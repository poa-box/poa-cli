/**
 * pop vouch revoke — withdraw YOUR OWN vouch for a wearer.
 *
 * Pre-flight (skippable), one Multicall3 round-trip: hasVouched(hat, wearer, signer)
 * must be true AND currentVouchCount(hat, wearer) must be non-zero. Either failing
 * means revokeVouch reverts HasNotVouched (verified against contracts origin/main
 * src/EligibilityModule.sol), so we fail fast with a friendly message instead.
 *
 * The count check is not redundant: hasVouched reads the raw `vouchers` mapping with
 * no epoch filter, so it still returns true for a vouch that a later configureVouching
 * or clearWearerVouches already voided. currentVouchCount is epoch-aware and returns 0
 * for exactly that case. The one residual revert — wearer epoch current but THIS
 * voucher's record stale — has no getter, so the decoded HasNotVouched still covers it.
 *
 * Note (verified): revoking does NOT refund the daily rate-limit slot, and
 * dropping the wearer below quorum can revoke their hat when vouching is the
 * only eligibility path.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { requireAddress } from '../../lib/validation';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { readRevokeGate } from './helpers';

interface RevokeArgs {
  org?: string;
  address: string;
  hat: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const revokeHandler = {
  builder: (yargs: Argv) => yargs
    .option('address', { type: 'string', demandOption: true, describe: 'Address whose vouch to revoke' })
    .option('hat', { type: 'string', demandOption: true, describe: 'Hat ID of the role' })
    .option('idempotency-key', { type: 'string', describe: 'Explicit idempotency key (repeat calls within the TTL return the prior result).' })
    .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache and always submit.' })
    .example('pop vouch revoke --address 0xabc... --hat 123', 'Withdraw your vouch for a member on hat 123'),

  handler: async (argv: ArgumentsCamelCase<RevokeArgs>) => {
    const spin = output.spinner('Checking your vouch record...');
    spin.start();

    try {
      const wearer = requireAddress(argv.address, 'address');
      const ctx = await getWriteContext(argv);
      const eligibilityModuleAddress = requireModule(ctx.modules, 'eligibilityModuleAddress');

      if (argv.preflight !== false) {
        const gate = await readRevokeGate(ctx.provider, eligibilityModuleAddress, argv.hat, wearer, ctx.address);
        if (!gate.hasVouched) {
          throw new PreconditionError(
            `You have not vouched for ${wearer} on hat ${argv.hat} — nothing to revoke.`,
            `Check vouch state with: pop vouch status --hat ${argv.hat} --address ${wearer}`
          );
        }
        // hasVouched is epoch-blind, so a record can survive a reconfiguration that
        // already zeroed the tally. currentVouchCount is the epoch-aware answer.
        if (gate.currentCount === 0) {
          throw new PreconditionError(
            `Your vouch for ${wearer} on hat ${argv.hat} is no longer counted — the hat's vouching was reconfigured or their vouches were cleared, which voids every vouch cast beforehand.`,
            `Nothing to revoke. Confirm with: pop vouch status --hat ${argv.hat} --address ${wearer}`
          );
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        wearer,
        hat: argv.hat,
        note: 'may drop the wearer below quorum (their hat can be revoked)',
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to revoke your vouch' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Revoking vouch...');
        txSpin.start();
        const contract = createWriteContract(eligibilityModuleAddress, 'EligibilityModuleNew', ctx.signer);
        const result = await executeTx(contract, 'revokeVouch', [wearer, argv.hat], { dryRun: argv.dryRun });
        txSpin.stop();

        // VouchRevoked(voucher, wearer, hatId, newCount) — verified in ABI.
        const revokedEvent = result.logs?.find(l => l.name === 'VouchRevoked');
        const newCount = revokedEvent?.args?.newCount !== undefined
          ? Number(revokedEvent.args.newCount.toString())
          : undefined;

        finishWrite(result, {
          successMsg: `Vouch revoked for ${wearer} on hat ${argv.hat}`,
          fields: { wearer, hat: argv.hat, newCount },
        });
        return { wearer, hat: argv.hat, newCount, txHash: result.txHash };
      };

      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'vouch.revoke', run);
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
