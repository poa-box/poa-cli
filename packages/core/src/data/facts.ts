import { requireRawUint } from '../amounts';

export interface SourceBlock {
  number: string;
  hash?: string;
  /** Unix seconds, never milliseconds. */
  timestamp?: string;
}

export interface PlanScope {
  chainId: number;
  orgId?: string;
  account?: string;
  contract?: string;
  contracts?: Readonly<Record<string, string>>;
  endpoint?: string;
  method?: string;
}

export interface SourceRef extends PlanScope {
  endpoint: string;
  method: string;
  /** Graph/indexed evidence is never silently promoted to a live RPC read. */
  indexed: boolean;
  /** Capability/selection, not proof that queried fields are populated. */
  snapshot: 'pinned' | 'latest' | 'unsupported' | 'unknown';
  block?: SourceBlock;
  /** Explicit Unix seconds supplied by the observer. */
  observedAt?: number;
}

export type Fact<T> =
  | { state: 'known'; value: T; source?: SourceRef }
  | { state: 'unknown'; code: string; source?: SourceRef };

export function knownFact<T>(value: T, source?: SourceRef): Fact<T> {
  return { state: 'known', value, ...(source ? { source } : {}) };
}

export function unknownFact<T = never>(code: string, source?: SourceRef): Fact<T> {
  if (!code) throw new Error('Unknown fact requires a code');
  return { state: 'unknown', code, ...(source ? { source } : {}) };
}

export interface EvidenceIssue {
  code: string;
  id?: string;
}

export interface Coverage {
  status: 'complete' | 'incomplete' | 'unavailable';
  /** Omit only when the key universe is unknown (e.g. cursor discovery). */
  expectedKeys?: readonly string[];
  receivedKeys: readonly string[];
  missingIds: readonly string[];
  failedIds: readonly string[];
  issues: readonly EvidenceIssue[];
  cursor?: string;
  cap?: number;
  pages?: number;
}

export interface SourceSnapshot<T> {
  source: SourceRef;
  data: T;
  coverage: Coverage;
}

export interface PlanPrerequisite extends EvidenceIssue {
  scope?: PlanScope;
}

export interface PlanConsequence extends EvidenceIssue {
  values?: Readonly<Record<string, string | boolean>>;
}

/** Protocol codes/data only. UI copy and execution lifecycle belong to hosts. */
export type PlanResult<T> =
  | { status: 'ready'; data: T; consequences: readonly PlanConsequence[] }
  | { status: 'blocked'; codes: readonly string[]; prerequisites: readonly PlanPrerequisite[]; consequences: readonly PlanConsequence[] };

export class SnapshotValidationError extends Error {
  constructor(public readonly code: string, public readonly field?: string) {
    super(field ? `${code}: ${field}` : code);
    this.name = 'SnapshotValidationError';
  }
}

