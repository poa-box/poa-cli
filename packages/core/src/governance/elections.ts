import { ethers } from 'ethers';
import { requireRawUint } from '../amounts';
import { assertPlanScope, assertSourceBlock, assertSourceRef, Fact, PlanConsequence, PlanResult, PlanScope, requireCompleteSnapshot, SourceRef, SourceSnapshot } from '../data/facts';
import { normalizeSubjectId } from '../authority/ids';
import { ACTION_REASON } from '../authority/lifecycle';
import { AuthorityReadiness, isAuthorityReady } from '../reads/authority';
import { ExecutionCall } from '../tx/governance';
import { validateGovernanceBatches } from './capabilities';
import { authorityExecutionCall, governancePlanBlocked, PlanningFreshness, requireLivePlanningSnapshot, requirePlanningFact } from './role-planning';

export interface ElectionMemberStatus { account: string; accepted: boolean; eligible: boolean; acceptedAt: string; ruleKind: number }
export interface ElectionSubjectState { subjectId: string; kind: 'Role'; maxMembers: string; memberCount: string;
  /** Full accepted roster AND requested candidates' fresh getStatus results. */
  statuses: readonly ElectionMemberStatus[]; rulesRevision: string }
export interface ElectionContext {
  readiness: AuthorityReadiness; executorAuthorized: Fact<boolean>; paused: Fact<boolean>;
  subjects: readonly ElectionSubjectState[];
  accounts: readonly { account: string; acceptedAnywhere: Fact<boolean>; acceptedSubjectIds: Fact<readonly string[]> }[];
}
export interface RemovalChoice { account: string; ban: boolean; expectedReason: number; expectedSourceSet: number }
export interface RemovalPreflight { subjectId: string; account: string; ban: false; reason: number; sourceSet: number; status?: Omit<ElectionMemberStatus, 'account'> }
export interface BanConsent { subjectId: string; account: string; reason: number; sourceSet: number }
export interface RemovalPlanningInput {
  scope: PlanScope; freshness: PlanningFreshness; context: SourceSnapshot<ElectionContext>;
  subjectId: string; removals: readonly RemovalChoice[]; preflights: SourceSnapshot<readonly RemovalPreflight[]>;
  /** Exact reviewed durable consequences, never a default banLosers boolean. */
  confirmedBans: readonly BanConsent[];
  /** Re-submit with the previous fingerprint and NEW evidence; changed data blocks. */
  expectedFingerprint?: string;
}
function account(value: string): string {
  if (!ethers.utils.isAddress(value) || value.toLowerCase() === ethers.constants.AddressZero) throw new Error('INVALID_ELECTION_ACCOUNT');
  return value.toLowerCase();
}
export function electionPlanningFingerprint(context: ElectionContext, preflights: readonly RemovalPreflight[]): string {
  // Source scope/freshness is validated independently on every plan. Observation
  // clocks and block identity must not invalidate unchanged reviewed values.
  const values = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(values);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'source').map(([key, nested]) => [key, values(nested)]));
    return value;
  };
  return ethers.utils.id(JSON.stringify(values([context, preflights])));
}
export interface RemovalReadRequest { contract: string; subjectId: string; account: string; source: SourceRef }
export interface RemovalPreflightReader {
  canRemove(request: RemovalReadRequest & { ban: false }): Promise<SourceSnapshot<{ reason: number; sourceSet: number }>>;
  getStatus(request: RemovalReadRequest): Promise<SourceSnapshot<Omit<ElectionMemberStatus, 'account'>>>;
}
/** Concrete injected observer. Every pair ALWAYS tests canRemove(..., false),
 * including a draft ban. Host binds block/endpoint/provider; failures retain partial
 * evidence and cannot pass planner completeness gates. No signer or RPC constructor. */
