/**
 * pop brain check-retractions <lesson-id> — cascade-retraction scanner.
 *
 * Task #531 (vigil HB#673 spec; vigil HB#682 implementation).
 *
 * RULE #24 extension: when a peer agent self-corrects a lesson (e.g. sentinel
 * HB#1040 corrected HB#1039), descendants that built on the corrected claim
 * may need cascade-retraction. This command walks the causedBy descendant
 * tree from a given lesson and surfaces which descendants ALREADY have
 * retractions vs which are PENDING (cascade-retraction candidates).
 *
 * Detection heuristic for "already retracted":
 *  - lesson has `retraction` or `rule-24-retraction` in its tags
 *  - OR a descendant of THIS lesson exists with a retraction marker
 *    (so the original descendant is implicitly retracted)
 *
 * Output (default): human-readable list with ✓ retracted / ⚠ pending markers
 * Output (--json): structured for tooling
 *
 * Pairs with `pop brain thread` (Task #509) — thread walks ancestry+descendants
 * for general deliberation; check-retractions walks descendants ONLY with
 * retraction-aware filtering.
 */

import type { ArgumentsCamelCase, Argv } from 'yargs';
import * as output from '../../lib/output';
import { openBrainDoc, stopBrainNode } from '../../lib/brain';

interface CheckRetractionsArgs {
  doc: string;
  lessonId: string;
  maxDepth?: number;
  json?: boolean;
}

interface LessonRef {
  id: string;
  title?: string;
  author?: string;
  timestamp?: number;
  causedBy?: string | string[];
  tags?: string[];
  body?: string;
}

const RETRACTION_TAGS = new Set([
  'retraction',
  'rule-24-retraction',
  'rule-24',
  'cascade-retraction',
]);

const RETRACTION_TITLE_PATTERNS = [
  /\bRETRACTION\b/i,
  /\bRETRACT(?:ED|S)?\b/i,
  /\bRULE\s*#?\s*24\b/i,
];

function asArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function buildIndex(lessons: LessonRef[]): Map<string, LessonRef> {
  const idx = new Map<string, LessonRef>();
  for (const l of lessons) {
    if (l && l.id) idx.set(l.id, l);
  }
  return idx;
}

function buildChildIndex(lessons: LessonRef[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const l of lessons) {
    if (!l || !l.id) continue;
    for (const p of asArray(l.causedBy)) {
      const arr = children.get(p) ?? [];
      arr.push(l.id);
      children.set(p, arr);
    }
  }
  return children;
}

function isRetractionLesson(l: LessonRef): boolean {
  const tags = (l.tags ?? []).map((t) => t.toLowerCase());
  for (const t of tags) {
    if (RETRACTION_TAGS.has(t)) return true;
  }
  const title = l.title ?? '';
  for (const re of RETRACTION_TITLE_PATTERNS) {
    if (re.test(title)) return true;
  }
  return false;
}

interface DescendantStatus {
  lesson: LessonRef;
  depth: number;
  retracted: boolean;
  /** ID of the retracting lesson (if found via descendant scan) */
  retractedBy?: string;
  retractedByTitle?: string;
}

function walkDescendants(
  startId: string,
  byId: Map<string, LessonRef>,
  byParent: Map<string, string[]>,
  maxDepth: number,
): { entries: DescendantStatus[]; warnings: string[] } {
  const visited = new Set<string>();
  const entries: DescendantStatus[] = [];
  const warnings: string[] = [];

  const queue: Array<{ id: string; depth: number }> = [];
  for (const childId of byParent.get(startId) ?? []) {
    queue.push({ id: childId, depth: 1 });
  }

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id)) {
      warnings.push(`cycle detected: re-encountered "${id}" at depth ${depth}`);
      continue;
    }
    if (depth > maxDepth) {
      warnings.push(`descendant walk exceeded maxDepth=${maxDepth} at "${id}"; stopping branch`);
      continue;
    }
    visited.add(id);
    const lesson = byId.get(id);
    if (!lesson) continue;

    // Compute retraction status: a descendant is "retracted" iff
    //   (a) the descendant itself is a retraction lesson (self-marker), OR
    //   (b) one of ITS descendants is a retraction lesson (retraction-by-followup)
    let retracted = false;
    let retractedBy: string | undefined;
    let retractedByTitle: string | undefined;

    if (isRetractionLesson(lesson)) {
      retracted = true;
      retractedBy = lesson.id;
      retractedByTitle = lesson.title;
    } else {
      // Scan first-level children for retraction markers
      for (const grandId of byParent.get(id) ?? []) {
        const grand = byId.get(grandId);
        if (grand && isRetractionLesson(grand)) {
          retracted = true;
          retractedBy = grand.id;
          retractedByTitle = grand.title;
          break;
        }
      }
    }

    entries.push({ lesson, depth, retracted, retractedBy, retractedByTitle });

    // Enqueue children for deeper walk
    for (const childId of byParent.get(id) ?? []) {
      queue.push({ id: childId, depth: depth + 1 });
    }
  }

  // Sort by timestamp asc (chronological)
  entries.sort((a, b) => (a.lesson.timestamp ?? 0) - (b.lesson.timestamp ?? 0));
  return { entries, warnings };
}

