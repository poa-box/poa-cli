/**
 * Unified brain write dispatcher (HB#324 principal-engineer ship-2).
 *
 * ## Why this module exists
 *
 * Before this module, every brain write command (append-lesson, edit-lesson,
 * remove-lesson, new-project, advance-stage, remove-project, …) called
 * `applyBrainChange` directly with a closure. That works fine in-process but
 * cannot be routed through IPC to a running daemon — closures don't serialize.
 *
 * The brain daemon needs to be the single owner of libp2p/gossipsub when it's
 * running (HB#312 dogfood wedge proved sequential agent sessions never overlap
 * in wall-clock time, so a short-lived in-process libp2p can't reliably
 * deliver a gossipsub announcement before exiting). For the daemon to be
 * useful, every write has to route through it. For the daemon to be usable,
 * the CLI commands need a transparent fallback when no daemon is running.
 *
 * The solution is to turn every brain write into a pure-data operation
 * descriptor (`BrainOp`) and have two execution paths that share zero
 * business logic:
 *
 *   `dispatchOp(op)`      Runs the op in the current process. Used by:
 *                         (a) the daemon's IPC handler, and
 *                         (b) CLI commands as a fallback when no daemon.
 *   `routedDispatch(op)`  Entry point for CLI commands. Checks for a running
 *                         daemon: if yes, sends `applyOp` via IPC; if no,
 *                         calls dispatchOp locally.
 *
 * Both paths converge on the same `dispatchOp` function. There is no
 * "local" vs "routed" business logic — only a transport decision.
 *
 * ## Fallback correctness (important)
 *
 * `routedDispatch` must be careful about when it falls back to local
 * dispatch. If the daemon has already processed the write and only the
 * *response* got lost, a silent local fallback causes a double-write.
 *
 * The rule:
 *   - Pre-connect IPC failure (ECONNREFUSED, ENOENT, daemon not running at
 *     all) → SAFE to fall back. The write definitely did not land in the
 *     daemon's process because we never opened the connection.
 *   - Post-connect IPC failure (ECONNRESET, EPIPE, timeout mid-call) → NOT
 *     safe. The daemon may have processed the write. Error out and let the
 *     operator decide.
 *
 * This is the opposite of retry-everything semantics, on purpose. Brain
 * writes are append-mostly and deduplication is hard once the block lands.
 *
 * ## Adding a new op
 *
 *   1. Add the variant to the `BrainOp` discriminated union below.
 *   2. Add the case to `dispatchOp`'s switch statement.
 *   3. Replace the `applyBrainChange(doc, closure)` call in your command
 *      with `routedDispatch({type: 'yourOp', ...})`.
 *
 * The daemon's IPC handler is a one-line `return dispatchOp(params.op)` —
 * it does not need to be updated for new ops.
 */

import { applyBrainChange } from './brain';
import { getRunningDaemonPid, sendIpcRequest, BrainIpcError } from './brain-daemon';

// ---------------------------------------------------------------------------
// Op descriptors
// ---------------------------------------------------------------------------

export interface AppendLessonOp {
  type: 'appendLesson';
  docId: string;
  id: string;
  title: string;
  body: string;
  author: string;
  timestamp: number;
  /** Task #346: bypass write-time schema validation. Default false (strict). */
  allowInvalidShape?: boolean;
}

export interface EditLessonOp {
  type: 'editLesson';
  docId: string;
  lessonId: string;
  fields: {
    title?: string;
    body?: string;
    author?: string;
  };
  /** Bump the lesson's timestamp to now(), even when no fields change. */
  touch: boolean;
  /** Task #346: bypass write-time schema validation. Default false (strict). */
  allowInvalidShape?: boolean;
}

export interface RemoveLessonOp {
  type: 'removeLesson';
  docId: string;
  lessonId: string;
  removedBy: string;
  removedAt: number;
  removedReason?: string;
  /** Task #346: bypass write-time schema validation. Default false (strict). */
  allowInvalidShape?: boolean;
}