export async function readRemovalPreflights(input: {
  source: SourceRef; subjectId: string; accounts: readonly string[]; reader: RemovalPreflightReader;
}): Promise<SourceSnapshot<readonly RemovalPreflight[]>> {
  assertSourceRef(input.source);
  if (input.source.indexed || input.source.snapshot !== 'pinned' || !input.source.orgId || !input.source.contract) throw new Error('PINNED_LIVE_REMOVAL_SOURCE_REQUIRED');
  const subjectId = normalizeSubjectId(input.subjectId), accounts = input.accounts.map(account);
  if (subjectId === '0' || new Set(accounts).size !== accounts.length) throw new Error('INVALID_REMOVAL_READ_REQUEST');
  const results = await Promise.allSettled(accounts.map(async a => {
    const request: RemovalReadRequest = { contract: input.source.contract!, subjectId, account: a, source: input.source };
    const [removal, status] = await Promise.all([input.reader.canRemove({ ...request, ban: false }), input.reader.getStatus(request)]);
    const scope = { chainId: input.source.chainId, orgId: input.source.orgId, contract: input.source.contract, account: a };
    for (const result of [removal, status]) {
      requireCompleteSnapshot<unknown>(result, { scope, indexed: false, snapshot: 'pinned', block: input.source.block });
      assertSourceBlock(input.source.block, result.source.block!);
    }
    return { subjectId, account: a, ban: false as const, ...removal.data, status: status.data };
  }));
  const data: RemovalPreflight[] = [], failedIds: string[] = [], receivedKeys: string[] = [];
  results.forEach((result, i) => { if (result.status === 'fulfilled') { data.push(result.value); receivedKeys.push(accounts[i]); } else failedIds.push(accounts[i]); });
  return { source: input.source, data, coverage: { status: failedIds.length ? data.length ? 'incomplete' : 'unavailable' : 'complete', expectedKeys: accounts,
    receivedKeys, missingIds: failedIds, failedIds, issues: failedIds.map(id => ({ code: 'REMOVAL_PAIR_READ_FAILED', id })) } };
}
function checkedContext(input: RemovalPlanningInput): { context: ElectionContext; subject: ElectionSubjectState; checks: readonly RemovalPreflight[] } {
  if (!input.scope.orgId || !input.scope.contract) throw new Error('ELECTION_SCOPE_REQUIRED');
  const context = requireLivePlanningSnapshot(input.context, input.scope, input.freshness);
  for (const source of [input.scope, input.context.source, input.preflights.source]) if (source.contracts?.membershipAuthority !== undefined) {
    assertPlanScope({ chainId: input.scope.chainId, contract: input.scope.contract },
      { chainId: input.scope.chainId, contract: source.contracts.membershipAuthority });
  }
  if (!isAuthorityReady(context.readiness) || context.readiness.membershipAuthority!.id!.toLowerCase() !== input.scope.contract.toLowerCase()) throw new Error('AUTHORITY_UNAVAILABLE');
  if (requirePlanningFact(context.executorAuthorized, input.context, input.scope, 'EXECUTOR_AUTHORIZATION_REQUIRED') !== true) throw new Error('EXECUTOR_AUTHORIZATION_REQUIRED');
  const paused = requirePlanningFact(context.paused, input.context, input.scope, 'PAUSE_STATE_UNAVAILABLE');
  if (typeof paused !== 'boolean' || paused) throw new Error('AUTHORITY_PAUSED_OR_UNKNOWN');
  const subjectId = normalizeSubjectId(input.subjectId);
  if (subjectId === '0') throw new Error('INVALID_ELECTION_SUBJECT');
  const subjects = new Set<string>();
  for (const s of context.subjects) {
    const id = normalizeSubjectId(s.subjectId);
    if (id === '0' || subjects.has(id) || s.kind !== 'Role' || typeof s.rulesRevision !== 'string' || !s.rulesRevision) throw new Error('INVALID_SUBJECT_STATE');
    subjects.add(id);
    requireRawUint(s.maxMembers, 32); requireRawUint(s.memberCount, 32);
    const seen = new Set<string>();
    for (const m of s.statuses) {
      const a = account(m.account);
      if (seen.has(a) || typeof m.accepted !== 'boolean' || typeof m.eligible !== 'boolean' || !Number.isInteger(m.ruleKind) || m.ruleKind < 0 || m.ruleKind > 2) throw new Error('INVALID_OR_DUPLICATE_STATUS');
      seen.add(a); requireRawUint(m.acceptedAt, 64);
    }
    if (BigInt(s.statuses.filter(m => m.accepted).length) !== BigInt(s.memberCount)) throw new Error('INCOMPLETE_ACCEPTED_ROSTER');
  }
  const subject = context.subjects.find(s => normalizeSubjectId(s.subjectId) === subjectId);
  if (!subject) throw new Error('ELECTION_SUBJECT_UNAVAILABLE');
  const checks = requireLivePlanningSnapshot(input.preflights, input.scope, input.freshness);
  // Sources can use different read methods but must attest the SAME live state.
  if (!input.context.source.block || !input.preflights.source.block) throw new Error('LIVE_BLOCK_REQUIRED');
  assertSourceBlock(input.preflights.source.block, input.context.source.block);
  assertSourceBlock(input.context.source.block, input.preflights.source.block);
  if (input.expectedFingerprint !== undefined && input.expectedFingerprint !== electionPlanningFingerprint(context, checks)) throw new Error('STALE_ELECTION_PLAN');
  return { context, subject, checks };
}
/** Non-banning canRemove first. Changed sourceSet/reason/roster invalidates a restored choice. */
export function validateRemovalPreflights(input: RemovalPlanningInput): PlanResult<readonly RemovalChoice[]> {
  const consequences: PlanConsequence[] = [];
  try {
    const { subject, checks } = checkedContext(input);
    const subjectId = normalizeSubjectId(input.subjectId);
    const choices = new Set<string>();
    const consentKeys = input.confirmedBans.map(c => JSON.stringify([normalizeSubjectId(c.subjectId), account(c.account), c.reason, c.sourceSet])).sort();
    const requiredConsent: string[] = [];
    const checksSeen = new Set<string>();
    for (const check of checks) {
      const key = normalizeSubjectId(check.subjectId) + ':' + account(check.account);
      if (checksSeen.has(key) || check.ban !== false || !Number.isInteger(check.reason) || check.reason < 0 || check.reason > 11
        || !Number.isInteger(check.sourceSet) || check.sourceSet < 0 || check.sourceSet > 15) throw new Error('INVALID_REMOVAL_PREFLIGHT');
      checksSeen.add(key);
    }
    for (const choice of input.removals) {
      const a = account(choice.account);
      if (choices.has(a) || typeof choice.ban !== 'boolean') throw new Error('INVALID_OR_DUPLICATE_REMOVAL');
      choices.add(a);
      if (!subject.statuses.some(m => account(m.account) === a && m.accepted)) throw new Error('REMOVAL_ROSTER_CHANGED');
      const check = checks.find(c => normalizeSubjectId(c.subjectId) === subjectId && account(c.account) === a);
      if (!check) throw new Error('REMOVAL_PREFLIGHT_UNAVAILABLE');
      if (check.status) {
        const current = subject.statuses.find(m => account(m.account) === a)!;
        if (check.status.accepted !== current.accepted || check.status.eligible !== current.eligible
          || check.status.acceptedAt !== current.acceptedAt || check.status.ruleKind !== current.ruleKind) throw new Error('REMOVAL_STATUS_CHANGED');
      }
      const needsBan = check.reason === ACTION_REASON.RemovalIneffective;
      if (needsBan) consequences.push({ code: 'DURABLE_GOVERNANCE_BAN', id: a, values: { subjectId, account: a, sourceSet: String(check.sourceSet), preventsReclaim: true } });
      if (check.reason !== choice.expectedReason || check.sourceSet !== choice.expectedSourceSet) throw new Error('REMOVAL_REASON_CHANGED');
      if (needsBan && !choice.ban) throw new Error('BAN_REQUIRED');
      if (!needsBan && choice.ban) throw new Error('BAN_NO_LONGER_REQUIRED');
      if (!needsBan && check.reason !== ACTION_REASON.Ok) throw new Error('REMOVAL_PREFLIGHT_REFUSED');
      if ((needsBan && check.sourceSet === 0) || (!needsBan && check.sourceSet !== 0)) throw new Error('CONTRADICTORY_REMOVAL_PREFLIGHT');
      if (needsBan) requiredConsent.push(JSON.stringify([subjectId, a, check.reason, check.sourceSet]));
    }
    requiredConsent.sort();
    if (JSON.stringify(consentKeys) !== JSON.stringify(requiredConsent)) throw new Error('EXACT_BAN_CONSENT_REQUIRED');
    return { status: 'ready', data: input.removals, consequences };
  } catch (error) { return governancePlanBlocked(error, consequences); }
}

