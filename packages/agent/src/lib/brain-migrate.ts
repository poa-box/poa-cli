/**
 * Brain migration — one-shot parser that converts the hand-written
 * agent/brain/Knowledge/shared.md (and siblings) into a structured
 * SharedBrainDoc for seeding the Automerge CRDT layer.
 *
 * This is step 8 of the brain plan (cheeky-nibbling-raven.md).
 * After this file has been run once on each hand-written knowledge
 * file, the CRDT substrate is the source of truth and the hand-written
 * files become historical snapshots.
 *
 * ## Design notes
 *
 * - **Pure function.** parseSharedMarkdown takes a raw string and
 *   returns a SharedBrainDoc. No I/O, no Date.now, no environment
 *   reads. The CLI command handles all I/O and timestamp-from-now
 *   decisions.
 *
 * - **Heuristic, not canonical.** This is a one-shot parse; we're
 *   allowed to lose fidelity on layout details as long as the
 *   content content survives. Each H2 section becomes one entry.
 *
 * - **Short sections become rules, long sections become lessons.**
 *   A rule is a short-form policy item (one to a few lines of plain
 *   text, often bullet-led). A lesson is a longer structured
 *   narrative. The heuristic: if a section's body has more than 200
 *   characters OR contains a code fence, it's a lesson; otherwise
 *   it's a rule. This maps the existing hand-written file's mix of
 *   short policy bullets and long narrative notes to the brain doc
 *   schema cleanly.
 *
 * - **HB# tags → timestamps.** Lines containing `HB#N` or `(HB#N,
 *   author)` extract both the heartbeat number and the author.
 *   Timestamps are derived from HB# via a caller-provided anchor
 *   (see MigrationContext below) rather than guessed — keeps the
 *   parser pure.
 *
 * - **Code fences are preserved verbatim.** We do NOT split on ##
 *   headers inside a ``` block — that would corrupt embedded code
 *   samples. Tracked via a simple in-fence toggle.
 */

import type { SharedBrainDoc } from './brain-projections';

export interface MigrationContext {
  /**
   * Default author to assign to sections where no HB#/author tag was
   * found in the source. Typically the agent running the migration.
   */
  defaultAuthor: string;
  /**
   * Unix-seconds timestamp representing "now" for the migration run.
   * Sections without their own HB# tag get this timestamp — a
   * reasonable proxy for "discovered at migration time."
   */
  defaultTimestamp: number;
  /**
   * Caller-supplied function that turns a heartbeat number into a
   * unix-seconds timestamp. Pass in the "best guess" curve, typically
   * `now - (currentHB - N) * 15 * 60`. If omitted, all HB# tagged
   * sections fall back to defaultTimestamp.
   */
  timestampForHB?: (hb: number) => number;
}

export interface ParsedBrainDoc extends SharedBrainDoc {
  // Always present after a parse run — makes downstream handling
  // non-optional.
  rules: NonNullable<SharedBrainDoc['rules']>;
  lessons: NonNullable<SharedBrainDoc['lessons']>;
}

