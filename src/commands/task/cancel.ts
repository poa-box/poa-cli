/**
 * pop task cancel — cancel a not-yet-completed task (destructive).
 *
 * Status gate verified against contracts origin/main src/TaskManager.sol
 * (BadStatus semantics): cancel applies to tasks that have not reached a
 * terminal state — UNCLAIMED, CLAIMED, and SUBMITTED. COMPLETED and
 * CANCELLED tasks fail fast in pre-flight.
 *
 * Cancelling discards the task (and any in-flight work on it), so the
 * confirmation is destructive: interactive sessions are prompted, and
 * non-TTY sessions must pass --yes explicitly (--json implies consent for
 * script compatibility).
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { parseTaskId } from '../../lib/encoding';
import { formatToken } from '../../lib/format';
import { taskStatusName, TASK_STATUS, TaskOnChain } from '../../lib/task-lens';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { requireModule } from '../../lib/resolve';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { readTaskForPreflight } from './claim';

interface CancelArgs {
  org: string;
  task: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

const CANCELLABLE_STATUSES: number[] = [
  TASK_STATUS.UNCLAIMED,
  TASK_STATUS.CLAIMED,
  TASK_STATUS.SUBMITTED,
];

export const cancelHandler = {
  builder: (yargs: Argv) => yargs
    .option('task', { type: 'string', demandOption: true, describe: 'Task ID' })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Explicit idempotency key. Two cancels of the same task within 15 minutes return the same result without re-submitting. Default: auto-derived from argv.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit.',
    }),

  handler: async (argv: ArgumentsCamelCase<CancelArgs>) => {
    const spin = output.spinner('Checking task state...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);
      const taskManagerAddress = requireModule(ctx.modules, 'taskManagerAddress');
      const parsedTaskId = parseTaskId(argv.task);

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      let task: TaskOnChain | null = null;
      if (argv.preflight !== false) {
        task = await readTaskForPreflight(ctx.provider, taskManagerAddress, argv.task);
        if (!CANCELLABLE_STATUSES.includes(task.status)) {
          throw new PreconditionError(
            `Task ${argv.task} is ${taskStatusName(task.status)} — only UNCLAIMED, CLAIMED, or SUBMITTED tasks can be cancelled.`,
            `Inspect it with: pop task view --task ${argv.task}`
          );
        }
        if (task.status !== TASK_STATUS.UNCLAIMED) {
          output.warn(
            `Task ${argv.task} is ${taskStatusName(task.status)} by ${task.claimer} — cancelling discards their in-flight work.`
          );
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        task: `#${argv.task}`,
        status: task ? taskStatusName(task.status) : undefined,
        payout: task ? formatToken(task.payout, 18, 'PT') : undefined,
        claimer: task && task.status !== TASK_STATUS.UNCLAIMED ? task.claimer : undefined,
        org: argv.org,
        chain: ctx.networkName,
      }, { destructive: true, actionLabel: 'About to CANCEL task (cannot be undone)' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Cancelling task...');
        txSpin.start();
        const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', ctx.signer);
        const result = await executeTx(contract, 'cancelTask', [parsedTaskId], { dryRun: argv.dryRun });
        txSpin.stop();

        finishWrite(result, {
          successMsg: `Task ${argv.task} cancelled`,
          fields: { taskId: argv.task },
        });
        return { taskId: argv.task, txHash: result.txHash };
      };

      // Dry runs simulate unconditionally: no idempotency read or record.
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'task.cancel', run);
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
