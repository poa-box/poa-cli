/**
 * pop task unclaim — release a CLAIMED task back to the pool (TaskManager v7).
 *
 * Two routes reach `unclaimTask(uint256)`, and they have genuinely different
 * blast radius, so the command treats them differently:
 *
 *   SELF-RELEASE   the claimer gives their own task back. Allowed at ANY time,
 *                  with no permission-mask check on-chain (an assignee never
 *                  needs CLAIM, and hats get revoked mid-claim — gating this
 *                  would trap exactly the people it frees). Non-destructive:
 *                  reversible by re-claiming, refunds nothing, destroys nothing.
 *   FORCE-RELEASE  someone else releases an ALREADY-EXPIRED claim. Needs ASSIGN
 *                  on the project (PM / executor bypass included). Destructive:
 *                  it takes a task away from another member, so `--json` is not
 *                  consent and `--yes` is required non-interactively.
 *
 * SUBMITTED is excluded on purpose — a zeroed claimer would let `completeTask`
 * mint to address(0) and brick the task. The route out is `pop task review
 * --action reject` first, then this.
 *
 * Budgets and application hashes are untouched on-chain: `cancelTask` stays the
 * single refund path, and becomes reachable again once a task is released.
 *
 * Post-success the receipt logs are parsed: `TaskUnclaimed` names the previous
 * claimer and the caller (their equality IS the self-vs-forced discriminator),
 * and `TaskClaimDeadlineSet(id, 0)` follows only when a claim window was
 * actually running. `TaskClaimExpired` is never emitted — no replacement
 * claimer is named — so it is deliberately not looked for.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx, TxResult } from '../../lib/tx';
import { parseTaskId, formatDeadline } from '../../lib/encoding';
import { formatCountdown, formatToken } from '../../lib/format';
import {
  deriveClaimState,
  taskStatusName,
  TASK_STATUS,
  TaskOnChain,
} from '../../lib/task-lens';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { requireModule } from '../../lib/resolve';
import { detectTaskManagerFeatures, featureUnavailable } from '../../lib/version';
import { chainIndexesTaskReleases } from '../../queries/task';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { readTaskForPreflight } from './claim';

interface UnclaimArgs {
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
 * Gate a release on the v7 two-route rule. Returns true for a self-release,
 * false for a permitted third-party release of an expired claim; throws
 * PreconditionError (exit 4) on every disallowed state, BEFORE any transaction.
 *
 * `checkTaskStatus` cannot express this: its `claimerMustBe` is an AND applied
 * after the status gate, and there is no disjunction operator — so "the claimer
 * at any time OR a third party once expired" needs a hand-written gate, the
 * same escape hatch `gateClaimableTask` already is. `gateClaimableTask` itself
 * is NOT reusable here: it rejects CLAIMED-and-not-expired unconditionally,
 * which is the single most common unclaim case (a healthy self-release).
 */
export function gateUnclaimableTask(
  task: TaskOnChain,
  taskLabel: string,
  caller: string
): boolean {
  if (task.status !== TASK_STATUS.CLAIMED) {
    throw new PreconditionError(
      `Task ${taskLabel} is ${taskStatusName(task.status)} — only CLAIMED tasks can be released.`,
      task.status === TASK_STATUS.SUBMITTED
        ? `Delivered work must be reviewed first. Reject it, then release: pop task review --task ${taskLabel} --action reject --reason "..." && pop task unclaim --task ${taskLabel}`
        : `Inspect it with: pop task view --task ${taskLabel}`
    );
  }

  // The claimer may always release — no mask check, no deadline check.
  if (task.claimer.toLowerCase() === caller.toLowerCase()) return true;

  if (deriveClaimState(task) === 'expired-claimable') return false;

  // A deadline-less claim never expires, so "wait for it to expire" would be a
  // lie. deriveClaimState returns 'none' (not 'expired-claimable') for that
  // case, and pre-v6 implementations leave all three deadline fields undefined
  // rather than 0 — hence the truthiness guard rather than a `!== 0` check.
  const deadline = task.claimDeadline || task.absoluteDeadline || 0;
  throw new PreconditionError(
    deadline
      ? `Task ${taskLabel} is claimed by ${task.claimer} and the claim has not expired (${formatCountdown(deadline)}).`
      : `Task ${taskLabel} is claimed by ${task.claimer} and has no deadline, so the claim can never expire on its own.`,
    deadline
      ? `Wait for the claim to expire, or ask ${task.claimer} to run: pop task unclaim --task ${taskLabel}`
      : `Give it a deadline first, then retry: pop task update --task ${taskLabel} --deadline <a past time>`
  );
}

/**
 * Pull the release facts out of the receipt logs. Deliberately NOT
 * `claimReceiptFields`: that helper looks for TaskClaimExpired, which unclaim
 * never emits, and would silently report nothing.
 */
