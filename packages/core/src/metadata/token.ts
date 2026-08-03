/**
 * Token-request metadata — the document `pop token request` pins to IPFS.
 *
 * Port of the metadata construction in src/commands/token/request.ts:
 *
 *   const metadata = { reason: argv.reason, submittedAt: Date.now() };
 *   pinJson(JSON.stringify(metadata));
 *
 * KEY ORDER IS A PROTOCOL CONTRACT: {reason, submittedAt} matches the
 * frontend exactly — the subgraph's TokenRequestMetadata mapping and the UI
 * both consume this document. Do not reorder or insert keys.
 */

/** Canonical token-request document. Key order: reason, submittedAt. */
export interface TokenRequestMetadata {
  /** Free-text justification for the request (shown to approvers). */
  reason: string;
  /** Unix milliseconds at submission time (Date.now() in the CLI/frontend). */
  submittedAt: number;
}

/**
 * Build the token-request metadata object with the canonical key order.
 * Port of `pop token request` — src/commands/token/request.ts.
 *
 * `submittedAt` defaults to Date.now(), exactly as the CLI does; pass it
 * explicitly for deterministic documents (tests, replays).
 */
export function buildTokenRequestMetadata(
  reason: string,
  submittedAt: number = Date.now()
): TokenRequestMetadata {
  // Key order is load-bearing — matches the frontend serialization exactly.
  return { reason, submittedAt };
}

/**
 * Serialize with the exact key order the CLI pins
 * (JSON.stringify of an object constructed as {reason, submittedAt}).
 */
export function serializeTokenRequestMetadata(metadata: TokenRequestMetadata): string {
  // Rebuilt with explicit key order so callers cannot accidentally pin a
  // reordered document.
  return JSON.stringify({ reason: metadata.reason, submittedAt: metadata.submittedAt });
}
