import { ethers } from 'ethers';
import { requireAssetRef, requireRawUint, sumRawAssetAmounts, type AssetRef, type RawAssetAmount } from '../amounts';
import { assertSourceBlock, assertSourceRef, knownFact, requireCompleteSnapshot, unknownFact,
  type Coverage, type Fact, type SourceBlock, type SourceRef, type SourceSnapshot } from '../data/facts';
import { readIndexedPageFacts, type IndexedRow, type ProtocolQuery } from '../reads/protocol';
import { FETCH_PAYMASTER_HUB_POTS_PAGE, FETCH_INDEXED_NATIVE_PAYMENTS_PAGE, FETCH_INDEXED_ORG_DEPOSITS_PAGE,
  FETCH_INDEXED_DONATIONS_PAGE } from '../graph/documents/inflows';
import { normalizeRecordedInflows, type HistoricalPot, type HistoricalPaymasterHubPot, type HistoricalInflowPot,
  type RecordedInflowEvent, type InflowEventChunk } from './inflows';

export type NativeInflowCollection = 'payments' | 'paymasterDepositEvents' | 'solidarityEvents';
const collections: readonly NativeInflowCollection[] = ['payments', 'paymasterDepositEvents', 'solidarityEvents'];
export interface IndexedNativeInflowEvent {
  source: SourceRef; collection: NativeInflowCollection; entityId: string;
  chainId: number; transactionHash: string; blockNumber: string;
  from: string; to: string; asset: AssetRef; amountRaw: string;
  provenance: 'payment-received' | 'org-deposit' | 'donation-received';
  /** Present only for Payment's actual paymentManager.organization relation. */
  orgId?: string;
}
export interface IndexedNativeInflowStream {
  collection: NativeInflowCollection; fromBlock: string; toBlock: string; rows: readonly IndexedRow[];
}
export interface InflowPageOptions {
  source: SourceRef; query: ProtocolQuery;
  /** Explicit finite limits. A full last page is incomplete, never a total. */
  pageSize: number; maxPages: number;
}
export interface IndexedNativeInflowPageOptions extends InflowPageOptions {
  collection: NativeInflowCollection; fromBlock: string;
}
function globalIndexedSource(source: SourceRef): void {
  assertSourceRef(source);
  if (!source.indexed || source.snapshot !== 'pinned' || source.orgId || source.account || source.contract) throw new Error('GLOBAL_PINNED_INDEXED_SOURCE_REQUIRED');
}
function pageBounds(options: InflowPageOptions): void {
  globalIndexedSource(options.source);
  if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 1000
    || !Number.isSafeInteger(options.maxPages) || options.maxPages < 1
    || !Number.isSafeInteger(options.pageSize * options.maxPages)) throw new Error('EXPLICIT_INFLOW_PAGE_BOUNDS_REQUIRED');
}
function bytesId(id: unknown): string {
  if (typeof id !== 'string' || !/^0x(?:[\da-fA-F]{2})+$/.test(id)) throw new Error('INVALID_INDEXED_ENTITY_ID');
  return id.toLowerCase();
}
function diagnosticCode(error: unknown, fallback: string): string {
  return error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : fallback;
}
function nativeAssetRef(asset: AssetRef, chainId: number): void {
  requireAssetRef(asset);
  if (asset.chainId !== chainId || asset.address.toLowerCase() !== ethers.constants.AddressZero) throw new Error('NATIVE_ASSET_SCOPE_MISMATCH');
}
function eventFields(row: IndexedRow, collection: NativeInflowCollection) {
  if (!collections.includes(collection)) throw new Error('INVALID_NATIVE_INFLOW_COLLECTION');
  const payment = collection === 'payments';
  if (payment ? row.token !== ethers.constants.AddressZero
    : row.eventType !== (collection === 'paymasterDepositEvents' ? 'OrgDeposit' : 'DonationReceived')) throw new Error('NATIVE_EVENT_KIND_MISMATCH');
  const entityId = bytesId(row.id);
  const transactionHash = row.transactionHash;
  if (typeof transactionHash !== 'string' || !ethers.utils.isHexString(transactionHash, 32)) throw new Error('INVALID_INDEXED_TRANSACTION_HASH');
  const from = ethers.utils.getAddress((payment ? row.payer : row.from) as string).toLowerCase();
  const target = row[payment ? 'paymentManager' : 'paymasterHub'] as IndexedRow | undefined;
  const to = ethers.utils.getAddress(target?.id as string).toLowerCase();
  const orgId = payment ? (target?.organization as IndexedRow | undefined)?.id : undefined;
  if (payment && (typeof orgId !== 'string' || !ethers.utils.isHexString(orgId, 32))) throw new Error('PAYMENT_ORG_UNKNOWN');
  return { entityId, transactionHash: transactionHash.toLowerCase(), from, to,
    amountRaw: requireRawUint(row.amount as string), blockNumber: requireRawUint(row[payment ? 'receivedAtBlock' : 'eventAtBlock'] as string),
    provenance: (payment ? 'payment-received' : collection === 'paymasterDepositEvents' ? 'org-deposit' : 'donation-received') as IndexedNativeInflowEvent['provenance'],
    ...(payment ? { orgId: (orgId as string).toLowerCase() } : {}) };
}
/** Projection of actual serving fields. Entity IDs stay opaque; no inferred log
 * index, trace identity or organization for global hub events. */
