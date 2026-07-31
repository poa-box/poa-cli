/**
 * pop role apply — apply for a vouching-gated role.
 *
 * applyForRole(hatId, applicationHash) — open to anyone while unpaused, but
 * (VERIFIED against contracts origin/main src/EligibilityModule.sol) reverts
 * unless vouching is enabled for the hat, the applicant has no active
 * application, and they don't already wear the hat. Pre-flight fails fast on
 * the first two BEFORE pinning to IPFS or spending gas. Applying is a
 * signaling mechanism only — it does not grant eligibility.
 *
 * READ SOURCING: BOTH pre-flight reads stay on chain. VouchConfig.enabled and
 * RoleApplication.active are populated in the subgraph, but each read here
 * exists purely to predict a revert (VouchingNotEnabled / duplicate
 * application) — a stale answer either blocks a valid application or burns gas
 * on a doomed one. They hit the same contract, so they now share ONE
 * Multicall3 round-trip instead of two eth_calls.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { batchEligibilityReads } from '../vouch/helpers';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { ipfsCidToBytes32 } from '../../lib/encoding';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface ApplyArgs {
  org?: string;
  hat: string;
  notes?: string;
  experience?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const applyHandler = {
  builder: (yargs: Argv) => yargs
    .option('hat', { type: 'string', demandOption: true, describe: 'Hat ID of the role to apply for' })
    .option('notes', { type: 'string', describe: 'Application notes' })
    .option('experience', { type: 'string', describe: 'Relevant experience' })
    .option('idempotency-key', { type: 'string', describe: 'Explicit idempotency key (repeat applies within the TTL return the prior result).' })
    .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache and always submit.' })
    .example('pop role apply --hat 123 --notes "Active in governance since March"', 'Apply for role 123 with a note'),

  handler: async (argv: ArgumentsCamelCase<ApplyArgs>) => {
    const spin = output.spinner('Checking application preconditions...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);
      const eligibilityAddr = requireModule(ctx.modules, 'eligibilityModuleAddress');

      // ── Pre-flight (skippable): vouching enabled + no active application ──
      if (argv.preflight !== false) {
        const [enabled, alreadyApplied] = await batchEligibilityReads(ctx.provider, eligibilityAddr, [
          { fn: 'isVouchingEnabled', args: [argv.hat] },
          { fn: 'hasActiveApplication', args: [argv.hat, ctx.address] },
        ]);
        if (!enabled) {
          throw new PreconditionError(
            `Vouching is not enabled for hat ${argv.hat} — applications only exist for vouching-gated roles.`,
            `Check the config with: pop vouch config show --hat ${argv.hat}`
          );
        }
        if (alreadyApplied) {
          throw new PreconditionError(
            `You already have an active application for hat ${argv.hat}.`,
            `Withdraw it first if you want to re-apply: pop role withdraw-application --hat ${argv.hat}`
          );
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        hat: argv.hat,
        applicant: ctx.address,
        notes: argv.notes || '(none)',
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to apply for role' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Pinning application to IPFS...');
        txSpin.start();

        // Upload application metadata to IPFS (key order preserved for
        // frontend/subgraph parity).
        const applicationData = {
          notes: argv.notes || '',
          experience: argv.experience || '',
          appliedAt: Date.now(),
        };
        const cid = await pinJson(JSON.stringify(applicationData));
        const applicationHash = ipfsCidToBytes32(cid);

        txSpin.text = 'Sending transaction...';
        const contract = createWriteContract(eligibilityAddr, 'EligibilityModuleNew', ctx.signer);
        const result = await executeTx(contract, 'applyForRole', [argv.hat, applicationHash], { dryRun: argv.dryRun });
        txSpin.stop();

        finishWrite(result, {
          successMsg: `Applied for role (hat ${argv.hat})`,
          fields: {
            hat: argv.hat,
            applicant: ctx.address,
            ipfsCid: cid,
            note: 'applying signals interest — eligibility still comes from vouches',
          },
        });
        return { hat: argv.hat, ipfsCid: cid, txHash: result.txHash };
      };

      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'role.apply', run);
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