function formatTimestamp(ts: number | string | undefined): string {
  if (ts === undefined || ts === null) return '?';
  const n = typeof ts === 'string' ? Number(ts) : ts;
  if (!Number.isFinite(n)) return String(ts);
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export const checkRetractionsHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Brain document ID (e.g. pop.brain.shared)',
        type: 'string',
        default: 'pop.brain.shared',
      })
      .positional('lesson-id', {
        describe: 'Corrected/retracted lesson id; walk descendants and surface cascade-retraction candidates',
        type: 'string',
        demandOption: true,
      })
      .option('max-depth', {
        describe: 'Max descendant walk depth (cycle defense). Default 50.',
        type: 'number',
        default: 50,
      })
      .option('json', {
        describe: 'Machine-readable JSON output',
        type: 'boolean',
        default: false,
      }),

  handler: async (argv: ArgumentsCamelCase<CheckRetractionsArgs>) => {
    const docId = (argv.doc as string) || 'pop.brain.shared';
    const lessonId = (argv as any).lessonId as string;
    const maxDepth = (argv.maxDepth as number) ?? 50;
    const wantJson = Boolean(argv.json);

    if (!lessonId) {
      output.error('lesson-id positional argument required');
      process.exit(1);
    }

    const { doc } = await openBrainDoc(docId);

    try {
      const lessons = ((doc as any)?.lessons ?? []) as LessonRef[];
      const byId = buildIndex(lessons);
      const byParent = buildChildIndex(lessons);

      const target = byId.get(lessonId);
      if (!target) {
        if (wantJson) {
          console.log(JSON.stringify({ error: `lesson not found: ${lessonId}`, docId }, null, 2));
        } else {
          output.error(`Lesson not found in ${docId}: ${lessonId}`);
        }
        process.exit(2);
      }

      const { entries, warnings } = walkDescendants(lessonId, byId, byParent, maxDepth);

      const retractedCount = entries.filter((e) => e.retracted).length;
      const pendingCount = entries.length - retractedCount;

      if (wantJson) {
        console.log(
          JSON.stringify(
            {
              target: {
                id: target.id,
                title: target.title,
                author: target.author,
                timestamp: target.timestamp,
              },
              descendants: entries.map((e) => ({
                id: e.lesson.id,
                title: e.lesson.title,
                author: e.lesson.author,
                timestamp: e.lesson.timestamp,
                depth: e.depth,
                retracted: e.retracted,
                retractedBy: e.retractedBy,
                retractedByTitle: e.retractedByTitle,
              })),
              summary: {
                totalDescendants: entries.length,
                retracted: retractedCount,
                pending: pendingCount,
              },
              warnings,
            },
            null,
            2,
          ),
        );
        process.exit(pendingCount > 0 ? 2 : 0);
      }

      // Human-readable
      console.log('');
      console.log(`  Cascade-retraction check for: ${target.id}`);
      console.log(`    "${(target.title ?? '').slice(0, 90)}"`);
      console.log(`    author: ${target.author ?? '?'}  ts: ${formatTimestamp(target.timestamp)}`);
      console.log('');

      if (entries.length === 0) {
        console.log('  No descendants found via causedBy.');
        console.log('');
        process.exit(0);
      }

      console.log(`  Descendants (${entries.length} total, ${retractedCount} retracted, ${pendingCount} pending):`);
      console.log('');
      for (const e of entries) {
        const marker = e.retracted ? '✓ RETRACTED' : '⚠ PENDING  ';
        const indent = '  '.repeat(e.depth);
        console.log(`    ${marker} ${indent}${e.lesson.id}`);
        console.log(`                ${indent}  "${(e.lesson.title ?? '').slice(0, 80)}"`);
        console.log(`                ${indent}  author: ${e.lesson.author ?? '?'}  ts: ${formatTimestamp(e.lesson.timestamp)}`);
        if (e.retracted && e.retractedBy && e.retractedBy !== e.lesson.id) {
          console.log(`                ${indent}  retracted-by: ${e.retractedBy}`);
        }
        console.log('');
      }

      if (warnings.length > 0) {
        console.log(`  Warnings (${warnings.length}):`);
        for (const w of warnings) console.log(`    - ${w}`);
        console.log('');
      }

      console.log(`  Summary: ${retractedCount}/${entries.length} retracted; ${pendingCount} need review.`);
      if (pendingCount > 0) {
        console.log(`  Action: review the PENDING descendants — if they materially depend on the corrected claim,`);
        console.log(`          issue a RULE #24 cascade-retraction lesson with causedBy to both target + descendant.`);
      }
      console.log('');

      process.exit(pendingCount > 0 ? 2 : 0);
    } finally {
      await stopBrainNode();
    }
  },
};
