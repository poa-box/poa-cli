import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { buildSchema, extendSchema, graphql, parse, validate } from 'graphql';
import { ethers } from 'ethers';
import { knownFact, type SourceRef, type SourceSnapshot } from '../src/data/facts';
import type { AssetRef } from '../src/amounts';
import type { IndexedRow } from '../src/reads/protocol';
import { classifyInternalMovement, normalizeRecordedInflows, deduplicateInflowEvents,
  type HistoricalInflowPot, type RecordedInflowEvent, type InflowEventChunk } from '../src/treasury/inflows';
import { projectIndexedNativeInflow, deduplicateIndexedNativeInflows, readHistoricalPaymasterHubPotFacts,
  readIndexedNativeInflowFacts, normalizeIndexedRecordedInflows, type NativeInflowCollection,
  type IndexedNativeInflowEvent, type IndexedNativeInflowStream, type IndexedRecordedInflowsInput } from '../src/treasury/indexed-inflows';
import * as publicTreasury from '../src/treasury';
import * as documents from '../src/graph/documents/inflows';

const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const ZERO = addr(0), PM = addr(10), RETIRED = addr(11), TM = addr(12), EXEC = addr(13), HUB = addr(14), OLD_HUB = addr(15), OUTSIDE = addr(20), TOKEN = addr(21);
const HASH = '0x' + 'ab'.repeat(32), OTHER_HASH = '0x' + 'cd'.repeat(32), ORG = '0x' + 'ee'.repeat(32);
const BLOCK = { number: '100', hash: HASH, timestamp: '1000' };
const HUGE = '9007199254740993000000000000000001';
const NATIVE: AssetRef = { chainId: 100, address: ZERO, decimals: 18 }, USD: AssetRef = { chainId: 100, address: TOKEN, decimals: 6 };
const source = (overrides: Partial<SourceRef> = {}): SourceRef => ({ chainId: 100, endpoint: 'fixture://indexed-inflows', method: 'graph', indexed: true, snapshot: 'pinned', block: { ...BLOCK }, ...overrides });
const snap = <T>(data: T, src = source()): SourceSnapshot<T> => ({ source: src, data,
  coverage: { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] } });
const meta = () => ({ _meta: { block: { number: 100, hash: HASH, timestamp: 1000 } } });
const nativeCollections: NativeInflowCollection[] = ['payments', 'paymasterDepositEvents', 'solidarityEvents'];
function row(collection: NativeInflowCollection = 'payments', id = '0x01', overrides: IndexedRow = {}): IndexedRow {
  const fields = collection === 'payments' ? { payer: OUTSIDE, token: ZERO, receivedAtBlock: '40', paymentManager: { id: RETIRED, organization: { id: ORG } } }
    : { from: OUTSIDE, eventAtBlock: '40', eventType: collection === 'paymasterDepositEvents' ? 'OrgDeposit' : 'DonationReceived', paymasterHub: { id: HUB } };
  return { id, transactionHash: HASH, amount: '1', ...fields, ...overrides };
}
function projected(collection: NativeInflowCollection = 'payments', id = '0x01', overrides: IndexedRow = {}, src = source()): IndexedNativeInflowEvent {
  const result = projectIndexedNativeInflow(row(collection, id, overrides), collection, src, NATIVE);
  if (result.state !== 'known') throw new Error(result.code);
  return result.value;
}
function log(logIndex = '1', overrides: Partial<RecordedInflowEvent> = {}): RecordedInflowEvent {
  return { chainId: 100, transactionHash: HASH, logIndex, blockNumber: '40', from: OUTSIDE, to: HUB, asset: USD, amountRaw: '1000001', provenance: 'erc20-transfer', ...overrides };
}
function input(): IndexedRecordedInflowsInput {
  const pot = (address: string, kind: 'payment-manager' | 'task-manager' | 'executor') => ({ chainId: 100, address, kind, orgId: ORG, createdAtBlock: '1' });
  return { fromBlock: '1', block: { ...BLOCK }, nativeAsset: { ...NATIVE },
    pots: { 'payment-manager': snap([pot(PM, 'payment-manager'), pot(RETIRED, 'payment-manager')]), 'task-manager': snap([pot(TM, 'task-manager')]), executor: snap([pot(EXEC, 'executor')]),
      'paymaster-hub': snap([HUB, OLD_HUB].map(address => ({ chainId: 100, address, kind: 'paymaster-hub' as const, createdAtBlock: '1' }))) },
    chunks: [snap<InflowEventChunk>({ fromBlock: '1', toBlock: '100', events: [log(), log('2', { from: PM, amountRaw: '2000000' })] }, source({ indexed: false, endpoint: 'fixture://rpc', method: 'eth_getLogs' }))],
    streams: [snap({ collection: 'payments', fromBlock: '1', toBlock: '100', rows: [row(), row('payments', '0x02')] }),
      snap({ collection: 'paymasterDepositEvents', fromBlock: '1', toBlock: '100', rows: [row('paymasterDepositEvents', '0x03', { from: PM, amount: '100' })] }),
      snap({ collection: 'solidarityEvents', fromBlock: '1', toBlock: '100', rows: [row('solidarityEvents', '0x04', { amount: HUGE, paymasterHub: { id: OLD_HUB } })] })] };
}

