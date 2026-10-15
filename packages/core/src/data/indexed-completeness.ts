import { assertPlanScope, assertSourceBlock, assertSourceRef, type Coverage, type SourceRef, type SourceSnapshot } from './facts';
import type { ProtocolQuery } from '../reads/protocol';
import { readIndexedSingletonFacts, type IndexedRow } from '../reads/protocol';

/** Explicit finite bounds for indexed totals. These reads never fall back to RPC. */
export interface IndexedTotalOptions {
  source: SourceRef;
  query: ProtocolQuery;
  pageSize: number;
  maxPages: number;
}

export function requireIndexedTotalOptions(options: IndexedTotalOptions, accountScoped = false): void {
  const { source } = options;
  assertSourceRef(source);
  if (!source.indexed || source.snapshot !== 'pinned' || !source.contract
    || (accountScoped ? !source.account : source.account !== undefined)) throw new Error('PINNED_INDEXED_TOTAL_SCOPE_REQUIRED');
  if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 1000
    || !Number.isSafeInteger(options.maxPages) || options.maxPages < 1
    || !Number.isSafeInteger(options.pageSize * options.maxPages)) throw new Error('EXPLICIT_INDEXED_TOTAL_BOUNDS_REQUIRED');
}

/** Graph deployment/error evidence is checked on every response, including the
 * terminal empty page. The ordinary reader independently verifies block proof. */
export function checkedIndexedTotalQuery(query: ProtocolQuery): ProtocolQuery {
  let deployment: string | undefined;
  return async (document, variables, source) => {
    const result = await query(document, variables, source);
    if (result?.errors != null && (!Array.isArray(result.errors) || result.errors.length)) throw new Error('INDEX_QUERY_FAILED');
    const meta = result?._meta as { deployment?: string; hasIndexingErrors?: boolean } | undefined;
    if (meta?.hasIndexingErrors !== false || typeof meta.deployment !== 'string' || !meta.deployment) throw new Error('INDEX_HEALTH_UNPROVEN');
    if (deployment !== undefined && deployment !== meta.deployment) throw new Error('INDEX_DEPLOYMENT_CHANGED');
    deployment = meta.deployment;
    return result;
  };
}

/** Preserve each stream's diagnostics and compare observed block proof in both
 * directions. A caller's requested block never attests a failed response. */
export function indexedTotalCoverage(streams: Readonly<Record<string, SourceSnapshot<unknown>>>, extraIssues: readonly { code: string; id?: string }[] = []): Coverage {
  const entries = Object.entries(streams);
  const issues = [...extraIssues];
  const receivedKeys: string[] = [], missingIds: string[] = [], failedIds: string[] = [];
  let pages = 0, cap = 0;
  const reference = entries.find(([, snapshot]) => snapshot.source.snapshot === 'pinned')?.[1].source;
  for (const [name, snapshot] of entries) {
    const coverage = snapshot.coverage;
    issues.push(...coverage.issues.map(issue => ({ ...issue, id: `${name}:${issue.id ?? 'source'}` })));
    receivedKeys.push(...coverage.receivedKeys.map(id => `${name}:${id}`));
    missingIds.push(...coverage.missingIds.map(id => `${name}:${id}`));
    failedIds.push(...coverage.failedIds.map(id => `${name}:${id}`));
    if (coverage.status !== 'complete') issues.push({ code: 'INCOMPLETE_INDEXED_STREAM', id: name });
    pages += coverage.pages ?? 0; cap += coverage.cap ?? 0;
    try {
      if (!reference || snapshot.source.snapshot !== 'pinned') throw new Error('Unproven source');
      assertPlanScope(snapshot.source, reference);
      assertSourceBlock(snapshot.source.block, reference.block!);
      assertSourceBlock(reference.block, snapshot.source.block!);
    } catch { issues.push({ code: 'INDEXED_STREAM_SOURCE_MISMATCH', id: name }); }
  }
  return { status: issues.length || missingIds.length || failedIds.length
    ? entries.every(([, snapshot]) => snapshot.coverage.status === 'unavailable') ? 'unavailable' : 'incomplete' : 'complete',
  receivedKeys, missingIds, failedIds, issues, pages, cap };
}

export function indexedTotalIssue(error: unknown): { code: string } {
  const message = error instanceof Error ? error.message : '';
  return { code: /^[A-Z][A-Z_0-9]+$/.test(message) ? message : 'INVALID_INDEXED_TOTAL_EVIDENCE' };
}

/** Adapt a singular existing Graph field to the foundation's singleton checker.
 * Missing fields stay missing; an explicit null stays an empty singleton. */
export async function readIndexedTotalState(options: IndexedTotalOptions, document: string, variables: Record<string, unknown>, field: string, id: string): Promise<SourceSnapshot<IndexedRow | null>> {
  const result = await readIndexedSingletonFacts(options.source, async (query, args, source) => {
    const response = await options.query(query, args, source);
    return { ...response, stateRows: response[field] === undefined ? undefined : response[field] === null ? [] : [response[field]] };
  }, document, variables, ['stateRows'], { stateRows: id });
  return { ...result, data: result.data[field] as IndexedRow ?? null };
}
