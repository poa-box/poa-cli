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
import { matchesFilter, type LessonForMatch } from './subscription-filter';

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
   * Per Q1 peer-poll resolution (sentinel HB#968): new key PRIORITY_0
   * above HIGH; CRITICAL reserved for system-critical (gas-empty,
   * daemon-down). CLI integration layer resolves; this layer just
   * carries the agent's stated priority.
   */
  priority?: number;
  /** Optional override for drift threshold. Default 50 HB cycles
   *  (~12.5h at 15-min cadence). Picked to be sane-default for
   *  slow-moving topics; fast-moving subscriptions can override
   *  explicitly. Per sentinel HB#968 META. */
  driftThreshold?: number;
  /** Updated by the triage layer; total cumulative matches observed. */
  matchCount?: number;
  /** Updated by the triage layer; unix-seconds timestamp of last match.
   *  Used for human-readable drift-age display + as fallback when
   *  lastMatchedLessonId is null. */
  lastMatchAt?: number | null;
  /** Updated by the triage layer; lesson id of the most recent match.
   *  PRIMARY state-tracking field for "match window only-new" semantics
   *  (Q4 peer-poll resolution per sentinel HB#968). Lesson IDs are
   *  deterministic + comparable; timestamp comparison fights clock skew
   *  + gossipsub delays + Automerge merge ordering. Reset to null on
   *  filter-widening edits (the editing CLI handles the reset). */
  lastMatchedLessonId?: string | null;
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
      lastMatchedLessonId:
        typeof s.lastMatchedLessonId === 'string' ? s.lastMatchedLessonId : null,
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
  // HB#636 GAP 2 (vigil HB#605 #513): defensive input bounds on the filter
  // side, parallel to MATCH_LIMITS on the matcher side. Filters live in
  // ~/.pop-agent/brain/Config/subscriptions.json; misconfiguration or
  // accidental copy-paste of a huge string shouldn't slow every heartbeat
  // cycle. Caps calibrated for typical filter content (short tag names,
  // human-authored substring patterns).
  const FILTER_LIMITS = {
    MAX_TAGS: 20,
    MAX_TAG_CHARS: 64,
    MAX_SUBSTRING_CHARS: 256,
  } as const;
  if (filter.tags !== undefined) {
    if (!Array.isArray(filter.tags) || !filter.tags.every((t: any) => typeof t === 'string')) {
      errors.push(`${ctx}.tags: must be an array of strings`);
    } else if (filter.tags.length > FILTER_LIMITS.MAX_TAGS) {
      errors.push(`${ctx}.tags: max ${FILTER_LIMITS.MAX_TAGS} tags per filter (got ${filter.tags.length})`);
    } else if (filter.tags.some((t: string) => t.length > FILTER_LIMITS.MAX_TAG_CHARS)) {
      errors.push(`${ctx}.tags: each tag max ${FILTER_LIMITS.MAX_TAG_CHARS} chars`);
    } else if (filter.tags.some((t: string) => t.length === 0)) {
      errors.push(`${ctx}.tags: tags must be non-empty strings`);
    } else {
      canonical.tags = filter.tags.map((t: string) => t.toLowerCase());
    }
  }
  if (filter.titleContains !== undefined) {
    if (typeof filter.titleContains !== 'string' || filter.titleContains.length === 0) {
      errors.push(`${ctx}.titleContains: must be a non-empty string`);
    } else if (filter.titleContains.length > FILTER_LIMITS.MAX_SUBSTRING_CHARS) {
      errors.push(`${ctx}.titleContains: max ${FILTER_LIMITS.MAX_SUBSTRING_CHARS} chars (got ${filter.titleContains.length})`);
    } else {
      canonical.titleContains = filter.titleContains;
    }
  }
  if (filter.causedByContains !== undefined) {
    if (typeof filter.causedByContains !== 'string' || filter.causedByContains.length === 0) {
      errors.push(`${ctx}.causedByContains: must be a non-empty string`);
    } else if (filter.causedByContains.length > FILTER_LIMITS.MAX_SUBSTRING_CHARS) {
      errors.push(`${ctx}.causedByContains: max ${FILTER_LIMITS.MAX_SUBSTRING_CHARS} chars (got ${filter.causedByContains.length})`);
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

/**
 * Pure-function subscription evaluator (Task #513, HB#600 refactor per
 * argus HB#702-correction finding 3).
 *
 * Inputs: subscriptions file + cached docs (read once by caller, e.g.,
 * triage.ts processSubscriptions wrapper) + opts (allMatches override,
 * heartbeatIntervalMinutes for drift detection cycle calc — fixes
 * argus HB#702-correction finding 2).
 *
 * Outputs: evaluation actions (subscription-match PRIORITY_0 + drift
 * INFO) + mutated flag (caller saves atomically when true).
 *
 * The match logic, only-new gating (Q4 lastMatchedLessonId), drift
 * detection, priority assignment, and mutation tracking all live here
 * as pure logic — testable without mocking helia/brain CRDT.
 */
export interface EvaluateOpts {
  /** Override Q4 only-new gate; surface every match each call. Default false. */
  allMatches?: boolean;
  /** HB cadence in minutes for drift cycle calc. Default 15. */
  heartbeatIntervalMinutes?: number;
  /** Override "now" for deterministic testing. Default Date.now()/1000. */
  nowSecs?: number;
}

export interface EvaluateAction {
  priority: 'PRIORITY_0' | 'INFO';
  type: 'subscription-match' | 'subscription-drift';
  detail: string;
  data: any;
}

export function evaluateSubscriptions(
  file: SubscriptionsFile,
  docs: Map<string, { lessons?: any[] } | undefined>,
  opts: EvaluateOpts = {},
): { actions: EvaluateAction[]; mutated: boolean } {
  const allMatches = !!opts.allMatches;
  const heartbeatIntervalMinutes = opts.heartbeatIntervalMinutes ?? 15;
  const nowSecs = opts.nowSecs ?? Math.floor(Date.now() / 1000);
  const cycleSecs = heartbeatIntervalMinutes * 60;

  const actions: EvaluateAction[] = [];
  let mutated = false;

  for (const sub of file.subscriptions) {
    const doc = docs.get(sub.docId);
    if (!doc) continue;
    const lessons: any[] = Array.isArray(doc.lessons) ? doc.lessons : [];
    if (lessons.length === 0) continue;

    // Filter + sort by timestamp asc so latest matched id is the LAST entry.
    const matched = lessons
      .filter((l) => l && !l.removed && l.id && matchesFilter(sub.filter, l as LessonForMatch))
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

    if (matched.length === 0) {
      // Drift detection: WARN-equivalent INFO when 0 matches over driftThreshold cycles.
      const driftThresholdHB = sub.driftThreshold ?? 50;
      if (sub.lastMatchAt != null) {
        const ageSecs = nowSecs - sub.lastMatchAt;
        const cycles = Math.floor(ageSecs / cycleSecs);
        if (cycles >= driftThresholdHB) {
          actions.push({
            priority: 'INFO',
            type: 'subscription-drift',
            detail: `Subscription "${sub.id}" has 0 matches in last ${cycles} HB cycles (threshold: ${driftThresholdHB}). Review or remove?`,
            data: { subscriptionId: sub.id, driftCycles: cycles },
          });
        }
      }
      continue;
    }

    // Q4 only-new gate: surface only lessons newer than lastMatchedLessonId.
    let newMatches = matched;
    if (!allMatches && sub.lastMatchedLessonId) {
      const lastIdx = matched.findIndex((l) => l.id === sub.lastMatchedLessonId);
      if (lastIdx >= 0) {
        newMatches = matched.slice(lastIdx + 1);
      }
      // If lastMatchedLessonId is no longer in the doc (removed, or filter
      // widened to include older lessons), surface ALL matches — newMatches
      // stays as `matched`.
    }

    if (newMatches.length === 0) continue;

    // Update subscription state with the most recent matched id +
    // increment cumulative matchCount. Mutated=true triggers atomic write-back.
    const latestMatched = newMatches[newMatches.length - 1];
    sub.lastMatchedLessonId = latestMatched.id;
    sub.lastMatchAt = latestMatched.timestamp ?? nowSecs;
    sub.matchCount = (sub.matchCount ?? 0) + newMatches.length;
    mutated = true;

    // Per Q1 peer-poll resolution: PRIORITY_0 is the user-elevated key.
    // Future v2 may surface lower-priority subscriptions as HIGH/MEDIUM
    // by reading sub.priority; for v1 all matches surface as PRIORITY_0.
    // TODO: v2 multi-priority subscription levels (use sub.priority).
    const priority: 'PRIORITY_0' = 'PRIORITY_0';

    const titles = newMatches
      .map((l) => l.title)
      .filter(Boolean)
      .slice(0, 3);
    const moreCount = newMatches.length - titles.length;
    const titleStr =
      titles.join('; ') + (moreCount > 0 ? ` (+${moreCount} more)` : '');

    actions.push({
      priority,
      type: 'subscription-match',
      detail: `Subscription "${sub.id}" matched ${newMatches.length} lesson(s): ${titleStr}`,
      data: {
        subscriptionId: sub.id,
        docId: sub.docId,
        lessonIds: newMatches.map((l) => l.id),
        matchCount: sub.matchCount,
      },
    });
  }

  return { actions, mutated };
}

/**
 * Atomic write-back of subscriptions.json. Q2 peer-poll resolution
 * (sentinel HB#968): write-tmp-with-pid+timestamp, fs.renameSync
 * (POSIX atomic), cleanup-on-failure. Pattern reused from
 * src/lib/brain.ts saveHeadsManifestV2().
 *
 * Concurrent edit IS realistic for subscriptions.json — heartbeat
 * triage --watch updates matchCount + lastMatchedLessonId on every
 * fire (every 15 min) AND the editing CLI (subscribe/unsubscribe)
 * mutates the same file. Atomic rename means readers always see a
 * complete file, never a half-written one.
 */
export function saveSubscriptions(file: SubscriptionsFile, filePath?: string): void {
  const finalPath = filePath ?? getSubscriptionsPath();
  // Ensure Config directory exists. ~/.pop-agent/brain/Config/ may not exist
  // on first write for an agent that has never had subscriptions before.
  const configDir = path.dirname(finalPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(file, null, 2));
  try {
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    // Best-effort cleanup if the rename failed (per saveHeadsManifestV2 pattern).
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}