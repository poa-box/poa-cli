import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeSubjectId, HATS_NAMESPACE_FLOOR } from '../src/authority/ids';
import { readCurrentMemberTotals } from '../src/reads/member-totals';
import { readTokenHolderTotals } from '../src/reads/token';
import { listAllCompletionsComplete, readEducationCompletionTotals } from '../src/reads/education';
import { requireCompleteSnapshot, type SourceRef } from '../src/data/facts';
import type { IndexedTotalOptions } from '../src/data/indexed-completeness';
import type { IndexedRow, ProtocolQuery } from '../src/reads/protocol';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const AUTH = address(1), TOKEN = address(2), HUB = address(3), EXEC = address(4), OLD_ELIG = address(5);
const ORG = `0x${'ee'.repeat(32)}`, OTHER_ORG = `0x${'dd'.repeat(32)}`, HASH = `0x${'ab'.repeat(32)}`;
const BLOCK = { number: '100', hash: HASH, timestamp: '1000' };
const source = (contract: string): SourceRef => ({ chainId: 100, orgId: ORG, contract, endpoint: 'fixture://gnosis', method: 'graph', indexed: true, snapshot: 'pinned', block: { ...BLOCK } });
const meta = () => ({ deployment: 'fixture-deployment', hasIndexingErrors: false, block: { number: 100, hash: HASH, timestamp: 1000 } });
const role = (n = 1) => ({ id: composeSubjectId(AUTH, n), subjectId: composeSubjectId(AUTH, n), kind: 'Role', defaultAllow: true,
  vouchConfig: null, organization: { id: ORG }, authority: { id: AUTH } });
function member(n: number, subject = role(), changes: IndexedRow = {}): IndexedRow {
  const user = address(100 + n);
  return { id: `${subject.subjectId}-${user}`, user, subject, accepted: true, emailVerified: false, ruleKind: 'None', vouchCount: 0, vouchEpoch: '0',
    organization: { id: ORG }, authority: { id: AUTH }, ...changes };
}
function balance(n: number, raw = '1'): IndexedRow {
  const account = address(100 + n);
  return { id: `${TOKEN}-${account}`, account, balance: raw, updatedAtBlock: '99', participationToken: { id: TOKEN, organization: { id: ORG } } };
}
function completion(n: number, learner = address(100 + n), moduleId = '1'): IndexedRow {
  return { id: `${HUB}-${moduleId}-${learner}`, learner, moduleId, completedAt: '999', completedAtBlock: '99', transactionHash: HASH,
    module: { id: `${HUB}-${moduleId}` }, educationHub: { id: HUB, organization: { id: ORG } } };
}
interface Fixture {
  options: IndexedTotalOptions; rows: IndexedRow[];
  calls: { document: string; variables: Record<string, unknown>; source: SourceRef }[];
  state: IndexedRow | null;
  alter?: (response: Record<string, unknown>, variables: Record<string, unknown>, document: string) => Record<string, unknown>;
}
function fixture(kind: 'members' | 'holders' | 'education', rows: IndexedRow[], pageSize = 2, maxPages = 1000): Fixture {
  const field = kind === 'members' ? 'organization' : kind === 'holders' ? 'participationTokenContract' : 'educationHubContract';
  const collection = kind === 'members' ? 'subjectMemberships' : kind === 'holders' ? 'tokenBalances' : 'moduleCompletions';
  const state: IndexedRow = kind === 'members' ? { id: ORG, executorContract: { id: EXEC }, eligibilityModule: { id: OLD_ELIG },
    membershipAuthority: { id: AUTH, isRouterBound: true, cutoverAt: '1', acceptedMembershipCount: rows.filter(r => r.accepted).length } }
    : kind === 'holders' ? { id: TOKEN, totalSupply: rows.reduce((sum, row) => sum + BigInt(String(row.balance)), 0n).toString(), organization: { id: ORG } }
      : { id: HUB, organization: { id: ORG } };
  const f: Fixture = { options: null as unknown as IndexedTotalOptions, rows, state, calls: [] };
  const query: ProtocolQuery = async (document, variables, ref) => {
    f.calls.push({ document, variables, source: ref });
    expect(ref).toEqual(f.options.source);
    expect(variables.block).toEqual({ hash: HASH });
    const response = document.includes('State(') ? { [field]: f.state, _meta: meta() }
      : { [collection]: f.rows.filter(row => String(row.id) > String(variables.cursor)).sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, variables.first as number), _meta: meta() };
    return f.alter ? f.alter(response, variables, document) : response;
  };
  f.options = { source: source(kind === 'members' ? AUTH : kind === 'holders' ? TOKEN : HUB), query, pageSize, maxPages };
  return f;
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Offline test forbids network'); })));
afterEach(() => vi.unstubAllGlobals());