export function planRoleRemovals(input: RemovalPlanningInput): PlanResult<ExecutionCall[][]> {
  const checked = validateRemovalPreflights(input);
  if (checked.status !== 'ready') return checked;
  try {
    if (!input.removals.length) throw new Error('EMPTY_REMOVAL_REQUEST');
    const calls = input.removals.map(c => authorityExecutionCall(input.scope.contract!, 'remove', [normalizeSubjectId(input.subjectId), account(c.account), c.ban]));
    validateGovernanceBatches([calls, []], 2);
    return { status: 'ready', data: [calls, []], consequences: checked.consequences };
  } catch (error) { return governancePlanBlocked(error, checked.consequences); }
}
export interface ElectionPlanningInput extends RemovalPlanningInput {
  candidates: readonly string[]; includeNoOneOption?: boolean; fallbackSubjectId?: string;
  /** Explicit elected-seat policy; fallback is always delegable. */
  stickyWinner: boolean;
}
/** Capacity-safe options: loser removal -> fallback -> elected winner. No One is empty. */
export function planElection(input: ElectionPlanningInput): PlanResult<ExecutionCall[][]> {
  const validated = validateRemovalPreflights(input);
  if (validated.status !== 'ready') return validated;
  try {
    const { context, subject } = checkedContext(input);
    if (!input.candidates.length || typeof input.stickyWinner !== 'boolean'
      || (input.includeNoOneOption !== undefined && typeof input.includeNoOneOption !== 'boolean')) throw new Error('INVALID_ELECTION_REQUEST');
    const candidates = input.candidates.map(account);
    if (new Set(candidates).size !== candidates.length) throw new Error('DUPLICATE_ELECTION_CANDIDATE');
    const accounts = new Map(context.accounts.map(a => [account(a.account), a]));
    if (accounts.size !== context.accounts.length) throw new Error('DUPLICATE_ACCEPTANCE_FACT');
    const fallbackId = input.fallbackSubjectId === undefined ? undefined : normalizeSubjectId(input.fallbackSubjectId);
    if (fallbackId === normalizeSubjectId(input.subjectId) || fallbackId === '0') throw new Error('INVALID_FALLBACK_SUBJECT');
    const fallback = fallbackId === undefined ? undefined : context.subjects.find(s => normalizeSubjectId(s.subjectId) === fallbackId);
    if (fallbackId !== undefined && !fallback) throw new Error('FALLBACK_SUBJECT_UNAVAILABLE');
    const acceptedAnywhere = (a: string): boolean => {
      const fact = accounts.get(a)?.acceptedAnywhere;
      const value = requirePlanningFact(fact, input.context, { ...input.scope, account: a }, 'ACCEPTANCE_ANYWHERE_UNAVAILABLE');
      if (typeof value !== 'boolean') throw new Error('ACCEPTANCE_ANYWHERE_UNAVAILABLE');
      return value;
    };
    const status = (s: ElectionSubjectState, a: string): ElectionMemberStatus => {
      const found = s.statuses.find(m => account(m.account) === a);
      if (!found) throw new Error('GET_STATUS_UNAVAILABLE');
      return found;
    };
    const batches = candidates.map(winner => {
      const winnerStatus = status(subject, winner);
      const losers = input.removals.filter(c => account(c.account) !== winner);
      const calls = losers.map(c => authorityExecutionCall(input.scope.contract!, 'remove', [normalizeSubjectId(input.subjectId), account(c.account), c.ban]));
      let fallbackCount = fallback ? BigInt(fallback.memberCount) : 0n;
      for (const loser of fallback ? losers : []) {
        const a = account(loser.account), fs = status(fallback!, a);
        if (fs.accepted) continue; // acceptance, not current eligibility
        const before = acceptedAnywhere(a);
        // If this election removes the only accepted role, _isInOrg becomes false
        // before fallback/grant. Complete fresh subject statuses prove the post-removal state.
        const ids = requirePlanningFact(accounts.get(a)?.acceptedSubjectIds, input.context, { ...input.scope, account: a }, 'POST_REMOVAL_ACCEPTANCE_UNPROVEN').map(normalizeSubjectId);
        if (new Set(ids).size !== ids.length || before !== (ids.length > 0)) throw new Error('CONTRADICTORY_ACCEPTANCE_FACT');
        const grant = ids.some(id => id !== normalizeSubjectId(input.subjectId));
        if (grant) fallbackCount++;
        calls.push(authorityExecutionCall(input.scope.contract!, grant ? 'grant' : 'offer', [fallbackId!, a, true]));
      }
      if (fallback && BigInt(fallback.maxMembers) > 0n && fallbackCount > BigInt(fallback.maxMembers)) throw new Error('FALLBACK_CAPACITY_EXCEEDED');
      if (!winnerStatus.accepted) {
        const grant = acceptedAnywhere(winner);
        const resultingCount = BigInt(subject.memberCount) - BigInt(losers.length) + (grant ? 1n : 0n);
        if (BigInt(subject.maxMembers) > 0n && resultingCount > BigInt(subject.maxMembers)) throw new Error('ELECTION_CAPACITY_EXCEEDED');
        calls.push(authorityExecutionCall(input.scope.contract!, grant ? 'grant' : 'offer', [normalizeSubjectId(input.subjectId), winner, !input.stickyWinner]));
      }
      return calls;
    });
    if (input.includeNoOneOption) batches.push([]);
    validateGovernanceBatches(batches, batches.length);
    return { status: 'ready', data: batches, consequences: [...validated.consequences,
      { code: 'ELECTION_STATE_MAY_CHANGE_BEFORE_EXECUTION', values: { fingerprint: electionPlanningFingerprint(context, input.preflights.data) } }] };
  } catch (error) { return governancePlanBlocked(error, validated.consequences); }
}