export function unclaimReceiptFields(
  result: TxResult
): Record<string, string | number | boolean | undefined> {
  if (!result.success || result.dryRun) return {};
  const logs = result.logs ?? [];
  const fields: Record<string, string | number | boolean | undefined> = {};

  const released = logs.find(l => l.name === 'TaskUnclaimed');
  if (released?.args?.previousClaimer) {
    fields.previousClaimer = released.args.previousClaimer;
    fields.releasedBy = released.args.caller;
    fields.selfRelease =
      String(released.args.previousClaimer).toLowerCase()
      === String(released.args.caller).toLowerCase();
  }

  // TaskClaimDeadlineSet(id, 0) follows ONLY when a claim window was actually
  // running — its absence is normal for a windowless task, never an error.
  const deadlineSet = logs.find(l => l.name === 'TaskClaimDeadlineSet');
  if (deadlineSet?.args?.claimDeadline !== undefined) {
    fields.claimDeadlineCleared = Number(deadlineSet.args.claimDeadline.toString()) === 0;
  }
  return fields;
}

/**
 * Machine-readable companion to the human warnings below.
 *
 * `output.warn` is a no-op under `--json`, so every caveat echoed to a human
 * would otherwise be invisible to automation — which is the audience that most
 * needs the indexing one. These keys ride in the success payload instead.
 */
export function unclaimAdvisoryFields(
  chainId: number,
  raced: boolean
): Record<string, string | boolean> {
  const indexed = chainIndexesTaskReleases(chainId);
  return {
    subgraphIndexesReleases: indexed,
    ...(indexed ? {} : {
      indexingWarning:
        "This chain's subgraph does not index task releases — pop task list/view will keep "
        + 'showing this task as claimed by the previous assignee until the subgraph is upgraded.',
    }),
    ...(raced ? {
      consentWarning:
        'This was confirmed as a self-release but landed as a third-party force-release — the '
        + 'claim was taken over between pre-flight and mining.',
    } : {}),
  };
}

/**
 * Human echo after a release. The subgraph-indexing warning is the load-bearing
 * one: TaskManager v7 is live on every chain, but only Gnosis indexes
 * `TaskUnclaimed` today, so elsewhere the release succeeds on-chain and is then
 * invisible to every read surface — the task keeps showing as claimed by the
 * previous assignee. That is not discoverable later, so it is said at the
 * moment it happens.
 *
 * `dryRun` short-circuits everything: nothing was sent, so claiming "the
 * on-chain release itself succeeded" would be a lie.
 */
export function echoUnclaimReceipt(
  fields: Record<string, string | number | boolean | undefined>,
  task: TaskOnChain | null,
  chainId: number,
  opts?: { dryRun?: boolean; consentedAsSelfRelease?: boolean }
): void {
  if (opts?.dryRun) return;

  if (fields.selfRelease === false && fields.previousClaimer) {
    output.info(`Force-release confirmed — the expired claim by ${fields.previousClaimer} was released.`);
  }

  // Defence in depth for the pre-flight/mining race: we consented to a
  // frictionless self-release, but the receipt says we released someone else.
  if (opts?.consentedAsSelfRelease && fields.selfRelease === false) {
    output.warn(
      `This was confirmed as a self-release, but the claim was taken over by `
      + `${fields.previousClaimer} before the transaction mined — it landed as a `
      + 'third-party force-release. Their claim was already expired, so it was forfeit either way.'
    );
  }

  const nowSecs = Math.floor(Date.now() / 1000);
  if (task?.absoluteDeadline && task.absoluteDeadline > nowSecs) {
    output.warn(
      `The task's absolute deadline (${formatDeadline(task.absoluteDeadline)}) is unchanged — `
      + `re-claiming refreshes the completion window, but nothing resets that cutoff `
      + `(${formatCountdown(task.absoluteDeadline)}).`
    );
  }

  if (!chainIndexesTaskReleases(chainId)) {
    output.warn(
      "This chain's subgraph does not index task releases yet — the task will keep showing as "
      + 'claimed by the previous assignee in pop task list/view until the subgraph is upgraded. '
      + 'The on-chain release itself succeeded.'
    );
  }
}

