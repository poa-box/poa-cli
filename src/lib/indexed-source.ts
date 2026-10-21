/** CLI host adapter: choose one endpoint, pin a proven index block, and never
 * relabel a fallback endpoint or a requested block as observed evidence. */
import { GraphQLClient } from 'graphql-request';
import { createHash } from 'crypto';
import type { PlanScope, SourceBlock, SourceRef } from '@poa-box/core/data/facts';
import { assertSourceBlock } from '@poa-box/core/data/facts';
import { requireRawUint } from '@poa-box/core/amounts';
import type { ProtocolQuery } from '@poa-box/core/reads/protocol';
import type { DocumentQueryResult } from '@poa-box/core/graph/sources';
import { resolveTransportPlan } from './subgraph';

/** Endpoint identity stays stable without exposing RPC keys in paths, URL user
 * info, query strings, or nonstandard gateway credential formats. */
export function publicSourceEndpoint(endpoint: string): string {
  const digest = createHash('sha256').update(endpoint).digest('hex').slice(0, 20);
  try { const url = new URL(endpoint); return `${url.protocol}//${url.host}/source-${digest}`; }
  catch { return `configured-source:${digest}`; }
}

export interface IndexedSourceOptions extends PlanScope { block?: SourceBlock }
export interface PinnedIndexedSource {
  source: SourceRef;
  query<T>(source: SourceRef, document: string, variables: Record<string, unknown>): Promise<DocumentQueryResult<T>>;
  protocolQuery: ProtocolQuery;
}

export async function createIndexedSource(options: IndexedSourceOptions): Promise<PinnedIndexedSource> {
  const plan = resolveTransportPlan(options.chainId);
  const attempt = plan.attempts[0];
  if (!attempt) throw new Error('INDEXED_ENDPOINT_UNAVAILABLE');
  const endpoint = publicSourceEndpoint(attempt.url);
  const headers = attempt.tier === 'paid' && process.env.GRAPH_API_KEY
    ? { Authorization: `Bearer ${process.env.GRAPH_API_KEY}` } : undefined;
  const client = new GraphQLClient(attempt.url, { headers });
  const variables = options.block ? { block: options.block.hash ? { hash: options.block.hash }
    : { number: Number(requireRawUint(options.block.number, 31)) } } : {};
  let meta: any;
  try { meta = await client.request<any>('query CliIndexedSource($block: Block_height) { _meta(block: $block) { block { number hash timestamp } } }', variables); }
  catch { throw new Error('INDEXED_SOURCE_UNAVAILABLE'); }
  const row = meta?._meta?.block;
  if (row?.number == null || row.hash === undefined) throw new Error('INDEX_BLOCK_UNAVAILABLE');
  const block: SourceBlock = { number: requireRawUint(row.number), ...(row.hash ? { hash: row.hash } : {}),
    // Extra timestamp evidence is opt-in: authority documents intentionally
    // prove number/hash only and must not inherit an unobserved page dimension.
    ...(options.block?.timestamp !== undefined && row.timestamp != null ? { timestamp: requireRawUint(row.timestamp) } : {}) };
  if (options.block) assertSourceBlock(block, options.block);
  const source: SourceRef = { ...options, endpoint, method: options.method ?? 'indexed-snapshot', indexed: true,
    snapshot: 'pinned', block, observedAt: Math.floor(Date.now() / 1000) };
  const request = async <T>(requested: SourceRef, document: string, args: Record<string, unknown>): Promise<T> => {
    if (requested.endpoint !== endpoint || requested.chainId !== options.chainId || !requested.indexed) throw new Error('INDEXED_SOURCE_MISMATCH');
    try { return await client.request<T>(document, args); }
    catch (error: any) {
      // Only bounded GraphQL identifiers and validator grammar survive. The
      // original request, extensions, transport URL and arbitrary text never do.
      const errors = error?.response?.errors;
      const status = error?.response?.status;
      const safe = /^(?:Type `[A-Za-z_][A-Za-z_0-9]*` has no field `[A-Za-z_][A-Za-z_0-9]*`\.?|Cannot query field "[A-Za-z_][A-Za-z_0-9]*"(?: on type "[A-Za-z_][A-Za-z_0-9]*")?\.?)$/;
      if (Number.isInteger(status) && status >= 200 && status < 300 && Array.isArray(errors) && errors.length
        && errors.every(row => typeof row?.message === 'string' && row.message.length <= 256 && safe.test(row.message))) {
        const sanitized = new Error('INDEXED_QUERY_SCHEMA_UNAVAILABLE');
        Object.assign(sanitized, { response: { status, errors: errors.map(row => ({ message: row.message })) } });
        throw sanitized;
      }
      throw new Error('INDEXED_QUERY_UNAVAILABLE');
    }
  };
  const query = async <T>(requested: SourceRef, document: string, args: Record<string, unknown>): Promise<DocumentQueryResult<T>> => {
    try {
      const data = await request<T>(requested, document, args);
      return { source: { ...requested, observedAt: Math.floor(Date.now() / 1000) }, data, issues: [] };
    } catch {
      // Preserve an unavailable observation without credential-bearing transport errors.
      return { source: { ...requested, snapshot: 'unknown', block: undefined }, issues: [{ code: 'INDEXED_QUERY_UNAVAILABLE' }] };
    }
  };
  return { source, query, protocolQuery: (document, variables, source) => request<Record<string, unknown>>(source, document, variables) };
}
