/**
 * pop brain delegations — list claim-signaling lessons with delegateTo set
 *
 * Task #510 (HB#965, sentinel_01). Surfaces the SWARM-style handoff
 * subtype of claim-signaling. The heartbeat skill consults this command
 * each cycle to surface own-delegations as priority-0 actions before
 * checking `pop agent triage` (per the bundle pairing with #511
 * should-i-claim).
 *
 * Flags:
 *   --to <address>     show only delegations whose recipient matches
 *   --from <address>   show only delegations whose author matches
 *   --unanswered       hide delegations that have a follow-up claim or
 *                      decline lesson from the recipient (heuristic:
 *                      another lesson by the recipient that mentions the
 *                      delegation's lesson id in body or causedBy chain)
 *   --doc <docId>      default pop.brain.shared
 *
 * Output:
 *   Default: human-readable table with timestamp, author → delegateTo,
 *   title, lesson id
 *   --json: structured array {id,title,author,delegateTo,timestamp,
 *   answeredBy?: {answerer, lessonId, action}}
 */

import type { ArgumentsCamelCase, Argv } from 'yargs';
import * as output from '../../lib/output';
import { openBrainDoc } from '../../lib/brain';

interface DelegationsArgs {
  doc: string;
  to?: string;
  from?: string;
  unanswered?: boolean;
}

interface LessonRef {
  id: string;
  title?: string;
  author?: string;
  body?: string;
  timestamp?: number;
  delegateTo?: string;
  causedBy?: string | string[];
}

function asArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function normalizeAddress(s: string | undefined): string | undefined {
  if (typeof s !== 'string' || s.length === 0) return undefined;
  return s.trim().toLowerCase();
}

/**
 * Heuristic: a delegation is "answered" when there's at least one later
 * lesson by the recipient that mentions the delegation's lesson id —
 * either via causedBy or via the body containing the slug. Conservative:
 * we err on side of marking unanswered (false negatives are fine; false
 * positives would suppress real pending delegations).
 */
function findAnswer(
  delegation: LessonRef,
  lessons: LessonRef[],
): { answerer: string; lessonId: string } | null {
  const recipient = normalizeAddress(delegation.delegateTo);
  if (!recipient) return null;
  const slug = delegation.id;
  for (const l of lessons) {
    if (!l || !l.id) continue;
    if (normalizeAddress(l.author) !== recipient) continue;
    if (l.id === delegation.id) continue;
    if ((l.timestamp ?? 0) <= (delegation.timestamp ?? 0)) continue;
    // Match via causedBy (typed) — primary signal
    if (asArray(l.causedBy).includes(slug)) {
      return { answerer: recipient, lessonId: l.id };
    }
    // Match via body mention (legacy, less precise)
    if (typeof l.body === 'string' && l.body.includes(slug)) {
      return { answerer: recipient, lessonId: l.id };
    }
  }
  return null;
}

export const delegationsHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Brain document ID (default pop.brain.shared)',
        type: 'string',
        default: 'pop.brain.shared',
      })
      .option('to', {
        describe:
          'Filter to delegations whose delegateTo matches the given address (case-insensitive)',
        type: 'string',
      })
      .option('from', {
        describe:
          'Filter to delegations whose author matches the given address (case-insensitive)',
        type: 'string',
      })
      .option('unanswered', {
        describe:
          'Show only delegations that have NOT been answered (no follow-up lesson by the recipient citing this delegation id)',
        type: 'boolean',
        default: false,
      }),

  handler: async (argv: ArgumentsCamelCase<DelegationsArgs>) => {
    try {
      const { doc } = await openBrainDoc(argv.doc);
      const lessons: LessonRef[] = ((doc as any)?.lessons ?? []) as LessonRef[];

      const wantTo = normalizeAddress(argv.to);
      const wantFrom = normalizeAddress(argv.from);
      const unansweredOnly = !!argv.unanswered;

      const results: Array<{
        id: string;
        title: string | null;
        author: string | null;
        delegateTo: string;
        timestamp: number | null;
        answeredBy: { answerer: string; lessonId: string } | null;
      }> = [];

      for (const l of lessons) {
        if (!l || !l.id || !l.delegateTo) continue;
        const recipient = normalizeAddress(l.delegateTo);
        if (!recipient) continue;
        if (wantTo && recipient !== wantTo) continue;
        if (wantFrom && normalizeAddress(l.author) !== wantFrom) continue;
        const answer = findAnswer(l, lessons);
        if (unansweredOnly && answer) continue;
        results.push({
          id: l.id,
          title: l.title ?? null,
          author: (l.author ?? null) as any,
          delegateTo: recipient,
          timestamp: (l.timestamp ?? null) as any,
          answeredBy: answer,
        });
      }

      results.sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0));

      if (output.isJsonMode()) {
        output.json({ status: 'ok', docId: argv.doc, count: results.length, delegations: results });
        return;
      }

      if (results.length === 0) {
        console.log('');
        console.log('  No delegations match the filters.');
        console.log('');
        return;
      }

      console.log('');
      console.log(`  ${results.length} delegation(s) in ${argv.doc}${argv.to ? ` to ${wantTo}` : ''}${
        argv.from ? ` from ${wantFrom}` : ''
      }${unansweredOnly ? ' (unanswered only)' : ''}:`);
      console.log('');
      for (const r of results) {
        const ts =
          r.timestamp === null
            ? '?'
            : new Date(Number(r.timestamp) * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
        const status = r.answeredBy ? `ANSWERED via ${r.answeredBy.lessonId.slice(0, 50)}` : 'PENDING';
        const author = (r.author ?? '?').slice(0, 12);
        console.log(`  [${ts}] ${author} → ${r.delegateTo.slice(0, 12)}  [${status}]`);
        console.log(`    ${(r.title ?? '(no title)').slice(0, 80)}`);
        console.log(`    id: ${r.id}`);
        console.log('');
      }
    } catch (err: any) {
      output.error(`delegations list failed: ${err.message}`);
      process.exitCode = 1;
    }
  },
};
