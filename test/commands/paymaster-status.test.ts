/** Current budget state and lazy rollover time must share one canonical RPC block. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryWithFieldFallback: vi.fn(),
  resolveOrgId: vi.fn(),
  createProvider: vi.fn(),
  tryAggregate: vi.fn(),
  isJsonMode: vi.fn(() => true),
  json: vi.fn(),
  table: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/lib/subgraph', () => ({
  query: mocks.query,
  queryWithFieldFallback: mocks.queryWithFieldFallback,
}));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgId: mocks.resolveOrgId,
  resolveOrgModules: vi.fn(),
  requireModule: vi.fn(),
}));
vi.mock('../../src/lib/signer', () => ({ createProvider: mocks.createProvider }));
vi.mock('../../src/lib/multicall', () => ({ tryAggregate: mocks.tryAggregate }));
vi.mock('../../src/lib/output', () => {
  const makeSpinner = () => {
    const s: any = { text: '' };
    s.start = () => s;
    s.stop = () => s;
    s.succeed = () => s;
    s.fail = () => s;
    return s;
  };
  return {
    spinner: vi.fn(makeSpinner),
    success: vi.fn(),
    error: mocks.error,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    json: mocks.json,
    table: mocks.table,
    keyValueBlock: vi.fn(),
    isJsonMode: mocks.isJsonMode,
    isQuietMode: vi.fn(() => false),
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import { statusHandler, budgetEpochState } from '../../src/commands/paymaster/status';
import {
  fetchPaymasterSubgraphState,
  readPaymasterOrgConfigPreferSubgraph,
  subgraphMatchesHub,
  hatSubjectKey,
} from '../../src/commands/paymaster/helpers';
import { createReadContract } from '../../src/lib/contracts';

// Live Gnosis fixtures (hub 0xdef1…4108, org "Argus").
const HUB = '0xdef1038c297493c0b5f82f0cdb49e929b53b4108';
const POA_MANAGER = '0x794fd39e75140ee1545b1b022e5486b7c863789b';
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const ORG_ID = '0x112de94b6e6cba0ccece7301df866a932711655946942d795f07334e3fd6f46b';
const ADMIN_HAT = '30222100213875867209821723912549005985147238897667981751317147089371136';
const OPERATOR_HAT = '30222100625258283641858621132055137413908072809768050515156576961036288';
// Contract key = keccak256(uint8(HAT), bytes32(hatId)), never the raw hat ID.
const OPERATOR_KEY = '0x05924c0398c75d0181aa851a777916677944836dc7081a3d39c21232d8e27953';
const HASHED_KEY = '0x' + '22'.repeat(32);
const RPC_BLOCK = { number: 123456, hash: '0x' + 'aa'.repeat(32), timestamp: 1800000000 };
const currentBudgets = new Map<string, [string, string, number, number]>();

const fakeProvider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:1', 100);
const hubIface = createReadContract(HUB, 'PaymasterHub', fakeProvider).interface;
const epIface = new ethers.utils.Interface(['function balanceOf(address) view returns (uint256)']);

const sel = (name: string) => hubIface.getSighash(name);

/** Live on-chain values as of the verification run. */
const FIN = [
  ethers.utils.parseEther('3'),                    // deposited
  ethers.BigNumber.from('1264186582032000000'),    // spent (INCLUDES the solidarity fee)
  ethers.BigNumber.from(0),                        // solidarityUsedThisPeriod
  1775767945,                                      // periodStart
];
const SOLIDARITY = [
  ethers.BigNumber.from('5108847919402250000'),
  9,    // numActiveOrgs   — no subgraph field
  100,  // feePercentageBps — no subgraph field
  false,
];
const DEPOSIT = ethers.BigNumber.from('10450735073975000000');

