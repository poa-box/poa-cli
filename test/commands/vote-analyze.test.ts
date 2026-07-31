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

import { analyzeHandler } from '../../src/commands/vote/analyze';

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
    minBalance: '0', asset: ethers.constants.AddressZero, hatIds: [], isActive: true,
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

  afterEach(() => exitSpy.mockRestore());

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
    expect(report.actual.winner.pct).toBe(100);
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
    // 150 of 200 total weight-power on option 3.
    expect(report.actual.winner.pct).toBe(75);
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
    expect(report.classConfig).toEqual([
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

  it('prefers the org username map, then Vote.voterUsername, then the truncated address', async () => {
    const payload = analysisPayload();
    payload.data.hybridVotingContract.proposals[0].votes[1].voterUsername = 'bob_from_vote';
    queryWithFieldFallbackMock.mockResolvedValue(payload);
    queryMock.mockResolvedValue({ tokenBalances: [] });

    await analyzeHandler.handler({ org: 'test-org', chain: 100, proposal: 3, json: true } as any);

    const report = jsonMock.mock.calls[0][0];
    expect(report.votes.map((v: any) => v.name)).toEqual(['alice', 'bob_from_vote']);
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
