/**
 * Shared Snapshot GraphQL helper with retry + exponential backoff.
 *
 * History:
 * - HB#487 (vigil, retro-839 change-5): retry/backoff shipped in audit-proxy-factory
 *   `snapshotGraphQL()` — ECONNRESET + 429 + 5xx with 1s/2s/4s exp-backoff, max 3 attempts.
 * - HB#508 (vigil): same pattern replicated in audit-snapshot `querySnapshot()` after
 *   an HTTP 429 silently became an undefined-dereference.
 * - HB#509 (this file): duplicated retry code extracted into a shared utility.
 *
 * Usage:
 *   import { snapshotGraphQL } from '../../lib/snapshot';
 *   const data = await snapshotGraphQL<MyResponseType>(query, variables);
 *
 * Guarantees:
 *   - Returns `json.data` (the GraphQL data payload). If `data` is missing, throws
 *     with a clear "Snapshot API returned no data field" error.
 *   - Retries on 429 / 5xx / ECONNRESET / ETIMEDOUT / EAI_AGAIN / "fetch failed".
 *   - Fails fast on non-429 4xx.
 *   - Throws the original GraphQL error message when `json.errors` is present.
 */

export interface SnapshotGraphQLOptions {
  /** Optional override for the GraphQL endpoint URL. Defaults to hub.snapshot.org. */
  endpoint?: string;
  /** Maximum retry attempts (default 3). */
  maxAttempts?: number;
  /** Emit a warning to console.warn() on each retry when true. */
  verbose?: boolean;
}

const DEFAULT_ENDPOINT = 'https://hub.snapshot.org/graphql';

export async function snapshotGraphQL<T = any>(
  query: string,
  variables: Record<string, unknown> = {},
  options: SnapshotGraphQLOptions = {},
): Promise<T> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const maxAttempts = options.maxAttempts ?? 3;
  const verbose = options.verbose === true;
  const body = JSON.stringify({ query, variables });
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (resp.status === 429 || resp.status >= 500) {
        throw new Error(`Snapshot HTTP ${resp.status}`);
      }
      if (!resp.ok) {
        throw new Error(`Snapshot HTTP ${resp.status} (non-retryable)`);
      }
      const json = (await resp.json()) as { data?: T; errors?: Array<{ message: string }> };
      if (json.errors && json.errors.length > 0) {
        throw new Error(`Snapshot API: ${json.errors[0].message}`);
      }
      if (!json.data) {
        throw new Error('Snapshot API returned no data field');
      }
      return json.data;
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      const retryable =
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('EAI_AGAIN') ||
        msg.includes('fetch failed') ||
        msg.includes('HTTP 429') ||
        /HTTP 5\d\d/.test(msg);
      if (!retryable || attempt === maxAttempts) break;
      const delayMs = 1000 * Math.pow(2, attempt - 1);
      if (verbose) {
        // eslint-disable-next-line no-console
        console.warn(`  [snapshot] attempt ${attempt}/${maxAttempts} failed (${msg}); retrying in ${delayMs}ms`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr || new Error('Snapshot: unknown error');
}
