import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deriveDirectDemocracyAuthorization, DirectDemocracyAuthorizationInput } from '../src/governance/dd-authorization';
import { AuthorityPermissionData } from '../src/authority/permissions';
import { ActivationMembership } from '../src/authority/activation';
import { Fact, knownFact, SourceRef, SourceSnapshot, unknownFact } from '../src/data/facts';
import { AUTHORITY_KEYS, permissionWord } from '../src/tx/authority';
import { buildDonateToSolidarity } from '../src/tx/paymaster';
import { encodeIntent } from '../src/tx/intent';

const A = `0x${'11'.repeat(20)}`, B = `0x${'22'.repeat(20)}`, DD = `0x${'33'.repeat(20)}`, AUTH = `0x${'44'.repeat(20)}`;
const ORG = `0x${'55'.repeat(32)}`, HASH = `0x${'66'.repeat(32)}`, ZERO = ethers.constants.AddressZero;
// Adopted uint256 IDs must not become Number, local sequence, or bit-decoded Hats.
const ROLE = ((1n << 224n) + 9007199254740993n).toString(), ROLE2 = (BigInt(ROLE) + 1n).toString(), GROUP = (BigInt(ROLE) + 2n).toString();
const CTX = `0x${'0'.repeat(64)}`;
const source: SourceRef = { chainId: 100, orgId: ORG, contract: DD, endpoint: 'fixture://dd', method: 'dd-policy', indexed: false,
  snapshot: 'pinned', block: { number: '1234', hash: HASH }, contracts: { membershipAuthority: AUTH, directDemocracyVoting: DD } };
function snapshot<T>(data: T, src: SourceRef): SourceSnapshot<T> {
  return { source: src, data, coverage: { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] } };
}
function input(executor = false, restricted = false): DirectDemocracyAuthorizationInput {
  const authority: AuthorityPermissionData = { subjects: [
    { subjectId: ROLE, kind: 'Role', name: 'R' }, { subjectId: ROLE2, kind: 'Role', name: 'R2' }, { subjectId: GROUP, kind: 'Group', name: 'G' }],
    groupEdges: [{ id: 'g-r', groupSubjectId: GROUP, roleSubjectId: ROLE, isActive: true }, { id: 'g-r2', groupSubjectId: GROUP, roleSubjectId: ROLE2, isActive: false }],
    permissions: [{ id: 'p', subjectId: GROUP, permKey: AUTHORITY_KEYS.DD_VOTE, ctx: CTX, word: permissionWord('1').toString() }] };
  const memberships: ActivationMembership[] = [
    { subjectId: ROLE, isMember: knownFact(true), acceptedAt: knownFact('900'), seededWhilePaused: knownFact(false) },
    { subjectId: ROLE2, isMember: knownFact(true), acceptedAt: knownFact('800'), seededWhilePaused: knownFact(false) }];
  return { scope: { ...source, account: A }, proposalId: '9007199254740993',
    proposal: snapshot({ proposalId: '9007199254740993', createdAt: knownFact('1000', source), membershipAuthority: knownFact(AUTH, source),
      executor: knownFact(executor ? A : B, source), restricted: knownFact(restricted, source), restrictedSubjectIds: knownFact([GROUP], source) }, source),
    authority: snapshot(authority, { ...source, contract: AUTH }),
    memberships: snapshot(memberships, { ...source, contract: AUTH, account: A }) };
}
function raw<T>(f: Fact<T>): T { expect(f.state).toBe('known'); if (f.state !== 'known') throw new Error(f.code); return f.value; }
const mutable = (i: DirectDemocracyAuthorizationInput) => i.memberships!.data as ActivationMembership[];
const authData = (i: DirectDemocracyAuthorizationInput) => i.authority!.data as { subjects: any[]; groupEdges: any[]; permissions: any[] };