describe('opaque indexed native entity identity and exact amounts', () => {
  it('projects only serving fields, retaining source and exact 1 wei / large values without a log index', () => {
    const payment = projected(), donation = projected('solidarityEvents', '0x02', { amount: HUGE });
    expect(payment).toEqual({ source: source(), collection: 'payments', entityId: '0x01', chainId: 100, transactionHash: HASH, blockNumber: '40', from: OUTSIDE, to: RETIRED, asset: NATIVE, amountRaw: '1', orgId: ORG, provenance: 'payment-received' });
    expect(payment).not.toHaveProperty('logIndex'); expect(donation).not.toHaveProperty('orgId'); expect(donation.amountRaw).toBe(HUGE);
    expect(donation.to).toBe(HUB); expect(donation.provenance).toBe('donation-received');
  });
  it('keeps equal amounts in the same transaction distinct by entity ID, and deduplicates repeated observations', () => {
    const a = projected(), b = projected('payments', '0x02');
    expect(deduplicateIndexedNativeInflows([a, a, b])).toEqual(knownFact([a, b]));
    expect(deduplicateIndexedNativeInflows([a, { ...a, entityId: '0x01', amountRaw: '01', source: source({ method: 'another-query' }) }])).toEqual(knownFact([a]));
  });
  it('collection and chain are explicit identity dimensions; IDs need not embed tx/log information', () => {
    const a = projected(), deposit = projected('paymasterDepositEvents'), donation = projected('solidarityEvents');
    // The projection correctly requires explicit matching native asset metadata.
    expect(projectIndexedNativeInflow(row(), 'payments', source({ chainId: 42161 }), NATIVE).state).toBe('unknown');
    const chainProjection = projectIndexedNativeInflow(row(), 'payments', source({ chainId: 42161 }), { ...NATIVE, chainId: 42161 });
    expect(chainProjection.state).toBe('known');
    if (chainProjection.state === 'known') expect(deduplicateIndexedNativeInflows([a, deposit, donation, chainProjection.value]).state).toBe('known');
  });
  it.each(['amountRaw', 'blockNumber', 'from', 'to', 'transactionHash', 'orgId', 'decimals'] as const)('conflicting %s on one source entity yields unknown', field => {
    const a = projected(); const b = { ...a };
    if (field === 'amountRaw') b.amountRaw = HUGE;
    if (field === 'blockNumber') b.blockNumber = '41';
    if (field === 'from') b.from = PM;
    if (field === 'to') b.to = PM;
    if (field === 'transactionHash') b.transactionHash = OTHER_HASH;
    if (field === 'orgId') b.orgId = HASH;
    if (field === 'decimals') b.asset = { ...NATIVE, decimals: 6 };
    expect(deduplicateIndexedNativeInflows([a, b])).toMatchObject({ state: 'unknown', code: 'CONFLICTING_INDEXED_EVENT_OBSERVATIONS' });
  });
  it('normalizes case and uint spelling before comparing repeated observations', () => {
    const a = projected('payments', '0xab');
    expect(deduplicateIndexedNativeInflows([a, { ...a, entityId: '0xAB', transactionHash: HASH.toUpperCase().replace('0X', '0x'), blockNumber: '040', amountRaw: '01' }])).toEqual(knownFact([a]));
  });
  it('replicas at another endpoint do not silently become new money', () => {
    const a = projected(), replica = projected('payments', '0x01', {}, source({ endpoint: 'fixture://replica' }));
    expect(deduplicateIndexedNativeInflows([a, replica])).toMatchObject({ state: 'unknown', code: 'AMBIGUOUS_INDEXED_SOURCE_REPRESENTATIONS' });
    const differentNamespace = projected('payments', '0x9901', {}, source({ endpoint: 'fixture://replica' }));
    expect(deduplicateIndexedNativeInflows([a, differentNamespace]).state).toBe('unknown');
  });
  it.each([
    ['payments', { token: TOKEN }], ['payments', { payer: null }], ['payments', { paymentManager: { id: RETIRED } }],
    ['paymasterDepositEvents', { eventType: 'HubDeposit' }], ['paymasterDepositEvents', { from: null }],
    ['solidarityEvents', { eventType: 'FeeCollected' }], ['solidarityEvents', { amount: null }],
    ['payments', { id: '' }], ['payments', { id: '0x1' }], ['payments', { amount: '1.1' }],
    ['payments', { transactionHash: undefined }], ['payments', { receivedAtBlock: '101' }],
  ] as [NativeInflowCollection, IndexedRow][])('missing/mismatched %s fields stay unknown (%j)', (collection, overrides) => {
    expect(projectIndexedNativeInflow(row(collection, '0x01', overrides), collection, source(), NATIVE).state).toBe('unknown');
  });
  it('does not weaken the strict historical log DTO or native/ERC20 provenance boundary', () => {
    expect(deduplicateInflowEvents([{ ...log(), provenance: 'payment-received', asset: NATIVE, logIndex: undefined as any }]).state).toBe('unknown');
    expect(deduplicateIndexedNativeInflows([{ ...projected(), chainId: 42161 }]).state).toBe('unknown');
    expect(deduplicateIndexedNativeInflows([{ ...projected('solidarityEvents'), orgId: ORG }]).state).toBe('unknown');
    expect(projectIndexedNativeInflow(row(), 'payments', source(), USD).state).toBe('unknown');
  });
});

