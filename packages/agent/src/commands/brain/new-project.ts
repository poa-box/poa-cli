/**
 * pop brain new-project — create a project entry in pop.brain.projects.
 *
 * First write command for the pop.brain.projects doc shape introduced
 * in #306. Thin wrapper over applyBrainChange that pushes a new
 * BrainProject onto doc.projects and auto-publishes via the existing
 * gossipsub hook. Validates stage against the ProjectStage union so
 * typos get caught at the CLI boundary.
 *
 * Out of scope for this command (each is a separate follow-up):
 * - advance-stage (advance a project to the next lifecycle stage)
 * - post-discussion (append a discussion entry)
 * - add-task-plan (attach a task plan block)
 * - stage-transition validation (currently any stage is accepted as
 *   the starting stage; the PROPOSE → DISCUSS → PLAN order is a soft
 *   convention, not a hard constraint)
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
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

interface NewProjectArgs {
  doc: string;
  name: string;
  stage?: ProjectStage;
  proposedBy?: string;
  brief?: string;
  briefFile?: string;
  id?: string;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

const VALID_STAGES: ProjectStage[] = [
  'propose', 'discuss', 'plan', 'vote', 'execute', 'review', 'ship',
];

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export const newProjectHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Target brain document ID (typically pop.brain.projects)',
        type: 'string',
        demandOption: true,
      })
      .option('name', {
        describe: 'Project name (used as the markdown header + default id base)',
        type: 'string',
        demandOption: true,
      })
      .option('stage', {
        describe: 'Starting lifecycle stage',
        type: 'string',
        choices: VALID_STAGES,
        default: 'propose' as ProjectStage,
      })
      .option('proposed-by', {
        describe: 'Override the proposer label (default: signing wallet address)',
        type: 'string',
      })
      .option('brief', {
        describe: 'Inline project brief (short form)',
        type: 'string',
      })
      .option('brief-file', {
        describe: 'Path to a file whose contents are used as the brief',
        type: 'string',
      })
      .option('id', {
        describe: 'Override the auto-generated project id',
        type: 'string',
      })
      .option('idempotency-key', {
        type: 'string',
        describe: 'Task #375 (HB#217) idempotency cache. Agent-scoped.',
      })
      .option('no-idempotency', {
        type: 'boolean',
        default: false,
        describe: 'Bypass the idempotency cache.',
      }),

  handler: async (argv: ArgumentsCamelCase<NewProjectArgs>) => {
    try {
      // Resolve brief content.
      let brief: string | undefined;
      if (argv.briefFile) {
        const p = resolve(argv.briefFile);
        if (!existsSync(p)) {
          output.error(`--brief-file not found: ${p}`);
          process.exitCode = 1;
          return;
        }
        brief = readFileSync(p, 'utf8').replace(/\s+$/, '');
      } else if (argv.brief !== undefined) {
        brief = argv.brief.trim();
      }

      // Resolve proposedBy label up front — matches the append-lesson
      // pattern. Default: lowercased wallet address from POP_PRIVATE_KEY.
      let proposedBy: string;
      if (argv.proposedBy) {
        proposedBy = argv.proposedBy;
      } else {
        const key = process.env.POP_PRIVATE_KEY;
        if (!key) {
          output.error(
            'POP_PRIVATE_KEY not set — cannot derive default proposedBy. Pass --proposed-by explicitly.',
          );
          process.exitCode = 1;
          return;
        }
        proposedBy = new ethers.Wallet(key).address.toLowerCase();
      }

      // Compute the id. Default is slugify(name); on collision with
      // an existing project, append a unix-seconds suffix so a second
      // caller with the same --name still succeeds.
      const { doc: currentDoc } = await openBrainDoc(argv.doc);
      const existing: any[] = Array.isArray(currentDoc?.projects) ? currentDoc.projects : [];
      const baseId = argv.id ?? (slugify(argv.name) || 'project');
      let id = baseId;
      if (existing.some(p => p?.id === id)) {
        id = `${baseId}-${Math.floor(Date.now() / 1000)}`;
      }

      const now = Math.floor(Date.now() / 1000);
      const stage = (argv.stage ?? 'propose') as ProjectStage;

      // Task #375 (HB#217): idempotency check, agent-scoped
      const idempKey = argv.idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!argv.noIdempotency) {
        const cached = checkIdempotencyCache(proposedBy, 'brain.newProject', idempKey);
        if (cached) {
          if (output.isJsonMode()) {
            output.json({ status: 'ok', cached: true, ...cached });
          } else {
            console.log('');
            console.log(`  Project already created (idempotency cache hit)`);
            console.log(`  id:     ${cached.projectId}`);
            console.log(`  head:   ${cached.headCid}`);
            console.log('');
          }
          return;
        }
      }

      // Route through the unified dispatcher (HB#324 ship-2).
      const result = await routedDispatch({
        type: 'newProject',
        docId: argv.doc,
        projectId: id,
        name: argv.name,
        brief,
        stage,
        proposedBy,
        proposedAt: now,
      });

      if (!argv.noIdempotency) {
        recordIdempotentResult(proposedBy, 'brain.newProject', idempKey, {
          docId: argv.doc,
          projectId: id,
          headCid: result.headCid,
        });
      }

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId: argv.doc,
          projectId: id,
          name: argv.name,
          stage,
          proposedBy,
          headCid: result.headCid,
          envelopeAuthor: result.envelopeAuthor,
          routedViaDaemon: result.routedViaDaemon,
        });
      } else {
        console.log('');
        console.log(`  Project created in ${argv.doc}`);
        console.log(`  id:          ${id}`);
        console.log(`  name:        ${argv.name}`);
        console.log(`  stage:       ${stage}`);
        console.log(`  proposedBy:  ${proposedBy}`);
        console.log(`  head:        ${result.headCid}`);
        console.log(`  routed:      ${result.routedViaDaemon ? 'via brain daemon' : 'in-process (no daemon)'}`);
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
