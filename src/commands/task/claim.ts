/**
 * pop task claim — claim an open task (v6 expired-claim takeover aware).
 *
 * Pre-flight (skippable with --no-preflight) reads the authoritative task
 * state via the TaskManager lens BEFORE any transaction:
 *   - UNCLAIMED               → proceed (fail fast if it requires an application)
 *   - CLAIMED, claim expired  → proceed as a takeover (v6: claimTask succeeds
 *                               iff claimDeadline/absoluteDeadline strictly
 *                               passed, emitting TaskClaimExpired first)
 *   - CLAIMED, not expired    → fail fast naming the claimer + time remaining
 *   - SUBMITTED/COMPLETED/CANCELLED → fail fast with the status name
 *
 * After success the receipt logs are parsed: TaskClaimExpired confirms the
 * takeover, TaskClaimDeadlineSet echoes the submit-by deadline.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract } from '../../lib/contracts';
import { executeTx, TxResult } from '../../lib/tx';
import { parseTaskId, formatDeadline } from '../../lib/encoding';
import { formatCountdown, formatToken } from '../../lib/format';
import {
  getTaskOnChain,
  deriveClaimState,
  taskStatusName,
  TASK_STATUS,
  TaskOnChain,
} from '../../lib/task-lens';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { requireModule } from '../../lib/resolve';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface ClaimArgs {
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

/**
 * Read the task via the lens, mapping unreadable tasks to a precondition
 * failure. Shared shape across claim/assign/approve-app/apply preflights.
 */
export async function readTaskForPreflight(
  provider: ethers.providers.Provider,
  taskManagerAddress: string,
  taskLabel: string
): Promise<TaskOnChain> {
  try {
    return await getTaskOnChain(provider, taskManagerAddress, taskLabel);
  } catch {
    throw new PreconditionError(
      `Could not read task ${taskLabel} on-chain — it may not exist.`,
      'Check the task ID with: pop task list'
    );
  }
}

/**
 * Gate a claim-style write (claim/assign/approve-app/apply) on the v6
 * takeover rules. Returns true when this write is an expired-claim takeover.
 * Throws PreconditionError (exit 4) on every non-claimable state, BEFORE any
 * transaction is sent.
 */
export function gateClaimableTask(task: TaskOnChain, taskLabel: string, action: string): boolean {
  if (task.status === TASK_STATUS.UNCLAIMED) return false;

  if (task.status === TASK_STATUS.CLAIMED) {
    if (deriveClaimState(task) === 'expired-claimable') return true;
    const deadline = task.claimDeadline || task.absoluteDeadline || 0;
    const detail = deadline
      ? `${formatCountdown(deadline)} on the current claim`
      : 'the claim has no deadline, so it cannot expire';
    throw new PreconditionError(
      `Task ${taskLabel} is already claimed by ${task.claimer} (${detail}).`,
      deadline
        ? 'Wait for the claim to expire, or pick another task: pop task list'
        : 'Pick another task: pop task list'
    );
  }

  throw new PreconditionError(
    `Task ${taskLabel} is ${taskStatusName(task.status)} — ${action} needs an UNCLAIMED task (or an expired claim).`,
    `Inspect it with: pop task view --task ${taskLabel}`
  );
}

/**
 * Post-success deadline echo shared by claim/assign/approve-app: pull
 * TaskClaimExpired (takeover confirmation) and TaskClaimDeadlineSet (the
 * submit-by deadline the contract actually recorded) out of the receipt
 * logs. Returns additive success fields; prints nothing.
 */