export function projectIndexedNativeInflow(row: IndexedRow, collection: NativeInflowCollection, source: SourceRef, nativeAsset: AssetRef): Fact<IndexedNativeInflowEvent> {
  try {
    globalIndexedSource(source); nativeAssetRef(nativeAsset, source.chainId);
    const fields = eventFields(row, collection);
    if (BigInt(fields.blockNumber) > BigInt(source.block!.number)) throw new Error('EVENT_AFTER_SNAPSHOT');
    return knownFact({ ...fields, source, collection, chainId: source.chainId, asset: { ...nativeAsset } }, source);
  } catch (error) { return unknownFact(diagnosticCode(error, 'INVALID_INDEXED_NATIVE_ROW'), source); }
}
function validatedEvent(event: IndexedNativeInflowEvent): IndexedNativeInflowEvent {
  const row: IndexedRow = event.collection === 'payments'
    ? { id: event.entityId, token: event.asset.address, payer: event.from, amount: event.amountRaw, receivedAtBlock: event.blockNumber,
      transactionHash: event.transactionHash, paymentManager: { id: event.to, organization: { id: event.orgId } } }
    : { id: event.entityId, eventType: event.collection === 'paymasterDepositEvents' ? 'OrgDeposit' : 'DonationReceived',
      from: event.from, amount: event.amountRaw, eventAtBlock: event.blockNumber, transactionHash: event.transactionHash, paymasterHub: { id: event.to } };
  const projected = projectIndexedNativeInflow(row, event.collection, event.source, event.asset);
  if (projected.state === 'unknown') throw new Error(projected.code);
  if (event.chainId !== event.source.chainId || projected.value.provenance !== event.provenance
    || (event.collection !== 'payments' && event.orgId !== undefined)) throw new Error('INDEXED_EVENT_SCOPE_MISMATCH');
  return projected.value;
}
function entityKey(event: IndexedNativeInflowEvent): string {
  return JSON.stringify([event.chainId, event.source.endpoint, event.collection, event.entityId]);
}
function eventSignature(event: IndexedNativeInflowEvent): string {
  return JSON.stringify([event.transactionHash, event.blockNumber, event.from, event.to, event.asset.address.toLowerCase(),
    event.asset.decimals, event.amountRaw, event.provenance, event.orgId]);
}
/** Distinct entity IDs remain distinct even in one transaction with equal amounts.
 * Multiple indexed endpoints on one chain cannot be unioned as independent
 * new money: entity namespaces may differ, and no cross-source link is proven. */
