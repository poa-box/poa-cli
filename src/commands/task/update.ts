/**
 * pop task update — edit any updatable task field via TaskManager.updateTask.
 *
 * updateTask is a FULL OVERWRITE on-chain:
 *   updateTask(id, newPayout, newTitle, newMetadataHash, newBountyToken,
 *              newBountyPayout, newAbsoluteDeadline, newCompletionWindow)
 * so this command reads the current state first (chain via task-lens for
 * payout/bounty/deadlines, subgraph + IPFS for title/description/metadata)
 * and merges only the flags the caller passed. Metadata is re-pinned to IPFS
 * only when --name/--description actually change it.
 *
 * Status gate — VERIFIED against contracts origin/main src/TaskManager.sol:
 *   `if (t.status == Status.COMPLETED || t.status == Status.CANCELLED) revert BadStatus();`
 * i.e. UNCLAIMED, CLAIMED and SUBMITTED are all editable; only the terminal
 * states are immutable. (The permission gate is what narrows post-claim
 * editing: CREATE-holders may edit only while UNCLAIMED; executor / project
 * manager / EDIT_FULL(bit 128) may edit any non-terminal status.)
 *
 * Deadline semantics — also verified: a PAST --deadline is deliberately
 * accepted by the contract on update (unlike create). It is the admin lever
 * that opens an abandoned CLAIMED task to takeover, since cancelTask is
 * UNCLAIMED-only.
 *
 * Permissions are NOT pre-checked: TaskPerm masks are not readable on-chain,
 * so a decoded Unauthorized revert (with the perms hint from the error
 * catalog) is the authoritative answer.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson, fetchJson } from '../../lib/ipfs';
import {
  stringToBytes,
  ipfsCidToBytes32,
  parseTaskId,
  parseDeadline,
  parseDurationSeconds,
  formatDeadline,
  formatAddress,
} from '../../lib/encoding';
import { detectTaskManagerFeatures, featureUnavailable } from '../../lib/version';
import { getTaskOnChain, TASK_STATUS, taskStatusName } from '../../lib/task-lens';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance, checkTaskStatus } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { formatToken } from '../../lib/format';
import { getTokenDecimals } from '../../config/tokens';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import { query } from '../../lib/subgraph';
import { FETCH_PROJECTS_DATA } from '../../queries/task';
import * as output from '../../lib/output';

interface UpdateArgs {
  org: string;
  task: string;
  payout?: number;
  name?: string;
  description?: string;
  'bounty-token'?: string;
  'bounty-amount'?: number;
  deadline?: string;
  'completion-window'?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

/** Flags that constitute an actual edit (at least one required). */
const CHANGE_FLAGS = [
  'payout',
  'name',
  'description',
  'bounty-token',
  'bounty-amount',
  'deadline',
  'completion-window',
] as const;

/**
 * parseDeadline for the update path: the contract deliberately accepts a
 * PAST absolute deadline here (admin lever — immediately opens a CLAIMED
 * task to takeover), so downgrade parseDeadline's past-check to a warning.
 * Only absolute forms (unix seconds / ISO date) can resolve to the past —
 * relative forms ("7d") are always future — so re-parsing with now=0 never
 * changes relative math.
 */
export function parseUpdateDeadline(input: string): { value: number; isPast: boolean } {
  try {
    return { value: parseDeadline(input), isPast: false };
  } catch (err: any) {
    if (err instanceof CliError && /is in the past/.test(err.message)) {
      return { value: parseDeadline(input, 0), isPast: true };
    }
    throw err;
  }
}

/** Locate a task in the FETCH_PROJECTS_DATA result by plain or composite ID. */
function findSubgraphTask(projects: any[], taskId: string): any | null {
  for (const project of projects) {
    for (const task of project.tasks || []) {
      if (task.taskId === taskId || task.id?.endsWith(`-${taskId}`)) return task;
    }
  }
  return null;
}

/** "old → new" when changed, plain value otherwise (for the confirm summary). */
function delta(oldValue: string, newValue: string): string {
  return oldValue === newValue ? oldValue : `${oldValue} → ${newValue}`;
}