export function claimReceiptFields(result: TxResult): Record<string, string | number | undefined> {
  if (!result.success || result.dryRun) return {};
  const logs = result.logs ?? [];
  const fields: Record<string, string | number | undefined> = {};

  const expired = logs.find(l => l.name === 'TaskClaimExpired');
  if (expired?.args?.previousClaimer) {
    fields.takenOverFrom = expired.args.previousClaimer;
  }

  const deadlineSet = logs.find(l => l.name === 'TaskClaimDeadlineSet');
  const claimDeadline = deadlineSet?.args?.claimDeadline
    ? Number(deadlineSet.args.claimDeadline.toString())
    : 0;
  if (claimDeadline > 0) {
    fields.claimDeadline = claimDeadline;
    fields.submitBy = formatDeadline(claimDeadline);
  }
  return fields;
}

/**
 * Human echo after a successful claim-style write: takeover confirmation,
 * submit-by countdown, and a warning when the absolute deadline cuts the
 * completion window short (the earlier cutoff always applies on-chain).
 */
export function echoClaimReceipt(
  fields: Record<string, string | number | undefined>,
  task: TaskOnChain | null,
  who: string
): void {
  if (fields.takenOverFrom) {
    output.info(`Takeover confirmed — the expired claim by ${fields.takenOverFrom} was released.`);
  }
  if (typeof fields.claimDeadline === 'number' && fields.claimDeadline > 0) {
    output.info(`${who} before ${formatDeadline(fields.claimDeadline)} (${formatCountdown(fields.claimDeadline)})`);
  }
  const nowSecs = Math.floor(Date.now() / 1000);
  if (
    task?.absoluteDeadline && task?.completionWindow &&
    task.absoluteDeadline < nowSecs + task.completionWindow
  ) {
    output.warn(
      `The task's absolute deadline (${formatDeadline(task.absoluteDeadline)}) lands before the full ` +
      `completion window — the earlier cutoff applies (${formatCountdown(task.absoluteDeadline)}).`
    );
  }
}

export const claimHandler = {
  builder: (yargs: Argv) => yargs
    .option('task', { type: 'string', demandOption: true, describe: 'Task ID' })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Task #370 (HB#214): explicit idempotency key. Two claims for the same task within 15 minutes return the same result without re-submitting. Default: auto-derived from argv.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit.',
    }),

  handler: async (argv: ArgumentsCamelCase<ClaimArgs>) => {
    const spin = output.spinner('Checking task state...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);
      const taskManagerAddress = requireModule(ctx.modules, 'taskManagerAddress');
      const parsedTaskId = parseTaskId(argv.task);

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      // Authoritative task state via the lens: fail fast (exit 4) on every
      // unclaimable state BEFORE gas is spent; detect expired-claim takeover.
      let task: TaskOnChain | null = null;
      let takeover = false;
      if (argv.preflight !== false) {
        task = await readTaskForPreflight(ctx.provider, taskManagerAddress, argv.task);
        takeover = gateClaimableTask(task, argv.task, 'claiming');
        if (!takeover && task.requiresApplication) {
          throw new PreconditionError(
            `Task ${argv.task} requires an application before it can be claimed.`,
            `Apply first: pop task apply --task ${argv.task}`
          );
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      if (takeover && task) {
        output.info(`Taking over expired claim from ${task.claimer}`);
      }

      await confirmWrite(argv, {
        task: `#${argv.task}`,
        payout: task ? formatToken(task.payout, 18, 'PT') : undefined,
        takeover: takeover && task ? `expired claim by ${task.claimer}` : undefined,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to claim task' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Claiming task...');
        txSpin.start();
        const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', ctx.signer);
        const result = await executeTx(contract, 'claimTask', [parsedTaskId], { dryRun: argv.dryRun });
        txSpin.stop();

        const receiptFields = claimReceiptFields(result);
        finishWrite(result, {
          successMsg: `Task ${argv.task} claimed`,
          fields: { taskId: argv.task, ...receiptFields },
        });
        echoClaimReceipt(receiptFields, task, 'Submit');
        return { taskId: argv.task, txHash: result.txHash };
      };

      // Dry runs simulate unconditionally: they neither consult nor record
      // the idempotency cache (nothing lands on-chain).
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'task.claim', run);
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