export const unclaimHandler = {
  builder: (yargs: Argv) => yargs
    .option('task', { type: 'string', demandOption: true, describe: 'Task ID' })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Explicit idempotency key. Two releases of the same task within 15 minutes return the same result without re-submitting. Default: auto-derived from argv.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit.',
    })
    .example('pop task unclaim --task 12', 'Release a task you claimed back to the pool')
    .example('pop task unclaim --task 12 --yes', "Force-release someone else's EXPIRED claim (needs ASSIGN)"),

  handler: async (argv: ArgumentsCamelCase<UnclaimArgs>) => {
    const spin = output.spinner('Checking task state...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);
      const taskManagerAddress = requireModule(ctx.modules, 'taskManagerAddress');
      const parsedTaskId = parseTaskId(argv.task);

      // ── Feature gate ──────────────────────────────────────────────────
      // Runs before pre-flight, and under --dry-run too. Every org resolves
      // to v7 today (all beacons are Mirror mode), so this exists for orgs
      // that later PIN to an older implementation — where it turns an
      // undecodable "cannot estimate gas" into an actionable message.
      const features = await detectTaskManagerFeatures(
        ctx.provider,
        taskManagerAddress,
        ctx.chainId,
        { orgId: ctx.orgId }
      );
      if (!features.unclaim) {
        spin.stop();
        output.error(featureUnavailable(
          'releasing a claimed task',
          'TaskManager v7',
          'Upgrade the org\'s TaskManager beacon, or wait for the claim deadline to expire so it can be taken over.'
        ));
        process.exit(EXIT.PRECONDITION);
        return;
      }
      // Everything below manages its own spinner: withIdempotency can short-
      // circuit before run() ever executes, and output.success does not stop a
      // running spinner, so leaving this one alive would spin over a cache hit.
      spin.stop();

      // Pre-flight, confirmation and send all live inside run() so an
      // idempotent retry returns the CACHED success instead of re-running the
      // gate — post-release the task is UNCLAIMED, which would otherwise fail
      // the retry rather than confirm it. Same reasoning as task submit.
      const run = async (): Promise<Record<string, any>> => {
        let task: TaskOnChain | null = null;
        // null = route not determined, because --no-preflight skipped the read
        // that would tell us. Treated as the third-party route below: a flag
        // whose job is skipping CHECKS must not silently downgrade CONSENT.
        let selfRelease: boolean | null = null;
        const preSpin = output.spinner('Running pre-flight checks...');
        preSpin.start();
        try {
          if (argv.preflight !== false) {
            task = await readTaskForPreflight(ctx.provider, taskManagerAddress, argv.task);
            selfRelease = gateUnclaimableTask(task, argv.task, ctx.address);
          }
          await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
        } finally {
          preSpin.stop();
        }

        if (selfRelease === false && task) {
          output.info(`Force-releasing the expired claim held by ${task.claimer}`);
        }

        // A self-release only earns the frictionless (non-destructive) path when
        // it cannot turn into a third-party force-release before it mines.
        //
        // `unclaimTask(uint256)` takes only an id — there is no expected-claimer
        // argument — so the intent CANNOT be bound on-chain. The pre-flight read
        // is therefore a snapshot, and every takeover path (claimTask,
        // assignTask, approveApplication) requires `_claimExpired`. So an
        // ALREADY-EXPIRED claim is takeover-able at any moment with no time
        // pressure on the other party: our transaction would then land as a
        // force-release of whoever won the race, having been confirmed as a
        // harmless self-release with no --yes. That case takes destructive
        // consent.
        //
        // Residual, deliberately accepted: a claim that is live at pre-flight
        // but lapses in the seconds before mining, AND is taken over inside that
        // same sliver. echoUnclaimReceipt reports it from the receipt when it
        // happens, since it cannot be prevented without an on-chain binding.
        const raceable = task !== null && deriveClaimState(task) === 'expired-claimable';
        const frictionless = selfRelease === true && !raceable;

        await confirmWrite(argv, {
          task: `#${argv.task}`,
          claimer: task?.claimer,
          mode: selfRelease === null
            ? 'unverified — pre-flight skipped'
            : selfRelease
              ? (raceable ? 'self-release of an EXPIRED claim (takeover-able)' : 'self-release')
              : 'forced release of an EXPIRED claim',
          payout: task ? formatToken(task.payout, 18, 'PT') : undefined,
          org: argv.org,
          chain: ctx.networkName,
        }, frictionless
          ? { actionLabel: 'About to release your claim' }
          : {
            destructive: true,
            actionLabel: selfRelease === false
              ? 'About to FORCE-RELEASE another member\'s expired claim'
              : selfRelease === null
                ? 'About to release a claim without verifying whose it is'
                : 'About to release your EXPIRED claim (it may be taken over before this lands)',
          });

        const txSpin = output.spinner('Releasing task...');
        txSpin.start();
        const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', ctx.signer);
        const result = await executeTx(contract, 'unclaimTask', [parsedTaskId], { dryRun: argv.dryRun });
        txSpin.stop();

        const receiptFields = unclaimReceiptFields(result);
        // The race bit if we consented as a frictionless self-release but the
        // receipt names someone else as the previous claimer.
        const raced = frictionless && receiptFields.selfRelease === false;
        // Advisories are omitted on a dry run: nothing was sent, so there is no
        // indexing consequence and no race to report.
        const advisory = result.dryRun ? {} : unclaimAdvisoryFields(ctx.chainId, raced);
        finishWrite(result, {
          successMsg: `Task ${argv.task} released back to the pool`,
          fields: { taskId: argv.task, ...receiptFields, ...advisory },
        });
        echoUnclaimReceipt(receiptFields, task, ctx.chainId, {
          dryRun: result.dryRun,
          consentedAsSelfRelease: frictionless,
        });
        return { taskId: argv.task, txHash: result.txHash };
      };

      // Dry runs simulate unconditionally: they neither consult nor record
      // the idempotency cache (nothing lands on-chain).
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'task.unclaim', run);
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
