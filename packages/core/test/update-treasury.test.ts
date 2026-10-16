import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { buildSchema, parse, validate, graphql, type GraphQLSchema } from 'graphql';
import { readFileSync } from 'fs';
import { join } from 'path';
import { encodeAbiParameters, parseAbi, encodeFunctionData } from 'viem';
import { paymentManagerAvailability, planTreasuryTransfer, buildTreasuryTransferCalls, prepareExactRecipients, treasuryTokenAddress,
  type PaymentManagerState, type TreasuryTransferInput } from '../src/treasury/planning';
import { allocateDistribution, type AllocateDistributionInput } from '../src/treasury/distributions';
import { buildDistributionClaimsDocument, verifyDistributionClaimsDocument, findDistributionClaim, distributionClaimCacheKey,
  distributionClaimsDiscoveryMarker, parseDistributionClaimsDiscoveryMarker, type DistributionClaimsDocument, type DistributionClaimsReference } from '../src/metadata/distribution';
import { buildSendProposalExact, sendProposalExactIntent, sendProposalIntent, parseRecipients, computeDistributionAllocations, buildDistributionTree, getAllocationProof,
  proposeDistributionIntent, buildDistributionProposal } from '../src/tx/treasury';
import { readTreasuryWorkFacts, projectTreasuryBountyTotals, readDistributionReferences, readDistributionHistoryFacts, readPaymentHistoryFacts, readDistributionClaimFacts,
  readPaymentManagerPlanningSnapshot, paymentManagerPlanningState, type PaymentManagerPlanningReader } from '../src/reads/treasury';
import { normalizeRecordedInflows, deduplicateInflowEvents, classifyInternalMovement, readHistoricalPotFacts, readRecordedNativeDepositFacts,
  type HistoricalPot, type RecordedInflowEvent, type InflowEventChunk } from '../src/treasury/inflows';
import { CASHOUT_SCHEMA_V1, CASHOUT_PARAMS_TUPLE, CASHOUT_ESCROW_ABI_V1, encodeCashoutPayload, prepareCashoutPayload, decodeCashoutDeposit,
  projectRecoveryFacts, buildRecoverFailed, buildWithdrawDeposit, type CashoutRecoveryState, type CashoutLog } from '../src/integrations/cashout';
import { knownFact, unknownFact, requireCompleteSnapshot, type SourceRef, type SourceSnapshot, type Fact } from '../src/data/facts';
import type { AssetRef } from '../src/amounts';
import { bytes32ToCidV0 } from '../src/encoding/cid';
import { encodeIntent } from '../src/tx/intent';
import * as treasuryDocs from '../src/graph/documents/treasury';
import { FETCH_EXECUTED_DISTRIBUTION_PROPOSALS_PAGE } from '../src/graph/documents/financial-history';
import { FETCH_HISTORICAL_POTS_PAGE, FETCH_NATIVE_DEPOSITS_PAGE } from '../src/graph/documents/inflows';
import { pinJson } from '../src/ipfs';
import { resolveOrgModules } from '../src/reads/resolve';
import { exampleExactNativeSend, exampleTransferPlan, exampleStoredClaim, exampleCashoutWithdrawal } from './fixtures/core-update/treasury/consumer';

vi.mock('../src/ipfs', async importOriginal => ({ ...await importOriginal<typeof import('../src/ipfs')>(), pinJson: vi.fn() }));
vi.mock('../src/reads/resolve', async importOriginal => ({ ...await importOriginal<typeof import('../src/reads/resolve')>(), resolveOrgModules: vi.fn() }));
const addr = (id: number) => '0x' + BigInt(id).toString(16).padStart(40, '0');
const A = addr(1), B = addr(2), C = addr(3), PM = addr(11), TM = addr(12), EXEC = addr(13), HV = addr(14), PT = addr(15), TOKEN = addr(16), RETIRED = addr(17);
const ZERO = ethers.constants.AddressZero, ORG = '0x' + '11'.repeat(32), HASH = '0x' + '22'.repeat(32), OTHER_HASH = '0x' + '33'.repeat(32);
const CID = bytes32ToCidV0(HASH), OTHER_CID = bytes32ToCidV0(OTHER_HASH);
const BLOCK = { number: '100', hash: HASH };
const X: AssetRef = { chainId: 100, address: TOKEN, decimals: 6 }, NATIVE: AssetRef = { chainId: 100, address: ZERO, decimals: 18 };
const src = (contract = PM, indexed = false, overrides: Partial<SourceRef> = {}): SourceRef => ({ chainId: 100, orgId: ORG, contract, endpoint: 'mock://chain100', method: indexed ? 'graph' : 'rpc-enumeration', indexed, snapshot: 'pinned', block: BLOCK, ...overrides });
const snap = <T>(data: T, source = src(), keys: string[] = []): SourceSnapshot<T> => ({ source, data, coverage: { status: 'complete', receivedKeys: keys, missingIds: [], failedIds: [], issues: [] } });
const fixture = <T = any>(name: string): T => JSON.parse(readFileSync(join(__dirname, 'fixtures/core-update/treasury', name), 'utf8'));
const schema = buildSchema(readFileSync(join(__dirname, 'fixtures/core-update/treasury/serving-schema.graphql'), 'utf8'));
const GOLD = fixture('merkle-goldens.json');
const amountValues = (input: ReturnType<typeof allocateDistribution>) => input.allocations.map(a => a.amountRaw);
const ready = <T>(result: { status: 'ready'; data: T } | { status: 'blocked'; codes: readonly string[] }): T => {
  expect(result.status, result.status === 'blocked' ? result.codes.join(', ') : '').toBe('ready');
  if (result.status !== 'ready') throw new Error(result.codes.join(','));
  return result.data;
};
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Live network forbidden in treasury regressions'); }));
  vi.mocked(pinJson).mockReset(); vi.mocked(pinJson).mockResolvedValue(CID);
  vi.mocked(resolveOrgModules).mockReset();
  vi.mocked(resolveOrgModules).mockResolvedValue({ orgId: ORG, paymentManagerAddress: PM, hybridVotingAddress: HV } as any);
});
afterEach(() => { vi.unstubAllGlobals(); });

