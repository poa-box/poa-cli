/**
 * Subgraph Client — tiered transport
 *
 * Two transports can serve the same subgraph:
 *
 *   FREE ("Studio")   `api.studio.thegraph.com/...` — no key, capped at
 *                     3K queries/day (rolling window, see x-ratelimit-reset).
 *   PAID ("gateway")  `gateway.thegraph.com/api/subgraphs/id/<ID>` — billed
 *                     against GRAPH_API_KEY, sent as an Authorization header.
 *
 * Routing is by AVAILABILITY, controlled by POP_SUBGRAPH_TIER=free|paid|auto
 * (default `auto`):
 *
 *   both      free first, switch to paid when free is exhausted, and REMEMBER
 *             the switch on disk so the next process does not repeat the
 *             doomed free round-trip
 *   paid only straight to the gateway, never probe Studio
 *   free only Studio; on exhaustion, fail with an actionable error naming
 *             GRAPH_API_KEY and the gateway URL to set
 *   neither   PRECONDITION error (this chain has no POP subgraph)
 *
 * ## Why exhaustion is persisted
 *
 * The CLI is a fresh process per command. A per-process flag meant that once
 * Studio's daily quota was gone EVERY command burned a doomed Studio
 * round-trip first, and queryWithFieldFallback repeated that once per tier.
 * The exhausted state lives in `~/.pop/subgraph-tier-state.json` — the CLI's
 * per-user config dir (`pop init --global` writes there too). A human install
 * must never grow a `~/.pop-agent/` directory as a side effect of a rate
 * limit; agents still get per-agent isolation because each one runs with its
 * own HOME, so `~/.pop/` resolves inside the agent home. POP_AGENT_HOME (set
 * by agent tooling) and POP_SUBGRAPH_STATE_FILE both override.
 *
 * ## Why the pin is SHORT
 *
 * A burst limit and a spent daily quota look identical from a single 429, so
 * exhaustion is pinned for FREE_BACKOFF_SECONDS (15 min) and no longer — never
 * "until UTC midnight". Worst case we re-probe Studio ~96 times a day instead
 * of thousands of times; best case a transient burst limit does not push a
 * whole day of traffic onto the paid key. A `x-ratelimit-reset` sooner than the
 * backoff shortens the pin but never extends it.
 *
 * The state file is advisory: a corrupt or unreadable one is ignored, never
 * fatal.
 */

import { GraphQLClient } from 'graphql-request';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  resolveNetworkConfig,
  getAllSubgraphUrls,
  getGatewaySubgraphUrl,
  getEnvInfixByChainId,
} from '../config/networks';
import { CliError } from './errors';
import { EXIT } from './exit-codes';

/** How long a free-tier quota/rate error suppresses the free transport. */
export const FREE_BACKOFF_SECONDS = 15 * 60;

export type SubgraphTierName = 'free' | 'paid';
export type SubgraphTierMode = 'auto' | 'free' | 'paid';
export type TransportAvailability = 'both' | 'paid-only' | 'free-only' | 'none';

export interface TransportAttempt {
  tier: SubgraphTierName;
  url: string;
}