describe('complete current member account totals from current authority inputs', () => {
  it('pages beyond 1000 candidates without consulting historical User rows', async () => {
    const f = fixture('members', Array.from({ length: 1001 }, (_, n) => member(n)), 500);
    const result = await readCurrentMemberTotals(f.options);
    expect(result.data.total).toMatchObject({ state: 'known', value: '1001' });
    expect(result.coverage.status).toBe('complete');
    expect(f.calls).toHaveLength(4); // State plus three independent ID pages.
    expect(f.calls.every(call => !call.document.includes('users('))).toBe(true);
    expect(f.calls.slice(1).every(call => call.variables.orgId === ORG && call.variables.authority === AUTH)).toBe(true);
  });
  it('deduplicates accounts across roles and excludes bans, renounced seats, stale epochs, structural roots and system addresses', async () => {
    const vouch = { ...role(3), defaultAllow: false, vouchConfig: { quorum: 1, epoch: '2' } };
    const structural = { ...role(4), id: HATS_NAMESPACE_FLOOR.toString(), subjectId: HATS_NAMESPACE_FLOOR.toString() };
    const f = fixture('members', [member(1), member(1, role(2)), member(2, role(), { ruleKind: 'Ban' }), member(3, role(), { accepted: false }),
      member(4, vouch, { vouchCount: 5, vouchEpoch: '1' }), member(5, structural),
      member(6, role(), { user: EXEC, id: `${role().id}-${EXEC}` }), member(7, role(), { user: OLD_ELIG, id: `${role().id}-${OLD_ELIG}` })]);
    const result = await readCurrentMemberTotals(f.options);
    expect(result.data.total).toMatchObject({ state: 'known', value: '1' });
    expect(result.data.members).toEqual([{ account: address(101), subjectIds: [role().id, role(2).id] }]);
  });
  it('uses revoked vouches, email revocation and subject defaults instead of a stale indexed isMember bit', async () => {
    const vouch = { ...role(), defaultAllow: false, vouchConfig: { quorum: 2, epoch: '2' } };
    const f = fixture('members', [member(1, vouch, { vouchCount: 1, vouchEpoch: '2', isMember: true }),
      member(2, { ...role(2), defaultAllow: false }, { emailVerified: false, isMember: true }), member(3, role(3), { isMember: false })]);
    expect((await readCurrentMemberTotals(f.options)).data.total).toMatchObject({ state: 'known', value: '1' });
  });
  it('accepts an eligible accepted grant and current epoch quorum; unaccepted offers remain excluded', async () => {
    const closed = { ...role(), defaultAllow: false };
    const f = fixture('members', [member(1, closed, { ruleKind: 'Grant' }), member(2, closed, { emailVerified: true }),
      member(3, { ...role(2), defaultAllow: false, vouchConfig: { quorum: 2, epoch: '3' } }, { vouchCount: 2, vouchEpoch: '3' }),
      member(4, closed, { accepted: false, ruleKind: 'Grant' })]);
    expect((await readCurrentMemberTotals(f.options)).data.total).toMatchObject({ state: 'known', value: '3' });
  });
  it.each(['organization', 'authority', 'foreign-subject', 'group', 'fold-inputs', 'duplicate-identity'])("refuses mismatched %s rows", async field => {
    const row = member(1);
    if (field === 'organization') row.organization = { id: OTHER_ORG };
    if (field === 'authority') row.authority = { id: TOKEN };
    if (field === 'foreign-subject') row.subject = { ...role(), authority: { id: AUTH }, id: composeSubjectId(TOKEN, 1), subjectId: composeSubjectId(TOKEN, 1) };
    if (field === 'group') row.subject = { ...role(), kind: 'Group' };
    if (field === 'fold-inputs') delete (row.subject as IndexedRow).vouchConfig;
    if (field === 'duplicate-identity') row.id = `alternative-${row.id}`;
    expect((await readCurrentMemberTotals(fixture('members', [row]).options)).data.total.state).toBe('unknown');
  });
  it('cross-checks all accepted role seats rather than treating a row count as a person count', async () => {
    const f = fixture('members', [member(1)]);
    (f.state!.membershipAuthority as IndexedRow).acceptedMembershipCount = 2;
    const result = await readCurrentMemberTotals(f.options);
    expect(result.data.total.state).toBe('unknown');
    expect(result.coverage.issues).toContainEqual({ code: 'ACCEPTED_MEMBERSHIP_COUNT_MISMATCH' });
  });
});