export const updateHandler = {
  builder: (yargs: Argv) => yargs
    .option('task', { type: 'string', demandOption: true, describe: 'Task ID' })
    .option('payout', { type: 'number', describe: 'New PT payout amount' })
    .option('name', { type: 'string', describe: 'New task name (re-pins metadata)' })
    .option('description', { type: 'string', describe: 'New task description (re-pins metadata)' })
    .option('bounty-token', { type: 'string', describe: 'New bounty ERC20 token address ("none" clears the bounty)' })
    .option('bounty-amount', { type: 'number', describe: 'New bounty payout amount (0 clears)' })
    .option('deadline', { type: 'string', describe: 'New absolute claim deadline ("0" = none; a PAST value opens a claimed task to takeover)' })
    .option('completion-window', { type: 'string', describe: 'New per-claim submission window, e.g. "48h" ("0" = none)' })
    .example('pop task update --task 12 --payout 25', 'Raise task 12\'s payout; every other field is preserved')
    .example('pop task update --task 12 --name "New title" --deadline 7d', 'Rename and set a one-week claim deadline in one tx'),

  handler: async (argv: ArgumentsCamelCase<UpdateArgs>) => {
    const spin = output.spinner('Reading current task state...');
    spin.start();

    try {
      // ── 0. Fail fast on input problems before any network work ─────────
      // Check kebab AND camel spellings: yargs sets both, but direct handler
      // invocation (tests, programmatic use) may set only the camel form.
      const changed = CHANGE_FLAGS.filter((flag) => {
        const camel = flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        return (argv as any)[flag] !== undefined || (argv as any)[camel] !== undefined;
      });
      if (changed.length === 0) {
        spin.stop();
        output.error(
          'Nothing to update — pass at least one field flag.',
          { suggestion: `Available: ${CHANGE_FLAGS.map(f => `--${f}`).join(', ')}` }
        );
        process.exit(EXIT.USAGE);
        return;
      }

      let deadlineIsPast = false;
      let newAbsoluteDeadline: number | undefined;
      if (argv.deadline !== undefined) {
        const parsed = parseUpdateDeadline(argv.deadline);
        newAbsoluteDeadline = parsed.value;
        deadlineIsPast = parsed.isPast;
      }
      const newCompletionWindow = argv.completionWindow !== undefined
        ? parseDurationSeconds(argv.completionWindow)
        : undefined;

      // ── 1. Resolve org + signer, gate on the v6 signature ──────────────
      const ctx = await getWriteContext(argv);
      const taskManagerAddress = requireModule(ctx.modules, 'taskManagerAddress');
      const taskId = parseTaskId(argv.task);

      const features = await detectTaskManagerFeatures(ctx.provider, taskManagerAddress, ctx.chainId);
      if (!features.deadlines) {
        // Pre-v6 implementations expose a 6-field updateTask that no longer
        // exists in the synced ABI — do NOT attempt it; degrade clearly.
        spin.stop();
        output.error(featureUnavailable(
          'full task editing (updateTask)',
          'TaskManager v6',
          'Upgrade the org TaskManager beacon, or use pop task edit-meta if the org supports metadata-only edits.'
        ));
        process.exit(EXIT.PRECONDITION);
        return;
      }

      // ── 2. READ: current on-chain fields (authoritative via lens) ──────
      const current = await getTaskOnChain(ctx.provider, taskManagerAddress, taskId);
      if (current.status === TASK_STATUS.COMPLETED || current.status === TASK_STATUS.CANCELLED) {
        spin.stop();
        output.error(
          `Task ${taskId} is ${taskStatusName(current.status)} — terminal states are immutable on-chain.`,
          { suggestion: 'Create a new task instead (pop task create).' }
        );
        process.exit(EXIT.PRECONDITION);
        return;
      }

      // ── 3. READ: current title/description/metadata (subgraph → IPFS) ──
      const metadataChanging = argv.name !== undefined || argv.description !== undefined;
      let subgraphTask: any = null;
      try {
        const result = await query<any>(FETCH_PROJECTS_DATA, { orgId: ctx.orgId }, argv.chain);
        subgraphTask = findSubgraphTask(result.organization?.taskManager?.projects || [], taskId);
      } catch {
        // Subgraph unavailable — handled below based on what the merge needs.
      }

      let metadata = subgraphTask?.metadata || null;
      if (!metadata && subgraphTask?.metadataHash) {
        try {
          metadata = await fetchJson(subgraphTask.metadataHash);
        } catch { /* IPFS lag — handled below */ }
      }

      const currentName: string | undefined = metadata?.name ?? subgraphTask?.title ?? undefined;
      const currentDescription: string | undefined = metadata?.description ?? undefined;
      const currentMetadataHash: string | undefined = subgraphTask?.metadataHash ?? undefined;

      // updateTask overwrites title + metadataHash even when only, say,
      // --payout changed — so the current values must be recoverable.
      if (!metadataChanging && (currentName === undefined || !currentMetadataHash)) {
        spin.stop();
        output.error(
          `Task ${taskId} metadata is not indexed yet (subgraph lag) — cannot preserve the current title/metadata through a full-overwrite update.`,
          { suggestion: 'Retry in a few seconds, or pass --name and --description explicitly.' }
        );
        process.exit(EXIT.INFRA);
        return;
      }
      if (metadataChanging
        && (argv.name === undefined || argv.description === undefined)
        && (currentName === undefined || currentDescription === undefined)) {
        spin.stop();
        output.error(
          `Task ${taskId} metadata is not indexed yet (subgraph lag) — cannot merge a partial metadata edit.`,
          { suggestion: 'Retry in a few seconds, or pass BOTH --name and --description.' }
        );
        process.exit(EXIT.INFRA);
        return;
      }

      // ── 4. MERGE: flags override, everything else preserved ────────────
      const finalPayout = argv.payout !== undefined
        ? ethers.utils.parseUnits(argv.payout.toString(), 18)
        : current.payout;

      let finalBountyToken = current.bountyToken;
      if (argv.bountyToken !== undefined) {
        if (argv.bountyToken.toLowerCase() === 'none') {
          finalBountyToken = ethers.constants.AddressZero;
        } else if (ethers.utils.isAddress(argv.bountyToken)) {
          finalBountyToken = ethers.utils.getAddress(argv.bountyToken);
        } else {
          throw new CliError(`Invalid --bounty-token "${argv.bountyToken}".`, EXIT.USAGE, 'Pass an ERC20 address, or "none" to clear the bounty.');
        }
      }

      let finalBountyPayout: ethers.BigNumber = current.bountyPayout;
      if (finalBountyToken === ethers.constants.AddressZero) {
        finalBountyPayout = ethers.BigNumber.from(0); // zero token ⇒ zero payout (contract validation)
      } else if (argv.bountyAmount !== undefined) {
        finalBountyPayout = argv.bountyAmount > 0
          ? ethers.utils.parseUnits(argv.bountyAmount.toString(), getTokenDecimals(finalBountyToken))
          : ethers.BigNumber.from(0);
      } else if (argv.bountyToken !== undefined && finalBountyToken.toLowerCase() !== current.bountyToken.toLowerCase()) {
        output.warn('Bounty token changed without --bounty-amount — the raw current amount is kept, which may mean a different human value if the tokens use different decimals.');
      }

      const finalDeadline = newAbsoluteDeadline !== undefined ? newAbsoluteDeadline : (current.absoluteDeadline ?? 0);
      const finalWindow = newCompletionWindow !== undefined ? newCompletionWindow : (current.completionWindow ?? 0);
      const finalName = argv.name ?? currentName ?? '';
      const finalDescription = argv.description ?? currentDescription ?? '';

      // Re-pin only when the metadata content actually changes.
      let finalMetadataHash = currentMetadataHash
        ? ipfsCidToBytes32(currentMetadataHash)
        : ethers.constants.HashZero;
      let newCid: string | undefined;
      const metadataActuallyChanged = metadataChanging
        && (finalName !== currentName || finalDescription !== currentDescription);
      if (metadataActuallyChanged) {
        if (!metadata) {
          output.warn('Current metadata could not be fetched — location/difficulty/estHours will reset to defaults in the re-pinned metadata.');
        }
        // Key order MUST match src/commands/task/create.ts (frontend parity).
        const metadataJson = {
          name: finalName,
          description: finalDescription,
          location: metadata?.location || '',
          difficulty: metadata?.difficulty || 'medium',
          estHours: metadata?.estimatedHours || metadata?.estHours || 0,
          submission: metadata?.submission || '',
        };
        spin.text = 'Pinning updated metadata to IPFS...';
        newCid = await pinJson(JSON.stringify(metadataJson));
        finalMetadataHash = ipfsCidToBytes32(newCid);
      }

      // ── 5. Pre-flight (skippable with --no-preflight) ──────────────────
      // Allowed statuses verified against TaskManager.sol: any non-terminal.
      await runPreflight(ctx.provider, [
        checkGasBalance(ctx.address),
        checkTaskStatus(taskManagerAddress, taskId, [
          TASK_STATUS.UNCLAIMED,
          TASK_STATUS.CLAIMED,
          TASK_STATUS.SUBMITTED,
        ]),
      ], { skip: !argv.preflight });

      spin.stop();

      if (deadlineIsPast) {
        output.warn('The new deadline is in the past — this immediately opens the task to claim takeover (v6 admin lever for abandoned claims).');
      }

      // ── 6. Confirm with the FULL final field set (old → new) ───────────
      const currentBountyLabel = current.bountyToken === ethers.constants.AddressZero
        ? 'none'
        : `${current.bountyPayout.toString()} raw @ ${formatAddress(current.bountyToken)}`;
      const finalBountyLabel = finalBountyToken === ethers.constants.AddressZero
        ? 'none'
        : `${finalBountyPayout.toString()} raw @ ${formatAddress(finalBountyToken)}`;

      const finalFields: Record<string, string | number | undefined> = {
        task: taskId,
        status: taskStatusName(current.status),
        payout: delta(formatToken(current.payout, 18, 'PT'), formatToken(finalPayout, 18, 'PT')),
        title: delta(currentName ?? '(unknown)', finalName),
        description: metadataActuallyChanged ? delta(currentDescription ?? '(unknown)', finalDescription) : undefined,
        bounty: delta(currentBountyLabel, finalBountyLabel),
        deadline: delta(formatDeadline(current.absoluteDeadline ?? 0), formatDeadline(finalDeadline)),
        completionWindow: delta(
          current.completionWindow ? `${current.completionWindow}s` : 'none',
          finalWindow ? `${finalWindow}s` : 'none'
        ),
        metadataHash: metadataActuallyChanged
          ? delta(finalMetadataHash === ethers.constants.HashZero ? 'none' : '(current)', finalMetadataHash)
          : undefined,
      };

      await confirmWrite(argv, finalFields, { actionLabel: `Update task ${taskId} (full overwrite)` });

      // --dry-run: surface the merged final fields, then the gas estimate.
      if (argv.dryRun) {
        output.keyValueBlock('Final task fields (merged)', finalFields);
      }

      const txSpin = output.spinner('Sending updateTask...');
      txSpin.start();
      const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', ctx.signer);
      const result = await executeTx(contract, 'updateTask', [
        taskId,
        finalPayout,
        stringToBytes(finalName),
        finalMetadataHash,
        finalBountyToken,
        finalBountyPayout,
        finalDeadline,
        finalWindow,
      ], { dryRun: argv.dryRun });
      txSpin.stop();

      finishWrite(result, {
        successMsg: `Task ${taskId} updated`,
        fields: {
          taskId,
          payout: formatToken(finalPayout, 18, 'PT'),
          title: finalName,
          bountyToken: finalBountyToken === ethers.constants.AddressZero ? undefined : finalBountyToken,
          bountyPayout: finalBountyPayout.isZero() ? undefined : finalBountyPayout.toString(),
          deadline: formatDeadline(finalDeadline),
          completionWindowSeconds: finalWindow || undefined,
          ipfsCid: newCid,
          fieldsChanged: changed.join(','),
        },
      });
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
