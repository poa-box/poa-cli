/**
 * pop brain advance-stage — move a project through the lifecycle.
 *
 * Second write command for the pop.brain.projects doc shape. Finds a
 * project by id, advances its stage to either an explicit --to target
 * or the next stage in the canonical PROPOSE → DISCUSS → PLAN → VOTE
 * → EXECUTE → REVIEW → SHIP sequence, and records a lastStageAdvanceAt
 * timestamp. Short-circuits no-op transitions, errors cleanly on
 * not-found, and refuses to advance past 'ship'.
 *
 * Design note: the canonical order is a SOFT convention at the data
 * layer — any stage string is accepted on disk (so legacy / scripted
 * writes can use custom stages). advance-stage enforces the order
 * only for the --to-omitted "next stage" case. Passing --to <stage>
 * sets the stage directly without checking that the transition makes
 * sense (this allows 'discuss → ship' when the operator knows what
 * they're doing, at the cost of letting a typo jump over stages).
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { openBrainDoc, stopBrainNode } from '../../lib/brain';
import { routedDispatch } from '../../lib/brain-ops';
import type { ProjectStage } from '../../lib/brain-projections';
import {
  argvToIdempotencyString,
  checkIdempotencyCache,
  recordIdempotentResult,
} from '@poa/cli/lib/idempotency';
import * as output from '@poa/cli/lib/output';

interface AdvanceArgs {
  doc: string;
  projectId: string;
  to?: ProjectStage;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

const STAGE_ORDER: ProjectStage[] = [
  'propose', 'discuss', 'plan', 'vote', 'execute', 'review', 'ship',
];

function nextStage(current: string): ProjectStage | null {
  const idx = STAGE_ORDER.indexOf(current as ProjectStage);
  if (idx === -1) return null; // Unknown current stage — caller errors.
  if (idx === STAGE_ORDER.length - 1) return null; // Already at ship.
  return STAGE_ORDER[idx + 1];
}

export const advanceStageHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Brain document ID (typically pop.brain.projects)',
        type: 'string',
        demandOption: true,
      })
      .option('project-id', {
        describe: 'The project.id to advance',
        type: 'string',
        demandOption: true,
      })
      .option('to', {
        describe: 'Explicit target stage (default: next stage in canonical order)',
        type: 'string',
        choices: STAGE_ORDER,
      })
      .option('idempotency-key', { type: 'string', describe: 'Task #375 (HB#217) idempotency cache. Agent-scoped.' })
      .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache.' }),

  handler: async (argv: ArgumentsCamelCase<AdvanceArgs>) => {
    try {
      // Pre-flight: locate the project, emit actionable not-found error.
      const { doc: currentDoc } = await openBrainDoc(argv.doc);
      const projects: any[] = Array.isArray(currentDoc?.projects) ? currentDoc.projects : [];
      const target = projects.find((p: any) => p?.id === argv.projectId);
      if (!target) {
        const candidates = projects
          .map((p: any) => p?.id)
          .filter((id: any) => typeof id === 'string')
          .slice(0, 8);
        output.error(
          `Project "${argv.projectId}" not found in ${argv.doc}. ` +
            `Available ids (first 8): ${candidates.join(', ') || '(none)'}`,
        );
        process.exitCode = 1;
        return;
      }

      // Resolve the target stage.
      let nextStageValue: ProjectStage;
      if (argv.to) {
        nextStageValue = argv.to;
      } else {
        const computed = nextStage(target.stage ?? '');
        if (!computed) {
          if (target.stage === 'ship') {
            output.error(
              `Project "${argv.projectId}" is already at stage 'ship' — no next stage. ` +
                `Use --to <stage> if you need to override.`,
            );
          } else {
            output.error(
              `Project "${argv.projectId}" has unknown current stage "${target.stage}" — ` +
                `cannot compute next stage automatically. Pass --to <stage> to set explicitly.`,
            );
          }
          process.exitCode = 1;
          return;
        }
        nextStageValue = computed;
      }

      // Short-circuit: stage is already the target.
      if (target.stage === nextStageValue) {
        if (output.isJsonMode()) {
          output.json({
            status: 'noop',
            docId: argv.doc,
            projectId: argv.projectId,
            stage: nextStageValue,
          });
        } else {
          console.log(`Project "${argv.projectId}" is already at stage '${nextStageValue}'. No-op.`);
        }
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const priorStage = target.stage;

      // Task #375 (HB#217): agent-scoped idempotency cache
      const signerKey = process.env.POP_PRIVATE_KEY;
      const authorScope = signerKey ? new ethers.Wallet(signerKey).address.toLowerCase() : 'anonymous';
      const idempKey = argv.idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!argv.noIdempotency) {
        const cached = checkIdempotencyCache(authorScope, 'brain.advanceStage', idempKey);
        if (cached) {
          if (output.isJsonMode()) {
            output.json({ status: 'ok', cached: true, ...cached });
          } else {
            console.log(`  Project "${argv.projectId}" stage already advanced (idempotency cache hit). head: ${cached.headCid}`);
          }
          return;
        }
      }

      // Route through the unified dispatcher (HB#324 ship-2).
      const result = await routedDispatch({
        type: 'advanceStage',
        docId: argv.doc,
        projectId: argv.projectId,
        newStage: nextStageValue,
        lastStageAdvanceAt: now,
      });

      if (!argv.noIdempotency) {
        recordIdempotentResult(authorScope, 'brain.advanceStage', idempKey, {
          docId: argv.doc,
          projectId: argv.projectId,
          stage: nextStageValue,
          headCid: result.headCid,
        });
      }

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId: argv.doc,
          projectId: argv.projectId,
          priorStage,
          stage: nextStageValue,
          lastStageAdvanceAt: now,
          headCid: result.headCid,
          routedViaDaemon: result.routedViaDaemon,
        });
      } else {
        console.log('');
        console.log(`  Project "${argv.projectId}" advanced in ${argv.doc}`);
        console.log(`  ${priorStage} → ${nextStageValue}`);
        console.log(`  lastStageAdvanceAt: ${new Date(now * 1000).toISOString()}`);
        console.log(`  new head: ${result.headCid}`);
        console.log(`  routed:   ${result.routedViaDaemon ? 'via brain daemon' : 'in-process (no daemon)'}`);
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