describe('verified global and historical pots in log and indexed classification', () => {
  it('supports actual global hubs without an org or fake Executor kind and retains former hubs', () => {
    const i = input(), pots = snap<readonly HistoricalInflowPot[]>(Object.values(i.pots).flatMap(p => p.data));
    expect(classifyInternalMovement(log('1', { from: PM, to: OLD_HUB }), pots)).toEqual(knownFact(true, pots.source));
    const result = normalizeRecordedInflows({ pots, chunks: i.chunks, fromBlock: i.fromBlock, block: i.block });
    expect(result.externalRecordedTotals).toEqual(knownFact([{ asset: USD, rawAmount: '1000001' }], pots.source));
    expect(result.internalMovements).toHaveLength(1);
  });
  it('combines exact asset totals, canonical native streams and historical global hub classification', () => {
    const i = input(), result = normalizeIndexedRecordedInflows(i);
    expect(result.events).toHaveLength(6); expect(result.internalMovements).toHaveLength(2);
    expect(result.externalRecordedTotals).toEqual(knownFact([{ asset: USD, rawAmount: '1000001' }, { asset: NATIVE, rawAmount: '9007199254740993000000000000000003' }], i.pots['payment-manager'].source));
    expect(result.completeRevenue).toMatchObject({ state: 'unknown', code: 'NATIVE_AND_CAUSAL_COVERAGE_UNPROVEN' });
    expect(result.blockAlignment).toEqual(knownFact(true, i.pots['payment-manager'].source));
    expect(result.sourceEvidence).toHaveLength(8); expect(result.scope).toBe('recorded-gross-events');
  });
  it('all complete empty streams produce known empty recorded totals while native revenue remains unknown', () => {
    const i = input(); Object.values(i.pots).forEach(p => p.data = []); i.chunks[0].data.events = []; i.streams.forEach(s => s.data.rows = []);
    const result = normalizeIndexedRecordedInflows(i);
    expect(result.externalRecordedTotals).toEqual(knownFact([], i.pots['payment-manager'].source)); expect(result.completeRevenue.state).toBe('unknown');
  });
  it('creation cutoff applies at the event block; a future sender is external and a future recipient is unknown', () => {
    const i = input(); i.pots['payment-manager'].data[0].createdAtBlock = '41'; i.chunks[0].data.events = [];
    const result = normalizeIndexedRecordedInflows(i);
    expect(result.internalMovements).toHaveLength(0);
    expect(result.externalRecordedTotals).toEqual(knownFact([{ asset: NATIVE, rawAmount: '9007199254740993000000000000000103' }], i.pots['payment-manager'].source));
    i.pots['paymaster-hub'].data[0].createdAtBlock = '41'; expect(normalizeIndexedRecordedInflows(i).externalRecordedTotals.state).toBe('unknown');
  });
  it.each(['org', 'chain', 'address', 'creation', 'coverage', 'source-kind', 'scoped', 'duplicate', 'pot-kind'] as const)('%s invalid global history cannot classify movements', kind => {
    const i = input(); const history = i.pots['paymaster-hub'];
    if (kind === 'org') (history.data[0] as any).orgId = ORG;
    if (kind === 'chain') history.data[0].chainId = 42161;
    if (kind === 'address') history.data[0].address = ZERO;
    if (kind === 'creation') history.data[0].createdAtBlock = '101';
    if (kind === 'coverage') history.coverage.status = 'incomplete';
    if (kind === 'source-kind') history.source.indexed = false;
    if (kind === 'scoped') history.source.orgId = ORG;
    if (kind === 'duplicate') history.data = [...history.data, history.data[0]];
    if (kind === 'pot-kind') (history.data[0] as any).kind = 'executor';
    expect(normalizeIndexedRecordedInflows(i).externalRecordedTotals.state).toBe('unknown');
  });
  it.each(['missing-stream', 'missing-pots', 'page-unknown', 'wrong-range', 'row-range', 'wrong-chain', 'wrong-hash', 'wrong-endpoint', 'wrong-target', 'wrong-org', 'hash-upgrade', 'log-gap', 'scoped-log'] as const)('%s keeps the combined totals unknown', kind => {
    const i = input();
    if (kind === 'missing-stream') i.streams.pop();
    if (kind === 'missing-pots') delete (i.pots as any).executor;
    if (kind === 'page-unknown') i.streams[0].coverage.status = 'unavailable';
    if (kind === 'wrong-range') i.streams[0].data.fromBlock = '2';
    if (kind === 'row-range') i.streams[0].data.rows = [row('payments', '0x01', { receivedAtBlock: '0' })];
    if (kind === 'wrong-chain') i.streams[0].source.chainId = 42161;
    if (kind === 'wrong-hash') i.streams[0].source.block!.hash = OTHER_HASH;
    if (kind === 'wrong-endpoint') i.streams[0].source.endpoint = 'fixture://other-index';
    if (kind === 'wrong-target') i.streams[0].data.rows = [row('payments', '0x01', { paymentManager: { id: HUB, organization: { id: ORG } } })];
    if (kind === 'wrong-org') i.streams[0].data.rows = [row('payments', '0x01', { paymentManager: { id: RETIRED, organization: { id: HASH } } })];
    if (kind === 'hash-upgrade') { i.block = { number: '100' }; Object.values(i.pots).forEach(p => p.source.block = { number: '100' }); }
    if (kind === 'log-gap') i.chunks[0].data.fromBlock = '2';
    if (kind === 'scoped-log') i.chunks[0].source.contract = PM;
    expect(normalizeIndexedRecordedInflows(i).externalRecordedTotals.state).toBe('unknown');
  });
  it('repeated same stream is idempotent; conflicting complete stream alternatives cannot be unioned', () => {
    const i = input(); i.streams.push(snap({ ...i.streams[0].data }));
    expect(normalizeIndexedRecordedInflows(i).events).toHaveLength(6);
    i.streams[i.streams.length - 1].data.rows = [row('payments', '0x05')];
    expect(normalizeIndexedRecordedInflows(i).externalRecordedTotals).toMatchObject({ state: 'unknown', code: 'CONFLICTING_STREAM_OBSERVATIONS' });
  });
  it('same entity conflicts in a complete stream stay unknown, and collection identities remain distinct', () => {
    const i = input(); i.streams[0].data.rows = [row(), row('payments', '0x01', { amount: '2' })];
    expect(normalizeIndexedRecordedInflows(i).externalRecordedTotals).toMatchObject({ state: 'unknown', code: 'CONFLICTING_INDEXED_EVENT_OBSERVATIONS' });
    i.streams[0].data.rows = []; i.chunks[0].data.events = [];
    i.streams[1].data.rows = [row('paymasterDepositEvents', '0x01')]; i.streams[2].data.rows = [row('solidarityEvents', '0x01')];
    const result = normalizeIndexedRecordedInflows(i);
    expect(result.events).toHaveLength(2); expect(result.externalRecordedTotals).toEqual(knownFact([{ asset: NATIVE, rawAmount: '2' }], i.pots['payment-manager'].source));
  });
  it.each(['native-transfer', 'payment-received', 'erc20-transfer'] as const)('native %s log + indexed representations cannot silently double count', provenance => {
    const i = input(); i.chunks[0].data.events = [log('1', { asset: NATIVE, provenance, amountRaw: '1' })];
    expect(normalizeIndexedRecordedInflows(i).externalRecordedTotals).toMatchObject({ state: 'unknown', code: 'MIXED_NATIVE_EVENT_REPRESENTATIONS' });
  });
});

