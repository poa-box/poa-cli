/**
 * `pop vote analyze` — subgraph-backed counterfactuals.
 *
 * This command used to do the two worst RPC reads in the repo: one un-chunked
 * queryFilter over the last 200,000 blocks (most public RPCs reject the range
 * outright) and then ONE balanceOf per voter, awaited strictly serially inside
 * a for-loop. Both are now single subgraph queries — Vote.classRawPowers is
 * the contract-emitted per-class power the command needs, and TokenBalance
 * mirrors balanceOf.
 *
 * What is pinned here: the report is byte-identical in shape to the event-
 * derived one, the per-class power is taken from the FROZEN class version, and
 * an empty/failed subgraph answer still falls back to the contract instead of
 * quietly reporting a different electorate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';

const {
  resolveOrgModulesMock,
  queryMock,
  queryWithFieldFallbackMock,
  resolveNetworkConfigMock,
  jsonMock,
  errorMock,
} = vi.hoisted(() => ({
  resolveOrgModulesMock: vi.fn(),
  queryMock: vi.fn(),
  queryWithFieldFallbackMock: vi.fn(),
  resolveNetworkConfigMock: vi.fn(),
  jsonMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock('../../src/lib/resolve', () => ({ resolveOrgModules: resolveOrgModulesMock }));
vi.mock('../../src/lib/subgraph', () => ({
  query: queryMock,
  queryWithFieldFallback: queryWithFieldFallbackMock,
  queryAllChains: vi.fn(async () => []),
}));
vi.mock('../../src/config/networks', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, resolveNetworkConfig: resolveNetworkConfigMock };
});
vi.mock('../../src/lib/output', () => ({
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), text: '' })),
  success: vi.fn(), error: errorMock, info: vi.fn(), warn: vi.fn(), debug: vi.fn(),
  table: vi.fn(), json: jsonMock, isJsonMode: vi.fn(() => true), keyValueBlock: vi.fn(),
}));

import { analyzeHandler, readProposalVoteEvents } from '../../src/commands/vote/analyze';

const HV = ethers.utils.getAddress('0x' + '1a'.repeat(20));
const PT = ethers.utils.getAddress('0x' + '2b'.repeat(20));
const ALICE = ethers.utils.getAddress('0x' + 'aa'.repeat(20));
const BOB = ethers.utils.getAddress('0x' + 'bb'.repeat(20));
const ORG_ID = '0x' + '11'.repeat(32);

const ONE = '1000000000000000000';

function classRow(classIndex: number, slicePct: number, version = '500') {
  return {
    version, classIndex,
    strategy: classIndex === 0 ? 'DIRECT' : 'ERC20_BAL',
    slicePct, quadratic: classIndex === 1,
    minBalance: '0', asset: classIndex === 0 ? ethers.constants.AddressZero : PT, hatIds: [], isActive: true,
  };
}

function analysisPayload(overrides: any = {}) {
  return {
    tierIndex: 0,
    data: {
      hybridVotingContract: {
        id: HV.toLowerCase(),
        organization: {
          id: ORG_ID,
          users: [{ address: ALICE.toLowerCase(), account: { username: 'alice' } }],
        },
        proposals: [{
          proposalId: '3',
          classesVersion: '500',
          isHatRestricted: false,
          votes: [
            {
              voter: ALICE.toLowerCase(), voterUsername: 'alice',
              optionIndexes: [0, 1], optionWeights: [100, 0],
              classRawPowers: ['100', '0'],
            },
            {
              voter: BOB.toLowerCase(), voterUsername: null,
              optionIndexes: [0, 1], optionWeights: [0, 100],
              classRawPowers: ['100', String(BigInt(ONE) * 50n)],
            },
          ],
        }],
        // A stale version must not leak into the math.
        votingClasses: [classRow(0, 1, '400'), classRow(1, 99, '400'), classRow(0, 50), classRow(1, 50)],
      },
      ...overrides,
    },
  };
}

describe('vote analyze', () => {
  let exitSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveOrgModulesMock.mockResolvedValue({
      orgId: ORG_ID, hybridVotingAddress: HV, participationTokenAddress: PT,
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
  });

  afterEach(() => vi.restoreAllMocks());

  // ── Sparse ballots ────────────────────────────────────────────────
  //
  // optionWeights[k] is the weight for option optionIndexes[k] — NOT for option
  // k. The subgraph copies the VoteCast(idxs, weights) params verbatim, so both
  // the indexed and the event path are sparse. Reading weights positionally, and
  // taking numOptions from the FIRST voter's array length, produced a confident
  // wrong winner. Live Gnosis has this shape all over: proposal
  // 0x13cbd5ed…-2's first ballot is idxs [1]/weights [100]; proposal …-9's is
  // idxs [3]; proposal 0xa9209afa…-22 has idxs [0,1,2,3,4,5].
  it('a ballot naming only option 1 is counted for option 1, not option 0', async () => {
    const payload = analysisPayload();
    payload.data.hybridVotingContract.proposals[0].votes = [
      // First voter is a single-option ballot for option 1. numOptions must NOT
      // collapse to 1, and this weight must NOT land on option 0.
      {
        voter: ALICE.toLowerCase(), voterUsername: 'alice',
        optionIndexes: [1], optionWeights: [100],
        classRawPowers: ['100', '0'],
      },
      {
        voter: BOB.toLowerCase(), voterUsername: null,
        optionIndexes: [1], optionWeights: [100],
        classRawPowers: ['100', '0'],
      },
    ];
    queryWithFieldFallbackMock.mockResolvedValue(payload);
    queryMock.mockResolvedValue({ tokenBalances: [] });

    await analyzeHandler.handler({ org: 'test-org', chain: 100, proposal: 3, json: true } as any);

    const report = jsonMock.mock.calls[0][0];
    expect(report.options).toBe(2);              // was 1
    expect(report.actual.winner.option).toBe(1); // was 0
    expect(report.actual.winner.pct).toBe(50); // The empty token class keeps its unused 50% slice.
  });

  it('scatters a partial multi-option ballot into the right slots', async () => {
    const payload = analysisPayload();
    payload.data.hybridVotingContract.proposals[0].votes = [
      {
        voter: ALICE.toLowerCase(), voterUsername: 'alice',
        optionIndexes: [3], optionWeights: [100],
        classRawPowers: ['100', '0'],
      },
      {
        voter: BOB.toLowerCase(), voterUsername: null,
        optionIndexes: [0, 3], optionWeights: [50, 50],
        classRawPowers: ['100', '0'],
      },
    ];
    queryWithFieldFallbackMock.mockResolvedValue(payload);
    queryMock.mockResolvedValue({ tokenBalances: [] });

    await analyzeHandler.handler({ org: 'test-org', chain: 100, proposal: 3, json: true } as any);

    const report = jsonMock.mock.calls[0][0];
    // numOptions is max(index)+1 across ALL ballots, so a partial first ballot
    // cannot shrink the option space.
    expect(report.options).toBe(4);
    expect(report.actual.winner.option).toBe(3);
    // 75% of the DIRECT class, whose configured slice is 50%.
    expect(report.actual.winner.pct).toBe(37.5);
  });

  it('builds the whole report from the subgraph — no provider, no queryFilter, one balance query', async () => {
    queryWithFieldFallbackMock.mockResolvedValue(analysisPayload());
    queryMock.mockResolvedValue({
      tokenBalances: [{ account: BOB.toLowerCase(), balance: String(BigInt(ONE) * 25n) }],
    });

    await analyzeHandler.handler({ org: 'test-org', chain: 100, proposal: 3, json: true } as any);

    // The contract path is never even constructed.
    expect(resolveNetworkConfigMock).not.toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();

    // ONE balance query for ALL voters, not one per voter.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][1]).toEqual({
      token: PT.toLowerCase(),
      accounts: [ALICE.toLowerCase(), BOB.toLowerCase()],
    });
    expect(queryMock.mock.calls[0][2]).toBe(100);

    const report = jsonMock.mock.calls[0][0];
    expect(report.proposalId).toBe(3);
    expect(report.voters).toBe(2);
    expect(report.options).toBe(2);
    expect(report.source).toBe('subgraph');
    // The FROZEN 50/50 config, not the 1/99 rows from version 400.
    expect(report.classConfig).toMatchObject([
      { slicePct: 50, quadratic: false },
      { slicePct: 50, quadratic: true },
    ]);

    // Per-vote shape is unchanged from the event-derived version.
    expect(report.votes).toEqual([
      { name: 'alice', weights: [100, 0], ptBalance: 0, ddPower: '100', tokenPower: '0' },
      { name: BOB.slice(0, 10), weights: [0, 100], ptBalance: 25, ddPower: '100', tokenPower: String(BigInt(ONE) * 50n) },
    ]);

    // Alice wins on DD-only power, Bob wins on token-only → SENSITIVE.
    expect(report.counterfactuals.ddOnly.winner.option).toBe(0);
    expect(report.counterfactuals.tokenOnly.winner.option).toBe(1);
    expect(report.robustness).toBe('SENSITIVE');
    expect(Object.keys(report.counterfactuals)).toEqual(['ddOnly', 'tokenOnly', 'noQuadratic', 'singlePick']);
  });

  it('normalizes token and DIRECT power separately before applying class slices', async () => {
    const payload = analysisPayload();
    payload.data.hybridVotingContract.votingClasses = [classRow(0, 80), classRow(1, 20)];
    payload.data.hybridVotingContract.proposals[0].votes[1].classRawPowers[0] = '0';
    queryWithFieldFallbackMock.mockResolvedValue(payload);
    queryMock.mockResolvedValue({ tokenBalances: [] });
    await analyzeHandler.handler({ org: 'test-org', chain: 100, proposal: 3, json: true } as any);
    const report = jsonMock.mock.calls[0][0];
    expect(report.actual.ranking).toEqual([{ option: 0, pct: 80 }, { option: 1, pct: 20 }]);
  });

  it('supports one DIRECT class and keeps unvoted options from numOptions', async () => {
    const payload: any = analysisPayload();
    payload.data.hybridVotingContract.votingClasses = [classRow(0, 100)];
    payload.data.hybridVotingContract.proposals[0].numOptions = 4;
    for (const vote of payload.data.hybridVotingContract.proposals[0].votes) vote.classRawPowers = ['100'];
    queryWithFieldFallbackMock.mockResolvedValue(payload);
    queryMock.mockResolvedValue({ tokenBalances: [] });
    await analyzeHandler.handler({ org: 'test-org', chain: 100, proposal: 3, json: true } as any);
    const report = jsonMock.mock.calls[0][0];
    expect(report.options).toBe(4);
    expect(report.actual.ranking).toHaveLength(4);
    expect(report.votes[0].tokenPower).toBe('0');
    expect(report.counterfactuals.tokenOnly).toMatchObject({ winner: null, available: false });
  });

  it('prefers the org username map, then Vote.voterUsername, then the truncated address', async () => {
    const payload = analysisPayload();
    payload.data.hybridVotingContract.proposals[0].votes[1].voterUsername = 'bob_from_vote';
    queryWithFieldFallbackMock.mockResolvedValue(payload);
    queryMock.mockResolvedValue({ tokenBalances: [] });

    await analyzeHandler.handler({ org: 'test-org', chain: 100, proposal: 3, json: true } as any);

    const report = jsonMock.mock.calls[0][0];
    expect(report.votes.map((v: any) => v.name)).toEqual(['alice', 'bob_from_vote']);
  });

  it('uses complete indexed ballots when restricted V2 classes require an on-chain snapshot', async () => {
    const payload: any = analysisPayload();
    payload.data.hybridVotingContract.proposals[0].isHatRestricted = true;
    payload.data.hybridVotingContract.proposals[0].numOptions = 4;
    for (const vote of payload.data.hybridVotingContract.proposals[0].votes) vote.classRawPowers = ['100'];
    queryWithFieldFallbackMock.mockResolvedValue(payload);
    queryMock.mockResolvedValue({ tokenBalances: [] });
    resolveNetworkConfigMock.mockReturnValue({ resolvedRpc: 'http://127.0.0.1:1' });
    const contract = { getProposalClasses: vi.fn().mockResolvedValue([classRow(0, 100)]), queryFilter: vi.fn() };
    vi.spyOn(ethers, 'Contract').mockImplementation((() => contract) as any);
    await analyzeHandler.handler({ org: 'test-org', chain: 100, proposal: 3, json: true } as any);
    expect(contract.getProposalClasses).toHaveBeenCalledWith(3);
    expect(contract.queryFilter).not.toHaveBeenCalled();
    expect(jsonMock.mock.calls[0][0]).toMatchObject({ voters: 2, options: 4, source: 'rpc' });
  });

  it('refuses a partial RPC history when the proposal creation block is unknown', async () => {
    queryWithFieldFallbackMock.mockRejectedValue(new Error('not indexed'));
    queryMock.mockResolvedValue({ proposal: null });
    resolveNetworkConfigMock.mockReturnValue({ resolvedRpc: 'http://127.0.0.1:1' });
    const contract = { getProposalClasses: vi.fn().mockResolvedValue([classRow(0, 100)]), queryFilter: vi.fn() };
    vi.spyOn(ethers, 'Contract').mockImplementation((() => contract) as any);
    await expect(analyzeHandler.handler({ org: 'test-org', chain: 100, proposal: 3, json: true } as any)).rejects.toThrow(/process.exit/);
    expect(errorMock).toHaveBeenCalledWith(expect.stringContaining('creation block or option count is not indexed'), expect.anything());
    expect(contract.queryFilter).not.toHaveBeenCalled();
    expect(jsonMock).not.toHaveBeenCalled();
  });

  it('reads PT balances beyond the first thousand voters', async () => {
    const ballot = (i: number) => ({ id: `vote-${String(i).padStart(4, '0')}`,
      voter: `0x${i.toString(16).padStart(40, '0')}`, optionIndexes: [0], optionWeights: [100], classRawPowers: ['100', '1'] });
    const first: any = analysisPayload();
    first.data.hybridVotingContract.proposals[0].votes = Array.from({ length: 1000 }, (_, i) => ballot(i));
    const second: any = analysisPayload();
    second.data.hybridVotingContract.proposals[0].votes = [ballot(1000)];
    queryWithFieldFallbackMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    queryMock.mockImplementation(async (_query, vars) => ({ tokenBalances: vars.accounts.map((account: string) => ({ account, balance: ONE })) }));
    await analyzeHandler.handler({ org: 'test-org', chain: 100, proposal: 3, json: true } as any);
    expect(queryMock.mock.calls.map(call => call[1].accounts.length)).toEqual([1000, 1]);
    expect(jsonMock.mock.calls[0][0].votes[1000].ptBalance).toBe(1);
  });

  it('falls back to the contract when the subgraph errors', async () => {
    queryWithFieldFallbackMock.mockRejectedValue(new Error('boom'));
    resolveNetworkConfigMock.mockReturnValue({ chainId: 100, resolvedRpc: 'http://127.0.0.1:1' });

    await expect(
      analyzeHandler.handler({ org: 'test-org', chain: 100, proposal: 3, json: true } as any)
    ).rejects.toThrow(/process.exit/);

    // Reaching resolveNetworkConfig is the signal that the contract path ran.
    expect(resolveNetworkConfigMock).toHaveBeenCalledWith(100);
    expect(jsonMock).not.toHaveBeenCalled();
  });

  it('an empty vote list is NOT an answer — indexing lag must not shrink the electorate', async () => {
    const payload = analysisPayload();
    payload.data.hybridVotingContract.proposals[0].votes = [];
    queryWithFieldFallbackMock.mockResolvedValue(payload);
    resolveNetworkConfigMock.mockReturnValue({ chainId: 100, resolvedRpc: 'http://127.0.0.1:1' });

    await expect(
      analyzeHandler.handler({ org: 'test-org', chain: 100, proposal: 3, json: true } as any)
    ).rejects.toThrow(/process.exit/);

    expect(resolveNetworkConfigMock).toHaveBeenCalled();
  });

  it('surfaces the missing-ParticipationToken error instead of silently reporting zero balances', async () => {
    resolveOrgModulesMock.mockResolvedValue({
      orgId: ORG_ID, hybridVotingAddress: HV, participationTokenAddress: null,
    });
    queryWithFieldFallbackMock.mockResolvedValue(analysisPayload());

    await expect(
      analyzeHandler.handler({ org: 'test-org', chain: 100, proposal: 3, json: true } as any)
    ).rejects.toThrow(/process.exit/);

    expect(errorMock).toHaveBeenCalledWith(
      'ParticipationToken not found for this org',
      expect.anything()
    );
    expect(resolveNetworkConfigMock).not.toHaveBeenCalled();
  });
});


describe('complete vote event history', () => {
  it('includes ballots older than 200,000 blocks and has no overlap at page boundaries', async () => {
    const blocks = [10, 10009, 10010, 220015];
    const hv = { filters: { VoteCast: vi.fn(() => ({})) }, queryFilter: vi.fn(async (_filter, from, to) =>
      blocks.filter(block => block >= from && block <= to).map(blockNumber => ({ blockNumber }))) };
    const events = await readProposalVoteEvents(hv as any, 3, 10, 230020);
    expect(events.map(event => event.blockNumber)).toEqual(blocks);
    expect(hv.queryFilter.mock.calls[0].slice(1)).toEqual([10, 10009]);
    expect(hv.queryFilter.mock.calls.at(-1)?.[2]).toBe(230020);
    expect(hv.queryFilter.mock.calls.every(call => call[2] - call[1] < 10000)).toBe(true);
  });

  it('retries smaller ranges without dropping or duplicating ballots', async () => {
    const hv = { filters: { VoteCast: vi.fn(() => ({})) }, queryFilter: vi.fn(async (_filter, from, to) => {
      if (to - from >= 2) throw new Error('RPC block range exceeded');
      return Array.from({ length: to - from + 1 }, (_, i) => ({ blockNumber: from + i }));
    }) };
    const events = await readProposalVoteEvents(hv as any, 3, 100, 104);
    expect(events.map(event => event.blockNumber)).toEqual([100, 101, 102, 103, 104]);
  });

  it('fails instead of returning earlier pages when an RPC block remains unreadable', async () => {
    const hv = { filters: { VoteCast: vi.fn(() => ({})) }, queryFilter: vi.fn().mockRejectedValue(new Error('unavailable block')) };
    await expect(readProposalVoteEvents(hv as any, 3, 100, 104)).rejects.toThrow('unavailable block');
    await expect(readProposalVoteEvents(hv as any, 3, 0, 104)).rejects.toThrow('complete proposal vote-event range');
  });
});
