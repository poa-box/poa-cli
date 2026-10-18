import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { parse, Kind, TypeNode, SelectionSetNode } from 'graphql';
import { SourceRef, SourceSnapshot, Coverage, knownFact, unknownFact, Fact, PlanScope } from '../src/data/facts';
import { classifySubjectId, composeSubjectId, embeddedAuthority, localSequence, normalizeSubjectId, predictNextSubjectIds, subjectCreationRaceFacts } from '../src/authority/ids';
import { AuthorityMemberFact, AuthorityPermissionData, decodePermissionWord, projectEffectiveSubjectPermissions, projectUserPermissions, resolvePermissionContext } from '../src/authority/permissions';
import { ACTION_REASON, ELIG_SOURCE, LINT_CODE, RULE_KIND, RULE_AUTHOR, PENDING_KIND, AuthorityMembershipInput, AuthorityPendingInput, projectMembershipLifecycle, projectPendingAction, projectVouchEligibility, predictAuthorityLints } from '../src/authority/lifecycle';
import { ActivationMembership, electorateActivationFacts } from '../src/authority/activation';
import { AUTHORITY_KEYS, permissionKey, permissionWord, projectContext, buildAuthorityAction } from '../src/tx/authority';
import { encodeIntent } from '../src/tx/intent';
import { AuthoritySnapshotQuery, authorityMemberRoleSubjects, authorityAccountMembershipFacts, authorityAccountActivationMemberships, readAuthoritySnapshot } from '../src/reads/authority';
import * as docs from '../src/graph/documents/authority';
import oracles from './fixtures/core-update/authority/oracles.json';

const AUTH = '0x1111111111111111111111111111111111111111';
const OTHER_AUTH = '0x2222222222222222222222222222222222222222';
const ACCOUNT = '0x3333333333333333333333333333333333333333';
const VOUCHER = '0x4444444444444444444444444444444444444444';
const ORG = `0x${'55'.repeat(32)}`;
const GLOBAL = `0x${'00'.repeat(32)}`;
const HASH = `0x${'ab'.repeat(32)}`;
const scope: PlanScope = { chainId: 100, orgId: ORG, contract: AUTH };
const userScope = { ...scope, account: ACCOUNT };
const source: SourceRef = { ...scope, endpoint: 'https://authority.invalid/graph', method: 'authority', indexed: true, snapshot: 'pinned', block: { number: '123', hash: HASH } };
const complete: Coverage = { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] };
function snapshot<T>(data: T, account?: string): SourceSnapshot<T> { return { source: { ...source, ...(account ? { account } : {}) }, data, coverage: complete }; }
function value<T>(fact: Fact<T>): T { if (fact.state !== 'known') throw new Error(fact.code); return fact.value; }
function permissionData(key = AUTHORITY_KEYS.TM_PERMS, own = '0', group = '8', active = true): AuthorityPermissionData {
  return { subjects: [{ subjectId: '7', kind: 'Role', name: 'Current role' }, { subjectId: '9', kind: 'Group', name: 'Current group' }],
    groupEdges: [{ id: '9-7', groupSubjectId: '9', roleSubjectId: '7', isActive: active }],
    permissions: [{ id: 'r', subjectId: '7', permKey: key, ctx: GLOBAL, word: permissionWord(own).toString() }, { id: 'g', subjectId: '9', permKey: key, ctx: GLOBAL, word: permissionWord(group).toString() }] };
}
const effective = (data: AuthorityPermissionData, key = AUTHORITY_KEYS.TM_PERMS, ctx = GLOBAL, contractOrder?: readonly string[]) => projectEffectiveSubjectPermissions({ snapshot: snapshot(data), scope, subjectId: '7', permKey: key, ctx, contractOrder });

function membership(overrides: Partial<AuthorityMembershipInput> = {}): AuthorityMembershipInput {
  return { id: '7-user', user: ACCOUNT, accepted: false, acceptedAt: null, seededWhilePaused: false, ruleKind: 'None', rule: null,
    emailVerified: false, vouchEpoch: '2', vouchCount: '0', pendingAction: null,
    subject: { subjectId: '7', kind: 'Role', defaultAllow: false, vouchConfig: { quorum: '1', epoch: '2', voucherSubjectId: '9' } }, ...overrides };
}
const lifecycle = (row: AuthorityMembershipInput) => projectMembershipLifecycle({ snapshot: snapshot(row, ACCOUNT), scope: userScope });
const pending: AuthorityPendingInput = { id: 'a', pendingId: '9007199254740993', action: 'Offer', status: 'Pending', actor: VOUCHER, user: ACCOUNT, activatesAt: '1000', cancelledBy: null };
const pendingFacts = { paused: knownFact(false), viewerIsExecutor: knownFact(false), viewerIsCurrentManager: knownFact(false), actorAuthorized: knownFact(true) };

function activationRow(subjectId: string, at: string | null, active = true, seeded = false): ActivationMembership {
  return { subjectId, isMember: knownFact(active), acceptedAt: at === null ? unknownFact('TIMESTAMP_MISSING') : knownFact(at), seededWhilePaused: knownFact(seeded) };
}
function activation(rows: ActivationMembership[], restrictions: readonly string[] = [], created = '1000') {
  return electorateActivationFacts({ memberships: snapshot(rows, ACCOUNT), authority: snapshot(permissionData()), scope: userScope, restrictions: knownFact(restrictions), proposalCreatedAt: knownFact(created) });
}

