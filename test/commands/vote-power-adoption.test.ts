import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
const mocks = vi.hoisted(() => ({ evidence: vi.fn(), detail: vi.fn(), ballots: vi.fn(), aggregate: vi.fn(), json: vi.fn() }));
vi.mock('../../src/commands/role/evidence', () => ({ readRoleEvidence: mocks.evidence,
  completeCoverage: { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] } }));
vi.mock('@poa-box/core/reads/vote', async original => ({ ...await original<typeof import('@poa-box/core/reads/vote')>(),
  readProposalDetailFacts: mocks.detail, readProposalBallotFacts: mocks.ballots }));
vi.mock('../../src/lib/multicall', () => ({ tryAggregate: mocks.aggregate }));
vi.mock('../../src/lib/output', () => ({ isJsonMode: () => true, json: mocks.json }));
import { powerHandler, buildIndexedPowerMatrix } from '../../src/commands/vote/power';
import { knownFact, unknownFact } from '@poa-box/core/data/facts';
import { getAbi } from '@poa-box/core/contracts';
const AUTH = `0x${'11'.repeat(20)}`, HV = `0x${'22'.repeat(20)}`, EXEC = `0x${'33'.repeat(20)}`, ACCOUNT = `0x${'44'.repeat(20)}`, OTHER = `0x${'55'.repeat(20)}`;
const ORG = `0x${'66'.repeat(32)}`, HEAD = `0x${'77'.repeat(32)}`, INCLUDED = `0x${'88'.repeat(32)}`, TX = `0x${'99'.repeat(32)}`, DESCRIPTION = `0x${'aa'.repeat(32)}`;
const scope = { chainId: 100, orgId: ORG, contract: HV, contracts: { membershipAuthority: AUTH, hybridVoting: HV, executor: EXEC } };
const source = { ...scope, endpoint: 'fixture://rpc', method: 'power', indexed: false, snapshot: 'pinned' as const, block: { number: '100', hash: HEAD }, observedAt: 1000 };
const indexedSource = { ...source, endpoint: 'fixture://index', indexed: true };
const coverage = { status: 'complete' as const, receivedKeys: [], missingIds: [], failedIds: [], issues: [] };
const cls = { classIndex: 0, strategy: 'DIRECT', slicePct: 100, quadratic: false, minBalance: '0', asset: ethers.constants.AddressZero, hatIds: [] };
const iface = new ethers.utils.Interface(getAbi('HybridVotingNew'));
let override: number, restricted: boolean, missingBinding: boolean;
let evidence: any;
function ballot(voter = OTHER, raw = '100') { return { voter, optionIndexes: [0], optionWeights: [100], classRawPowers: [raw] }; }
function matrix(rows: any[]) { return { source: indexedSource, coverage, data: rows }; }
function canonicalProvider(executable: boolean) {
  const batches = executable ? [[{ target: AUTH, value: 0, data: '0x' }], []] : [[], []];
  const data = iface.encodeFunctionData('createProposalV2', [ethers.utils.toUtf8Bytes('Vote'), DESCRIPTION, 60, 2, batches, ['7'], override, false]);
  const event = iface.encodeEventLog('NewHatProposal', ['1', ethers.utils.toUtf8Bytes('Vote'), DESCRIPTION, 2, 2000, 900, ['7']]);
  const inclusion = { number: 90, hash: INCLUDED, timestamp: 900 }, head = { number: 100, hash: HEAD, timestamp: 1000 };
  return { getNetwork: vi.fn(async () => ({ chainId: 100 })),
    getBlock: vi.fn(async (block: string | number) => block === INCLUDED || block === 90 || block === '0x5a' ? inclusion : head),
    getTransaction: vi.fn(async () => ({ hash: TX, from: ACCOUNT, to: HV, data, value: ethers.BigNumber.from(0), chainId: 100, blockNumber: 90, blockHash: INCLUDED })),
    getTransactionReceipt: vi.fn(async () => ({ status: 1, transactionHash: TX, blockNumber: 90, blockHash: INCLUDED, logs: [{ address: HV, topics: event.topics,
      data: event.data, transactionHash: TX, blockNumber: 90, blockHash: INCLUDED, removed: false, logIndex: 0 }] })) };
}
beforeEach(() => {
  vi.clearAllMocks(); override = 0; restricted = false; missingBinding = false;
  evidence = { scope: { ...scope, contract: AUTH }, modules: {}, provider: {}, rpcSource: { ...source, contract: AUTH },
    freshness: { now: 1000, maxAgeSeconds: 30, block: source.block }, indexed: { source: { ...indexedSource, contract: AUTH }, protocolQuery: vi.fn() },
    assertCanonical: vi.fn(async () => {}), snapshot: { source: { ...indexedSource, contract: AUTH }, coverage,
      data: { subjects: [], groupEdges: [], permissions: [], memberships: [] } } };
  mocks.evidence.mockResolvedValue(evidence);
  mocks.detail.mockResolvedValue({ source: indexedSource, coverage, data: {
    proposal: knownFact({ proposalId: '1', title: 'Vote', descriptionHash: DESCRIPTION, numOptions: 2, transactionHash: TX, createdAtBlock: '90', proposer: ACCOUNT }, indexedSource),
    classSnapshot: { classes: knownFact([cls], indexedSource) } } });
  mocks.ballots.mockResolvedValue(matrix([ballot()]));
  mocks.aggregate.mockImplementation(async (_provider, calls) => calls.map((call: any) => {
    const parsed = iface.parseTransaction({ data: call.data });
    if (missingBinding && parsed.name === 'proposalClassSubject') return { success: false, returnData: '0x' };
    const values: Record<string, any[]> = { membershipAuthority: [AUTH], executor: [EXEC], proposalCreatedAt: [900], pollRestricted: [restricted],
      quorum: [10], proposalQuorumOverride: [override], thresholdPct: [51], proposalEndTimestamp: [2000], paused: [false], proposalClassSubject: [0] };
    return { success: true, returnData: iface.encodeFunctionResult(parsed.name, values[parsed.name]) };
  }));
});
describe('indexed vote power matrix and current account preview', () => {
  it('reconstructs exact integer powers, weighted tally, prospective share and option contributions without authorizing a vote', async () => {
    await powerHandler.handler({ proposal: '1', account: ACCOUNT, options: '1', weights: '100' });
    const result = mocks.json.mock.calls[0][0];
    expect(result.matrix).toMatchObject({ state: 'known', value: { perOptionClassRaw: [['100'], ['0']], totalsRaw: ['100'], ballotCount: '1' } });
    expect(result.weightedTally).toMatchObject({ state: 'known', value: ['1000000', '0'] });
    expect(result.forecast.value[0]).toMatchObject({ rawPower: { state: 'known', value: '100' },
      prospectiveShare: { state: 'known', value: { approximate: true, numerator: '100', denominator: '200' } },
      contributions: [{ option: 1, weight: 100, delta: { state: 'known', value: '100' } }] });
    expect(result.quorum).toMatchObject({ effective: { state: 'known', value: '10' }, met: { state: 'known', value: false } });
    expect(result.voteAuthorization.state).toBe('unknown');
    expect(evidence.assertCanonical).toHaveBeenCalled();
  });
  it('keeps incomplete ballots and absent immutable class bindings unknown instead of zero/open', async () => {
    missingBinding = true;
    mocks.ballots.mockResolvedValue({ ...matrix([ballot()]), coverage: { ...coverage, status: 'incomplete', missingIds: ['next-page'] } });
    await powerHandler.handler({ proposal: '1', account: ACCOUNT });
    const result = mocks.json.mock.calls[0][0];
    expect(result.matrix.state).toBe('unknown'); expect(result.weightedTally.state).toBe('unknown'); expect(result.quorum.met.state).toBe('unknown');
    expect(result.forecast.value[0].rawPower.state).toBe('unknown');
  });
  it('does not allow a restricted empty electorate to bypass activation, including for the executor', async () => {
    restricted = true;
    await powerHandler.handler({ proposal: '1', account: EXEC });
    expect(mocks.json.mock.calls[0][0].forecast.value[0].eligibility.state).toBe('unknown');
  });
  it('uses canonical exact creation evidence for signal/raise-only quorum and retains unknown if proof is unavailable', async () => {
    override = 2; restricted = true; evidence.provider = canonicalProvider(false);
    await powerHandler.handler({ proposal: '1', account: ACCOUNT });
    expect(mocks.json.mock.calls[0][0].quorum).toMatchObject({ executable: { state: 'known', value: false }, effective: { state: 'known', value: '2' } });
    evidence.provider = canonicalProvider(true);
    await powerHandler.handler({ proposal: '1', account: ACCOUNT });
    expect(mocks.json.mock.calls[1][0].quorum).toMatchObject({ executable: { state: 'known', value: true }, effective: { state: 'known', value: '10' } });
    evidence.provider = {};
    await powerHandler.handler({ proposal: '1', account: ACCOUNT });
    expect(mocks.json.mock.calls[2][0].quorum.effective.state).toBe('unknown');
  });
  it('rejects malformed weights before observing data, and refuses overflowed or duplicate emitted ballots', async () => {
    await expect(powerHandler.handler({ proposal: '1', account: ACCOUNT, options: '0,0', weights: '50,50' })).rejects.toThrow();
    expect(mocks.evidence).not.toHaveBeenCalled();
    expect(buildIndexedPowerMatrix(matrix([ballot(), ballot()]), scope, 2, 1).state).toBe('unknown');
    expect(buildIndexedPowerMatrix(matrix([ballot(OTHER, (1n << 128n).toString())]), scope, 2, 1).state).toBe('unknown');
    expect(buildIndexedPowerMatrix(matrix([ballot(OTHER, '9007199254740993')]), scope, 2, 1)).toMatchObject({ state: 'known', value: { totalsRaw: ['9007199254740993'] } });
  });
});