export function deduplicateIndexedNativeInflows(events: readonly IndexedNativeInflowEvent[]): Fact<IndexedNativeInflowEvent[]> {
  try {
    const unique = new Map<string, IndexedNativeInflowEvent>();
    const origins = new Map<string, string>();
    for (const observation of events) {
      const event = validatedEvent(observation), key = entityKey(event);
      const replicaKey = String(event.chainId);
      const endpoint = origins.get(replicaKey);
      if (endpoint !== undefined && endpoint !== event.source.endpoint) throw new Error('AMBIGUOUS_INDEXED_SOURCE_REPRESENTATIONS');
      origins.set(replicaKey, event.source.endpoint);
      const prior = unique.get(key);
      if (prior && eventSignature(prior) !== eventSignature(event)) throw new Error('CONFLICTING_INDEXED_EVENT_OBSERVATIONS');
      if (!prior) unique.set(key, event);
    }
    return knownFact([...unique.values()]);
  } catch (error) { return unknownFact(diagnosticCode(error, 'INVALID_INDEXED_NATIVE_EVENT')); }
}
export async function readHistoricalPaymasterHubPotFacts(options: InflowPageOptions): Promise<SourceSnapshot<readonly HistoricalPaymasterHubPot[]>> {
  pageBounds(options);
  const result = await readIndexedPageFacts({ ...options, document: FETCH_PAYMASTER_HUB_POTS_PAGE, collection: 'paymasterHubContracts',
    variables: {}, initialCursor: '0x', validateRow: row => {
      const address = ethers.utils.getAddress(row.id as string);
      if (address === ethers.constants.AddressZero || BigInt(requireRawUint(row.createdAtBlock as string)) > BigInt(options.source.block!.number)) throw new Error('INVALID_GLOBAL_POT');
    } });
  return { ...result, data: result.data.map(row => ({ kind: 'paymaster-hub', chainId: result.source.chainId,
    address: String(row.id), createdAtBlock: String(row.createdAtBlock) })) };
}
export async function readIndexedNativeInflowFacts(options: IndexedNativeInflowPageOptions): Promise<SourceSnapshot<IndexedNativeInflowStream>> {
  pageBounds(options);
  const fromBlock = requireRawUint(options.fromBlock), toBlock = requireRawUint(options.source.block!.number);
  if (!collections.includes(options.collection) || BigInt(fromBlock) > BigInt(toBlock)) throw new Error('INVALID_INDEXED_INFLOW_RANGE_OR_COLLECTION');
  const document = options.collection === 'payments' ? FETCH_INDEXED_NATIVE_PAYMENTS_PAGE
    : options.collection === 'paymasterDepositEvents' ? FETCH_INDEXED_ORG_DEPOSITS_PAGE : FETCH_INDEXED_DONATIONS_PAGE;
  const result = await readIndexedPageFacts({ ...options, document, collection: options.collection, initialCursor: '0x', variables: { fromBlock, toBlock },
    validateRow: row => {
      const fields = eventFields(row, options.collection);
      if (BigInt(fields.blockNumber) < BigInt(fromBlock) || BigInt(fields.blockNumber) > BigInt(toBlock)) throw new Error('EVENT_RANGE_MISMATCH');
    } });
  return { ...result, data: { collection: options.collection, fromBlock, toBlock, rows: result.data } };
}

export type HistoricalInflowPotFacts = Record<HistoricalPot['kind'], SourceSnapshot<readonly HistoricalPot[]>> & {
  'paymaster-hub': SourceSnapshot<readonly HistoricalPaymasterHubPot[]>;
};
export interface IndexedRecordedInflowsInput {
  pots: HistoricalInflowPotFacts;
  /** ERC20 Transfer logs only. Native log/trace representations must not be
   * mixed with indexed native entity rows without an independent identity link. */
  chunks: readonly SourceSnapshot<InflowEventChunk>[];
  streams: readonly SourceSnapshot<IndexedNativeInflowStream>[];
  nativeAsset: AssetRef; fromBlock: string; block: SourceBlock;
}
export interface IndexedRecordedInflows {
  events: readonly (RecordedInflowEvent | IndexedNativeInflowEvent)[];
  internalMovements: readonly (RecordedInflowEvent | IndexedNativeInflowEvent)[];
  externalRecordedTotals: Fact<RawAssetAmount[]>;
  completeRevenue: Fact<never>; blockAlignment: Fact<boolean>;
  sourceEvidence: readonly { source: SourceRef; coverage: Coverage }[];
  scope: 'recorded-gross-events';
}
/** Combines complete historical pot streams, ERC20 ranges and the three
 * disjoint canonical recorded native streams. No traces or revenue inference. */
