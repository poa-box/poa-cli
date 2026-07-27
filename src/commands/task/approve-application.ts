/**
 * pop task approve-app — approve a task application (v6 takeover aware).
 *
 * Pre-flight verifies (skippable with --no-preflight):
 *   - the task actually uses applications (requiresApplication)
 *   - the applicant has applied (lens TASK_APPLICANTS read — when that read
 *     fails, the check is skipped and the contract's NotApplicant decode is
 *     the authoritative answer)
 *   - the task is UNCLAIMED, or CLAIMED with an expired claim (v6 takeover:
 *     approveApplication succeeds on expired claims, emitting
 *     TaskClaimExpired before ApplicationApproved)
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { parseTaskId } from '../../lib/encoding';
import { formatToken } from '../../lib/format';
import { getTaskApplicants, TaskOnChain } from '../../lib/task-lens';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { requireModule } from '../../lib/resolve';
import { requireAddress } from '../../lib/validation';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import {
  readTaskForPreflight,
  gateClaimableTask,
  claimReceiptFields,
  echoClaimReceipt,
} from './claim';

interface ApproveAppArgs {
  org: string;
  task: string;
  applicant: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const approveAppHandler = {
  builder: (yargs: Argv) => yargs
    .option('task', { type: 'string', demandOption: true, describe: 'Task ID' })
    .option('applicant', { type: 'string', demandOption: true, describe: 'Applicant address to approve' })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Explicit idempotency key. Two approvals for the same task within 15 minutes return the same result without re-submitting. Default: auto-derived from argv.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit.',
    }),

  handler: async (argv: ArgumentsCamelCase<ApproveAppArgs>) => {
    const spin = output.spinner('Checking task state...');

    try {
      const applicant = requireAddress(argv.applicant, 'applicant');
      spin.start();

      const ctx = await getWriteContext(argv);
      const taskManagerAddress = requireModule(ctx.modules, 'taskManagerAddress');
      const parsedTaskId = parseTaskId(argv.task);

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      let task: TaskOnChain | null = null;
      let takeover = false;
      if (argv.preflight !== false) {
        task = await readTaskForPreflight(ctx.provider, taskManagerAddress, argv.task);
        if (!task.requiresApplication) {
          throw new PreconditionError(
            `Task ${argv.task} does not use applications — there is nothing to approve.`,
            `Assign it directly instead: pop task assign --task ${argv.task} --assignee ${applicant}`
          );
        }
        takeover = gateClaimableTask(task, argv.task, 'approving an application');

        // Applicant check via the lens (cheap). A failed read is NOT fatal:
        // the contract's decoded NotApplicant error is the authoritative
        // answer if this is skipped.
        try {
          const applicants = await getTaskApplicants(ctx.provider, taskManagerAddress, parsedTaskId);
          if (!applicants.some(a => a.toLowerCase() === applicant.toLowerCase())) {
            throw new PreconditionError(
              `${applicant} has not applied for task ${argv.task}.`,
              `See who applied with: pop task view --task ${argv.task}`
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
        output.info(`Taking over expired claim from ${task.claimer} — approving ${applicant}`);
      }

      await confirmWrite(argv, {
        task: `#${argv.task}`,
        applicant,
        payout: task ? formatToken(task.payout, 18, 'PT') : undefined,
        takeover: takeover && task ? `expired claim by ${task.claimer}` : undefined,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to approve application' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Approving application...');
        txSpin.start();
        const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', ctx.signer);
        const result = await executeTx(contract, 'approveApplication', [parsedTaskId, applicant], { dryRun: argv.dryRun });
        txSpin.stop();

        const receiptFields = claimReceiptFields(result);
        finishWrite(result, {
          successMsg: `Application approved for task ${argv.task}`,
          fields: { taskId: argv.task, applicant, ...receiptFields },
        });
        echoClaimReceipt(receiptFields, task, 'The approved applicant must submit');
        return { taskId: argv.task, applicant, txHash: result.txHash };
      };

      // Dry runs simulate unconditionally: no idempotency read or record.
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'task.approve-app', run);
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