const fixture = (file: string) => readFileSync(new URL(`./fixtures/core-update/treasury/${file}`, import.meta.url), 'utf8');
const schema = buildSchema(fixture('recorded-inflows-serving-schema.graphql'));
const docs = [documents.FETCH_PAYMASTER_HUB_POTS_PAGE, documents.FETCH_INDEXED_NATIVE_PAYMENTS_PAGE, documents.FETCH_INDEXED_ORG_DEPOSITS_PAGE, documents.FETCH_INDEXED_DONATIONS_PAGE];
describe('canonical serving-schema documents and bounded paginated readers', () => {
  it('pins the new offline projection and the unchanged original fixtures', () => {
    const provenance = JSON.parse(fixture('recorded-inflows-provenance.json'));
    expect(createHash('sha256').update(fixture(provenance.fixture)).digest('hex')).toBe(provenance.sha256);
    expect(provenance.matchingRetainedChains).toEqual([100, 42161]);
    const old = readFileSync(new URL('./fixtures/core-update/serving-queries/schema.graphql', import.meta.url), 'utf8');
    expect(createHash('sha256').update(old).digest('hex')).toBe('470c2b88cfab386f73781d81e8c76151f9b410d6fc46d7f1eec9ccd1ce69d6bf');
    // Existing output entity shapes corroborate the new selections independently.
    const serving = extendSchema(buildSchema(old), parse('extend type _Block_ { timestamp: Int }'));
    for (const name of ['PaymasterHubContract', 'PaymasterDepositEvent', 'SolidarityEvent']) {
      const fields = (schema.getType(name) as any).getFields(), original = (serving.getType(name) as any).getFields();
      for (const [field, value] of Object.entries(fields)) expect(String((value as any).type)).toBe(String(original[field].type));
    }
    const treasury = buildSchema(fixture('serving-schema.graphql'));
    const original = (treasury.getType('Payment') as any).getFields();
    for (const [name, value] of Object.entries((schema.getType('Payment') as any).getFields())) expect(String((value as any).type)).toBe(String(original[name].type));
  });
  it.each(docs)('validates actual scalar positions and same-response metadata (%s)', document => {
    expect(validate(schema, parse(document)).map(e => e.message)).toEqual([]);
    expect(document).toContain('_meta(block: $block)'); expect(document).toContain('orderBy: id, orderDirection: asc');
  });
  it('rejects fabricated logIndex / hub organization and misleading cursor/range scalar types', () => {
    for (const [document, before, after] of [
      [docs[1], 'id payer amount', 'id logIndex payer amount'], [docs[0], 'id createdAtBlock', 'id createdAtBlock organization { id }'],
      [docs[2], '$cursor: Bytes!', '$cursor: String!'], [docs[3], '$fromBlock: BigInt!', '$fromBlock: Int!'],
    ]) expect(validate(schema, parse(document.replace(before, after))).length).toBeGreaterThan(0);
  });
  it.each(nativeCollections)('%s executes unchanged document/variables, proving filters and every terminal page from the same response', async collection => {
    const rows = [row(collection, '0x01'), row(collection, '0x02')];
    const rootValue = { [collection]: ({ where, first, block }: any) => {
      const blockKey = collection === 'payments' ? 'receivedAtBlock' : 'eventAtBlock';
      expect(where).toMatchObject({ [blockKey + '_gte']: '1', [blockKey + '_lte']: '100' }); expect(block).toEqual({ hash: HASH });
      if (collection === 'payments') expect(where.token).toBe(ZERO); else expect(where.eventType).toBe(collection === 'paymasterDepositEvents' ? 'OrgDeposit' : 'DonationReceived');
      return rows.filter(r => String(r.id) > where.id_gt).slice(0, first);
    }, _meta: ({ block }: any) => { expect(block).toEqual({ hash: HASH }); return meta()._meta; } };
    const query = vi.fn(async (document: string, variables: Record<string, unknown>) => {
      const result = await graphql({ schema, source: document, rootValue, variableValues: variables }); expect(result.errors).toBeUndefined();
      return result.data as Record<string, unknown>;
    });
    const result = await readIndexedNativeInflowFacts({ source: source(), collection, fromBlock: '1', query, pageSize: 2, maxPages: 3 });
    expect(query).toHaveBeenCalledTimes(2); expect(query.mock.calls[1][1].cursor).toBe('0x02');
    expect(result.data.rows).toEqual(rows); expect(result.coverage).toMatchObject({ status: 'complete', pages: 2, cursor: '0x02' });
    expect(result.source.block).toEqual(BLOCK);
  });
  it('historical hubs paginate independently through a proven empty terminal page, retaining old instances', async () => {
    const rows = [OLD_HUB, HUB].sort().map(id => ({ id, createdAtBlock: '1' }));
    const query = vi.fn(async (document: string, variables: Record<string, unknown>) => {
      expect(document).toBe(documents.FETCH_PAYMASTER_HUB_POTS_PAGE); expect(variables.block).toEqual({ hash: HASH });
      return { ...meta(), paymasterHubContracts: rows.filter(r => r.id > String(variables.cursor)).slice(0, Number(variables.first)) };
    });
    const result = await readHistoricalPaymasterHubPotFacts({ source: source(), query, pageSize: 1, maxPages: 4 });
    expect(query).toHaveBeenCalledTimes(3); expect(result.coverage.status).toBe('complete'); expect(result.data.map(p => p.address)).toEqual(rows.map(p => p.id));
    expect(result.data.every(p => p.kind === 'paymaster-hub' && !('orgId' in p))).toBe(true);
  });
  it('1000 native rows at the cap stay incomplete; a 1001st row is retained with explicit continuation', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => row('payments', '0x' + (i + 1).toString(16).padStart(8, '0')));
    const query = async (_document: string, variables: Record<string, unknown>) => ({ ...meta(), payments: rows.filter(r => String(r.id) > String(variables.cursor)).slice(0, Number(variables.first)) });
    const options = { source: source(), collection: 'payments' as const, fromBlock: '1', query, pageSize: 1000, maxPages: 1 };
    const capped = await readIndexedNativeInflowFacts(options);
    expect(capped.data.rows).toHaveLength(1000); expect(capped.coverage).toMatchObject({ status: 'incomplete', issues: [{ code: 'PAGE_CAP' }] });
    const complete = await readIndexedNativeInflowFacts({ ...options, maxPages: 2 });
    expect(complete.data.rows).toHaveLength(1001); expect(complete.coverage.status).toBe('complete');
  });
  it.each(['missing-meta', 'wrong-number', 'wrong-hash', 'missing-collection', 'transport', 'graphql-error', 'wrong-range', 'wrong-kind', 'null-amount', 'bad-id', 'future-hub'] as const)('%s cannot yield complete pinned evidence', async kind => {
    const response: Record<string, unknown> = { ...meta(), payments: [], solidarityEvents: [row('solidarityEvents')], paymasterHubContracts: [{ id: HUB, createdAtBlock: '1' }] };
    if (kind === 'missing-meta') delete response._meta;
    if (kind === 'wrong-number') (response._meta as any).block.number = 99;
    if (kind === 'wrong-hash') (response._meta as any).block.hash = OTHER_HASH;
    if (kind === 'missing-collection') delete response.solidarityEvents;
    if (kind === 'graphql-error') response.errors = [{ message: 'fixture error' }];
    if (kind === 'wrong-range') (response.solidarityEvents as any)[0].eventAtBlock = '0';
    if (kind === 'wrong-kind') (response.solidarityEvents as any)[0].eventType = 'FeeCollected';
    if (kind === 'null-amount') (response.solidarityEvents as any)[0].amount = null;
    if (kind === 'bad-id') (response.solidarityEvents as any)[0].id = 'not-bytes';
    if (kind === 'future-hub') (response.paymasterHubContracts as any)[0].createdAtBlock = '101';
    const query = async () => { if (kind === 'transport') throw new Error('fixture transport unavailable'); return response; };
    const options = { source: source(), query, pageSize: 2, maxPages: 2 };
    const result = kind === 'future-hub' ? await readHistoricalPaymasterHubPotFacts(options)
      : await readIndexedNativeInflowFacts({ ...options, collection: 'solidarityEvents', fromBlock: '1' });
    expect(result.coverage.status).not.toBe('complete');
  });
  it('missing proof on terminal native/hub pages retains earlier diagnostics without claiming completion', async () => {
    for (const collection of ['payments', 'paymasterHubContracts'] as const) {
      const query = vi.fn(async (_doc, vars: Record<string, unknown>) => vars.cursor === '0x'
        ? { ...meta(), [collection]: collection === 'payments' ? [row()] : [{ id: HUB, createdAtBlock: '1' }] }
        : { [collection]: [] });
      const options = { source: source(), query, pageSize: 1, maxPages: 2 };
      const result = collection === 'payments' ? await readIndexedNativeInflowFacts({ ...options, collection, fromBlock: '1' }) : await readHistoricalPaymasterHubPotFacts(options);
      expect(result.coverage.status).toBe('incomplete'); expect(result.coverage.issues).toContainEqual({ code: 'BLOCK_EVIDENCE_UNAVAILABLE', id: 'page:2' });
      expect(collection === 'payments' ? (result.data as IndexedNativeInflowStream).rows.length : (result.data as any[]).length).toBe(1);
    }
  });
  it.each([{ pageSize: undefined }, { maxPages: undefined }, { pageSize: 1001 }, { maxPages: 0 }, { pageSize: 1.5 }, { maxPages: Infinity }])('requires explicit sane bounds: %j', async override => {
    const query = vi.fn(async () => meta()); const options = { source: source(), query, pageSize: 2, maxPages: 2, ...override } as any;
    await expect(readHistoricalPaymasterHubPotFacts(options)).rejects.toThrow('EXPLICIT_INFLOW_PAGE_BOUNDS_REQUIRED');
    await expect(readIndexedNativeInflowFacts({ ...options, collection: 'payments', fromBlock: '1' })).rejects.toThrow(); expect(query).not.toHaveBeenCalled();
  });
  it.each([{ indexed: false }, { orgId: ORG }, { contract: HUB }, { account: OUTSIDE }, { snapshot: 'latest' as const }])('rejects non-global or unpinned source %j', async override => {
    await expect(readHistoricalPaymasterHubPotFacts({ source: source(override), query: async () => meta(), pageSize: 2, maxPages: 2 })).rejects.toThrow();
  });
});

describe('additive public browser and declaration boundaries', () => {
  it('exposes the new APIs through the treasury barrel', () => {
    expect(publicTreasury.normalizeIndexedRecordedInflows).toBe(normalizeIndexedRecordedInflows);
    expect(publicTreasury.readIndexedNativeInflowFacts).toBe(readIndexedNativeInflowFacts);
    expect(publicTreasury.normalizeRecordedInflows).toBe(normalizeRecordedInflows);
  });
  it('bundles the actual browser leaf with no Node, transport or optional executor imports', async () => {
    const bundle = await build({ entryPoints: [resolve(__dirname, '../src/treasury/indexed-inflows.ts')], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent' });
    const files = Object.keys(bundle.metafile!.inputs);
    expect(files.some(file => file.endsWith('/treasury/indexed-inflows.ts'))).toBe(true);
    expect(files.filter(file => /(?:viem|permissionless|\/execute\/|graphql-request|node:)/.test(file))).toEqual([]);
    expect(bundle.outputFiles[0].text).toContain('normalizeIndexedRecordedInflows');
  });
});