function subgraphFixture(overrides: Record<string, any> = {}) {
  return {
    paymasterHubContracts: [{ id: HUB, entryPoint: ENTRY_POINT.toLowerCase() }],
    paymasterOrgConfigs: [{
      id: `${HUB}-${ORG_ID}`,
      orgId: ORG_ID,
      paymasterHub: { id: HUB },
      adminHatId: ADMIN_HAT,
      operatorHatId: OPERATOR_HAT,
      isPaused: false,
      isBannedFromSolidarity: false,
      registeredAt: '1775767945',
      feeCaps: {
        maxFeePerGas: '50000000000',
        maxPriorityFeePerGas: '10000000000',
        maxCallGas: 2000000,
        maxVerificationGas: 1500000,
        maxPreVerificationGas: 500000,
      },
      budgets: [
        // Ordered by setAt, i.e. NOT admin/operator first — the command has to
        // re-order so the historically-probed subjects keep their positions.
        {
          subjectKey: HASHED_KEY,
          capPerEpoch: '1000000000000000000',
          usedInEpoch: '203970081150000000',
          epochLen: 604800,
          epochStart: 1778187145, // lapsed long ago
          totalUsed: '1251669883200000000',
        },
        {
          subjectKey: OPERATOR_KEY,
          capPerEpoch: '100000000000000000',
          usedInEpoch: '0',
          epochLen: 86400,
          epochStart: 1775859070,
          totalUsed: '0',
        },
      ],
      ...overrides,
    }],
  };
}

const ok = (data: string) => ({ success: true, returnData: data });

/** Answer a Multicall3 batch the way the chain would. */
function respond(calls: Array<{ to: string; data: string }>) {
  return calls.map((c) => {
    const s = c.data.slice(0, 10);
    if (s === sel('getOrgFinancials')) return ok(hubIface.encodeFunctionResult('getOrgFinancials', [FIN]));
    if (s === sel('getSolidarityFund')) return ok(hubIface.encodeFunctionResult('getSolidarityFund', [SOLIDARITY]));
    if (s === sel('ENTRY_POINT')) return ok(hubIface.encodeFunctionResult('ENTRY_POINT', [ENTRY_POINT]));
    if (s === sel('getOrgConfig')) {
      return ok(hubIface.encodeFunctionResult('getOrgConfig', [[ADMIN_HAT, OPERATOR_HAT, false, 1775767945, false]]));
    }
    if (s === sel('getFeeCaps')) {
      return ok(hubIface.encodeFunctionResult('getFeeCaps', [['50000000000', '10000000000', 2000000, 1500000, 500000]]));
    }
    if (s === sel('getBudget')) {
      const [, key] = hubIface.decodeFunctionData('getBudget', c.data);
      const override = currentBudgets.get(String(key).toLowerCase());
      if (override) return ok(hubIface.encodeFunctionResult('getBudget', [override]));
      if (String(key).toLowerCase() === HASHED_KEY) return ok(hubIface.encodeFunctionResult('getBudget', [['1000000000000000000', '203970081150000000', 604800, 1778187145]]));
      if (String(key).toLowerCase() === OPERATOR_KEY) {
        return ok(hubIface.encodeFunctionResult('getBudget', [['100000000000000000', '0', 86400, 1775859070]]));
      }
      return ok(hubIface.encodeFunctionResult('getBudget', [['0', '0', 0, 0]]));
    }
    if (s === epIface.getSighash('balanceOf')) {
      return ok(epIface.encodeFunctionResult('balanceOf', [DEPOSIT]));
    }
    throw new Error(`unexpected call selector ${s}`);
  });
}

function selectorsOf(calls: Array<{ data: string }>) {
  return calls.map(c => c.data.slice(0, 10));
}

