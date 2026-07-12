/**
 * pop role withdraw-application — withdraw your own role application.
 *
 * withdrawApplication(uint256 hatId) — signature VERIFIED in
 * src/abi/EligibilityModuleNew.json; reverts NoActiveApplication when the
 * caller has none (verified against contracts origin/main
 * src/EligibilityModule.sol), so pre-flight checks hasActiveApplication and
 * fails fast with a friendly message instead.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { hasActiveApplication } from '../vouch/helpers';

interface WithdrawArgs {
  org?: string;
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

export const withdrawApplicationHandler = {
  builder: (yargs: Argv) => yargs
    .option('hat', { type: 'string', demandOption: true, describe: 'Hat ID whose application to withdraw' })
    .option('idempotency-key', { type: 'string', describe: 'Explicit idempotency key (repeat withdrawals within the TTL return the prior result).' })
    .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache and always submit.' })
    .example('pop role withdraw-application --hat 123', 'Withdraw your pending application for role 123'),

  handler: async (argv: ArgumentsCamelCase<WithdrawArgs>) => {
    const spin = output.spinner('Checking your application...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);
      const eligibilityAddr = requireModule(ctx.modules, 'eligibilityModuleAddress');

      if (argv.preflight !== false) {
        const active = await hasActiveApplication(ctx.provider, eligibilityAddr, argv.hat, ctx.address);
        if (!active) {
          throw new PreconditionError(
            `You have no active application for hat ${argv.hat}.`,
            'List applications with: pop role applications --mine'
          );
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        hat: argv.hat,
        applicant: ctx.address,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to withdraw application' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Withdrawing application...');
        txSpin.start();
        const contract = createWriteContract(eligibilityAddr, 'EligibilityModuleNew', ctx.signer);
        const result = await executeTx(contract, 'withdrawApplication', [argv.hat], { dryRun: argv.dryRun });
        txSpin.stop();

        finishWrite(result, {
          successMsg: `Application withdrawn for hat ${argv.hat}`,
          fields: { hat: argv.hat, applicant: ctx.address },
        });
        return { hat: argv.hat, txHash: result.txHash };
      };

      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'role.withdraw-application', run);
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
