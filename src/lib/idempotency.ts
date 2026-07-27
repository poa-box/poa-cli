/**
 * Idempotency cache for on-chain write commands — task #369 (HB#213).
 *
 * ## The HB#211 failure mode
 *
 * vigil_01 created duplicate on-chain proposals #55 and #56 for the same
 * PR #14 merge because:
 *
 *   1. First `pop vote create` ran via background task (run_in_background=true)
 *   2. Background task's stdout file was initially empty
 *   3. Agent read the empty file, assumed the call failed, retried
 *   4. Both calls landed → two identical proposals #55 and #56
 *   5. Both expired with 0 votes over 12+ hours
 *   6. HB#212 had to announce both to clear state
 *   7. HB#373 discovered the triangular stuck state (announce=AlreadyExecuted,
 *      execute=Active, vote=PastWindow) as a secondary consequence
 *
 * The root cause is agent discipline (retry-before-verify), but the
 * side effect is real on-chain state that can't be undone. Vigil's brain
 * lesson `background-retry-duplicate-on-chain-writes-hb-211-failure-mode-and-fix`
 * documents the agent-discipline side. This module is the CLI-level
 * defense-in-depth.
 *
 * ## Fix shape
 *
 * A small file-backed cache that sits between the CLI's argument parse
 * and the actual `executeTx` call. When a write command runs, it:
 *
 *   1. Computes a deterministic cache key from { orgId, commandName,
 *      idempotencyKey } where idempotencyKey is either (a) passed
 *      explicitly via `--idempotency-key <str>` or (b) auto-derived
 *      from hash(JSON-serialized argv minus transient fields like
 *      --private-key, --dry-run, --yes).
 *   2. Checks the cache for a non-expired entry. See "Why 15 minutes"
 *      below.
 *   3. If a cache hit: returns the prior result without re-submitting
 *      the transaction. Caller prints the cached fields and exits 0.
 *   4. If no cache hit: caller submits the tx; on success, caller
 *      writes the fresh entry via `recordIdempotentResult`.
 *
 * ## Why 15 minutes
 *
 * The TTL matches the Argus heartbeat cadence. The heartbeat runs every
 * 15 minutes, so the cache window is exactly one heartbeat. The
 * agent-discipline rule of thumb is: "one command per concept per
 * heartbeat." If the same write happens twice within one heartbeat, it
 * is almost certainly a retry, not an intentional duplicate. If it
 * happens in two different heartbeats, the agent has deliberately
 * decided to re-run it, and the cache expiring on the heartbeat
 * boundary lines up with that mental model.
 *
 * Tradeoffs considered:
 *   - **Shorter (1-5 min)**: would cover the HB#211 bug (retries happen
 *     within seconds) but leaves narrow margin for clock drift, slow
 *     chain confirmation, or RPC hiccups. A retry that slipped 6 min
 *     after the first call would get through.
 *   - **Longer (1 hour+)**: blocks legitimate re-use of the same
 *     command template (e.g. re-issuing a failed proposal with tweaks)
 *     for too long, encouraging operators to pass --no-idempotency
 *     reflexively, which defeats the guard.
 *   - **15 min**: wide enough to catch every realistic retry pattern,
 *     narrow enough that a deliberate re-run in the next heartbeat
 *     just works. Also aligns with the heartbeat cadence so the
 *     operator's mental model ("one action per heartbeat") maps
 *     cleanly onto the cache semantics.
 *
 * ## What this does NOT cover
 *
 *   - **On-chain state already corrupted** before the cache shipped —
 *     duplicate proposals #55 and #56 remain as permanent stale
 *     records on Argus DAO. The cache cannot unstick existing state.
 *   - **Cross-agent duplicates** — the cache is local to one
 *     POP_AGENT_HOME. If argus and vigil both independently try the
 *     same write, they hit two different caches. Mitigation in practice
 *     is proposal-title uniqueness felt at governance review time.
 *   - **Truly concurrent retries** — if call 1 has not yet recorded
 *     its result to the cache when call 2 starts, both race through.
 *     Rare in practice: agent retries are always separated by at least
 *     the time it takes to read an empty stdout, form a new tool call,
 *     and issue it (several seconds minimum).
 *   - **Commands not wired to consult the cache** — only the write
 *     commands explicitly wired (all of them after #369 + #370 + #374)
 *     get protection. New write commands must call
 *     `checkIdempotencyCache` + `recordIdempotentResult` to opt in.
 *
 * ## Escape hatches
 *
 *   - `--no-idempotency` on any wired command bypasses the check
 *     entirely. Use when you intentionally want a duplicate write.
 *   - `--idempotency-key "<str>"` overrides the auto-derived argv
 *     hash with an explicit key. Use when you want two structurally
 *     different commands to be treated as the same logical action
 *     (or two structurally identical commands to be treated as
 *     different actions — pass a distinct key).
 *
 * ## Storage
 *
 * The cache lives at `$POP_AGENT_HOME/idempotency-cache.json` where
 * POP_AGENT_HOME defaults to `~/.pop-agent`. Each agent home has its
 * own cache so argus / vigil / sentinel don't collide. The file is
 * JSON so an operator can hand-inspect or manually evict entries
 * without tooling.
 *
 * ## Coverage (after the #369 → #370 → #374 rollout)
 *
 *   - Writes:    `pop vote create`, `pop vote cast`,
 *                `pop task create`, `pop task claim`, `pop task submit`,
 *                `pop task review`, `pop brain append-lesson`,
 *                `pop brain edit-lesson`, `pop brain remove-lesson`,
 *                `pop brain tag`
 *   - Not wired: read-only commands (reads are safe to retry), brain
 *                daemon-routed writes via routedDispatch (different
 *                invariants — the daemon's post-connect failure rule
 *                covers the same ground at a different layer),
 *                treasury operations pending explicit review.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';

const DEFAULT_TTL_SECONDS = 15 * 60; // 15 minutes — see module header

/**
 * Resolve the effective TTL in seconds.
 * Priority: explicit param → POP_IDEMPOTENCY_TTL_MINUTES env → 15 min.
 * Invalid or non-positive values fall through to the next tier.
 */
