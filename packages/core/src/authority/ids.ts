import { RawUintInput, requireRawUint } from '../amounts';
import { Fact, knownFact, PlanResult, PlanScope, requireCompleteSnapshot, SourceSnapshot, unknownFact } from '../data/facts';

export const HATS_NAMESPACE_FLOOR = 1n << 224n;
export const AUTHORITY_ADDR_SHIFT = 64n;
const SEQUENCE_MASK = (1n << 64n) - 1n;

/** Canonical decimal ID; hexadecimal strings are accepted without passing through Number. */
export function normalizeSubjectId(value: RawUintInput): string {
  return requireRawUint(typeof value === 'string' && /^0x[\da-f]+$/i.test(value) ? BigInt(value) : value);
}
function authorityAddress(value: string): string {
  if (!/^0x[\da-f]{40}$/i.test(value) || BigInt(value) === 0n) throw new Error('Nonzero authority address required');
  return value.toLowerCase();
}
export function embeddedAuthority(value: RawUintInput): string | null {
  const id = BigInt(normalizeSubjectId(value));
  return id >= HATS_NAMESPACE_FLOOR || id >> 64n === 0n ? null : `0x${(id >> 64n).toString(16).padStart(40, '0')}`;
}
export function localSequence(value: RawUintInput): string | null {
  return embeddedAuthority(value) === null ? null : (BigInt(normalizeSubjectId(value)) & SEQUENCE_MASK).toString();
}
export interface SubjectIdClassification {
  id: string;
  namespace: 'native' | 'foreign' | 'adopted' | 'structural' | 'unallocated';
  authority: string | null;
  sequence: string | null;
  userFacing: boolean;
}
export function classifySubjectId(value: RawUintInput, localAuthority?: string): SubjectIdClassification {
  const id = normalizeSubjectId(value);
  const raw = BigInt(id);
  const authority = embeddedAuthority(id);
  const local = localAuthority === undefined ? undefined : authorityAddress(localAuthority);
  const namespace = raw >= HATS_NAMESPACE_FLOOR
    ? (raw & (HATS_NAMESPACE_FLOOR - 1n)) === 0n ? 'structural' : 'adopted'
    : authority === null ? 'unallocated' : local !== undefined && authority !== local ? 'foreign' : 'native';
  return { id, namespace, authority, sequence: localSequence(id), userFacing: namespace !== 'structural' && namespace !== 'unallocated' };
}
export function composeSubjectId(authority: string, sequence: RawUintInput): string {
  const address = authorityAddress(authority);
  const seq = BigInt(requireRawUint(sequence, 64));
  if (seq === 0n) throw new Error('Subject sequence must be positive');
  return ((BigInt(address) << AUTHORITY_ADDR_SHIFT) | seq).toString();
}
export interface SubjectAllocation { subjectId: string }
export interface SubjectPrediction { subjectIds: readonly string[]; nextSequence: string; executionStable: false }
/** The complete allocation history includes adopted IDs and every locally created role/group.
 * Enumeration cannot eliminate concurrent execution or index lag. */
export function predictNextSubjectIds(input: {
  authority: string; history: SourceSnapshot<readonly SubjectAllocation[]>; scope: PlanScope; count?: number;
}): PlanResult<SubjectPrediction> {
  const consequences = [{ code: 'SUBJECT_CREATION_RACE', values: { executionStable: false } }];
  try {
    const authority = authorityAddress(input.authority);
    if (!input.scope.orgId) throw new Error('ORG_SCOPE_REQUIRED');
    const history = requireCompleteSnapshot(input.history, { scope: { ...input.scope, contract: authority } });
    const count = input.count ?? 1;
    if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw new Error('INVALID_PREDICTION_COUNT');
    let max = 0n;
    const seen = new Set<string>();
    for (const row of history) {
      const id = classifySubjectId(row.subjectId, authority);
      if (seen.has(id.id)) throw new Error('DUPLICATE_SUBJECT');
      seen.add(id.id);
      if (id.namespace === 'unallocated' || (id.namespace === 'native' && id.sequence === '0')) throw new Error('INVALID_ALLOCATION_HISTORY');
      if (id.namespace === 'native' && BigInt(id.sequence!) > max) max = BigInt(id.sequence!);
    }
    if (max + BigInt(count) > SEQUENCE_MASK) throw new Error('SUBJECT_SEQUENCE_EXHAUSTED');
    return { status: 'ready', data: { subjectIds: Array.from({ length: count }, (_, i) => composeSubjectId(authority, max + BigInt(i) + 1n)), nextSequence: (max + 1n).toString(), executionStable: false }, consequences };
  } catch (error) {
    const candidate = (error as { code?: string }).code ?? (error instanceof Error ? error.message : '');
    const code = /^[A-Z][A-Z_0-9]+$/.test(candidate) ? candidate : 'INVALID_SUBJECT_PREDICTION_INPUT';
    return { status: 'blocked', codes: [code], prerequisites: [{ code }], consequences };
  }
}
export interface SubjectCreationProposal {
  id: string; createsSubject?: boolean; actionSummaries?: readonly string[];
  executed?: boolean; wasExecuted?: boolean; status?: string;
}
export function subjectCreationRaceFacts(history: SourceSnapshot<readonly SubjectCreationProposal[]>, scope: PlanScope): {
  competingIds: readonly string[]; hasCompetingCreation: Fact<boolean>; executionStable: false;
} {
  const competingIds: string[] = [];
  try {
    const proposals = requireCompleteSnapshot(history, { scope });
    let unresolved = false;
    for (const row of proposals) {
      // Expiration alone is never settlement: a closed poll can still execute its batch.
      const contradicted = (row.executed === true && row.wasExecuted === false) || (row.wasExecuted === true && row.executed === false);
      const provenExecuted = !contradicted && (row.executed === true || row.wasExecuted === true
        || (row.status === 'Executed' && row.executed !== false && row.wasExecuted !== false));
      // Serving HV status Executed follows ProposalExecuted/Winner(executed=true).
      // Ended can follow a failed, retryable batch; Succeeded is not a served status.
      if (provenExecuted) continue;
      const detected = row.createsSubject ?? (row.actionSummaries?.some(s => /^create the (role|group)\b/i.test(s.trim())) ? true : undefined);
      if (detected === true) competingIds.push(row.id);
      else if (detected === undefined) unresolved = true;
    }
    return { competingIds, hasCompetingCreation: unresolved ? unknownFact('PROPOSAL_CREATION_UNRESOLVED', history.source) : knownFact(competingIds.length > 0, history.source), executionStable: false };
  } catch { return { competingIds, hasCompetingCreation: unknownFact('INCOMPLETE_PROPOSAL_HISTORY', history.source), executionStable: false }; }
}
