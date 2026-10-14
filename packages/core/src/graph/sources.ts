import { assertCoverage, assertSourceBlock, assertSourceRef, Coverage, EvidenceIssue, Fact, knownFact, SourceRef, SourceSnapshot, unknownFact } from '../data/facts';
import { requireRawUint } from '../amounts';
export type { SourceSnapshot } from '../data/facts';

export type SourceResult<T> =
  | { status: 'fulfilled'; snapshot: SourceSnapshot<readonly T[]> }
  | { status: 'rejected'; source: SourceRef; code: string };

export interface SourceReduction<T> {
  data: readonly T[];
  sources: readonly SourceSnapshot<readonly T[]>[];
  coverage: Coverage;
  /** Independent sources are explicitly unknown, never implicitly aligned. */
  blockAlignment: Fact<readonly { chainId: number; number: string; hash?: string }[]>;
}

/** Request identity excludes observation time/block; provenance stays on each result. */
export function sourceIdentityKey(source: SourceRef): string {
  assertSourceRef(source);
  const scope = (value?: string): string | null => value === undefined ? null : /^0x[\da-f]+$/i.test(value) ? value.toLowerCase() : value;
  return JSON.stringify([
    source.chainId, source.endpoint, source.method, scope(source.orgId), scope(source.contract), scope(source.account),
    Object.entries(source.contracts ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, address]) => [key, scope(address)]),
    source.indexed, source.snapshot,
  ]);
}

/** Pure reduction. Caller supplies the exact product/source subset, never NETWORKS. */
export function reduceSourceResults<T>(
  expected: readonly SourceRef[],
  results: readonly SourceResult<T>[],
  options: { blockAlignment: 'independent' | 'same-chain-block' },
): SourceReduction<T> {
  if (!options || !['independent', 'same-chain-block'].includes(options.blockAlignment)) throw new Error('Explicit block alignment policy required');
  const expectedKeys = expected.map(sourceIdentityKey);
  const expectedSet = new Set(expectedKeys);
  const receivedKeys: string[] = [];
  const failedIds: string[] = [];
  const issues: EvidenceIssue[] = [];
  const sources: SourceSnapshot<readonly T[]>[] = [];
  const data: T[] = [];
  if (expectedSet.size !== expectedKeys.length) issues.push({ code: 'DUPLICATE_EXPECTED_SOURCE' });
  for (const result of results) {
    const source = result.status === 'fulfilled' ? result.snapshot.source : result.source;
    const key = sourceIdentityKey(source);
    if (!expectedSet.has(key)) { issues.push({ code: 'UNEXPECTED_SOURCE', id: key }); continue; }
    if (receivedKeys.includes(key)) { issues.push({ code: 'DUPLICATE_SOURCE', id: key }); continue; }
    receivedKeys.push(key);
    if (result.status === 'rejected') {
      failedIds.push(key);
      issues.push({ code: result.code || 'SOURCE_FAILED', id: key });
      continue;
    }
    const snapshot = result.snapshot;
    sources.push(snapshot);
    data.push(...snapshot.data);
    const coverage = snapshot.coverage;
    assertCoverage(coverage);
    if (coverage.status !== 'complete' || coverage.missingIds.length || coverage.failedIds.length || coverage.issues.length
      || new Set(coverage.receivedKeys).size !== coverage.receivedKeys.length
      || (coverage.expectedKeys !== undefined && new Set(coverage.expectedKeys).size !== coverage.expectedKeys.length)
      || (coverage.expectedKeys ?? []).some(id => !coverage.receivedKeys.includes(id))) {
      failedIds.push(key);
      issues.push({ code: 'INCOMPLETE_SOURCE', id: key }, ...coverage.issues);
    }
    const requested = expected[expectedKeys.indexOf(key)].block;
    if (requested) {
      try { assertSourceBlock(source.block, requested); }
      catch {
        failedIds.push(key);
        issues.push({ code: 'SOURCE_BLOCK_MISMATCH', id: key });
      }
    }
  }
  const missingIds = expectedKeys.filter(key => !receivedKeys.includes(key));
  let blockAlignment: SourceReduction<T>['blockAlignment'] = unknownFact('INDEPENDENT_SOURCES');
  if (options.blockAlignment === 'same-chain-block') {
    const blocks = new Map<number, { chainId: number; number: string; hash?: string }>();
    let aligned = !issues.length && !missingIds.length && sources.length > 0;
    for (const { source } of sources) {
      if (!source.block || source.snapshot !== 'pinned') { aligned = false; continue; }
      const block = { chainId: source.chainId, number: requireRawUint(source.block.number), hash: source.block.hash?.toLowerCase() };
      const previous = blocks.get(source.chainId);
      if (previous && (previous.number !== block.number || previous.hash !== block.hash)) aligned = false;
      blocks.set(source.chainId, block);
    }
    blockAlignment = aligned ? knownFact([...blocks.values()]) : unknownFact('BLOCK_ALIGNMENT_UNPROVEN');
    if (!aligned) issues.push({ code: 'BLOCK_ALIGNMENT_UNPROVEN' });
  }
  return {
    data, sources, blockAlignment,
    coverage: {
      status: issues.length || missingIds.length ? sources.some(item => item.coverage.status !== 'unavailable') ? 'incomplete' : 'unavailable' : 'complete',
      expectedKeys, receivedKeys, missingIds, failedIds: [...new Set(failedIds)], issues,
    },
  };
}