export function resolveTtlSeconds(ttlSeconds?: number): number {
  if (ttlSeconds !== undefined && Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    return Math.floor(ttlSeconds);
  }
  const envMinutes = process.env.POP_IDEMPOTENCY_TTL_MINUTES;
  if (envMinutes) {
    const minutes = parseInt(envMinutes, 10);
    if (Number.isFinite(minutes) && minutes > 0) return minutes * 60;
  }
  return DEFAULT_TTL_SECONDS;
}

/**
 * On-disk cache shape. Not exported — callers use the functions below.
 */
interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

interface CacheEntry {
  /** When this entry was written, unix-seconds. Used for TTL eviction. */
  ts: number;
  /** TTL (seconds) in effect when the entry was recorded. Older cache
   *  files predate this field, so eviction falls back to the default
   *  when absent. */
  ttlSeconds?: number;
  /** The original cache-key-components, for audit purposes. */
  orgId: string;
  command: string;
  /** Result captured when the write succeeded. Shape is whatever the
   *  caller wants to remember — typically { txHash, proposalId } or
   *  { txHash, taskId, ipfsCid }. Free-form so we can reuse for new
   *  commands without schema migrations. */
  result: Record<string, any>;
}

/**
 * Where the cache file lives. Respects POP_AGENT_HOME env var so
 * multi-agent setups (argus / vigil / sentinel) each have their own.
 */
function getCachePath(): string {
  const agentHome = process.env.POP_AGENT_HOME || path.join(os.homedir(), '.pop-agent');
  return path.join(agentHome, 'idempotency-cache.json');
}

/**
 * Load the cache file. Returns a fresh empty cache if the file does
 * not exist or is corrupt — corruption is a silent recovery case
 * because losing a 15-minute cache is strictly less bad than crashing
 * a legitimate write.
 */
