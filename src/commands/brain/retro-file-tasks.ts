/**
 * pop brain retro file-tasks — convert agreed retro changes into on-chain tasks.
 *
 * Usage:
 *
 *   pop brain retro file-tasks --retro retro-327-1776...
 *   pop brain retro file-tasks --retro retro-327-1776... --dry-run
 *   pop brain retro file-tasks --retro retro-327-1776... --project "CLI Infrastructure"
 *
 * Flow:
 *
 *   1. Load the retro from pop.brain.retros.
 *   2. Find every proposed change whose status is 'agreed'. Changes at any
 *      other status are skipped — 'proposed' needs more discussion first,
 *      'rejected' was explicitly rejected, 'modified' needs a second round,
 *      and 'filed' is already done (this is the idempotency guarantee:
 *      re-running the command is safe because filed changes are no-ops).
 *   3. For each agreed change:
 *      a. Call `pop task create` with a structured description derived
 *         from the change summary + details + retro window.
 *      b. Capture the returned task id.
 *      c. Run `updateChangeStatus` to flip the change to 'filed' with
 *         filedTaskId set.
 *   4. When every change is filed or rejected, the updateChangeStatus op
 *      auto-advances the retro status to 'shipped' with a closedAt
 *      timestamp.
 *
 * ## Idempotency
 *
 * This command is safe to run multiple times. A change with status='filed'
 * is skipped. A change that was already converted won't be re-filed. The
 * idempotency guarantee requires the `agreed → filed` transition to be
 * the only way a change gets converted. Operators who want to re-file a
 * change after filing it should run `pop brain retro respond --vote
 * change-X=agree` again and then call file-tasks — but the previous
 * filed task id is never overwritten, so the old task sticks around
 * unless manually cancelled. That's a deliberate safety design: no
 * accidental re-filing of the same work.
 *
 * ## Dry-run
 *
 * `--dry-run` prints the plan (which changes would be filed, what task
 * description would be produced) without actually creating any tasks or
 * mutating the retro. Use this to preview before committing.
 *
 * ## Project selection
 *
 * Defaults to "CLI Infrastructure" — the historical catch-all for brain
 * layer + CLI work. Override with --project if the retro's proposed
 * changes belong to a different project (e.g. "DeFi Research",
 * "Agent Protocol").
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { spawnSync } from 'child_process';
import { openBrainDoc, stopBrainNode } from '../../lib/brain';
import { routedDispatch } from '../../lib/brain-ops';
import type { BrainRetro, RetroProposedChange } from '../../lib/brain-projections';
import * as output from '../../lib/output';
import { query } from '../../lib/subgraph';
import { resolveOrgId } from '../../lib/resolve';

/**
 * Task #494 (retro-509 change-3, HB#874): pre-flight query to detect
 * already-filed tasks for a (retroId, changeId) pair. Prevents the
 * race-condition duplicate-task pattern from retro-839 (sentinel HB#849
 * had to reconcile taxonomy fork between argus #485 + vigil #486).
 *
 * Search: the description template in buildTaskDescription() always
 * embeds `- Retro id: {retro.id}` and `- Change id: {change.id}` on
 * separate lines. Any task created via file-tasks (by any agent) has
 * these markers. Querying the subgraph for tasks with BOTH markers
 * returns a deterministic dedup identifier.
 *
 * Returns the existing task id if found, null otherwise.
 * Exported for unit testing.
 */
export async function findExistingFiledTask(
  orgId: string,
  chainId: number | undefined,
  retroId: string,
  changeId: string,
): Promise<string | null> {
  const gql = `
    query FindFiledTask($orgId: Bytes!) {
      organization(id: $orgId) {
        projects(first: 100) {
          tasks(first: 1000, orderBy: taskId, orderDirection: desc) {
            taskId
            metadata {
              description
            }
          }
        }
      }
    }
  `;
  try {
    const resp: any = await query(gql, { orgId }, chainId);
    const projects = resp?.organization?.projects || [];
    const retroMarker = `- Retro id: ${retroId}`;
    const changeMarker = `- Change id: ${changeId}`;
    for (const p of projects) {
      for (const t of p.tasks || []) {
        const desc = t?.metadata?.description || '';
        if (desc.includes(retroMarker) && desc.includes(changeMarker)) {
          return String(t.taskId);
        }
      }
    }
    return null;
  } catch {
    // If subgraph query fails, return null — idempotency guard fails open
    // rather than blocking legitimate filing. The retro CRDT status='filed'
    // check remains the primary single-agent idempotency mechanism.
    return null;
  }
}