export function normalizeIndexedRecordedInflows(input: IndexedRecordedInflowsInput): IndexedRecordedInflows {
  const histories = Object.values(input.pots);
  const base: IndexedRecordedInflows = { events: [], internalMovements: [], externalRecordedTotals: unknownFact('INFLOW_EVIDENCE_UNAVAILABLE'),
    completeRevenue: unknownFact('NATIVE_AND_CAUSAL_COVERAGE_UNPROVEN'), blockAlignment: unknownFact('INFLOW_BLOCK_ALIGNMENT_UNPROVEN'),
    sourceEvidence: [...histories, ...input.chunks, ...input.streams].map(({ source, coverage }) => ({ source, coverage })), scope: 'recorded-gross-events' };
  try {
    const source = input.pots['payment-manager'].source;
    globalIndexedSource(source); nativeAssetRef(input.nativeAsset, source.chainId);
    const from = BigInt(requireRawUint(input.fromBlock)), to = BigInt(requireRawUint(input.block.number));
    if (from > to) throw new Error('INVALID_INDEXED_INFLOW_RANGE_OR_COLLECTION');
    const aligned = (snapshot: SourceSnapshot<unknown>, indexed: boolean) => {
      requireCompleteSnapshot(snapshot, { scope: { chainId: source.chainId, endpoint: indexed ? source.endpoint : undefined }, indexed, snapshot: 'pinned', block: input.block });
      assertSourceBlock(snapshot.source.block, source.block!); assertSourceBlock(source.block, snapshot.source.block!);
      if (indexed) globalIndexedSource(snapshot.source);
      else if (snapshot.source.orgId || snapshot.source.account || snapshot.source.contract) throw new Error('GLOBAL_LOG_SOURCE_REQUIRED');
    };
    const pots: HistoricalInflowPot[] = [];
    for (const kind of ['payment-manager', 'task-manager', 'executor', 'paymaster-hub'] as const) {
      const history = input.pots[kind]; aligned(history, true);
      for (const pot of history.data) {
        if (pot.kind !== kind) throw new Error('POT_COLLECTION_MISMATCH');
        pots.push(pot);
      }
    }
    const combined: SourceSnapshot<readonly HistoricalInflowPot[]> = { source, data: pots, coverage: {
      status: 'complete', receivedKeys: pots.map(p => `${p.kind}:${p.address.toLowerCase()}`), missingIds: [], failedIds: [], issues: [] } };
    for (const chunk of input.chunks) {
      aligned(chunk, false);
      if (chunk.data.events.some(event => event.provenance !== 'erc20-transfer' || event.asset.address.toLowerCase() === ethers.constants.AddressZero)) throw new Error('MIXED_NATIVE_EVENT_REPRESENTATIONS');
    }
    // Reuse the unchanged strict log/range/dedup contract, with additive global pots.
    const logs = normalizeRecordedInflows({ pots: combined, chunks: input.chunks, fromBlock: input.fromBlock, block: input.block });
    if (logs.externalRecordedTotals.state === 'unknown') throw new Error(logs.externalRecordedTotals.code);
    const nativeEvents: IndexedNativeInflowEvent[] = [], streamSignatures = new Map<NativeInflowCollection, string>();
    for (const stream of input.streams) {
      aligned(stream, true);
      if (!collections.includes(stream.data.collection) || BigInt(requireRawUint(stream.data.fromBlock)) !== from
        || BigInt(requireRawUint(stream.data.toBlock)) !== to) throw new Error('INDEXED_STREAM_RANGE_MISMATCH');
      const projected = stream.data.rows.map(row => {
        const event = projectIndexedNativeInflow(row, stream.data.collection, stream.source, input.nativeAsset);
        if (event.state === 'unknown') throw new Error(event.code);
        if (BigInt(event.value.blockNumber) < from || BigInt(event.value.blockNumber) > to) throw new Error('EVENT_RANGE_MISMATCH');
        return event.value;
      });
      const dedup = deduplicateIndexedNativeInflows(projected);
      if (dedup.state === 'unknown') throw new Error(dedup.code);
      const signature = JSON.stringify(dedup.value.map(e => [entityKey(e), eventSignature(e)]).sort((a, b) => a[0].localeCompare(b[0])));
      const prior = streamSignatures.get(stream.data.collection);
      if (prior !== undefined && prior !== signature) throw new Error('CONFLICTING_STREAM_OBSERVATIONS');
      streamSignatures.set(stream.data.collection, signature); nativeEvents.push(...dedup.value);
    }
    if (collections.some(c => !streamSignatures.has(c))) throw new Error('MISSING_NATIVE_INFLOW_STREAM');
    const dedup = deduplicateIndexedNativeInflows(nativeEvents);
    if (dedup.state === 'unknown') throw new Error(dedup.code);
    const internal: IndexedNativeInflowEvent[] = [], external: IndexedNativeInflowEvent[] = [];
    for (const event of dedup.value) {
      const target = pots.find(p => p.address.toLowerCase() === event.to);
      if (!target || target.kind !== (event.collection === 'payments' ? 'payment-manager' : 'paymaster-hub')
        || BigInt(target.createdAtBlock) > BigInt(event.blockNumber)
        || (target.kind === 'payment-manager' && target.orgId.toLowerCase() !== event.orgId)) throw new Error('EVENT_POT_BINDING_MISMATCH');
      const sender = pots.find(p => p.address.toLowerCase() === event.from && BigInt(p.createdAtBlock) <= BigInt(event.blockNumber));
      (sender ? internal : external).push(event);
    }
    return { ...base, events: [...logs.events, ...dedup.value], internalMovements: [...logs.internalMovements, ...internal],
      externalRecordedTotals: knownFact(sumRawAssetAmounts([...logs.externalRecordedTotals.value,
        ...external.map(event => ({ asset: event.asset, rawAmount: event.amountRaw }))]), source), blockAlignment: knownFact(true, source) };
  } catch (error) { return { ...base, externalRecordedTotals: unknownFact(diagnosticCode(error, 'INVALID_INDEXED_INFLOW_EVIDENCE')) }; }
}