function scopedEqual(a: string, b: string): boolean {
  return /^0x[\da-f]+$/i.test(a) && /^0x[\da-f]+$/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function assertSourceRef(source: SourceRef): void {
  if (!source || !Number.isSafeInteger(source.chainId) || source.chainId <= 0) throw new SnapshotValidationError('INVALID_SOURCE', 'chainId');
  for (const field of ['endpoint', 'method'] as const) {
    if (typeof source[field] !== 'string' || !source[field].trim() || source[field].trim() !== source[field]) {
      throw new SnapshotValidationError('INVALID_SOURCE', field);
    }
  }
  if (typeof source.indexed !== 'boolean' || !['pinned', 'latest', 'unsupported', 'unknown'].includes(source.snapshot)) {
    throw new SnapshotValidationError('INVALID_SOURCE', 'provenance');
  }
  for (const field of ['orgId', 'account', 'contract'] as const) {
    if (source[field] !== undefined && (typeof source[field] !== 'string' || !source[field]?.trim())) throw new SnapshotValidationError('INVALID_SOURCE', field);
    if (field !== 'orgId' && source[field] !== undefined && !/^0x[\da-fA-F]{40}$/.test(source[field]!)) throw new SnapshotValidationError('INVALID_SOURCE', field);
  }
  for (const [key, address] of Object.entries(source.contracts ?? {})) {
    if (!key || !/^0x[\da-fA-F]{40}$/.test(address)) throw new SnapshotValidationError('INVALID_SOURCE', `contracts.${key}`);
  }
  if (source.observedAt !== undefined && (!Number.isSafeInteger(source.observedAt) || source.observedAt < 0)) throw new SnapshotValidationError('INVALID_SOURCE', 'observedAt');
  if (source.snapshot === 'pinned' && !source.block) throw new SnapshotValidationError('INVALID_SOURCE', 'block');
  if (source.block) {
    requireRawUint(source.block.number);
    if (source.block.timestamp !== undefined) requireRawUint(source.block.timestamp);
    if (source.block.hash !== undefined && !/^0x[\da-fA-F]{64}$/.test(source.block.hash)) throw new SnapshotValidationError('INVALID_SOURCE', 'block.hash');
  }
}

/** Every explicitly expected dimension must be present and match. */
export function assertPlanScope(actual: PlanScope, expected: PlanScope): void {
  if (!actual || !expected || !Number.isSafeInteger(expected.chainId) || expected.chainId <= 0 || actual.chainId !== expected.chainId) {
    throw new SnapshotValidationError('SCOPE_MISMATCH', 'chainId');
  }
  for (const field of ['orgId', 'account', 'contract', 'endpoint', 'method'] as const) {
    const want = expected[field];
    if (want !== undefined && (typeof want !== 'string' || !want.trim() || typeof actual[field] !== 'string' || !scopedEqual(actual[field]!, want))) {
      throw new SnapshotValidationError('SCOPE_MISMATCH', field);
    }
  }
  for (const [key, want] of Object.entries(expected.contracts ?? {})) {
    const got = actual.contracts?.[key];
    if (!want || typeof got !== 'string' || !scopedEqual(got, want)) throw new SnapshotValidationError('SCOPE_MISMATCH', `contracts.${key}`);
  }
}

export interface SnapshotRequirements {
  scope?: PlanScope;
  indexed?: boolean;
  snapshot?: SourceRef['snapshot'];
  block?: SourceBlock;
  requiredKeys?: readonly string[];
}

/** Compare every explicitly requested block dimension using exact raw units. */
export function assertSourceBlock(actual: SourceBlock | undefined, expected: SourceBlock): void {
  if (!actual || requireRawUint(actual.number) !== requireRawUint(expected.number)
    || (expected.hash !== undefined && actual.hash?.toLowerCase() !== expected.hash.toLowerCase())
    || (expected.timestamp !== undefined && (actual.timestamp === undefined || requireRawUint(actual.timestamp) !== requireRawUint(expected.timestamp)))) {
    throw new SnapshotValidationError('BLOCK_MISMATCH');
  }
}

export function assertCoverage(coverage: Coverage): void {
  if (!coverage || !['complete', 'incomplete', 'unavailable'].includes(coverage.status)) throw new SnapshotValidationError('INVALID_COVERAGE', 'status');
  for (const field of ['receivedKeys', 'missingIds', 'failedIds'] as const) {
    if (!Array.isArray(coverage[field]) || coverage[field].some(key => typeof key !== 'string' || !key)) throw new SnapshotValidationError('INVALID_COVERAGE', field);
  }
  if (coverage.expectedKeys !== undefined && (!Array.isArray(coverage.expectedKeys) || coverage.expectedKeys.some(key => typeof key !== 'string' || !key))) throw new SnapshotValidationError('INVALID_COVERAGE', 'expectedKeys');
  if (!Array.isArray(coverage.issues) || coverage.issues.some(issue => !issue || typeof issue.code !== 'string' || !issue.code)) throw new SnapshotValidationError('INVALID_COVERAGE', 'issues');
  for (const field of ['cap', 'pages'] as const) {
    const value = coverage[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new SnapshotValidationError('INVALID_COVERAGE', field);
  }
  if (coverage.cursor !== undefined && typeof coverage.cursor !== 'string') throw new SnapshotValidationError('INVALID_COVERAGE', 'cursor');
}

/** Transport coverage gate only; inspect/narrow each protocol Fact separately. */
export function requireCompleteSnapshot<T>(snapshot: SourceSnapshot<T>, requirements: SnapshotRequirements = {}): T {
  assertSourceRef(snapshot.source);
  if (requirements.scope) assertPlanScope(snapshot.source, requirements.scope);
  const coverage = snapshot.coverage;
  assertCoverage(coverage);
  if (coverage.status !== 'complete') throw new SnapshotValidationError('INCOMPLETE_SNAPSHOT');
  if (coverage.missingIds.length || coverage.failedIds.length || coverage.issues.length
    || new Set(coverage.receivedKeys).size !== coverage.receivedKeys.length
    || (coverage.expectedKeys !== undefined && new Set(coverage.expectedKeys).size !== coverage.expectedKeys.length)
    || (coverage.expectedKeys ?? []).some(key => !coverage.receivedKeys.includes(key))
    || (requirements.requiredKeys ?? []).some(key => !coverage.receivedKeys.includes(key))) {
    throw new SnapshotValidationError('INCONSISTENT_COVERAGE');
  }
  if (requirements.indexed !== undefined && snapshot.source.indexed !== requirements.indexed) throw new SnapshotValidationError('SOURCE_KIND_MISMATCH');
  if (requirements.snapshot !== undefined && snapshot.source.snapshot !== requirements.snapshot) throw new SnapshotValidationError('SNAPSHOT_CAPABILITY_MISMATCH');
  if (requirements.block) assertSourceBlock(snapshot.source.block, requirements.block);
  return snapshot.data;
}
