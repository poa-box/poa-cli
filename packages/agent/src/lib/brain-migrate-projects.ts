/**
 * Brain projects migration — one-shot parser for agent/brain/Knowledge/projects.md
 * into a ProjectsBrainDoc.
 *
 * This parses the "Active Projects" H2 section only. Each '### <Name>'
 * subsection becomes a BrainProject entry. Structured fields we extract:
 *
 *   - Stage           — from "- **Stage**: X"
 *   - Proposed by     — from "- **Proposed by**: <author> (HB#N)"
 *   - Brief           — from "- **Brief**: ..." (possibly multi-line with
 *                        continuation indented under the bullet)
 *
 * Unstructured fields we preserve as raw markdown strings attached to
 * the project:
 *
 *   - Discussion      → taskPlan field, prefixed '(Raw markdown from
 *                        projects.md — parse in v2)' (TODO: split into
 *                        ProjectDiscussionEntry[] with author / stance /
 *                        timestamp fields when we have time)
 *   - Task Plan       → concatenated into taskPlan
 *   - Proposal        → concatenated into proposal
 *   - Retrospective   → concatenated into retrospective
 *
 * Same discipline as parseSharedMarkdown from brain-migrate.ts: pure
 * function, no I/O, no Date.now, caller-supplied MigrationContext for
 * default timestamps + author.
 *
 * Scope: "Active Projects" H2 only. The "On-Chain Projects" table, the
 * "How to Propose a Project" H2, the "Completed Projects" H2, and the
 * "Lessons Learned" H2 are all skipped — they're prose / metadata, not
 * projects-to-migrate.
 */

import type { BrainProject, ProjectsBrainDoc, ProjectStage } from './brain-projections';
import type { MigrationContext } from './brain-migrate';

const STAGE_WORDS: Record<string, ProjectStage> = {
  propose: 'propose',
  discuss: 'discuss',
  plan: 'plan',
  vote: 'vote',
  execute: 'execute',
  review: 'review',
  ship: 'ship',
};

const ACTIVE_PROJECTS_H2_RE = /^##\s+Active Projects\b/i;
const H2_RE = /^##\s+/;
const H3_RE = /^###\s+/;
const HB_TAG_RE = /\(\s*HB#(\d+)(?:\s*,\s*([^\s)]+))?\s*\)/i;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Extract the "Active Projects" H2 block as a list of lines. Returns
 * an empty array if the section isn't found. Fence-aware (won't split
 * on `### ` inside a code block).
 */
function extractActiveProjectsBlock(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  let inside = false;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      if (inside) out.push(line);
      continue;
    }
    if (!inFence && H2_RE.test(line)) {
      if (ACTIVE_PROJECTS_H2_RE.test(line)) {
        inside = true;
        continue;
      }
      if (inside) break; // Hit the next H2 — end of section.
    }
    if (inside) out.push(line);
  }
  return out;
}

/**
 * Split an Active Projects block into per-project sections keyed by
 * the H3 header. Fence-aware.
 */
