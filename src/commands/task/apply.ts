/**
 * pop task apply — apply for an application-gated task.
 *
 * Pre-flight (skippable with --no-preflight) runs BEFORE the IPFS pin so a
 * doomed application never wastes a pin:
 *   - the task must use applications (requiresApplication), else the
 *     contract would revert NoApplicationRequired
 *   - the signer must not have applied already (AlreadyApplied)
 *   - status must be UNCLAIMED, or CLAIMED with an expired claim —
 *     v6 allows applyForTask while an expired claim awaits takeover
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { parseTaskId, ipfsCidToBytes32 } from '../../lib/encoding';
import { formatToken } from '../../lib/format';
import { getTaskApplicants, TaskOnChain } from '../../lib/task-lens';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { requireModule } from '../../lib/resolve';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { readTaskForPreflight, gateClaimableTask } from './claim';

interface ApplyArgs {
  org: string;
  task: string;
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
    .option('task', { type: 'string', demandOption: true, describe: 'Task ID' })
    .option('notes', { type: 'string', describe: 'Application notes' })
    .option('experience', { type: 'string', describe: 'Relevant experience' })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Explicit idempotency key. Two applications for the same task within 15 minutes return the same result without re-submitting or re-pinning. Default: auto-derived from argv.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit.',
    }),

  handler: async (argv: ArgumentsCamelCase<ApplyArgs>) => {
    const spin = output.spinner('Checking task state...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);
      const taskManagerAddress = requireModule(ctx.modules, 'taskManagerAddress');
      const parsedTaskId = parseTaskId(argv.task);

      // ── Pre-flight (skippable with --no-preflight), BEFORE the pin ────
      let task: TaskOnChain | null = null;
      let takeover = false;
      if (argv.preflight !== false) {
        task = await readTaskForPreflight(ctx.provider, taskManagerAddress, argv.task);
        if (!task.requiresApplication) {
          throw new PreconditionError(
            `Task ${argv.task} does not use applications — claim it directly.`,
            `Run: pop task claim --task ${argv.task}`
          );
        }
        // applyForTask is allowed while an expired claim awaits takeover.
        takeover = gateClaimableTask(task, argv.task, 'applying');

        // Duplicate-application check via the lens (cheap). A failed read is
        // NOT fatal: the contract's AlreadyApplied decode is authoritative.
        try {
          const applicants = await getTaskApplicants(ctx.provider, taskManagerAddress, parsedTaskId);
          if (applicants.some(a => a.toLowerCase() === ctx.address.toLowerCase())) {
            throw new PreconditionError(
              `You (${ctx.address}) have already applied for task ${argv.task}.`,
              `Check the application status with: pop task view --task ${argv.task}`
            );
          }
        } catch (err: any) {
          if (err instanceof PreconditionError) throw err;
          // Lens applicants read unavailable — let the contract decide.
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      if (takeover && task) {
        output.info(`Previous claim by ${task.claimer} has expired — applications can take over this task.`);
      }

      await confirmWrite(argv, {
        task: `#${argv.task}`,
        payout: task ? formatToken(task.payout, 18, 'PT') : undefined,
        notes: argv.notes || undefined,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to apply for task' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Pinning application to IPFS...');
        txSpin.start();

        // Pin AFTER the pre-flight so doomed applications never waste a pin.
        const applicationData = {
          notes: argv.notes || '',
          experience: argv.experience || '',
        };
        const cid = await pinJson(JSON.stringify(applicationData));
        const applicationHash = ipfsCidToBytes32(cid);

        txSpin.text = 'Sending transaction...';
        const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', ctx.signer);
        const result = await executeTx(contract, 'applyForTask', [parsedTaskId, applicationHash], { dryRun: argv.dryRun });
        txSpin.stop();

        finishWrite(result, {
          successMsg: `Applied for task ${argv.task}`,
          fields: { taskId: argv.task, ipfsCid: cid },
        });
        return { taskId: argv.task, txHash: result.txHash, ipfsCid: cid };
      };

      // Dry runs simulate unconditionally: no idempotency read or record.
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'task.apply', run);
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
