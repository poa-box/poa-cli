/**
 * pop brain append-lesson — user-facing write path into the CRDT brain
 * substrate. Thin wrapper over applyBrainChange that pushes a lesson
 * object onto `doc.lessons` and auto-publishes the new head via
 * gossipsub (step 5) + seeds it for Bitswap (step 6).
 *
 * Before this command, writing a lesson required a Node script that
 * imported dist/lib/brain.js and called applyBrainChange manually.
 * This command closes the last ergonomic gap before the brain
 * substrate is day-to-day usable for heartbeat work.
 *
 * Usage:
 *   pop brain append-lesson --doc pop.brain.shared \
 *     --title "Don't upgrade libp2p past 2.x" \
 *     --body "gossipsub 14 crashes on libp2p 3+ ... "
 *
 *   pop brain append-lesson --doc pop.brain.shared \
 *     --title "Long form lesson" \
 *     --body-file /tmp/lesson.md
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { ethers } from 'ethers';
import { stopBrainNode } from '../../lib/brain';
import { routedDispatch } from '../../lib/brain-ops';
import {
  argvToIdempotencyString,
  checkIdempotencyCache,
  recordIdempotentResult,
} from '@poa/cli/lib/idempotency';
import * as output from '@poa/cli/lib/output';

interface AppendArgs {
  doc: string;
  title: string;
  body?: string;
  bodyFile?: string;
  author?: string;
  id?: string;
  allowInvalidShape?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

/**
 * Keep this in sync with the slugify in brain-migrate.ts — these are
 * separate code paths but produce compatible ids.
 */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export const appendLessonHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Brain document ID (e.g. pop.brain.shared)',
        type: 'string',
        demandOption: true,
      })
      .option('title', {
        describe: 'Short title for the lesson (used as the markdown header + default id)',
        type: 'string',
        demandOption: true,
      })
      .option('body', {
        describe: 'Lesson body text (inline). Prefer --body-file for multi-paragraph content.',
        type: 'string',
      })
      .option('body-file', {
        describe: 'Path to a file whose contents will be used as the lesson body',
        type: 'string',
      })
      .option('author', {
        describe: 'Override the author name (default: signing wallet address)',
        type: 'string',
      })
      .option('id', {
        describe: 'Override the auto-generated lesson id',
        type: 'string',
      })
      .option('allow-invalid-shape', {
        describe:
          'Bypass write-time schema validation (Task #346). Use only when you deliberately need a non-canonical shape.',
        type: 'boolean',
        default: false,
      })
      .option('idempotency-key', {
        type: 'string',
        describe:
          'Task #370 (HB#214): explicit idempotency key. Two identical append-lesson calls within 15 minutes return the same result without re-submitting. Default: auto-derived from argv (title + body + docId). Scope: author address (brain writes are agent-scoped not org-scoped).',
      })
      .option('no-idempotency', {
        type: 'boolean',
        default: false,
        describe: 'Bypass the idempotency cache and always submit a new lesson.',
      })
      .check((argv) => {
        if (!argv.body && !argv['body-file']) {
          throw new Error('Must supply --body or --body-file');
        }
        return true;
      }),

  handler: async (argv: ArgumentsCamelCase<AppendArgs>) => {
    try {
      // Resolve body content.
      let body: string;
      if (argv.bodyFile) {
        const p = resolve(argv.bodyFile);
        if (!existsSync(p)) {
          output.error(`--body-file not found: ${p}`);
          process.exitCode = 1;
          return;
        }
        body = readFileSync(p, 'utf8').replace(/\s+$/, '');
      } else {
        body = (argv.body ?? '').trim();
      }
      if (!body) {
        output.error('Lesson body is empty.');
        process.exitCode = 1;
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      // Default id: slug(title) + suffix so two lessons with the same
      // title still land at distinct ids. Callers can override with --id
      // when they want a stable key (e.g. upserting a policy rule).
      const id = argv.id ?? `${slugify(argv.title) || 'lesson'}-${now}`;

      // Resolve the author up front — for the default case (no --author
      // flag) we derive the Ethereum address from POP_PRIVATE_KEY so the
      // lesson.author field matches the envelope signer that brain-signing
      // will stamp on the block. Doing this before applyBrainChange keeps
      // the change fn pure and avoids a two-phase update dance.
      let authorLabel: string;
      if (argv.author) {
        authorLabel = argv.author;
      } else {
        const key = process.env.POP_PRIVATE_KEY;
        if (!key) {
          output.error('POP_PRIVATE_KEY not set — cannot derive default author. Pass --author explicitly.');
          process.exitCode = 1;
          return;
        }
        authorLabel = new ethers.Wallet(key).address.toLowerCase();
      }

      // Task #370: idempotency check. Brain writes are agent-scoped
      // (no orgId), so the scope is the author address instead.
      const idempKey = argv.idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!argv.noIdempotency) {
        const cached = checkIdempotencyCache(authorLabel, 'brain.appendLesson', idempKey);
        if (cached) {
          if (output.isJsonMode()) {
            output.json({
              status: 'ok',
              cached: true,
              ...cached,
              note: 'Prior call within 15-min window produced this result.',
            });
          } else {
            console.log('');
            console.log(`  Lesson already appended (idempotency cache hit)`);
            console.log(`  id:     ${cached.lessonId}`);
            console.log(`  head:   ${cached.headCid}`);
            console.log(`  note:   Prior call within 15-min window. Use --no-idempotency to force re-submit.`);
            console.log('');
          }
          return;
        }
      }

      // Route through the unified dispatcher (HB#324 ship-2). When a
      // brain daemon is running, this sends the op via IPC so the
      // daemon's long-lived gossipsub mesh handles the publish. When
      // no daemon, it falls back to in-process applyBrainChange via
      // dispatchOp. Same result shape in both cases.
      const result = await routedDispatch({
        type: 'appendLesson',
        docId: argv.doc,
        id,
        title: argv.title,
        body,
        author: authorLabel,
        timestamp: now,
        allowInvalidShape: argv.allowInvalidShape,
      });

      // Task #370: record idempotent result after successful dispatch
      if (!argv.noIdempotency) {
        recordIdempotentResult(authorLabel, 'brain.appendLesson', idempKey, {
          docId: argv.doc,
          lessonId: id,
          headCid: result.headCid,
          author: authorLabel,
        });
      }

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId: argv.doc,
          lessonId: id,
          headCid: result.headCid,
          author: authorLabel,
          envelopeAuthor: result.envelopeAuthor,
          routedViaDaemon: result.routedViaDaemon,
        });
      } else {
        console.log('');
        console.log(`  Lesson appended to ${argv.doc}`);
        console.log(`  id:      ${id}`);
        console.log(`  author:  ${authorLabel}`);
        console.log(`  head:    ${result.headCid}`);
        console.log(`  routed:  ${result.routedViaDaemon ? 'via brain daemon' : 'in-process (no daemon)'}`);
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

