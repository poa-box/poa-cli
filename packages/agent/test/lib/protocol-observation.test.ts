import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), projects: vi.fn(), users: vi.fn(), archive: vi.fn(),
  ballots: vi.fn(), distributions: vi.fn(), claims: vi.fn(), totals: vi.fn(), source: vi.fn() }));
vi.mock('@poa-box/cli/lib/subgraph', () => ({ query: mocks.query }));
vi.mock('@poa-box/cli/lib/subgraph-module-client', () => ({ subgraphModuleClient: () => ({}) }));
vi.mock('@poa-box/cli/lib/indexed-source', () => ({ createIndexedSource: mocks.source }));
vi.mock('@poa-box/cli/lib/protocol-reads', () => ({ fetchProjectsData: mocks.projects, readAuthorityUsers: mocks.users,
  readProposalArchive: mocks.archive, readProposalBallotFacts: mocks.ballots, readDistributionHistoryFacts: mocks.distributions,
  readDistributionClaimFacts: mocks.claims, readCurrentMemberTotals: mocks.totals }));
import { observeAgentProtocol } from '../../src/lib/protocol-observation';

const address = '0x' + '11'.repeat(20), orgId = '0x' + '22'.repeat(32);
const modules: any = { orgId, taskManagerAddress: address, membershipAuthorityAddress: address,
  hybridVotingAddress: address, ddVotingAddress: '0x' + '33'.repeat(20), paymentManagerAddress: address };
const coverage = { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] };
const snapshot = (data: any, status = 'complete') => ({ data, coverage: { ...coverage, status }, source: { block: { number: '50' } } });

describe('agent protocol observation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ organization: { name: 'Org', participationToken: { totalSupply: '10' } } });
    mocks.users.mockResolvedValue([{ address, historyIndexed: false, membershipStatus: 'Active', totalTasksCompleted: null }]);
    mocks.projects.mockResolvedValue({ data: { organization: { taskManager: { projects: [] } } }, hasReleaseData: true, hasDeadlineData: true });
    mocks.source.mockImplementation(async scope => ({ source: scope, protocolQuery: vi.fn() }));
    mocks.archive.mockResolvedValue(snapshot([])); mocks.ballots.mockResolvedValue(snapshot([]));
    mocks.distributions.mockResolvedValue(snapshot([])); mocks.claims.mockResolvedValue(snapshot([]));
    mocks.totals.mockResolvedValue(snapshot({ total: { state: 'known', value: '1' } }));
  });

  it('retains authority-only history as unknown and uses independently attested member totals', async () => {
    const result = await observeAgentProtocol(modules, 42161);
    expect(result.org.users[0]).toMatchObject({ historyIndexed: false, totalTasksCompleted: null });
    expect(result.memberTotal).toBe('1');
    expect(mocks.source).toHaveBeenCalledWith({ chainId: 42161, orgId, contract: modules.ddVotingAddress });
    expect(result.coverage.tasks).toMatchObject({ status: 'complete', atomic: false });
    expect(result.sources.members).toMatchObject({ snapshot: 'latest', atomic: false });
    expect(result.sources.members).not.toHaveProperty('block');
    expect(result.sources.memberTotal).toEqual({ block: { number: '50' } });
  });

  it('does not promote failed board reads or truncated proposal rows into actionable absence', async () => {
    mocks.projects.mockRejectedValue(new Error('offline'));
    mocks.archive.mockResolvedValue(snapshot([{ proposalId: '2', status: 'Active' }], 'incomplete'));
    mocks.totals.mockResolvedValue(snapshot({ total: { state: 'unknown', code: 'INCOMPLETE' } }, 'incomplete'));
    const result = await observeAgentProtocol(modules, 100);
    expect(result.coverage.tasks.status).toBe('unavailable');
    expect(result.coverage.hybrid.status).toBe('incomplete');
    expect(result.org.hybridVoting.proposals).toEqual([]);
    expect(result.memberTotal).toBeNull();
    expect(mocks.ballots).not.toHaveBeenCalled();
  });

  it('keeps lane identity and refuses partial ballots or partial claim logs', async () => {
    mocks.archive.mockResolvedValue(snapshot([{ proposalId: '2', status: 'Active', winningOption: null }]));
    mocks.ballots.mockResolvedValue(snapshot([{ voter: address }], 'incomplete'));
    mocks.distributions.mockResolvedValue(snapshot([{ distributionId: '3', status: 'Active' }]));
    mocks.claims.mockResolvedValue(snapshot([{ claimer: address }], 'incomplete'));
    const result = await observeAgentProtocol(modules, 100);
    expect(result.org.hybridVoting.proposals[0]).toMatchObject({ lane: 'hybrid', votes: [], ballotCoverage: { status: 'incomplete' } });
    expect(result.org.directDemocracyVoting.ddvProposals[0]).toMatchObject({ lane: 'dd' });
    expect(result.org.paymentManager.distributions[0]).toMatchObject({ claims: [], claimCoverage: { status: 'incomplete' } });
  });

  it('bounds detailed ballot work without calling the overflow unvoted', async () => {
    mocks.archive.mockImplementation(async ({ lane }) => snapshot(lane === 'dd' ? [] : Array.from({ length: 101 }, (_, i) => ({ proposalId: String(i), status: 'Active' }))));
    const result = await observeAgentProtocol(modules, 100);
    expect(mocks.ballots).toHaveBeenCalledTimes(100);
    expect(result.org.hybridVoting.proposals[100].ballotCoverage.status).toBe('unavailable');
  });
});