function loadCache(): CacheFile {
  const p = getCachePath();
  try {
    if (!fs.existsSync(p)) return { version: 1, entries: {} };
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed && parsed.version === 1 && parsed.entries) return parsed;
    return { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveCache(cache: CacheFile): void {
  const p = getCachePath();
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch {
    // Best-effort. If we can't save, the next call may duplicate — but
    // that's the same as pre-#369 behavior. Don't crash the write.
  }
}

/**
 * Compute the deterministic cache key from the caller's components.
 *
 * Explicit-key callers pass their `--idempotency-key` value directly.
 * Auto-key callers pass a stable JSON-serialized view of their argv
 * (with transient fields stripped — see stripTransient below) and
 * this function hashes it.
 */
export function computeCacheKey(
  orgId: string,
  commandName: string,
  idempotencyKey: string,
): string {
  const digest = createHash('sha256')
    .update(`${orgId}\0${commandName}\0${idempotencyKey}`)
    .digest('hex')
    .slice(0, 32);
  return `${commandName}:${digest}`;
}

/**
 * Strip transient argv fields that shouldn't affect the auto-derived
 * idempotency key. `--private-key` changes per agent session but
 * should not fork two separate cache entries. `--dry-run` and `--yes`
 * are UX flags, not content. Same for `--json` (output format) and
 * `--verbose` (diagnostics).
 */
const TRANSIENT_ARGV_KEYS = new Set([
  'privateKey',
  'private-key',
  'dryRun',
  'dry-run',
  'yes',
  'y',
  'json',
  'verbose',
  'v',
  'help',
  'version',
  '_',
  '$0',
  'idempotencyKey',
  'idempotency-key',
  'noIdempotency',
  'no-idempotency',
  'quiet',
  'q',
  'no-preflight',
  'noPreflight',
  'preflight',
  'idempotency-ttl',
  'idempotencyTtl',
]);

/**
 * Normalize argv into a stable JSON string for auto-key derivation.
 * Keys are sorted so two calls with the same content but different
 * argument order hash to the same key.
 */
export function argvToIdempotencyString(argv: Record<string, any>): string {
  const filtered: Record<string, any> = {};
  for (const [k, v] of Object.entries(argv)) {
    if (TRANSIENT_ARGV_KEYS.has(k)) continue;
    if (typeof v === 'function') continue;
    if (v === undefined) continue;
    filtered[k] = v;
  }
  // Sort keys for determinism
  const sortedKeys = Object.keys(filtered).sort();
  const obj: Record<string, any> = {};
  for (const k of sortedKeys) obj[k] = filtered[k];
  return JSON.stringify(obj);
}

/**
 * Check whether an idempotent result already exists for this call.
 * Returns the cached result (unwrapped) on hit, or null on miss.
 * Expired entries (older than TTL) are treated as misses and pruned.
 *
 * TTL resolution: explicit `ttlSeconds` param → POP_IDEMPOTENCY_TTL_MINUTES
 * env → 15 minutes (see resolveTtlSeconds).
 */
export function checkIdempotencyCache(
  orgId: string,
  commandName: string,
  idempotencyKey: string,
  ttlSeconds?: number,
): Record<string, any> | null {
  const cacheKey = computeCacheKey(orgId, commandName, idempotencyKey);
  const cache = loadCache();
  const entry = cache.entries[cacheKey];
  if (!entry) return null;
  const nowSecs = Math.floor(Date.now() / 1000);
  if (nowSecs - entry.ts > resolveTtlSeconds(ttlSeconds)) {
    // Expired — prune silently so the cache file doesn't accumulate
    delete cache.entries[cacheKey];
    saveCache(cache);
    return null;
  }
  return entry.result;
}

/**
 * Record a successful write result for later idempotency checks.
 * Also prunes any expired entries at the same time to keep the cache
 * from growing unboundedly.
 */
export function recordIdempotentResult(
  orgId: string,
  commandName: string,
  idempotencyKey: string,
  result: Record<string, any>,
  ttlSeconds?: number,
): void {
  const cacheKey = computeCacheKey(orgId, commandName, idempotencyKey);
  const cache = loadCache();
  const nowSecs = Math.floor(Date.now() / 1000);

  // Prune expired entries while we have the file open. Each entry is
  // judged against the TTL it was recorded with (pre-TTL-field entries
  // fall back to the default).
  for (const [k, e] of Object.entries(cache.entries)) {
    if (nowSecs - e.ts > (e.ttlSeconds ?? DEFAULT_TTL_SECONDS)) delete cache.entries[k];
  }

  cache.entries[cacheKey] = {
    ts: nowSecs,
    ttlSeconds: resolveTtlSeconds(ttlSeconds),
    orgId,
    command: commandName,
    result,
  };
  saveCache(cache);
}

/**
 * Test-only hook: clear the cache file. Useful for vitest setup/teardown.
 * Not exported from the main barrel — callers import it explicitly.
 */
export function _clearIdempotencyCacheForTest(): void {
  const p = getCachePath();
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // Best-effort
  }
}