describe('pop paymaster status — subgraph-first hub state', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    mocks.isJsonMode.mockReturnValue(true);
    mocks.resolveOrgId.mockResolvedValue(ORG_ID);
    mocks.createProvider.mockReturnValue(fakeProvider);
    currentBudgets.clear();
    vi.spyOn(fakeProvider, 'getNetwork').mockResolvedValue({ chainId: 100 } as any);
    vi.spyOn(fakeProvider, 'getBlock').mockResolvedValue({ ...RPC_BLOCK } as any);
    mocks.query.mockResolvedValue({
      poaManagerContracts: [{ id: POA_MANAGER, paymasterHubProxy: HUB }],
    });
    mocks.queryWithFieldFallback.mockResolvedValue({ data: subgraphFixture(), tierIndex: 0 });
    mocks.tryAggregate.mockImplementation(async (_p: any, calls: any[]) => respond(calls));
  });

  afterEach(() => { exitSpy.mockRestore(); vi.restoreAllMocks(); });

  it('batches current budgets for requested and discovered keys at the same canonical block as financials', async () => {
    await statusHandler.handler({ org: 'Argus', chain: 100 } as any);
    expect(mocks.tryAggregate).toHaveBeenCalledTimes(2);
    const calls = mocks.tryAggregate.mock.calls[0][1];
    expect(calls).toHaveLength(3);
    const selectors = selectorsOf(calls);
    expect(selectors).toContain(sel('getOrgFinancials')); expect(selectors).toContain(sel('getSolidarityFund'));
    expect(selectors).toContain(epIface.getSighash('balanceOf'));
    const budgetCalls = mocks.tryAggregate.mock.calls[1][1];
    expect(budgetCalls).toHaveLength(3);
    expect(new Set(budgetCalls.map((call: any) => String(hubIface.decodeFunctionData('getBudget', call.data)[1]).toLowerCase())))
      .toEqual(new Set([hatSubjectKey(ADMIN_HAT), OPERATOR_KEY, HASHED_KEY]));
    for (const [, , options] of mocks.tryAggregate.mock.calls) expect(options).toEqual({ blockTag: RPC_BLOCK.number });
    expect(calls.find((call: any) => call.data.startsWith(epIface.getSighash('balanceOf'))).to).toBe(ENTRY_POINT);
  });

  it('preserves the --json contract: same keys, same order, same formats', async () => {
    await statusHandler.handler({ org: 'Argus', chain: 100 } as any);

    const payload = mocks.json.mock.calls[0][0];
    expect(Object.keys(payload)).toEqual([
      'paymasterHub', 'entryPoint', 'deposit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'paused',
      'registered', 'adminHatId', 'operatorHatId', 'registeredAt', 'bannedFromSolidarity',
      'financials', 'solidarityFund', 'budgets',
      'dataSource', 'budgetObservedAtSeconds', 'rpcObservation', 'indexedObservation', 'indexedBudgetHistory', // additive
    ]);

    // entryPoint is re-checksummed: the subgraph stores Bytes lowercased, but
    // ENTRY_POINT() returned a checksummed address and agents compare strings.
    expect(payload.entryPoint).toBe(ENTRY_POINT);
    expect(payload.maxFeePerGas).toBe('50.0');
    expect(payload.maxPriorityFeePerGas).toBe('10.0');
    expect(payload.registered).toBe(true);
    expect(payload.adminHatId).toBe(ADMIN_HAT);
    expect(payload.operatorHatId).toBe(OPERATOR_HAT);
    expect(payload.registeredAt).toBe(1775767945);
    expect(payload.paused).toBe(false);

    // Financials still come off the chain, fee included.
    expect(payload.financials.spent).toBe('1.264186582032');
    expect(payload.financials.available).toBe('1.735813417968');
    expect(payload.financials.periodStart).toBe(1775767945);
    expect(payload.solidarityFund).toEqual({
      balance: '5.10884791940225',
      numActiveOrgs: 9,
      feePercentageBps: 100,
      distributionPaused: false,
    });
    expect(payload.dataSource).toEqual({
      entryPoint: 'subgraph', orgConfig: 'subgraph', feeCaps: 'subgraph', budgets: 'rpc',
      financials: 'rpc', solidarityFund: 'rpc', deposit: 'rpc',
    });
  });

  it('keeps the probed subject first, then appends the subjects only the subgraph knows', async () => {
    await statusHandler.handler({ org: 'Argus', chain: 100 } as any);
    const { budgets } = mocks.json.mock.calls[0][0];

    // The admin hat has no budget on chain, so as before it is absent; the
    // operator hat kept index 0 even though the subgraph returned it second.
    expect(budgets).toHaveLength(2);
    expect(budgets[0].subject).toBe(`operator hat ${OPERATOR_HAT}`);
    expect(budgets[0].subjectKey).toBe(OPERATOR_KEY);
    expect(budgets[0].capPerEpoch).toBe('0.1');
    expect(budgets[0].usedInEpoch).toBe('0.0');
    expect(budgets[0].epochLen).toBe(86400);
    expect(budgets[0].epochStart).toBe(1775859070);

    // A hashed subject key the CLI cannot derive — invisible before this change.
    expect(budgets[1].subjectKey).toBe(HASHED_KEY);
    expect(budgets[1].subject).toMatch(/^subject 0x22222222/);
    // totalUsed has no getBudget() counterpart at all.
    expect(budgets[1].totalUsed).toBe('1.2516698832');
  });

  it('flags a lapsed epoch instead of printing a stale spend as current', async () => {
    await statusHandler.handler({ org: 'Argus', chain: 100 } as any);
    const b = mocks.json.mock.calls[0][0].budgets[1];

    // The raw counter is preserved byte-for-byte (the contract reports the same
    // stale figure), and the derived fields say what it actually means.
    expect(b.usedInEpoch).toBe('0.20397008115');
    expect(b.epochEnd).toBe(1778187145 + 604800);
    expect(b.epochExpired).toBe(true);
    expect(b.usedInEpochEffective).toBe('0.0');
  });

  it('leaves a live epoch alone', async () => {
    const now = RPC_BLOCK.timestamp;
    currentBudgets.set(OPERATOR_KEY, ['100000000000000000', '25000000000000000', 604800, now - 60]);
    const fixture = subgraphFixture();
    fixture.paymasterOrgConfigs[0].budgets = [{
      subjectKey: OPERATOR_KEY,
      capPerEpoch: '100000000000000000',
      usedInEpoch: '25000000000000000',
      epochLen: 604800,
      epochStart: now - 60,
      totalUsed: '25000000000000000',
    }];
    mocks.queryWithFieldFallback.mockResolvedValue({ data: fixture, tierIndex: 0 });

    await statusHandler.handler({ org: 'Argus', chain: 100 } as any);
    const b = mocks.json.mock.calls[0][0].budgets[0];
    expect(b.epochExpired).toBe(false);
    expect(b.usedInEpochEffective).toBe('0.025');
    expect(b.usedInEpochEffective).toBe(b.usedInEpoch);
  });

  it('never replenishes a lagged indexed budget when the same-block RPC epoch is already exhausted', async () => {
    const previous = subgraphFixture();
    previous.paymasterOrgConfigs[0].budgets[1] = { subjectKey: OPERATOR_KEY, capPerEpoch: '100000000000000000',
      usedInEpoch: '1', epochLen: 86400, epochStart: RPC_BLOCK.timestamp - 2 * 86400, totalUsed: '9007199254740993000001' };
    mocks.queryWithFieldFallback.mockResolvedValue({ data: previous, tierIndex: 0 });
    currentBudgets.set(OPERATOR_KEY, ['100000000000000000', '100000000000000000', 86400, RPC_BLOCK.timestamp - 30]);
    // Wall-clock rollover would replenish even the current row; chain time must win.
    vi.spyOn(Date, 'now').mockReturnValue((RPC_BLOCK.timestamp + 100 * 86400) * 1000);
    await statusHandler.handler({ org: 'Argus', chain: 100 } as any);
    const payload = mocks.json.mock.calls[0][0], budget = payload.budgets.find((row: any) => row.subjectKey === OPERATOR_KEY);
    expect(budget).toMatchObject({ remainingRaw: '0', epochExpired: false, source: 'rpc', blockNumber: RPC_BLOCK.number, blockHash: RPC_BLOCK.hash,
      raw: { capPerEpoch: '100000000000000000', usedInEpoch: '100000000000000000', epochStart: String(RPC_BLOCK.timestamp - 30) },
      totalUsedSource: 'indexed-history', indexedHistory: { snapshot: 'latest', block: null, usedInEpochRaw: '1', totalUsedRaw: '9007199254740993000001' } });
    expect(payload.budgetObservedAtSeconds).toBe(RPC_BLOCK.timestamp);
    expect(payload.rpcObservation).toEqual({ chainId: 100, blockNumber: RPC_BLOCK.number, blockHash: RPC_BLOCK.hash, timestamp: RPC_BLOCK.timestamp });
    expect(payload.indexedObservation.currentAvailabilityVerified).toBe(false);
  });

  it('includes an explicitly requested key omitted from indexed discovery and honors --rpc', async () => {
    const key = hatSubjectKey('7');
    currentBudgets.set(key, ['9007199254740993', '1', 86400, RPC_BLOCK.timestamp - 1]);
    await statusHandler.handler({ org: 'Argus', chain: 100, hat: ['7'], rpc: 'https://rpc.example.org' } as any);
    expect(mocks.createProvider).toHaveBeenCalledWith({ chainId: 100, rpcUrl: 'https://rpc.example.org' });
    const budget = mocks.json.mock.calls[0][0].budgets.find((row: any) => row.subjectKey === key);
    expect(budget).toMatchObject({ remainingRaw: '9007199254740992', source: 'rpc', totalUsed: null, totalUsedSource: 'unavailable', indexedHistory: null });
  });

  it('does not let an indexed zero budget suppress a current RPC budget', async () => {
    const fixture = subgraphFixture();
    fixture.paymasterOrgConfigs[0].budgets[0].capPerEpoch = '0'; fixture.paymasterOrgConfigs[0].budgets[0].usedInEpoch = '0';
    mocks.queryWithFieldFallback.mockResolvedValue({ data: fixture, tierIndex: 0 });
    currentBudgets.set(HASHED_KEY, ['100', '25', 86400, RPC_BLOCK.timestamp - 1]);
    await statusHandler.handler({ org: 'Argus', chain: 100 } as any);
    expect(mocks.json.mock.calls[0][0].budgets.find((row: any) => row.subjectKey === HASHED_KEY).remainingRaw).toBe('75');
  });

  it('retains labeled indexed lifetime totals when the current budget is unset', async () => {
    currentBudgets.set(HASHED_KEY, ['0', '0', 0, 0]);
    await statusHandler.handler({ org: 'Argus', chain: 100 } as any);
    const result = mocks.json.mock.calls[0][0];
    expect(result.budgets.some((budget: any) => budget.subjectKey === HASHED_KEY)).toBe(false);
    expect(result.indexedBudgetHistory.find((budget: any) => budget.subjectKey === HASHED_KEY)).toMatchObject({
      snapshot: 'latest', block: null, totalUsedRaw: '1251669883200000000' });
  });

  it('fails closed when a current budget and its pinned direct retry are unavailable', async () => {
    mocks.tryAggregate.mockImplementation(async (_provider, calls) => calls.map((call: any) => call.data.startsWith(sel('getBudget'))
      ? { success: false, returnData: '0x' } : respond([call])[0]));
    const direct = vi.spyOn(fakeProvider, 'call').mockRejectedValue(new Error('Pinned budget unavailable'));
    await expect(statusHandler.handler({ org: 'Argus', chain: 100 } as any)).rejects.toThrow('exit:1');
    expect(mocks.json).not.toHaveBeenCalled(); expect(direct).toHaveBeenCalled();
    expect(direct.mock.calls.every(([, block]) => block === RPC_BLOCK.number)).toBe(true);
  });

  it.each(['chain', 'hash', 'timestamp'] as const)('refuses %s drift before reporting current remaining gas', async dimension => {
    if (dimension === 'chain') vi.mocked(fakeProvider.getNetwork).mockResolvedValueOnce({ chainId: 42161 } as any);
    else vi.mocked(fakeProvider.getBlock).mockResolvedValueOnce({ ...RPC_BLOCK } as any).mockResolvedValue({ ...RPC_BLOCK,
      ...(dimension === 'hash' ? { hash: '0x' + 'bb'.repeat(32) } : { timestamp: RPC_BLOCK.timestamp + 1 }) } as any);
    await expect(statusHandler.handler({ org: 'Argus', chain: 100 } as any)).rejects.toThrow('exit:1');
    expect(mocks.json).not.toHaveBeenCalled();
  });

  it('a null feeCaps edge means the contract default of zero, not "unknown"', async () => {
    const fixture = subgraphFixture();
    (fixture.paymasterOrgConfigs[0] as any).feeCaps = null;
    mocks.queryWithFieldFallback.mockResolvedValue({ data: fixture, tierIndex: 0 });

    await statusHandler.handler({ org: 'Argus', chain: 100 } as any);

    expect(selectorsOf(mocks.tryAggregate.mock.calls[0][1])).not.toContain(sel('getFeeCaps'));
    const payload = mocks.json.mock.calls[0][0];
    expect(payload.maxFeePerGas).toBe('0.0');
    expect(payload.maxPriorityFeePerGas).toBe('0.0');
  });

  it('falls back to the full RPC path when the org is not indexed', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({
      data: { paymasterHubContracts: [{ id: HUB, entryPoint: ENTRY_POINT.toLowerCase() }], paymasterOrgConfigs: [] },
      tierIndex: 0,
    });

    await statusHandler.handler({ org: 'Argus', chain: 100, hat: ['7'] } as any);

    expect(mocks.tryAggregate).toHaveBeenCalledTimes(2);
    const r1 = selectorsOf(mocks.tryAggregate.mock.calls[0][1]);
    expect(r1).toContain(sel('getOrgConfig'));
    expect(r1).toContain(sel('getFeeCaps'));
    // entryPoint still came from the subgraph, so balanceOf rode along in r1.
    expect(r1).not.toContain(sel('ENTRY_POINT'));
    expect(r1).toContain(epIface.getSighash('balanceOf'));

    // Round 2 is the budgets: admin hat, operator hat, --hat 7.
    const r2 = mocks.tryAggregate.mock.calls[1][1];
    expect(r2).toHaveLength(3);
    expect(new Set(selectorsOf(r2))).toEqual(new Set([sel('getBudget')]));

    const payload = mocks.json.mock.calls[0][0];
    expect(payload.dataSource).toMatchObject({ orgConfig: 'rpc', feeCaps: 'rpc', budgets: 'rpc', entryPoint: 'subgraph' });
    // Only the operator hat has a budget on chain; the zero rows are skipped
    // exactly as they were before the conversion.
    expect(payload.budgets).toHaveLength(1);
    expect(payload.budgets[0].subject).toBe(`operator hat ${OPERATOR_HAT}`);
  });

  it('falls all the way back to RPC when the subgraph is unreachable', async () => {
    mocks.queryWithFieldFallback.mockRejectedValue(new Error('502 Bad Gateway'));

    await statusHandler.handler({ org: 'Argus', chain: 100 } as any);

    const r1 = selectorsOf(mocks.tryAggregate.mock.calls[0][1]);
    expect(r1).toContain(sel('ENTRY_POINT'));
    expect(r1).toContain(sel('getOrgConfig'));
    expect(r1).toContain(sel('getFeeCaps'));
    // balanceOf CANNOT be batched here — it needs the EntryPoint address first.
    expect(r1).not.toContain(epIface.getSighash('balanceOf'));
    expect(selectorsOf(mocks.tryAggregate.mock.calls[1][1])).toContain(epIface.getSighash('balanceOf'));

    const payload = mocks.json.mock.calls[0][0];
    expect(payload.entryPoint).toBe(ENTRY_POINT);
    expect(payload.dataSource.entryPoint).toBe('rpc');
  });

  it('a ZERO-ADDRESS indexed entryPoint is a placeholder, not an answer', async () => {
    // The mapping seeds hub.entryPoint = Address.zero() in getOrCreateHub, and the
    // deploy path only fills it via a try_ENTRY_POINT() that falls back to zero
    // (PaymasterInitialized fires before InfrastructureDeployed, so
    // handlePaymasterInitialized never runs for the initial deploy).
    //
    // getAddress() accepts address(0) happily, so without a guard the placeholder
    // becomes a non-null entryPoint that is then used as an eth_call TARGET:
    // balanceOf against address(0) returns '0x', decodeFunctionResult throws
    // CALL_EXCEPTION, and the command exits 1 instead of degrading. It would also
    // publish a wrong address on the pinned --json `entryPoint` key.
    const fixture = subgraphFixture();
    fixture.paymasterHubContracts[0].entryPoint = ethers.constants.AddressZero;
    mocks.queryWithFieldFallback.mockResolvedValue({ data: fixture, tierIndex: 0 });

    await statusHandler.handler({ org: 'Argus', chain: 100 } as any);

    // Degrades to the ENTRY_POINT() read the command already implements.
    const r1 = selectorsOf(mocks.tryAggregate.mock.calls[0][1]);
    expect(r1).toContain(sel('ENTRY_POINT'));
    expect(r1).not.toContain(epIface.getSighash('balanceOf'));

    const payload = mocks.json.mock.calls[0][0];
    expect(payload.entryPoint).toBe(ENTRY_POINT);
    expect(payload.entryPoint).not.toBe(ethers.constants.AddressZero);
    expect(payload.dataSource.entryPoint).toBe('rpc');
  });

  it('ignores indexed rows that belong to a different hub', async () => {
    const fixture = subgraphFixture();
    fixture.paymasterHubContracts[0].id = '0x1111111111111111111111111111111111111111';
    fixture.paymasterOrgConfigs[0].paymasterHub = { id: '0x1111111111111111111111111111111111111111' };
    mocks.queryWithFieldFallback.mockResolvedValue({ data: fixture, tierIndex: 0 });

    await statusHandler.handler({ org: 'Argus', chain: 100 } as any);

    const r1 = selectorsOf(mocks.tryAggregate.mock.calls[0][1]);
    expect(r1).toContain(sel('ENTRY_POINT'));
    expect(r1).toContain(sel('getOrgConfig'));
    expect(mocks.json.mock.calls[0][0].dataSource).toMatchObject({
      entryPoint: 'rpc', orgConfig: 'rpc', feeCaps: 'rpc', budgets: 'rpc',
    });
  });

  it('surfaces a reverting read instead of decoding it as zero', async () => {
    mocks.tryAggregate.mockImplementation(async (_p: any, calls: any[]) =>
      calls.map(c => (c.data.startsWith(sel('getOrgFinancials'))
        ? { success: false, returnData: '0x' }
        : respond([c])[0])));
    const callSpy = vi.spyOn(fakeProvider, 'call').mockRejectedValue(new Error('call revert exception'));

    await expect(statusHandler.handler({ org: 'Argus', chain: 100 } as any)).rejects.toThrow('exit:1');
    expect(callSpy).toHaveBeenCalled();
    callSpy.mockRestore();
  });
});

