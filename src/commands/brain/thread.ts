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
  inferred?: boolean;
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

/**
 * Auto-derive heuristic — scan a lesson's body for full-slug-form lesson
 * ids (`hb-N-...-TIMESTAMP`) and return the subset that resolve to lessons
 * in the doc's index. We deliberately DON'T match the abbreviated `HB#NNN`
 * form because it's high-recall but low-precision (multiple lessons share
 * the same HB number across the corpus); the full-slug form includes the
 * unique timestamp suffix.
 *
 * Returns an empty array when the lesson has no body or no matches.
 */
const FULL_SLUG_RE = /hb-\d+-[a-z0-9-]+?-1\d{9,12}/g;

function deriveInferredCausedBy(lesson: LessonRef, byId: Map<string, LessonRef>): string[] {
  const body = (lesson as any)?.body;
  if (typeof body !== 'string' || body.length === 0) return [];
  const matches = body.match(FULL_SLUG_RE) ?? [];
  if (matches.length === 0) return [];
  const explicit = new Set(asArray(lesson.causedBy));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (m === lesson.id) continue; // self-reference; skip
    if (explicit.has(m)) continue; // already author-asserted; not inferred
    if (seen.has(m)) continue; // de-dup duplicate body matches
    if (!byId.has(m)) continue; // unresolved — skip without warning (body-scan noise)
    seen.add(m);
    out.push(m);
  }
  return out;
}

function buildIndex(lessons: LessonRef[]): Map<string, LessonRef> {
  const idx = new Map<string, LessonRef>();
  for (const l of lessons) {
    if (l && l.id) idx.set(l.id, l);
  }
  return idx;
}

/**
 * Collect a lesson's effective parent refs. `explicit` is what the author
 * asserted via `--caused-by`; `inferred` is body-scan matches that resolve
 * in the local doc (omitted when --no-inferred). The walker uses both for
 * traversal but tracks inferred edges separately for output marking.
 */
function effectiveParents(
  lesson: LessonRef,
  byId: Map<string, LessonRef>,
  includeInferred: boolean,
): { explicit: string[]; inferred: string[] } {
  const explicit = asArray(lesson.causedBy);
  if (!includeInferred) return { explicit, inferred: [] };
  const inferred = deriveInferredCausedBy(lesson, byId);
  return { explicit, inferred };
}

function buildChildIndex(
  lessons: LessonRef[],
  byId: Map<string, LessonRef>,
  includeInferred: boolean,
): { children: Map<string, string[]>; inferredEdges: Set<string> } {
  const children = new Map<string, string[]>();
  const inferredEdges = new Set<string>();
  for (const l of lessons) {
    if (!l || !l.id) continue;
    const { explicit, inferred } = effectiveParents(l, byId, includeInferred);
    for (const p of explicit) {
      const arr = children.get(p) ?? [];
      arr.push(l.id);
      children.set(p, arr);
    }
    for (const p of inferred) {
      const arr = children.get(p) ?? [];
      arr.push(l.id);
      children.set(p, arr);
      // Tag the (parent → child) edge as inferred. Format: "<parent>->|<child>".
      inferredEdges.add(`${p}->${l.id}`);
    }
  }
  return { children, inferredEdges };
}

interface WalkEntry {
  lesson: LessonRef;
  depth: number;
  relation: 'ancestor' | 'target' | 'descendant';
  /** True when this entry was reached via at least one inferred (body-scan) edge from the target. */
  viaInferredEdge?: boolean;
}

interface WalkResult {
  visited: Map<string, WalkEntry>;
  warnings: string[];
  inferredEdges: Set<string>;
}

function walkAncestry(
  startId: string,
  byId: Map<string, LessonRef>,
  out: WalkResult,
  maxDepth: number,
  includeInferred: boolean,
): void {
  const queue: Array<{ id: string; depth: number; viaInferred: boolean }> = [
    { id: startId, depth: 0, viaInferred: false },
  ];
  while (queue.length > 0) {
    const { id, depth, viaInferred } = queue.shift()!;
    if (out.visited.has(id)) {
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
      if (depth > 0) {
        out.warnings.push(`unresolved causedBy ancestor "${id}" (not found in doc)`);
      }
      continue;
    }
    out.visited.set(id, {
      lesson,
      depth,
      relation: depth === 0 ? 'target' : 'ancestor',
      viaInferredEdge: viaInferred,
    });
    const { explicit, inferred } = effectiveParents(lesson, byId, includeInferred);
    for (const parentId of explicit) {
      queue.push({ id: parentId, depth: depth + 1, viaInferred });
    }
    for (const parentId of inferred) {
      // record edge for output
      out.inferredEdges.add(`${parentId}->${id}`);
      queue.push({ id: parentId, depth: depth + 1, viaInferred: true });
    }
  }
}