function pmState(token = TOKEN): PaymentManagerState {
  return { asset: token === ZERO ? NATIVE : X, balanceRaw: '70', distributionCounterRaw: '2', rounds: [
    { distributionId: '1', payoutToken: token, totalAmount: '100', totalClaimed: '100', finalized: false, checkpointBlock: '1', creationBlock: knownFact('80') },
    { distributionId: '2', payoutToken: token, totalAmount: '50', totalClaimed: '30', finalized: false, checkpointBlock: '1', creationBlock: knownFact('80') },
  ] };
}
const availability = (state = pmState(), snapshot = snap(state), extra = {}) => paymentManagerAvailability({ snapshot, scope: { chainId: 100, orgId: ORG, contract: PM }, block: BLOCK, asset: state.asset, minClaimPeriodBlocks: '20', ...extra });
function transferInput(state = pmState(), amountRaw = '20'): TreasuryTransferInput {
  return { scope: { chainId: 100, orgId: ORG, contracts: { paymentManager: PM, executor: EXEC } }, block: BLOCK, asset: state.asset,
    destination: TM, amountRaw, sources: [{ kind: 'payment-manager', address: PM, snapshot: snap(state) }], minClaimPeriodBlocks: '20' };
}
describe('TREASURY-PLAN / full commitment and safe closure contract regressions', () => {
  it.each(['0', '49', '50', '70', '149', '150', '151', '170'].flatMap(balance => ['1', '20', '50', '70', '100'].map(amount => [balance, amount])))('contract solvency matrix balance%s amount%s matches executable post-state', (balance, amount) => {
    const state = pmState(); state.balanceRaw = balance;
    const plan = planTreasuryTransfer(transferInput(state, amount));
    // Fixed independent contract ledger: full100 can close, partial50 stays
    // committed. Claimed30 does not change the withdraw guard's50 obligation.
    expect(plan.status).toBe(BigInt(balance) >= 50n + BigInt(amount) ? 'ready' : 'blocked');
    if (plan.status === 'ready') {
      let committed = 150n;
      const iface = new ethers.utils.Interface(['function finalizeDistribution(uint256,uint256)', 'function withdraw(address,address,uint256)']);
      for (const call of plan.data.calls) {
        const decoded = iface.parseTransaction({ data: call.calldata });
        if (decoded.name === 'finalizeDistribution') { expect(decoded.args[0].toString()).toBe('1'); committed -= 100n; }
        else { expect(decoded.args[2].toString()).toBe(amount); expect(BigInt(balance) >= committed + BigInt(amount)).toBe(true); }
      }
    }
  });
  it('70 balance / 150 full committed / 100 releasable yields exactly 20, never the residual 50', () => {
    expect(ready(availability())).toEqual({ balanceRaw: '70', committedRaw: '150', spendableRaw: '0', releasableRaw: '100', spendableAfterReleaseRaw: '20', finalizeIds: ['1'], commitmentProvenance: 'derived-complete-rpc-enumeration' });
    expect(planTreasuryTransfer(transferInput(pmState(), '50')).status).toBe('blocked');
    const plan = ready(planTreasuryTransfer(transferInput()));
    expect(plan.finalizeIds).toEqual(['1']);
    const oracle = new ethers.utils.Interface(['function finalizeDistribution(uint256,uint256)', 'function withdraw(address,address,uint256)']);
    expect(plan.calls).toEqual([
      { target: PM, value: '0', calldata: oracle.encodeFunctionData('finalizeDistribution', ['1', '20']) },
      { target: PM, value: '0', calldata: oracle.encodeFunctionData('withdraw', [TOKEN, TM, '20']) },
    ]);
    expect(ready(buildTreasuryTransferCalls(transferInput()))).toEqual(plan.calls);
  });
  it('native closure still has zero call value; withdraw sends the exact amount to TaskManager', () => {
    const plan = ready(planTreasuryTransfer(transferInput(pmState(ZERO))));
    const decoded = new ethers.utils.Interface(['function withdraw(address token,address to,uint256 amount)']).decodeFunctionData('withdraw', plan.calls[1].calldata);
    expect([decoded.token, decoded.to.toLowerCase(), decoded.amount.toString(), plan.calls[1].value]).toEqual([ZERO, TM, '20', '0']);
  });
  it('partially claimed rounds NEVER autoclose even after their claim period', () => {
    const state = pmState(); state.rounds = state.rounds.map(r => ({ ...r, totalClaimed: '30' }));
    expect(ready(availability(state)).releasableRaw).toBe('0');
    expect(planTreasuryTransfer(transferInput(state)).status).toBe('blocked');
  });
  it.each(['incomplete', 'unavailable', 'failed', 'missing', 'cap', 'duplicate', 'counter'] as const)('refuses %s round evidence instead of an executable plan', kind => {
    const state = pmState(); const evidence = snap(state);
    if (kind === 'incomplete' || kind === 'unavailable') evidence.coverage.status = kind;
    if (kind === 'failed') evidence.coverage.failedIds = ['2'];
    if (kind === 'missing') evidence.coverage.missingIds = ['2'];
    if (kind === 'cap') evidence.coverage.issues = [{ code: 'PAGE_CAP' }];
    if (kind === 'duplicate') state.rounds = [state.rounds[0], state.rounds[0]];
    if (kind === 'counter') state.distributionCounterRaw = '3';
    const input = transferInput(state); input.sources = [{ kind: 'payment-manager', address: PM, snapshot: evidence }];
    expect(planTreasuryTransfer(input).status).toBe('blocked');
  });
  it.each([
    { chainId: 42161 }, { orgId: OTHER_HASH }, { contract: TM }, { indexed: true }, { block: { number: '99', hash: HASH } },
    { block: { number: '100', hash: OTHER_HASH } }, { snapshot: 'latest' as const, block: undefined },
  ])('refuses wrong/stale/nonlive source %j', overrides => expect(availability(pmState(), snap(pmState(), src(PM, false, overrides))).status).toBe('blocked'));
  it('creation anchor equality succeeds, before boundary refuses; old zero anchor uses checkpoint', () => {
    const state = pmState();
    expect(ready(availability(state, snap(state), { minClaimPeriodBlocks: '21' })).finalizeIds).toEqual([]);
    state.rounds = state.rounds.map(r => ({ ...r, creationBlock: knownFact('0'), checkpointBlock: '80' }));
    expect(ready(availability(state)).finalizeIds).toEqual(['1']);
    expect(ready(availability(state, snap(state), { minClaimPeriodBlocks: '21' })).finalizeIds).toEqual([]);
  });
  it('unknown creation keeps its full commitment; foreign creation evidence still refuses', () => {
    const state = pmState(); state.rounds = [{ ...state.rounds[0], creationBlock: unknownFact('GETTER_ABSENT') }, state.rounds[1]];
    expect(ready(availability(state))).toMatchObject({ committedRaw: '150', spendableRaw: '0', releasableRaw: '0', spendableAfterReleaseRaw: '0', finalizeIds: [] });
    expect(planTreasuryTransfer(transferInput(state))).toMatchObject({ status: 'blocked', codes: ['INSUFFICIENT_SPENDABLE'] });
    state.rounds = [{ ...state.rounds[0], creationBlock: knownFact('80', src(PM, true, { orgId: OTHER_HASH })) }, state.rounds[1]];
    expect(availability(state).status).toBe('blocked');
  });
  it('independent commitment mismatch/unknown and impossible claimed/uint totals refuse', () => {
    const state = pmState();
    state.commitmentRaw = knownFact('50'); expect(availability(state).status).toBe('blocked');
    state.commitmentRaw = unknownFact('FAILED'); expect(availability(state).status).toBe('blocked');
    state.commitmentRaw = knownFact('150', src()); expect(ready(availability(state)).committedRaw).toBe('150');
    delete state.commitmentRaw; state.rounds = [{ ...state.rounds[0], totalClaimed: '101' }, state.rounds[1]];
    expect(availability(state).status).toBe('blocked');
    state.rounds = [{ ...state.rounds[0], totalAmount: ethers.constants.MaxUint256.toString(), totalClaimed: '0' }, state.rounds[1]];
    expect(availability(state).status).toBe('blocked');
  });
  it('checked anchor addition refuses overflow; checked withdrawal addition refuses overflow', () => {
    expect(availability(pmState(), snap(pmState()), { minClaimPeriodBlocks: ethers.constants.MaxUint256.toString() }).status).toBe('blocked');
    const state = pmState(); state.balanceRaw = ethers.constants.MaxUint256.toString();
    state.rounds = [ { ...state.rounds[0], totalAmount: ethers.constants.MaxUint256.toString(), totalClaimed: '1' } ]; state.distributionCounterRaw = '1';
    expect(planTreasuryTransfer(transferInput(state, '1')).status).toBe('blocked');
  });
  it('finalized rounds and different assets do not contribute to this asset commitment', () => {
    const state = pmState(); state.rounds = [{ ...state.rounds[0], finalized: true }, { ...state.rounds[1], payoutToken: ZERO }];
    expect(ready(availability(state)).committedRaw).toBe('0');
    expect(ready(planTreasuryTransfer(transferInput(state))).calls).toHaveLength(1);
  });
  it('source preference is explicit, exact executor value survives and unknown first source refuses fallback', () => {
    const state = pmState(ZERO); const input = transferInput(state, '20');
    input.sources = [{ kind: 'executor', address: EXEC, balance: snap({ asset: NATIVE, rawAmount: '20' }, src(EXEC)) }, ...input.sources];
    expect(ready(planTreasuryTransfer(input)).calls).toEqual([{ target: ethers.utils.getAddress(TM), value: '20', calldata: '0x' }]);
    input.sources = [...input.sources].reverse(); expect(ready(planTreasuryTransfer(input)).source).toBe('payment-manager');
    const bad = snap({ asset: NATIVE, rawAmount: '20' }, src(EXEC)); bad.coverage.status = 'incomplete';
    input.sources = [{ kind: 'executor', address: EXEC, balance: bad }, ...input.sources];
    expect(planTreasuryTransfer(input).status).toBe('blocked');
  });
  it('correct executor ERC20 target and raw calldata; wrong installed source / destination / zero amount refuse', () => {
    const input = transferInput(); input.sources = [{ kind: 'executor', address: EXEC, balance: snap({ asset: X, rawAmount: '20' }, src(EXEC)) }];
    const call = ready(planTreasuryTransfer(input)).calls[0];
    expect([call.target, call.value]).toEqual([TOKEN, '0']);
    expect(new ethers.utils.Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', call.calldata)[1].toString()).toBe('20');
    expect(planTreasuryTransfer({ ...input, scope: { ...input.scope, contracts: { executor: PM } } }).status).toBe('blocked');
    expect(planTreasuryTransfer({ ...input, destination: ZERO }).status).toBe('blocked');
    expect(planTreasuryTransfer({ ...input, amountRaw: '0' }).status).toBe('blocked');
  });
  it('minimal own-module source is accepted, but an explicit contradictory installed binding refuses', () => {
    const input = transferInput(); expect(planTreasuryTransfer(input).status).toBe('ready');
    const candidate = input.sources[0];
    if (candidate.kind === 'payment-manager') candidate.snapshot.source = { ...candidate.snapshot.source, contracts: { paymentManager: TM } };
    expect(planTreasuryTransfer(input).status).toBe('blocked');
  });
  it('contract oracle confirms no totalCommitted getter and full-total removal/creation anchor semantics', () => {
    const source = readFileSync(join(__dirname, 'fixtures/core-update/treasury/PaymentManager.sol.txt'), 'utf8');
    const iface = readFileSync(join(__dirname, 'fixtures/core-update/treasury/IPaymentManager.sol.txt'), 'utf8');
    expect(iface).not.toMatch(/function\s+totalCommitted/);
    expect(source).toContain('s.totalCommitted[dist.payoutToken] -= dist.totalAmount;');
    expect(source).toContain('dist.creationBlock == 0 ? dist.checkpointBlock : dist.creationBlock');
    expect(source).toContain('s.totalCommitted[token] + amount');
  });
});

describe('TREASURY:missing-creation-fact-blocks-uncommitted-spend', () => {
  function uncommittedState(): PaymentManagerState {
    return { asset: X, balanceRaw: '1000', distributionCounterRaw: '1', rounds: [
      { ...pmState().rounds[0], creationBlock: unknownFact('CREATION_BLOCK_UNKNOWN') },
    ] };
  }
  it.each(['10', '900'])('permits exactly %s from proven free funds without guessing a creation anchor or closing the round', amount => {
    const state = uncommittedState();
    expect(ready(availability(state))).toEqual({ balanceRaw: '1000', committedRaw: '100', spendableRaw: '900', releasableRaw: '0',
      spendableAfterReleaseRaw: '900', finalizeIds: [], commitmentProvenance: 'derived-complete-rpc-enumeration' });
    const plan = ready(planTreasuryTransfer(transferInput(state, amount)));
    const oracle = new ethers.utils.Interface(['function withdraw(address token,address to,uint256 amount)']);
    expect(plan.finalizeIds).toEqual([]);
    expect(plan.calls).toEqual([{ target: PM, value: '0', calldata: oracle.encodeFunctionData('withdraw', [TOKEN, TM, amount]) }]);
    expect(state.rounds[0].creationBlock).toEqual(unknownFact('CREATION_BLOCK_UNKNOWN'));
    expect(state.rounds[0].finalized).toBe(false);
  });
  it.each(['901', '950', '1000'])('refuses %s because unknown creation cannot release the committed 100', amount => {
    expect(planTreasuryTransfer(transferInput(uncommittedState(), amount))).toMatchObject({ status: 'blocked', codes: ['INSUFFICIENT_SPENDABLE'] });
  });
  it('partial claims remain fully committed even with ample free balance and an expired known creation anchor', () => {
    const state = uncommittedState();
    state.rounds = [{ ...state.rounds[0], totalClaimed: '99', creationBlock: knownFact('80') }];
    expect(ready(availability(state))).toMatchObject({ committedRaw: '100', spendableRaw: '900', releasableRaw: '0', finalizeIds: [] });
    expect(ready(planTreasuryTransfer(transferInput(state, '900'))).finalizeIds).toEqual([]);
    expect(planTreasuryTransfer(transferInput(state, '901'))).toMatchObject({ status: 'blocked', codes: ['INSUFFICIENT_SPENDABLE'] });
  });
  it('mixed evidence closes only the eligible known round and matches the actual post-close withdrawal guard', () => {
    const state = uncommittedState();
    state.distributionCounterRaw = '4';
    state.rounds = [state.rounds[0],
      { ...state.rounds[0], distributionId: '2', totalAmount: '200', totalClaimed: '200', creationBlock: knownFact('80', src(PM, true)) },
      { ...state.rounds[0], distributionId: '3', totalAmount: '300', totalClaimed: '250', creationBlock: knownFact('80') },
      { ...state.rounds[0], distributionId: '4', totalAmount: '50', totalClaimed: '50', creationBlock: knownFact('90') },
    ];
    expect(ready(availability(state))).toMatchObject({ committedRaw: '650', spendableRaw: '350', releasableRaw: '200', spendableAfterReleaseRaw: '550', finalizeIds: ['2'] });
    expect(ready(planTreasuryTransfer(transferInput(state, '350'))).finalizeIds).toEqual([]);
    for (const amount of ['351', '550']) {
      const plan = ready(planTreasuryTransfer(transferInput(state, amount)));
      expect(plan.finalizeIds).toEqual(['2']);
      const oracle = new ethers.utils.Interface(['function finalizeDistribution(uint256,uint256)', 'function withdraw(address,address,uint256)']);
      expect(plan.calls).toEqual([
        { target: PM, value: '0', calldata: oracle.encodeFunctionData('finalizeDistribution', ['2', '20']) },
        { target: PM, value: '0', calldata: oracle.encodeFunctionData('withdraw', [TOKEN, TM, amount]) },
      ]);
      // PaymentManager subtracts the full 200 commitment and sends total-claimed
      // (zero) to its owner. Unknown100, partial300, and immature50 stay committed.
      const balanceAfterClose = 1000n - (200n - 200n), committedAfterClose = 650n - 200n;
      const withdraw = oracle.parseTransaction({ data: plan.calls[1].calldata });
      expect(balanceAfterClose >= committedAfterClose + BigInt(withdraw.args[2].toString())).toBe(true);
      expect(balanceAfterClose - committedAfterClose).toBe(550n);
    }
    expect(planTreasuryTransfer(transferInput(state, '551'))).toMatchObject({ status: 'blocked', codes: ['INSUFFICIENT_SPENDABLE'] });
  });
  it.each(['incomplete', 'unavailable', 'missing-round', 'failed-round', 'page-cap', 'counter', 'duplicate', 'missing-balance', 'missing-counter', 'asset', 'chain', 'org', 'contract', 'block', 'hash', 'indexed', 'unpinned', 'binding'] as const)(
    'unknown history does not bypass %s validation even for a free-funded request', kind => {
      const state = uncommittedState(), evidence = snap(state);
      if (kind === 'incomplete' || kind === 'unavailable') evidence.coverage.status = kind;
      if (kind === 'missing-round') { state.rounds = []; evidence.coverage.missingIds = ['1']; }
      if (kind === 'failed-round') evidence.coverage.failedIds = ['1'];
      if (kind === 'page-cap') evidence.coverage.issues = [{ code: 'PAGE_CAP' }];
      if (kind === 'counter') state.distributionCounterRaw = '2';
      if (kind === 'duplicate') { state.distributionCounterRaw = '2'; state.rounds = [state.rounds[0], state.rounds[0]]; }
      if (kind === 'missing-balance') delete (state as Partial<PaymentManagerState>).balanceRaw;
      if (kind === 'missing-counter') delete (state as Partial<PaymentManagerState>).distributionCounterRaw;
      if (kind === 'asset') state.asset = { ...X, address: ZERO };
      if (kind === 'chain') evidence.source.chainId = 42161;
      if (kind === 'org') evidence.source.orgId = OTHER_HASH;
      if (kind === 'contract') evidence.source.contract = TM;
      if (kind === 'block') evidence.source.block = { ...BLOCK, number: '99' };
      if (kind === 'hash') evidence.source.block = { ...BLOCK, hash: OTHER_HASH };
      if (kind === 'indexed') evidence.source.indexed = true;
      if (kind === 'unpinned') evidence.source.snapshot = 'latest';
      if (kind === 'binding') evidence.source.contracts = { paymentManager: TM };
      const input = transferInput(state, '10'); input.asset = X;
      input.sources = [{ kind: 'payment-manager', address: PM, snapshot: evidence }];
      expect(planTreasuryTransfer(input).status).toBe('blocked');
    });
  it.each(['known', 'unknown'] as const)('%s attached creation facts retain their scope, block and binding checks', state => {
    for (const overrides of [{ orgId: OTHER_HASH }, { chainId: 42161 }, { contract: TM }, { block: { ...BLOCK, number: '99' } },
      { block: { ...BLOCK, hash: OTHER_HASH } }, { snapshot: 'latest' as const }, { contracts: { paymentManager: TM } }]) {
      const value = uncommittedState(), source = src(PM, true, overrides);
      value.rounds = [{ ...value.rounds[0], creationBlock: state === 'known' ? knownFact('80', source) : unknownFact('CREATION_BLOCK_UNKNOWN', source) }];
      expect(planTreasuryTransfer(transferInput(value, '10')).status).toBe('blocked');
    }
  });
});

describe('ROUND-READ-COMPLETENESS / authoritative injected RPC enumeration', () => {
  function reader(): PaymentManagerPlanningReader {
    return { readCounter: vi.fn(async () => knownFact('2', src())), readBalance: vi.fn(async () => knownFact('70', src(TOKEN, false, { account: PM }))),
      readDistribution: vi.fn(async id => { const { creationBlock: _, ...round } = pmState().rounds[Number(id) - 1]; return knownFact(round, src()); }) };
  }
  it('counter plus every ID and exact balance produce a proven complete snapshot; no nonexistent commitment getter is invoked', async () => {
    const reads = reader();
    const result = await readPaymentManagerPlanningSnapshot({ source: src(), asset: X, reader: reads, maxRounds: 20, creationBlocks: { '1': knownFact('80'), '2': knownFact('80') } });
    expect(result.coverage).toMatchObject({ status: 'complete', receivedKeys: ['counter', 'balance', '1', '2'], expectedKeys: ['counter', 'balance', '1', '2'] });
    expect(reads.readCounter).toHaveBeenCalledTimes(1); expect(reads.readBalance).toHaveBeenCalledTimes(1); expect(reads.readDistribution).toHaveBeenCalledTimes(2);
    const state = paymentManagerPlanningState(result);
    expect(state.state).toBe('known');
    if (state.state === 'known') expect(ready(availability(state.value.data, state.value)).spendableAfterReleaseRaw).toBe('20');
  });
  it.each(['failed-row', 'missing-fact-source', 'wrong-row', 'mixed-proof', 'cap', 'unknown-counter', 'balance-failed'] as const)('%s produces unknown fields/coverage and refuses narrowing to spendability', async kind => {
    const reads = reader();
    if (kind === 'failed-row') reads.readDistribution = vi.fn(async id => { if (id === '2') throw new Error('RPC_FAILED'); const { creationBlock: _, ...row } = pmState().rounds[0]; return knownFact(row, src()); });
    if (kind === 'missing-fact-source') reads.readCounter = vi.fn(async () => knownFact('2'));
    if (kind === 'wrong-row') reads.readDistribution = vi.fn(async () => { const { creationBlock: _, ...row } = pmState().rounds[0]; return knownFact(row, src()); });
    if (kind === 'mixed-proof') { reads.readCounter = vi.fn(async () => knownFact('2', src(PM, false, { block: { number: '100' } }))); }
    if (kind === 'unknown-counter') reads.readCounter = vi.fn(async () => unknownFact('RPC_FAILED'));
    if (kind === 'balance-failed') reads.readBalance = vi.fn(async () => unknownFact('RPC_FAILED'));
    const result = await readPaymentManagerPlanningSnapshot({ source: kind === 'mixed-proof' ? src(PM, false, { block: { number: '100' } }) : src(), asset: X, reader: reads, maxRounds: kind === 'cap' ? 1 : 20 });
    expect(result.coverage.status).not.toBe('complete'); expect(paymentManagerPlanningState(result).state).toBe('unknown');
    if (kind === 'cap') expect(reads.readDistribution).not.toHaveBeenCalled();
    if (kind === 'unknown-counter' || kind === 'missing-fact-source') expect(result.data.distributionCounterRaw.state).toBe('unknown');
    if (kind === 'balance-failed') expect(result.data.balanceRaw.state).toBe('unknown');
  });
  it('counter0 and balance0 remain known complete facts; unknown creation block remains explicit and closure refuses', async () => {
    const reads = reader(); reads.readCounter = vi.fn(async () => knownFact('0', src())); reads.readBalance = vi.fn(async () => knownFact('0', src(TOKEN, false, { account: PM })));
    const empty = await readPaymentManagerPlanningSnapshot({ source: src(), asset: X, reader: reads, maxRounds: 0 });
    expect(empty.coverage.status).toBe('complete'); expect(empty.data.balanceRaw).toEqual(knownFact('0', src(TOKEN, false, { account: PM }))); expect(reads.readDistribution).not.toHaveBeenCalled();
    const result = await readPaymentManagerPlanningSnapshot({ source: src(), asset: X, reader: reader(), maxRounds: 20 });
    const state = paymentManagerPlanningState(result); expect(state.state).toBe('known');
    if (state.state === 'known') {
      expect(ready(availability(state.value.data, state.value))).toMatchObject({ committedRaw: '150', spendableRaw: '0', releasableRaw: '0', finalizeIds: [] });
      expect(planTreasuryTransfer(transferInput(state.value.data))).toMatchObject({ status: 'blocked', codes: ['INSUFFICIENT_SPENDABLE'] });
    }
  });
  it('complete current getter enumeration with no indexed creation history still funds an exact uncommitted transfer', async () => {
    const reads = reader();
    reads.readCounter = vi.fn(async () => knownFact('1', src()));
    reads.readBalance = vi.fn(async () => knownFact('1000', src(TOKEN, false, { account: PM })));
    const observed = await readPaymentManagerPlanningSnapshot({ source: src(), asset: X, reader: reads, maxRounds: 1 });
    expect(observed.coverage).toMatchObject({ status: 'complete', receivedKeys: ['counter', 'balance', '1'] });
    const state = paymentManagerPlanningState(observed);
    expect(state.state).toBe('known');
    if (state.state !== 'known') throw new Error(state.code);
    expect(state.value.data.rounds[0].creationBlock.state).toBe('unknown');
    const input = transferInput(state.value.data, '10');
    input.sources = [{ kind: 'payment-manager', address: PM, snapshot: state.value }];
    const plan = ready(planTreasuryTransfer(input));
    expect(plan.finalizeIds).toEqual([]); expect(plan.calls).toHaveLength(1);
    expect(ready(availability(state.value.data, state.value))).toMatchObject({ spendableRaw: '900', releasableRaw: '0', spendableAfterReleaseRaw: '900' });
    expect(reads.readCounter).toHaveBeenCalledTimes(1); expect(reads.readBalance).toHaveBeenCalledTimes(1); expect(reads.readDistribution).toHaveBeenCalledTimes(1);
  });
  it('externally supplied attached balance/counter facts cannot contradict a complete aggregate scope or block', async () => {
    const observed = await readPaymentManagerPlanningSnapshot({ source: src(), asset: X, reader: reader(), maxRounds: 20 });
    expect(paymentManagerPlanningState(observed).state).toBe('known');
    const wrongBalance = { ...observed, data: { ...observed.data, balanceRaw: knownFact('70', src(TOKEN, false, { account: PM, chainId: 42161 })) } };
    expect(paymentManagerPlanningState(wrongBalance).state).toBe('unknown');
    const wrongCounter = { ...observed, data: { ...observed.data, distributionCounterRaw: knownFact('2', src(PM, false, { block: { number: '99', hash: HASH } })) } };
    expect(paymentManagerPlanningState(wrongCounter).state).toBe('unknown');
  });
});

function allocationInput(policy?: AllocateDistributionInput['policy'], totalRaw = '10'): AllocateDistributionInput {
  return { policy, totalRaw, chainId: 100, orgId: ORG, holderContract: PT, paymentManager: PM, checkpoint: BLOCK,
    holders: snap([ { address: A, participationTokenBalance: '2', membershipStatus: 'Active' }, { address: B, participationTokenBalance: '1', membershipStatus: 'Active' }, { address: C, participationTokenBalance: '1', membershipStatus: 'Active' } ], src(PT, true)),
    optOutFacts: snap([A, B, C].map(address => ({ address, optedOut: false })), src(PM)) };
}
describe('Treasury attached module bindings / retained root counterexamples', () => {
  async function observed(asset = X, change?: 'counter' | 'balance' | 'row', contracts: Record<string, string> = { paymentManager: TM }) {
    const source = src(PM, false, { contracts: { paymentManager: PM, taskManager: TM } });
    const factSource = (key: string) => src(key === 'balance' && asset.address !== ZERO ? asset.address : PM, false,
      { ...(key === 'balance' ? { account: PM } : {}), ...(key === change ? { contracts } : {}) });
    const { creationBlock: _, ...round } = pmState(asset.address).rounds[0];
    const reader: PaymentManagerPlanningReader = {
      readCounter: async () => knownFact('1', factSource('counter')),
      readBalance: async () => knownFact('10', factSource('balance')),
      readDistribution: async () => knownFact({ ...round, totalAmount: '10', totalClaimed: '10' }, factSource('row')),
    };
    return readPaymentManagerPlanningSnapshot({ source, asset, reader, maxRounds: 1, creationBlocks: { '1': knownFact('80', src(PM, true)) } });
  }
  it.each([X, NATIVE])('minimal own-module %j facts keep complete enumeration and the exact closure/withdraw', async asset => {
    const result = await observed(asset);
    expect(result.coverage.status).toBe('complete');
    const narrowed = paymentManagerPlanningState(result); expect(narrowed.state).toBe('known');
    if (narrowed.state !== 'known') throw new Error(narrowed.code);
    const input = transferInput(narrowed.value.data, '10'); input.sources = [{ kind: 'payment-manager', address: PM, snapshot: narrowed.value }];
    const plan = ready(planTreasuryTransfer(input));
    expect(plan.finalizeIds).toEqual(['1']);
    const iface = new ethers.utils.Interface(['function finalizeDistribution(uint256,uint256)', 'function withdraw(address,address,uint256)']);
    expect(plan.calls).toEqual([
      { target: PM, value: '0', calldata: iface.encodeFunctionData('finalizeDistribution', ['1', '20']) },
      { target: PM, value: '0', calldata: iface.encodeFunctionData('withdraw', [asset.address, TM, '10']) },
    ]);
  });
  it.each([X, NATIVE].flatMap(asset => (['counter', 'balance', 'row'] as const).map(key => ({ asset, key }))))('RPC $key with contradictory PaymentManager map cannot prove $asset.address solvency', async ({ asset, key }) => {
    const result = await observed(asset, key);
    expect(result.coverage.status).not.toBe('complete');
    expect(result.coverage.failedIds).toContain(key === 'row' ? '1' : key);
    expect(paymentManagerPlanningState(result).state).toBe('unknown');
    if (key === 'counter') expect(result.data.distributionCounterRaw.state).toBe('unknown');
    if (key === 'balance') expect(result.data.balanceRaw.state).toBe('unknown');
    if (key === 'row') expect(result.data.rounds).toEqual([]);
  });
  it.each(['counter', 'balance', 'row'] as const)('RPC %s also refuses a known unrelated expected TaskManager contradiction', async key => {
    const result = await observed(X, key, { paymentManager: PM, taskManager: EXEC });
    expect(result.coverage.status).not.toBe('complete'); expect(paymentManagerPlanningState(result).state).toBe('unknown');
  });
  it.each([X, NATIVE].flatMap(asset => (['missing-account', 'foreign-account', 'wrong-contract'] as const).map(kind => ({ asset, kind }))))('balance $kind keeps $asset.address contract/account provenance mandatory', async ({ asset, kind }) => {
    const balanceSource = src(asset.address === ZERO ? PM : asset.address, false, { account: PM });
    if (kind === 'missing-account') delete balanceSource.account;
    if (kind === 'foreign-account') balanceSource.account = EXEC;
    if (kind === 'wrong-contract') balanceSource.contract = asset.address === ZERO ? TOKEN : PM;
    const result = await readPaymentManagerPlanningSnapshot({ source: src(), asset, maxRounds: 0, reader: {
      readCounter: async () => knownFact('0', src()), readBalance: async () => knownFact('10', balanceSource), readDistribution: vi.fn(),
    } });
    expect(result.coverage.failedIds).toEqual(['balance']); expect(result.data.balanceRaw.state).toBe('unknown');
    expect(paymentManagerPlanningState(result).state).toBe('unknown');
  });
  it.each([X, NATIVE].flatMap(asset => (['counter', 'balance'] as const).map(key => ({ asset, key }))))('direct narrowing cannot launder $key PaymentManager-map contradictions for $asset.address', async ({ asset, key }) => {
    const result = await observed(asset);
    const fact = key === 'counter' ? result.data.distributionCounterRaw : result.data.balanceRaw;
    fact.source = { ...fact.source!, contracts: { paymentManager: TM } };
    expect(result.coverage.status).toBe('complete');
    expect(paymentManagerPlanningState(result).state).toBe('unknown');
  });
  it('direct narrowing checks parent/internal maps and expected unrelated maps, preserving trusted aggregate facts', async () => {
    const parentConflict = await observed(); parentConflict.source.contracts = { paymentManager: TM };
    expect(paymentManagerPlanningState(parentConflict).state).toBe('unknown');
    const fieldConflict = await observed(); fieldConflict.data.balanceRaw.source!.contracts = { taskManager: EXEC };
    expect(paymentManagerPlanningState(fieldConflict).state).toBe('unknown');
    const trusted = await observed(); delete trusted.data.balanceRaw.source; delete trusted.data.distributionCounterRaw.source;
    expect(paymentManagerPlanningState(trusted).state).toBe('known');
  });
  it('contradictory reader parent fails before callbacks, rather than replacing the declared manager', async () => {
    const readCounter = vi.fn(async () => knownFact('0', src()));
    const reader: PaymentManagerPlanningReader = { readCounter, readBalance: vi.fn(), readDistribution: vi.fn() };
    await expect(readPaymentManagerPlanningSnapshot({ source: src(PM, false, { contracts: { paymentManager: TM } }), asset: X, maxRounds: 0, reader })).rejects.toThrow();
    expect(readCounter).not.toHaveBeenCalled();
  });
  it.each(['parent', 'creation', 'commitment'] as const)('direct availability refuses explicit %s map contradiction with complete numeric evidence', kind => {
    const state = pmState(), parent = src();
    if (kind === 'parent') parent.contracts = { paymentManager: TM };
    if (kind === 'creation') state.rounds = [{ ...state.rounds[0], creationBlock: knownFact('80', src(PM, true, { contracts: { paymentManager: TM } })) }, state.rounds[1]];
    if (kind === 'commitment') state.commitmentRaw = knownFact('150', src(PM, false, { contracts: { paymentManager: TM } }));
    expect(availability(state, snap(state, parent)).status).toBe('blocked');
  });
  it('minimal current parent, independently observed creation and commitment preserve exact spendability', () => {
    const state = pmState();
    state.rounds = [{ ...state.rounds[0], creationBlock: knownFact('80', src(PM, true, { endpoint: 'mock://events', method: 'DistributionCreated' })) }, state.rounds[1]];
    state.commitmentRaw = knownFact('150', src(PM, false, { method: 'independent-commitment' }));
    const result = ready(availability(state));
    expect([result.committedRaw, result.releasableRaw, result.spendableAfterReleaseRaw]).toEqual(['150', '100', '20']);
    expect(ready(availability({ asset: X, balanceRaw: '10', distributionCounterRaw: '0', rounds: [] })).spendableRaw).toBe('10');
  });
  it('explicit aggregate scope needs no redundant map on a minimal own-manager commitment fact', () => {
    const state = pmState(); state.commitmentRaw = knownFact('150', src());
    const scope = { chainId: 100, orgId: ORG, contract: PM, contracts: { paymentManager: PM, taskManager: TM } };
    expect(ready(availability(state, snap(state, src(PM, false, { contracts: scope.contracts })), { scope })).committedRaw).toBe('150');
    state.commitmentRaw.source!.contracts = { taskManager: EXEC };
    expect(availability(state, snap(state, src(PM, false, { contracts: scope.contracts })), { scope })).toMatchObject({ status: 'blocked', codes: ['SCOPE_MISMATCH'] });
  });
  it.each(['creation', 'commitment'] as const)('%s maps must agree with parent and explicit transfer expectations, even without redundant parent keys', kind => {
    for (const parentHasMap of [false, true]) {
      const state = pmState(), source = src(PM, false, parentHasMap ? { contracts: { taskManager: TM } } : {});
      const fact = knownFact(kind === 'creation' ? '80' : '150', src(PM, kind === 'creation', { contracts: { taskManager: EXEC } }));
      if (kind === 'creation') state.rounds = [{ ...state.rounds[0], creationBlock: fact }, state.rounds[1]];
      else state.commitmentRaw = fact;
      const snapshot = snap(state, source), input = transferInput(state);
      input.scope.contracts = { ...input.scope.contracts, taskManager: TM };
      input.sources = [{ kind: 'payment-manager', address: PM, snapshot }];
      expect(planTreasuryTransfer(input).status).toBe('blocked');
      if (parentHasMap) expect(availability(state, snapshot).status).toBe('blocked');
    }
  });
  it.each(['holder', 'optOut'] as const)('allocation %s refuses both explicit relevant module-map contradictions', kind => {
    for (const key of ['paymentManager', 'participationToken'] as const) {
      const input = allocationInput(), source = kind === 'holder' ? input.holders.source : input.optOutFacts.source;
      source.contracts = { [key]: EXEC };
      expect(() => allocateDistribution(input)).toThrow();
    }
  });
  it('minimal and matching-map allocations preserve immutable roots/proofs and CLI default without mutating sources', () => {
    for (const policy of ['cli-first-holder', 'sorted-last-omit-zero'] as const) {
      const input = allocationInput(policy), minimal = allocateDistribution(input);
      const oracle = policy === 'cli-first-holder' ? GOLD.cli10 : GOLD.host10;
      expect(minimal.merkleRoot).toBe(oracle.root);
      oracle.leaves.forEach(([address, amount]: string[], i: number) => expect(minimal.claims[address]).toEqual({ amount, proof: oracle.proofs[i] }));
      input.holders.source.contracts = { participationToken: PT.toUpperCase().replace('0X', '0x'), paymentManager: PM, taskManager: TM };
      input.optOutFacts.source.contracts = { participationToken: PT, paymentManager: PM, taskManager: EXEC };
      const before = JSON.stringify(input);
      expect(allocateDistribution(input)).toEqual(minimal); expect(JSON.stringify(input)).toBe(before);
    }
  });
});
describe('DISTRIBUTION-POLICY / independent OZ golden leaves and old-default parity', () => {
  it('total10 CLI stays6/2/2 and explicit host sorted-last is5/2/3; total8 agrees4/2/2', () => {
    const cli = allocateDistribution(allocationInput()), host = allocateDistribution(allocationInput('sorted-last-omit-zero'));
    expect(amountValues(cli)).toEqual(['6', '2', '2']); expect(cli.merkleRoot).toBe(GOLD.cli10.root);
    expect(amountValues(host)).toEqual(['5', '2', '3']); expect(host.merkleRoot).toBe(GOLD.host10.root);
    for (const policy of ['cli-first-holder', 'sorted-last-omit-zero'] as const) {
      expect(amountValues(allocateDistribution(allocationInput(policy, '8')))).toEqual(['4', '2', '2']);
      expect(allocateDistribution(allocationInput(policy, '8')).merkleRoot).toBe(GOLD.both8.root);
    }
    const old = computeDistributionAllocations(allocationInput().holders.data.slice(), '10');
    expect(old.map(a => a.amount.toString())).toEqual(['6', '2', '2']);
  });
  it('shuffling does not change sorted-last; CLI input-order dust remains intentionally unchanged', () => {
    const input = allocationInput('sorted-last-omit-zero');
    input.holders.data = [...input.holders.data].reverse();
    expect(allocateDistribution(input).merkleRoot).toBe(GOLD.host10.root);
    input.policy = 'cli-first-holder';
    expect(amountValues(allocateDistribution(input))).toEqual(['3', '2', '5']);
  });
  it.each([
    [[A, B, C], ['6', '2', '2']], [[A, C, B], ['6', '2', '2']],
    [[B, A, C], ['3', '5', '2']], [[B, C, A], ['3', '2', '5']],
    [[C, A, B], ['3', '5', '2']], [[C, B, A], ['3', '2', '5']],
  ])('all holder permutation%s preserves explicit host root and legacy first-holder dust', (order, cliExpected) => {
    const input = allocationInput('sorted-last-omit-zero');
    input.holders.data = order.map(address => input.holders.data.find(h => h.address === address)!);
    expect(allocateDistribution(input).merkleRoot).toBe(GOLD.host10.root);
    input.policy = 'cli-first-holder'; expect(amountValues(allocateDistribution(input))).toEqual(cliExpected);
  });
  it('tiny payout omits zero leaves only on explicit policy; CLI total0 keeps its zero leaves', () => {
    expect(amountValues(allocateDistribution(allocationInput(undefined, '1')))).toEqual(['1', '0', '0']);
    const host = allocateDistribution(allocationInput('sorted-last-omit-zero', '1'));
    expect(host.allocations).toEqual([{ address: C, amountRaw: '1' }]);
    expect(amountValues(allocateDistribution(allocationInput(undefined, '0')))).toEqual(['0', '0', '0']);
    expect(() => allocateDistribution(allocationInput('sorted-last-omit-zero', '0'))).toThrow('ZERO_DISTRIBUTION');
  });
  it.each([1, 3, 5, 7])('%i leaves match frozen independent complete-tree roots/proofs', count => {
    const oracle = GOLD.counts.find((g: any) => g.leaves.length === count);
    const allocations = oracle.leaves.map(([address, amount]: string[]) => ({ address, amount: ethers.BigNumber.from(amount) }));
    const tree = buildDistributionTree(allocations);
    expect(tree.root).toBe(oracle.root);
    allocations.forEach((a: any, i: number) => expect(getAllocationProof(tree, a)).toEqual(oracle.proofs[i]));
  });
  it.each(['1', '101', '9007199254740993000000000000000001'])('allocation total %s conserves exact raw units for both policies', total => {
    for (const policy of ['cli-first-holder', 'sorted-last-omit-zero'] as const) {
      const result = allocateDistribution(allocationInput(policy, total));
      expect(result.allocations.reduce((sum, a) => sum + BigInt(a.amountRaw), 0n).toString()).toBe(total);
    }
  });
  it('opted-out/zero/inactive holders are excluded; absent fact, mismatched checkpoint and duplicate casing refuse', () => {
    const input = allocationInput(); input.optOutFacts.data = [{ address: A, optedOut: true }, { address: B, optedOut: false }, { address: C, optedOut: false }];
    expect(amountValues(allocateDistribution(input))).toEqual(['5', '5']);
    input.optOutFacts.data = []; expect(() => allocateDistribution(input)).toThrow('OPT_OUT_UNKNOWN');
    input.optOutFacts = allocationInput().optOutFacts; input.holders.source = src(PT, true, { block: { number: '99', hash: HASH } });
    expect(() => allocateDistribution(input)).toThrow();
    input.holders = allocationInput().holders; input.holders.data = [...input.holders.data, input.holders.data[0]];
    expect(() => allocateDistribution(input)).toThrow('INVALID_HOLDER');
  });
  it('equal weights tiny payout chooses explicit last address; inactive/zero facts and unknown membership never gain leaves', () => {
    const input = allocationInput('sorted-last-omit-zero', '1');
    input.holders.data = input.holders.data.map(h => ({ ...h, participationTokenBalance: '1' }));
    expect(allocateDistribution(input).allocations).toEqual([{ address: C, amountRaw: '1' }]);
    input.holders.data = [{ ...input.holders.data[0], membershipStatus: 'Inactive' }, { ...input.holders.data[1], participationTokenBalance: '0' }, input.holders.data[2]];
    expect(allocateDistribution(input).allocations).toEqual([{ address: C, amountRaw: '1' }]);
    input.holders.data = [{ ...input.holders.data[0], membershipStatus: 'Unknown' }];
    expect(() => allocateDistribution(input)).toThrow('MEMBERSHIP_UNKNOWN');
  });
});

function storedDocument(): DistributionClaimsDocument {
  return buildDistributionClaimsDocument({ token: TOKEN, tokenSymbol: 'USDC', totalAmount: '10', checkpointBlock: 99, merkleRoot: GOLD.host10.root,
    claims: Object.fromEntries(GOLD.host10.leaves.map(([a, amount]: string[], i: number) => [a, { amount, proof: GOLD.host10.proofs[i] }])), createdAt: 1700000000000 });
}
function reference(): DistributionClaimsReference { return { chainId: 100, orgId: ORG, paymentManager: PM, distributionId: '1', cid: CID, merkleRoot: GOLD.host10.root, token: TOKEN, totalAmount: '10', checkpointBlock: '99' }; }
const verify = (doc: unknown = storedDocument(), ref = reference(), loadedCid = CID) => verifyDistributionClaimsDocument(doc, { reference: ref, loadedCid });
describe('DISTRIBUTION-DOCUMENT / immutable stored tree and scope guards', () => {
  it('preserves current JSON keys/order and stored checkpoint representation; reload yields the same raw proof', () => {
    const doc = storedDocument(); expect(Object.keys(doc)).toEqual(['token', 'tokenSymbol', 'totalAmount', 'checkpointBlock', 'merkleRoot', 'claims', 'createdAt']);
    const verified = verify(JSON.parse(JSON.stringify(doc)));
    expect(findDistributionClaim(verified, A.toUpperCase().replace('0X', '0x'))).toEqual(knownFact({ amount: '5', proof: GOLD.host10.proofs[0] }));
    expect(findDistributionClaim(verified, addr(50))).toEqual(knownFact(null));
    expect(verify().state).toBe('known');
  });
  it('letter-case claim lookup resolves a real checksummed stored address; case-duplicate leaves are rejected', () => {
    const lower = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', checksum = ethers.utils.getAddress(lower);
    const root = ethers.utils.keccak256(ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'uint256'], [lower, '9007199254740993'])));
    const doc = buildDistributionClaimsDocument({ ...storedDocument(), totalAmount: '9007199254740993', merkleRoot: root, claims: { [checksum]: { amount: '9007199254740993', proof: [] } } });
    const verified = verify(doc, { ...reference(), totalAmount: doc.totalAmount, merkleRoot: root });
    expect(findDistributionClaim(verified, lower)).toEqual(knownFact({ amount: '9007199254740993', proof: [] }));
    expect(findDistributionClaim(verified, lower.toUpperCase().replace('0X', '0x'))).toEqual(knownFact({ amount: '9007199254740993', proof: [] }));
    doc.claims[lower] = doc.claims[checksum];
    expect(verify(doc, { ...reference(), totalAmount: doc.totalAmount, merkleRoot: root })).toEqual(unknownFact('DUPLICATE_OR_INVALID_CLAIM'));
  });
  it('missing document/fetch failure stays unknown, never known absent or zero entitlement', () => {
    expect(verify(null).state).toBe('unknown');
    expect(findDistributionClaim(verify(null), A).state).toBe('unknown');
    expect(findDistributionClaim(unknownFact('GATEWAY_FAILED'), A)).toEqual(unknownFact('GATEWAY_FAILED'));
  });
  it.each(['root', 'token', 'total', 'checkpoint', 'proof', 'duplicate', 'truncated'] as const)('rejects stored %s tampering', kind => {
    const doc = storedDocument();
    if (kind === 'root') doc.merkleRoot = HASH;
    if (kind === 'token') doc.token = PT;
    if (kind === 'total') doc.totalAmount = '9';
    if (kind === 'checkpoint') doc.checkpointBlock = 98;
    if (kind === 'proof') doc.claims[A].proof = [HASH];
    if (kind === 'duplicate') { const special = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'; doc.claims[special] = doc.claims[A]; doc.claims[special.toUpperCase().replace('0X', '0x')] = doc.claims[A]; }
    if (kind === 'truncated') delete doc.claims[B];
    expect(verify(doc).state).toBe('unknown');
  });
  it('wrong loaded CID and invalid external binding refuse; scoped cache keys isolate chains/managers/accounts', () => {
    expect(verify(storedDocument(), reference(), OTHER_CID).state).toBe('unknown');
    expect(verify(storedDocument(), { ...reference(), paymentManager: ZERO }).state).toBe('unknown');
    const key = distributionClaimCacheKey(reference(), A);
    for (const ref of [{ ...reference(), chainId: 42161 }, { ...reference(), paymentManager: TM }, { ...reference(), distributionId: '2' }, { ...reference(), cid: OTHER_CID }]) expect(distributionClaimCacheKey(ref, A)).not.toBe(key);
    expect(distributionClaimCacheKey(reference(), B)).not.toBe(key);
  });
  it('old frozen allocations stay5/2/3 after choosing CLI6/2/2 for a NEW distribution', () => {
    allocateDistribution(allocationInput('cli-first-holder'));
    expect(findDistributionClaim(verify(), A)).toEqual(knownFact({ amount: '5', proof: GOLD.host10.proofs[0] }));
    const marker = distributionClaimsDiscoveryMarker(reference());
    expect(marker).toBe(`Merkle tree: ipfs://${CID} Root: ${GOLD.host10.root}`);
    expect(parseDistributionClaimsDiscoveryMarker(marker)).toEqual(knownFact({ cid: CID, merkleRoot: GOLD.host10.root }));
    expect(parseDistributionClaimsDiscoveryMarker(marker + ' ' + marker).state).toBe('unknown');
  });
  it('prepared stored CID/root is included in resolved proposal and checked BEFORE any upload', async () => {
    const context = { chainId: 100, client: {}, ipfs: {}, env: {} } as any;
    const merkle = { merkleRoot: GOLD.host10.root, totalAmount: '10', tokenAddress: TOKEN, checkpointBlock: '99', memberCount: 3 };
    const params = { org: ORG, merkle, preparedClaims: { document: storedDocument(), reference: reference(), loadedCid: CID } };
    const intent = await proposeDistributionIntent(context, params);
    expect(intent.meta.ipfs?.metadata).toMatchObject({ description: expect.stringContaining(distributionClaimsDiscoveryMarker(reference())) });
    expect(intent.meta.summary?.claimsCid).toBe(CID);
    vi.mocked(pinJson).mockClear();
    await expect(proposeDistributionIntent(context, { ...params, preparedClaims: { ...params.preparedClaims, loadedCid: OTHER_CID } })).rejects.toThrow('CLAIM_CID_MISMATCH');
    expect(pinJson).not.toHaveBeenCalled();
    await expect(proposeDistributionIntent(context, { ...params, preparedClaims: { ...params.preparedClaims, reference: { ...reference(), paymentManager: TM } } })).rejects.toThrow();
    expect(pinJson).not.toHaveBeenCalled();
  });
  it('retained no-reference distribution convenience refuses invalid duration before metadata publication', async () => {
    await expect(proposeDistributionIntent({ chainId: 100, client: {}, ipfs: {} } as any, { org: ORG, durationMinutes: 1,
      merkle: { merkleRoot: GOLD.host10.root, totalAmount: '10', tokenAddress: TOKEN, checkpointBlock: '99', memberCount: 3 } })).rejects.toThrow();
    expect(pinJson).not.toHaveBeenCalled();
  });
});

