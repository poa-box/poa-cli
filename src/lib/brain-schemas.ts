/**
 * Brain doc schemas — write-time shape validation (Task #346, HB#168).
 *
 * Retro #1 change #5: currently applyBrainChange() accepts any doc shape
 * and the projection layer (brain-projections.ts) tolerates bad shapes at
 * read time via formatTimestamp() and schema-tolerant renderers. That
 * approach means bad data enters the doc and stays forever (Automerge
 * field renames are merge hazards per HB#248). This module validates
 * shape at WRITE time so canonically-broken entries never enter the doc.
 *
 * DESIGN:
 * - Per-doc-id validators. pop.brain.shared, pop.brain.projects,
 *   pop.brain.retros each have their own shape. Unknown doc ids return
 *   `{ ok: true, warnings: [...] }` — permissionless schema evolution.
 * - Validators check ITEMS of known arrays for required fields. Extra
 *   fields are allowed (extensibility); missing required fields are errors.
 * - applyBrainChange diffs pre-vs-post validity: if the pre-change doc
 *   was already invalid, the bad state was inherited, not introduced, and
 *   the new write is NOT rejected. Only regressions (valid → invalid) are
 *   rejected. This preserves the constraint "existing bad entries stay
 *   readable" while still preventing new bad writes.
 * - Per-command --allow-invalid-shape bypass lives at the CLI layer and is
 *   plumbed through applyBrainChange's options bag.
 *
 * SCHEMAS ARE DEFINED ONCE HERE and NOT duplicated in the CLI commands.
 */