export interface NewProjectOp {
  type: 'newProject';
  docId: string;
  projectId: string;
  /** Display name — matches the `name` field on the stored project object. */
  name: string;
  /** Optional short-form brief; omitted field when undefined. */
  brief?: string;
  /** Starting lifecycle stage (propose / discuss / plan / vote / execute / review / ship). */
  stage: string;
  /** Proposer label — default is lowercased wallet address. */
  proposedBy: string;
  /** Unix seconds — recorded as `proposedAt` on the stored project. */
  proposedAt: number;
}

export interface AdvanceStageOp {
  type: 'advanceStage';
  docId: string;
  projectId: string;
  /** New lifecycle stage. */
  newStage: string;
  /** Unix seconds — recorded as `lastStageAdvanceAt` on the project. */
  lastStageAdvanceAt: number;
}

export interface RemoveProjectOp {
  type: 'removeProject';
  docId: string;
  projectId: string;
  removedBy: string;
  removedAt: number;
  removedReason?: string;
}

// --- Retros (task #344) ------------------------------------------------

export interface RetroChangeInput {
  id: string;
  summary: string;
  details?: string;
  status?: 'proposed' | 'agreed' | 'modified' | 'rejected' | 'filed';
}

export interface StartRetroOp {
  type: 'startRetro';
  docId: string;
  retroId: string;
  author: string;
  /** HB number when the retro was started. */
  hb: number;
  window: { from: number; to: number };
  observations: {
    worked?: string;
    didntWork?: string;
  };
  proposedChanges: RetroChangeInput[];
  createdAt: number;
}

export interface RespondToRetroOp {
  type: 'respondToRetro';
  docId: string;
  retroId: string;
  author: string;
  hb?: number;
  message: string;
  votePerChange?: Record<string, 'agree' | 'modify' | 'reject'>;
  timestamp: number;
}

export interface UpdateChangeStatusOp {
  type: 'updateChangeStatus';
  docId: string;
  retroId: string;
  changeId: string;
  newStatus: 'proposed' | 'agreed' | 'modified' | 'rejected' | 'filed';
  filedTaskId?: string;
}

export interface RemoveRetroOp {
  type: 'removeRetro';
  docId: string;
  retroId: string;
  removedBy: string;
  removedAt: number;
  removedReason?: string;
}

// --- Tags (task #347) -------------------------------------------------

export interface TagLessonOp {
  type: 'tagLesson';
  docId: string;
  lessonId: string;
  addTags: string[];
  removeTags: string[];
  /** Task #346: bypass write-time schema validation. Default false (strict). */
  allowInvalidShape?: boolean;
}

// --- Brainstorms (task #354 phase b, HB#208) -------------------------
//
// Forward-looking cross-agent ideation surface. See src/lib/brain-schemas.ts
// validateBrainstormsDoc for the doc shape.

export interface StartBrainstormOp {
  type: 'startBrainstorm';
  docId: string;
  brainstormId: string;
  title: string;
  prompt: string;
  author: string;
  openedAt: number;
  windowFromHB?: number;
  windowToHB?: number;
}

export interface RespondToBrainstormOp {
  type: 'respondToBrainstorm';
  docId: string;
  brainstormId: string;
  author: string;
  /** Message posted by the responding agent. Plain string, no schema. */
  message?: string;
  /** New idea to add to the brainstorm's ideas list. */
  addIdea?: { id: string; message: string };
  /** Map of idea id → stance (support/explore/oppose). Merges into existing votes without overwriting other agents' votes. */
  votes?: Record<string, 'support' | 'explore' | 'oppose'>;
  timestamp: number;
}

export interface PromoteIdeaOp {
  type: 'promoteIdea';
  docId: string;
  brainstormId: string;
  ideaId: string;
  /** The pop.brain.projects id to link to after promotion. Caller creates the project separately via newProject; this op just records the back-reference. */
  promotedProjectId: string;
  promotedBy: string;
  promotedAt: number;
}

export interface CloseBrainstormOp {
  type: 'closeBrainstorm';
  docId: string;
  brainstormId: string;
  closedBy: string;
  closedAt: number;
  /** Free-form reason for the close. */
  reason?: string;
}

export interface RemoveBrainstormOp {
  type: 'removeBrainstorm';
  docId: string;
  brainstormId: string;
  removedBy: string;
  removedAt: number;
  removedReason?: string;
}