describe('repair authority provenance regressions', () => {
  const otherOrg = `0x${'66'.repeat(32)}`;
  const mismatches = [{ field: 'chainId', value: 42161 }, { field: 'orgId', value: otherOrg }] as const;
  const activationInput = () => ({ memberships: snapshot([activationRow('7', '99')], ACCOUNT), authority: snapshot(permissionData()), scope: userScope,
    restrictions: knownFact<readonly string[]>(['7'], { ...source, contract: OTHER_AUTH }), proposalCreatedAt: knownFact('1000', { ...source, contract: OTHER_AUTH }) });
  it.each((['restrictions', 'proposalCreatedAt'] as const).flatMap(field => mismatches.map(mismatch => ({ field, mismatch }))))('ROOT-AUTHORITY-ELECTORATE-SCOPE: $field from another $mismatch.field cannot establish a voting decision', ({ field, mismatch }) => {
    const input = activationInput();
    const result = electorateActivationFacts({ ...input, [field]: { ...input[field], source: { ...input[field].source!, [mismatch.field]: mismatch.value } } });
    expect(result.canVote.state).toBe('unknown'); expect(result.activeSince.state).toBe('unknown'); expect(result.reason.state).toBe('unknown');
    expect(result.qualifyingRoleIds).toEqual([]);
  });
  it('ROOT-AUTHORITY-ELECTORATE-SCOPE: different voting contract, historical observation, optional org and trusted unscoped facts retain activation', () => {
    const input = activationInput();
    const proposalSource = { ...source, contract: OTHER_AUTH, account: VOUCHER, orgId: ORG.toUpperCase().replace('0X', '0x'), block: { number: '50' } };
    for (const factSource of [undefined, proposalSource, { ...proposalSource, orgId: undefined }]) {
      const result = electorateActivationFacts({ ...input, restrictions: knownFact(['7'], factSource), proposalCreatedAt: knownFact('100', factSource) });
      expect(value(result.activeSince)).toBe('99'); expect(value(result.canVote)).toBe(true);
      expect(value(electorateActivationFacts({ ...input, restrictions: knownFact(['7'], factSource), proposalCreatedAt: knownFact('0', factSource) }).canVote)).toBe(true);
    }
  });

  function pendingInput() {
    const row = { ...pending, action: 'Grant' as const, user: OTHER_AUTH };
    return { scope: userScope, now: '1000', pending: knownFact(row, { ...source, account: row.user }), paused: knownFact(false, source),
      viewerIsExecutor: knownFact(true, { ...source, contract: OTHER_AUTH, account: ACCOUNT }), viewerIsCurrentManager: knownFact(true, { ...source, account: ACCOUNT }),
      actorAuthorized: knownFact(true, { ...source, account: row.actor }),
      completionAuthorization: { pendingId: row.pendingId, authorized: knownFact(true, { ...source, account: ACCOUNT, indexed: false, method: 'canFinalize' }) } };
  }
  it.each((['pending', 'paused', 'viewerIsExecutor', 'viewerIsCurrentManager', 'actorAuthorized'] as const).flatMap(field => mismatches.map(mismatch => ({ field, mismatch }))))('ROOT-AUTHORITY-PENDING-SCOPE: explicit wrong $mismatch.field on $field cannot authorize cancellation or completion', ({ field, mismatch }) => {
    const input = pendingInput();
    const result = projectPendingAction({ ...input, [field]: { ...input[field], source: { ...input[field].source!, [mismatch.field]: mismatch.value } } });
    expect(result.canCancel.state).toBe('unknown'); expect(result.canComplete.state).toBe('unknown'); expect(result.open.state).toBe('unknown');
  });
  it.each(['pending', 'viewerIsExecutor', 'viewerIsCurrentManager', 'actorAuthorized'] as const)('ROOT-AUTHORITY-PENDING-SCOPE: %s account is bound to its target, viewer or actor', field => {
    const input = pendingInput();
    const result = projectPendingAction({ ...input, [field]: { ...input[field], source: { ...input[field].source!, account: AUTH } } });
    expect(result.canCancel.state).toBe('unknown'); expect(result.canComplete.state).toBe('unknown');
  });
  it('ROOT-AUTHORITY-PENDING-SCOPE: distinct viewer/target/actor and org-wide pause remain valid', () => {
    const input = pendingInput();
    for (const pauseSource of [source, { ...source, account: AUTH, block: { number: '124' } }]) {
      const result = projectPendingAction({ ...input, paused: knownFact(false, pauseSource) });
      expect(value(result.canCancel)).toBe(true); expect(value(result.canComplete)).toBe(true);
    }
    const partial = projectPendingAction({ ...input, viewerIsExecutor: knownFact(true, { ...input.viewerIsExecutor.source!, orgId: undefined, account: undefined }) });
    expect(value(partial.canCancel)).toBe(true); expect(value(partial.canComplete)).toBe(true);
  });
  it.each((['pending', 'paused', 'viewerIsExecutor', 'viewerIsCurrentManager', 'actorAuthorized'] as const).flatMap(field => mismatches.map(mismatch => ({ field, mismatch }))))('ROOT-AUTHORITY-PENDING-SCOPE: absent scope still rejects contradictory $mismatch.field on $field', ({ field, mismatch }) => {
    const input = pendingInput();
    const result = projectPendingAction({ ...input, scope: undefined, [field]: { ...input[field], source: { ...input[field].source!, [mismatch.field]: mismatch.value } } });
    expect(result.canCancel.state).toBe('unknown'); expect(result.canComplete.state).toBe('unknown');
  });
  it('ROOT-AUTHORITY-PENDING-SCOPE: no scope preserves consistent and trusted unscoped projections without live completion', () => {
    const input = pendingInput();
    expect(value(projectPendingAction({ ...input, scope: undefined }).canCancel)).toBe(true);
    expect(projectPendingAction({ ...input, scope: undefined }).canComplete.state).toBe('unknown');
    const trusted = projectPendingAction({ ...pendingFacts, viewerIsExecutor: knownFact(true), pending: knownFact(pending), now: '1000' });
    expect(value(trusted.canCancel)).toBe(true); expect(trusted.canComplete.state).toBe('unknown');
    const conflictingViewers = projectPendingAction({ ...input, scope: undefined, viewerIsCurrentManager: knownFact(true, { ...source, account: VOUCHER }) });
    expect(conflictingViewers.canCancel.state).toBe('unknown'); expect(conflictingViewers.canComplete.state).toBe('unknown');
  });
  it.each(mismatches)('ROOT-AUTHORITY-PENDING-SCOPE: contradictory completion provenance ($field) also invalidates the join', mismatch => {
    const input = pendingInput();
    const result = projectPendingAction({ ...input, completionAuthorization: { ...input.completionAuthorization,
      authorized: knownFact(true, { ...input.completionAuthorization.authorized.source!, [mismatch.field]: mismatch.value }) } });
    expect(result.canCancel.state).toBe('unknown'); expect(result.canComplete.state).toBe('unknown');
  });
});

describe('AUTH-ID namespace, complete allocation and execution races', () => {
  it('distinguishes native/adopted/structural/foreign/reserved IDs without precision loss', () => {
    const native = composeSubjectId(AUTH, '9007199254740993');
    expect(normalizeSubjectId(`0x${BigInt(native).toString(16)}`)).toBe(native);
    expect(classifySubjectId(native, AUTH)).toMatchObject({ namespace: 'native', authority: AUTH, sequence: '9007199254740993', userFacing: true });
    expect(classifySubjectId(native, OTHER_AUTH).namespace).toBe('foreign');
    expect(embeddedAuthority(native)).toBe(AUTH);
    const root = (37n << 224n).toString();
    expect(classifySubjectId(root)).toMatchObject({ namespace: 'structural', userFacing: false });
    expect(classifySubjectId((BigInt(root) + (1n << 208n)).toString())).toMatchObject({ namespace: 'adopted', userFacing: true });
    expect(embeddedAuthority(root)).toBeNull(); expect(localSequence(root)).toBeNull();
    expect(classifySubjectId('7').namespace).toBe('unallocated');
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '-0', ' 1', '1e2', (1n << 256n).toString()])('rejects malformed/unsafe ID %s', id => { expect(() => normalizeSubjectId(id)).toThrow(); });
  it('bounds uint64 sequences rather than wrapping, including exact last allocation', () => {
    expect(localSequence(composeSubjectId(AUTH, (1n << 64n) - 1n))).toBe('18446744073709551615');
    for (const seq of ['0', '-1', (1n << 64n).toString(), Number.MAX_SAFE_INTEGER + 1]) expect(() => composeSubjectId(AUTH, seq)).toThrow();
    expect(() => composeSubjectId(ethers.constants.AddressZero, 1)).toThrow();
    const p = predictNextSubjectIds({ authority: AUTH, scope, history: snapshot([{ subjectId: composeSubjectId(AUTH, (1n << 64n) - 1n) }]) });
    expect(p).toMatchObject({ status: 'blocked', codes: ['SUBJECT_SEQUENCE_EXHAUSTED'] });
  });
  it('only locally allocated IDs advance sequence; complete history and exact scope are prerequisites', () => {
    const history = snapshot([{ subjectId: (99n << 224n).toString() }, { subjectId: composeSubjectId(OTHER_AUTH, 1000) }, { subjectId: composeSubjectId(AUTH, 7) }]);
    const result = predictNextSubjectIds({ authority: AUTH, scope, history, count: 2 });
    expect(result).toMatchObject({ status: 'ready', data: { subjectIds: [composeSubjectId(AUTH, 8), composeSubjectId(AUTH, 9)], nextSequence: '8', executionStable: false }, consequences: [{ code: 'SUBJECT_CREATION_RACE' }] });
    for (const bad of [ { ...history, coverage: { ...complete, status: 'incomplete' as const } }, { ...history, source: { ...source, chainId: 42161 } }, { ...history, data: [{ subjectId: 'broken' }] } ]) {
      expect(predictNextSubjectIds({ authority: AUTH, scope, history: bad }).status).toBe('blocked');
    }
  });
  it('never retires an unexecuted closed poll, and absence of creation metadata remains unknown', () => {
    expect(subjectCreationRaceFacts(snapshot([{ id: 'closed', createsSubject: true, status: 'Active', expired: true } as any]), scope)).toMatchObject({ competingIds: ['closed'], hasCompetingCreation: { state: 'known', value: true }, executionStable: false });
    expect(subjectCreationRaceFacts(snapshot([{ id: 'u', actionSummaries: ['Unrelated text'] }]), scope).hasCompetingCreation.state).toBe('unknown');
    expect(value(subjectCreationRaceFacts(snapshot([{ id: 'executed', executed: true, createsSubject: true }]), scope).hasCompetingCreation)).toBe(false);
  });
});

