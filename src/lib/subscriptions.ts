/**
 * Per-agent declarative subscriptions — capability-pull triage filter
 * (Task #513, HB#594-#599; MetaGPT _watch_actions borrow per #504 catalog).
 *
 * Schema + load/save for ~/.pop-agent/brain/Config/subscriptions.json.
 * Read-side-only, agent-private, NO cross-agent propagation. Composability
 * comes from independent per-agent subscription lists, not shared state.
 *
 * Question-independent layer (vigil HB#596): schema + validator + JSON I/O
 * are decoupled from the open peer-poll questions Q1-Q4 (priority key,
 * write-back atomicity choice, cache strategy, match-window). The filter
 * evaluator (subscription-filter.ts) is similarly question-independent.
 * Question-dependent layers (triage --watch flag, editing CLI, drift
 * detection) wait for peer-poll resolution.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * v1 filter language per task #513 [CONSTRAINTS]: exact-match string
 * fields + AND of multiple keys. NO regex / negation / OR / body / timestamp.
 */
export interface SubscriptionFilter {
  /** Exact equality (lowercased) on lesson.author. */
  author?: string;
  /** Exact equality (lowercased) on lesson.delegateTo. */
  delegateTo?: string;
  /** Array intersection: lesson.tags contains ANY of these tags. */
  tags?: string[];
  /** Case-insensitive substring on lesson.title. */
  titleContains?: string;
  /** Substring match on causedBy field (string OR array element). */
  causedByContains?: string;
}

export interface Subscription {
  /** Unique ID within this agent's subscriptions file. */
  id: string;
  /** Brain doc to watch (e.g. pop.brain.shared, pop.brain.projects). */
  docId: string;
  /** v1 filter object. Multiple keys = AND. Empty filter = matches all. */
  filter: SubscriptionFilter;
  /**
   * Surface priority for matched events. Default 0 (above HIGH/MEDIUM).
   * Q1 in the HB#595 peer-poll: whether to use new key PRIORITY_0 or
   * reuse CRITICAL — CLI integration layer resolves; this layer just
   * carries the agent's stated priority.
   */
  priority?: number;
  /** Optional override for drift threshold (default 10 HB cycles). */
  driftThreshold?: number;
  /** Updated by the triage layer; total cumulative matches observed. */
  matchCount?: number;
  /** Updated by the triage layer; unix-seconds timestamp of last match. */
  lastMatchAt?: number | null;
  /** Set at create time. Used for drift-age calculation. */
  createdAt?: number;
}

export interface SubscriptionsFile {
  version: number;
  subscriptions: Subscription[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const ETH_ADDR_RE = /^0x[0-9a-f]{40}$/;
const KNOWN_DOCS = new Set([
  'pop.brain.shared',
  'pop.brain.projects',
  'pop.brain.heuristics',
  'pop.brain.retros',
  'pop.brain.brainstorms',
  'pop.brain.peers',
]);

/**
 * Default path: ~/.pop-agent/brain/Config/subscriptions.json (per-agent
 * persistent runtime tier, per CLAUDE.md). Override via env for tests.
 */
export function getSubscriptionsPath(): string {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME env var not set');
  return path.join(home, '.pop-agent', 'brain', 'Config', 'subscriptions.json');
}

/** Parse + validate a subscriptions file. Returns canonical shape on success. */
export function parseSubscriptionsFile(raw: string): { result: ValidationResult; file: SubscriptionsFile | null } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    errors.push(`invalid JSON: ${e.message}`);
    return { result: { ok: false, errors, warnings }, file: null };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push('top-level must be an object with `version` and `subscriptions`');
    return { result: { ok: false, errors, warnings }, file: null };
  }
  const version = parsed.version;
  if (version !== 1) {
    errors.push(`unsupported version: ${version}; expected 1`);
    return { result: { ok: false, errors, warnings }, file: null };
  }
  const subs = parsed.subscriptions;
  if (!Array.isArray(subs)) {
    errors.push('`subscriptions` must be an array');
    return { result: { ok: false, errors, warnings }, file: null };
  }
  const seenIds = new Set<string>();
  const validatedSubs: Subscription[] = [];
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    const ctx = `subscriptions[${i}]`;
    if (s == null || typeof s !== 'object') {
      errors.push(`${ctx}: not an object`);
      continue;
    }
    if (typeof s.id !== 'string' || s.id.length === 0) {
      errors.push(`${ctx}: missing required string id`);
      continue;
    }
    if (seenIds.has(s.id)) {
      errors.push(`${ctx}: duplicate id "${s.id}"`);
      continue;
    }
    seenIds.add(s.id);
    if (typeof s.docId !== 'string' || s.docId.length === 0) {
      errors.push(`${ctx}: missing required string docId`);
      continue;
    }
    if (!KNOWN_DOCS.has(s.docId)) {
      warnings.push(`${ctx}: docId "${s.docId}" is not a standard brain doc`);
    }
    if (s.filter == null || typeof s.filter !== 'object' || Array.isArray(s.filter)) {
      errors.push(`${ctx}: filter must be an object`);
      continue;
    }
    const filterRes = validateFilter(s.filter, `${ctx}.filter`);
    errors.push(...filterRes.errors);
    warnings.push(...filterRes.warnings);
    if (filterRes.errors.length > 0) continue;
    validatedSubs.push({
      id: s.id,
      docId: s.docId,
      filter: filterRes.canonical,
      priority: typeof s.priority === 'number' ? s.priority : 0,
      driftThreshold: typeof s.driftThreshold === 'number' ? s.driftThreshold : undefined,
      matchCount: typeof s.matchCount === 'number' ? s.matchCount : 0,
      lastMatchAt: typeof s.lastMatchAt === 'number' ? s.lastMatchAt : null,
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : undefined,
    });
  }
  if (errors.length > 0) {
    return { result: { ok: false, errors, warnings }, file: null };
  }
  return {
    result: { ok: true, errors, warnings },
    file: { version: 1, subscriptions: validatedSubs },
  };
}

