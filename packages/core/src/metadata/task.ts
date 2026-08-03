/**
 * Task-domain metadata documents (task, rejection, application, project).
 *
 * KEY ORDER IS A PROTOCOL CONTRACT. The subgraph's IPFS templates and the
 * frontend both parse these documents positionally-by-convention: a document
 * whose keys are serialized in a different order breaks metadata indexing and
 * the UI. Every builder below constructs its object with an explicit literal
 * so the JSON.stringify key order is fixed at the source.
 *
 * Shapes verified against the CLI commands that pin them:
 *   task        — src/commands/task/create.ts (buildMetadata in create-batch.ts,
 *                 the merge sites in submit.ts / update.ts / edit-meta.ts)
 *   rejection   — src/commands/task/review.ts (reject path)
 *   application — src/commands/task/apply.ts
 *   project     — src/commands/project/create.ts + project/propose.ts
 */

/**
 * Canonical task metadata document.
 *
 * Exact key order: name, description, location, difficulty, estHours,
 * submission — and dueDate LAST, present ONLY when set. The subgraph re-points
 * task.metadata at whatever document was pinned most recently (submitTask,
 * updateTask, updateTaskMetadata are full overwrites of the pointer), so a
 * dueDate omitted from a re-pin is deleted for good. Mirrors the frontend,
 * which appends the key last and only when set.
 */
export interface TaskMetadata {
  name: string;
  description: string;
  location: string;
  difficulty: string;
  /**
   * number on create/submit; update/edit-meta pass the subgraph's BigDecimal
   * STRING through unparsed (`metadata?.estimatedHours || metadata?.estHours
   * || 0` in update.ts/edit-meta.ts) — preserved for byte parity.
   */
  estHours: number | string;
  submission: string;
  /**
   * Soft due date (unix seconds). LAST key, present only when set. May be
   * NaN-serialized-as-null when a merge carried a garbage raw value — see
   * buildTaskMetadata.
   */
  dueDate?: number | null;
}

export interface TaskMetadataFields {
  name: string;
  description: string;
  location: string;
  difficulty: string;
  /** See TaskMetadata.estHours for why strings are allowed. */
  estHours: number | string;
  submission: string;
  /**
   * RAW due-date value (unix seconds, or whatever a merge read back from
   * IPFS). Truthiness is applied to THIS raw value, coercion happens after —
   * matching the CLI merge sites exactly. Omit / 0 / '' ⇒ key absent.
   */
  dueDate?: number | string;
}

/**
 * Build the canonical task metadata object with the load-bearing key order.
 *
 * Deliberately takes FINAL values with no defaulting: the CLI's commands
 * default differently per site (create uses difficulty 'medium', submit's
 * merge uses '' — see the Level-2 builders in ../tx/task), so defaults here
 * would silently change pinned bytes. `dueDate` follows the CLI merge sites'
 * convention EXACTLY: truthiness on the RAW value, coercion after — so a raw
 * "0" (truthy string) is pinned as 0, and a truthy non-numeric raw value is
 * pinned as NaN, which JSON-serializes to null. Testing the coerced number
 * instead would drop keys the CLI keeps and change the pinned bytes.
 */
export function buildTaskMetadata(fields: TaskMetadataFields): TaskMetadata {
  const rawDueDate = fields.dueDate;
  const coerced = Math.floor(Number(rawDueDate));
  return {
    name: fields.name,
    description: fields.description,
    location: fields.location,
    difficulty: fields.difficulty,
    estHours: fields.estHours,
    submission: fields.submission,
    // Key order is load-bearing: dueDate is appended LAST and only when the
    // RAW value is truthy (NaN → null via JSON, same as the CLI).
    ...(rawDueDate ? { dueDate: Number.isNaN(coerced) ? null : coerced } : {}),
  };
}

/** Serialize exactly as the CLI pins it (JSON.stringify of the ordered object). */
export function serializeTaskMetadata(metadata: TaskMetadata): string {
  return JSON.stringify(metadata);
}

/**
 * Rejection document pinned by `pop task review --action reject`
 * (src/commands/task/review.ts): a single `rejection` key.
 */
export interface TaskRejectionMetadata {
  rejection: string;
}

export function buildTaskRejectionMetadata(reason: string): TaskRejectionMetadata {
  // Single key — order trivially fixed, kept explicit for symmetry.
  return { rejection: reason };
}

export function serializeTaskRejectionMetadata(metadata: TaskRejectionMetadata): string {
  return JSON.stringify(metadata);
}

/**
 * Application document pinned by `pop task apply`
 * (src/commands/task/apply.ts). Key order: notes, experience.
 */
export interface TaskApplicationMetadata {
  notes: string;
  experience: string;
}

export function buildTaskApplicationMetadata(fields: {
  notes?: string;
  experience?: string;
}): TaskApplicationMetadata {
  // Key order is load-bearing: notes, then experience. Empty-string defaults
  // match the CLI (`argv.notes || ''`).
  return {
    notes: fields.notes || '',
    experience: fields.experience || '',
  };
}

export function serializeTaskApplicationMetadata(metadata: TaskApplicationMetadata): string {
  return JSON.stringify(metadata);
}

/**
 * Project metadata document pinned by `pop project create` / `pop project
 * propose` (src/commands/project/create.ts, project/propose.ts): a single
 * `description` key. The CLI only pins it when a description was given —
 * otherwise the on-chain metaHash is HashZero, never a pin of `{description:''}`.
 */
export interface ProjectMetadata {
  description: string;
}

export function buildProjectMetadata(description: string): ProjectMetadata {
  return { description };
}

export function serializeProjectMetadata(metadata: ProjectMetadata): string {
  return JSON.stringify(metadata);
}
