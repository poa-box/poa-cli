import { RawUintInput, requireRawUint } from '../amounts';
import { assertPlanScope, assertSourceBlock, Fact, knownFact, PlanScope, requireCompleteSnapshot, SourceSnapshot, unknownFact } from '../data/facts';
import { projectAuthorityMembership } from '../reads/authority';
import { normalizeSubjectId } from './ids';
import { AuthorityMemberFact, AuthorityPermissionData, projectSubjectMembership } from './permissions';

/** Numeric values are the AccessV2Types enums, not UI reason strings. */
export const ACTION_REASON = { Ok: 0, UnknownSubject: 1, NotInOrg: 2, AlreadyMember: 3, NotMember: 4, SubjectFull: 5,
  BlockedByGovernanceBan: 6, RemovalIneffective: 7, NotYetActive: 8, NoRuleToClaim: 9, RenouncedClaimable: 10, Paused: 11 } as const;
/** Enum indices: a sourceSet uses 1 << index. */
export const ELIG_SOURCE = { DefaultAllow: 0, VouchQuorum: 1, EmailVerified: 2, StickyGovernanceGrant: 3 } as const;
export const LINT_CODE = { None: 0, QuorumNoOp: 1, VouchWithMaxMembers: 2, DefaultAllowStrongPerms: 3, GroupFanout: 4, SelfVoucher: 5 } as const;
export const RULE_KIND = { None: 0, Grant: 1, Ban: 2 } as const;
export const RULE_AUTHOR = { Governance: 0, Delegated: 1 } as const;
export const PENDING_KIND = { Grant: 0, Offer: 1, Remove: 2 } as const;
export interface AuthorityRule { kind: 'None' | 'Grant' | 'Ban'; author: 'Governance' | 'Delegated'; delegable: boolean }
export interface AuthorityVouchConfig { quorum: string; epoch: string; voucherSubjectId?: string }
export interface AuthorityMembershipInput {
  id: string; user: string; userUsername?: string | null; accepted?: boolean; acceptedAt?: string | null; seededWhilePaused?: boolean;
  ruleKind?: AuthorityRule['kind']; rule?: AuthorityRule | null; emailVerified?: boolean; vouchCount?: string | number; vouchEpoch?: string;
  subject: { subjectId: string; kind: 'Role' | 'Group'; defaultAllow?: boolean; vouchConfig?: AuthorityVouchConfig | null };
  pendingAction?: AuthorityPendingInput | null;
}
export interface AuthorityPendingInput {
  id: string; pendingId: string; action: 'Grant' | 'Offer' | 'Remove'; status: 'Pending' | 'Finalized' | 'Cancelled' | 'Voided';
  actor: string; actorUsername?: string | null; user: string; activatesAt: string; cancelledBy?: string | null;
}
function bool(value: unknown, code: string): Fact<boolean> { return typeof value === 'boolean' ? knownFact(value) : unknownFact(code); }
function sticky(rule: AuthorityRule | null | undefined): Fact<boolean> {
  if (rule === null || rule?.kind === 'None') return knownFact(false);
  if (!rule || !['Grant', 'Ban'].includes(rule.kind) || !['Governance', 'Delegated'].includes(rule.author) || typeof rule.delegable !== 'boolean') return unknownFact('RULE_UNAVAILABLE');
  return knownFact(rule.kind === 'Grant' && rule.author === 'Governance' && !rule.delegable);
}
export interface MembershipLifecycle {
  accepted: Fact<boolean>; eligible: Fact<boolean>; isMember: Fact<boolean>; claimable: Fact<boolean>;
  status: Fact<'active' | 'accepted-ineligible' | 'claimable' | 'inactive'>;
  heldInReserve: Fact<boolean>; renounceClearsGrant: Fact<boolean>;
  /** This is a live injected decision, separate from eligibility/claimable projections. */
  claimAuthorized: Fact<boolean>;
  indexedRow: AuthorityMembershipInput;
}
export function projectMembershipLifecycle(input: {
  snapshot: SourceSnapshot<AuthorityMembershipInput>; scope: PlanScope;
  claimAuthorization?: { subjectId: string; authorized: Fact<boolean> };
}): MembershipLifecycle {
  const row = input.snapshot.data;
  const result: MembershipLifecycle = { accepted: unknownFact('MEMBERSHIP_UNAVAILABLE'), eligible: unknownFact('ELIGIBILITY_UNAVAILABLE'),
    isMember: unknownFact('MEMBERSHIP_UNAVAILABLE'), claimable: unknownFact('ELIGIBILITY_UNAVAILABLE'), status: unknownFact('MEMBERSHIP_UNAVAILABLE'),
    heldInReserve: unknownFact('RULE_UNAVAILABLE'), renounceClearsGrant: unknownFact('RULE_UNAVAILABLE'), claimAuthorized: unknownFact('LIVE_CLAIM_CHECK_REQUIRED'), indexedRow: row };
  try {
    if (!input.scope.orgId || !input.scope.contract || !input.scope.account || input.scope.account.toLowerCase() !== row.user.toLowerCase()) return result;
    requireCompleteSnapshot(input.snapshot, { scope: input.scope });
    const current = projectAuthorityMembership(row);
    const ruleKnown = row.rule === null ? row.ruleKind === 'None' : row.rule !== undefined && row.rule.kind === row.ruleKind;
    result.accepted = bool(row.accepted, 'ACCEPTANCE_UNAVAILABLE');
    if (current.membershipProjection === 'current-authority-inputs') {
      result.eligible = knownFact(current.eligible, input.snapshot.source);
      result.isMember = knownFact(current.isMember, input.snapshot.source);
      result.claimable = knownFact(current.claimable, input.snapshot.source);
      result.status = knownFact(current.isMember ? 'active' : row.accepted ? 'accepted-ineligible' : current.claimable ? 'claimable' : 'inactive', input.snapshot.source);
      const isSticky = ruleKnown ? sticky(row.rule) : unknownFact<boolean>('RULE_UNAVAILABLE');
      const pendingKnown = Object.prototype.hasOwnProperty.call(row, 'pendingAction');
      if (isSticky.state === 'known' && pendingKnown) result.heldInReserve = knownFact(current.claimable && isSticky.value && row.pendingAction?.status !== 'Pending');
    }
    if (ruleKnown && (row.rule === null || row.rule?.kind === 'None' || row.rule?.kind === 'Ban')) result.renounceClearsGrant = knownFact(false);
    else {
      const isSticky = ruleKnown ? sticky(row.rule) : unknownFact<boolean>('RULE_UNAVAILABLE');
      if (isSticky.state === 'known') result.renounceClearsGrant = knownFact(!isSticky.value);
    }
    // Never promote an indexed canClaim/capacity estimate to live authority.
    const live = input.claimAuthorization?.authorized;
    if (live?.source && !live.source.indexed && normalizeSubjectId(input.claimAuthorization!.subjectId) === normalizeSubjectId(row.subject.subjectId)) {
      requireCompleteSnapshot({ source: live.source, data: live, coverage: input.snapshot.coverage }, { scope: input.scope, indexed: false });
      result.claimAuthorized = live;
    }
  } catch { /* Unknown is retained, even for a fully transported but unpopulated row. */ }
  return result;
}
export function projectPendingAction(input: {
  pending: Fact<AuthorityPendingInput | null>; now: RawUintInput;
  paused: Fact<boolean>; viewerIsExecutor: Fact<boolean>; viewerIsCurrentManager: Fact<boolean>;
  /** Original actor must STILL have the required manager cap when claim/finalize runs. */
  actorAuthorized: Fact<boolean>;
  /** Inject exact current claim/finalize authorization (including capacity/rules/target). */
  completionAuthorization?: { pendingId: string; authorized: Fact<boolean> };
  /** Viewer scope: validates attached chain/org and viewer identity; required in full
   * for live completion. Unscoped facts remain trusted, but explicit sources must agree
   * with one another even when scope is absent. Target/actor accounts come from pending. */
  scope?: PlanScope;
}): { open: Fact<boolean>; operation: Fact<'claim' | 'finalize' | null>; matured: Fact<boolean>; canComplete: Fact<boolean>; canCancel: Fact<boolean> } {
  const unknown = <T>(): Fact<T> => unknownFact('PENDING_INPUT_UNRESOLVED');
  const result = { open: unknown<boolean>(), operation: unknown<'claim' | 'finalize' | null>(), matured: unknown<boolean>(), canComplete: unknown<boolean>(), canCancel: unknown<boolean>() };
  const now = BigInt(requireRawUint(input.now, 64));
  if (input.pending.state === 'unknown') return result;
  const p = input.pending.value;
  try {
    const sources = [input.pending, input.paused, input.viewerIsExecutor, input.viewerIsCurrentManager, input.actorAuthorized, input.completionAuthorization?.authorized]
      .flatMap(fact => fact?.source ? [fact.source] : []);
    // These readers can observe different contracts/blocks. Chain and org are common
    // join dimensions; absent scope checks consistency without inventing a current org.
    const chainId = input.scope?.chainId ?? sources[0]?.chainId;
    const orgId = input.scope?.orgId ?? sources.find(source => source.orgId !== undefined)?.orgId;
    for (const source of sources) assertPlanScope(source, { chainId: chainId!, ...(source.orgId !== undefined && orgId !== undefined ? { orgId } : {}) });
    const viewerFacts = [input.viewerIsExecutor, input.viewerIsCurrentManager, input.completionAuthorization?.authorized];
    const viewer = input.scope?.account ?? viewerFacts.find(fact => fact?.source?.account !== undefined)?.source?.account;
    for (const fact of viewerFacts) if (fact?.source?.account !== undefined && viewer !== undefined) {
      assertPlanScope(fact.source, { chainId: fact.source.chainId, account: viewer });
    }
    if (p) for (const [fact, account] of [[input.pending, p.user], [input.actorAuthorized, p.actor]] as const) if (fact.source?.account !== undefined) {
      assertPlanScope(fact.source, { chainId: fact.source.chainId, account });
    }
  } catch { return result; /* Contradictory provenance cannot authorize either action. */ }
  if (p === null || ['Finalized', 'Cancelled', 'Voided'].includes(p.status)) return { open: knownFact(false), operation: knownFact(null), matured: knownFact(false), canComplete: knownFact(false), canCancel: knownFact(false) };
  if (p.status !== 'Pending' || !['Grant', 'Offer', 'Remove'].includes(p.action)) return result;
  const matured = now >= BigInt(requireRawUint(p.activatesAt, 64));
  normalizeSubjectId(p.pendingId);
  result.open = knownFact(true); result.operation = knownFact(p.action === 'Offer' ? 'claim' : 'finalize'); result.matured = knownFact(matured);
  const exempt = input.viewerIsExecutor.state === 'known' && input.viewerIsExecutor.value;
  if (!matured || (input.paused.state === 'known' && input.paused.value && input.viewerIsExecutor.state === 'known' && !input.viewerIsExecutor.value)
    || (input.actorAuthorized.state === 'known' && !input.actorAuthorized.value)) result.canComplete = knownFact(false);
  else if ((exempt || (input.paused.state === 'known' && !input.paused.value)) && input.actorAuthorized.state === 'known') {
    result.canComplete = unknownFact(p.action === 'Offer' ? 'LIVE_CLAIM_CHECK_REQUIRED' : 'LIVE_FINALIZE_CHECK_REQUIRED');
    const completion = input.completionAuthorization;
    if (completion?.authorized.source && !completion.authorized.source.indexed && input.scope?.account
      && input.scope.contract && input.scope.orgId && normalizeSubjectId(completion.pendingId) === normalizeSubjectId(p.pendingId)) {
      try {
        requireCompleteSnapshot({ source: completion.authorized.source, data: null, coverage: { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] } }, { scope: input.scope, indexed: false });
        result.canComplete = completion.authorized;
      } catch { /* Mismatched live authorization remains unresolved. */ }
    }
  }
  if (exempt) result.canCancel = knownFact(true);
  else if (input.paused.state === 'known' && input.paused.value) result.canCancel = knownFact(false);
  else if (input.paused.state === 'known' && input.viewerIsCurrentManager.state === 'known') result.canCancel = knownFact(input.viewerIsCurrentManager.value);
  return result;
}
export interface AuthorityVouchRecord { id: string; subjectId: string; user: string; voucher: string; voucherUsername?: string | null; active: boolean; epoch: string; seeded?: boolean }
/** Counts come from the epoch-scoped contract counter. A roster alone cannot prove seeded
 * anonymous counts or per-user generation clearing; mismatch stays unknown. */