interface RetroFileTasksArgs {
  doc: string;
  retro: string;
  project?: string;
  payout?: number;
  difficulty?: 'easy' | 'medium' | 'hard';
  estHours?: number;
  dryRun?: boolean;
  yes?: boolean;
}

/**
 * Build a structured task description for a filed retro change. The
 * description follows the /task-create skill template: context,
 * deliverable, acceptance, constraints, context links.
 */
function buildTaskDescription(
  retro: BrainRetro,
  change: RetroProposedChange,
): { name: string; description: string } {
  const windowLabel = retro.window
    ? `HB#${retro.window.from ?? '?'}..HB#${retro.window.to ?? '?'}`
    : '(no window)';
  const retroLabel = `retro ${retro.id} (${windowLabel})`;
  // Short name: take the summary, trim to 60 chars, no change-id prefix
  // so the task search UI reads cleanly.
  const name = change.summary.slice(0, 60);

  const descLines: string[] = [];
  descLines.push(`[CONTEXT] This task was filed automatically by pop brain retro file-tasks from ${retroLabel}, change ${change.id}. The change was agreed during retro discussion and is ready to ship.`);
  descLines.push('');
  descLines.push(`[SUMMARY]`);
  descLines.push(change.summary);
  if (change.details) {
    descLines.push('');
    descLines.push(`[DETAILS]`);
    descLines.push(change.details);
  }
  descLines.push('');
  descLines.push(`[RETRO CONTEXT]`);
  if (retro.author) descLines.push(`- Retro author: ${retro.author}`);
  descLines.push(`- Retro window: ${windowLabel}`);
  descLines.push(`- Retro id: ${retro.id}`);
  descLines.push(`- Change id: ${change.id}`);
  if (Array.isArray(retro.discussion) && retro.discussion.length > 0) {
    descLines.push(`- Discussion entries: ${retro.discussion.length}`);
    // Find vote tallies on this specific change.
    const voteCounts: Record<string, number> = {};
    for (const entry of retro.discussion) {
      const vote = entry?.votePerChange?.[change.id];
      if (typeof vote === 'string') {
        voteCounts[vote] = (voteCounts[vote] ?? 0) + 1;
      }
    }
    if (Object.keys(voteCounts).length > 0) {
      const tally = Object.entries(voteCounts).map(([v, n]) => `${n} ${v}`).join(', ');
      descLines.push(`- Votes on this change: ${tally}`);
    }
  }
  descLines.push('');
  descLines.push(`[ACCEPTANCE]`);
  descLines.push('- Implementation addresses the summary/details above');
  descLines.push('- Any tests or verification appropriate to the change type');
  descLines.push(`- Update the retro via pop brain retro respond with a shipped-note comment`);
  descLines.push('');
  descLines.push(`[CONSTRAINTS]`);
  descLines.push('- Reuse existing POP CLI + brain infra — do not introduce new persistence layers');
  descLines.push('- Pinned stack (helia@5.5.1, libp2p@2.10, gossipsub@14) unchanged');

  return { name, description: descLines.join('\n') };
}