/** Validate + canonicalize a filter object. Lowercases addresses + tags. */
export function validateFilter(
  filter: any,
  ctx: string,
): { errors: string[]; warnings: string[]; canonical: SubscriptionFilter } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const canonical: SubscriptionFilter = {};
  const allowedKeys = new Set([
    'author',
    'delegateTo',
    'tags',
    'titleContains',
    'causedByContains',
  ]);
  for (const key of Object.keys(filter)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${ctx}: unsupported filter key "${key}" (v1 supports: ${[...allowedKeys].join(', ')})`);
    }
  }
  if (filter.author !== undefined) {
    if (typeof filter.author !== 'string' || !ETH_ADDR_RE.test(filter.author.toLowerCase())) {
      errors.push(`${ctx}.author: must be a 0x-prefixed 40-hex ethereum address`);
    } else {
      canonical.author = filter.author.toLowerCase();
    }
  }
  if (filter.delegateTo !== undefined) {
    if (typeof filter.delegateTo !== 'string' || !ETH_ADDR_RE.test(filter.delegateTo.toLowerCase())) {
      errors.push(`${ctx}.delegateTo: must be a 0x-prefixed 40-hex ethereum address`);
    } else {
      canonical.delegateTo = filter.delegateTo.toLowerCase();
    }
  }
  if (filter.tags !== undefined) {
    if (!Array.isArray(filter.tags) || !filter.tags.every((t: any) => typeof t === 'string')) {
      errors.push(`${ctx}.tags: must be an array of strings`);
    } else {
      canonical.tags = filter.tags.map((t: string) => t.toLowerCase());
    }
  }
  if (filter.titleContains !== undefined) {
    if (typeof filter.titleContains !== 'string' || filter.titleContains.length === 0) {
      errors.push(`${ctx}.titleContains: must be a non-empty string`);
    } else {
      canonical.titleContains = filter.titleContains;
    }
  }
  if (filter.causedByContains !== undefined) {
    if (typeof filter.causedByContains !== 'string' || filter.causedByContains.length === 0) {
      errors.push(`${ctx}.causedByContains: must be a non-empty string`);
    } else {
      canonical.causedByContains = filter.causedByContains;
    }
  }
  if (Object.keys(canonical).length === 0 && errors.length === 0) {
    warnings.push(`${ctx}: empty filter matches all lessons (consider narrowing)`);
  }
  return { errors, warnings, canonical };
}

/** Load + parse subscriptions.json. Returns empty file if missing. */
export function loadSubscriptions(filePath?: string): { result: ValidationResult; file: SubscriptionsFile } {
  const p = filePath ?? getSubscriptionsPath();
  if (!fs.existsSync(p)) {
    return {
      result: { ok: true, errors: [], warnings: [`subscriptions file not found at ${p}; treating as empty`] },
      file: { version: 1, subscriptions: [] },
    };
  }
  const raw = fs.readFileSync(p, 'utf8');
  const { result, file } = parseSubscriptionsFile(raw);
  if (!result.ok || !file) {
    return { result, file: { version: 1, subscriptions: [] } };
  }
  return { result, file };
}