/**
 * pop education complete — answer a module's quiz and claim its PT reward.
 *
 * EducationHub.completeModule(id, answer) — verified contracts origin/main
 * src/EducationHub.sol: onlyMember + whenNotPaused; reverts ModuleUnknown
 * for missing modules, AlreadyCompleted on a second attempt (each module
 * pays out once per account), and InvalidAnswer on a wrong answer index.
 *
 * Pre-flight (skippable with --no-preflight) fails fast BEFORE gas on the
 * two knowable reverts: the module must exist (getModule) and the learner
 * must not have completed it already (hasCompleted).
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { parseModuleId } from '../../lib/encoding';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { checkModuleExists, checkNotCompleted } from './helpers';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface CompleteArgs {
  org: string;
  module: string;
  answer: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const completeHandler = {
  builder: (yargs: Argv) => yargs
    .option('module', { type: 'string', demandOption: true, describe: 'Module ID' })
    .option('answer', { type: 'number', demandOption: true, describe: 'Answer index (0-based)' })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Explicit idempotency key. Two identical completions within the TTL return the same result without re-submitting. Default: auto-derived from argv.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit.',
    })
    .example('pop education complete --module 2 --answer 1', 'Answer module 2 with option index 1 and claim the PT reward'),

  handler: async (argv: ArgumentsCamelCase<CompleteArgs>) => {
    const spin = output.spinner('Checking module state...');
    spin.start();

    try {
      if (!Number.isInteger(argv.answer) || argv.answer < 0 || argv.answer > 255) {
        throw new CliError(`--answer must be an integer 0-255 (uint8), got: ${argv.answer}`, EXIT.USAGE);
      }

      const ctx = await getWriteContext(argv);
      const educationHubAddress = requireModule(ctx.modules, 'educationHubAddress');
      const moduleId = parseModuleId(argv.module);

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      // Fail fast (exit 4) on the knowable reverts: ModuleUnknown and
      // AlreadyCompleted. A wrong answer is only knowable on-chain.
      await runPreflight(ctx.provider, [
        checkGasBalance(ctx.address),
        checkModuleExists(educationHubAddress, moduleId),
        checkNotCompleted(educationHubAddress, ctx.address, moduleId),
      ], { skip: argv.preflight === false });
      spin.stop();

      await confirmWrite(argv, {
        module: `#${moduleId}`,
        answer: `index ${argv.answer}`,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to complete module' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Completing module...');
        txSpin.start();
        const contract = createWriteContract(educationHubAddress, 'EducationHubNew', ctx.signer);
        const result = await executeTx(
          contract,
          'completeModule',
          [moduleId, argv.answer],
          { dryRun: argv.dryRun }
        );
        txSpin.stop();

        finishWrite(result, {
          successMsg: `Module ${argv.module} completed`,
          fields: { moduleId },
        });
        return { moduleId, txHash: result.txHash };
      };

      // Dry runs simulate unconditionally: they neither consult nor record
      // the idempotency cache (nothing lands on-chain).
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'education.complete', run);
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
