/**
 * pop brain thread <lesson-id> — walk a deliberation chain via causedBy
 *
 * Task #509 (HB#962, sentinel_01). Surfaces brain-lesson causality chains
 * machine-readably. Walks BOTH directions:
 *   - ANCESTRY: parent lessons referenced by causedBy on the target +
 *     transitively
 *   - DESCENDANTS: lessons whose own causedBy references the target +
 *     transitively
 *
 * Cycle defense: a lesson can causedBy-reference itself or form a cycle
 * with a peer (author error or auto-derive false positive). The walk
 * tracks visited ids and emits a warning + skips on re-visit; never loops.
 *
 * Output (default): chronological list of all reachable lessons (oldest
 * first). Each entry includes id + title + author + timestamp + arrow
 * marker showing position relative to the target lesson:
 *   ↑ ANCESTOR (chain leading to target)
 *   * TARGET
 *   ↓ DESCENDANT (chain branching from target)
 *
 * --json output: structured `{target, ancestors, descendants, warnings}`
 *   for downstream tooling.
 */

import type { ArgumentsCamelCase, Argv } from 'yargs';
import * as output from '../../lib/output';
import { openBrainDoc } from '../../lib/brain';

interface ThreadArgs {
  doc: string;
  lessonId: string;
  ancestorsOnly?: boolean;
  descendantsOnly?: boolean;
  maxDepth?: number;
}

interface LessonRef {
  id: string;
  title?: string;
  author?: string;
  timestamp?: number;
  causedBy?: string | string[];
}

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
    const parents = asArray(l.causedBy);
    for (const p of parents) {
      const arr = children.get(p) ?? [];
      arr.push(l.id);
      children.set(p, arr);
    }
  }
  return children;
}

interface WalkResult {
  visited: Map<string, { lesson: LessonRef; depth: number; relation: 'ancestor' | 'target' | 'descendant' }>;
  warnings: string[];
}

function walkAncestry(
  startId: string,
  byId: Map<string, LessonRef>,
  out: WalkResult,
  maxDepth: number,
): void {
  const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (out.visited.has(id)) {
      // Already saw this id — cycle defense; warn once per cycle edge.
      if (depth > 0) {
        out.warnings.push(`cycle detected during ancestry walk: re-encountered "${id}" at depth ${depth}`);
      }
      continue;
    }
    if (depth > maxDepth) {
      out.warnings.push(`ancestry walk exceeded maxDepth=${maxDepth} at "${id}"; stopping branch`);
      continue;
    }
    const lesson = byId.get(id);
    if (!lesson) {
      // Reference to a lesson not in this doc — could be a typo or external ref.
      if (depth > 0) {
        out.warnings.push(`unresolved causedBy ancestor "${id}" (not found in doc)`);
      }
      continue;
    }
    out.visited.set(id, {
      lesson,
      depth,
      relation: depth === 0 ? 'target' : 'ancestor',
    });
    for (const parentId of asArray(lesson.causedBy)) {
      queue.push({ id: parentId, depth: depth + 1 });
    }
  }
}

function walkDescendants(
  startId: string,
  byId: Map<string, LessonRef>,
  byParent: Map<string, string[]>,
  out: WalkResult,
  maxDepth: number,
): void {
  const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    const seenEntry = out.visited.get(id);
    if (seenEntry && depth > 0 && seenEntry.relation !== 'descendant') {
      // The descendant walk re-discovered something the ancestry walk
      // already named (or the target itself). This is normal at depth 0
      // (target seeds both walks) and indicates a cycle past depth 0.
      out.warnings.push(`cycle detected during descendant walk: re-encountered "${id}" at depth ${depth}`);
      continue;
    }
    if (seenEntry && depth === 0) {
      // We're at the seed — already recorded by ancestry walk as target.
      // Just descend from here.
    } else if (depth > maxDepth) {
      out.warnings.push(`descendant walk exceeded maxDepth=${maxDepth} at "${id}"; stopping branch`);
      continue;
    } else if (!seenEntry) {
      const lesson = byId.get(id);
      if (!lesson) continue;
      out.visited.set(id, { lesson, depth, relation: 'descendant' });
    }
    const childIds = byParent.get(id) ?? [];
    for (const childId of childIds) {
      queue.push({ id: childId, depth: depth + 1 });
    }
  }
}

