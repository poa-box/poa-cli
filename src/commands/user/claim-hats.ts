/**
 * pop user claim-hats — claim additional role hats after joining.
 *
 * QuickJoin.claimHatsWithUser(uint256[] claimHatIds) — verified against
 * contracts origin/main src/QuickJoin.sol and src/abi/QuickJoinNew.json:
 * the vouch-first flow. The caller must already have a username (the
 * contract reverts NoUsername otherwise — pre-flighted here), and Hats
 * Protocol enforces per-hat eligibility via the EligibilityModule (an
 * ineligible claim reverts NotEligible; that decode flows through the
 * error catalog).
 *
 * Hat IDs are uint256 (Hats Protocol IDs exceed Number.MAX_SAFE_INTEGER),
 * so they are parsed with BigNumber — never parseInt.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createReadContract, createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { requireModule } from '../../lib/resolve';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface ClaimHatsArgs {
  org: string;
  hats: string;
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
 * Parse a comma-separated hat-ID list into BigNumbers. Accepts decimal and
 * 0x-hex forms. Hats Protocol IDs are uint256 — far beyond 2^53 — so
 * parseInt/Number would silently corrupt them.
 */
export function parseHatIds(input: string): ethers.BigNumber[] {
  const parts = String(input).split(',').map(part => part.trim()).filter(part => part.length > 0);
  if (parts.length === 0) {
    throw new CliError('No hat IDs given.', EXIT.USAGE, 'Pass --hats <id>[,<id>...] (see pop org roles for hat IDs).');
  }
  return parts.map(part => {
    try {
      return ethers.BigNumber.from(part);
    } catch {
      throw new CliError(
        `Invalid hat ID "${part}".`,
        EXIT.USAGE,
        'Hat IDs are uint256 integers — pass them as decimal or 0x-hex strings (see pop org roles).'
      );
    }
  });
}

export const claimHatsHandler = {
  builder: (yargs: Argv) => yargs
    .option('hats', {
      type: 'string',
      demandOption: true,
      describe: 'Comma-separated hat IDs to claim (decimal or 0x-hex), e.g. after being vouched for a role',
    })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Explicit idempotency key. Two identical claims within the TTL return the same result without re-submitting. Default: auto-derived from argv.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit.',
    })
    .example('pop user claim-hats --hats 123,456', 'Claim two role hats you are eligible for (e.g. via vouching)')
    .example('pop user claim-hats --hats 0x0000000100020001000000000000000000000000000000000000000000000000', 'Claim one hat by 0x-hex ID'),

  handler: async (argv: ArgumentsCamelCase<ClaimHatsArgs>) => {
    const spin = output.spinner('Checking account state...');
    spin.start();

    try {
      const hatIds = parseHatIds(argv.hats);

      const ctx = await getWriteContext(argv);
      const quickJoinAddr = requireModule(ctx.modules, 'quickJoinAddress');

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      // claimHatsWithUser reverts NoUsername for unregistered accounts —
      // fail fast with the fix instead of burning gas estimation.
      if (argv.preflight !== false) {
        try {
          const quickJoin = createReadContract(quickJoinAddr, 'QuickJoinNew', ctx.provider);
          const registryAddr = await quickJoin.accountRegistry();
          const registry = createReadContract(registryAddr, 'UniversalAccountRegistry', ctx.provider);
          const username: string = await registry.getUsername(ctx.address);
          if (username.length === 0) {
            throw new PreconditionError(
              `${ctx.address} has no registered username — claimHatsWithUser would revert NoUsername.`,
              'Join first (pop user join --username <name>), or register with pop user register.'
            );
          }
        } catch (err: any) {
          if (err instanceof CliError) throw err;
          output.debug(`username pre-check skipped (registry read failed: ${err?.message || err})`);
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: argv.preflight === false });
      spin.stop();

      await confirmWrite(argv, {
        org: argv.org,
        hats: hatIds.map(id => id.toString()).join(', '),
        chain: ctx.networkName,
      }, { actionLabel: 'About to claim role hats' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Claiming hats...');
        txSpin.start();
        const contract = createWriteContract(quickJoinAddr, 'QuickJoinNew', ctx.signer);
        const result = await executeTx(contract, 'claimHatsWithUser', [hatIds], { dryRun: argv.dryRun });
        txSpin.stop();

        finishWrite(result, {
          successMsg: hatIds.length === 1 ? `Hat ${hatIds[0].toString()} claimed` : `${hatIds.length} hats claimed`,
          fields: { hatIds: hatIds.map(id => id.toString()).join(','), orgId: ctx.orgId },
        });
        return { hatIds: hatIds.map(id => id.toString()).join(','), txHash: result.txHash };
      };

      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'user.claim-hats', run);
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
