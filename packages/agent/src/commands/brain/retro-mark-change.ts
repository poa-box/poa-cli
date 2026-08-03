/**
 * pop brain retro mark-change — manually set a proposed change's status.
 *
 * The retro workflow separates VOTES (discussion-level signals) from
 * CHANGE STATUS (decision). Other agents respond via `pop brain retro
 * respond --vote change-1=agree`, which records a vote entry in the
 * discussion array — NOT a status change on the proposed change.
 *
 * When the retro author (or a designated file-tasks runner) decides a
 * change has enough agreement, they explicitly flip its status to
 * 'agreed' with this command. Then `pop brain retro file-tasks` picks
 * up the change and converts it into a real on-chain task.
 *
 * MVP design: quorum interpretation is human-judged per the task spec
 * (#344 "out of scope: cross-agent voting quorum logic"). This command
 * is the escape hatch that lets operators make the call explicitly.
 *
 * Usage:
 *
 *   pop brain retro mark-change retro-327-... change-1 --status agreed
 *   pop brain retro mark-change retro-327-... change-2 --status rejected
 *   pop brain retro mark-change retro-327-... change-3 --status modified
 *
 * Status values: proposed, agreed, modified, rejected, filed.
 * Setting status to 'filed' manually is unusual — prefer `file-tasks`,
 * which records the filedTaskId for you. Allowed here for emergency
 * manual reconciliation.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { stopBrainNode } from '../../lib/brain';
import { routedDispatch } from '../../lib/brain-ops';
import type { RetroChangeStatus } from '../../lib/brain-projections';
import {
  argvToIdempotencyString,
  checkIdempotencyCache,
  recordIdempotentResult,
} from '@poa-box/cli/lib/idempotency';
import * as output from '@poa-box/cli/lib/output';

interface MarkChangeArgs {
  doc: string;
  retroId: string;
  changeId: string;
  status: RetroChangeStatus;
  filedTaskId?: string;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

const VALID_STATUSES: RetroChangeStatus[] = [
  'proposed', 'agreed', 'modified', 'rejected', 'filed',
];

export const retroMarkChangeHandler = {
  builder: (yargs: Argv) =>
    yargs
      .positional('retro-id', {
        describe: 'The retro.id containing the change',
        type: 'string',
      })
      .positional('change-id', {
        describe: 'The proposed-change id to update',
        type: 'string',
      })
      .option('doc', {
        describe: 'Brain document ID (default: pop.brain.retros)',
        type: 'string',
        default: 'pop.brain.retros',
      })
      .option('status', {
        describe: 'New status for the proposed change',
        type: 'string',
        choices: VALID_STATUSES,
        demandOption: true,
      })
      .option('filed-task-id', {
        describe: 'When --status=filed, record the on-chain task id on the change (optional)',
        type: 'string',
      })
      .option('idempotency-key', { type: 'string', describe: 'Task #375 (HB#217) idempotency cache.' })
      .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache.' })
      .demandOption(['retro-id', 'change-id']),

  handler: async (argv: ArgumentsCamelCase<MarkChangeArgs>) => {
    try {
      if (argv.filedTaskId && argv.status !== 'filed') {
        output.error(`--filed-task-id only makes sense with --status=filed`);
        process.exitCode = 1;
        return;
      }

      // Task #375 idempotency check, agent-scoped
      const signerKey = process.env.POP_PRIVATE_KEY;
      const authorScope = signerKey ? new ethers.Wallet(signerKey).address.toLowerCase() : 'anonymous';
      const idempKey = (argv as any).idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!(argv as any).noIdempotency) {
        const cached = checkIdempotencyCache(authorScope, 'brain.retroMarkChange', idempKey);
        if (cached) {
          if (output.isJsonMode()) output.json({ status: 'ok', cached: true, ...cached });
          else console.log(`  Change "${argv.changeId}" already marked (idempotency cache hit). head: ${cached.headCid}`);
          return;
        }
      }

      const result = await routedDispatch({
        type: 'updateChangeStatus',
        docId: argv.doc,
        retroId: argv.retroId,
        changeId: argv.changeId,
        newStatus: argv.status,
        filedTaskId: argv.filedTaskId,
      });

      if (!(argv as any).noIdempotency) {
        recordIdempotentResult(authorScope, 'brain.retroMarkChange', idempKey, {
          docId: argv.doc,
          retroId: argv.retroId,
          changeId: argv.changeId,
          newStatus: argv.status,
          headCid: result.headCid,
        });
      }

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId: argv.doc,
          retroId: argv.retroId,
          changeId: argv.changeId,
          newStatus: argv.status,
          filedTaskId: argv.filedTaskId ?? null,
          headCid: result.headCid,
          envelopeAuthor: result.envelopeAuthor,
          routedViaDaemon: result.routedViaDaemon,
        });
      } else {
        console.log('');
        console.log(`  Change "${argv.changeId}" in retro "${argv.retroId}" marked as ${argv.status}`);
        if (argv.filedTaskId) {
          console.log(`  filed task: #${argv.filedTaskId}`);
        }
        console.log(`  new head:   ${result.headCid}`);
        console.log(`  routed:     ${result.routedViaDaemon ? 'via brain daemon' : 'in-process (no daemon)'}`);
        console.log('');
        if (argv.status === 'agreed') {
          console.log(
            `  Next: run "pop brain retro file-tasks --retro ${argv.retroId}" to convert ` +
            `this change (and any other agreed changes) into real on-chain tasks.`,
          );
          console.log('');
        }
      }
    } catch (err: any) {
      output.error(err.message);
      process.exitCode = 1;
    } finally {
      await stopBrainNode();
    }
  },
};