function formatTimestamp(ts: number | string | undefined): string {
  if (ts === undefined || ts === null) return '?';
  const n = typeof ts === 'string' ? Number(ts) : ts;
  if (!Number.isFinite(n)) return String(ts);
  // Brain timestamps are seconds since epoch.
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export const threadHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Brain document ID (e.g. pop.brain.shared)',
        type: 'string',
        default: 'pop.brain.shared',
      })
      .positional('lesson-id', {
        describe: 'Lesson id to walk causedBy ancestry + descendants from',
        type: 'string',
        demandOption: true,
      })
      .option('ancestors-only', {
        describe: 'Only walk parents (causedBy chain). Skip the descendant walk.',
        type: 'boolean',
        default: false,
      })
      .option('descendants-only', {
        describe: 'Only walk children (lessons whose causedBy references this one). Skip ancestry walk.',
        type: 'boolean',
        default: false,
      })
      .option('max-depth', {
        describe:
          'Max walk depth in either direction (cycle / runaway-chain defense). Default 50; bump for very long chains.',
        type: 'number',
        default: 50,
      }),

  handler: async (argv: ArgumentsCamelCase<ThreadArgs>) => {
    try {
      const { doc } = await openBrainDoc(argv.doc);
      const lessons = (doc as any)?.lessons;
      if (!Array.isArray(lessons)) {
        output.error(`doc ${argv.doc} has no lessons array`);
        process.exitCode = 1;
        return;
      }

      const byId = buildIndex(lessons);
      const byParent = buildChildIndex(lessons);

      const target = byId.get(argv.lessonId);
      if (!target) {
        output.error(`lesson "${argv.lessonId}" not found in ${argv.doc}`);
        process.exitCode = 1;
        return;
      }

      const result: WalkResult = { visited: new Map(), warnings: [] };

      if (!argv.descendantsOnly) {
        walkAncestry(argv.lessonId, byId, result, argv.maxDepth ?? 50);
      } else {
        // Seed the visited map with the target so the descendant walk
        // can extend correctly.
        result.visited.set(argv.lessonId, { lesson: target, depth: 0, relation: 'target' });
      }

      if (!argv.ancestorsOnly) {
        walkDescendants(argv.lessonId, byId, byParent, result, argv.maxDepth ?? 50);
      }

      // Sort all visited lessons chronologically (oldest first).
      const ordered = Array.from(result.visited.values()).sort((a, b) => {
        const ta = Number(a.lesson.timestamp ?? 0);
        const tb = Number(b.lesson.timestamp ?? 0);
        return ta - tb;
      });

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId: argv.doc,
          target: { id: target.id, title: target.title ?? null },
          chain: ordered.map((e) => ({
            id: e.lesson.id,
            title: e.lesson.title ?? null,
            author: e.lesson.author ?? null,
            timestamp: e.lesson.timestamp ?? null,
            relation: e.relation,
            depth: e.depth,
            causedBy: e.lesson.causedBy ?? null,
          })),
          ancestorCount: ordered.filter((e) => e.relation === 'ancestor').length,
          descendantCount: ordered.filter((e) => e.relation === 'descendant').length,
          warnings: result.warnings,
        });
        return;
      }

      // Human-readable output: chronological list with relation markers.
      console.log('');
      console.log(`  Thread for lesson: ${target.id}`);
      console.log(`  doc: ${argv.doc}`);
      console.log(`  ${ordered.length} lessons in chain (${
        ordered.filter((e) => e.relation === 'ancestor').length
      } ancestors + 1 target + ${
        ordered.filter((e) => e.relation === 'descendant').length
      } descendants)`);
      console.log('');
      for (const entry of ordered) {
        const marker =
          entry.relation === 'target' ? '*' : entry.relation === 'ancestor' ? '↑' : '↓';
        const title = (entry.lesson.title ?? '(no title)').slice(0, 80);
        const author = (entry.lesson.author ?? '?').slice(0, 12);
        console.log(`  ${marker} [${formatTimestamp(entry.lesson.timestamp)}] ${author}`);
        console.log(`    ${title}`);
        console.log(`    id: ${entry.lesson.id}`);
        if (entry.lesson.causedBy !== undefined) {
          const parents = asArray(entry.lesson.causedBy);
          if (parents.length === 1) {
            console.log(`    causedBy: ${parents[0]}`);
          } else if (parents.length > 1) {
            console.log(`    causedBy (multi-parent, ${parents.length}):`);
            for (const p of parents) console.log(`      - ${p}`);
          }
        }
        console.log('');
      }

      if (result.warnings.length > 0) {
        console.log(`  Warnings:`);
        for (const w of result.warnings) console.log(`    - ${w}`);
        console.log('');
      }
    } catch (err: any) {
      output.error(`thread walk failed: ${err.message}`);
      process.exitCode = 1;
    }
  },
};
