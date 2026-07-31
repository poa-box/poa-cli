/**
 * pop brain tag — add or remove tags on an existing brain lesson.
 *
 * Task #347 (Retro #1 fallback #6). Companion to `pop brain search`.
 * Tags are an optional `string[]` field on each lesson. Vocabulary is
 * free-form — suggested conventions live in docs/agents/brain-layer-setup.md
 * but nothing enforces them. The goal is search-ability not rigor.
 *
 * Usage:
 *   pop brain tag --doc pop.brain.shared --lesson-id <id> --add tag1,tag2
 *   pop brain tag --doc pop.brain.shared --lesson-id <id> --remove old-tag
 *
 * --add and --remove both accept comma-separated lists. At least one must
 * be supplied. Idempotent: re-adding a tag or removing a missing tag is a
 * no-op on the tags array itself but still writes a new head CID (the
 * tag operation is a legitimate change event for the provenance trail).
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { openBrainDoc, stopBrainNode } from '../../lib/brain';
import { routedDispatch } from '../../lib/brain-ops';
import {
  argvToIdempotencyString,
  checkIdempotencyCache,
  recordIdempotentResult,
} from '@poa/cli/lib/idempotency';
import * as output from '@poa/cli/lib/output';

interface TagArgs {
  doc: string;
  lessonId: string;
  add?: string;
  remove?: string;
  allowInvalidShape?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

function parseList(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

export const tagHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Brain document ID (e.g. pop.brain.shared)',
        type: 'string',
        demandOption: true,
      })
      .option('lesson-id', {
        describe: 'The lesson.id of the entry to tag',
        type: 'string',
        demandOption: true,
      })
      .option('add', {
        describe: 'Comma-separated list of tags to add',
        type: 'string',
      })
      .option('remove', {
        describe: 'Comma-separated list of tags to remove',
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
      })
      .check((argv) => {
        if (!argv.add && !argv.remove) {
          throw new Error('Must supply at least one of --add or --remove');
        }
        return true;
      }),

  handler: async (argv: ArgumentsCamelCase<TagArgs>) => {
    try {
      const addTags = parseList(argv.add);
      const removeTags = parseList(argv.remove);

      // Pre-flight existence check — fail fast with candidate ids if not
      // found. Same UX as edit-lesson / remove-lesson.
      const { doc: currentDoc } = await openBrainDoc(argv.doc);
      const lessons: any[] = Array.isArray(currentDoc?.lessons) ? currentDoc.lessons : [];
      const target = lessons.find((l: any) => l && l.id === argv.lessonId);
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

      // Task #374: idempotency check (agent-scoped).
      const signerKey = process.env.POP_PRIVATE_KEY;
      const authorScope = signerKey ? new ethers.Wallet(signerKey).address.toLowerCase() : 'anonymous';
      const idempKey = argv.idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!argv.noIdempotency) {
        const cached = checkIdempotencyCache(authorScope, 'brain.tag', idempKey);
        if (cached) {
          if (output.isJsonMode()) {
            output.json({ status: 'ok', cached: true, ...cached });
          } else {
            console.log('');
            console.log(`  Lesson "${argv.lessonId}" tags already updated (idempotency cache hit)`);
            console.log(`  head:   ${cached.headCid}`);
            console.log('');
          }
          return;
        }
      }

      const result = await routedDispatch({
        type: 'tagLesson',
        docId: argv.doc,
        lessonId: argv.lessonId,
        addTags,
        removeTags,
        allowInvalidShape: argv.allowInvalidShape,
      });

      if (!argv.noIdempotency) {
        recordIdempotentResult(authorScope, 'brain.tag', idempKey, {
          docId: argv.doc,
          lessonId: argv.lessonId,
          added: addTags,
          removed: removeTags,
          headCid: result.headCid,
        });
      }

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId: argv.doc,
          lessonId: argv.lessonId,
          added: addTags,
          removed: removeTags,
          headCid: result.headCid,
          routedViaDaemon: result.routedViaDaemon,
        });
      } else {
        console.log('');
        console.log(`  Lesson "${argv.lessonId}" tags updated in ${argv.doc}`);
        if (addTags.length > 0) console.log(`  added:   ${addTags.join(', ')}`);
        if (removeTags.length > 0) console.log(`  removed: ${removeTags.join(', ')}`);
        console.log(`  head:    ${result.headCid}`);
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