export interface QueryEnvelope<T> {
  data?: T | null;
  errors?: readonly { extensions?: { code?: string } }[];
  /** Apollo errorPolicy all / combined network error. */
  error?: unknown;
}

export interface DocumentQueryResult<T> {
  source: SourceRef;
  data?: T;
  issues: readonly EvidenceIssue[];
}

export interface DocumentQueryAdapterOptions<Document, Client> {
  parse(document: string): Document;
  createClient(endpoint: string): Client;
  execute<T>(client: Client, request: { document: Document; variables?: Record<string, unknown>; source: SourceRef }): Promise<QueryEnvelope<T>>;
}

/** Inject Apollo (or another parsed-document client). No framework/runtime dependency. */
export function createDocumentQueryAdapter<Document, Client>(options: DocumentQueryAdapterOptions<Document, Client>): {
  query<T>(source: SourceRef, document: string, variables?: Record<string, unknown>): Promise<DocumentQueryResult<T>>;
} {
  const documents = new Map<string, Document>();
  const clients = new Map<string, Client>();
  return {
    async query<T>(source: SourceRef, document: string, variables?: Record<string, unknown>): Promise<DocumentQueryResult<T>> {
      assertSourceRef(source);
      try {
        if (!documents.has(document)) documents.set(document, options.parse(document));
        if (!clients.has(source.endpoint)) clients.set(source.endpoint, options.createClient(source.endpoint));
        const result = await options.execute<T>(clients.get(source.endpoint)!, { document: documents.get(document)!, variables, source });
        const issues: EvidenceIssue[] = (result?.errors ?? []).map(error => ({ code: error.extensions?.code || 'GRAPHQL_ERROR' }));
        if (result?.error) issues.push({ code: 'QUERY_FAILED' });
        if (result?.data === null || result?.data === undefined) issues.push({ code: 'MISSING_DATA' });
        return { source, ...(result?.data !== null && result?.data !== undefined ? { data: result.data } : {}), issues };
      } catch {
        return { source, issues: [{ code: 'QUERY_FAILED' }] };
      }
    },
  };
}

/** Honest structural seam; GraphClient private fields are irrelevant to injection. */
export interface RawQueryClient {
  query<T = unknown>(document: string, variables?: Record<string, any>, chainId?: number): Promise<T>;
  queryUrl<T = unknown>(endpoint: string, document: string, variables?: Record<string, any>): Promise<T>;
}
