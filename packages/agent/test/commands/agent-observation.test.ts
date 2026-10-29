import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ observe: vi.fn(), identity: vi.fn(), json: vi.fn(), error: vi.fn(), writeState: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/lib/protocol-observation', () => ({ observeAgentProtocol: mocks.observe }));
vi.mock('../../src/lib/audit-opportunities', () => ({ findAuditOpportunities: mocks.audit }));
vi.mock('@poa-box/cli/lib/signer', () => ({ resolveIdentityAddress: mocks.identity }));
vi.mock('@poa-box/cli/lib/resolve', () => ({ resolveOrgModules: async () => ({ orgId: 'org' }) }));
vi.mock('@poa-box/cli/config/networks', () => ({ resolveNetworkConfig: () => ({ chainId: 100, resolvedRpc: 'http://unit.invalid', nativeCurrency: { symbol: 'xDAI' } }) }));
vi.mock('@poa-box/cli/lib/output', () => ({ spinner: () => ({ start() {}, stop() {} }), isJsonMode: () => true, json: mocks.json, error: mocks.error }));
vi.mock('@poa-box/cli/lib/no-alloc-cache', () => ({ getNoAllocationSet: () => new Set() }));
vi.mock('@poa-box/cli/lib/contracts', () => ({ createReadContract: vi.fn() }));
vi.mock('@poa-box/cli/commands/vote/helpers', () => ({ resolveVotingContracts: async () => ({}) }));
vi.mock('fs', () => ({ readFileSync: () => { throw new Error('no state'); }, existsSync: () => false, writeFileSync: mocks.writeState }));
vi.mock('ethers', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, ethers: { ...real.ethers, providers: { JsonRpcProvider: class { getBalance = async () => real.ethers.utils.parseEther('1'); } } } };
});
import { agentStatusHandler } from '../../src/commands/agent/status';
import { triageHandler } from '../../src/commands/agent/triage';

const address = '0x' + '11'.repeat(20);
const coverage = { status: 'complete' };
function observation() {
  return { org: { name: 'Org', users: [{ address, membershipStatus: 'Active', historyIndexed: false,
    participationTokenBalance: null, totalTasksCompleted: null, totalVotes: null }],
    participationToken: { totalSupply: '100' }, taskManager: { projects: [] },
    hybridVoting: { proposals: [] }, directDemocracyVoting: { ddvProposals: [] }, paymentManager: { distributions: [] } },
    coverage: { members: coverage, memberTotal: coverage, tasks: coverage, hybrid: coverage, dd: coverage, distributions: coverage },
    sources: {}, memberTotal: '1', hasReleaseData: true };
}
describe('agent read-only observations', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.identity.mockReturnValue(address); mocks.observe.mockResolvedValue(observation()); mocks.audit.mockResolvedValue([]); });

  it('uses address identity and does not fabricate historical counters for authority-only members', async () => {
    await agentStatusHandler.handler({ address, chain: 100 } as any);
    expect(mocks.identity).toHaveBeenCalledWith(expect.objectContaining({ address }), expect.objectContaining({ required: true }));
    expect(mocks.json.mock.calls[0][0]).toMatchObject({ wallet: address, memberStatus: 'Active', historyIndexed: false,
      pt: null, ptShare: null, tasksCompleted: null, votesCast: null });
  });

  it('keeps unavailable board and ballot counts unknown', async () => {
    const result: any = observation();
    result.coverage.tasks = { status: 'unavailable' }; result.coverage.dd = { status: 'incomplete' };
    mocks.observe.mockResolvedValue(result);
    await agentStatusHandler.handler({ address } as any);
    expect(mocks.json.mock.calls[0][0]).toMatchObject({ myAssigned: null, mySubmitted: null, awaitingMyReview: null, unvotedProposals: null });
  });

  it('never recommends planning an empty board from a failed board read', async () => {
    const result: any = observation(); result.coverage.tasks = { status: 'unavailable' };
    mocks.observe.mockResolvedValue(result);
    await triageHandler.handler({ address } as any);
    const data = mocks.json.mock.calls[0][0];
    expect(data.actions.some((a: any) => a.type === 'plan')).toBe(false);
    expect(data.actions.some((a: any) => a.type === 'observation-incomplete')).toBe(true);
    expect(data.context).toMatchObject({ boardState: 'unknown', openTasks: null });
    expect(mocks.writeState).not.toHaveBeenCalled();
  });

  it('separates application tasks and retains DD lane identity without voting on unknown ballots', async () => {
    const result: any = observation();
    result.org.taskManager.projects = [{ tasks: [
      { taskId: '1', title: 'Application', status: 'Open', requiresApplication: true },
      { taskId: '2', title: 'Claim', status: 'Open', requiresApplication: false },
    ] }];
    result.org.directDemocracyVoting.ddvProposals = [
      { proposalId: '8', lane: 'dd', status: 'Active', endTimestamp: String(Date.now() / 1000 + 3600), votes: [], ballotCoverage: coverage },
      { proposalId: '9', lane: 'dd', status: 'Active', votes: [], ballotCoverage: { status: 'incomplete' } },
    ];
    mocks.observe.mockResolvedValue(result);
    await triageHandler.handler({ address } as any);
    const actions = mocks.json.mock.calls[0][0].actions;
    expect(actions.find((a: any) => a.type === 'apply-task').data.tasks.map((t: any) => t.id)).toEqual(['1']);
    expect(actions.find((a: any) => a.type === 'claim-task').data.tasks.map((t: any) => t.id)).toEqual(['2']);
    expect(actions.filter((a: any) => a.type === 'vote').map((a: any) => a.data)).toEqual([expect.objectContaining({ proposalId: '8', lane: 'dd' })]);
    expect(mocks.json.mock.calls[0][0].context).toMatchObject({ pendingVotes: null, observedPendingVotes: 1 });
  });

  it('treats an absent recorded claim as an unverified entitlement candidate', async () => {
    const result: any = observation();
    result.org.taskManager.projects = [{ tasks: [{ taskId: '1', status: 'Open', requiresApplication: false }] }];
    result.org.paymentManager.distributions = [{ distributionId: '5', claimCoverage: coverage, claims: [] }];
    mocks.observe.mockResolvedValue(result);
    await triageHandler.handler({ address } as any);
    expect(mocks.json.mock.calls[0][0].actions.find((a: any) => a.type === 'claim')).toMatchObject({
      detail: expect.stringContaining('claim-stored only for a verified positive entitlement'),
      data: { distributionIds: ['5'], entitlementVerified: false },
    });
  });
  it('attaches current authority and complete lane evidence to an empty-history audit suggestion', async () => {
    const evidence = { orgId: 'org-candidate', orgName: 'Active DAO', chainId: 100, chainName: 'Gnosis', currentMembers: '4',
      proposals: { hybrid: '0', dd: '0' }, coverage: { members: coverage, hybrid: coverage, dd: coverage },
      sources: { members: { block: { number: '50' } }, hybrid: { block: { number: '50' } }, dd: { block: { number: '50' } } } };
    mocks.audit.mockResolvedValue([evidence]);
    await triageHandler.handler({ address } as any);
    expect(mocks.json.mock.calls[0][0].actions.find((action: any) => action.type === 'audit-opportunity')).toMatchObject({
      detail: 'Active DAO (Gnosis): 4 current member accounts, 0 Hybrid + DD proposals — audit opportunity.', data: evidence,
    });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });
});
