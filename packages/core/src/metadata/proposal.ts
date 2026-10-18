/**
 * Proposal metadata — the JSON document pinned to IPFS whose bytes32 digest
 * becomes `descriptionHash` in createProposal.
 *
 * KEY ORDER IS A PROTOCOL CONTRACT: the subgraph and frontend parse this
 * document, and every CLI site that pins it writes the keys in exactly this
 * order — {description, optionNames, createdAt} — with no optional keys.
 * Verified against every pinning site:
 *   - src/commands/vote/create.ts           (pop vote create)
 *   - src/commands/vote/propose-quorum.ts   (pop vote propose-quorum)
 *   - src/commands/vote/propose-config.ts   (pop vote propose-config)
 *   - src/commands/vote/classes.ts          (pop vote classes propose)
 *   - src/commands/task/perms.ts            (pop task perms propose-global)
 *   - src/commands/org/set-metadata-admin.ts, src/commands/project/propose.ts
 *
 * Optional extensions follow the three canonical basic keys in a fixed order.
 * Omitted extensions leave existing CLI content-addressed bytes unchanged.
 */

export interface ProposalMetadata {
  description: string;
  optionNames: string[];
  /** Unix time in MILLISECONDS (the CLI pins Date.now()). */
  createdAt: number;
  actionSummaries?: string[];
  promotedFrom?: string;
  createsSubject?: boolean;
  schemaVersion?: 1;
  extensions?: Record<string, ProposalJsonValue>;
}

export type ProposalJsonValue = null | boolean | number | string | ProposalJsonValue[] | { [key: string]: ProposalJsonValue };

export interface BuildProposalMetadataParams {
  description: string;
  optionNames: string[];
  /** Defaults to Date.now() (milliseconds), matching every CLI pin site. */
  createdAt?: number;
  actionSummaries?: string[];
  promotedFrom?: string;
  createsSubject?: boolean;
  schemaVersion?: 1;
  extensions?: Record<string, ProposalJsonValue>;
}

/**
 * Canonical proposal metadata object. Key order is load-bearing — see the
 * module doc comment. Port of the inline object in `pop vote create`
 * (src/commands/vote/create.ts) shared by every governance-wrap command.
 */
export function buildProposalMetadata(params: BuildProposalMetadataParams): ProposalMetadata {
  if (params.actionSummaries !== undefined && (!Array.isArray(params.actionSummaries)
    || params.actionSummaries.some(v => typeof v !== 'string' || !v.trim()))) throw new Error('INVALID_ACTION_SUMMARIES');
  // Explicit key order: description, optionNames, createdAt.
  return {
    description: params.description,
    optionNames: params.optionNames,
    createdAt: params.createdAt ?? Date.now(),
    ...(params.actionSummaries?.length ? { actionSummaries: [...params.actionSummaries] } : {}),
    ...(params.promotedFrom !== undefined ? { promotedFrom: params.promotedFrom } : {}),
    ...(params.createsSubject !== undefined ? { createsSubject: params.createsSubject } : {}),
    ...(params.schemaVersion !== undefined ? { schemaVersion: params.schemaVersion } : {}),
    ...(params.extensions !== undefined ? { extensions: canonicalJson(params.extensions) as Record<string, ProposalJsonValue> } : {}),
  };
}

/**
 * The exact serialization the CLI pins: JSON.stringify with no spacing.
 * (The IPFS CID is content-addressed, so byte-identical serialization is what
 * makes CLI-pinned and core-pinned documents hash identically.)
 */
export function serializeProposalMetadata(metadata: ProposalMetadata): string {
  return JSON.stringify(metadata);
}

function canonicalJson(value: ProposalJsonValue, ancestors = new Set<object>()): ProposalJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('INVALID_PROPOSAL_EXTENSION');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('INVALID_PROPOSAL_EXTENSION');
  const path = new Set(ancestors).add(value);
  if (Array.isArray(value)) return value.map(v => canonicalJson(v, path));
  return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonicalJson(value[k], path)]));
}

/** Validate untrusted/final documents BEFORE any content callback or pin request. */
export function validateProposalMetadata(doc: unknown): asserts doc is ProposalMetadata {
  const d = doc as ProposalMetadata;
  if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.description !== 'string'
    || !Array.isArray(d.optionNames) || d.optionNames.some(v => typeof v !== 'string' || !v.trim())
    || !Number.isSafeInteger(d.createdAt) || d.createdAt < 0) throw new Error('INVALID_PROPOSAL_METADATA');
  if (d.schemaVersion !== undefined && d.schemaVersion !== 1) throw new Error('UNSUPPORTED_PROPOSAL_METADATA_VERSION');
  if (d.actionSummaries !== undefined && (!Array.isArray(d.actionSummaries) || d.actionSummaries.some(v => typeof v !== 'string' || !v.trim()))) throw new Error('INVALID_ACTION_SUMMARIES');
  if (d.promotedFrom !== undefined && (typeof d.promotedFrom !== 'string' || !d.promotedFrom.trim())) throw new Error('INVALID_PROMOTION_PROVENANCE');
  if (d.createsSubject !== undefined && typeof d.createsSubject !== 'boolean') throw new Error('INVALID_CREATION_MARKER');
  if (!d.description.trim() && !d.optionNames.length && !d.actionSummaries?.length) throw new Error('EMPTY_PROPOSAL_METADATA');
  if (Object.keys(d).some(k => !['description', 'optionNames', 'createdAt', 'actionSummaries', 'promotedFrom', 'createsSubject', 'schemaVersion', 'extensions'].includes(k))) throw new Error('UNKNOWN_PROPOSAL_METADATA_KEY');
  if (d.extensions !== undefined) {
    if (!d.extensions || typeof d.extensions !== 'object' || Array.isArray(d.extensions)) throw new Error('INVALID_PROPOSAL_EXTENSION');
    canonicalJson(d.extensions);
  }
}

/** Stable final-document path. No clock access; preserves supplied milliseconds. */
export function prepareProposalMetadata(doc: unknown): ProposalMetadata {
  validateProposalMetadata(doc);
  return buildProposalMetadata(doc);
}