import type { ProjectStage } from './brain-projections';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Lesson schema used by pop.brain.shared and (historically) pop.brain.lessons.
 * Canonical shape: { id, author, title, body, timestamp, removed? }.
 * Legacy tolerance: `text` is accepted as a synonym for `body`, `ts` for
 * `timestamp` — the projection layer reads both (HB#297 formatTimestamp).
 * A lesson must have at least one of {body, text} AND at least one of
 * {title, id}. That's the minimum renderable shape.
 */
function validateLesson(lesson: any, index: number, errors: string[]): void {
  if (lesson == null || typeof lesson !== 'object') {
    errors.push(`lessons[${index}]: not an object`);
    return;
  }
  const hasBody =
    (typeof lesson.body === 'string' && lesson.body.length > 0) ||
    (typeof lesson.text === 'string' && lesson.text.length > 0);
  if (!hasBody) {
    errors.push(`lessons[${index}]: missing required body/text (one must be a non-empty string)`);
  }
  const hasTitle =
    (typeof lesson.title === 'string' && lesson.title.length > 0) ||
    (typeof lesson.id === 'string' && lesson.id.length > 0);
  if (!hasTitle) {
    errors.push(`lessons[${index}]: missing required title/id (one must be a non-empty string)`);
  }
  if (lesson.timestamp != null && lesson.ts != null) {
    // Not an error; just unusual. Don't warn noisily.
  }
  if (
    lesson.timestamp != null &&
    typeof lesson.timestamp !== 'number' &&
    typeof lesson.timestamp !== 'string'
  ) {
    errors.push(`lessons[${index}]: timestamp must be number or ISO string`);
  }
  // Task #347: optional tags field. Must be an array of strings when present.
  // Backwards compatible: existing lessons without tags still validate.
  // Tag vocabulary is free-form — no enforcement of category:/topic:/etc.
  if (lesson.tags != null) {
    if (!Array.isArray(lesson.tags)) {
      errors.push(`lessons[${index}]: tags must be an array of strings`);
    } else {
      for (let i = 0; i < lesson.tags.length; i++) {
        if (typeof lesson.tags[i] !== 'string') {
          errors.push(`lessons[${index}]: tags[${i}] must be a string`);
        }
      }
    }
  }
  // Task #509: optional causedBy field. Single string (single-parent) or
  // array of strings (multi-parent — synthesis integrating multiple priors).
  // Each entry must be a non-empty string lesson id. Backwards compatible:
  // existing lessons without causedBy validate unchanged.
  if (lesson.causedBy != null) {
    const cb = lesson.causedBy;
    if (typeof cb === 'string') {
      if (cb.length === 0) {
        errors.push(`lessons[${index}]: causedBy must be a non-empty string id`);
      }
    } else if (Array.isArray(cb)) {
      for (let i = 0; i < cb.length; i++) {
        if (typeof cb[i] !== 'string' || cb[i].length === 0) {
          errors.push(`lessons[${index}]: causedBy[${i}] must be a non-empty string id`);
        }
      }
    } else {
      errors.push(`lessons[${index}]: causedBy must be a string or array of strings`);
    }
  }
}

function validateRule(rule: any, index: number, errors: string[]): void {
  if (rule == null || typeof rule !== 'object') {
    errors.push(`rules[${index}]: not an object`);
    return;
  }
  if (typeof rule.text !== 'string' || rule.text.length === 0) {
    errors.push(`rules[${index}]: missing required text (non-empty string)`);
  }
}

/**
 * pop.brain.shared — lessons + rules + operatingConstraints + orgState.
 * Arrays are optional (first-write bootstrap) but when present their items
 * must validate.
 */
function validateSharedDoc(doc: any, errors: string[], warnings: string[]): void {
  if (doc == null || typeof doc !== 'object') {
    errors.push('pop.brain.shared: doc is not an object');
    return;
  }
  if (doc.lessons != null) {
    if (!Array.isArray(doc.lessons)) {
      errors.push('pop.brain.shared: lessons must be an array');
    } else {
      doc.lessons.forEach((l: any, i: number) => validateLesson(l, i, errors));
    }
  }
  if (doc.rules != null) {
    if (!Array.isArray(doc.rules)) {
      errors.push('pop.brain.shared: rules must be an array');
    } else {
      doc.rules.forEach((r: any, i: number) => validateRule(r, i, errors));
    }
  }
  if (doc.operatingConstraints != null && !Array.isArray(doc.operatingConstraints)) {
    errors.push('pop.brain.shared: operatingConstraints must be an array');
  }
  if (doc.orgState != null && typeof doc.orgState !== 'object') {
    errors.push('pop.brain.shared: orgState must be an object');
  }
  void warnings;
}

// HB#183 (lesson cross-module-enum-drift): the source of truth for the
// project lifecycle stages is the ProjectStage union type in
// src/lib/brain-projections.ts. We MUST NOT retype the values here —
// drift between the schema and the projection breaks at runtime
// (HB#180 incident: schema enum was {proposed, building, ...},
// canonical was {propose, discuss, ...}, validator rejected legitimate
// new-project writes). The literal-array-as-type pattern below lets
// TypeScript keep both the runtime Set and the union type in sync from
// one declaration. If the canonical lifecycle ever changes,
// brain-projections.ts ProjectStage stays the source of truth — update
// that union, then update PROJECT_STAGES here in lockstep, and the
// vitest "accepts all canonical lifecycle stages" case fails loudly
// if drift creeps back in.
// The literal tuple is what gives us a runtime Set; the satisfies clause
// below proves at compile time that this list is structurally identical
// to the ProjectStage union from brain-projections. If brain-projections
// adds or removes a stage and this list isn't updated, tsc fails the
// build at the satisfies line — drift is impossible.
const PROJECT_STAGES = ['propose', 'discuss', 'plan', 'vote', 'execute', 'review', 'ship'] as const;
// Compile-time bidirectional drift check.
// Direction 1 (literal → union): every literal in PROJECT_STAGES must
// be a valid ProjectStage. tsc fails if you add a typo to the tuple.
const _stagesAreValid: readonly ProjectStage[] = PROJECT_STAGES;
// Direction 2 (union → literal): every member of ProjectStage must
// appear in PROJECT_STAGES. tsc fails if brain-projections adds a new
// stage and this tuple isn't updated. The conditional-type trick
// reduces to `true` only when the two sets are structurally equal.
type _StagesMatchUnion = [ProjectStage] extends [typeof PROJECT_STAGES[number]] ? true : false;
const _stagesMatchUnion: _StagesMatchUnion = true;
void _stagesAreValid;
void _stagesMatchUnion;
const VALID_PROJECT_STAGES: ReadonlySet<ProjectStage> = new Set(PROJECT_STAGES);

function validateProject(p: any, index: number, errors: string[]): void {
  if (p == null || typeof p !== 'object') {
    errors.push(`projects[${index}]: not an object`);
    return;
  }
  if (typeof p.id !== 'string' || p.id.length === 0) {
    errors.push(`projects[${index}]: missing required id (non-empty string)`);
  }
  if (typeof p.name !== 'string' || p.name.length === 0) {
    errors.push(`projects[${index}]: missing required name (non-empty string)`);
  }
  if (typeof p.stage !== 'string' || !VALID_PROJECT_STAGES.has(p.stage)) {
    errors.push(
      `projects[${index}]: stage must be one of ${[...VALID_PROJECT_STAGES].join('|')}, got ${JSON.stringify(p.stage)}`,
    );
  }
}

function validateProjectsDoc(doc: any, errors: string[]): void {
  if (doc == null || typeof doc !== 'object') {
    errors.push('pop.brain.projects: doc is not an object');
    return;
  }
  if (doc.projects != null) {
    if (!Array.isArray(doc.projects)) {
      errors.push('pop.brain.projects: projects must be an array');
    } else {
      doc.projects.forEach((p: any, i: number) => validateProject(p, i, errors));
    }
  }
}

function validateRetro(r: any, index: number, errors: string[]): void {
  if (r == null || typeof r !== 'object') {
    errors.push(`retros[${index}]: not an object`);
    return;
  }
  if (typeof r.id !== 'string' || r.id.length === 0) {
    errors.push(`retros[${index}]: missing required id`);
  }
  if (r.proposedChanges != null && !Array.isArray(r.proposedChanges)) {
    errors.push(`retros[${index}]: proposedChanges must be an array`);
  }
  if (r.discussion != null && !Array.isArray(r.discussion)) {
    errors.push(`retros[${index}]: discussion must be an array`);
  }
}

function validateRetrosDoc(doc: any, errors: string[]): void {
  if (doc == null || typeof doc !== 'object') {
    errors.push('pop.brain.retros: doc is not an object');
    return;
  }
  if (doc.retros != null) {
    if (!Array.isArray(doc.retros)) {
      errors.push('pop.brain.retros: retros must be an array');
    } else {
      doc.retros.forEach((r: any, i: number) => validateRetro(r, i, errors));
    }
  }
}

// --- pop.brain.brainstorms (task #354 phase a, HB#207) -------------
//
// Brainstorms are a forward-looking cross-agent ideation surface:
// { id, title, prompt, author, status, ideas[], window, removed? }.
// Distinct from pop.brain.retros (reactive session retrospectives)
// and pop.brain.projects (lifecycle state machine) — this doc is
// where new questions get posted, ideas get debated + voted, and
// top-ranked ideas get promoted to pop.brain.projects at the propose
// stage. See docs/brain-layer-setup.md and the #354 task description
// for the full lifecycle.
const VALID_BRAINSTORM_STATUSES = ['open', 'voting', 'closed', 'promoted'] as const;
type BrainstormStatus = typeof VALID_BRAINSTORM_STATUSES[number];
const VALID_BRAINSTORM_STATUS_SET: ReadonlySet<BrainstormStatus> = new Set(VALID_BRAINSTORM_STATUSES);

const VALID_VOTE_STANCES = ['support', 'explore', 'oppose'] as const;
type IdeaVoteStance = typeof VALID_VOTE_STANCES[number];
const VALID_VOTE_STANCE_SET: ReadonlySet<IdeaVoteStance> = new Set(VALID_VOTE_STANCES);

function validateIdea(idea: any, brainstormId: string, ideaIndex: number, errors: string[]): void {
  if (idea == null || typeof idea !== 'object') {
    errors.push(`brainstorms[${brainstormId}].ideas[${ideaIndex}]: not an object`);
    return;
  }
  if (typeof idea.id !== 'string' || idea.id.length === 0) {
    errors.push(`brainstorms[${brainstormId}].ideas[${ideaIndex}]: missing required id`);
  }
  if (typeof idea.message !== 'string' || idea.message.length === 0) {
    errors.push(`brainstorms[${brainstormId}].ideas[${ideaIndex}]: missing required message`);
  }
  if (idea.author != null && typeof idea.author !== 'string') {
    errors.push(`brainstorms[${brainstormId}].ideas[${ideaIndex}]: author must be a string when present`);
  }
  if (idea.votes != null) {
    if (typeof idea.votes !== 'object' || Array.isArray(idea.votes)) {
      errors.push(`brainstorms[${brainstormId}].ideas[${ideaIndex}]: votes must be an object keyed by agent address`);
    } else {
      for (const [addr, stance] of Object.entries(idea.votes)) {
        if (typeof stance !== 'string' || !VALID_VOTE_STANCE_SET.has(stance as IdeaVoteStance)) {
          errors.push(
            `brainstorms[${brainstormId}].ideas[${ideaIndex}].votes[${addr}]: stance must be one of ${[...VALID_VOTE_STANCES].join('|')}, got ${JSON.stringify(stance)}`,
          );
        }
      }
    }
  }
  if (idea.priority != null && !['high', 'medium', 'low'].includes(idea.priority)) {
    errors.push(`brainstorms[${brainstormId}].ideas[${ideaIndex}]: priority must be high|medium|low when present`);
  }
}

function validateBrainstorm(b: any, index: number, errors: string[]): void {
  if (b == null || typeof b !== 'object') {
    errors.push(`brainstorms[${index}]: not an object`);
    return;
  }
  const bid = b.id ?? `<index ${index}>`;
  if (typeof b.id !== 'string' || b.id.length === 0) {
    errors.push(`brainstorms[${index}]: missing required id`);
  }
  if (typeof b.title !== 'string' || b.title.length === 0) {
    errors.push(`brainstorms[${bid}]: missing required title`);
  }
  if (typeof b.status !== 'string' || !VALID_BRAINSTORM_STATUS_SET.has(b.status as BrainstormStatus)) {
    errors.push(
      `brainstorms[${bid}]: status must be one of ${[...VALID_BRAINSTORM_STATUSES].join('|')}, got ${JSON.stringify(b.status)}`,
    );
  }
  if (b.ideas != null) {
    if (!Array.isArray(b.ideas)) {
      errors.push(`brainstorms[${bid}]: ideas must be an array`);
    } else {
      b.ideas.forEach((idea: any, i: number) => validateIdea(idea, bid, i, errors));
    }
  }
  if (b.promotedToProjectIds != null && !Array.isArray(b.promotedToProjectIds)) {
    errors.push(`brainstorms[${bid}]: promotedToProjectIds must be an array`);
  }
}

function validateBrainstormsDoc(doc: any, errors: string[]): void {
  if (doc == null || typeof doc !== 'object') {
    errors.push('pop.brain.brainstorms: doc is not an object');
    return;
  }
  if (doc.brainstorms != null) {
    if (!Array.isArray(doc.brainstorms)) {
      errors.push('pop.brain.brainstorms: brainstorms must be an array');
    } else {
      doc.brainstorms.forEach((b: any, i: number) => validateBrainstorm(b, i, errors));
    }
  }
}

/**
 * Task #448 pt1 — pop.brain.peers shape:
 *   { peers: { [peerIdBase58: string]: {
 *       multiaddrs: string[],    // at least one entry
 *       lastSeen: number,        // unix seconds
 *       username?: string        // optional operator tag
 *   } } }
 * PeerId keys are libp2p base58 strings; we don't validate their exact
 * format here (libp2p parses on dial and rejects malformed).
 */
function validatePeersDoc(doc: any, errors: string[]): void {
  if (!doc || typeof doc !== 'object') {
    errors.push('pop.brain.peers: root must be an object');
    return;
  }
  if (doc.peers === undefined) {
    // Empty-on-first-write is fine — doc.peers gets populated lazily.
    return;
  }
  if (typeof doc.peers !== 'object' || Array.isArray(doc.peers)) {
    errors.push('pop.brain.peers: peers must be a keyed object');
    return;
  }
  for (const [peerId, entry] of Object.entries(doc.peers)) {
    if (typeof peerId !== 'string' || peerId.length === 0) {
      errors.push(`pop.brain.peers: empty peerId key`);
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      errors.push(`pop.brain.peers[${peerId}]: entry must be an object`);
      continue;
    }
    const e: any = entry;
    if (!Array.isArray(e.multiaddrs)) {
      errors.push(`pop.brain.peers[${peerId}]: multiaddrs must be an array`);
    } else if (e.multiaddrs.length === 0) {
      errors.push(`pop.brain.peers[${peerId}]: multiaddrs must not be empty`);
    } else {
      for (let i = 0; i < e.multiaddrs.length; i++) {
        if (typeof e.multiaddrs[i] !== 'string') {
          errors.push(`pop.brain.peers[${peerId}].multiaddrs[${i}]: not a string`);
        }
      }
    }
    if (typeof e.lastSeen !== 'number' || !Number.isFinite(e.lastSeen)) {
      errors.push(`pop.brain.peers[${peerId}]: lastSeen must be a number`);
    }
    if (e.username !== undefined && typeof e.username !== 'string') {
      errors.push(`pop.brain.peers[${peerId}]: username must be a string if present`);
    }
  }
}

/**
 * Dispatch entry point. Returns { ok, errors, warnings }. Unknown doc ids
 * are permitted (schema evolution) with a warning, not an error.
 */
export function validateBrainDocShape(docId: string, doc: any): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  switch (docId) {
    case 'pop.brain.shared':
    case 'pop.brain.lessons':
      validateSharedDoc(doc, errors, warnings);
      break;
    case 'pop.brain.projects':
      validateProjectsDoc(doc, errors);
      break;
    case 'pop.brain.retros':
      validateRetrosDoc(doc, errors);
      break;
    case 'pop.brain.brainstorms':
      validateBrainstormsDoc(doc, errors);
      break;
    case 'pop.brain.peers':
      validatePeersDoc(doc, errors);
      break;
    default:
      warnings.push(
        `unknown doc id "${docId}" — no schema registered, accepting any shape. ` +
          `Add a validator to src/lib/brain-schemas.ts to enforce one.`,
      );
  }

  return { ok: errors.length === 0, errors, warnings };
}
