/**
 * Role application metadata — the canonical document `pop role apply` pins to
 * IPFS before calling EligibilityModuleNew.applyForRole(hatId, applicationHash).
 *
 * KEY ORDER IS A PROTOCOL CONTRACT. The subgraph and frontend read this
 * document by shape, and the CLI has always pinned exactly
 * `{ notes, experience, appliedAt }` in that order
 * (src/commands/role/apply.ts — "key order preserved for frontend/subgraph
 * parity"). Do not reorder, rename, or interleave keys.
 */

/** The pinned document shape. Key order matches the CLI byte-for-byte. */
export interface RoleApplicationMetadata {
  /** Application notes; empty string when the applicant provided none. */
  notes: string;
  /** Relevant experience; empty string when the applicant provided none. */
  experience: string;
  /** Unix MILLISECONDS (Date.now() in the CLI), not seconds. */
  appliedAt: number;
}

export interface RoleApplicationMetadataInput {
  notes?: string;
  experience?: string;
  /** Override the timestamp (unix ms). Default: Date.now(), as the CLI does. */
  appliedAt?: number;
}

/**
 * Port of `pop role apply`'s metadata construction —
 * src/commands/role/apply.ts (`applicationData`).
 *
 * Key order is load-bearing (see module header): the object literal below is
 * the canonical order and must not change.
 */
export function buildRoleApplicationMetadata(
  input: RoleApplicationMetadataInput = {}
): RoleApplicationMetadata {
  return {
    notes: input.notes || '',
    experience: input.experience || '',
    appliedAt: input.appliedAt ?? Date.now(),
  };
}

/**
 * The exact serialization the CLI pins: bare JSON.stringify with no spacing.
 * `applicationHash` on chain is ipfsCidToBytes32(pinJson(this)).
 */
export function serializeRoleApplicationMetadata(metadata: RoleApplicationMetadata): string {
  return JSON.stringify(metadata);
}