export interface TransportPlan {
  chainId: number;
  /** Human network name, for error messages. */
  networkName: string;
  /** Effective POP_SUBGRAPH_TIER. */
  mode: SubgraphTierMode;
  /** Set when POP_SUBGRAPH_TIER held an unrecognised value (we fell back to auto). */
  modeOverrideIgnored?: string;
  availability: TransportAvailability;
  hasApiKey: boolean;
  /** A gateway URL is configured but GRAPH_API_KEY is missing, so it is unusable. */
  paidKeyMissing: boolean;
  freeUrl?: string;
  paidUrl?: string;
  /** Transports to try, in order. Empty means "nothing usable" — see planError(). */
  attempts: TransportAttempt[];
  /** unix-seconds; while in the future the free transport is skipped. */
  freeExhaustedUntil?: number;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const clientCache: Map<string, GraphQLClient> = new Map();

function isGatewayUrl(url: string): boolean {
  return /(^|\/\/)([\w-]+\.)?gateway[\w-]*\.thegraph\.com/i.test(url);
}

function getApiKey(): string {
  return (process.env.GRAPH_API_KEY || '').trim();
}

/**
 * Mask anything that could be a credential before a URL is printed or put in
 * an error. The modern gateway form carries the key in a header, but the
 * LEGACY form embeds it in the path (`/api/<KEY>/subgraphs/id/<ID>`), and
 * some hosts accept `?api_key=`. Never let either reach stdout.
 */
export function redactSubgraphUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  return url
    .replace(/(\/api\/)(?!subgraphs\/)[^/?#]+/i, '$1<redacted>')
    .replace(/([?&](?:api[-_]?key|access[-_]?token)=)[^&#]+/gi, '$1<redacted>');
}

function getClient(url: string, chainId?: number, opts?: { paid?: boolean }): GraphQLClient {
  // The Authorization header follows the PLANNED TIER, not hostname sniffing.
  // isGatewayUrl only recognises gateway.thegraph.com, but the documented
  // POP_GRAPH_GATEWAY_URL / POP_<NET>_SUBGRAPH_GATEWAY overrides allow
  // self-hosted and regional hosts (gateway-arbitrum.network.thegraph.com
  // fails the regex too) — keying on the hostname sent those requests keyless
  // and then blamed the operator's valid key. Hostname sniffing remains only
  // as a fallback for direct queryUrl() calls that carry no tier.
  const paid = opts?.paid ?? isGatewayUrl(url);
  const cacheKey = `${chainId ?? '-'}|${paid ? 'paid' : 'free'}|${url}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    const headers: Record<string, string> = {};
    const key = getApiKey();
    if (paid && key) {
      headers['Authorization'] = `Bearer ${key}`;
    }
    client = new GraphQLClient(url, {
      headers,
      // Studio publishes x-ratelimit-remaining / -reset on every response.
      // Reading them lets us record exhaustion BEFORE a request fails, so the
      // next process skips the free transport instead of learning the hard way.
      responseMiddleware: (res: any) => {
        if (chainId !== undefined && !paid) observeRateLimit(chainId, res);
      },
    });
    clientCache.set(cacheKey, client);
  }
  return client;
}

/** Test/diagnostic hook: drop memoised clients and the in-process state copy. */
export function resetSubgraphTransportCache(): void {
  clientCache.clear();
  stateCache = undefined;
  stateCacheAt = 0;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Server-supplied strings only. Deliberately NOT `error.message` — for a
 * ClientError that embeds a JSON dump of the whole request, so matching on it
 * would let a query that merely CONTAINS "429" or the word "quota" fake a
 * rate limit and burn paid quota.
 */
function serverMessages(error: any): string[] {
  const out: string[] = [];
  const res = error?.response;
  if (!res) return out;
  if (Array.isArray(res.errors)) {
    for (const e of res.errors) if (e?.message) out.push(String(e.message));
  }
  if (typeof res.error === 'string') out.push(res.error);
  else if (res.error?.message) out.push(String(res.error.message));
  return out;
}

function httpStatus(error: any): number | undefined {
  const raw = error?.response?.status ?? error?.status;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Quota/rate exhaustion, in whatever shape the host actually uses.
 *
 * Confirmed live (2026-07): Studio answers a healthy query HTTP 200 with
 * `x-ratelimit-limit: 3000` / `-remaining` / `-reset`, and the gateway answers
 * an unauthenticated query HTTP **200** with `{"errors":[{"message":"auth
 * error: ..."}]}` — i.e. HTTP status alone is not sufficient in either
 * direction. So: match the status when it is one of the unambiguous
 * exhaustion codes, otherwise match only the SERVER's message text.
 */
export function isQuotaError(error: any): boolean {
  const status = httpStatus(error);
  if (status === 429 || status === 402) return true;

  const msgs = serverMessages(error);
  const QUOTA_RE = /(rate[\s-]?limit|too many requests|quota|out of credits|payment required|free (?:tier|plan) limit|exceeded[^.]{0,40}(?:limit|budget))/i;
  if (msgs.some(m => QUOTA_RE.test(m))) return true;

  // Non-JSON bodies (Studio serves a plain-text 429) become
  // "GraphQL Error (Code: 429): {...}". Anchored so only the code matches.
  if (typeof error?.message === 'string' && /^GraphQL Error \(Code: (?:429|402)\)/.test(error.message)) return true;

  return false;
}

/** Missing/invalid/unauthorised API key on the paid transport. */
export function isAuthError(error: any): boolean {
  if (isQuotaError(error)) return false;
  const msgs = serverMessages(error);
  const AUTH_RE = /(auth error|api key|authorization|unauthorized|forbidden)/i;
  if (msgs.some(m => AUTH_RE.test(m))) return true;
  const status = httpStatus(error);
  return status === 401;
}

/**
 * Detect a GraphQL validation error caused by querying a field the
 * deployed schema doesn't have (older subgraph version). Network/HTTP
 * failures deliberately do NOT match — those should propagate.
 */
function isUnknownFieldError(error: any): boolean {
  const messages: string[] = [];
  const gqlErrors = error?.response?.errors;
  if (Array.isArray(gqlErrors)) {
    for (const e of gqlErrors) {
      if (e?.extensions?.code === 'GRAPHQL_VALIDATION_FAILED') return true;
      if (e?.message) messages.push(String(e.message));
    }
  }
  if (error?.message) messages.push(String(error.message));
  return messages.some(m =>
    /cannot query field/i.test(m)
    || /has no field/i.test(m)
    || /unknown field/i.test(m)
    || /unknown argument/i.test(m)
    || /undefined field/i.test(m)
  );
}

// ---------------------------------------------------------------------------
// Persisted exhaustion state
// ---------------------------------------------------------------------------

interface TierStateFile {
  version: 1;
  chains: Record<string, { freeExhaustedUntil: number; recordedAt: number; reason?: string }>;
}

let stateCache: TierStateFile | undefined;
let stateCacheAt = 0;
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

function emptyState(): TierStateFile {
  return { version: 1, chains: {} };
}

/**
 * Never throws. A missing, unreadable, truncated or hand-mangled state file is
 * treated as "no knowledge" — the cost is one wasted free-tier probe, which is
 * strictly better than crashing a read command over a cache file.
 */
function loadState(): TierStateFile {
  if (stateCache && Date.now() - stateCacheAt < STATE_CACHE_TTL_MS) return stateCache;
  stateCacheAt = Date.now();
  try {
    const p = getStatePath();
    if (!fs.existsSync(p)) return (stateCache = emptyState());
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (parsed && parsed.version === 1 && parsed.chains && typeof parsed.chains === 'object' && !Array.isArray(parsed.chains)) {
      stateCache = parsed as TierStateFile;
    } else {
      stateCache = emptyState();
    }
  } catch {
    stateCache = emptyState();
  }
  return stateCache!;
}

function saveState(state: TierStateFile): void {
  stateCache = state;
  stateCacheAt = Date.now();
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

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** unix-seconds until which the free transport is considered spent, or undefined. */
export function getFreeExhaustedUntil(chainId: number): number | undefined {
  const entry = loadState().chains[String(chainId)];
  if (!entry || typeof entry.freeExhaustedUntil !== 'number') return undefined;
  return entry.freeExhaustedUntil > nowSeconds() ? entry.freeExhaustedUntil : undefined;
}

/**
 * Record that the free transport is spent. `resetAtSeconds` (from
 * x-ratelimit-reset) may SHORTEN the pin but never extend it past
 * FREE_BACKOFF_SECONDS — see the module header on why the pin stays short.
 */
function markFreeExhausted(chainId: number, reason: string, resetAtSeconds?: number): void {
  const now = nowSeconds();
  const cap = now + FREE_BACKOFF_SECONDS;
  const until = resetAtSeconds && resetAtSeconds > now ? Math.min(resetAtSeconds, cap) : cap;
  const state = loadState();
  state.chains[String(chainId)] = { freeExhaustedUntil: until, recordedAt: now, reason };
  saveState(state);
}

function clearFreeExhausted(chainId: number): void {
  const state = loadState();
  if (!state.chains[String(chainId)]) return; // avoid a pointless disk write
  delete state.chains[String(chainId)];
  saveState(state);
}

/** Case-insensitive header read across Headers instances and plain objects. */
function readHeader(headers: any, name: string): string | undefined {
  try {
    if (!headers) return undefined;
    if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === name.toLowerCase()) return String(v);
    }
  } catch { /* headers shape is host-dependent; never let this throw */ }
  return undefined;
}

/**
 * Proactive exhaustion: Studio tells us how much of the free quota is left on
 * every response, so record "spent" at remaining === 0 rather than waiting for
 * the next command to eat a 429.
 */
function observeRateLimit(chainId: number, resOrError: any): void {
  try {
    const headers = resOrError?.headers ?? resOrError?.response?.headers;
    const remainingRaw = readHeader(headers, 'x-ratelimit-remaining');
    if (remainingRaw === undefined) return;
    const remaining = Number(remainingRaw);
    if (!Number.isFinite(remaining)) return;
    if (remaining > 0) return;
    const resetRaw = readHeader(headers, 'x-ratelimit-reset');
    const resetAt = Number(resetRaw);
    markFreeExhausted(chainId, 'x-ratelimit-remaining=0', Number.isFinite(resetAt) ? resetAt : undefined);
  } catch { /* observation only */ }
}

// ---------------------------------------------------------------------------
// Transport planning
// ---------------------------------------------------------------------------

function resolveMode(): { mode: SubgraphTierMode; ignored?: string } {
  const raw = (process.env.POP_SUBGRAPH_TIER || '').trim().toLowerCase();
  if (!raw || raw === 'auto') return { mode: 'auto' };
  if (raw === 'free' || raw === 'paid') return { mode: raw };
  return { mode: 'auto', ignored: raw };
}

/**
 * Work out which transports exist for a chain and in what order to try them.
 * Pure w.r.t. the network: reads env + config + the persisted state file only.
 */
export function resolveTransportPlan(chainId?: number): TransportPlan {
  const config = resolveNetworkConfig(chainId);
  const effectiveChainId = config.chainId;
  const { mode, ignored } = resolveMode();

  const primary = (config.resolvedSubgraph || '').trim();
  const gateway = getGatewaySubgraphUrl(effectiveChainId);

  // Classify by URL, not by which env var supplied it: an operator who points
  // POP_<NET>_SUBGRAPH straight at the gateway has a paid primary, not a free one.
  const freeUrl = primary && !isGatewayUrl(primary) ? primary : undefined;
  const paidUrl = gateway || (primary && isGatewayUrl(primary) ? primary : undefined);

  const hasApiKey = !!getApiKey();
  // A gateway URL without a key is not a transport: it answers HTTP 200 with
  // {"errors":[{"message":"auth error: missing authorization header"}]}.
  const paidUsable = !!paidUrl && hasApiKey;
  const paidKeyMissing = !!paidUrl && !hasApiKey;

  const availability: TransportAvailability = freeUrl && paidUsable
    ? 'both'
    : paidUsable ? 'paid-only'
      : freeUrl ? 'free-only'
        : 'none';

  const freeExhaustedUntil = freeUrl ? getFreeExhaustedUntil(effectiveChainId) : undefined;

  const attempts: TransportAttempt[] = [];
  let softenedOverride: string | undefined;
  if (mode === 'paid') {
    if (paidUsable) {
      attempts.push({ tier: 'paid', url: paidUrl! });
    } else if (freeUrl && !paidKeyMissing) {
      // POP_SUBGRAPH_TIER is one global env var but paid transports are
      // per-chain: Arbitrum has no gateway deployment, so honouring the
      // override literally would make the whole chain unreadable while its
      // Studio endpoint is demonstrably alive (queryAllChains then reports
      // "no results" instead of data). Treat the override as prefer-paid:
      // chains without a gateway fall back to free, and the softening is
      // surfaced via modeOverrideIgnored so `pop config show` explains it.
      // A missing API KEY is not softened — that is a misconfiguration the
      // operator asked us to surface, not a per-chain gap.
      attempts.push({ tier: 'free', url: freeUrl });
      softenedOverride = `paid (no gateway configured for ${config.name} — using the free endpoint)`;
    }
  } else if (mode === 'free') {
    if (freeUrl) attempts.push({ tier: 'free', url: freeUrl });
  } else {
    // auto
    //
    // A live free-tier pin DEMOTES the free transport, it never drops it. The
    // pin exists to skip a doomed Studio round-trip on the happy path, not to
    // make the command depend solely on the gateway for the whole pin window:
    // a revoked/unbilled GRAPH_API_KEY or a transient gateway outage must still
    // fall through to a healthy Studio endpoint. Keeping free in the plan also
    // keeps the self-healing path reachable — a free success clears a pin that
    // was really just a transient burst limit (see executePlan).
    const demoteFree = !!freeExhaustedUntil && paidUsable;
    if (freeUrl && !demoteFree) attempts.push({ tier: 'free', url: freeUrl });
    if (paidUsable) attempts.push({ tier: 'paid', url: paidUrl! });
    if (freeUrl && demoteFree) attempts.push({ tier: 'free', url: freeUrl });
  }

  return {
    chainId: effectiveChainId,
    networkName: config.name,
    mode,
    ...(ignored || softenedOverride ? { modeOverrideIgnored: ignored || softenedOverride } : {}),
    availability,
    hasApiKey,
    paidKeyMissing,
    freeUrl,
    paidUrl,
    attempts,
    ...(freeExhaustedUntil ? { freeExhaustedUntil } : {}),
  };
}

function gatewayEnvHint(chainId: number): string {
  const infix = getEnvInfixByChainId(chainId) || 'GNOSIS';
  return `Set GRAPH_API_KEY and POP_${infix}_SUBGRAPH_GATEWAY=<gateway url> (or POP_${infix}_SUBGRAPH_ID=<subgraph id>).`;
}

/** The error to raise when a plan has no usable transport at all. */
function planError(plan: TransportPlan): CliError {
  const supported = getAllSubgraphUrls().map(n => `${n.name} (${n.chainId})`).join(', ');

  if (plan.mode === 'paid') {
    return new CliError(
      plan.paidKeyMissing
        ? `POP_SUBGRAPH_TIER=paid but GRAPH_API_KEY is not set, so the gateway cannot be used.`
        : `POP_SUBGRAPH_TIER=paid but no gateway subgraph is configured for ${plan.networkName} (chain ${plan.chainId}).`,
      EXIT.PRECONDITION,
      `${gatewayEnvHint(plan.chainId)} Or unset POP_SUBGRAPH_TIER to fall back to the free Studio endpoint.`
    );
  }

  if (plan.mode === 'free' && plan.availability !== 'none') {
    return new CliError(
      `POP_SUBGRAPH_TIER=free but no free (Studio) subgraph is configured for ${plan.networkName} (chain ${plan.chainId}).`,
      EXIT.PRECONDITION,
      `Unset POP_SUBGRAPH_TIER to use the configured gateway endpoint instead.`
    );
  }

  if (plan.paidKeyMissing) {
    return new CliError(
      `POP has no free subgraph on ${plan.networkName} (chain ${plan.chainId}) and the configured gateway needs an API key.`,
      EXIT.PRECONDITION,
      `${gatewayEnvHint(plan.chainId)}`
    );
  }

  // Unchanged from the pre-tiering behaviour: some configured chains are
  // RPC-only (no POP subgraph deployed, or the deployment was removed).
  // Without this guard the raw graphql-request failure surfaces as a ~600-byte
  // blob containing an internal Graph deployment id and the whole serialized
  // query, with no indication of WHICH chain failed.
  return new CliError(
    `POP has no subgraph on ${plan.networkName} (chain ${plan.chainId}), so this command cannot read org data.`,
    EXIT.PRECONDITION,
    // getEnvInfixByChainId, not toUpperCase(): the camelCase names need the
    // underscore, or the hint names a variable that does not exist
    // (POP_BASESEPOLIA_SUBGRAPH instead of POP_BASE_SEPOLIA_SUBGRAPH).
    `Chains with a subgraph: ${supported}. Override with POP_${getEnvInfixByChainId(plan.chainId)}_SUBGRAPH if you host your own.`
  );
}

/** Free quota gone and there is no paid transport to fall back to. */
function freeExhaustedError(plan: TransportPlan, cause: any, paidFailure?: any): CliError {
  const tail = paidFailure
    ? ` and the configured paid gateway also failed (${String(paidFailure?.message || paidFailure).slice(0, 120)}).`
    : plan.paidKeyMissing
      ? ` and the configured paid gateway has no API key.`
      : ` and no paid gateway is configured.`;
  const err = new CliError(
    `The free Graph Studio subgraph for ${plan.networkName} (chain ${plan.chainId}) is rate-limited (3K queries/day)`
    + tail,
    EXIT.INFRA,
    paidFailure
      ? `The gateway failure is likely transient — retry, and check the gateway status if it persists. Studio's quota resets on a rolling 24h window.`
      : plan.paidKeyMissing
        ? `Add GRAPH_API_KEY=<your gateway key> to your .env — the gateway URL is already set. Studio's quota resets on a rolling 24h window, so retrying later also works.`
        : `${gatewayEnvHint(plan.chainId)} Studio's quota resets on a rolling 24h window, so retrying later also works.`
  );
  (err as any).cause = cause;
  (err as any).response = cause?.response;
  return err;
}

function paidAuthError(plan: TransportPlan, cause: any): CliError {
  const err = new CliError(
    `The Graph gateway rejected the API key for ${plan.networkName} (chain ${plan.chainId}).`,
    EXIT.INFRA,
    `Check GRAPH_API_KEY is a valid gateway key with this subgraph enabled (${redactSubgraphUrl(plan.paidUrl)}).`
  );
  (err as any).cause = cause;
  (err as any).response = cause?.response;
  return err;
}

function paidQuotaError(plan: TransportPlan, cause: any): CliError {
  const err = new CliError(
    `The Graph gateway is out of query budget for ${plan.networkName} (chain ${plan.chainId}).`,
    EXIT.INFRA,
    `Top up the billing balance for GRAPH_API_KEY, or raise its per-query budget in Subgraph Studio.`
  );
  (err as any).cause = cause;
  (err as any).response = cause?.response;
  return err;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function executePlan<T>(
  plan: TransportPlan,
  gqlQuery: string,
  variables?: Record<string, any>
): Promise<T> {
  if (!plan.attempts.length) throw planError(plan);

  // When a paid attempt fails and we fall through to a demoted free attempt,
  // remember why: if free then quota-fails, the error must state BOTH facts —
  // "no paid gateway is configured" is a lie when one just returned a 500.
  let paidFailure: any;
  for (let i = 0; i < plan.attempts.length; i++) {
    const attempt = plan.attempts[i];
    const isLast = i === plan.attempts.length - 1;
    try {
      const data = await getClient(attempt.url, plan.chainId, { paid: attempt.tier === 'paid' }).request<T>(gqlQuery, variables);
      // A success on free means an earlier pin was a transient burst limit.
      if (attempt.tier === 'free' && plan.freeExhaustedUntil) clearFreeExhausted(plan.chainId);
      return data;
    } catch (error: any) {
      if (attempt.tier === 'free' && isQuotaError(error)) {
        markFreeExhausted(plan.chainId, 'quota-error', Number(readHeader(error?.response?.headers, 'x-ratelimit-reset')) || undefined);
        if (!isLast) continue; // switch to the paid transport
        throw freeExhaustedError(plan, error, paidFailure);
      }
      if (attempt.tier === 'paid') {
        // A broken gateway (revoked key, exhausted budget, DNS/5xx) must not
        // sink the command when a demoted free transport is still queued —
        // that availability guarantee predates the tiering work. Schema and
        // validation errors are excluded: they are a property of the query,
        // not the transport, so retrying elsewhere only wastes a round-trip
        // (queryWithFieldFallback owns that case).
        if (!isLast && !isUnknownFieldError(error)) { paidFailure = error; continue; }
        if (isAuthError(error)) throw paidAuthError(plan, error);
        if (isQuotaError(error)) throw paidQuotaError(plan, error);
      }
      // Schema/validation/network errors are NOT a reason to spend paid quota.
      throw error;
    }
  }
  /* istanbul ignore next — loop always returns or throws */
  throw planError(plan);
}

/**
 * Query a subgraph on the specified chain, routed through the tier plan
 * (see the module header).
 */
export async function query<T = any>(
  gqlQuery: string,
  variables?: Record<string, any>,
  chainId?: number
): Promise<T> {
  return executePlan<T>(resolveTransportPlan(chainId), gqlQuery, variables);
}

/**
 * One tier of a field-fallback query. Tier 0 is the richest query
 * (newest schema fields); later tiers progressively drop fields for
 * older subgraph deployments.
 */
export interface FieldFallbackTier {
  query: string;
  variables?: Record<string, any>;
}

/**
 * Try query tiers in order, falling through to the next tier when the
 * deployed schema rejects a field (validation error). Any other error
 * (network, HTTP, rate limit without fallback) is rethrown immediately.
 * Returns the first successful result plus the tier index that served it.
 *
 * Each tier re-plans, so once tier 0 has recorded free-tier exhaustion the
 * remaining tiers go straight to the gateway instead of repeating the probe.
 */
export async function queryWithFieldFallback<T = any>(
  tiers: Array<FieldFallbackTier>,
  opts?: { chainId?: number }
): Promise<{ data: T; tierIndex: number }> {
  if (!tiers.length) {
    throw new Error('queryWithFieldFallback requires at least one query tier');
  }

  let lastValidationError: any;
  for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
    try {
      const data = await query<T>(tiers[tierIndex].query, tiers[tierIndex].variables, opts?.chainId);
      return { data, tierIndex };
    } catch (error: any) {
      if (!isUnknownFieldError(error)) throw error;
      lastValidationError = error;
    }
  }
  throw lastValidationError;
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
  const owner = getAllSubgraphUrls().find(n => n.url === url);
  if (owner) return executePlan<T>(resolveTransportPlan(owner.chainId), gqlQuery, variables);

  // Unknown URL (self-hosted, or a one-off endpoint): no chain to plan for, so
  // issue it directly. Still classified so an auth failure reads sensibly.
  return getClient(url).request<T>(gqlQuery, variables);
}

export interface ChainQueryResult<T> {
  chainId: number;
  name: string;
  /** null when the chain returned nothing OR when the query failed — check `error`. */
  data: T | null;
  /**
   * Present only when the query FAILED. `data: null` with no `error` means the
   * chain answered and simply had no matching rows. Without this a
   * rate-limited sweep looked identical to an empty ecosystem.
   */
  error?: string;
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
  const endpoints = getAllSubgraphUrls();

  const results = await Promise.allSettled(
    endpoints.map(async (ep) => {
      const data = await query<T>(gqlQuery, variables, ep.chainId);
      return { chainId: ep.chainId, name: ep.name, data };
    })
  );

  return results.map((result, i) => {
    if (result.status === 'fulfilled') return result.value as ChainQueryResult<T>;
    const reason: any = result.reason;
    const message = (reason?.message && String(reason.message)) || 'subgraph query failed';
    // stderr, not stdout: visible to a human without corrupting --json output.
    // Silent per-chain failure previously rendered as "no orgs found".
    try {
      process.stderr.write(`warn: subgraph query failed on ${endpoints[i].name} (chain ${endpoints[i].chainId}): ${message.slice(0, 200)}\n`);
    } catch { /* stderr closed */ }
    return { chainId: endpoints[i].chainId, name: endpoints[i].name, data: null, error: message };
  });
}

// ---------------------------------------------------------------------------
// Introspection (for `pop config show` / `pop config validate`)
// ---------------------------------------------------------------------------

export interface TransportStatus {
  mode: SubgraphTierMode;
  availability: TransportAvailability;
  /** Transport that WILL serve the next query, or null if none is usable. */
  activeTier: SubgraphTierName | null;
  hasApiKey: boolean;
  paidKeyMissing: boolean;
  freeUrl?: string;
  paidUrl?: string;
  freeExhaustedUntil?: number;
  /** One-line human summary, safe to print. Never contains the API key. */
  summary: string;
}

/**
 * Describe the transport that will serve the next query on `chainId`.
 * Purely local — issues no network request. URLs are redacted.
 */
export function getTransportStatus(chainId?: number): TransportStatus {
  const plan = resolveTransportPlan(chainId);
  const activeTier = plan.attempts[0]?.tier ?? null;

  const parts: string[] = [];
  parts.push(activeTier ? `${activeTier} tier active` : 'no transport available');
  parts.push(plan.mode === 'auto' ? `mode auto (${plan.availability})` : `mode ${plan.mode} (forced)`);
  parts.push(plan.hasApiKey ? 'GRAPH_API_KEY detected' : 'no GRAPH_API_KEY');
  if (plan.paidKeyMissing) parts.push('gateway configured but unusable without a key');
  if (plan.freeExhaustedUntil) {
    const mins = Math.max(1, Math.ceil((plan.freeExhaustedUntil - nowSeconds()) / 60));
    parts.push(`free quota spent, re-probing in ~${mins}m`);
  }
  if (plan.modeOverrideIgnored) parts.push(`tier override softened: ${plan.modeOverrideIgnored}`);

  return {
    mode: plan.mode,
    availability: plan.availability,
    activeTier,
    hasApiKey: plan.hasApiKey,
    paidKeyMissing: plan.paidKeyMissing,
    freeUrl: redactSubgraphUrl(plan.freeUrl),
    paidUrl: redactSubgraphUrl(plan.paidUrl),
    ...(plan.freeExhaustedUntil ? { freeExhaustedUntil: plan.freeExhaustedUntil } : {}),
    ...(plan.modeOverrideIgnored ? { modeOverrideIgnored: plan.modeOverrideIgnored } : {}),
    summary: parts.join('; '),
  };
}