export function projectVouchEligibility(input: {
  records: SourceSnapshot<readonly AuthorityVouchRecord[]>; scope: PlanScope; subjectId: string;
  config: Fact<AuthorityVouchConfig | null>; wearerEpoch: Fact<string>; rawCount: Fact<string>;
  authority: SourceSnapshot<AuthorityPermissionData>; viewerMemberships: SourceSnapshot<readonly AuthorityMemberFact[]>;
  viewerScope: PlanScope;
}): { count: Fact<string>; rosterCount: Fact<string>; met: Fact<boolean>; liveRecords: readonly AuthorityVouchRecord[]; viewerIsVoucherMember: Fact<boolean> } {
  const result = { count: unknownFact<string>('VOUCH_UNAVAILABLE'), rosterCount: unknownFact<string>('VOUCH_ROSTER_UNAVAILABLE'), met: unknownFact<boolean>('VOUCH_UNAVAILABLE'), liveRecords: [] as AuthorityVouchRecord[], viewerIsVoucherMember: unknownFact<boolean>('VOUCHER_MEMBERSHIP_UNAVAILABLE') };
  try {
    if (!input.scope.orgId || !input.scope.contract || !input.scope.account) return result;
    const records = requireCompleteSnapshot(input.records, { scope: input.scope });
    for (const [fact, scoped] of [[input.config, { ...input.scope, account: undefined }], [input.wearerEpoch, input.scope], [input.rawCount, input.scope]] as const) if (fact.source) {
      assertPlanScope(fact.source, { chainId: scoped.chainId, orgId: scoped.orgId, contract: scoped.contract, account: scoped.account });
      if (input.records.source.block) assertSourceBlock(fact.source.block, input.records.source.block);
    }
    if (input.config.state === 'unknown') return result;
    const config = input.config.value;
    if (!config) { result.met = knownFact(false); return result; }
    const quorum = BigInt(requireRawUint(config.quorum, 32));
    if (quorum === 0n) result.met = knownFact(false);
    const epoch = requireRawUint(config.epoch, 64);
    const sid = normalizeSubjectId(input.subjectId);
    if (records.some(r => normalizeSubjectId(r.subjectId) !== sid || r.user.toLowerCase() !== input.scope.account!.toLowerCase() || typeof r.active !== 'boolean')) return result;
    result.liveRecords = records.filter(r => r.active && requireRawUint(r.epoch, 64) === epoch);
    const vouchers = result.liveRecords.map(r => r.voucher.toLowerCase());
    if (new Set(vouchers).size !== vouchers.length) return result;
    if (input.wearerEpoch.state === 'known' && input.rawCount.state === 'known') {
      const count = requireRawUint(input.wearerEpoch.value, 64) === epoch ? requireRawUint(input.rawCount.value, 32) : '0';
      result.count = knownFact(count); result.met = knownFact(quorum > 0n && BigInt(count) >= quorum);
      if (BigInt(count) === BigInt(vouchers.length)) result.rosterCount = knownFact(count);
      else result.rosterCount = unknownFact('VOUCH_COUNTER_ROSTER_MISMATCH');
    }
    const data = requireCompleteSnapshot(input.authority, { scope: { ...input.scope, account: undefined }, ...(input.records.source.block ? { block: input.records.source.block } : {}) });
    const memberships = requireCompleteSnapshot(input.viewerMemberships, { scope: input.viewerScope, ...(input.authority.source.block ? { block: input.authority.source.block } : {}) });
    if (input.viewerScope.chainId !== input.scope.chainId || input.viewerScope.orgId !== input.scope.orgId || input.viewerScope.contract?.toLowerCase() !== input.scope.contract.toLowerCase() || !input.viewerScope.account) return result;
    for (const m of memberships) if (m.isMember.source) {
      assertPlanScope(m.isMember.source, { chainId: input.viewerScope.chainId, orgId: input.viewerScope.orgId, contract: input.viewerScope.contract, account: input.viewerScope.account });
      if (input.viewerMemberships.source.block) assertSourceBlock(m.isMember.source.block, input.viewerMemberships.source.block);
    }
    if (config.voucherSubjectId) result.viewerIsVoucherMember = projectSubjectMembership(data, config.voucherSubjectId, memberships);
  } catch { /* Retain unresolved facts and raw evidence; no fallback authority. */ }
  return result;
}
/** Configuration conditions, not a promise about which setter emits each lint. */
export function predictAuthorityLints(input: {
  subjectId: string; voucherSubjectId: string; defaultAllow: boolean; vouchQuorum: RawUintInput;
  maxMembers: RawUintInput; permCount: RawUintInput; groupFanout: RawUintInput;
}): readonly number[] {
  const quorum = BigInt(requireRawUint(input.vouchQuorum, 32)), max = BigInt(requireRawUint(input.maxMembers, 32));
  const perms = BigInt(requireRawUint(input.permCount)), fanout = BigInt(requireRawUint(input.groupFanout));
  const subject = normalizeSubjectId(input.subjectId), voucher = normalizeSubjectId(input.voucherSubjectId);
  const codes: number[] = [];
  if (quorum > 0n && input.defaultAllow) codes.push(LINT_CODE.QuorumNoOp);
  if (quorum > 0n && max > 0n) codes.push(LINT_CODE.VouchWithMaxMembers);
  // Current contract checks permCount, including a zero-valued row, rather than selected keys.
  if (input.defaultAllow && perms > 0n) codes.push(LINT_CODE.DefaultAllowStrongPerms);
  if (fanout > 3n) codes.push(LINT_CODE.GroupFanout);
  if (quorum > 0n && subject === voucher) codes.push(LINT_CODE.SelfVoucher);
  return codes;
}
