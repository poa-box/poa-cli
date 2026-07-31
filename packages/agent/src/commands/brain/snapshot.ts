/**
 * pop brain snapshot — project a brain doc to markdown and write it to
 * agent/brain/Knowledge/<docId>.generated.md.
 *
 * This is the read-side counterpart to applyBrainChange. The heartbeat
 * skill calls this at end-of-heartbeat so the projection is kept in
 * sync on disk for human review and git archival. Step 8 of the plan
 * is when the hand-written files are retired and this becomes the
 * source of truth; until then, the output lives at a `.generated.md`
 * suffix so reviewers can diff it against the hand-written original.
 *
 * Graceful bootstrap: if the doc has no head CID yet (manifest empty),
 * the command exits 0 with a log line so that the heartbeat skill can
 * call it unconditionally without blowing up on fresh agents.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { join } from 'path';
import { getRepoBrainRoot } from '../../lib/brain-paths';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { readBrainDoc, stopBrainNode } from '../../lib/brain';
import { projectForDoc } from '../../lib/brain-projections';
import { parseSharedMarkdown } from '../../lib/brain-migrate';
import * as output from '@poa/cli/lib/output';

interface SnapshotArgs {
  doc: string;
  outputPath?: string;
  force?: boolean;
}

/**
 * Count unique lesson ids in a rendered `.generated.md` projection.
 *
 * Task #359 (HB#361): this previously used `/^### /gm` which matched EVERY
 * line starting with `### ` in the markdown, INCLUDING lines inside lesson
 * bodies that contain `### ` as literal content. After HB#358 (#357) taught
 * the parser to preserve H3 body content, body H3s started inflating the
 * naive count and the regression guard reported false mismatches.
 *
 * The fix is in two parts:
 *   1. For the **local projection** side of the comparison, count
 *      `doc.lessons.filter(!removed).length` directly — the doc is in
 *      scope, no parsing needed, no inflation possible. Done inline at
 *      the call site.
 *   2. For the **existing-file** side, we don't have the old doc, so we
 *      parse the markdown structurally (via the HB#358 parser) and count
 *      UNIQUE ids. Unique-id counting dedupes the ghost lessons produced
 *      by one lesson's body containing `### ` at line-start: the parser
 *      will start "new lessons" at each body H3, but those ghosts often
 *      share slug-fallback ids with their neighbors (or with the enclosing
 *      real lesson), so counting unique-ids compresses the inflation
 *      back out. The count reflects the best estimate of how many
 *      distinct-id lessons are structurally present in the file.
 *
 * For non-shared docs (projects, retros), the naive H3 count is still
 * usable because their bodies don't typically contain `### ` lines —
 * kept as a fallback.
 */
function countLessonsInProjectedMarkdown(md: string): number {
  const parsed = parseSharedMarkdown(md, {
    defaultAuthor: 'snapshot-regression-guard',
    defaultTimestamp: 0,
  });
  const uniqueIds = new Set<string>();
  for (const l of parsed.lessons) {
    if (l && typeof l.id === 'string' && l.id !== '') {
      uniqueIds.add(l.id);
    }
  }
  return uniqueIds.size;
}

/**
 * Legacy H3 counter — kept as a fallback for non-shared docs (projects,
 * retros) whose projections don't embed H3 content inside bodies. New
 * shared-doc logic uses `countLessonsInProjectedMarkdown` instead.
 */
