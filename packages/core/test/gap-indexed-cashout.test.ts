import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, parse, validate } from 'graphql';
import { readCashoutDiscovery, projectRecoveryFacts, type CashoutDescriptor } from '../src/integrations/cashout';
import { FETCH_CASHOUT_DISCOVERY_PAGE, FETCH_CASHOUT_DISCOVERY_STATE } from '../src/graph/documents/indexed-completeness';
import { knownFact, requireCompleteSnapshot, type SourceRef } from '../src/data/facts';
import type { IndexedRow } from '../src/reads/protocol';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const ACCOUNT = address(5), RELAY = address(1), ESCROW = address(2), TOKEN = address(3);
const BLOCK = { number: '50000000', hash: hash(100) };
const descriptor: CashoutDescriptor = { chainId: 8453, relay: RELAY, escrow: ESCROW, token: TOKEN };
const source = (): SourceRef => ({ chainId: 8453, account: ACCOUNT, contract: RELAY, endpoint: 'fixture://single-relay-base', method: 'graph', indexed: true, snapshot: 'pinned', block: { ...BLOCK } });
const meta = () => ({ deployment: 'relay-deployment', hasIndexingErrors: false, block: { number: 50000000, hash: BLOCK.hash, timestamp: 1000 } });
const stream = (variables: Record<string, unknown>) => Array.isArray(variables.statuses) ? variables.statuses.includes('DEPOSITED') ? 'DEPOSITED' : 'FAILED' : undefined;
function row(n: number, status: 'FAILED' | 'RECOVERED' | 'DEPOSITED'): IndexedRow {
  return { id: hash(n), requestHash: hash(n), depositor: { id: ACCOUNT }, pendingFor: status === 'FAILED' ? { id: ACCOUNT } : null,
    status, amount: '9007199254740993000001', paymentMethod: hash(20), failureReason: status === 'FAILED' ? '0xdead' : null,
    createdAtBlock: '44464307', createdAtTimestamp: '999', createdTxHash: hash(99) };
}
function fixture(failed = [row(1, 'FAILED')], deposited = [row(2, 'DEPOSITED')]) {
  const calls: { variables: Record<string, unknown>; source: SourceRef }[] = [];
  const f = { failed, deposited, state: { id: RELAY, escrow: ESCROW, usdc: TOKEN } as IndexedRow | null,
    mutate: undefined as ((response: Record<string, unknown>, variables: Record<string, unknown>) => Record<string, unknown>) | undefined };
  const options = { source: source(), descriptor, pageSize: 50, maxPages: 10,
    query: async (document: string, variables: Record<string, unknown>, ref: SourceRef): Promise<Record<string, unknown>> => {
      calls.push({ variables, source: ref });
      expect(ref).toEqual(options.source); expect(variables.block).toEqual({ hash: BLOCK.hash });
      const rows = stream(variables) === 'FAILED' ? f.failed : f.deposited;
      const response = document.includes('State(') ? { relayContract: f.state, relayContracts: f.state ? [{ id: RELAY }] : [], _meta: meta() }
        : { cashOutRequests: rows.filter(row => String(row.id) > String(variables.cursor)).sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, variables.first as number), _meta: meta() };
      return f.mutate ? f.mutate(response, variables) : response;
    } };
  return { f, options, calls };
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Offline test forbids network'); })));
afterEach(() => vi.unstubAllGlobals());

