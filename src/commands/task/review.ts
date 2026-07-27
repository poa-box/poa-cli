/**
 * pop task review — approve (completeTask) or reject (rejectTask) a
 * SUBMITTED task.
 *
 * Pre-flight (skippable with --no-preflight) verifies the task is actually
 * SUBMITTED before anything else, and the confirmation summary spells out
 * the payout consequence: approving releases the payout (and any bounty) to
 * the claimer; rejecting pays nothing and returns the task to CLAIMED so the
 * claimer can resubmit.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { parseTaskId, ipfsCidToBytes32 } from '../../lib/encoding';
import { formatToken } from '../../lib/format';
import { taskStatusName, TASK_STATUS, TaskOnChain } from '../../lib/task-lens';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { requireModule } from '../../lib/resolve';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { readTaskForPreflight } from './claim';

interface ReviewArgs {
  org: string;
  task: string;
  action: string;
  reason?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const reviewHandler = {
  builder: (yargs: Argv) => yargs
    .option('task', { type: 'string', demandOption: true, describe: 'Task ID' })
    .option('action', { type: 'string', demandOption: true, choices: ['approve', 'reject'], describe: 'Approve or reject' })
    .option('reason', { type: 'string', describe: 'Rejection reason (required for reject)' })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Task #374 (HB#215): explicit idempotency key. Two reviews of the same task within 15 minutes return the same result without re-submitting.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit.',
    }),

  handler: async (argv: ArgumentsCamelCase<ReviewArgs>) => {
    if (argv.action === 'reject' && !argv.reason) {
      output.error('--reason is required when rejecting a task');
      process.exit(1);
      return;
    }
    const approving = argv.action === 'approve';

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
        if (task.status !== TASK_STATUS.SUBMITTED) {
          throw new PreconditionError(
            `Task ${argv.task} is ${taskStatusName(task.status)} — only SUBMITTED tasks can be reviewed.`,
            `Inspect it with: pop task view --task ${argv.task}`
          );
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      // ── Confirm: decision + payout consequence ────────────────────────
      const payoutLabel = task ? formatToken(task.payout, 18, 'PT') : undefined;
      const bountyLabel = task && !task.bountyPayout.isZero()
        ? `${task.bountyPayout.toString()} raw of ${task.bountyToken}`
        : undefined;
      await confirmWrite(argv, {
        task: `#${argv.task}`,
        decision: argv.action,
        consequence: approving
          ? `releases the payout${payoutLabel ? ` (${payoutLabel})` : ''}${bountyLabel ? ` + bounty (${bountyLabel})` : ''} to the claimer`
          : 'no payout — the task returns to CLAIMED so the claimer can resubmit',
        claimer: task?.claimer,
        reason: approving ? undefined : argv.reason,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: `About to ${argv.action} submission` });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner(`${approving ? 'Approving' : 'Rejecting'} task...`);
        txSpin.start();
        const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', ctx.signer);

        let result;
        let cid: string | undefined;
        if (approving) {
          result = await executeTx(contract, 'completeTask', [parsedTaskId], { dryRun: argv.dryRun });
        } else {
          // Pin the rejection reason AFTER pre-flight + confirmation so a
          // doomed or declined review never wastes a pin.
          const rejectionMetadata = { rejection: argv.reason };
          txSpin.text = 'Pinning rejection reason to IPFS...';
          cid = await pinJson(JSON.stringify(rejectionMetadata));
          const rejectionHash = ipfsCidToBytes32(cid);

          txSpin.text = 'Sending transaction...';
          result = await executeTx(contract, 'rejectTask', [parsedTaskId, rejectionHash], { dryRun: argv.dryRun });
        }
        txSpin.stop();

        finishWrite(result, {
          successMsg: `Task ${argv.task} ${approving ? 'approved' : 'rejected'}`,
          fields: {
            taskId: argv.task,
            action: argv.action,
            payout: approving ? payoutLabel : undefined,
            ipfsCid: cid,
          },
        });
        return { taskId: argv.task, action: argv.action, txHash: result.txHash };
      };

      // Dry runs simulate unconditionally: no idempotency read or record.
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'task.review', run);
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
