/**
 * pop brain search — keyword / tag / author / HB filters over brain lesson docs.
 *
 * Task #347 (Retro #1 fallback #6). The pop.brain.shared / pop.brain.lessons
 * doc has grown past the "cold read is cheap" threshold. Agents reaching for
 * "is there a lesson about X" were grepping heartbeat-log.md as a faster
 * proxy, which defeated the purpose of the canonical lesson substrate.
 * This command makes lesson search cheaper than log grep.
 *
 * Filters compose as AND:
 *   --query    case-insensitive substring match over title + body
 *   --tag      exact tag match (one tag per invocation; run twice to AND)
 *   --author   exact author match (0x lowercase)
 *   --since    HB number: only lessons with timestamp >= the HB's wall-clock.
 *              Heuristic — the HB number is not stored on the lesson; we
 *              approximate by comparing the lesson timestamp against a
 *              provided unix-seconds lower bound passed as --since-ts.
 *
 * Output is ranked by timestamp descending (most recent first) since that's
 * the useful default for "what happened lately about X". JSON mode for
 * programmatic consumption.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { openBrainDoc, stopBrainNode } from '../../lib/brain';
import * as output from '@poa/cli/lib/output';

interface SearchArgs {
  doc: string;
  query?: string;
  tag?: string;
  author?: string;
  sinceTs?: number;
  limit?: number;
}

function firstSentence(body: string): string {
  if (!body) return '';
  const trimmed = body.trim();
  const match = trimmed.match(/^(.{1,160}?[.!?])(\s|$)/);
  if (match) return match[1];
  // No sentence terminator in first 160 chars — take first line or 160 chars.
  const firstLine = trimmed.split('\n')[0];
  return firstLine.length > 160 ? firstLine.slice(0, 157) + '…' : firstLine;
}

export const searchHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Brain document ID (e.g. pop.brain.shared)',
        type: 'string',
        demandOption: true,
      })
      .option('query', {
        describe: 'Case-insensitive substring match over title + body',
        type: 'string',
      })
      .option('tag', {
        describe: 'Filter to lessons whose tags include this exact string',
        type: 'string',
      })
      .option('author', {
        describe: 'Filter to lessons by this author address (0x lowercase)',
        type: 'string',
      })
      .option('since-ts', {
        describe: 'Only lessons with timestamp >= this unix-seconds value',
        type: 'number',
      })
      .option('limit', {
        describe: 'Max number of lessons to return (default 10)',
        type: 'number',
        default: 10,
      }),

  handler: async (argv: ArgumentsCamelCase<SearchArgs>) => {
    try {
      const { doc: currentDoc } = await openBrainDoc(argv.doc);
      const lessons: any[] = Array.isArray(currentDoc?.lessons) ? currentDoc.lessons : [];

      const queryLower = argv.query ? argv.query.toLowerCase() : null;
      const wantTag = argv.tag ?? null;
      const wantAuthor = argv.author ? argv.author.toLowerCase() : null;
      const sinceTs = typeof argv.sinceTs === 'number' ? argv.sinceTs : null;

      const matched = lessons.filter((lesson: any) => {
        if (!lesson || lesson.removed === true) return false;
        if (queryLower) {
          const haystack = `${lesson.title ?? ''}\n${lesson.body ?? lesson.text ?? ''}`.toLowerCase();
          if (!haystack.includes(queryLower)) return false;
        }
        if (wantTag) {
          const tags: any[] = Array.isArray(lesson.tags) ? lesson.tags : [];
          if (!tags.some((t) => t === wantTag)) return false;
        }
        if (wantAuthor) {
          const author = typeof lesson.author === 'string' ? lesson.author.toLowerCase() : '';
          if (author !== wantAuthor) return false;
        }
        if (sinceTs !== null) {
          const ts = typeof lesson.timestamp === 'number' ? lesson.timestamp : 0;
          if (ts < sinceTs) return false;
        }
        return true;
      });

      // Sort by timestamp descending. Non-numeric timestamps sort last.
      matched.sort((a, b) => {
        const ta = typeof a.timestamp === 'number' ? a.timestamp : 0;
        const tb = typeof b.timestamp === 'number' ? b.timestamp : 0;
        return tb - ta;
      });

      const limited = matched.slice(0, argv.limit ?? 10);

      if (output.isJsonMode()) {
        output.json({
          docId: argv.doc,
          filters: {
            query: argv.query ?? null,
            tag: argv.tag ?? null,
            author: argv.author ?? null,
            sinceTs: sinceTs,
          },
          totalMatched: matched.length,
          returned: limited.length,
          lessons: limited.map((l) => ({
            id: l.id ?? null,
            title: l.title ?? null,
            author: l.author ?? null,
            timestamp: l.timestamp ?? null,
            tags: Array.isArray(l.tags) ? l.tags : [],
            summary: firstSentence(l.body ?? l.text ?? ''),
          })),
        });
      } else {
        console.log('');
        console.log(
          `  ${matched.length} matching lesson${matched.length === 1 ? '' : 's'} in ${argv.doc}` +
            (matched.length > limited.length ? ` (showing most recent ${limited.length})` : ''),
        );
        console.log('');
        if (limited.length === 0) {
          console.log('  (no matches)');
          console.log('');
        }
        for (const l of limited) {
          const iso = typeof l.timestamp === 'number' ? new Date(l.timestamp * 1000).toISOString() : '?';
          const tags = Array.isArray(l.tags) && l.tags.length > 0 ? ` [${l.tags.join(', ')}]` : '';
          console.log(`  • ${l.title ?? l.id ?? '(no title)'}${tags}`);
          console.log(`    ${l.author ?? '?'} · ${iso}`);
          const summary = firstSentence(l.body ?? l.text ?? '');
          if (summary) console.log(`    ${summary}`);
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