describe('existing single-relay source candidate discovery', () => {
  it('reads more than 50 rows in BOTH streams using independent Bytes-ID cursors', async () => {
    const f = fixture(Array.from({ length: 51 }, (_, n) => row(1 + n, 'FAILED')), Array.from({ length: 51 }, (_, n) => row(100 + n, 'DEPOSITED')));
    const result = await readCashoutDiscovery(f.options);
    expect(result.coverage.status).toBe('complete'); requireCompleteSnapshot(result);
    expect(result.data.failed).toHaveLength(51); expect(result.data.deposited).toHaveLength(51);
    expect(result.data.failed[0].amount).toBe('9007199254740993000001');
    for (const status of ['FAILED', 'DEPOSITED']) {
      const calls = f.calls.filter(call => stream(call.variables) === status);
      expect(calls).toHaveLength(2); expect(calls[0].variables.cursor).toBe('0x');
      expect(calls[1].variables.cursor).toBe(status === 'FAILED' ? hash(50) : hash(149));
      expect(calls.every(call => call.variables.wallet === ACCOUNT)).toBe(true);
    }
    expect(result.data.outstandingCount).toMatchObject({ state: 'unknown', code: 'LIVE_RECOVERY_STATE_REQUIRED' });
  });
  it('an exact-full page needs a terminal empty page rather than relying on a wallet counter', async () => {
    const f = fixture([row(1, 'FAILED')], []); f.options.pageSize = 1;
    const result = await readCashoutDiscovery(f.options);
    expect(result.coverage.status).toBe('complete');
    expect(f.calls.filter(call => stream(call.variables) === 'FAILED')).toHaveLength(2);
  });
  it('keeps FIFO-inferred RECOVERED rows as candidates until exact pinned relay state settles identity', async () => {
    const f = fixture([row(1, 'FAILED'), row(2, 'RECOVERED')], []);
    const result = await readCashoutDiscovery(f.options);
    expect(result.coverage.status).toBe('complete');
    expect(result.data.failed.map(candidate => candidate.status)).toEqual(['FAILED', 'RECOVERED']);
    expect(result.data.outstandingCount.state).toBe('unknown');
    expect(f.calls.find(call => stream(call.variables) === 'FAILED')!.variables.statuses).toEqual(['FAILED', 'RECOVERED']);
  });
  it('retains completed stream and partial rows when the other stream fails on page two', async () => {
    const f = fixture([row(1, 'FAILED'), row(2, 'FAILED')], [row(3, 'DEPOSITED')]); f.options.pageSize = 1;
    f.f.mutate = (response, variables) => {
      if (stream(variables) === 'FAILED' && variables.cursor !== '0x') throw new Error('endpoint rejected');
      return response;
    };
    const result = await readCashoutDiscovery(f.options);
    expect(result.coverage.status).toBe('incomplete');
    expect(result.data.failed).toHaveLength(1); expect(result.data.deposited).toHaveLength(1);
    expect(result.data.evidence.deposited.coverage.status).toBe('complete');
    expect(result.data.evidence.failed.coverage.failedIds).toEqual(['page:2']);
  });
  it('deduplicates repeated IDs without labelling the broken provider page complete', async () => {
    const f = fixture();
    f.f.mutate = (response, variables) => stream(variables) === 'FAILED' ? { ...response, cashOutRequests: [row(1, 'FAILED'), row(1, 'FAILED')] } : response;
    const result = await readCashoutDiscovery(f.options);
    expect(result.data.failed).toHaveLength(1); expect(result.coverage.status).toBe('incomplete');
    expect(result.data.evidence.failed.coverage.issues.some(issue => issue.code === 'DUPLICATE_CURSOR_OR_KEY')).toBe(true);
  });
  it('explicit per-stream page caps retain candidates and incomplete coverage', async () => {
    const f = fixture([row(1, 'FAILED')], [row(2, 'DEPOSITED')]); f.options.pageSize = 1; f.options.maxPages = 1;
    const result = await readCashoutDiscovery(f.options);
    expect(result.coverage.status).toBe('incomplete'); expect(result.coverage.cap).toBe(2);
    expect(result.data.failed).toHaveLength(1); expect(result.data.deposited).toHaveLength(1);
  });
  it.each(['wallet', 'pending-owner', 'hash', 'status', 'block', 'negative', 'missing-method'])("rejects %s row mismatches", async field => {
    const f = fixture(), candidate = f.f.failed[0];
    if (field === 'wallet') candidate.depositor = { id: address(9) };
    if (field === 'pending-owner') candidate.pendingFor = { id: address(9) };
    if (field === 'hash') candidate.requestHash = hash(9);
    if (field === 'status') candidate.status = 'DEPOSITED';
    if (field === 'block') candidate.createdAtBlock = '50000001';
    if (field === 'negative') candidate.amount = '-1';
    if (field === 'missing-method') delete candidate.paymentMethod;
    const result = await readCashoutDiscovery(f.options);
    expect(result.coverage.status).toBe('incomplete'); expect(result.data.failed).toHaveLength(0);
  });
  it.each(['wrong-token', 'wrong-escrow', 'missing-relay', 'metadata', 'index-errors', 'partial-graphql', 'block-drift', 'deployment-drift'])("does not attest discovery after %s", async failure => {
    const f = fixture();
    if (failure === 'wrong-token') f.f.state!.usdc = address(9);
    if (failure === 'wrong-escrow') f.f.state!.escrow = address(9);
    if (failure === 'missing-relay') f.f.state = null;
    f.f.mutate = (response, variables) => {
      if (!stream(variables)) return response;
      if (failure === 'metadata') delete response._meta;
      if (failure === 'index-errors') (response._meta as any).hasIndexingErrors = true;
      if (failure === 'partial-graphql') response.errors = [{ message: 'some rows are missing' }];
      if (failure === 'block-drift') (response._meta as any).block.number = 50000001;
      if (failure === 'deployment-drift') (response._meta as any).deployment = 'other-deployment';
      return response;
    };
    const result = await readCashoutDiscovery(f.options);
    expect(result.coverage.status).not.toBe('complete'); expect(() => requireCompleteSnapshot(result)).toThrow();
  });
  it('fails a wrong chain/relay/latest/org/account scope before invoking transport', async () => {
    for (const change of [
      (s: SourceRef) => { s.chainId = 100; }, (s: SourceRef) => { s.contract = ESCROW; },
      (s: SourceRef) => { s.snapshot = 'latest'; }, (s: SourceRef) => { s.orgId = hash(1); }, (s: SourceRef) => { delete s.account; },
    ]) {
      const f = fixture(); change(f.options.source);
      await expect(readCashoutDiscovery(f.options)).rejects.toThrow(); expect(f.calls).toHaveLength(0);
    }
  });
  it('cannot scope requests to a relay in a multi-relay index that lacks a request.relay field', async () => {
    const f = fixture();
    f.f.mutate = (response, variables) => variables.relay ? { ...response, relayContracts: [{ id: RELAY }, { id: address(9) }] } : response;
    const result = await readCashoutDiscovery(f.options);
    expect(result.coverage.status).toBe('incomplete');
    expect(result.data.evidence.state.coverage.status).toBe('unavailable');
    expect(result.data.failed).toHaveLength(1);
  });
  it('does not change the passkey/Permit2 initiation gate when recovery capability is proven', () => {
    const rpc = { ...source(), indexed: false, method: 'eth_call' };
    const result = projectRecoveryFacts({ descriptor, account: ACCOUNT, block: BLOCK,
      snapshot: { source: rpc, data: { kind: 'failed', requestHash: hash(1), depositor: ACCOUNT, token: TOKEN, amountRaw: '1' },
        coverage: { status: 'complete', receivedKeys: ['state'], missingIds: [], failedIds: [], issues: [] } }, transactionCapability: knownFact(true, rpc) });
    expect(result.state).toBe('known');
    if (result.state === 'known') expect(result.value.initiationCapability).toMatchObject({ state: 'unknown', code: 'PERMIT2_INITIATION_CAPABILITY_UNPROVEN' });
  });
});