describe('TREASURY-SEND-INPUT / exact decimal adapter and retained CLI behavior', () => {
  const makeSend = (tokenAddress: string | null, recipients = [{ to: A, amount: '0.123456789123456789' }], decimals = 18) => buildSendProposalExact({ hybridVotingAddress: HV, tokenAddress,
    recipients, decimals, tokenLabel: 'asset', descriptionHash: HASH, durationMinutes: '60', orgId: ORG });
  it.each([null, '', ZERO])('explicit native alias %j preserves every wei and uses one exact summary total', token => {
    const intent = makeSend(token);
    expect((intent.args[4] as any)[0][0][1].toString()).toBe('123456789123456789');
    expect(intent.meta.summary?.totalAmountRaw).toBe('123456789123456789');
    expect(treasuryTokenAddress(token)).toBe(ZERO);
  });
  it('arbitrary decimal strings above2^53 plus one wei sum exactly; prepared call values sum to the same total', () => {
    const intent = makeSend(null, [{ to: A, amount: '9007199254740993.000000000000000001' }, { to: B, amount: '0.000000000000000001' }]);
    const expected = '9007199254740993000000000000000002';
    expect(intent.meta.summary?.totalAmountRaw).toBe(expected);
    expect((intent.args[4] as any)[0].reduce((sum: bigint, r: any) => sum + BigInt(r[1].toString()), 0n).toString()).toBe(expected);
    expect(encodeIntent(intent).value).toBe('0'); // proposal creation itself is nonpayable
  });
  it('USDC1.000001 is1000001 raw with zero native value and exact ERC20 transfer', () => {
    const intent = makeSend(TOKEN, [{ to: A, amount: '1.000001' }], 6);
    const call = (intent.args[4] as any)[0][0];
    expect([call[0], call[1].toString()]).toEqual([TOKEN, '0']);
    expect(new ethers.utils.Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', call[2])[1].toString()).toBe('1000001');
    expect(intent.meta.summary?.totalAmountRaw).toBe('1000001');
  });
  it.each(['1.0000001', '-1', '1e3', ' 1', 'NaN'])('USDC input %s refuses before upload', async amount => {
    await expect(sendProposalExactIntent({ chainId: 100, client: {} } as any, { org: ORG, tokenAddress: TOKEN, decimals: 6, tokenLabel: 'USDC',
      recipients: [{ to: A, amount }], createdAt: 1700000000000 })).rejects.toThrow();
    expect(pinJson).not.toHaveBeenCalled();
  });
  it('raw and decimal mutually exclusive; unsafe raw or uint-sum overflow refuses; numeric CLI output unchanged', () => {
    expect(prepareExactRecipients([{ to: A, amount: '1.000001' }], 6)).toEqual([{ to: A, amountRaw: '1000001' }]);
    expect(parseRecipients({ to: A, amount: 1.25 })).toEqual([{ to: A, amount: 1.25 }]);
    const base = { hybridVotingAddress: HV, tokenAddress: null, decimals: 18, tokenLabel: 'native', descriptionHash: HASH, durationMinutes: '60' };
    expect(() => buildSendProposalExact({ ...base, recipients: [{ to: A, amount: '1' }], rawRecipients: [{ to: A, amountRaw: '1' }] })).toThrow();
    expect(() => buildSendProposalExact({ ...base, rawRecipients: [{ to: A, amountRaw: ethers.constants.MaxUint256.toString() }, { to: B, amountRaw: '1' }] })).toThrow();
  });
  it('retained numeric convenience preserves valid metadata and refuses already-unencodable input before upload', async () => {
    const context = { chainId: 100, client: {}, ipfs: {}, env: {} } as any;
    const intent = await sendProposalIntent(context, { org: ORG, to: A, amount: 1.25 });
    expect(intent.meta.summary).toMatchObject({ totalAmount: '1.25', recipients: 1 });
    expect((intent.meta.ipfs?.metadata as any).description).toContain('Transfer 1.25');
    vi.mocked(pinJson).mockClear();
    await expect(sendProposalIntent(context, { org: ORG, to: A, amount: 1e-20 })).rejects.toThrow();
    expect(pinJson).not.toHaveBeenCalled();
  });
});

function binding(contract: string, module: string) { return { organization: { id: ORG, [module]: { id: contract, organization: { id: ORG } } } }; }
function meta(number = 100, hash: string | null = HASH) { return { _meta: { block: { number, hash, timestamp: null } } }; }
function workRow(id: number, status: string, deleted = false, token = TOKEN, bountyPayout = '1000001') {
  const projectId = ethers.utils.hexZeroPad(ethers.BigNumber.from(id).toHexString(), 32);
  return { id: `${TM}-${String(id).padStart(6, '0')}`, taskId: String(id), taskManager: TM, status, payout: '9007199254740993000000000000000001', bountyToken: token, bountyPayout,
    project: { id: `${TM}-${projectId}`, projectId, deleted, taskManager: { id: TM, organization: { id: ORG } } } };
}
describe('TREASURY-TASK-HISTORY / uncapped historical financial selection', () => {
  it('pages1103 completions across >100 projects, including deleted projects, and segregates raw6/18 assets', async () => {
    const rows = Array.from({ length: 1103 }, (_, i) => workRow(i + 1, 'Completed', i % 2 === 0, i % 2 === 0 ? TOKEN : ZERO, i % 2 === 0 ? '1000001' : '9007199254740993000000000000000001'));
    const query = vi.fn(async (_doc, vars: Record<string, unknown>) => ({ ...meta(), ...binding(TM, 'taskManager'), tasks: rows.filter(r => r.id > String(vars.cursor)).slice(0, Number(vars.first)) }));
    const result = await readTreasuryWorkFacts({ source: src(TM, true), query, kind: 'completed', pageSize: 100, maxPages: 20 });
    expect(result.coverage.status).toBe('complete'); expect(result.data).toHaveLength(1103); expect(query).toHaveBeenCalledTimes(12);
    expect((result.data[0].project as any).deleted).toBe(true);
    expect(projectTreasuryBountyTotals(result, [X, NATIVE])).toEqual(knownFact([
      { asset: X, rawAmount: String(552n * 1000001n) }, { asset: NATIVE, rawAmount: String(551n * 9007199254740993000000000000000001n) },
    ], result.source));
  });
  it('promises select Open/Assigned/Submitted separately; terminal rows from a lying adapter mark incomplete', async () => {
    const query = async (doc: string) => ({ ...meta(), ...binding(TM, 'taskManager'), tasks: [workRow(1, 'Open'), workRow(2, 'Assigned'), workRow(3, 'Submitted')] });
    const result = await readTreasuryWorkFacts({ source: src(TM, true), query, kind: 'promised' });
    expect(result.coverage.status).toBe('complete'); expect(projectTreasuryBountyTotals(result, [X])).toEqual(knownFact([{ asset: X, rawAmount: '3000003' }], result.source));
    const bad = await readTreasuryWorkFacts({ source: src(TM, true), kind: 'promised', query: async () => ({ ...meta(), ...binding(TM, 'taskManager'), tasks: [workRow(1, 'Completed'), workRow(2, 'Cancelled')] }) });
    expect(bad.coverage.status).toBe('incomplete'); expect(projectTreasuryBountyTotals(bad, [X]).state).toBe('unknown');
  });
  it.each(['failed-page', 'stalled-cursor', 'cap', 'missing-array', 'missing-proof', 'wrong-binding', 'mixed-hash'] as const)('%s remains incomplete/unavailable with retained diagnostic history and unknown totals', async kind => {
    let call = 0;
    const query = async () => {
      call++; if (call === 2 && kind === 'failed-page') throw new Error('Network');
      if (call === 1 && kind === 'missing-array') return { ...meta(), ...binding(TM, 'taskManager') };
      const proof = kind === 'missing-proof' ? {} : meta(100, call === 2 && kind === 'mixed-hash' ? OTHER_HASH : HASH);
      const bind = kind === 'wrong-binding' ? binding(PM, 'taskManager') : binding(TM, 'taskManager');
      return { ...proof, ...bind, tasks: [workRow(call === 2 && kind === 'stalled-cursor' ? 1 : call, 'Completed', true)] };
    };
    const result = await readTreasuryWorkFacts({ source: src(TM, true), query, kind: 'completed', pageSize: 1, maxPages: kind === 'cap' ? 1 : 2 });
    expect(result.coverage.status).not.toBe('complete'); expect(projectTreasuryBountyTotals(result, [X]).state).toBe('unknown');
    expect(() => requireCompleteSnapshot(result)).toThrow();
  });
  it('numeric null->hash provenance upgrade even on terminal empty page refuses; true empty installed module stays complete', async () => {
    const source = src(TM, true, { block: { number: '100' } }); let call = 0;
    const result = await readTreasuryWorkFacts({ source, kind: 'completed', pageSize: 1, query: async () => ({ ...meta(100, ++call === 1 ? null : HASH), ...binding(TM, 'taskManager'), tasks: call === 1 ? [workRow(1, 'Completed')] : [] }) });
    expect(result.coverage.status).toBe('incomplete'); expect(result.source.block).toEqual({ number: '100' });
    expect((await readTreasuryWorkFacts({ source: src(TM, true), kind: 'completed', query: async () => ({ ...meta(), ...binding(TM, 'taskManager'), tasks: [] }) })).coverage.status).toBe('complete');
    expect((await readTreasuryWorkFacts({ source: src(TM, true), kind: 'completed', query: async () => ({ ...meta(), organization: null, tasks: [] }) })).coverage.status).toBe('unavailable');
  });
  it('missing bounty/metadata remains field unknown despite complete row transport; known zero is preserved', async () => {
    const row = workRow(1, 'Open'); const query = async () => ({ ...meta(), ...binding(TM, 'taskManager'), tasks: [row] });
    const complete = await readTreasuryWorkFacts({ source: src(TM, true), query, kind: 'promised' });
    expect(projectTreasuryBountyTotals(complete, []).state).toBe('unknown');
    expect(projectTreasuryBountyTotals({ ...complete, data: [{ ...row, bountyPayout: undefined }] }, [X]).state).toBe('unknown');
    expect(projectTreasuryBountyTotals({ ...complete, data: [{ ...row, bountyPayout: '0' }] }, [X])).toEqual(knownFact([{ asset: X, rawAmount: '0' }], complete.source));
  });
});

describe('FINANCIAL-HISTORY-DOC / executed pagination and independently paged rounds/payments/claims', () => {
  it('pages61 executed proposals beyond old50 cap; exact old description remains discoverable', async () => {
    const rows = Array.from({ length: 61 }, (_, i) => ({ id: `${HV}-${String(i + 1).padStart(3, '0')}`, proposalId: String(i + 1), status: 'Executed', descriptionHash: HASH,
      hybridVoting: { id: HV, organization: { id: ORG } }, metadata: { description: i === 60 ? distributionClaimsDiscoveryMarker(reference()) : 'Ordinary executed proposal' } }));
    const query = vi.fn(async (_doc, vars: Record<string, unknown>) => ({ ...meta(), ...binding(HV, 'hybridVoting'), proposals: rows.filter(r => r.id > String(vars.cursor)).slice(0, Number(vars.first)) }));
    const result = await readDistributionReferences({ source: src(HV, true), query, pageSize: 50 });
    expect(result.coverage.status).toBe('complete'); expect(result.data).toHaveLength(61); expect(query).toHaveBeenCalledTimes(2);
    expect(result.data[60].reference).toEqual(knownFact({ cid: CID, merkleRoot: GOLD.host10.root }));
    expect(result.data[0].reference.state).toBe('unknown');
    expect(findDistributionClaim(verify(), A).state).toBe('known');
  });
  it('executed filter and module binding are enforced including terminal empty; partial metadata stays unknown', async () => {
    const source = src(HV, true);
    const wrong = await readDistributionReferences({ source, query: async () => ({ ...meta(), ...binding(PM, 'hybridVoting'), proposals: [] }) });
    expect(wrong.coverage.status).toBe('unavailable');
    const pending = await readDistributionReferences({ source, query: async () => ({ ...meta(), ...binding(HV, 'hybridVoting'), proposals: [{ id: 'a', proposalId: '1', status: 'Active', hybridVoting: { id: HV, organization: { id: ORG } } }] }) });
    expect(pending.coverage.status).toBe('incomplete');
    const result = await readDistributionReferences({ source, query: async () => ({ ...meta(), ...binding(HV, 'hybridVoting'), proposals: [{ id: 'a', proposalId: '1', status: 'Executed', hybridVoting: { id: HV, organization: { id: ORG } }, metadata: null }] }) });
    expect(result.coverage.status).toBe('complete'); expect(result.data[0].reference.state).toBe('unknown');
  });
  it('201 rounds / 251 payments / 301 claims use independent cursors and retain older claims', async () => {
    const manager = { id: PM, organization: { id: ORG } };
    const rounds = Array.from({ length: 201 }, (_, i) => ({ id: `r${String(i + 1).padStart(3, '0')}`, distributionId: String(i + 1), paymentManager: manager, payoutToken: TOKEN, totalAmount: '10', totalClaimed: '5', checkpointBlock: '1', createdAtBlock: '2', merkleRoot: GOLD.host10.root, status: 'Active' }));
    const payments = Array.from({ length: 251 }, (_, i) => ({ id: ethers.utils.hexZeroPad(ethers.utils.hexlify(i + 1), 32), paymentManager: manager, payer: A, token: TOKEN, amount: '1000001', receivedAt: '1', receivedAtBlock: '2', transactionHash: HASH }));
    const claims = Array.from({ length: 301 }, (_, i) => ({ id: `c${String(i + 1).padStart(3, '0')}`, paymentManager: manager, distribution: { id: `${PM}-1`, distributionId: '1' }, claimer: A, amount: '5', claimedAt: '1', claimedAtBlock: '3', transactionHash: HASH }));
    const query = async (doc: string, vars: Record<string, unknown>) => {
      const [key, rows] = doc.includes('FetchDistributionsPage') ? ['distributions', rounds] : doc.includes('FetchPaymentsPage') ? ['payments', payments] : ['claims', claims];
      return { ...meta(), ...binding(PM, 'paymentManager'), [key as string]: (rows as any[]).filter(r => r.id > String(vars.cursor)).slice(0, Number(vars.first)) };
    };
    const options = { source: src(PM, true), query, pageSize: 100 };
    const results = await Promise.all([readDistributionHistoryFacts(options), readPaymentHistoryFacts(options), readDistributionClaimFacts({ ...options, distributionId: '1' })]);
    expect(results.map(r => r.data.length)).toEqual([201, 251, 301]); expect(results.map(r => r.coverage.status)).toEqual(['complete', 'complete', 'complete']);
  });
});

const POT_HISTORY: HistoricalPot[] = [{ chainId: 100, address: PM, kind: 'payment-manager', orgId: ORG, createdAtBlock: '1' }, { chainId: 100, address: RETIRED, kind: 'payment-manager', orgId: ORG, createdAtBlock: '1' }, { chainId: 100, address: EXEC, kind: 'executor', orgId: ORG, createdAtBlock: '1' }];
const pots = () => snap(POT_HISTORY, src(PM, true));
function event(logIndex = '1', overrides: Partial<RecordedInflowEvent> = {}): RecordedInflowEvent { return { chainId: 100, transactionHash: HASH, logIndex, blockNumber: '40', from: A, to: RETIRED, asset: X, amountRaw: '1000001', provenance: 'erc20-transfer', ...overrides }; }
function inflowInput() {
  const chunk1: InflowEventChunk = { fromBlock: '1', toBlock: '50', events: [event(), event(), event('2', { from: PM, to: EXEC, amountRaw: '2000000' })] };
  const chunk2: InflowEventChunk = { fromBlock: '51', toBlock: '100', events: [event('3', { blockNumber: '80', asset: NATIVE, amountRaw: '9007199254740993000000000000000001', provenance: 'payment-received' })] };
  return { pots: pots(), chunks: [snap(chunk1, src(PM, false)), snap(chunk2, src(PM, false))], fromBlock: '1', block: BLOCK };
}
describe('INFLOW-PROJECTION / recorded scope, historical pots and exact per-asset totals', () => {
  it('retired pots remain; dedup and internal movements are separate;6/18 raw values and unknown causal scope survive', () => {
    const result = normalizeRecordedInflows(inflowInput());
    expect(result.events).toHaveLength(3); expect(result.internalMovements).toHaveLength(1);
    expect(result.externalRecordedTotals).toEqual(knownFact([{ asset: X, rawAmount: '1000001' }, { asset: NATIVE, rawAmount: '9007199254740993000000000000000001' }], pots().source));
    expect(result.completeRevenue.state).toBe('unknown'); expect(result.scope).toBe('recorded-gross-events');
    expect(classifyInternalMovement(event('2', { from: PM, to: EXEC }), pots())).toEqual(knownFact(true, pots().source));
  });
  it('chain+tx+log is the identity; the same hash on another chain is a distinct event and conflicts refuse', () => {
    const other = event('1', { chainId: 42161, asset: { ...X, chainId: 42161 } });
    const distinct = deduplicateInflowEvents([event(), other]); expect(distinct.state === 'known' && distinct.value.length).toBe(2);
    expect(deduplicateInflowEvents([event(), event('1', { amountRaw: '2' })]).state).toBe('unknown');
  });
  it.each(['failed', 'gap', 'overlap', 'wrong-chain', 'wrong-block', 'hash-upgrade', 'missing-pots', 'invalid-units'] as const)('%s log/source evidence keeps totals unknown', kind => {
    const input = inflowInput();
    if (kind === 'failed') input.chunks[1].coverage.status = 'incomplete';
    if (kind === 'gap') input.chunks[1].data.fromBlock = '52';
    if (kind === 'overlap') input.chunks[1].data.fromBlock = '50';
    if (kind === 'wrong-chain') input.chunks[1].source.chainId = 42161;
    if (kind === 'wrong-block') input.chunks[1].source.block = { number: '101', hash: HASH };
    if (kind === 'hash-upgrade') { input.block = { number: '100' } as any; input.pots.source.block = { number: '100' }; input.chunks[0].source.block = { number: '100' }; }
    if (kind === 'missing-pots') input.pots.coverage.status = 'incomplete';
    if (kind === 'invalid-units') input.chunks[0].data.events = [event('1', { amountRaw: '1.1' })];
    const result = normalizeRecordedInflows(input);
    expect(result.externalRecordedTotals.state).toBe('unknown'); expect(result.events.length).toBeGreaterThan(0);
  });
  it('unknown pot/native provenance and asset mismatch cannot become inflow zero', () => {
    const input = inflowInput(); input.chunks[0].data.events = [event('1', { to: TM })];
    expect(normalizeRecordedInflows(input).externalRecordedTotals.state).toBe('unknown');
    expect(deduplicateInflowEvents([event('1', { asset: NATIVE, provenance: 'erc20-transfer' })]).state).toBe('unknown');
    const incomplete = pots(); incomplete.coverage.status = 'unavailable';
    expect(classifyInternalMovement(event(), incomplete).state).toBe('unknown');
  });
  it('historical pot streams paginate separately and pinned filters apply to every collection and metadata', async () => {
    const roots = { taskManagers: [TM, addr(30), addr(31)], paymentManagerContracts: [PM, RETIRED], executorContracts: [EXEC] };
    const query = vi.fn(async (_doc, vars: Record<string, unknown>) => {
      expect(vars.block).toEqual({ hash: HASH });
      return { ...meta(), ...Object.fromEntries(Object.entries(roots).map(([key, addresses]) => {
        const cursor = vars[key === 'taskManagers' ? 'taskCursor' : key === 'paymentManagerContracts' ? 'paymentCursor' : 'executorCursor'];
        return [key, addresses.filter(a => a > String(cursor)).slice(0, Number(vars.first)).map(id => ({ id, createdAtBlock: '1', organization: { id: ORG } }))];
      })) };
    });
    const globalSource = src(PM, true, { orgId: undefined, contract: undefined });
    const result = await readHistoricalPotFacts({ source: globalSource, query, pageSize: 1 });
    expect(Object.values(result).map(r => r.data.length)).toEqual([3, 2, 1]); expect(Object.values(result).every(r => r.coverage.status === 'complete')).toBe(true);
    expect(result['payment-manager'].data.some(p => p.address === RETIRED)).toBe(true);
    const native = await readRecordedNativeDepositFacts({ source: globalSource, query: async () => ({ ...meta(), payments: [{ id: HASH, token: ZERO, amount: '1', payer: A, receivedAtBlock: '50', transactionHash: HASH, paymentManager: { id: RETIRED, organization: { id: ORG } } }] }) });
    expect(native.coverage.status).toBe('complete'); expect(native.data[0].amount).toBe('1');
  });
});

describe('CASHOUT-SCHEMA / independent viem encoding, receipt identity and recovery facts', () => {
  const descriptor = { chainId: 8453, relay: PM, escrow: TM, token: TOKEN };
  const payload = { depositor: A, paymentMethod: ethers.utils.id('venmo'), payeeDetailsHash: HASH, fiatCurrency: ethers.utils.id('USD'), conversionRate: '980000000000000000', minIntentAmount: '1000000', maxIntentAmount: '10000000' };
  function depositLog(depositId = '1', overrides: Partial<CashoutLog> = {}, depositor = A, token = TOKEN): CashoutLog {
    const iface = new ethers.utils.Interface([...CASHOUT_ESCROW_ABI_V1]);
    const log = iface.encodeEventLog(iface.getEvent('DepositReceived'), [depositId, depositor, token, '10000000', ['1000000', '10000000'], ZERO, ZERO]);
    return { address: TM, topics: log.topics, data: log.data, logIndex: depositId, transactionHash: HASH, ...overrides };
  }
  const decode = (logs: CashoutLog[], extra = {}) => decodeCashoutDeposit({ descriptor, chainId: 8453, depositor: A, transactionHash: HASH, logs, ...extra });
  it('seven-field224-byte tuple matches independent viem; USDC6/rate18 decimal preparation is exact', () => {
    const data = encodeCashoutPayload(payload);
    expect((data.length - 2) / 2).toBe(224);
    expect(data).toBe(encodeAbiParameters(CASHOUT_PARAMS_TUPLE, [{ ...payload, depositor: A as `0x${string}`, paymentMethod: payload.paymentMethod as `0x${string}`, payeeDetailsHash: HASH as `0x${string}`, fiatCurrency: payload.fiatCurrency as `0x${string}`, conversionRate: 980000000000000000n, minIntentAmount: 1000000n, maxIntentAmount: 10000000n }]));
    expect(prepareCashoutPayload({ ...payload, conversionRateDecimal: '0.98', minIntentDecimal: '1', maxIntentDecimal: '10' })).toEqual(payload);
    expect(CASHOUT_SCHEMA_V1).toEqual({ version: 1, tokenDecimals: 6, conversionRateDecimals: 18, payloadBytes: 224 });
    expect(() => prepareCashoutPayload({ ...payload, conversionRateDecimal: '0.9800000000000000001', minIntentDecimal: '1', maxIntentDecimal: '10' })).toThrow();
  });
  it('matched emitter/depositor/token/chain/tx only; two matching deposits are ambiguous, explicit ID narrows', () => {
    expect(decode([depositLog()])).toEqual(knownFact({ depositId: '1', depositor: A, token: TOKEN, amountRaw: '10000000', logIndex: '1', transactionHash: HASH }));
    expect(decode([depositLog('1', { address: EXEC }), depositLog('2', {}, B), depositLog('3', {}, A, PT)]).state).toBe('unknown');
    expect(decode([depositLog('1'), depositLog('2')]).state).toBe('unknown');
    expect(decode([depositLog('1'), depositLog('2')], { depositId: '2' }).state).toBe('known');
    expect(decode([depositLog()], { chainId: 100 }).state).toBe('unknown');
    expect(decode([depositLog('1', { transactionHash: OTHER_HASH })]).state).toBe('unknown');
    expect(decode([depositLog(), depositLog()]).state).toBe('known');
  });
  it('failed recovery and remaining escrow withdrawal are distinct exact transaction intents', () => {
    const failed = encodeIntent(buildRecoverFailed({ descriptor, requestHash: HASH }));
    const escrow = encodeIntent(buildWithdrawDeposit({ descriptor, depositId: '9007199254740993' }));
    expect(failed).toEqual({ to: PM, value: '0', data: encodeFunctionData({ abi: parseAbi(['function recoverFailed(bytes32 requestHash)']), functionName: 'recoverFailed', args: [HASH as `0x${string}`] }) });
    expect(escrow).toEqual({ to: TM, value: '0', data: encodeFunctionData({ abi: parseAbi(['function withdrawDeposit(uint256 depositId)']), functionName: 'withdrawDeposit', args: [9007199254740993n] }) });
  });
  it('same-block owner/token capabilities preserve remaining/outstanding and unknown initiation; false/zero remain known', () => {
    const source = src(TM, false, { chainId: 8453, account: A });
    const state: CashoutRecoveryState = { kind: 'escrow', depositId: '1', depositor: A, token: TOKEN, remainingDeposits: '9007199254740993', outstandingIntentAmount: '1000001' };
    const facts = projectRecoveryFacts({ descriptor, account: A, block: BLOCK, snapshot: snap(state, source), transactionCapability: knownFact(true, source) });
    expect(facts.state).toBe('known');
    if (facts.state === 'known') expect(facts.value).toMatchObject({ owner: true, recoverableAmountRaw: '9007199254740993', outstandingIntentAmountRaw: '1000001', initiationCapability: { state: 'unknown' }, transactionOnlyCapability: { state: 'known', value: true } });
    const empty = projectRecoveryFacts({ descriptor, account: A, block: BLOCK, snapshot: snap({ ...state, remainingDeposits: '0', outstandingIntentAmount: '0' }, source), transactionCapability: knownFact(false, source) });
    expect(empty.state === 'known' && empty.value.recoverableAmountRaw).toBe('0');
    expect(empty.state === 'known' && empty.value.transactionOnlyCapability).toEqual(knownFact(false, source));
    const failedSource = { ...source, contract: PM };
    const failed = projectRecoveryFacts({ descriptor, account: A, block: BLOCK, snapshot: snap<CashoutRecoveryState>({ kind: 'failed', requestHash: HASH, depositor: A, token: TOKEN, amountRaw: '1000000' }, failedSource), transactionCapability: unknownFact('ACCOUNT_CAPABILITY_UNKNOWN') });
    expect(failed.state === 'known' && failed.value.kind).toBe('failed');
    expect(failed.state === 'known' && failed.value.transactionOnlyCapability.state).toBe('unknown');
  });
  it.each(['token', 'chain', 'owner', 'failed-read', 'stale', 'capability'] as const)('%s recovery mismatch never authorizes an unsupported recovery', kind => {
    const source = src(TM, false, { chainId: 8453, account: A });
    const state: CashoutRecoveryState = { kind: 'escrow', depositId: '1', depositor: A, token: kind === 'token' ? PT : TOKEN, remainingDeposits: '1', outstandingIntentAmount: '0' };
    if (kind === 'chain') source.chainId = 100;
    if (kind === 'owner') state.depositor = B;
    if (kind === 'stale') source.block = { number: '99', hash: HASH };
    const snapshot = snap(state, source); if (kind === 'failed-read') snapshot.coverage.status = 'unavailable';
    const result = projectRecoveryFacts({ descriptor, account: A, block: BLOCK, snapshot, transactionCapability: kind === 'capability' ? knownFact(true, { ...source, contract: PM }) : knownFact(true, source) });
    if (kind === 'owner') expect(result.state === 'known' && result.value.recoverableAmountRaw).toBe('0');
    else expect(result.state).toBe('unknown');
  });
});

describe('Serving-schema portable GraphQL validation and selection execution', () => {
  const documents = [treasuryDocs.FETCH_TREASURY_TASK_ACTIVITY_PAGE, treasuryDocs.FETCH_PROMISED_BOUNTIES_PAGE, treasuryDocs.FETCH_DISTRIBUTIONS_PAGE,
    treasuryDocs.FETCH_PAYMENTS_PAGE, treasuryDocs.FETCH_DISTRIBUTION_CLAIMS_PAGE, FETCH_EXECUTED_DISTRIBUTION_PROPOSALS_PAGE, FETCH_HISTORICAL_POTS_PAGE, FETCH_NATIVE_DEPOSITS_PAGE];
  it.each(documents.map(document => [parse(document).definitions[0].kind === 'OperationDefinition' ? (parse(document).definitions[0] as any).name.value : '', document]))('%s validates all variable argument positions against generated serving field/type definitions', (_name, document) => {
    expect(validate(schema, parse(document)).map(e => e.message)).toEqual([]);
  });
  it('flat promise/executed filters survive GraphQL execution; no task project deletion filter slips into history', async () => {
    const rootValue = { organization: () => ({ id: ORG, taskManager: { id: TM, organization: { id: ORG } }, hybridVoting: { id: HV, organization: { id: ORG } } }),
      tasks: ({ where }: any) => { expect(where).toEqual({ taskManager: TM, id_gt: '', status_in: ['Open', 'Assigned', 'Submitted'] }); return []; },
      proposals: ({ where }: any) => { expect(where).toEqual({ hybridVoting: HV, id_gt: '', status: 'Executed' }); return []; }, _meta: () => ({ block: { number: 100, hash: HASH, timestamp: null } }) };
    const vars = { orgId: ORG, taskManager: TM, hybridVoting: HV, cursor: '', first: 50, block: { hash: HASH } };
    expect((await graphql({ schema, source: treasuryDocs.FETCH_PROMISED_BOUNTIES_PAGE, rootValue, variableValues: vars })).errors).toBeUndefined();
    expect((await graphql({ schema, source: FETCH_EXECUTED_DISTRIBUTION_PROPOSALS_PAGE, rootValue, variableValues: vars })).errors).toBeUndefined();
  });
  it('schema rejects misleading Bytes organization selector and String taskManager filter controls', () => {
    expect(validate(schema, parse(treasuryDocs.FETCH_TREASURY_TASK_ACTIVITY_PAGE.replace('$orgId: ID!', '$orgId: Bytes!'))).length).toBeGreaterThan(0);
    expect(validate(schema, parse(treasuryDocs.FETCH_TREASURY_TASK_ACTIVITY_PAGE.replace('$taskManager: Bytes!', '$taskManager: String!'))).length).toBeGreaterThan(0);
  });
});

describe('Compiled portable consumer examples', () => {
  it('exact native send example retains123456789123456789 wei', () => expect(exampleExactNativeSend()?.totalAmountRaw).toBe('123456789123456789'));
  it('transfer example finalizes only fully claimed1 then withdraws20', () => {
    const plan = ready(exampleTransferPlan()); expect(plan.finalizeIds).toEqual(['1']); expect(plan.amountRaw).toBe('20'); expect(plan.calls).toHaveLength(2);
  });
  it('stored claim example returns immutable5 and its frozen golden proof', () => expect(exampleStoredClaim()).toEqual(knownFact({ amount: '5', proof: GOLD.host10.proofs[0] })));
  it('cashout recovery example encodes exact large deposit ID with zero native value', () => {
    const tx = exampleCashoutWithdrawal(); expect(tx.value).toBe('0');
    expect(tx.data).toBe(encodeFunctionData({ abi: parseAbi(['function withdrawDeposit(uint256)']), functionName: 'withdrawDeposit', args: [9007199254740993n] }));
  });
});