export const retroFileTasksHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Brain document ID (default: pop.brain.retros)',
        type: 'string',
        default: 'pop.brain.retros',
      })
      .option('retro', {
        describe: 'The retro.id whose agreed changes should be filed as tasks',
        type: 'string',
        demandOption: true,
      })
      .option('project', {
        describe: 'Target project for the new tasks (default: "CLI Infrastructure")',
        type: 'string',
        default: 'CLI Infrastructure',
      })
      .option('payout', {
        describe: 'PT payout per filed task (default: 10)',
        type: 'number',
        default: 10,
      })
      .option('difficulty', {
        describe: 'Difficulty label for filed tasks',
        type: 'string',
        choices: ['easy', 'medium', 'hard'] as const,
        default: 'medium' as const,
      })
      .option('est-hours', {
        describe: 'Estimated hours per filed task',
        type: 'number',
        default: 2,
      })
      .option('dry-run', {
        describe: 'Preview what would be filed without creating tasks or mutating the retro',
        type: 'boolean',
        default: false,
      })
      .option('yes', {
        alias: 'y',
        describe: 'Skip confirmation prompts on the underlying pop task create calls',
        type: 'boolean',
        default: true,
      }),

  handler: async (argv: ArgumentsCamelCase<RetroFileTasksArgs>) => {
    try {
      // Load the retro via openBrainDoc (same read path as retro-show).
      const { doc } = await openBrainDoc(argv.doc);
      const retros: BrainRetro[] = Array.isArray(doc?.retros) ? doc.retros : [];
      const retro = retros.find(r => r?.id === argv.retro);
      if (!retro) {
        const candidates = retros.map(r => r?.id).filter((id): id is string => typeof id === 'string').slice(0, 8);
        output.error(
          `Retro "${argv.retro}" not found in ${argv.doc}. ` +
          `Available ids (first 8): ${candidates.join(', ') || '(none)'}`,
        );
        process.exitCode = 1;
        return;
      }
      if (retro.removed) {
        output.error(`Retro "${argv.retro}" is tombstoned — cannot file tasks against a removed retro.`);
        process.exitCode = 1;
        return;
      }

      // Partition changes by status.
      const changes: RetroProposedChange[] = Array.isArray(retro.proposedChanges) ? retro.proposedChanges : [];
      const agreed = changes.filter(c => c?.status === 'agreed');
      const alreadyFiled = changes.filter(c => c?.status === 'filed');
      const rejected = changes.filter(c => c?.status === 'rejected');
      const stillProposed = changes.filter(c => c?.status === 'proposed' || c?.status === 'modified');

      if (agreed.length === 0) {
        if (output.isJsonMode()) {
          output.json({
            status: 'noop',
            docId: argv.doc,
            retroId: argv.retro,
            reason: 'no changes at status=agreed',
            counts: {
              total: changes.length,
              agreed: 0,
              alreadyFiled: alreadyFiled.length,
              rejected: rejected.length,
              stillProposed: stillProposed.length,
            },
          });
        } else {
          console.log('');
          console.log(`  No changes at status='agreed' in retro "${argv.retro}". Nothing to file.`);
          console.log('');
          console.log(`  Current status breakdown:`);
          console.log(`    total:         ${changes.length}`);
          console.log(`    agreed:        0 (ready to file)`);
          console.log(`    already filed: ${alreadyFiled.length}`);
          console.log(`    rejected:      ${rejected.length}`);
          console.log(`    still in discussion: ${stillProposed.length}`);
          console.log('');
          if (stillProposed.length > 0) {
            console.log(`  Changes still under discussion:`);
            for (const c of stillProposed) console.log(`    - ${c.id}: ${c.summary}`);
            console.log('');
            console.log(`  Other agents need to agree via "pop brain retro respond --to ${argv.retro} --vote ${stillProposed[0]?.id}=agree" before they can be filed.`);
          }
          console.log('');
        }
        return;
      }

      // Dry-run: print the plan and exit.
      if (argv.dryRun) {
        console.log('');
        console.log(`  [DRY RUN] Would file ${agreed.length} task${agreed.length === 1 ? '' : 's'} for retro "${argv.retro}"`);
        console.log('');
        for (const change of agreed) {
          const { name, description } = buildTaskDescription(retro, change);
          console.log(`  === ${change.id} → new task ===`);
          console.log(`  name:        ${name}`);
          console.log(`  project:     ${argv.project}`);
          console.log(`  payout:      ${argv.payout} PT`);
          console.log(`  difficulty:  ${argv.difficulty}`);
          console.log(`  est hours:   ${argv.estHours}`);
          console.log(`  description: ${description.split('\n').slice(0, 3).join(' ').slice(0, 160)}...`);
          console.log('');
        }
        console.log(`  Already filed: ${alreadyFiled.length}  ·  rejected: ${rejected.length}  ·  still proposed: ${stillProposed.length}`);
        console.log('');
        console.log(`  Run without --dry-run to actually file the tasks.`);
        console.log('');
        return;
      }

      // Real run: for each agreed change, spawn `pop task create` and
      // capture the resulting task id. Shelling out keeps this command
      // decoupled from the task create plumbing (which has its own
      // sponsored-tx + fee-limit logic we don't want to duplicate).
      const cliPath = process.argv[1]; // dist/index.js, same entrypoint
      const filed: Array<{ changeId: string; taskId: string; txHash: string; dedup?: boolean }> = [];

      // Task #494 (retro-509 change-3): resolve orgId ONCE for dedup queries
      // before the main loop. If resolution fails, dedup silently disabled
      // (single-agent status='filed' check remains primary idempotency).
      let orgIdForDedup: string | null = null;
      try {
        orgIdForDedup = await resolveOrgId((argv as any).org, (argv as any).chain);
      } catch {
        // Continue without dedup; log only in verbose
        if ((argv as any).verbose) {
          // eslint-disable-next-line no-console
          console.warn('  [file-tasks] orgId resolution failed; idempotency dedup disabled for this run');
        }
      }

      for (const change of agreed) {
        // Task #494: pre-flight dedup query — has another agent already filed
        // a task for this (retroId, changeId)? If yes, skip creation + flip
        // the local change to 'filed' pointing at the discovered task id.
        if (orgIdForDedup) {
          const existingTaskId = await findExistingFiledTask(
            orgIdForDedup,
            (argv as any).chain,
            argv.retro!,
            change.id,
          );
          if (existingTaskId) {
            if (!output.isJsonMode()) {
              console.log(`  ↻ ${change.id} → task #${existingTaskId} (already filed by another agent; dedup-skipped)`);
            }
            // Flip local retro change status to 'filed' pointing at discovered task
            await routedDispatch({
              type: 'updateChangeStatus',
              docId: argv.doc,
              retroId: argv.retro,
              changeId: change.id,
              newStatus: 'filed',
              filedTaskId: existingTaskId,
            });
            filed.push({ changeId: change.id, taskId: existingTaskId, txHash: 'dedup-no-tx', dedup: true });
            continue;
          }
        }

        const { name, description } = buildTaskDescription(retro, change);
        const createArgs = [
          cliPath, 'task', 'create',
          '--force',
          '--project', argv.project!,
          '--name', name,
          '--description', description,
          '--payout', String(argv.payout),
          '--difficulty', argv.difficulty!,
          '--est-hours', String(argv.estHours),
          '--json',
          '-y',
        ];
        const res = spawnSync(process.execPath, createArgs, {
          encoding: 'utf8',
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (res.status !== 0) {
          output.error(
            `pop task create failed for change ${change.id}: ${res.stderr || res.stdout}`,
          );
          process.exitCode = 1;
          return;
        }
        let parsed: any;
        try {
          parsed = JSON.parse(res.stdout);
        } catch (err: any) {
          output.error(`pop task create returned unparseable JSON for change ${change.id}: ${res.stdout}`);
          process.exitCode = 1;
          return;
        }
        const taskId = parsed.taskId;
        const txHash = parsed.txHash;
        if (!taskId) {
          output.error(`pop task create for change ${change.id} returned no taskId: ${JSON.stringify(parsed)}`);
          process.exitCode = 1;
          return;
        }

        // Flip the retro change's status to 'filed' with filedTaskId.
        await routedDispatch({
          type: 'updateChangeStatus',
          docId: argv.doc,
          retroId: argv.retro,
          changeId: change.id,
          newStatus: 'filed',
          filedTaskId: String(taskId),
        });

        filed.push({ changeId: change.id, taskId: String(taskId), txHash });
      }

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId: argv.doc,
          retroId: argv.retro,
          filed,
          filedCount: filed.length,
          skippedAlreadyFiled: alreadyFiled.length,
          skippedRejected: rejected.length,
          skippedStillProposed: stillProposed.length,
        });
      } else {
        console.log('');
        console.log(`  Filed ${filed.length} task${filed.length === 1 ? '' : 's'} from retro "${argv.retro}"`);
        console.log('');
        for (const f of filed) {
          console.log(`  ✓ ${f.changeId} → task #${f.taskId}`);
          console.log(`    tx: ${f.txHash}`);
        }
        console.log('');
        if (alreadyFiled.length > 0) console.log(`  (${alreadyFiled.length} previously filed — skipped)`);
        if (rejected.length > 0) console.log(`  (${rejected.length} rejected — skipped)`);
        if (stillProposed.length > 0) console.log(`  (${stillProposed.length} still under discussion — skipped)`);
        console.log('');
      }
    } catch (err: any) {
      output.error(err.message);
      process.exitCode = 1;
    } finally {
      await stopBrainNode();
    }
  },
};