export type BrainOp =
  | AppendLessonOp
  | EditLessonOp
  | RemoveLessonOp
  | NewProjectOp
  | AdvanceStageOp
  | RemoveProjectOp
  | StartRetroOp
  | RespondToRetroOp
  | UpdateChangeStatusOp
  | RemoveRetroOp
  | TagLessonOp
  | StartBrainstormOp
  | RespondToBrainstormOp
  | PromoteIdeaOp
  | CloseBrainstormOp
  | RemoveBrainstormOp;

export interface DispatchResult {
  headCid: string;
  /** The Ethereum address that signed the envelope (from POP_PRIVATE_KEY). */
  envelopeAuthor: string;
  /** True iff the op was routed through a running brain daemon. */
  routedViaDaemon: boolean;
}

// ---------------------------------------------------------------------------
// Local dispatch — runs in the current process
// ---------------------------------------------------------------------------

/**
 * Apply a BrainOp in the current process. Translates the op descriptor to
 * the corresponding Automerge change function and calls `applyBrainChange`,
 * which signs the envelope, writes the block, updates the manifest, and
 * publishes the new head CID via gossipsub.
 *
 * Same function is called from two places:
 *   - The daemon's `applyOp` IPC handler (when a CLI routed a write)
 *   - The CLI's `routedDispatch` fallback (when no daemon is running)
 *
 * Errors thrown from the change function propagate out as normal Error
 * instances. For example, editLesson throws if the target lesson id is
 * missing.
 */
