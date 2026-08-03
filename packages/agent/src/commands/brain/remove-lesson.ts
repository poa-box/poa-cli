/**
 * pop brain remove-lesson — mark an existing lesson as soft-deleted.
 *
 * Sets a tombstone on the lesson object:
 *
 *   {
 *     removed: true,
 *     removedAt: <unix-seconds>,
 *     removedBy: <signing wallet address>,
 *     removedReason: <optional --reason string>
 *   }
 *
 * The lesson stays in doc.lessons — the projection layer filters
 * tombstoned entries out of rendered markdown. This is the CRDT-safe
 * shape: hard delete from an Automerge list can lose concurrent edits,
 * and two concurrent soft-deletes converge via last-write-wins at the
 * field level (adding `removed: true` twice is idempotent).
 *
 * No --undo / --restore in this ship. If we need undelete later, the
 * shape is another field like `restoredAt` that supersedes removedAt.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { openBrainDoc, stopBrainNode } from '../../lib/brain';
import { routedDispatch } from '../../lib/brain-ops';
import {
  argvToIdempotencyString,
  checkIdempotencyCache,
  recordIdempotentResult,
} from '@poa-box/cli/lib/idempotency';
import * as output from '@poa-box/cli/lib/output';

interface RemoveArgs {
  doc: string;
  lessonId: string;
  reason?: string;
  allowInvalidShape?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const removeLessonHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Brain document ID (e.g. pop.brain.shared)',
        type: 'string',
        demandOption: true,
      })
      .option('lesson-id', {
        describe: 'The lesson.id to tombstone',
        type: 'string',
        demandOption: true,
      })
      .option('reason', {
        describe: 'Optional human-readable reason recorded on the tombstone',
        type: 'string',
      })
      .option('allow-invalid-shape', {
        describe: 'Bypass write-time schema validation (Task #346).',
        type: 'boolean',
        default: false,
      })
      .option('idempotency-key', {
        type: 'string',
        describe: 'Task #374 (HB#215): explicit idempotency key. Agent-scoped.',
      })
      .option('no-idempotency', {
        type: 'boolean',
        default: false,
        describe: 'Bypass the idempotency cache.',
      }),

  handler: async (argv: ArgumentsCamelCase<RemoveArgs>) => {
    try {
      // Pre-flight peek: locate the lesson, fail fast with candidate
      // ids if not found. Same pattern as edit-lesson.
      const { doc: currentDoc } = await openBrainDoc(argv.doc);
      const lessons: any[] = Array.isArray(currentDoc?.lessons) ? currentDoc.lessons : [];
      const target = lessons.find((l: any) => l?.id === argv.lessonId);
      if (!target) {
        const candidates = lessons
          .map((l: any) => l?.id)
          .filter((id: any) => typeof id === 'string')
          .slice(0, 8);
        output.error(
          `Lesson "${argv.lessonId}" not found in ${argv.doc}. ` +
            `Available ids (first 8): ${candidates.join(', ') || '(none)'}`,
        );
        process.exitCode = 1;
        return;
      }

      // Already tombstoned — short-circuit.
      if (target.removed === true) {
        if (output.isJsonMode()) {
          output.json({
            status: 'already-removed',
            docId: argv.doc,
            lessonId: argv.lessonId,
            removedAt: target.removedAt,
            removedBy: target.removedBy,
          });
        } else {
          console.log(
            `Lesson "${argv.lessonId}" is already tombstoned ` +
              `(removedAt=${target.removedAt}, removedBy=${target.removedBy}). No-op.`,
          );
        }
        return;
      }

      // Derive the remover address from POP_PRIVATE_KEY so the
      // tombstone's removedBy matches the signing envelope's author.
      const key = process.env.POP_PRIVATE_KEY;
      if (!key) {
        output.error(
          'POP_PRIVATE_KEY not set — cannot record removedBy. Set the env var and retry.',
        );
        process.exitCode = 1;
        return;
      }
      const removerAddress = new ethers.Wallet(key).address.toLowerCase();
      const now = Math.floor(Date.now() / 1000);

      // Task #374: idempotency check (agent-scoped, uses removerAddress)
      const idempKey = argv.idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!argv.noIdempotency) {
        const cached = checkIdempotencyCache(removerAddress, 'brain.removeLesson', idempKey);
        if (cached) {
          if (output.isJsonMode()) {
            output.json({ status: 'ok', cached: true, ...cached });
          } else {
            console.log('');
            console.log(`  Lesson "${argv.lessonId}" already removed (idempotency cache hit)`);
            console.log(`  head:   ${cached.headCid}`);
            console.log('');
          }
          return;
        }
      }

      // Route through the unified dispatcher (HB#324 ship-2).
      const result = await routedDispatch({
        type: 'removeLesson',
        docId: argv.doc,
        lessonId: argv.lessonId,
        removedBy: removerAddress,
        removedAt: now,
        removedReason: argv.reason,
        allowInvalidShape: argv.allowInvalidShape,
      });

      if (!argv.noIdempotency) {
        recordIdempotentResult(removerAddress, 'brain.removeLesson', idempKey, {
          docId: argv.doc,
          lessonId: argv.lessonId,
          headCid: result.headCid,
        });
      }

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId: argv.doc,
          lessonId: argv.lessonId,
          headCid: result.headCid,
          routedViaDaemon: result.routedViaDaemon,
          removedAt: now,
          removedBy: removerAddress,
          removedReason: argv.reason ?? null,
        });
      } else {
        console.log('');
        console.log(`  Lesson "${argv.lessonId}" tombstoned in ${argv.doc}`);
        console.log(`  removedBy: ${removerAddress}`);
        console.log(`  removedAt: ${new Date(now * 1000).toISOString()}`);
        if (argv.reason) console.log(`  reason:    ${argv.reason}`);
        console.log(`  new head:  ${result.headCid}`);
        console.log(`  routed:    ${result.routedViaDaemon ? 'via brain daemon' : 'in-process (no daemon)'}`);
        console.log('');
        console.log(
          `  The lesson is still in the Automerge doc (pop brain read still shows it). ` +
            `The next pop brain snapshot will filter it out of the rendered markdown.`,
        );
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