// Source-derived Graph query contract, NOT a retained serving introspection.
// PerpetualOrganizationArchitect/subgraph-pop peer-cashoutrelay-base/schema.graphql
// and subgraph.yaml: one CashOutRelay data source on Base, startBlock 44464307.
const schema = buildSchema(`
  scalar Bytes
  scalar BigInt
  enum CashOutStatus { DEPOSITED FAILED RECOVERED }
  enum OrderDirection { asc desc }
  enum CashOutRequest_orderBy { id }
  input Block_height { hash: Bytes number: Int number_gte: Int }
  input CashOutRequest_filter { depositor: String status_in: [CashOutStatus!] id_gt: Bytes }
  type _Block_ { number: Int! hash: Bytes timestamp: Int }
  type _Meta_ { block: _Block_! deployment: String! hasIndexingErrors: Boolean! }
  type Wallet { id: Bytes! }
  type RelayContract { id: Bytes! usdc: Bytes escrow: Bytes }
  type CashOutRequest { id: Bytes! requestHash: Bytes! depositor: Wallet! pendingFor: Wallet amount: BigInt! paymentMethod: Bytes status: CashOutStatus! failureReason: Bytes createdAtBlock: BigInt! createdAtTimestamp: BigInt! createdTxHash: Bytes! }
  type Query {
    _meta(block: Block_height): _Meta_
    relayContract(id: ID!, block: Block_height): RelayContract
    relayContracts(first: Int = 100, block: Block_height): [RelayContract!]!
    cashOutRequests(first: Int = 100, where: CashOutRequest_filter, orderBy: CashOutRequest_orderBy, orderDirection: OrderDirection, block: Block_height): [CashOutRequest!]!
  }
`);
it('cashout documents match the actual entity source and Graph ID ordering contract offline', () => {
  for (const document of [FETCH_CASHOUT_DISCOVERY_STATE, FETCH_CASHOUT_DISCOVERY_PAGE]) expect(validate(schema, parse(document)).map(error => error.message)).toEqual([]);
});