function splitProjectSections(lines: string[]): Array<{ header: string; body: string[] }> {
  const sections: Array<{ header: string; body: string[] }> = [];
  let current: { header: string; body: string[] } | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      if (current) current.body.push(line);
      continue;
    }
    if (!inFence && H3_RE.test(line)) {
      if (current) sections.push(current);
      current = { header: line.replace(H3_RE, '').trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * Parse one project's body lines into structured fields. The shape of
 * the hand-written projects.md body is a flat list of bullets, some of
 * which have nested continuation lines and some of which have nested
 * sub-bullets (Discussion / Task Plan). We scan line by line and use
 * the '- **Field**:' prefix as a section marker.
 */
function parseProjectBody(header: string, lines: string[], ctx: MigrationContext): BrainProject {
  const id = slugify(header) || 'project';
  const project: BrainProject = {
    id,
    name: header,
    stage: 'propose', // Default — overwritten if a Stage line is found.
  };

  // Section pointer: tracks which named bullet we're currently
  // accumulating into. 'none' before the first - **X**: bullet.
  type Section = 'none' | 'brief' | 'discussion' | 'taskPlan' | 'proposal' | 'retrospective';
  let section: Section = 'none';
  const accum: Record<Exclude<Section, 'none'>, string[]> = {
    brief: [],
    discussion: [],
    taskPlan: [],
    proposal: [],
    retrospective: [],
  };

  for (const rawLine of lines) {
    const line = rawLine;

    // New bullet — dispatch based on the field name.
    const bulletMatch = /^-\s+\*\*([^*]+)\*\*:?\s*(.*)$/.exec(line);
    if (bulletMatch) {
      const fieldRaw = bulletMatch[1].trim().toLowerCase();
      const rest = bulletMatch[2] ?? '';

      // Stage line — extract value directly; do not push to any section.
      if (fieldRaw === 'stage') {
        const stageWord = rest.trim().toLowerCase().split(/\s+/)[0];
        const normalized = STAGE_WORDS[stageWord as keyof typeof STAGE_WORDS];
        if (normalized) project.stage = normalized;
        section = 'none';
        continue;
      }

      // Proposed by: "<author> (HB#N)"
      if (fieldRaw === 'proposed by') {
        const hb = HB_TAG_RE.exec(rest);
        if (hb) {
          const hbN = Number(hb[1]);
          const authorInTag = hb[2] ?? null;
          project.proposedAtHB = hbN;
          project.proposedBy = authorInTag ?? rest.replace(HB_TAG_RE, '').trim() ?? ctx.defaultAuthor;
          if (ctx.timestampForHB) project.proposedAt = ctx.timestampForHB(hbN);
        } else {
          project.proposedBy = rest.trim() || ctx.defaultAuthor;
        }
        section = 'none';
        continue;
      }

      // Brief — multi-line accumulator.
      if (fieldRaw === 'brief') {
        section = 'brief';
        if (rest.trim()) accum.brief.push(rest.trim());
        continue;
      }

      // Discussion — nested bullets preserved as raw markdown.
      if (fieldRaw === 'discussion') {
        section = 'discussion';
        if (rest.trim()) accum.discussion.push(rest.trim());
        continue;
      }

      // Task plan — same treatment.
      if (fieldRaw === 'task plan') {
        section = 'taskPlan';
        if (rest.trim()) accum.taskPlan.push(rest.trim());
        continue;
      }

      if (fieldRaw === 'proposal') {
        section = 'proposal';
        if (rest.trim()) accum.proposal.push(rest.trim());
        continue;
      }

      if (fieldRaw === 'retrospective') {
        section = 'retrospective';
        if (rest.trim()) accum.retrospective.push(rest.trim());
        continue;
      }

      // Unknown named bullet (e.g. "- **Execution Status**:") — push
      // to the current section as a raw line so nothing is dropped.
      if (section !== 'none') accum[section].push(line);
      continue;
    }

    // Continuation line (indented or bare text). Push to the current
    // section if we're in one; drop otherwise.
    if (section !== 'none' && line.trim() !== '') {
      accum[section].push(line);
    }
  }

  if (accum.brief.length > 0) project.brief = accum.brief.join('\n').trim();
  // Compose discussion + task plan into the taskPlan field as raw
  // markdown for MVP. The structured ProjectDiscussionEntry[] parse
  // is v2 work.
  const discussionMd = accum.discussion.length > 0
    ? '**Discussion (raw)**\n' + accum.discussion.join('\n').trim()
    : '';
  const taskPlanMd = accum.taskPlan.length > 0
    ? '**Task plan (raw)**\n' + accum.taskPlan.join('\n').trim()
    : '';
  const combined = [discussionMd, taskPlanMd].filter(s => s).join('\n\n');
  if (combined) project.taskPlan = combined;

  if (accum.proposal.length > 0) project.proposal = accum.proposal.join('\n').trim();
  if (accum.retrospective.length > 0) project.retrospective = accum.retrospective.join('\n').trim();

  return project;
}

/**
 * Parse projects.md → ProjectsBrainDoc. Pure function.
 *
 * Only looks at the "Active Projects" H2 section. Each H3 becomes a
 * BrainProject with structured stage/proposedBy/proposedAtHB/brief
 * and a raw-markdown taskPlan preserving Discussion + Task Plan
 * content for later structured parsing.
 */
export function parseProjectsMarkdown(raw: string, ctx: MigrationContext): ProjectsBrainDoc {
  const block = extractActiveProjectsBlock(raw);
  const sections = splitProjectSections(block);
  const projects: BrainProject[] = sections.map(s => parseProjectBody(s.header, s.body, ctx));
  return { projects };
}
