import { ethers } from 'ethers';
import { requireAssetRef, requireRawUint, sumRawAssetAmounts, type AssetRef, type RawAssetAmount } from '../amounts';
import { assertPlanScope, assertSourceBlock, knownFact, requireCompleteSnapshot, unknownFact, type Coverage, type Fact, type SourceBlock, type SourceRef, type SourceSnapshot } from '../data/facts';
import { readIndexedPageFacts, type IndexedRow } from '../reads/protocol';
import type { TreasuryPageOptions } from '../reads/treasury';
import { FETCH_HISTORICAL_POTS_PAGE, FETCH_NATIVE_DEPOSITS_PAGE } from '../graph/documents/inflows';

export interface HistoricalPot { chainId: number; address: string; kind: 'payment-manager' | 'task-manager' | 'executor'; createdAtBlock: string; orgId: string }
export interface RecordedInflowEvent {
  chainId: number; transactionHash: string; logIndex: string; blockNumber: string;
  from: string; to: string; asset: AssetRef; amountRaw: string;
  /** Native traces require explicit host provenance; native receipt events are scoped facts. */
  provenance: 'erc20-transfer' | 'payment-received' | 'native-transfer';
}
export interface InflowEventChunk { fromBlock: string; toBlock: string; events: readonly RecordedInflowEvent[] }
function validateEvent(event: RecordedInflowEvent): void {
  requireAssetRef(event.asset); requireRawUint(event.amountRaw); requireRawUint(event.logIndex); requireRawUint(event.blockNumber);
  ethers.utils.getAddress(event.from); ethers.utils.getAddress(event.to);
  if (event.chainId !== event.asset.chainId || !ethers.utils.isHexString(event.transactionHash, 32)
    || !['erc20-transfer', 'payment-received', 'native-transfer'].includes(event.provenance)) throw new Error('INVALID_INFLOW_EVENT');
  const native = event.asset.address.toLowerCase() === ethers.constants.AddressZero;
  if ((event.provenance === 'erc20-transfer' && native) || (event.provenance === 'native-transfer' && !native)) throw new Error('EVENT_ASSET_PROVENANCE_MISMATCH');
}
export function inflowEventKey(event: RecordedInflowEvent): string {
  validateEvent(event);
  return `${event.chainId}:${event.transactionHash.toLowerCase()}:${requireRawUint(event.logIndex)}`;
}
/** Conflicting observations of one log are unknown, never first-row-wins. */
export function deduplicateInflowEvents(events: readonly RecordedInflowEvent[]): Fact<RecordedInflowEvent[]> {
  try {
    const unique = new Map<string, RecordedInflowEvent>();
    const signature = (event: RecordedInflowEvent) => JSON.stringify([event.blockNumber, event.from.toLowerCase(), event.to.toLowerCase(), event.asset.address.toLowerCase(), event.asset.decimals, requireRawUint(event.amountRaw), event.provenance]);
    for (const event of events) {
      const key = inflowEventKey(event), prior = unique.get(key);
      if (prior && signature(prior) !== signature(event)) throw new Error('CONFLICTING_EVENT_OBSERVATIONS');
      if (!prior) unique.set(key, { ...event, asset: { ...event.asset }, amountRaw: requireRawUint(event.amountRaw) });
    }
    return knownFact([...unique.values()]);
  } catch (error) { return unknownFact(error instanceof Error ? error.message : 'INVALID_INFLOW_EVENT'); }
}
/** Historical pots are retained even when no longer an organization's current module. */
export function classifyInternalMovement(event: RecordedInflowEvent, pots: SourceSnapshot<readonly HistoricalPot[]>): Fact<boolean> {
  try {
    validateEvent(event);
    const history = requireCompleteSnapshot(pots, { scope: { chainId: event.chainId }, snapshot: 'pinned' });
    if (BigInt(event.blockNumber) > BigInt(pots.source.block!.number)) throw new Error('EVENT_AFTER_SNAPSHOT');
    const active = new Set(history.filter(p => {
      if (p.chainId !== event.chainId || !ethers.utils.isHexString(p.orgId, 32)) throw new Error('POT_SCOPE_MISMATCH');
      ethers.utils.getAddress(p.address);
      return BigInt(requireRawUint(p.createdAtBlock)) <= BigInt(event.blockNumber);
    }).map(p => p.address.toLowerCase()));
    return knownFact(active.has(event.from.toLowerCase()) && active.has(event.to.toLowerCase()), pots.source);
  } catch (error) { return unknownFact(error instanceof Error ? error.message : 'POT_HISTORY_UNKNOWN', pots.source); }
}
export interface RecordedInflowsInput {
  pots: SourceSnapshot<readonly HistoricalPot[]>;
  chunks: readonly SourceSnapshot<InflowEventChunk>[];
  /** Requested inclusive scope; chunks must cover it once with no gaps. */
  fromBlock: string; block: SourceBlock;
}
export interface RecordedInflows {
  events: readonly RecordedInflowEvent[];
  externalRecordedTotals: Fact<RawAssetAmount[]>;
  internalMovements: readonly RecordedInflowEvent[];
  /** Recorded gross events do not establish exhaustive native/causal revenue. */
  completeRevenue: Fact<never>;
  sourceEvidence: readonly { source: SourceRef; coverage: Coverage }[];
  blockAlignment: Fact<boolean>;
  scope: 'recorded-gross-events';
}
export function normalizeRecordedInflows(input: RecordedInflowsInput): RecordedInflows {
  const diagnosticEvents = input.chunks.flatMap(chunk => Array.isArray(chunk.data?.events) ? chunk.data.events : []);
  const base: RecordedInflows = { events: diagnosticEvents, internalMovements: [], externalRecordedTotals: unknownFact('INFLOW_EVIDENCE_UNAVAILABLE'),
    completeRevenue: unknownFact('NATIVE_AND_CAUSAL_COVERAGE_UNPROVEN'), sourceEvidence: [input.pots, ...input.chunks].map(snapshot => ({ source: snapshot.source, coverage: snapshot.coverage })),
    blockAlignment: unknownFact('INFLOW_BLOCK_ALIGNMENT_UNPROVEN'), scope: 'recorded-gross-events' };
  try {
    const pots = requireCompleteSnapshot(input.pots, { snapshot: 'pinned', block: input.block });
    const potKeys = new Set<string>();
    for (const pot of pots) {
      const key = `${pot.chainId}:${ethers.utils.getAddress(pot.address).toLowerCase()}`;
      if (pot.chainId !== input.pots.source.chainId || potKeys.has(key) || BigInt(requireRawUint(pot.createdAtBlock)) > BigInt(input.block.number)
        || !ethers.utils.isHexString(pot.orgId, 32)) throw new Error('INVALID_POT_HISTORY');
      potKeys.add(key);
    }
    let next = BigInt(requireRawUint(input.fromBlock));
    const end = BigInt(requireRawUint(input.block.number));
    if (next > end) throw new Error('INVALID_INFLOW_RANGE');
    const chunks = input.chunks.map(snapshot => ({ snapshot, chunk: requireCompleteSnapshot(snapshot, { scope: { chainId: input.pots.source.chainId }, snapshot: 'pinned', block: input.block }) }))
      .sort((a, b) => BigInt(a.chunk.fromBlock) < BigInt(b.chunk.fromBlock) ? -1 : 1);
    const events: RecordedInflowEvent[] = [];
    for (const { snapshot, chunk } of chunks) {
      assertSourceBlock(snapshot.source.block, input.pots.source.block!);
      assertSourceBlock(input.pots.source.block, snapshot.source.block!);
      // Preserve explicit org scope if supplied; never mix an unrelated scoped source.
      if (input.pots.source.orgId) assertPlanScope(snapshot.source, { chainId: input.pots.source.chainId, orgId: input.pots.source.orgId });
      const from = BigInt(requireRawUint(chunk.fromBlock)), to = BigInt(requireRawUint(chunk.toBlock));
      if (from !== next || to < from || to > end) throw new Error('INCOMPLETE_OR_OVERLAPPING_LOG_RANGE');
      next = to + 1n;
      for (const event of chunk.events) {
        validateEvent(event);
        const block = BigInt(event.blockNumber);
        if (event.chainId !== snapshot.source.chainId || block < from || block > to) throw new Error('EVENT_RANGE_OR_CHAIN_MISMATCH');
        events.push(event);
      }
    }
    if (next !== end + 1n) throw new Error('INCOMPLETE_LOG_RANGE');
    const dedup = deduplicateInflowEvents(events);
    if (dedup.state === 'unknown') throw new Error(dedup.code);
    const external: RecordedInflowEvent[] = [], internal: RecordedInflowEvent[] = [];
    for (const event of dedup.value) {
      const recipient = pots.find(p => p.address.toLowerCase() === event.to.toLowerCase());
      if (!recipient || BigInt(recipient.createdAtBlock) > BigInt(event.blockNumber)) throw new Error('EVENT_POT_UNKNOWN');
      const classification = classifyInternalMovement(event, input.pots);
      if (classification.state === 'unknown') throw new Error(classification.code);
      (classification.value ? internal : external).push(event);
    }
    return { ...base, events: dedup.value, internalMovements: internal, blockAlignment: knownFact(true, input.pots.source),
      externalRecordedTotals: knownFact(sumRawAssetAmounts(external.map(event => ({ asset: event.asset, rawAmount: event.amountRaw }))), input.pots.source) };
  } catch (error) { return { ...base, externalRecordedTotals: unknownFact(error instanceof Error ? error.message : 'INFLOW_EVIDENCE_UNAVAILABLE', input.pots.source) }; }
}
/** Each stream is separately paginated and retains its own source/coverage. */
export async function readHistoricalPotFacts(options: TreasuryPageOptions): Promise<Record<HistoricalPot['kind'], SourceSnapshot<readonly HistoricalPot[]>>> {
  if (options.source.orgId || options.source.account || options.source.contract) throw new Error('GLOBAL_HISTORY_SOURCE_REQUIRED');
  const kinds = [['task-manager', 'taskManagers', 'taskCursor'], ['payment-manager', 'paymentManagerContracts', 'paymentCursor'], ['executor', 'executorContracts', 'executorCursor']] as const;
  const entries = await Promise.all(kinds.map(async ([kind, collection, cursorVariable]) => {
    const result = await readIndexedPageFacts({ ...options, document: FETCH_HISTORICAL_POTS_PAGE, collection, initialCursor: '0x',
      variables: { taskCursor: '0x', paymentCursor: '0x', executorCursor: '0x' },
      query: (document, variables, source) => options.query(document, { ...variables, [cursorVariable]: variables.cursor }, source),
      validateRow: row => { ethers.utils.getAddress(row.id as string); requireRawUint(row.createdAtBlock as string); if (!ethers.utils.isHexString((row.organization as IndexedRow)?.id, 32)) throw new Error('POT_ORG_UNKNOWN'); } });
    return [kind, { ...result, data: result.data.map(row => ({ kind, chainId: result.source.chainId, address: String(row.id), createdAtBlock: String(row.createdAtBlock), orgId: String((row.organization as IndexedRow).id) })) }] as const;
  }));
  return { 'task-manager': entries[0][1], 'payment-manager': entries[1][1], executor: entries[2][1] };
}
export function readRecordedNativeDepositFacts(options: TreasuryPageOptions): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  if (options.source.orgId || options.source.account || options.source.contract) throw new Error('GLOBAL_HISTORY_SOURCE_REQUIRED');
  return readIndexedPageFacts({ ...options, document: FETCH_NATIVE_DEPOSITS_PAGE, collection: 'payments', initialCursor: '0x', variables: {}, validateRow: row => {
    if (row.token !== ethers.constants.AddressZero) throw new Error('NATIVE_TOKEN_MISMATCH');
    requireRawUint(row.amount as string); requireRawUint(row.receivedAtBlock as string); ethers.utils.getAddress(row.payer as string);
    if (!ethers.utils.isHexString(row.transactionHash as string, 32)) throw new Error('INVALID_TX');
    ethers.utils.getAddress((row.paymentManager as IndexedRow)?.id as string);
    if (!ethers.utils.isHexString(((row.paymentManager as IndexedRow)?.organization as IndexedRow)?.id, 32)) throw new Error('PAYMENT_ORG_UNKNOWN');
  } });
}