describe('budgetEpochState (pure)', () => {
  it('is expired once epochStart + epochLen has passed', () => {
    expect(budgetEpochState(1000, 100, 1099)).toEqual({ epochEnd: 1100, expired: false });
    expect(budgetEpochState(1000, 100, 1100)).toEqual({ epochEnd: 1100, expired: true });
  });

  it('treats an unset budget (epochLen or epochStart == 0) as not expired', () => {
    expect(budgetEpochState(0, 0, 9e9)).toEqual({ epochEnd: null, expired: false });
    expect(budgetEpochState(1000, 0, 9e9)).toEqual({ epochEnd: null, expired: false });
  });
});

describe('paymaster helpers — subgraph state mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryWithFieldFallback.mockResolvedValue({ data: subgraphFixture(), tierIndex: 0 });
  });

  it('maps the indexed row onto the same shape getOrgConfig() produces', async () => {
    const state = await fetchPaymasterSubgraphState(ORG_ID, 100);
    expect(state.orgConfig!.adminHatId.toString()).toBe(ADMIN_HAT);
    expect(state.orgConfig!.operatorHatId.toString()).toBe(OPERATOR_HAT);
    expect(state.orgConfig!.paused).toBe(false);
    expect(state.orgConfig!.bannedFromSolidarity).toBe(false);
    expect(state.orgConfig!.registered).toBe(true);
    expect(state.entryPoint).toBe(ENTRY_POINT);
    expect(subgraphMatchesHub(state, HUB.toUpperCase())).toBe(true);
  });

  it('degrades to nulls (never throws) so callers can fall back', async () => {
    mocks.queryWithFieldFallback.mockRejectedValue(new Error('no subgraph on this chain'));
    const state = await fetchPaymasterSubgraphState(ORG_ID, 100);
    expect(state).toEqual({ hubAddress: null, entryPoint: null, orgConfig: null, feeCaps: null, budgets: null });
    expect(subgraphMatchesHub(state, HUB)).toBe(false);
  });

  it('survives the legacy tier, which has no totalUsed', async () => {
    const fixture = subgraphFixture();
    for (const b of fixture.paymasterOrgConfigs[0].budgets) delete (b as any).totalUsed;
    mocks.queryWithFieldFallback.mockResolvedValue({ data: fixture, tierIndex: 1 });

    const state = await fetchPaymasterSubgraphState(ORG_ID, 100);
    expect(state.budgets!.every(b => b.totalUsed === null)).toBe(true);
    expect(state.budgets![0].capPerEpoch.toString()).toBe('1000000000000000000');
  });
});