function countH3Items(md: string): number {
  const matches = md.match(/^### /gm);
  return matches ? matches.length : 0;
}

/** Parse the "*Head CID: `...`*" line from a generated projection file. */
function parseExistingHeadCid(md: string): string | null {
  const m = /^\*Head CID: `([^`]+)`\*/m.exec(md);
  return m?.[1] ?? null;
}

export const snapshotHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Brain document ID (e.g. pop.brain.shared)',
        type: 'string',
        demandOption: true,
      })
      .option('output-path', {
        describe: 'Explicit output path (default: agent/brain/Knowledge/<doc>.generated.md)',
        type: 'string',
      })
      .option('force', {
        describe:
          'Overwrite the existing generated.md even if it would regress (fewer lessons/projects than the file currently on disk). Use only when you know local state is authoritative.',
        type: 'boolean',
        default: false,
      }),

  handler: async (argv: ArgumentsCamelCase<SnapshotArgs>) => {
    const docId = argv.doc;
    try {
      const { doc, headCid } = await readBrainDoc(docId);

      // Bootstrap case: no local head yet. Log + exit 0 so the
      // heartbeat skill can call us unconditionally.
      if (!headCid && (!doc || Object.keys(doc).length === 0)) {
        if (output.isJsonMode()) {
          output.json({ status: 'no-op', reason: 'no local head for this doc', docId });
        } else {
          console.log(`pop brain snapshot: no local head for "${docId}" — nothing to project yet.`);
        }
        return;
      }

      // Dispatch to the right projector based on docId. Unknown docIds
      // fall through to projectShared so older callers don't regress.
      const markdown = projectForDoc(docId, doc, headCid);

      // Default path: the repo-TRACKED brain (packages/agent/brain/Knowledge).
      // Resolved via getRepoBrainRoot, not process.cwd() — a cwd-built path
      // recreated the pre-split agent/ tree as untracked junk after the move.
      const outPath =
        argv.outputPath ??
        join(getRepoBrainRoot(), 'Knowledge', `${docId}.generated.md`);
      const outDir = outPath.substring(0, outPath.lastIndexOf('/'));
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

      // Regression guard (task #328): if the existing generated.md has
      // MORE content items (H3 headers) than our local projection, the
      // local state is probably behind the peer-merged team state and
      // writing would silently regress the committed file. Refuse with
      // a clear error unless --force. The heartbeat skill calls
      // `pop brain snapshot ... || true` so exit-1 here lets the HB
      // continue without committing the regressed file.
      if (existsSync(outPath) && !argv.force) {
        const existingContent = readFileSync(outPath, 'utf8');
        // Task #359 (HB#361): shared-doc regression guard uses
        // doc-direct counting for the local side and structural unique-id
        // parsing for the existing-file side. Naive /^### /gm counting
        // was inflated by body-embedded `### ` lines after HB#358 taught
        // the parser to preserve them. Other docs fall back to the naive
        // H3 counter (their bodies don't embed H3s).
        const isSharedDoc = docId === 'pop.brain.shared';
        let existingCount: number;
        let newCount: number;
        if (isSharedDoc) {
          existingCount = countLessonsInProjectedMarkdown(existingContent);
          // Authoritative count from the in-memory doc — no parsing,
          // no ghost lessons from body-H3 inflation.
          const liveLessons = Array.isArray((doc as any)?.lessons)
            ? ((doc as any).lessons as any[]).filter((l) => l?.removed !== true)
            : [];
          const liveIds = new Set<string>();
          for (const l of liveLessons) {
            if (l && typeof l.id === 'string' && l.id !== '') liveIds.add(l.id);
          }
          newCount = liveIds.size;
        } else {
          existingCount = countH3Items(existingContent);
          newCount = countH3Items(markdown);
        }
        if (newCount < existingCount) {
          const existingCid = parseExistingHeadCid(existingContent);
          const msg =
            `pop brain snapshot would regress ${outPath}: ` +
            `existing file has ${existingCount} items (head ${existingCid ?? '?'}), ` +
            `local doc projects to ${newCount} items (head ${headCid ?? '?'}). ` +
            `This usually means the local state lacks peer-merged content. ` +
            `Run \`pop brain subscribe --doc ${docId}\` first to sync, ` +
            `or pass \`--force\` to overwrite anyway.`;
          if (output.isJsonMode()) {
            output.json({
              status: 'refused',
              reason: 'regression',
              docId,
              path: outPath,
              existingCount,
              newCount,
              existingHead: existingCid,
              localHead: headCid,
            });
          } else {
            console.error(msg);
          }
          process.exitCode = 1;
          return;
        }
      }

      writeFileSync(outPath, markdown);

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId,
          headCid,
          bytes: markdown.length,
          path: outPath,
        });
      } else {
        console.log(`Wrote ${markdown.length} bytes to ${outPath}`);
        if (headCid) console.log(`Head CID: ${headCid}`);
      }
    } catch (err: any) {
      output.error(err.message);
      process.exitCode = 1;
    } finally {
      await stopBrainNode();
    }
  },
};
