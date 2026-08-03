/**
 * pop brain edit-lesson — update fields on an existing brain lesson.
 *
 * Finds a lesson by its id inside a brain doc, mutates the provided
 * fields in-place, and persists the result via applyBrainChange so
 * the edit goes through the full sign → persist → gossipsub publish
 * pipeline. Edits are idempotent from the user's perspective: running
 * the same edit twice produces the same final state (the second run
 * is a no-op if no field actually changes).
 *
 * Scope: edit in place only. No remove, no re-id, no ordering mutation.
 * Remove requires CRDT tombstone semantics which are a separate ship.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { openBrainDoc, stopBrainNode } from '../../lib/brain';
import { routedDispatch } from '../../lib/brain-ops';
import { ethers } from 'ethers';
import {
  argvToIdempotencyString,
  checkIdempotencyCache,
  recordIdempotentResult,
} from '@poa-box/cli/lib/idempotency';
import * as output from '@poa-box/cli/lib/output';

interface EditArgs {
  doc: string;
  lessonId: string;
  title?: string;
  body?: string;
  bodyFile?: string;
  author?: string;
  touch?: boolean;
  allowInvalidShape?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const editLessonHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Brain document ID (e.g. pop.brain.shared)',
        type: 'string',
        demandOption: true,
      })
      .option('lesson-id', {
        describe: 'The lesson.id of the entry to update',
        type: 'string',
        demandOption: true,
      })
      .option('title', { describe: 'New title', type: 'string' })
      .option('body', { describe: 'New body (inline)', type: 'string' })
      .option('body-file', { describe: 'Path to a file whose contents replace the body', type: 'string' })
      .option('author', { describe: 'Override the author label', type: 'string' })
      .option('touch', {
        describe: 'Bump the lesson.timestamp to now on edit (default: preserve original timestamp)',
        type: 'boolean',
        default: false,
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
      })
      .check((argv) => {
        if (
          argv.title === undefined &&
          argv.body === undefined &&
          argv['body-file'] === undefined &&
          argv.author === undefined
        ) {
          throw new Error('Must supply at least one of --title / --body / --body-file / --author');
        }
        return true;
      }),

  handler: async (argv: ArgumentsCamelCase<EditArgs>) => {
    try {
      // Pre-flight: open the doc and verify the target lesson exists.
      // We do a read-only peek first so we can fail fast with a
      // useful error (list candidate ids) instead of touching the
      // blockstore for a no-op change.
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

      // Resolve body replacement content if --body-file was given.
      let bodyReplacement: string | undefined;
      if (argv.bodyFile !== undefined) {
        const p = resolve(argv.bodyFile);
        if (!existsSync(p)) {
          output.error(`--body-file not found: ${p}`);
          process.exitCode = 1;
          return;
        }
        bodyReplacement = readFileSync(p, 'utf8').replace(/\s+$/, '');
      } else if (argv.body !== undefined) {
        bodyReplacement = argv.body.trim();
      }

      // Capture "before" state for the diff report so the operator
      // can see what actually changed.
      const before = {
        title: target.title,
        body: target.body,
        author: target.author,
        timestamp: target.timestamp,
      };

      const after: any = { ...before };
      if (argv.title !== undefined) after.title = argv.title;
      if (bodyReplacement !== undefined) after.body = bodyReplacement;
      if (argv.author !== undefined) after.author = argv.author;
      if (argv.touch) after.timestamp = Math.floor(Date.now() / 1000);

      // If nothing actually changed, short-circuit — don't burn a new
      // CID on a no-op.
      const changedKeys = Object.keys(after).filter(k => (after as any)[k] !== (before as any)[k]);
      if (changedKeys.length === 0) {
        if (output.isJsonMode()) {
          output.json({ status: 'noop', docId: argv.doc, lessonId: argv.lessonId });
        } else {
          console.log(`No changes to apply — all requested fields already match. No new head produced.`);
        }
        return;
      }

      // Task #374: idempotency check. Brain writes are agent-scoped, so
      // the scope component is the signing wallet address.
      const signerKey = process.env.POP_PRIVATE_KEY;
      const authorScope = signerKey ? new ethers.Wallet(signerKey).address.toLowerCase() : 'anonymous';
      const idempKey = argv.idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!argv.noIdempotency) {
        const cached = checkIdempotencyCache(authorScope, 'brain.editLesson', idempKey);
        if (cached) {
          if (output.isJsonMode()) {
            output.json({ status: 'ok', cached: true, ...cached });
          } else {
            console.log('');
            console.log(`  Lesson "${argv.lessonId}" edit cached (idempotency hit)`);
            console.log(`  head:   ${cached.headCid}`);
            console.log('');
          }
          return;
        }
      }

      // Route through the unified dispatcher. When the brain daemon is
      // running, this serializes an `editLesson` op and sends it via IPC
      // so the write lands in the daemon's long-lived libp2p context.
      // When no daemon, dispatchOp runs in-process (same applyBrainChange
      // call path as before).
      const fields: { title?: string; body?: string; author?: string } = {};
      if (argv.title !== undefined) fields.title = argv.title;
      if (bodyReplacement !== undefined) fields.body = bodyReplacement;
      if (argv.author !== undefined) fields.author = argv.author;

      const result = await routedDispatch({
        type: 'editLesson',
        docId: argv.doc,
        lessonId: argv.lessonId,
        fields,
        touch: argv.touch === true,
        allowInvalidShape: argv.allowInvalidShape,
      });

      if (!argv.noIdempotency) {
        recordIdempotentResult(authorScope, 'brain.editLesson', idempKey, {
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
          envelopeAuthor: result.envelopeAuthor,
          routedViaDaemon: result.routedViaDaemon,
          changedKeys,
          before,
          after,
        });
      } else {
        console.log('');
        console.log(`  Lesson "${argv.lessonId}" updated in ${argv.doc}`);
        console.log(`  changed:  ${changedKeys.join(', ')}`);
        console.log(`  new head: ${result.headCid}`);
        console.log(`  routed:   ${result.routedViaDaemon ? 'via brain daemon' : 'in-process (no daemon)'}`);
        console.log('');
        for (const k of changedKeys) {
          const b = String((before as any)[k] ?? '(unset)').slice(0, 100);
          const a = String((after as any)[k] ?? '(unset)').slice(0, 100);
          console.log(`  ${k}:`);
          console.log(`    - ${b}`);
          console.log(`    + ${a}`);
        }
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