/**
 * The registration read in `pop paymaster register` gates a WRITE, so it may
 * only be optimised in the direction the subgraph can be trusted: it lags
 * reality, it never runs ahead of it. A positive is therefore safe to take at
 * face value; a negative has to be re-confirmed on chain or the owner path would
 * broadcast an adminCall that reverts.
 */
describe('readPaymasterOrgConfigPreferSubgraph — asymmetric trust', () => {
  beforeEach(() => vi.clearAllMocks());

  it('trusts an indexed registration and skips the eth_call', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({ data: subgraphFixture(), tierIndex: 0 });
    const callSpy = vi.spyOn(fakeProvider, 'call');

    const { config, source } = await readPaymasterOrgConfigPreferSubgraph(fakeProvider, HUB, ORG_ID, 100);
    expect(source).toBe('subgraph');
    expect(config.registered).toBe(true);
    expect(config.adminHatId.toString()).toBe(ADMIN_HAT);
    expect(callSpy).not.toHaveBeenCalled();
    callSpy.mockRestore();
  });

  it('re-confirms a MISSING registration on chain before anything is written', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({
      data: { paymasterHubContracts: [{ id: HUB, entryPoint: ENTRY_POINT.toLowerCase() }], paymasterOrgConfigs: [] },
      tierIndex: 0,
    });
    const callSpy = vi.spyOn(fakeProvider, 'call').mockResolvedValue(
      hubIface.encodeFunctionResult('getOrgConfig', [[ADMIN_HAT, OPERATOR_HAT, false, 1775767945, false]])
    );

    const { config, source } = await readPaymasterOrgConfigPreferSubgraph(fakeProvider, HUB, ORG_ID, 100);
    // The chain says registered even though the indexer had not caught up.
    expect(source).toBe('rpc');
    expect(config.registered).toBe(true);
    expect(callSpy).toHaveBeenCalledTimes(1);
    callSpy.mockRestore();
  });

  it('re-confirms on chain when the indexed row belongs to another hub', async () => {
    const fixture = subgraphFixture();
    fixture.paymasterOrgConfigs[0].paymasterHub = { id: '0x1111111111111111111111111111111111111111' };
    fixture.paymasterHubContracts[0].id = '0x1111111111111111111111111111111111111111';
    mocks.queryWithFieldFallback.mockResolvedValue({ data: fixture, tierIndex: 0 });
    const callSpy = vi.spyOn(fakeProvider, 'call').mockResolvedValue(
      hubIface.encodeFunctionResult('getOrgConfig', [['0', '0', false, 0, false]])
    );

    const { config, source } = await readPaymasterOrgConfigPreferSubgraph(fakeProvider, HUB, ORG_ID, 100);
    expect(source).toBe('rpc');
    expect(config.registered).toBe(false);
    callSpy.mockRestore();
  });
});
