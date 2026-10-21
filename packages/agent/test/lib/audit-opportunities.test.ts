import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ discover: vi.fn(), source: vi.fn(), members: vi.fn(), archive: vi.fn() }));
vi.mock('@poa-box/cli/lib/subgraph', () => ({ queryAllChains: mocks.discover }));
vi.mock('@poa-box/cli/lib/indexed-source', () => ({ createIndexedSource: mocks.source }));
vi.mock('@poa-box/cli/lib/protocol-reads', async () => {
  const { requireCompleteSnapshot } = await import('@poa-box/core/data/facts');
  return { readCurrentMemberTotals: mocks.members, readProposalArchive: mocks.archive, requireCompleteSnapshot };
});
import { findAuditOpportunities } from '../../src/lib/audit-opportunities';
const ORG = `0x${'11'.repeat(32)}`, AUTH = `0x${'22'.repeat(20)}`, HV = `0x${'33'.repeat(20)}`, DD = `0x${'44'.repeat(20)}`, HASH = `0x${'55'.repeat(32)}`;
const coverage = { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] };
const block = { number: '50', hash: HASH };
const snapshot = (source: any, data: any, status = 'complete') => ({ source, data, coverage: { ...coverage, status } });
const candidate = { id: ORG, name: 'Active DAO', membershipAuthority: { id: AUTH }, hybridVoting: { id: HV }, directDemocracyVoting: { id: DD } };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.discover.mockResolvedValue([{ chainId: 100, name: 'Gnosis', data: { organizations: [candidate] } }]);
  mocks.source.mockImplementation(async options => ({ source: { ...options, endpoint: 'fixture://index', method: 'audit', indexed: true, snapshot: 'pinned', block }, protocolQuery: vi.fn() }));
  mocks.members.mockImplementation(async ({ source }) => snapshot(source, { total: { state: 'known', value: '3' } }));
  mocks.archive.mockImplementation(async ({ source }) => snapshot(source, []));
});
describe('evidence-gated agent audit opportunities', () => {
  it('discovers bounded candidates and proves current totals plus both empty lanes at one pinned source', async () => {
    const result = await findAuditOpportunities();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ orgId: ORG, currentMembers: '3', proposals: { hybrid: '0', dd: '0' },
      sources: { members: { contract: AUTH, block }, hybrid: { contract: HV, block }, dd: { contract: DD, block } },
      coverage: { members: { status: 'complete' }, hybrid: { status: 'complete' }, dd: { status: 'complete' } } });
    expect(mocks.source).toHaveBeenCalledTimes(1);
    expect(mocks.archive.mock.calls.map(([options]) => options.lane)).toEqual(['hybrid', 'dd']);
    expect(mocks.discover).toHaveBeenCalledWith(expect.not.stringContaining('users('), { first: 10 });
  });
  it('does not suggest absence from a capped or unavailable proposal archive', async () => {
    for (const status of ['incomplete', 'unavailable']) {
      mocks.archive.mockImplementation(async ({ source, lane }) => snapshot(source, [], lane === 'dd' ? status : 'complete'));
      expect(await findAuditOpportunities()).toEqual([]);
    }
    mocks.archive.mockRejectedValue(new Error('offline'));
    expect(await findAuditOpportunities()).toEqual([]);
  });
  it('counts DD history and current authority accounts rather than historical active User rows', async () => {
    mocks.archive.mockImplementation(async ({ source, lane }) => snapshot(source, lane === 'dd' ? [{ proposalId: '1' }] : []));
    expect(await findAuditOpportunities()).toEqual([]);
    mocks.archive.mockImplementation(async ({ source }) => snapshot(source, []));
    mocks.discover.mockResolvedValue([{ chainId: 100, name: 'Gnosis', data: { organizations: [{ ...candidate,
      users: Array.from({ length: 100 }, () => ({ membershipStatus: 'Active' })) }] } }]);
    mocks.members.mockImplementation(async ({ source }) => snapshot(source, { total: { state: 'known', value: '1' } }));
    expect(await findAuditOpportunities()).toEqual([]);
    mocks.members.mockImplementation(async ({ source }) => snapshot(source, { total: { state: 'unknown', code: 'PARTIAL' } }));
    expect(await findAuditOpportunities()).toEqual([]);
  });
  it('rejects rebound scope, inconsistent coverage and a different pinned block', async () => {
    for (const patch of [{ block: { number: '51', hash: HASH } }, { contract: AUTH }, { chainId: 42161 }]) {
      mocks.archive.mockImplementation(async ({ source }) => snapshot({ ...source, ...patch }, []));
      expect(await findAuditOpportunities()).toEqual([]);
    }
    mocks.archive.mockImplementation(async ({ source }) => ({ ...snapshot(source, []), coverage: { ...coverage, missingIds: ['next-page'] } }));
    expect(await findAuditOpportunities()).toEqual([]);
  });
  it('skips missing modules and chain discovery failures without fabricating an empty lane', async () => {
    mocks.discover.mockResolvedValue([{ chainId: 100, name: 'Gnosis', data: { organizations: [{ ...candidate, directDemocracyVoting: null }] } }]);
    expect(await findAuditOpportunities()).toEqual([]); expect(mocks.source).not.toHaveBeenCalled();
    mocks.discover.mockResolvedValue([{ chainId: 100, name: 'Gnosis', error: 'offline', data: { organizations: [candidate] } }]);
    expect(await findAuditOpportunities()).toEqual([]); expect(mocks.source).not.toHaveBeenCalled();
  });
});
