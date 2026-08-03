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
 * The subgraph's ProposalMetadata entity also carries `actionSummaries` and
 * `promotedFrom` (read by `pop vote results`), but the CLI never writes them
 * — they come from the frontend's proposal flow. Do NOT add them here without
 * a verified reference for their position.
 */

export interface ProposalMetadata {
  description: string;
  optionNames: string[];
  /** Unix time in MILLISECONDS (the CLI pins Date.now()). */
  createdAt: number;
}

export interface BuildProposalMetadataParams {
  description: string;
  optionNames: string[];
  /** Defaults to Date.now() (milliseconds), matching every CLI pin site. */
  createdAt?: number;
}

/**
 * Canonical proposal metadata object. Key order is load-bearing — see the
 * module doc comment. Port of the inline object in `pop vote create`
 * (src/commands/vote/create.ts) shared by every governance-wrap command.
 */
export function buildProposalMetadata(params: BuildProposalMetadataParams): ProposalMetadata {
  // Explicit key order: description, optionNames, createdAt.
  return {
    description: params.description,
    optionNames: params.optionNames,
    createdAt: params.createdAt ?? Date.now(),
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