function walkDescendants(
  startId: string,
  byId: Map<string, LessonRef>,
  byParent: Map<string, string[]>,
  inferredEdgesFromBuild: Set<string>,
  out: WalkResult,
  maxDepth: number,
): void {
  const queue: Array<{ id: string; depth: number; viaInferred: boolean }> = [
    { id: startId, depth: 0, viaInferred: false },
  ];
  while (queue.length > 0) {
    const { id, depth, viaInferred } = queue.shift()!;
    const seenEntry = out.visited.get(id);
    if (seenEntry && depth > 0 && seenEntry.relation !== 'descendant') {
      out.warnings.push(`cycle detected during descendant walk: re-encountered "${id}" at depth ${depth}`);
      continue;
    }
    if (seenEntry && depth === 0) {
      // target — already recorded by ancestry walk
    } else if (depth > maxDepth) {
      out.warnings.push(`descendant walk exceeded maxDepth=${maxDepth} at "${id}"; stopping branch`);
      continue;
    } else if (!seenEntry) {
      const lesson = byId.get(id);
      if (!lesson) continue;
      out.visited.set(id, { lesson, depth, relation: 'descendant', viaInferredEdge: viaInferred });
    }
    const childIds = byParent.get(id) ?? [];
    for (const childId of childIds) {
      const edgeKey = `${id}->${childId}`;
      const edgeInferred = inferredEdgesFromBuild.has(edgeKey);
      if (edgeInferred) out.inferredEdges.add(edgeKey);
      queue.push({ id: childId, depth: depth + 1, viaInferred: viaInferred || edgeInferred });
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
      })
      .option('inferred', {
        describe:
          'Auto-derive heuristic: body-scan for full-slug lesson ids and treat resolvable matches as additional causedBy refs. Default ON. Pass --no-inferred to disable (only follow author-asserted causedBy). Inferred edges are flagged as `viaInferredEdge: true` in --json output and shown with a "(inferred)" annotation in human output.',
        type: 'boolean',
        default: true,
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

      const includeInferred = argv.inferred !== false;
      const byId = buildIndex(lessons);
      const { children: byParent, inferredEdges: builtInferredEdges } = buildChildIndex(
        lessons,
        byId,
        includeInferred,
      );

      const target = byId.get(argv.lessonId);
      if (!target) {
        output.error(`lesson "${argv.lessonId}" not found in ${argv.doc}`);
        process.exitCode = 1;
        return;
      }

      const result: WalkResult = {
        visited: new Map(),
        warnings: [],
        inferredEdges: new Set<string>(),
      };

      if (!argv.descendantsOnly) {
        walkAncestry(argv.lessonId, byId, result, argv.maxDepth ?? 50, includeInferred);
      } else {
        result.visited.set(argv.lessonId, {
          lesson: target,
          depth: 0,
          relation: 'target',
          viaInferredEdge: false,
        });
      }

      if (!argv.ancestorsOnly) {
        walkDescendants(argv.lessonId, byId, byParent, builtInferredEdges, result, argv.maxDepth ?? 50);
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
            viaInferredEdge: e.viaInferredEdge ?? false,
          })),
          ancestorCount: ordered.filter((e) => e.relation === 'ancestor').length,
          descendantCount: ordered.filter((e) => e.relation === 'descendant').length,
          inferredEdgeCount: result.inferredEdges.size,
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
        const inferredFlag = entry.viaInferredEdge ? ' (inferred)' : '';
        const title = (entry.lesson.title ?? '(no title)').slice(0, 80);
        const author = (entry.lesson.author ?? '?').slice(0, 12);
        console.log(`  ${marker} [${formatTimestamp(entry.lesson.timestamp)}] ${author}${inferredFlag}`);
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