export async function dispatchOp(op: BrainOp): Promise<DispatchResult> {
  let applied: { headCid: string; author: string; doc: any };

  switch (op.type) {
    case 'appendLesson': {
      applied = await applyBrainChange(
        op.docId,
        (doc: any) => {
          if (!Array.isArray(doc.lessons)) doc.lessons = [];
          doc.lessons.push({
            id: op.id,
            title: op.title,
            author: op.author,
            body: op.body,
            timestamp: op.timestamp,
          });
        },
        { allowInvalidShape: op.allowInvalidShape },
      );
      break;
    }

    case 'editLesson': {
      applied = await applyBrainChange(
        op.docId,
        (doc: any) => {
          if (!Array.isArray(doc.lessons)) {
            throw new Error(`no lessons list in doc ${op.docId}`);
          }
          const lesson = doc.lessons.find((l: any) => l && l.id === op.lessonId);
          if (!lesson) {
            throw new Error(`lesson ${op.lessonId} not found in ${op.docId}`);
          }
          if (op.fields.title !== undefined) lesson.title = op.fields.title;
          if (op.fields.body !== undefined) lesson.body = op.fields.body;
          if (op.fields.author !== undefined) lesson.author = op.fields.author;
          if (op.touch) lesson.timestamp = Math.floor(Date.now() / 1000);
        },
        { allowInvalidShape: op.allowInvalidShape },
      );
      break;
    }

    case 'removeLesson': {
      applied = await applyBrainChange(
        op.docId,
        (doc: any) => {
          if (!Array.isArray(doc.lessons)) {
            throw new Error(`no lessons list in doc ${op.docId}`);
          }
          const lesson = doc.lessons.find((l: any) => l && l.id === op.lessonId);
          if (!lesson) {
            throw new Error(`lesson ${op.lessonId} not found in ${op.docId}`);
          }
          // Soft-delete tombstone — see brain-projections.ts filter logic.
          lesson.removed = true;
          lesson.removedAt = op.removedAt;
          lesson.removedBy = op.removedBy;
          if (op.removedReason) lesson.removedReason = op.removedReason;
        },
        { allowInvalidShape: op.allowInvalidShape },
      );
      break;
    }

    case 'newProject': {
      applied = await applyBrainChange(op.docId, (doc: any) => {
        if (!Array.isArray(doc.projects)) doc.projects = [];
        // Collision check — upstream should have resolved with slug + suffix,
        // but we defend here because routedDispatch is the last line before
        // applyBrainChange.
        if (doc.projects.some((p: any) => p && p.id === op.projectId)) {
          throw new Error(`project id ${op.projectId} already exists in ${op.docId}`);
        }
        const entry: any = {
          id: op.projectId,
          name: op.name,
          stage: op.stage,
          proposedBy: op.proposedBy,
          proposedAt: op.proposedAt,
        };
        if (op.brief !== undefined && op.brief !== '') entry.brief = op.brief;
        doc.projects.push(entry);
      });
      break;
    }

    case 'advanceStage': {
      applied = await applyBrainChange(op.docId, (doc: any) => {
        if (!Array.isArray(doc.projects)) {
          throw new Error(`no projects list in doc ${op.docId}`);
        }
        const idx = doc.projects.findIndex((p: any) => p && p.id === op.projectId);
        if (idx === -1) {
          throw new Error(`project ${op.projectId} not found in ${op.docId}`);
        }
        const project = doc.projects[idx];
        if (project.removed) {
          throw new Error(`project ${op.projectId} is tombstoned — cannot advance`);
        }
        project.stage = op.newStage;
        project.lastStageAdvanceAt = op.lastStageAdvanceAt;
      });
      break;
    }

    case 'removeProject': {
      applied = await applyBrainChange(op.docId, (doc: any) => {
        if (!Array.isArray(doc.projects)) {
          throw new Error(`no projects list in doc ${op.docId}`);
        }
        const project = doc.projects.find((p: any) => p && p.id === op.projectId);
        if (!project) {
          throw new Error(`project ${op.projectId} not found in ${op.docId}`);
        }
        project.removed = true;
        project.removedAt = op.removedAt;
        project.removedBy = op.removedBy;
        if (op.removedReason) project.removedReason = op.removedReason;
      });
      break;
    }

    case 'startRetro': {
      applied = await applyBrainChange(op.docId, (doc: any) => {
        if (!Array.isArray(doc.retros)) doc.retros = [];
        if (doc.retros.some((r: any) => r && r.id === op.retroId)) {
          throw new Error(`retro id ${op.retroId} already exists in ${op.docId}`);
        }
        // Schema validation at write time (task constraint).
        if (!op.author) throw new Error('startRetro: author is required');
        if (!op.window || typeof op.window.from !== 'number' || typeof op.window.to !== 'number') {
          throw new Error('startRetro: window.from and window.to are required numbers');
        }
        if (op.window.to < op.window.from) {
          throw new Error(`startRetro: window.to (${op.window.to}) must be >= window.from (${op.window.from})`);
        }
        if (!Array.isArray(op.proposedChanges)) {
          throw new Error('startRetro: proposedChanges must be an array');
        }
        // Enforce unique change ids within a retro.
        const seenIds = new Set<string>();
        for (const change of op.proposedChanges) {
          if (!change.id || !change.summary) {
            throw new Error('startRetro: each proposed change requires id and summary');
          }
          if (seenIds.has(change.id)) {
            throw new Error(`startRetro: duplicate change id "${change.id}"`);
          }
          seenIds.add(change.id);
        }

        const entry: any = {
          id: op.retroId,
          author: op.author,
          hb: op.hb,
          window: { from: op.window.from, to: op.window.to },
          observations: {},
          proposedChanges: op.proposedChanges.map(c => {
            const out: any = {
              id: c.id,
              summary: c.summary,
              status: c.status ?? 'proposed',
            };
            if (c.details !== undefined && c.details !== '') out.details = c.details;
            return out;
          }),
          discussion: [],
          status: 'open',
          createdAt: op.createdAt,
        };
        if (op.observations.worked !== undefined && op.observations.worked !== '') {
          entry.observations.worked = op.observations.worked;
        }
        if (op.observations.didntWork !== undefined && op.observations.didntWork !== '') {
          entry.observations.didntWork = op.observations.didntWork;
        }
        doc.retros.push(entry);
      });
      break;
    }

    case 'respondToRetro': {
      applied = await applyBrainChange(op.docId, (doc: any) => {
        if (!Array.isArray(doc.retros)) {
          throw new Error(`no retros list in doc ${op.docId}`);
        }
        const retro = doc.retros.find((r: any) => r && r.id === op.retroId);
        if (!retro) {
          throw new Error(`retro ${op.retroId} not found in ${op.docId}`);
        }
        if (retro.removed) {
          throw new Error(`retro ${op.retroId} is tombstoned — cannot respond`);
        }
        if (!Array.isArray(retro.discussion)) retro.discussion = [];
        // Validate votes refer to real change ids if provided.
        if (op.votePerChange) {
          const changeIds = new Set(
            (retro.proposedChanges ?? []).map((c: any) => c?.id).filter((id: any) => typeof id === 'string'),
          );
          for (const changeId of Object.keys(op.votePerChange)) {
            if (!changeIds.has(changeId)) {
              throw new Error(
                `respondToRetro: vote references unknown change id "${changeId}" ` +
                `(retro has: ${Array.from(changeIds).join(', ') || '(none)'})`,
              );
            }
          }
        }
        const entry: any = {
          author: op.author,
          message: op.message,
          timestamp: op.timestamp,
        };
        if (op.hb !== undefined) entry.hb = op.hb;
        if (op.votePerChange && Object.keys(op.votePerChange).length > 0) {
          entry.votePerChange = { ...op.votePerChange };
        }
        retro.discussion.push(entry);
        // Advance retro.status to 'discussed' on first response.
        if (retro.status === 'open') retro.status = 'discussed';
      });
      break;
    }

    case 'updateChangeStatus': {
      applied = await applyBrainChange(op.docId, (doc: any) => {
        if (!Array.isArray(doc.retros)) {
          throw new Error(`no retros list in doc ${op.docId}`);
        }
        const retro = doc.retros.find((r: any) => r && r.id === op.retroId);
        if (!retro) {
          throw new Error(`retro ${op.retroId} not found in ${op.docId}`);
        }
        if (!Array.isArray(retro.proposedChanges)) {
          throw new Error(`retro ${op.retroId} has no proposedChanges list`);
        }
        const change = retro.proposedChanges.find((c: any) => c && c.id === op.changeId);
        if (!change) {
          throw new Error(
            `change ${op.changeId} not found in retro ${op.retroId} ` +
            `(available: ${retro.proposedChanges.map((c: any) => c?.id).join(', ')})`,
          );
        }
        change.status = op.newStatus;
        if (op.newStatus === 'filed' && op.filedTaskId) {
          change.filedTaskId = op.filedTaskId;
        }
        // If all changes are filed or rejected, mark the retro as shipped.
        const stillOpen = retro.proposedChanges.some((c: any) =>
          c && c.status !== 'filed' && c.status !== 'rejected',
        );
        if (!stillOpen) {
          retro.status = 'shipped';
          retro.closedAt = Math.floor(Date.now() / 1000);
        }
      });
      break;
    }

    case 'removeRetro': {
      applied = await applyBrainChange(op.docId, (doc: any) => {
        if (!Array.isArray(doc.retros)) {
          throw new Error(`no retros list in doc ${op.docId}`);
        }
        const retro = doc.retros.find((r: any) => r && r.id === op.retroId);
        if (!retro) {
          throw new Error(`retro ${op.retroId} not found in ${op.docId}`);
        }
        retro.removed = true;
        retro.removedAt = op.removedAt;
        retro.removedBy = op.removedBy;
        if (op.removedReason) retro.removedReason = op.removedReason;
      });
      break;
    }

    case 'tagLesson': {
      applied = await applyBrainChange(
        op.docId,
        (doc: any) => {
          if (!Array.isArray(doc.lessons)) {
            throw new Error(`no lessons list in doc ${op.docId}`);
          }
          const lesson = doc.lessons.find((l: any) => l && l.id === op.lessonId);
          if (!lesson) {
            throw new Error(`lesson ${op.lessonId} not found in ${op.docId}`);
          }
          if (!Array.isArray(lesson.tags)) lesson.tags = [];
          for (const t of op.addTags) {
            if (!lesson.tags.includes(t)) lesson.tags.push(t);
          }
          for (const t of op.removeTags) {
            const idx = lesson.tags.indexOf(t);
            if (idx >= 0) lesson.tags.splice(idx, 1);
          }
        },
        { allowInvalidShape: op.allowInvalidShape },
      );
      break;
    }

    // --- Brainstorms (task #354 phase b, HB#208) ----------------------

    case 'startBrainstorm': {
      applied = await applyBrainChange(op.docId, (doc: any) => {
        if (!Array.isArray(doc.brainstorms)) doc.brainstorms = [];
        if (doc.brainstorms.some((b: any) => b && b.id === op.brainstormId)) {
          throw new Error(`brainstorm ${op.brainstormId} already exists in ${op.docId}`);
        }
        const entry: any = {
          id: op.brainstormId,
          title: op.title,
          prompt: op.prompt,
          author: op.author,
          openedAt: op.openedAt,
          status: 'open',
          ideas: [],
        };
        if (op.windowFromHB != null || op.windowToHB != null) {
          entry.window = {};
          if (op.windowFromHB != null) entry.window.from = op.windowFromHB;
          if (op.windowToHB != null) entry.window.to = op.windowToHB;
        }
        doc.brainstorms.push(entry);
      });
      break;
    }

    case 'respondToBrainstorm': {
      applied = await applyBrainChange(op.docId, (doc: any) => {
        if (!Array.isArray(doc.brainstorms)) {
          throw new Error(`no brainstorms list in doc ${op.docId}`);
        }
        const brainstorm = doc.brainstorms.find((b: any) => b && b.id === op.brainstormId);
        if (!brainstorm) {
          throw new Error(`brainstorm ${op.brainstormId} not found in ${op.docId}`);
        }
        if (brainstorm.removed || brainstorm.status === 'closed') {
          throw new Error(`brainstorm ${op.brainstormId} is ${brainstorm.removed ? 'removed' : 'closed'} — cannot respond`);
        }
        if (!Array.isArray(brainstorm.ideas)) brainstorm.ideas = [];

        // Add a new idea if requested
        if (op.addIdea) {
          if (brainstorm.ideas.some((i: any) => i && i.id === op.addIdea!.id)) {
            throw new Error(`idea ${op.addIdea.id} already exists in brainstorm ${op.brainstormId}`);
          }
          brainstorm.ideas.push({
            id: op.addIdea.id,
            author: op.author,
            message: op.addIdea.message,
            timestamp: op.timestamp,
            votes: {},
          });
        }

        // Merge votes into existing ideas — per-agent slot so concurrent
        // writes from different agents don't overwrite each other's votes
        if (op.votes) {
          for (const [ideaId, stance] of Object.entries(op.votes)) {
            const idea = brainstorm.ideas.find((i: any) => i && i.id === ideaId);
            if (!idea) {
              throw new Error(`cannot vote on unknown idea ${ideaId} in brainstorm ${op.brainstormId}`);
            }
            if (!idea.votes || typeof idea.votes !== 'object') idea.votes = {};
            idea.votes[op.author] = stance;
          }
        }

        // Auto-advance status from open to voting once any vote lands
        if (op.votes && Object.keys(op.votes).length > 0 && brainstorm.status === 'open') {
          brainstorm.status = 'voting';
        }

        // Record the discussion message (separate from ideas — a response
        // can have a message without adding an idea or casting a vote)
        if (op.message) {
          if (!Array.isArray(brainstorm.discussion)) brainstorm.discussion = [];
          brainstorm.discussion.push({
            author: op.author,
            message: op.message,
            timestamp: op.timestamp,
          });
        }
      });
      break;
    }

    case 'promoteIdea': {
      applied = await applyBrainChange(op.docId, (doc: any) => {
        if (!Array.isArray(doc.brainstorms)) {
          throw new Error(`no brainstorms list in doc ${op.docId}`);
        }
        const brainstorm = doc.brainstorms.find((b: any) => b && b.id === op.brainstormId);
        if (!brainstorm) {
          throw new Error(`brainstorm ${op.brainstormId} not found in ${op.docId}`);
        }
        const idea = (brainstorm.ideas || []).find((i: any) => i && i.id === op.ideaId);
        if (!idea) {
          throw new Error(`idea ${op.ideaId} not found in brainstorm ${op.brainstormId}`);
        }
        if (!Array.isArray(brainstorm.promotedToProjectIds)) brainstorm.promotedToProjectIds = [];
        if (!brainstorm.promotedToProjectIds.includes(op.promotedProjectId)) {
          brainstorm.promotedToProjectIds.push(op.promotedProjectId);
        }
        // Mark the idea itself as promoted so the projection can show
        // the link visibly
        idea.promotedAt = op.promotedAt;
        idea.promotedBy = op.promotedBy;
        idea.promotedProjectId = op.promotedProjectId;
        // Advance the brainstorm to promoted status if it wasn't already
        if (brainstorm.status !== 'closed' && brainstorm.status !== 'promoted') {
          brainstorm.status = 'promoted';
        }
      });
      break;
    }

    case 'closeBrainstorm': {
      applied = await applyBrainChange(op.docId, (doc: any) => {
        if (!Array.isArray(doc.brainstorms)) {
          throw new Error(`no brainstorms list in doc ${op.docId}`);
        }
        const brainstorm = doc.brainstorms.find((b: any) => b && b.id === op.brainstormId);
        if (!brainstorm) {
          throw new Error(`brainstorm ${op.brainstormId} not found in ${op.docId}`);
        }
        brainstorm.status = 'closed';
        brainstorm.closedAt = op.closedAt;
        brainstorm.closedBy = op.closedBy;
        if (op.reason) brainstorm.closedReason = op.reason;
      });
      break;
    }

    case 'removeBrainstorm': {
      applied = await applyBrainChange(op.docId, (doc: any) => {
        if (!Array.isArray(doc.brainstorms)) {
          throw new Error(`no brainstorms list in doc ${op.docId}`);
        }
        const brainstorm = doc.brainstorms.find((b: any) => b && b.id === op.brainstormId);
        if (!brainstorm) {
          throw new Error(`brainstorm ${op.brainstormId} not found in ${op.docId}`);
        }
        brainstorm.removed = true;
        brainstorm.removedAt = op.removedAt;
        brainstorm.removedBy = op.removedBy;
        if (op.removedReason) brainstorm.removedReason = op.removedReason;
      });
      break;
    }

    default: {
      // Exhaustiveness check — TypeScript will complain if a BrainOp variant
      // is missing from the switch.
      const _exhaustive: never = op;
      throw new Error(`Unknown BrainOp type: ${(_exhaustive as any)?.type}`);
    }
  }

  return {
    headCid: applied.headCid,
    envelopeAuthor: applied.author,
    routedViaDaemon: false,
  };
}