describe('positive holder totals and exact supply reconciliation', () => {
  it('exhausts all balances across pages; transfer-to-zero rows do not remain holders', async () => {
    const huge = '9007199254740993000000000000000001';
    const f = fixture('holders', [balance(1, huge), balance(2, '1'), balance(3, '0')]);
    const result = await readTokenHolderTotals(f.options);
    expect(result.data.total).toMatchObject({ state: 'known', value: '2' });
    expect(result.data.balanceTotalRaw).toMatchObject({ state: 'known', value: (BigInt(huge) + 1n).toString() });
    expect(result.data.holders.map(row => row.account)).toEqual([address(101), address(102)]);
    expect(result.data.evidence.balances.data).toHaveLength(3);
  });
  it('pages 1001 distinct holder identities and retains raw 1-wei precision', async () => {
    const f = fixture('holders', Array.from({ length: 1001 }, (_, n) => balance(n)), 500);
    const result = await readTokenHolderTotals(f.options);
    expect(result.data.total).toMatchObject({ state: 'known', value: '1001' });
    expect(result.data.balanceTotalRaw).toMatchObject({ state: 'known', value: '1001' });
  });
  it('a supply mismatch cannot be labelled complete even after a terminal empty page', async () => {
    const f = fixture('holders', [balance(1)]);
    f.state!.totalSupply = '2';
    const result = await readTokenHolderTotals(f.options);
    expect(result.coverage.issues).toContainEqual({ code: 'TOKEN_SUPPLY_RECONCILIATION_FAILED' });
    expect(result.data.total.state).toBe('unknown');
  });
  it.each(['token', 'org', 'zero-address', 'negative', 'future-block', 'wrong-id'])("rejects invalid %s balance evidence", async field => {
    const f = fixture('holders', [balance(1)]), row = f.rows[0];
    if (field === 'token') row.participationToken = { id: HUB, organization: { id: ORG } };
    if (field === 'org') row.participationToken = { id: TOKEN, organization: { id: OTHER_ORG } };
    if (field === 'zero-address') row.account = address(0);
    if (field === 'negative') row.balance = '-1';
    if (field === 'future-block') row.updatedAtBlock = '101';
    if (field === 'wrong-id') row.id = `wrong-${row.id}`;
    const result = await readTokenHolderTotals(f.options);
    expect(result.data.total.state).toBe('unknown'); expect(result.data.holders).toHaveLength(0);
  });
});

describe('all-learners indexed education totals', () => {
  it('counts completions and distinct learners independently across pages, including removed modules', async () => {
    const f = fixture('education', [completion(1), completion(1, address(101), '2'), completion(2, address(102), '2')]);
    const result = await readEducationCompletionTotals(f.options);
    expect(result.data.completions).toMatchObject({ state: 'known', value: '3' });
    expect(result.data.learners).toMatchObject({ state: 'known', value: '2' });
    expect(result.data.rewardTotalRaw).toMatchObject({ state: 'unknown', code: 'COMPLETION_PAYOUT_NOT_INDEXED' });
    expect(f.calls.slice(1).every(call => !('learner' in call.variables) && call.variables.hub === HUB && call.variables.orgId === ORG)).toBe(true);
  });
  it('exhausts 1001 all-learner rows without nesting completions in a capped module list', async () => {
    const result = await readEducationCompletionTotals(fixture('education', Array.from({ length: 1001 }, (_, n) => completion(n)), 500).options);
    expect(result.data.completions).toMatchObject({ state: 'known', value: '1001' });
  });
  it.each(['hub', 'org', 'learner', 'identity', 'block'])("rejects %s completion mismatches", async field => {
    const row = completion(1);
    if (field === 'hub') row.educationHub = { id: TOKEN, organization: { id: ORG } };
    if (field === 'org') row.educationHub = { id: HUB, organization: { id: OTHER_ORG } };
    if (field === 'learner') row.learner = address(0);
    if (field === 'identity') row.module = { id: 'other-module' };
    if (field === 'block') row.completedAtBlock = '101';
    const result = await readEducationCompletionTotals(fixture('education', [row]).options);
    expect(result.data.completions.state).toBe('unknown'); expect(result.data.observedLearners).toEqual([]);
  });
  it('does not turn an account-scoped completion history into an all-learners aggregate', async () => {
    const f = fixture('education', []); f.options.source.account = address(100);
    expect(() => listAllCompletionsComplete(f.options)).toThrow('PINNED_INDEXED_TOTAL_SCOPE_REQUIRED');
    expect(f.calls).toHaveLength(0);
  });
});

