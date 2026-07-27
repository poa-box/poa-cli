/**
 * pop vouch for — vouch for a member so they can claim a role.
 *
 * Pre-flight (skippable with --no-preflight) fails fast BEFORE gas is spent:
 *   - vouching not enabled for the hat        → exit 4 pointing at vouch config
 *   - canUserVouch(signer) false              → exit 4 with the friendly reason
 *     (daily rate limit "3/3 used today" or the new-account join grace),
 *     mirroring the on-chain _checkVouchingRateLimit order (VERIFIED against
 *     contracts origin/main src/EligibilityModule.sol).
 *
 * Post-success the Vouched event (voucher, wearer, hatId, newCount — verified
 * in src/abi/EligibilityModuleNew.json) drives the progress line
 * "N/quorum vouches". Reaching quorum does NOT auto-mint: the contract uses
 * the claim-based pattern, so at quorum the wearer runs pop vouch claim.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { requireAddress } from '../../lib/validation';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule, resolveOrgModules } from '../../lib/resolve';
import { isInteractive, select } from '../../lib/prompt';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { readVouchPreflight, vouchRestriction, vouchQuotaLabel, VouchPreflightState } from './helpers';

interface ForArgs {
  org?: string;
  address: string;
  hat?: string;
  role?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

/**
 * Resolve a role name to its hat ID by querying the org's roles.
 * Exact match first, then partial; multiple matches disambiguate via a TTY
 * select, or fail with the candidate list for non-interactive callers.
 */
async function resolveRoleToHatId(orgIdOrName: string, roleName: string, chainId?: number): Promise<string> {
  const { queryAllChains } = await import('../../lib/subgraph');
  const modules = await resolveOrgModules(orgIdOrName, chainId);
  const orgId = modules.orgId;

  const query = `{
    organization(id: "${orgId}") {
      roles(where: { isUserRole: true }) { hatId name }
    }
  }`;

  const results = await queryAllChains(query, {});
  const matches: Array<{ hatId: string; name: string }> = [];

  for (const r of results) {
    const roles = r.data?.organization?.roles || [];
    for (const role of roles) {
      if (role.name && role.name.toLowerCase() === roleName.toLowerCase()) {
        matches.push({ hatId: role.hatId, name: role.name });
      }
    }
  }

  if (matches.length === 0) {
    // Try partial match
    for (const r of results) {
      const roles = r.data?.organization?.roles || [];
      for (const role of roles) {
        if (role.name && role.name.toLowerCase().includes(roleName.toLowerCase())) {
          matches.push({ hatId: role.hatId, name: role.name });
        }
      }
    }
  }

  if (matches.length === 0) {
    throw new CliError(
      `No role named "${roleName}" found.`,
      EXIT.USAGE,
      'Use pop org roles to list available roles.'
    );
  }
  if (matches.length > 1) {
    if (isInteractive()) {
      return await select(
        `Multiple roles match "${roleName}" — which one?`,
        matches.map(m => ({ label: m.name, value: m.hatId, hint: `hat ${m.hatId}` }))
      );
    }
    const names = matches.map(m => `${m.name} (${m.hatId})`).join(', ');
    throw new CliError(
      `Multiple roles match "${roleName}": ${names}.`,
      EXIT.USAGE,
      'Use --hat with the specific hat ID.'
    );
  }

  return matches[0].hatId;
}

/**
 * Fail fast (exit 4) on every vouch precondition the contract would revert
 * on: vouching disabled, daily rate limit, new-account grace. Mirrors
 * vouchFor's own gate order so the friendly message matches the revert the
 * tx would have produced.
 */
export function gateVouch(state: VouchPreflightState, hatId: string): void {
  if (!state.config.enabled) {
    throw new PreconditionError(
      `Vouching is not enabled for hat ${hatId}.`,
      'Inspect/enable it with: pop vouch config show --hat ' + hatId
    );
  }
  const restriction = vouchRestriction(state.gate);
  if (restriction) {
    throw new PreconditionError(restriction.message, restriction.suggestion);
  }
}