const HB_TAG_RE = /\(\s*HB#(\d+)(?:\s*,\s*([^\s)]+))?\s*\)/i;
const BARE_HB_RE = /\bHB#(\d+)\b/i;

/**
 * Slugify a string for use as an entry id. Keeps lowercase letters,
 * digits, and hyphens; collapses other characters to hyphens.
 */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Split raw markdown into sections delimited by `^## ` headers at
 * the top level. Returns an ordered list of { header, body } pairs.
 * Skips content before the first H2 (preamble) entirely — it's
 * usually the file's title and intro paragraph.
 *
 * Code fences are respected: `##` inside a ``` block is treated as
 * literal content, not a section break. This matters because the
 * hand-written shared.md embeds shell command examples with
 * triple-backtick fences, and one of those happens to include a
 * markdown header in a commented line.
 */
function splitSections(raw: string): Array<{ header: string; body: string }> {
  const lines = raw.split(/\r?\n/);
  const sections: Array<{ header: string; body: string }> = [];
  let inFence = false;
  let current: { header: string; body: string[] } | null = null;

  for (const line of lines) {
    // Track code fence state so we don't treat `##` inside code as
    // a new section.
    if (/^```/.test(line)) {
      inFence = !inFence;
      if (current) current.body.push(line);
      continue;
    }

    if (!inFence && /^##\s+/.test(line)) {
      if (current) sections.push({ header: current.header, body: current.body.join('\n').trim() });
      current = { header: line.replace(/^##\s+/, '').trim(), body: [] };
      continue;
    }

    if (current) current.body.push(line);
    // lines before the first H2 are dropped (preamble)
  }

  if (current) sections.push({ header: current.header, body: current.body.join('\n').trim() });
  return sections;
}

/**
 * Extract an HB#/author tag from a block of text. Returns the first
 * match found (usually the header or the first body line). Returns
 * null if nothing matches.
 */
function extractHBTag(text: string): { hb: number; author: string | null } | null {
  const m = HB_TAG_RE.exec(text);
  if (m) return { hb: Number(m[1]), author: m[2] ?? null };
  const bare = BARE_HB_RE.exec(text);
  if (bare) return { hb: Number(bare[1]), author: null };
  return null;
}

/**
 * Detect whether the input is a modern `.generated.md` snapshot produced by
 * `pop brain snapshot` (task #352+), not a hand-written `shared.md`. The
 * discriminator is the DO-NOT-HAND-EDIT banner that the projector emits.
 *
 * Task #357 (HB#358): before this detection existed, parseSharedMarkdown
 * tried the legacy H2 scanner against the generated.md format and found
 * only 6 of 59 lessons — matching H2 headers like `## Lessons`,
 * `## What worked this session`, etc., as lesson titles. This is a
 * permanent format mismatch, not a parse bug; the solution is a
 * different parser for each format, dispatched by banner detection.
 */
function isModernGeneratedMd(raw: string): boolean {
  return /^# GENERATED BY `pop brain snapshot`/m.test(raw.slice(0, 500));
}

/**
 * Parse a modern `.generated.md` snapshot (task #357 / HB#358).
 *
 * Structure produced by brain-projections.ts `projectShared`:
 *
 *   # GENERATED BY `pop brain snapshot` — DO NOT HAND-EDIT
 *   <!-- ... -->
 *
 *   # Shared Agent Brain — `pop.brain.shared`
 *   *Head CID: `bafk...`*
 *
 *   ## Lessons
 *
 *   ### <lesson title> [possibly containing (HB#N, author)]
 *   *author: <name> · at: <ISO timestamp> · id: <lesson-id>*
 *
 *   <body paragraphs — may contain code fences AND `##` subheaders>
 *
 *   ---
 *
 *   ### <next lesson title>
 *   ...
 *
 *   ## Removed lessons
 *   ...
 *
 * Rules for this parser:
 *   1. Only consider content after the `## Lessons` header
 *   2. A lesson starts at `### <title>` (H3)
 *   3. The line immediately after (if matching `*author: ... · at: ... · id: ...*`)
 *      provides metadata
 *   4. Body = everything until the NEXT `### <title>` OR one of the known
 *      terminator H2 headers (`## Removed lessons`, `## Other fields`)
 *   5. `##` subheaders INSIDE a lesson body (e.g. `## What worked` inside a
 *      retro-style lesson) are content, not terminators
 *   6. `---` horizontal rules between lessons are cosmetic and dropped
 *   7. Code fences are respected: `###` inside ``` is literal content
 *
 * Every modern lesson is parsed as a lesson (not a rule). Rules only exist
 * in the legacy hand-written format and aren't produced by the modern
 * projector anymore.
 */
function parseModernGeneratedMd(raw: string, ctx: MigrationContext): ParsedBrainDoc {
  const lessons: NonNullable<SharedBrainDoc['lessons']> = [];
  const lines = raw.split(/\r?\n/);

  // Find the `## Lessons` header. Everything before is banner + doc title.
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Lessons\s*$/.test(lines[i])) {
      startIdx = i + 1;
      break;
    }
  }
  if (startIdx === -1) {
    // No lessons section — return empty. This is a valid case for a
    // fresh generated.md before any lesson has been written.
    return { rules: [], lessons: [] };
  }

  // Known terminator H2 headers that end the Lessons section.
  const TERMINATORS = [
    /^##\s+Removed lessons\s*$/,
    /^##\s+Other fields\s*$/,
  ];
  const isTerminator = (line: string) => TERMINATORS.some(re => re.test(line));

  // Metadata line format: `*author: X · at: ISO-TIMESTAMP · id: lesson-id*`
  // Each field is separated by ` · ` (middle dot with spaces).
  const METADATA_RE = /^\*author:\s*([^·]+?)\s*·\s*at:\s*([^·]+?)\s*·\s*id:\s*([^*\s]+)\s*\*?$/;

  let inFence = false;
  let pending: {
    title: string;
    author: string | null;
    at: string | null;
    id: string | null;
    bodyLines: string[];
  } | null = null;

  const commitPending = () => {
    if (!pending) return;
    // Title may contain HB#N tag. Extract for timestamp resolution and
    // also strip from the title for cleanliness.
    const tag = extractHBTag(pending.title);

    // Prefer the metadata author field; fall back to HB# tag author;
    // fall back to default.
    const author = pending.author ?? tag?.author ?? ctx.defaultAuthor;

    // Prefer the metadata `at:` ISO timestamp (parse to unix seconds).
    // Fall back to HB-derived timestamp, then default.
    let timestamp = ctx.defaultTimestamp;
    if (pending.at) {
      const parsed = Date.parse(pending.at);
      if (Number.isFinite(parsed)) {
        timestamp = Math.floor(parsed / 1000);
      }
    } else if (tag && ctx.timestampForHB) {
      timestamp = ctx.timestampForHB(tag.hb);
    }

    // Prefer the metadata `id:` field; fall back to slugified title.
    const id = pending.id ?? slugify(pending.title) ?? `lesson-${lessons.length + 1}`;

    // Join the body and trim trailing whitespace / trailing `---` separator.
    const body = pending.bodyLines
      .join('\n')
      .replace(/\n+---\n*$/, '')  // trim trailing horizontal rule
      .trim();

    if (body.length === 0 && !pending.id && !pending.author) {
      // Empty lesson with no metadata — likely a parse artifact, skip.
      pending = null;
      return;
    }

    lessons.push({ id, title: pending.title, author, body, timestamp });
    pending = null;
  };

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];

    // Track code fence state — `###` inside ``` is literal content.
    if (/^```/.test(line)) {
      inFence = !inFence;
      if (pending) pending.bodyLines.push(line);
      continue;
    }

    if (!inFence) {
      // Terminator: end of Lessons section. Commit + stop.
      if (isTerminator(line)) {
        commitPending();
        break;
      }

      // New H3 = new lesson.
      const h3Match = /^###\s+(.+?)\s*$/.exec(line);
      if (h3Match) {
        commitPending();
        pending = {
          title: h3Match[1],
          author: null,
          at: null,
          id: null,
          bodyLines: [],
        };
        continue;
      }

      // Metadata line immediately after the H3 (pending has no body yet).
      if (pending && pending.bodyLines.length === 0 && pending.id === null) {
        const metaMatch = METADATA_RE.exec(line);
        if (metaMatch) {
          pending.author = metaMatch[1];
          pending.at = metaMatch[2];
          pending.id = metaMatch[3];
          continue;
        }
      }
    }

    // Content line — append to the pending lesson body.
    if (pending) pending.bodyLines.push(line);
  }

  // Commit the final lesson if we hit EOF without a terminator.
  commitPending();

  return { rules: [], lessons };
}

/**
 * Parse the hand-written shared.md (or similar) into a SharedBrainDoc.
 *
 * Dispatches to `parseModernGeneratedMd` for modern snapshots produced by
 * `pop brain snapshot` (detected via the DO-NOT-HAND-EDIT banner), or to
 * the legacy H2-section scanner for hand-written shared.md files.
 *
 * Pure function — no I/O, no Date.now, no env reads. The caller must
 * supply the migration context (default author, default timestamp,
 * optional HB→timestamp function).
 */
export function parseSharedMarkdown(raw: string, ctx: MigrationContext): ParsedBrainDoc {
  // Task #357 dispatch: modern generated.md vs legacy hand-written.
  if (isModernGeneratedMd(raw)) {
    return parseModernGeneratedMd(raw, ctx);
  }

  const sections = splitSections(raw);

  const rules: NonNullable<SharedBrainDoc['rules']> = [];
  const lessons: NonNullable<SharedBrainDoc['lessons']> = [];

  for (const { header, body } of sections) {
    if (body.length === 0) continue;

    const combinedForTagHunt = `${header}\n${body.split('\n').slice(0, 2).join('\n')}`;
    const tag = extractHBTag(combinedForTagHunt);
    const author = tag?.author ?? ctx.defaultAuthor;
    const timestamp =
      tag && ctx.timestampForHB
        ? ctx.timestampForHB(tag.hb)
        : ctx.defaultTimestamp;

    const hasCodeFence = /^```/m.test(body);
    const isLesson = body.length > 200 || hasCodeFence;

    const id = slugify(header) || `section-${lessons.length + rules.length + 1}`;

    if (isLesson) {
      lessons.push({
        id,
        title: header,
        author,
        body,
        timestamp,
      });
    } else {
      rules.push({
        id,
        author,
        text: body,
        timestamp,
      });
    }
  }

  return { rules, lessons };
}
