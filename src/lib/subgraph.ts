/**
 * Subgraph Client — CLI host wrapper over @poa-box/core.
 *
 * The tiered transport (free Studio / paid gateway routing, quota pins, field
 * fallback) lives in @poa-box/core/graph/client and is browser-pure. This module
 * is the CLI's binding of it to the Node environment:
 *
 *   env         process.env (live reference, so per-call env reads behave
 *               exactly like the pre-extraction module)
 *   stateStore  ~/.pop/subgraph-tier-state.json — see getStatePath() for the
 *               POP_SUBGRAPH_STATE_FILE / POP_AGENT_HOME overrides and why a
 *               human install must never grow a ~/.pop-agent directory
 *   onWarn      process.stderr (visible to a human without corrupting --json)
 *
 * Every export keeps its pre-extraction signature, so the ~66 command files
 * and @poa-box/agent's deep imports (`@poa-box/cli/lib/subgraph`) are unaffected.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  GraphClient,
  emptyTierState,
  FREE_BACKOFF_SECONDS,
  redactSubgraphUrl,
  isQuotaError,
  isAuthError,
} from '@poa-box/core/graph/client';
import type {
  TierState,
  TierStateStore,
  SubgraphTierName,
  SubgraphTierMode,
  TransportAvailability,
  TransportAttempt,
  TransportPlan,
  TransportStatus,
  FieldFallbackTier,
  ChainQueryResult,
} from '@poa-box/core/graph/client';

export { FREE_BACKOFF_SECONDS, redactSubgraphUrl, isQuotaError, isAuthError };
export type {
  SubgraphTierName,
  SubgraphTierMode,
  TransportAvailability,
  TransportAttempt,
  TransportPlan,
  TransportStatus,
  FieldFallbackTier,
  ChainQueryResult,
};

// ---------------------------------------------------------------------------
// File-backed tier state (verbatim semantics of the pre-extraction module)
// ---------------------------------------------------------------------------

/**
 * The CLI is normally one process per command, so the memo exists to stop
 * queryWithFieldFallback re-reading the file per tier. Long-lived hosts (the
 * brain daemon) re-read after this window so an external writer is noticed.
 */
const STATE_CACHE_TTL_MS = 30_000;

function getStatePath(): string {
  const explicit = (process.env.POP_SUBGRAPH_STATE_FILE || '').trim();
  if (explicit) return explicit;
  // Agent tooling that sets POP_AGENT_HOME keeps its state under the agent
  // home; everyone else uses the CLI's own per-user dir. Never default to
  // ~/.pop-agent — a human install must not grow an agent directory because
  // it got rate-limited once.
  const agentHome = (process.env.POP_AGENT_HOME || '').trim();
  const dir = agentHome || path.join(os.homedir(), '.pop');
  return path.join(dir, 'subgraph-tier-state.json');
}

class FsTierStateStore implements TierStateStore {
  private cache: TierState | undefined;
  private cacheAt = 0;

  /**
   * Never throws. A missing, unreadable, truncated or hand-mangled state file
   * is treated as "no knowledge" — the cost is one wasted free-tier probe,
   * which is strictly better than crashing a read command over a cache file.
   */
  load(): TierState | undefined {
    if (this.cache && Date.now() - this.cacheAt < STATE_CACHE_TTL_MS) return this.cache;
    this.cacheAt = Date.now();
    try {
      const p = getStatePath();
      if (!fs.existsSync(p)) return (this.cache = emptyTierState());
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && parsed.version === 1 && parsed.chains && typeof parsed.chains === 'object' && !Array.isArray(parsed.chains)) {
        this.cache = parsed as TierState;
      } else {
        this.cache = emptyTierState();
      }
    } catch {
      this.cache = emptyTierState();
    }
    return this.cache;
  }

  save(state: TierState): void {
    this.cache = state;
    this.cacheAt = Date.now();
    try {
      const p = getStatePath();
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch {
      // Advisory only — a read-only HOME degrades us to the old per-process
      // behaviour rather than failing the command.
    }
  }

  reset(): void {
    this.cache = undefined;
    this.cacheAt = 0;
  }
}

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let store = new FsTierStateStore();
let client = buildClient();

function buildClient(): GraphClient {
  return new GraphClient({
    // process.env is passed by reference: the core client reads keys at call
    // time, so tests and commands that mutate env after import keep working.
    env: process.env,
    stateStore: store,
    onWarn: (message) => {
      // stderr, not stdout: visible to a human without corrupting --json output.
      try {
        process.stderr.write(message + '\n');
      } catch { /* stderr closed */ }
    },
  });
}

/** The GraphClient this process uses — for handing to @poa-box/core helpers. */
export function getGraphClient(): GraphClient {
  return client;
}

/** Test/diagnostic hook: drop memoised transport state and the state-file memo. */
export function resetSubgraphTransportCache(): void {
  store.reset();
  client = buildClient();
}

// ---------------------------------------------------------------------------
// Pre-extraction API surface (bound to the singleton)
// ---------------------------------------------------------------------------

/** unix-seconds until which the free transport is considered spent, or undefined. */
export function getFreeExhaustedUntil(chainId: number): number | undefined {
  return client.getFreeExhaustedUntil(chainId);
}

/**
 * Work out which transports exist for a chain and in what order to try them.
 * Pure w.r.t. the network: reads env + config + the persisted state file only.
 */
export function resolveTransportPlan(chainId?: number): TransportPlan {
  return client.resolveTransportPlan(chainId);
}

/**
 * Query a subgraph on the specified chain, routed through the tier plan
 * (see @poa-box/core/graph/client).
 */
export async function query<T = any>(
  gqlQuery: string,
  variables?: Record<string, any>,
  chainId?: number
): Promise<T> {
  return client.query<T>(gqlQuery, variables, chainId);
}

/**
 * Try query tiers in order, falling through to the next tier when the
 * deployed schema rejects a field (validation error). Any other error
 * (network, HTTP, rate limit without fallback) is rethrown immediately.
 * Returns the first successful result plus the tier index that served it.
 */
export async function queryWithFieldFallback<T = any>(
  tiers: Array<FieldFallbackTier>,
  opts?: { chainId?: number }
): Promise<{ data: T; tierIndex: number }> {
  return client.queryWithFieldFallback<T>(tiers, opts);
}

/**
 * Query a specific subgraph URL directly, still tier-aware: if `url` is a free
 * (Studio) endpoint belonging to a known chain and it rate-limits, the request
 * is retried against that chain's gateway rather than simply failing.
 */
export async function queryUrl<T = any>(
  url: string,
  gqlQuery: string,
  variables?: Record<string, any>
): Promise<T> {
  return client.queryUrl<T>(url, gqlQuery, variables);
}

/**
 * Query all non-testnet subgraphs in parallel, each through its own tier plan.
 * Returns results keyed by chainId. Failures are reported per-chain rather
 * than swallowed: see ChainQueryResult.error.
 */
export async function queryAllChains<T = any>(
  gqlQuery: string,
  variables?: Record<string, any>
): Promise<Array<ChainQueryResult<T>>> {
  return client.queryAllChains<T>(gqlQuery, variables);
}

/**
 * Describe the transport that will serve the next query on `chainId`.
 * Purely local — issues no network request. URLs are redacted.
 */
export function getTransportStatus(chainId?: number): TransportStatus {
  return client.getTransportStatus(chainId);
}
