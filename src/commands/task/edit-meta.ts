/**
 * pop task edit-meta — metadata-only editing via TaskManager.updateTaskMetadata.
 *
 * updateTaskMetadata(id, newTitle, newMetadataHash) rewrites the title and
 * IPFS pointer while preserving payout/bounty fields verbatim on-chain (no
 * budget side effects). Like update, it is a full overwrite of the metadata
 * pair, so we read the current name/description first (subgraph → IPFS
 * fallback) and merge.
 *
 * Status gate — VERIFIED against contracts origin/main src/TaskManager.sol
 * (updateTaskMetadata): identical to updateTask —
 *   `if (t.status == Status.COMPLETED || t.status == Status.CANCELLED) revert BadStatus();`
 * so UNCLAIMED / CLAIMED / SUBMITTED all pass; only terminal states refuse.
 * Permission gate (not pre-checked; masks aren't readable on-chain):
 * executor / project manager always; EDIT_META (bit 64) or EDIT_FULL
 * (bit 128) in any non-terminal status; CREATE only while UNCLAIMED.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson, fetchJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32, parseTaskId } from '../../lib/encoding';
import { detectTaskManagerFeatures, featureUnavailable } from '../../lib/version';
import { getTaskOnChain, TASK_STATUS, taskStatusName } from '../../lib/task-lens';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance, checkTaskStatus } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import { query } from '../../lib/subgraph';
import { FETCH_PROJECTS_DATA } from '../../queries/task';
import { findSubgraphTask } from './helpers';
import * as output from '../../lib/output';

interface EditMetaArgs {
  org: string;
  task: string;
  name?: string;
  description?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

function delta(oldValue: string, newValue: string): string {
  return oldValue === newValue ? oldValue : `${oldValue} → ${newValue}`;
}

export const editMetaHandler = {
  builder: (yargs: Argv) => yargs
    .option('task', { type: 'string', demandOption: true, describe: 'Task ID' })
    .option('name', { type: 'string', describe: 'New task name' })
    .option('description', { type: 'string', describe: 'New task description' })
    .example('pop task edit-meta --task 12 --description "Clarified acceptance criteria"', 'Fix a task description without touching payout/bounty/deadlines'),

  handler: async (argv: ArgumentsCamelCase<EditMetaArgs>) => {
    const spin = output.spinner('Reading current task metadata...');
    spin.start();

    try {
      if (argv.name === undefined && argv.description === undefined) {
        spin.stop();
        output.error('Nothing to edit — pass --name and/or --description.');
        process.exit(EXIT.USAGE);
        return;
      }

      const ctx = await getWriteContext(argv);
      const taskManagerAddress = requireModule(ctx.modules, 'taskManagerAddress');
      const taskId = parseTaskId(argv.task);

      // Feature-gate: updateTaskMetadata shipped with TaskManager v5.
      const features = await detectTaskManagerFeatures(ctx.provider, taskManagerAddress, ctx.chainId);
      if (!features.editMeta) {
        spin.stop();
        output.error(featureUnavailable(
          'post-claim metadata editing',
          'TaskManager v5',
          'Upgrade the org TaskManager beacon, or recreate the task with the corrected metadata.'
        ));
        process.exit(EXIT.PRECONDITION);
        return;
      }

      // Authoritative status read (also proves the task exists).
      const current = await getTaskOnChain(ctx.provider, taskManagerAddress, taskId);
      if (current.status === TASK_STATUS.COMPLETED || current.status === TASK_STATUS.CANCELLED) {
        spin.stop();
        output.error(
          `Task ${taskId} is ${taskStatusName(current.status)} — terminal states are immutable on-chain.`,
          { suggestion: 'Metadata of completed/cancelled tasks cannot be edited.' }
        );
        process.exit(EXIT.PRECONDITION);
        return;
      }

      // READ current metadata: subgraph first, IPFS pointer as fallback.
      let subgraphTask: any = null;
      try {
        const result = await query<any>(FETCH_PROJECTS_DATA, { orgId: ctx.orgId }, argv.chain);
        subgraphTask = findSubgraphTask(result.organization?.taskManager?.projects || [], taskId);
      } catch { /* handled below */ }

      let metadata = subgraphTask?.metadata || null;
      if (!metadata && subgraphTask?.metadataHash) {
        try {
          metadata = await fetchJson(subgraphTask.metadataHash);
        } catch { /* handled below */ }
      }

      const currentName: string | undefined = metadata?.name ?? subgraphTask?.title ?? undefined;
      const currentDescription: string | undefined = metadata?.description ?? undefined;

      if ((argv.name === undefined && currentName === undefined)
        || (argv.description === undefined && currentDescription === undefined)) {
        spin.stop();
        output.error(
          `Task ${taskId} metadata is not indexed yet (subgraph lag) — cannot merge a partial metadata edit.`,
          { suggestion: 'Retry in a few seconds, or pass BOTH --name and --description.' }
        );
        process.exit(EXIT.INFRA);
        return;
      }

      // MERGE
      const finalName = argv.name ?? currentName ?? '';
      const finalDescription = argv.description ?? currentDescription ?? '';
      if (finalName === currentName && finalDescription === currentDescription) {
        spin.stop();
        output.success(`Task ${taskId} metadata already matches — nothing to change`, {
          taskId,
          title: finalName,
        });
        return;
      }

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
        // Soft due date is metadata-borne; a re-pin that drops it deletes it.
        // Frontend appends this key last and only when set.
        ...(metadata?.dueDate ? { dueDate: Math.floor(Number(metadata.dueDate)) } : {}),
      };

      // Pre-flight — allowed statuses verified: any non-terminal.
      await runPreflight(ctx.provider, [
        checkGasBalance(ctx.address),
        checkTaskStatus(taskManagerAddress, taskId, [
          TASK_STATUS.UNCLAIMED,
          TASK_STATUS.CLAIMED,
          TASK_STATUS.SUBMITTED,
        ]),
      ], { skip: !argv.preflight });

      spin.stop();

      await confirmWrite(argv, {
        task: taskId,
        status: taskStatusName(current.status),
        title: delta(currentName ?? '(unknown)', finalName),
        description: delta(currentDescription ?? '(unknown)', finalDescription),
      }, { actionLabel: `Edit task ${taskId} metadata` });

      const pinSpin = output.spinner('Pinning updated metadata to IPFS...');
      pinSpin.start();
      const cid = await pinJson(JSON.stringify(metadataJson));
      const metadataHash = ipfsCidToBytes32(cid);

      pinSpin.text = 'Sending updateTaskMetadata...';
      const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', ctx.signer);
      const result = await executeTx(
        contract,
        'updateTaskMetadata',
        [taskId, stringToBytes(finalName), metadataHash],
        { dryRun: argv.dryRun }
      );
      pinSpin.stop();

      finishWrite(result, {
        successMsg: `Task ${taskId} metadata updated`,
        fields: {
          taskId,
          title: finalName,
          ipfsCid: cid,
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