// ---------------------------------------------------------------------------
// Routed dispatch — sends to daemon when running, falls back locally
// ---------------------------------------------------------------------------

/**
 * Route a BrainOp through a running brain daemon, or run it locally if no
 * daemon is up.
 *
 * Fallback safety: we only fall back on PRE-CONNECT IPC errors (daemon not
 * running, socket missing, connection refused). POST-CONNECT errors leave
 * the write in an unknown state, so we error out and ask the operator to
 * verify. See module header comment for the full rationale.
 */
export async function routedDispatch(op: BrainOp): Promise<DispatchResult> {
  const daemonPid = getRunningDaemonPid();
  if (daemonPid === null) {
    // No daemon → run locally. Correct + safe.
    return await dispatchOp(op);
  }

  try {
    const ipcResult = await sendIpcRequest('applyOp', { op }, 15_000);
    return {
      headCid: ipcResult.headCid,
      envelopeAuthor: ipcResult.envelopeAuthor,
      routedViaDaemon: true,
    };
  } catch (err: any) {
    // BrainIpcError carries a `.phase` field: 'pre-connect' means the
    // connection was never established (safe to fall back); 'post-connect'
    // means the write may or may not have landed (ambiguous — do NOT fall
    // back, surface to operator).
    const isPreConnect =
      err instanceof BrainIpcError
        ? err.phase === 'pre-connect'
        : (err?.code === 'ECONNREFUSED' || err?.code === 'ENOENT');

    if (isPreConnect) {
      return await dispatchOp(op);
    }

    throw new Error(
      `Brain IPC failed mid-call (PID ${daemonPid}): ${err?.message ?? err}. ` +
      `The write may or may not have landed in the daemon. ` +
      `Verify with: pop brain read --doc ${op.docId} — and then either ` +
      `retry the command or stop the daemon (pop brain daemon stop) before retrying.`,
    );
  }
}