describe('DD Executor and activation contract-policy parity', () => {
  it('pins inspected DD/activation oracle hashes and critical ordering without claiming deployed bytecode parity', () => {
    const dir = new URL('./fixtures/core-update/governance/', import.meta.url);
    const dd = readFileSync(new URL('DirectDemocracyVoting.sol.txt', dir), 'utf8');
    const math = readFileSync(new URL('VotingMath.sol.txt', dir), 'utf8');
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(sha(dd)).toBe('fc77454fcafccfe6a386baf577f85af838a2365228571ff39f0ed54a8d57fd67');
    expect(sha(math)).toBe('0d5b60d2775240190103f0f80fe79d29cda7694feac67ec8e771206f5273b9cd');
    const vote = dd.slice(dd.indexOf('    function vote('), dd.indexOf('        if (p.hasVoted[_msgSender()])'));
    expect(vote.indexOf('if (a == address(0))')).toBeLessThan(vote.indexOf('if (_msgSender() != address(l.executor))'));
    expect(vote.indexOf('if (_msgSender() != address(l.executor))')).toBeLessThan(vote.indexOf('if (p.restricted)'));
    expect(math).toContain('if (createdAt == 0) return since != MEMBERSHIP_SENTINEL;');
  });
  it('Executor unrestricted bypass needs nonzero authority but no DD_VOTE or membership', () => {
    const i = input(true); delete i.authority; delete i.memberships;
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(true);
    i.proposal.data.membershipAuthority = knownFact(ZERO, source);
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(false);
    i.proposal.data.membershipAuthority = unknownFact('UNREAD');
    expect(deriveDirectDemocracyAuthorization(i).state).toBe('unknown');
  });
  it('Executor restricted still needs an allowed subject/group activation, without DD_VOTE', () => {
    const i = input(true, true); authData(i).permissions = [];
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(true);
    mutable(i)[0].isMember = knownFact(false);
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(false);
    mutable(i)[0].isMember = knownFact(true); mutable(i)[0].acceptedAt = knownFact('1001');
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(false);
    i.proposal.data.createdAt = knownFact('0', source);
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(true);
    i.proposal.data.restrictedSubjectIds = knownFact([], source);
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(false);
  });
  it.each([false, true])('normal member restricted=%s requires both DD_VOTE and creation-time activation', restricted => {
    const i = input(false, restricted);
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(true);
    authData(i).permissions = [];
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(false);
  });
  it('normal member cannot use a restricted-poll membership to bypass missing general DD_VOTE', () => {
    const i = input(false, true); mutable(i)[0].isMember = knownFact(false); i.proposal.data.restrictedSubjectIds = knownFact([ROLE2]);
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(false);
    i.proposal.data.executor = knownFact(A, source);
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(true);
  });
  it.each(['900', '1000', '1001'])('normal group activation at %s uses active edges and <= creation', at => {
    const i = input(); mutable(i)[0].acceptedAt = knownFact(at);
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(BigInt(at) <= 1000n);
    // Earlier inactive group role is not a qualifying fallback.
    expect(mutable(i)[1].acceptedAt).toMatchObject({ value: '800' });
    expect(authData(i).subjects.map(s => s.subjectId)).toEqual([ROLE, ROLE2, GROUP]);
  });
  it('chooses the earliest active role for group DD_VOTE, preserves seeded activation and sentinel membership-only semantics', () => {
    const i = input(); mutable(i)[0].acceptedAt = knownFact('1001');
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(false);
    authData(i).groupEdges[1].isActive = true;
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(true);
    authData(i).groupEdges[1].isActive = false; mutable(i)[0].seededWhilePaused = knownFact(true);
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(true);
    mutable(i)[0].seededWhilePaused = knownFact(false); i.proposal.data.createdAt = knownFact('0', source);
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(true);
    mutable(i)[0].isMember = knownFact(false);
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(false);
  });
  it('allows a direct role permission but rejects an active role outside the restricted group', () => {
    const i = input(false, true); authData(i).permissions[0].subjectId = ROLE2; mutable(i)[0].isMember = knownFact(false);
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(false);
    i.proposal.data.restrictedSubjectIds = knownFact([ROLE2], source);
    expect(raw(deriveDirectDemocracyAuthorization(i))).toBe(true);
  });
  it.each(['createdAt', 'executor', 'restricted', 'restrictedSubjectIds', 'membershipAuthority'] as const)('unknown %s never yields a positive restricted Executor result', key => {
    const i = input(true, true); (i.proposal.data as any)[key] = unknownFact('UNREAD');
    expect(deriveDirectDemocracyAuthorization(i).state).toBe('unknown');
  });
  it.each(['0', ((1n << 64n) - 1n).toString(), '-1', '1.5'])('malformed/unknown active timestamp %s stays unavailable', at => {
    const i = input(); mutable(i)[0].acceptedAt = knownFact(at);
    expect(deriveDirectDemocracyAuthorization(i).state).toBe('unknown');
  });
  it.each(['isMember', 'acceptedAt', 'seededWhilePaused'] as const)('unknown membership %s remains unavailable', key => {
    const i = input(); (mutable(i)[0] as any)[key] = unknownFact('UNREAD');
    expect(deriveDirectDemocracyAuthorization(i).state).toBe('unknown');
  });
  it.each(['proposal', 'authority', 'memberships'] as const)('rejects missing/mismatched %s observations including Executor', key => {
    for (const patch of [{ chainId: 42161 }, { orgId: 'other' }, { contract: B }, { block: { number: '1235' } },
      { block: { number: '1234', hash: `0x${'aa'.repeat(32)}` } }, { snapshot: 'latest' }, { contracts: { membershipAuthority: B } }]) {
      const i = input(true, true); i[key]!.source = { ...i[key]!.source, ...patch } as SourceRef;
      expect(deriveDirectDemocracyAuthorization(i).state).toBe('unknown');
    }
    const i = input(true, true); i[key]!.coverage.status = 'incomplete';
    expect(deriveDirectDemocracyAuthorization(i).state).toBe('unknown');
  });
  it('requires activation snapshots for a restricted Executor and source-bound membership facts', () => {
    const i = input(true, true); delete i.memberships;
    expect(deriveDirectDemocracyAuthorization(i).state).toBe('unknown');
    const j = input(); mutable(j)[0].acceptedAt = knownFact('900', { ...source, contract: AUTH, account: B });
    expect(deriveDirectDemocracyAuthorization(j).state).toBe('unknown');
  });
  it('rejects wrong proposal, per-fact source, unknown subjects and invalid opaque ids', () => {
    const i = input(); i.proposalId = '9007199254740992'; expect(deriveDirectDemocracyAuthorization(i).state).toBe('unknown');
    const j = input(); j.proposal.data.executor = knownFact(A, { ...source, contract: B }); expect(deriveDirectDemocracyAuthorization(j).state).toBe('unknown');
    for (const id of ['1', '1.5', '-1', (1n << 256n).toString()]) {
      const k = input(true, true); k.proposal.data.restrictedSubjectIds = knownFact([id]); expect(deriveDirectDemocracyAuthorization(k).state).toBe('unknown');
    }
  });
});