describe('AUTH-PERM independent permission/context/group invariants', () => {
  it('retains a group-only ASSIGN=8 grant, exact names, raw rows and attribution', () => {
    const p = effective(permissionData());
    expect(value(p.value)).toBe('8'); expect(value(p.enabled)).toBe(true);
    expect(p.contributions.find(c => c.subjectId === '9')).toMatchObject({ name: 'Current group', kind: 'Group', context: { value: { value: '8' } } });
    expect(effective(permissionData(AUTHORITY_KEYS.TM_PERMS, '0', '8', false)).value).toMatchObject({ state: 'known', value: '0' });
  });
  it.each([
    { word: null, want: '8' }, { word: '0', want: '8' },
    { word: permissionWord(0).toString(), want: '0' }, { word: permissionWord(0, true).toString(), want: '8' },
    { word: permissionWord(2).toString(), want: '2' }, { word: permissionWord(2, true).toString(), want: '10' },
  ])('project zero is context one; exact override $word -> $want', ({ word, want }) => {
    expect(BigInt(projectContext('0'))).toBe(1n);
    expect(value(resolvePermissionContext({ permKey: AUTHORITY_KEYS.TM_PERMS, global: knownFact(permissionWord(8).toString()), project: knownFact(word) })).value).toBe(want);
    const d = permissionData(AUTHORITY_KEYS.TM_PERMS, '8', '0');
    if (word !== null) d.permissions = [...d.permissions, { id: 'project', subjectId: '7', permKey: AUTHORITY_KEYS.TM_PERMS, ctx: projectContext(0), word }];
    expect(value(effective(d, AUTHORITY_KEYS.TM_PERMS, projectContext(0)).value)).toBe(want);
  });
  it('uses raw bool first-nonzero global/project fold, OR-mask and reserved MAX', () => {
    for (const [key, expected] of [[AUTHORITY_KEYS.EDU_MEMBER, '8'], [AUTHORITY_KEYS.TM_PERMS, '10'], [permissionKey('reserved.scalar', 2), '8']]) {
      expect(value(resolvePermissionContext({ permKey: key, global: knownFact(permissionWord(8).toString()), project: knownFact(permissionWord(2, true).toString()) })).value).toBe(expected);
    }
    expect(value(effective(permissionData(permissionKey('reserved.scalar', 2), '2', '8'), permissionKey('reserved.scalar', 2)).value)).toBe('8');
  });
  it('never invents noncanonical bool raw aggregate from ID sort; storage order matters', () => {
    const d = permissionData(AUTHORITY_KEYS.EDU_MEMBER, '2', '8');
    const absent = effective(d, AUTHORITY_KEYS.EDU_MEMBER);
    expect(absent.value).toMatchObject({ state: 'unknown', code: 'CONTRACT_FOLD_ORDER_UNAVAILABLE' });
    expect(value(absent.enabled)).toBe(true);
    expect(value(effective(d, AUTHORITY_KEYS.EDU_MEMBER, GLOBAL, ['9', '7']).value)).toBe('8');
    expect(value(effective({ ...d, subjects: [...d.subjects].reverse() }, AUTHORITY_KEYS.EDU_MEMBER, GLOBAL, ['7', '9']).value)).toBe('2');
    expect(value(effective(permissionData(AUTHORITY_KEYS.EDU_MEMBER, '8', '8'), AUTHORITY_KEYS.EDU_MEMBER).value)).toBe('8');
  });
  it('keeps all 254 permission bits; absent global cannot hide a proven zero project override', () => {
    const huge = ((1n << 253n) | 8n).toString();
    expect(decodePermissionWord(permissionWord(huge).toString())).toMatchObject({ value: huge, exists: true, enabled: true });
    expect(value(effective(permissionData(AUTHORITY_KEYS.TM_PERMS, '2', huge)).value)).toBe((BigInt(huge) | 2n).toString());
    const result = resolvePermissionContext({ permKey: AUTHORITY_KEYS.TM_PERMS, global: unknownFact('MISSING_GLOBAL'), project: knownFact(permissionWord(0).toString()) });
    expect(value(result)).toMatchObject({ value: '0', global: { state: 'unknown', code: 'MISSING_GLOBAL' } });
    expect(() => decodePermissionWord(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
  it('derives user group membership from active roles; missing/ineligible/partial membership stays accurate', () => {
    const run = (memberships: AuthorityMemberFact[], data = permissionData()) => projectUserPermissions({ snapshot: snapshot(data), memberships: snapshot(memberships, ACCOUNT), scope: userScope, permKey: AUTHORITY_KEYS.TM_PERMS, ctx: GLOBAL });
    expect(value(run([{ subjectId: '7', isMember: knownFact(true) }]).value)).toBe('8');
    expect(value(run([{ subjectId: '7', isMember: knownFact(false) }]).value)).toBe('0');
    expect(run([]).value.state).toBe('unknown');
    expect(run([{ subjectId: '7', isMember: unknownFact('ELIGIBILITY_PENDING') }]).value.state).toBe('unknown');
    const bad = permissionData(); bad.groupEdges = [{ ...bad.groupEdges[0], groupSubjectId: '999' }];
    expect(effective(bad).value.state).toBe('unknown');
    expect(projectUserPermissions({ snapshot: snapshot(permissionData()), memberships: { ...snapshot([{ subjectId: '7', isMember: knownFact(true) }], ACCOUNT), coverage: { ...complete, status: 'incomplete' } }, scope: userScope, permKey: AUTHORITY_KEYS.TM_PERMS, ctx: GLOBAL }).value.state).toBe('unknown');
  });
  it('permits adopted role projection while rejecting duplicate/conflicting permission slots and mismatched scope', () => {
    const d = permissionData(); const adopted = ((1n << 224n) + (1n << 208n)).toString();
    d.subjects = d.subjects.map(s => s.subjectId === '7' ? { ...s, subjectId: adopted } : s);
    d.groupEdges = d.groupEdges.map(e => ({ ...e, roleSubjectId: adopted }));
    d.permissions = d.permissions.map(r => r.subjectId === '7' ? { ...r, subjectId: adopted } : r);
    expect(value(projectEffectiveSubjectPermissions({ snapshot: snapshot(d), scope, subjectId: adopted, permKey: AUTHORITY_KEYS.TM_PERMS, ctx: GLOBAL }).value)).toBe('8');
    const bad = permissionData(); bad.permissions = [...bad.permissions, bad.permissions[0]];
    expect(effective(bad).enabled.state).toBe('unknown');
    expect(projectEffectiveSubjectPermissions({ snapshot: snapshot(permissionData()), scope: { ...scope, chainId: 42161 }, subjectId: '7', permKey: AUTHORITY_KEYS.TM_PERMS, ctx: GLOBAL }).value.state).toBe('unknown');
  });
});

describe('AUTH-LIFECYCLE contract parity and incomplete inputs', () => {
  it('matches numeric ActionReason, EligSource, LintCode and rule/pending enums from the contract snapshot', () => {
    expect(ACTION_REASON).toEqual(oracles.enums.ActionReason); expect(ELIG_SOURCE).toEqual(oracles.enums.EligSource);
    expect(LINT_CODE).toEqual(oracles.enums.LintCode); expect(RULE_KIND).toEqual(oracles.enums.RuleKind);
    expect(RULE_AUTHOR).toEqual(oracles.enums.RuleAuthor); expect(PENDING_KIND).toEqual(oracles.enums.PendingKind);
  });
  it.each(['None', 'Grant', 'Ban'] as const)('preserves %s precedence across default/email/vouch/accepted combinations', ruleKind => {
    for (const defaultAllow of [false, true]) for (const emailVerified of [false, true]) for (const vouch of [false, true]) for (const accepted of [false, true]) {
      const row = membership({ ruleKind, accepted, emailVerified, vouchCount: vouch ? '1' : '0', subject: { ...membership().subject, defaultAllow } });
      const p = lifecycle(row);
      const eligible = ruleKind === 'Ban' ? false : ruleKind === 'Grant' || defaultAllow || emailVerified || vouch;
      expect(value(p.eligible)).toBe(eligible); expect(value(p.isMember)).toBe(accepted && eligible); expect(value(p.claimable)).toBe(!accepted && eligible);
      expect(p.claimAuthorized).toMatchObject({ state: 'unknown', code: 'LIVE_CLAIM_CHECK_REQUIRED' });
    }
  });
  it('preserves accepted-but-ineligible occupancy and sticky renounce reserve independently of history timestamp', () => {
    expect(value(lifecycle(membership({ accepted: true })).status)).toBe('accepted-ineligible');
    const row = membership({ ruleKind: 'Grant', rule: { kind: 'Grant', author: 'Governance', delegable: false } });
    expect(lifecycle(row)).toMatchObject({ heldInReserve: { value: true }, renounceClearsGrant: { value: false } });
    expect(lifecycle({ ...row, rule: { ...row.rule!, author: 'Delegated' } })).toMatchObject({ heldInReserve: { value: false }, renounceClearsGrant: { value: true } });
    expect(value(lifecycle({ ...row, pendingAction: pending }).heldInReserve)).toBe(false);
    expect(lifecycle(membership({ emailVerified: undefined })).eligible.state).toBe('unknown');
    expect(lifecycle(membership({ ruleKind: 'Grant', rule: null })).heldInReserve.state).toBe('unknown');
    expect(lifecycle(membership({ ruleKind: 'Grant', rule: null })).renounceClearsGrant.state).toBe('unknown');
  });
  it.each(['Grant', 'Offer', 'Remove'] as const)('pending %s honors delay, completion verb, cancellation manager and terminal evidence', action => {
    const p = { ...pending, action };
    const before = projectPendingAction({ ...pendingFacts, pending: knownFact(p), now: '999' });
    expect(before.operation).toMatchObject({ value: action === 'Offer' ? 'claim' : 'finalize' });
    expect(value(before.canComplete)).toBe(false);
    const at = projectPendingAction({ ...pendingFacts, pending: knownFact(p), now: '1000' });
    expect(value(at.matured)).toBe(true); expect(at.canComplete.state).toBe('unknown');
    expect(value(at.canCancel)).toBe(false); // Being the original actor supplies no cancellation right.
    expect(value(projectPendingAction({ ...pendingFacts, viewerIsCurrentManager: knownFact(true), pending: knownFact(p), now: '1000' }).canCancel)).toBe(true);
    expect(value(projectPendingAction({ ...pendingFacts, viewerIsExecutor: knownFact(true), paused: knownFact(true), pending: knownFact(p), now: '1000' }).canCancel)).toBe(true);
    expect(value(projectPendingAction({ ...pendingFacts, actorAuthorized: knownFact(false), pending: knownFact(p), now: '1000' }).canComplete)).toBe(false);
    expect(value(projectPendingAction({ ...pendingFacts, pending: knownFact({ ...p, status: 'Finalized' }), now: '1000' }).open)).toBe(false);
  });
  it('pause denies a non-executor even after maturity, and indexed authorization never becomes live', () => {
    expect(value(projectPendingAction({ ...pendingFacts, paused: knownFact(true), pending: knownFact(pending), now: '1000' }).canComplete)).toBe(false);
    const row = membership({ ruleKind: 'Grant' });
    expect(projectMembershipLifecycle({ snapshot: snapshot(row, ACCOUNT), scope: userScope, claimAuthorization: { subjectId: '7', authorized: knownFact(true, { ...source, account: ACCOUNT }) } }).claimAuthorized.state).toBe('unknown');
    expect(projectMembershipLifecycle({ snapshot: snapshot(row, ACCOUNT), scope: userScope, claimAuthorization: { subjectId: '7', authorized: knownFact(false, { ...source, account: ACCOUNT, indexed: false, method: 'canClaim' }) } }).claimAuthorized).toMatchObject({ state: 'known', value: false });
  });
  it('excludes stale/inactive vouches, handles current group vouchers and counter/roster unknown', () => {
    const config = membership().subject.vouchConfig!;
    const records = [{ id: 'live', subjectId: '7', user: ACCOUNT, voucher: VOUCHER, active: true, epoch: '2' },
      { id: 'stale', subjectId: '7', user: ACCOUNT, voucher: AUTH, active: true, epoch: '1' },
      { id: 'inactive', subjectId: '7', user: ACCOUNT, voucher: OTHER_AUTH, active: false, epoch: '2' }];
    const args = { records: snapshot(records, ACCOUNT), scope: userScope, subjectId: '7', config: knownFact(config), wearerEpoch: knownFact('2'), rawCount: knownFact('1'),
      authority: snapshot(permissionData()), viewerMemberships: snapshot([{ subjectId: '7', isMember: knownFact(true) }], VOUCHER), viewerScope: { ...scope, account: VOUCHER } };
    const p = projectVouchEligibility(args);
    expect(value(p.count)).toBe('1'); expect(value(p.met)).toBe(true); expect(p.liveRecords.map(r => r.id)).toEqual(['live']); expect(value(p.viewerIsVoucherMember)).toBe(true);
    expect(projectVouchEligibility({ ...args, wearerEpoch: knownFact('1'), rawCount: knownFact('3') })).toMatchObject({ count: { value: '0' }, met: { value: false }, rosterCount: { state: 'unknown' } });
    expect(projectVouchEligibility({ ...args, records: { ...args.records, coverage: { ...complete, status: 'incomplete' } } }).met.state).toBe('unknown');
    expect(projectVouchEligibility({ ...args, viewerMemberships: snapshot([], VOUCHER) }).viewerIsVoucherMember.state).toBe('unknown');
  });
  it('predicts actual contract lint conditions; disabled self-vouch and zero group fanout are not lints', () => {
    const params = { subjectId: '7', voucherSubjectId: '7', defaultAllow: true, vouchQuorum: '1', maxMembers: '1', permCount: '1', groupFanout: '4' };
    expect(predictAuthorityLints(params)).toEqual([1, 2, 3, 4, 5]);
    expect(predictAuthorityLints({ ...params, defaultAllow: false, vouchQuorum: '0', permCount: '0', groupFanout: '3' })).toEqual([]);
  });
});

describe('VOTE-ACTIVATION exact current electorate facts', () => {
  it.each([
    { at: '0', state: 'unknown', can: null }, { at: '1', state: 'known', can: true },
    { at: '999', state: 'known', can: true }, { at: '1000', state: 'known', can: true }, { at: '1001', state: 'known', can: false },
  ])('created t1000 versus acceptedAt=$at', ({ at, state, can }) => {
    const result = activation([activationRow('7', at)]);
    expect(result.canVote.state).toBe(state); if (can !== null) expect(value(result.canVote)).toBe(can);
  });
  it('backdates paused seeds to 1 and retains pre-authority creation zero sentinel and prior adoption timestamp', () => {
    expect(activation([activationRow('7', '5000', true, true)])).toMatchObject({ activeSince: { value: '1' }, canVote: { value: true } });
    expect(value(activation([activationRow('7', '5000')], [], '0').canVote)).toBe(true);
    expect(value(activation([activationRow('7', null, true, true)]).activeSince)).toBe('1');
  });
  it('uses oldest qualifying restricted role/group; inactive group edges cannot qualify', () => {
    const d = permissionData(); d.subjects = [...d.subjects, { subjectId: '8', kind: 'Role', name: 'Other' }];
    d.groupEdges = [...d.groupEdges, { id: '9-8', groupSubjectId: '9', roleSubjectId: '8', isActive: true }];
    const args = { memberships: snapshot([activationRow('7', '1001'), activationRow('8', '999')], ACCOUNT), authority: snapshot(d), scope: userScope, restrictions: knownFact(['9']), proposalCreatedAt: knownFact('1000') };
    expect(electorateActivationFacts(args)).toMatchObject({ activeSince: { value: '999' }, canVote: { value: true } });
    expect(electorateActivationFacts({ ...args, restrictions: knownFact(['7']) })).toMatchObject({ activeSince: { value: '1001' }, reason: { value: 'joined-after-proposal' } });
    d.groupEdges = d.groupEdges.map(e => e.roleSubjectId === '8' ? { ...e, isActive: false } : e);
    expect(value(electorateActivationFacts({ ...args, authority: snapshot(d) }).activeSince)).toBe('1001');
  });
  it('missing timestamps/rosters/restrictions/creation/scope are unknown, never a joined-after verdict', () => {
    const args = { memberships: snapshot([activationRow('7', '1001')], ACCOUNT), authority: snapshot(permissionData()), scope: userScope, restrictions: knownFact(['9']), proposalCreatedAt: knownFact('1000') };
    for (const bad of [ { ...args, memberships: snapshot([activationRow('7', null)], ACCOUNT) }, { ...args, memberships: snapshot([], ACCOUNT) },
      { ...args, memberships: { ...args.memberships, coverage: { ...complete, status: 'incomplete' as const } } },
      { ...args, proposalCreatedAt: unknownFact<string>('MISSING_CREATED_AT') }, { ...args, restrictions: unknownFact<readonly string[]>('MISSING_RESTRICTIONS') },
      { ...args, scope: { ...userScope, chainId: 42161 } } ]) {
      expect(electorateActivationFacts(bad).canVote.state).toBe('unknown'); expect(electorateActivationFacts(bad).reason.state).toBe('unknown');
    }
    expect(value(activation([activationRow('7', null, false)]).reason)).toBe('not-member');
  });
});

function graphFixture(count = 1001) {
  const roleIds = Array.from({ length: count }, (_, i) => composeSubjectId(AUTH, 100 + i));
  const groupId = composeSubjectId(AUTH, 9);
  const subjects = roleIds.map((id, i) => ({ id, subjectId: id, kind: 'Role', name: `Renamed ${i}`, maxMembers: 0, memberCount: 1, activeMemberCount: 1,
    defaultAllow: false, vouchConfig: { quorum: 1, epoch: '2', voucherSubjectId: groupId, configuredAt: '50' }, managerConfig: null, createdAt: '1' }));
  const fixtureUser = (i: number) => i < 16 ? ACCOUNT : `0x${BigInt(i + 10000).toString(16).padStart(40, '0')}`;
  const ref = (i: number) => ({ id: roleIds[i], subjectId: roleIds[i], kind: 'Role', name: 'Old name' });
  const make = (fn: (i: number) => Record<string, unknown>) => Array.from({ length: count }, (_, i) => ({ id: String(i).padStart(6, '0'), ...fn(i) }));
  const collections: Record<string, any[]> = {
    subjects: [...subjects, { id: groupId, subjectId: groupId, kind: 'Group', name: 'Current voucher group', maxMembers: 0, memberCount: 0, activeMemberCount: 0, defaultAllow: false, vouchConfig: null, managerConfig: null, createdAt: '1' }].sort((a, b) => a.id < b.id ? -1 : 1),
    subjectMemberships: make(i => ({ user: fixtureUser(i), userUsername: 'alice', accepted: true, acceptedAt: '99', seededWhilePaused: false, ruleKind: 'Grant',
      rule: { kind: 'Grant', author: 'Governance', delegable: false }, emailVerified: false, vouchCount: 1, vouchEpoch: '2', pendingAction: null, subject: ref(i) })),
    groupCompositions: make(i => ({ groupSubjectId: groupId, roleSubjectId: roleIds[i], isActive: i < 16, addedAt: '1', updatedAt: '2' })),
    permRows: make(i => ({ subject: ref(i), permKey: i < 16 ? AUTHORITY_KEYS.TM_PERMS : permissionKey(`history.key.${i}`, 1), ctx: GLOBAL, word: permissionWord(8).toString(), value: '8', exists: true, inheritGlobal: false })),
    accessRules: make(i => ({ subject: ref(i), user: fixtureUser(i), kind: 'Grant', author: 'Governance', delegable: false })),
    subjectVouchRecords: make(i => ({ subject: ref(i), user: fixtureUser(i), voucher: VOUCHER, active: i % 3 !== 0, epoch: i % 3 === 1 ? '1' : '2', seeded: false })),
    pendingActions: make(i => ({ subject: ref(i), pendingId: (9007199254740993n + BigInt(i)).toString(), action: i % 2 ? 'Offer' : 'Grant', user: fixtureUser(i), actor: VOUCHER,
      actorUsername: 'bob', activatesAt: '1000', status: i % 2 ? 'Pending' : 'Cancelled', cancelledBy: i % 2 ? null : AUTH, createdAt: '500', resolvedAt: i % 2 ? null : '700' })),
  };
  const calls: { field: string; variables: Record<string, unknown> }[] = [];
  const query: AuthoritySnapshotQuery = async <T>(requested: SourceRef, doc: string, variables: Record<string, unknown>) => {
    const field = doc.includes('query AuthorityState') ? 'state' : Object.keys(collections).find(f => doc.includes(`${f}(`))!;
    calls.push({ field, variables });
    const data = field === 'state' ? { organization: { id: ORG, membershipAuthority: { id: AUTH, isRouterBound: true, cutoverAt: '1', paused: false, subjectCount: collections.subjects.length, roleSubjectCount: collections.subjects.filter(s => s.kind === 'Role').length, groupSubjectCount: collections.subjects.filter(s => s.kind === 'Group').length, acceptedMembershipCount: collections.subjectMemberships.filter(m => m.accepted).length } } }
      : { [field]: collections[field].filter(r => r.id > variables.lastId!).slice(0, variables.first as number) };
    return { source: requested, data: { ...data, _meta: { block: { number: 123, hash: HASH } } } as T, issues: [] };
  };
  return { query, collections, calls, roleIds, groupId };
}

describe('AUTH-DOC-SHAPE complete current graph projections and INDEX-SCHEMA guards', () => {
  it('parses every new document and checks nested selections against the independent current schema snapshot', () => {
    const schema = parse(readFileSync(new URL('./fixtures/core-update/authority/schema.graphql', import.meta.url), 'utf8'));
    const types = new Map(schema.definitions.filter(d => d.kind === Kind.OBJECT_TYPE_DEFINITION).map(d => [d.name.value, d]));
    function named(type: TypeNode): string { return type.kind === Kind.NAMED_TYPE ? type.name.value : named(type.type); }
    function check(set: SelectionSetNode, type: string) {
      const object = types.get(type)!;
      expect(object, `schema type ${type}`).toBeDefined();
      for (const selection of set.selections) {
        if (selection.kind !== Kind.FIELD) throw new Error('Unexpected fragment');
        const field = object.fields!.find(f => f.name.value === selection.name.value);
        expect(field, `${type}.${selection.name.value}`).toBeDefined();
        if (selection.selectionSet) check(selection.selectionSet, named(field!.type));
      }
    }
    const rootTypes: Record<string, string> = { organization: 'Organization', subjects: 'Subject', subjectMemberships: 'SubjectMembership', groupCompositions: 'GroupComposition', permRows: 'PermRow', accessRules: 'AccessRule', subjectVouchRecords: 'SubjectVouchRecord', pendingActions: 'PendingAction' };
    for (const [key, doc] of Object.entries(docs).filter(([k]) => k.endsWith('_PAGE') || k.endsWith('_STATE'))) {
      const ast = parse(doc); const operation = ast.definitions[0];
      if (operation.kind !== Kind.OPERATION_DEFINITION) throw new Error('Missing operation');
      for (const selection of operation.selectionSet.selections) {
        if (selection.kind !== Kind.FIELD || selection.name.value === '_meta') continue;
        check(selection.selectionSet!, rootTypes[selection.name.value]);
        expect(selection.arguments?.find(a => a.name.value === 'block')?.value).toMatchObject({ kind: Kind.VARIABLE, name: { value: 'block' } });
        if (key.endsWith('_PAGE')) {
          expect(selection.arguments?.find(a => a.name.value === 'first')?.value).toMatchObject({ kind: Kind.VARIABLE, name: { value: 'first' } });
          expect(doc).toContain('orderBy: id, orderDirection: asc'); expect(doc).toContain('id_gt: $lastId');
          // Every nested relation is a singular reference/config; no capped nested arrays.
          const listSelections = (set: SelectionSetNode, type: string): boolean => set.selections.some(s => {
            if (s.kind !== Kind.FIELD || !s.selectionSet) return false;
            const f = types.get(type)!.fields!.find(f => f.name.value === s.name.value)!;
            const t = f.type.kind === Kind.NON_NULL_TYPE ? f.type.type : f.type;
            return t.kind === Kind.LIST_TYPE || listSelections(s.selectionSet, named(f.type));
          });
          expect(listSelections(selection.selectionSet!, rootTypes[selection.name.value])).toBe(false);
        }
      }
    }
  });
  it('pages 1001+ rows in every collection, including independent >1000 composition history and actors/full decimal IDs', async () => {
    const f = graphFixture();
    const result = await readAuthoritySnapshot({ source, query: f.query });
    expect(result.coverage.status).toBe('complete');
    expect(result.data.subjects).toHaveLength(1002); expect(result.data.memberships).toHaveLength(1001);
    expect(result.data.groupEdges).toHaveLength(1001); expect(result.data.permissions).toHaveLength(1001);
    expect(result.data.rules).toHaveLength(1001); expect(result.data.pendingActions).toHaveLength(1001); expect(result.data.vouches).toHaveLength(1001);
    for (const field of Object.keys(f.collections)) expect(f.calls.filter(c => c.field === field)).toHaveLength(2);
    expect(result.data.pendingActions[1000]).toMatchObject({ pendingId: '9007199254741993', actor: VOUCHER, cancelledBy: AUTH, subjectName: { state: 'known', value: 'Renamed 1000' } });
    expect(result.data.permissions[1000].subjectName).toMatchObject({ state: 'known', value: 'Renamed 1000' });
    expect(result.data.groupEdges[1000].roleName).toMatchObject({ state: 'known', value: 'Renamed 1000' });
    expect(result.data.pendingActions[1000].actorName).toMatchObject({ state: 'known', value: 'bob' });
    expect(result.data.memberships[1000].subject).toMatchObject({ subjectId: f.roleIds[1000], name: 'Renamed 1000' });
    expect(result.data.activeVouches.map(r => r.id)).toEqual(f.collections.subjectVouchRecords.filter(r => r.active && r.epoch === '2').map(r => r.id));
    expect(result.data.collections.subjectVouchRecords.data).toHaveLength(1001); // History kept independently of live filter.
    expect(f.calls.every(c => JSON.stringify(c.variables.block) === JSON.stringify({ hash: HASH }))).toBe(true);
  });
  it('retains structural adopted root history while excluding roots only from user-facing role view', async () => {
    const f = graphFixture(1), root = (19n << 224n).toString();
    f.collections.subjects.push({ ...f.collections.subjects.find(s => s.kind === 'Role'), id: root, subjectId: root, name: 'Structural ownership' });
    f.collections.subjects.sort((a, b) => a.id < b.id ? -1 : 1);
    const result = await readAuthoritySnapshot({ source, query: f.query });
    expect(result.coverage.status).toBe('complete'); expect(result.data.subjects.map(s => s.subjectId)).toContain(root);
    expect(authorityMemberRoleSubjects(result).map(s => s.subjectId)).not.toContain(root);
  });
  it.each(['late-page', 'missing-array', 'stalled-cursor', 'wrong-block', 'partial-envelope', 'null-word'] as const)('reports %s as incomplete/unavailable with retained evidence and no retired fallback', async failure => {
    const f = graphFixture();
    const query: AuthoritySnapshotQuery = async <T>(src: SourceRef, doc: string, variables: Record<string, unknown>) => {
      const result = await f.query<T>(src, doc, variables);
      if (doc.includes('query AuthorityPermsPage')) {
        const data = result.data as any;
        if (failure === 'late-page' && variables.lastId !== '') throw new Error('Offline injected failure');
        if (failure === 'missing-array') delete data.permRows;
        if (failure === 'stalled-cursor' && variables.lastId !== '') data.permRows = f.collections.permRows.slice(0, 1);
        if (failure === 'wrong-block') data._meta.block.number = 124;
        if (failure === 'partial-envelope') result.issues = [{ code: 'GRAPHQL_PARTIAL_ERROR' }];
        if (failure === 'null-word') data.permRows[0].word = null;
      }
      return result;
    };
    const result = await readAuthoritySnapshot({ source, query });
    expect(result.coverage.status).not.toBe('complete'); expect(result.coverage.issues.length).toBeGreaterThan(0);
    expect(result.data.subjects).toHaveLength(1002);
    if (failure === 'late-page') expect(result.data.permissions).toHaveLength(1000);
    expect(f.calls.length).toBeLessThan(30);
  });
  it('makes unpinned, unready, unpopulated readiness and wrong authority unavailable before decision joins', async () => {
    const f = graphFixture(1);
    const spy: AuthoritySnapshotQuery = vi.fn(f.query) as any;
    expect((await readAuthoritySnapshot({ source: { ...source, snapshot: 'latest', block: undefined }, query: spy })).coverage).toMatchObject({ status: 'unavailable', issues: [{ code: 'PINNED_AUTHORITY_SNAPSHOT_REQUIRED' }] });
    expect(spy).not.toHaveBeenCalled();
    for (const authority of [ { id: AUTH, isRouterBound: false, cutoverAt: '10', paused: false }, { id: AUTH, paused: false }, { id: OTHER_AUTH, isRouterBound: true, cutoverAt: '1', paused: false } ]) {
      const query: AuthoritySnapshotQuery = async <T>(src: SourceRef) => ({ source: src, data: { _meta: { block: { number: 123, hash: HASH } }, organization: { id: ORG, membershipAuthority: authority } } as T, issues: [] });
      const result = await readAuthoritySnapshot({ source, query });
      expect(result.coverage.status).toBe('unavailable'); expect(result.data.subjects).toHaveLength(0);
    }
  });
  it('refuses caps and preserves unknown nullable names without replacing missing references with empty names', async () => {
    const f = graphFixture(3); f.collections.subjects.find(s => s.kind === 'Role').name = null;
    const result = await readAuthoritySnapshot({ source, query: f.query, pageSize: 1, maxPages: 1 });
    expect(result.coverage.status).toBe('incomplete');
    const full = await readAuthoritySnapshot({ source, query: f.query });
    expect(full.coverage.status).toBe('complete'); expect(full.data.subjects.some(s => s.name === null)).toBe(true);
    f.collections.subjectMemberships[0].subject = { subjectId: composeSubjectId(OTHER_AUTH, 1) };
    expect((await readAuthoritySnapshot({ source, query: f.query })).coverage.status).toBe('incomplete');
  });
});

describe('authority CLI/build compatibility and browser-only protocol boundaries', () => {
  it('keeps preexisting document names and authority action calldata byte-identical to the contract ABI', () => {
    expect(docs.FETCH_AUTHORITY_MEMBERSHIPS).toContain('query AuthorityMemberships(');
    expect(docs.FETCH_AUTHORITY_SUBJECTS).toContain('query AuthoritySubjects(');
    const cases = [ { method: 'claim' as const, args: ['9007199254740993'], signature: 'function claim(uint256)' },
      { method: 'setPerm' as const, args: ['7', AUTHORITY_KEYS.TM_PERMS, projectContext(0), permissionWord(8).toString()], signature: 'function setPerm(uint256,bytes32,bytes32,uint256)' } ];
    for (const c of cases) {
      const intent = buildAuthorityAction({ authorityAddress: AUTH, method: c.method, args: c.args });
      expect(encodeIntent(intent).data).toBe(new ethers.utils.Interface([c.signature]).encodeFunctionData(c.method, c.args));
    }
  });
});


describe('cross-module authority adapters and scoped live prerequisites', () => {
  it('integrates paged raw graph rows into user permissions and seeded activation without host-owned protocol folds', async () => {
    const f = graphFixture(3);
    f.collections.subjectMemberships[0].seededWhilePaused = true;
    f.collections.subjectMemberships[0].acceptedAt = '9999';
    const raw = await readAuthoritySnapshot({ source, query: f.query });
    const members = authorityAccountMembershipFacts(raw, ACCOUNT);
    const perm = projectUserPermissions({ snapshot: raw, memberships: members, scope: userScope, permKey: AUTHORITY_KEYS.TM_PERMS, ctx: GLOBAL });
    expect(value(perm.value)).toBe('8');
    const gate = electorateActivationFacts({ memberships: authorityAccountActivationMemberships(raw, ACCOUNT), authority: raw, scope: userScope,
      restrictions: knownFact([f.groupId]), proposalCreatedAt: knownFact('50') });
    expect(value(gate.activeSince)).toBe('1'); expect(value(gate.canVote)).toBe(true);
    expect(authorityAccountMembershipFacts(raw, VOUCHER).data.every(m => m.isMember.state === 'unknown')).toBe(true);
    expect(() => authorityAccountMembershipFacts({ ...raw, source: { ...raw.source, account: ACCOUNT } }, VOUCHER)).toThrow('ACCOUNT_SCOPE_MISMATCH');
    const partial = { ...raw, coverage: { ...raw.coverage, status: 'incomplete' as const } };
    expect(authorityAccountMembershipFacts(partial, ACCOUNT).data.every(m => m.isMember.state === 'unknown')).toBe(true);
  });
  it('requires live completion scope and the exact subject/pending ID; a generic true flag is insufficient', () => {
    const live = { ...source, indexed: false, account: ACCOUNT, method: 'canClaim' };
    const row = membership({ ruleKind: 'Grant' });
    expect(projectMembershipLifecycle({ snapshot: snapshot(row, ACCOUNT), scope: userScope,
      claimAuthorization: { subjectId: '7', authorized: knownFact(true, live) } }).claimAuthorized).toMatchObject({ state: 'known', value: true });
    expect(projectMembershipLifecycle({ snapshot: snapshot(row, ACCOUNT), scope: userScope,
      claimAuthorization: { subjectId: '8', authorized: knownFact(true, live) } }).claimAuthorized.state).toBe('unknown');
    const p = { ...pending, action: 'Grant' as const };
    const args = { ...pendingFacts, pending: knownFact(p), now: '1000', scope: userScope,
      completionAuthorization: { pendingId: pending.pendingId, authorized: knownFact(true, { ...live, method: 'callStatic.finalize' }) } };
    expect(value(projectPendingAction(args).canComplete)).toBe(true);
    expect(projectPendingAction({ ...args, completionAuthorization: { ...args.completionAuthorization, pendingId: '1' } }).canComplete.state).toBe('unknown');
    expect(projectPendingAction({ ...args, scope: { ...userScope, account: VOUCHER } }).canComplete.state).toBe('unknown');
    expect(projectPendingAction({ ...args, completionAuthorization: { pendingId: pending.pendingId, authorized: knownFact(true, { ...live, indexed: true }) } }).canComplete.state).toBe('unknown');
  });
  it('missing vouch counter is unknown even with a complete roster; disabled quorum preserves the raw epoch count', () => {
    const record = { id: 'live', subjectId: '7', user: ACCOUNT, voucher: VOUCHER, active: true, epoch: '2' };
    const args = { records: snapshot([record], ACCOUNT), scope: userScope, subjectId: '7', config: knownFact(membership().subject.vouchConfig!), wearerEpoch: knownFact('2'), rawCount: unknownFact<string>('MISSING_COUNTER'),
      authority: snapshot(permissionData()), viewerMemberships: snapshot([{ subjectId: '7', isMember: knownFact(true) }], VOUCHER), viewerScope: { ...scope, account: VOUCHER } };
    expect(projectVouchEligibility(args).met.state).toBe('unknown');
    const disabled = projectVouchEligibility({ ...args, config: knownFact({ ...membership().subject.vouchConfig!, quorum: '0' }), rawCount: knownFact('1') });
    expect(value(disabled.count)).toBe('1'); expect(value(disabled.met)).toBe(false);
  });
  it('read projections reject invalid or overflowing uint32 vouch counts instead of numeric rounding', () => {
    const row = membership({ vouchCount: '9007199254740993' });
    expect(lifecycle(row).eligible.state).toBe('unknown');
    expect(lifecycle(membership({ vouchCount: Number.MAX_SAFE_INTEGER + 1 })).eligible.state).toBe('unknown');
  });
  it('refuses source block/chain/account mismatches and oversized graph page requests', async () => {
    const query = vi.fn() as unknown as AuthoritySnapshotQuery;
    await expect(readAuthoritySnapshot({ source, query, pageSize: 1001 })).rejects.toThrow('between 1 and 1000');
    expect(query).not.toHaveBeenCalled();
    const memberships = snapshot([{ subjectId: '7', isMember: knownFact(true) }], ACCOUNT);
    for (const bad of [{ ...memberships, source: { ...memberships.source, account: VOUCHER } }, { ...memberships, source: { ...memberships.source, block: { number: '124', hash: HASH } } }]) {
      expect(projectUserPermissions({ snapshot: snapshot(permissionData()), memberships: bad, scope: userScope, permKey: AUTHORITY_KEYS.TM_PERMS, ctx: GLOBAL }).value.state).toBe('unknown');
    }
  });
});


describe('independent preliminary root-review counterexamples', () => {
  it('ROOT-AUTHORITY-ORDER-ZERO: exact holder order excludes a zero/no-row role while keeping group raw bool value3', () => {
    const d: AuthorityPermissionData = {
      subjects: [{ subjectId: '7', kind: 'Role', name: 'R' }, { subjectId: '9', kind: 'Group', name: 'A' }, { subjectId: '10', kind: 'Group', name: 'B' }],
      groupEdges: [{ id: 'a', groupSubjectId: '9', roleSubjectId: '7', isActive: true }, { id: 'b', groupSubjectId: '10', roleSubjectId: '7', isActive: true }],
      permissions: [{ id: 'a', subjectId: '9', permKey: AUTHORITY_KEYS.DD_VOTE, ctx: GLOBAL, word: permissionWord(2).toString() },
        { id: 'b', subjectId: '10', permKey: AUTHORITY_KEYS.DD_VOTE, ctx: GLOBAL, word: permissionWord(3).toString() }],
    };
    const p = effective(d, AUTHORITY_KEYS.DD_VOTE, GLOBAL, ['10', '9']);
    expect(value(p.value)).toBe('3'); expect(value(p.enabled)).toBe(true);
    expect(p.contributions.find(c => c.subjectId === '7')?.context).toMatchObject({ value: { value: '0' } });
    expect(value(effective(d, AUTHORITY_KEYS.DD_VOTE, GLOBAL, ['9', '10']).value)).toBe('2');
  });
  it('ROOT-AUTHORITY-RACE-STATUS: merely succeeded/ended, unfamiliar and contradictory execution flags cannot retire a creation race', () => {
    for (const status of ['Succeeded', 'Ended', 'Cleaned', 'Failed', 'Defeated', 'Cancelled', 'UnknownFutureStatus', 'Executed']) {
      const result = subjectCreationRaceFacts(snapshot([{ id: status, createsSubject: true, executed: false, status }]), scope);
      expect(result.competingIds).toEqual([status]); expect(value(result.hasCompetingCreation)).toBe(true);
    }
    const contradiction = subjectCreationRaceFacts(snapshot([{ id: 'c', createsSubject: true, executed: false, wasExecuted: true, status: 'Executed' }]), scope);
    expect(contradiction.competingIds).toEqual(['c']);
    expect(subjectCreationRaceFacts(snapshot([{ id: 'done', createsSubject: true, status: 'Executed' }]), scope).competingIds).toEqual([]);
  });
});


describe('authority amount/order/timing boundary invariants', () => {
  it('OR/MAX folds are commutative while bool raw fold depends on the supplied storage list order', () => {
    const vals = ['0', '1', '2', '8', ((1n << 253n) | 32n).toString()];
    for (const a of vals) for (const b of vals) {
      const mask = value(effective(permissionData(AUTHORITY_KEYS.TM_PERMS, a, b)).value);
      expect(BigInt(mask) & BigInt(a)).toBe(BigInt(a)); expect(BigInt(mask) & BigInt(b)).toBe(BigInt(b));
      expect(value(effective(permissionData(AUTHORITY_KEYS.TM_PERMS, b, a)).value)).toBe(mask);
      const key = permissionKey('scalar.max', 2);
      const max = value(effective(permissionData(key, a, b), key).value);
      expect([a, b]).toContain(max); expect(BigInt(max) >= BigInt(a) && BigInt(max) >= BigInt(b)).toBe(true);
      expect(value(effective(permissionData(key, b, a), key).value)).toBe(max);
    }
  });
  it('retains adopted member timestamps and large hexadecimal restrictions without cutover clamping', () => {
    const adopted = ((1n << 224n) + (1n << 208n)).toString();
    const data: AuthorityPermissionData = { subjects: [{ subjectId: adopted, kind: 'Role', name: 'Adopted' }], groupEdges: [], permissions: [] };
    const result = electorateActivationFacts({ authority: snapshot(data), memberships: snapshot([activationRow(adopted, '99')], ACCOUNT), scope: userScope,
      restrictions: knownFact([`0x${BigInt(adopted).toString(16)}`]), proposalCreatedAt: knownFact('1000') });
    expect(value(result.activeSince)).toBe('99'); expect(value(result.canVote)).toBe(true);
  });
  it('a role with missing membership but a proven zero permission cannot influence the permission fold', () => {
    const d = permissionData(); d.groupEdges = []; d.subjects = [{ subjectId: '7', name: 'Zero-role', kind: 'Role' }, { subjectId: '9', name: 'Grant-role', kind: 'Role' }];
    const p = projectUserPermissions({ snapshot: snapshot(d), memberships: snapshot([{ subjectId: '9', isMember: knownFact(true) }], ACCOUNT), scope: userScope, permKey: AUTHORITY_KEYS.TM_PERMS, ctx: GLOBAL });
    expect(value(p.value)).toBe('8'); expect(value(p.enabled)).toBe(true);
    expect(p.contributions.find(c => c.subjectId === '7')?.membership.state).toBe('unknown');
  });
});


it('missing referenced grant-rule provenance makes a transported graph membership incomplete', async () => {
  const f = graphFixture(1); f.collections.subjectMemberships[0].rule = null;
  const result = await readAuthoritySnapshot({ source, query: f.query });
  expect(result.coverage.status).toBe('incomplete');
  expect(result.coverage.issues).toContainEqual({ code: 'INVALID_AUTHORITY_ROW', id: 'subjectMemberships:000000' });
  expect(result.data.memberships).toHaveLength(0);
  expect(result.data.collections.subjectMemberships.data).toHaveLength(1);
});


it('empty transported subject rows cannot claim completeness against nonzero authority counts', async () => {
  const f = graphFixture(1);
  const query: AuthoritySnapshotQuery = async <T>(src: SourceRef, doc: string, vars: Record<string, unknown>) => {
    const result = await f.query<T>(src, doc, vars);
    if (doc.includes('query AuthoritySubjectsPage')) (result.data as any).subjects = [];
    return result;
  };
  const result = await readAuthoritySnapshot({ source, query });
  expect(result.coverage.status).toBe('incomplete');
  expect(result.coverage.issues).toContainEqual({ code: 'AUTHORITY_COUNT_MISMATCH', id: 'subjectCount' });
});


it('prediction/read refusals expose stable protocol codes rather than exception or endpoint text', async () => {
  const plan = predictNextSubjectIds({ authority: AUTH, scope, history: snapshot([{ subjectId: 'not-a-decimal-id' }]) });
  expect(plan).toMatchObject({ status: 'blocked', codes: ['INVALID_SUBJECT_PREDICTION_INPUT'] });
  const query: AuthoritySnapshotQuery = async () => { throw new Error('Injected endpoint failure at https://authority.invalid/private-route'); };
  const read = await readAuthoritySnapshot({ source, query });
  expect(read.coverage).toMatchObject({ status: 'unavailable', issues: [{ code: 'AUTHORITY_STATE_UNAVAILABLE' }] });
});