export const forHandler = {
  builder: (yargs: Argv) => yargs
    .option('address', { type: 'string', demandOption: true, describe: 'Address of the user to vouch for' })
    .option('hat', { type: 'string', describe: 'Hat ID of the role' })
    .option('role', { type: 'string', describe: 'Role name (e.g. MEMBER, Agent) — resolves to hat ID' })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Explicit idempotency key. Repeat vouches for the same wearer+hat within the TTL return the prior result without re-submitting.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit.',
    })
    .check((argv) => {
      if (!argv.hat && !argv.role) {
        throw new Error('Either --hat or --role is required');
      }
      return true;
    })
    .example('pop vouch for --address 0xabc... --hat 123', 'Vouch for a member on hat 123')
    .example('pop vouch for --address 0xabc... --role MEMBER', 'Resolve the role by name, then vouch'),

  handler: async (argv: ArgumentsCamelCase<ForArgs>) => {
    const spin = output.spinner('Checking vouch preconditions...');
    spin.start();

    try {
      const wearer = requireAddress(argv.address, 'address');

      // Resolve hat ID from --role if provided
      let hatId = argv.hat as string;
      if (!hatId && argv.role) {
        spin.stop();
        hatId = await resolveRoleToHatId(argv.org as string, argv.role as string, argv.chain);
        output.info(`Resolved role "${argv.role}" → hat ${hatId.length > 20 ? hatId.slice(0, 20) + '...' : hatId}`);
        spin.start();
      }

      const ctx = await getWriteContext(argv);
      const eligibilityModuleAddress = requireModule(ctx.modules, 'eligibilityModuleAddress');

      if (wearer.toLowerCase() === ctx.address.toLowerCase()) {
        throw new PreconditionError('You cannot vouch for yourself.', 'Ask another member holding the membership hat to vouch for you.');
      }

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      let state: VouchPreflightState | null = null;
      if (argv.preflight !== false) {
        state = await readVouchPreflight(ctx.provider, eligibilityModuleAddress, hatId, ctx.address, wearer);
        gateVouch(state, hatId);
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      if (state) {
        output.info(`You can vouch (${vouchQuotaLabel(state.gate)})`);
      }

      await confirmWrite(argv, {
        wearer,
        hat: hatId,
        progress: state ? `${state.currentCount}/${state.config.quorum} vouches before yours` : undefined,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to vouch' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Vouching...');
        txSpin.start();
        const contract = createWriteContract(eligibilityModuleAddress, 'EligibilityModuleNew', ctx.signer);
        const result = await executeTx(contract, 'vouchFor', [wearer, hatId], { dryRun: argv.dryRun });
        txSpin.stop();

        // Vouched(address indexed voucher, address indexed wearer,
        //         uint256 indexed hatId, uint32 newCount) — verified in ABI.
        const vouchedEvent = result.logs?.find(l => l.name === 'Vouched');
        const newCount = vouchedEvent?.args?.newCount !== undefined
          ? Number(vouchedEvent.args.newCount.toString())
          : undefined;
        const quorum = state?.config.quorum;

        finishWrite(result, {
          successMsg: `Vouched for ${wearer} on hat ${hatId}`,
          fields: {
            wearer,
            hat: hatId,
            newCount,
            quorum,
            progress: newCount !== undefined && quorum ? `${newCount}/${quorum}` : undefined,
          },
        });

        if (newCount !== undefined && quorum) {
          if (newCount >= quorum) {
            output.info(`Quorum reached (${newCount}/${quorum}) — ${wearer} can now claim the hat: pop vouch claim --hat ${hatId}`);
          } else {
            output.info(`${newCount}/${quorum} vouches — the hat becomes claimable at quorum (pop vouch claim).`);
          }
        }
        return { wearer, hat: hatId, newCount, txHash: result.txHash };
      };

      // Dry runs simulate unconditionally: they neither consult nor record
      // the idempotency cache (nothing lands on-chain).
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'vouch.for', run);
      }
    } catch (err: any) {
      spin.stop();
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err?.message || String(err));
      process.exit(EXIT.USAGE);
    }
  },
};