describe('indexed aggregate coverage, snapshot and failure boundaries', () => {
  const cases = [
    ['members', readCurrentMemberTotals, () => member(1)], ['holders', readTokenHolderTotals, () => balance(1)], ['education', readEducationCompletionTotals, () => completion(1)],
  ] as const;
  for (const [kind, read, row] of cases) {
    it(`${kind}: known empty requires indexed entity presence and a complete response`, async () => {
      const f = fixture(kind, []), result = await read(f.options);
      expect(result.coverage.status).toBe('complete'); requireCompleteSnapshot(result);
      f.state = null;
      expect((await read(f.options)).coverage.status).not.toBe('complete');
    });
    it(`${kind}: chain, org and endpoint identity remain mandatory at the consumer boundary`, async () => {
      const result = await read(fixture(kind, []).options);
      for (const scope of [
        { chainId: 42161 }, { chainId: 100, orgId: OTHER_ORG }, { chainId: 100, endpoint: 'fixture://another-chain' },
      ]) expect(() => requireCompleteSnapshot(result, { scope })).toThrow('SCOPE_MISMATCH');
    });
    it(`${kind}: a full capped page remains partial and preserves its valid row`, async () => {
      const result = await read(fixture(kind, [row()], 1, 1).options);
      expect(result.coverage.status).toBe('incomplete');
      expect(result.coverage.issues.some(issue => issue.code === 'PAGE_CAP')).toBe(true);
      expect(result.coverage.receivedKeys.length).toBeGreaterThan(0);
    });
    it.each(['drift', 'missing-proof', 'duplicate', 'error', 'missing', 'index-error', 'deployment', 'late-proof'])(`${kind}: does not fabricate a total after %s`, async failure => {
      const f = fixture(kind, [row()], 1, 3);
      f.alter = (response, variables, document) => {
        if (document.includes('State(')) return response;
        const collection = kind === 'members' ? 'subjectMemberships' : kind === 'holders' ? 'tokenBalances' : 'moduleCompletions';
        if (failure === 'drift') (response._meta as any).block.number = 101;
        if (failure === 'missing-proof') delete (response._meta as any).block;
        if (failure === 'duplicate') response[collection] = [row(), row()];
        if (failure === 'error' && variables.cursor) throw new Error('private provider details must not escape');
        if (failure === 'missing') delete response[collection];
        if (failure === 'index-error') (response._meta as any).hasIndexingErrors = true;
        if (failure === 'deployment') (response._meta as any).deployment = 'other-deployment';
        if (failure === 'late-proof' && variables.cursor) (response._meta as any).block.timestamp = 1001;
        return response;
      };
      const result = await read(f.options);
      expect(result.coverage.status).not.toBe('complete');
      expect(() => requireCompleteSnapshot(result)).toThrow();
      expect(JSON.stringify(result.coverage)).not.toContain('private provider');
    });
    it(`${kind}: rejects latest sources, account scoping and unbounded limits before any query`, async () => {
      for (const mutation of [
        (f: Fixture) => { f.options.source.snapshot = 'latest'; },
        (f: Fixture) => { f.options.source.account = address(99); },
        (f: Fixture) => { f.options.maxPages = Infinity; },
        (f: Fixture) => { f.options.pageSize = 1001; },
      ]) {
        const f = fixture(kind, []); mutation(f);
        await expect(read(f.options)).rejects.toThrow(); expect(f.calls).toHaveLength(0);
      }
    });
  }
});