describe('strict raw native solidarity donation intent', () => {
  const oracle = new ethers.utils.Interface(JSON.parse(readFileSync(new URL('./fixtures/core-update/governance/PaymasterHub.abi.json', import.meta.url), 'utf8')));
  it.each([1n, '1', Number.MAX_SAFE_INTEGER, '900719925474099312345678901234567890', ((1n << 256n) - 1n).toString()])('retains raw amount %s and canonical ABI calldata', amountWei => {
    const intent = buildDonateToSolidarity({ paymasterHubAddress: AUTH, amountWei });
    expect(intent.args).toEqual([]); expect(intent.method).toBe('donateToSolidarity');
    expect(encodeIntent(intent)).toEqual({ to: AUTH, value: String(amountWei), data: oracle.encodeFunctionData('donateToSolidarity', []) });
    expect(intent.meta.summary?.amountWei).toBe(String(amountWei));
  });
  it.each([0, '0', 0n, -0, -1, -1n, '-1', 1.1, '0.1', '', ' 1', '1e18', '0x1', Number.MAX_SAFE_INTEGER + 1,
    (1n << 256n).toString(), undefined, null, true, {}])('rejects invalid/zero raw amount %s', amountWei => {
    expect(() => buildDonateToSolidarity({ paymasterHubAddress: AUTH, amountWei: amountWei as any })).toThrow();
  });
  it.each([ZERO, '', '0x1234', 'not-an-address', undefined])('rejects invalid/zero hub %s', paymasterHubAddress => {
    expect(() => buildDonateToSolidarity({ paymasterHubAddress: paymasterHubAddress as string, amountWei: '1' })).toThrow();
  });
});
