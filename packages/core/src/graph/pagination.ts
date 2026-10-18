import { assertPlanScope, assertSourceBlock, assertSourceRef, Coverage, EvidenceIssue, SourceRef, SourceSnapshot } from '../data/facts';

export interface CursorPageRequest {
  cursor: string;
  first: number;
  /** One-based attempted page number. */
  page: number;
}

export interface CursorPage<T> {
  /** Missing/null collection is unavailable evidence, never []. */
  rows?: readonly T[] | null;
  issues?: readonly EvidenceIssue[];
  source?: SourceRef;
  /** Use only if the schema exposes a trustworthy end-of-collection signal. */
  complete?: boolean;
}

export interface CursorDescriptor<T> {
  initial: string;
  fromRow(row: T): string;
  /** Same ordering as the server's strict cursor predicate and orderBy. */
  compare(a: string, b: string): number;
}

export interface CollectCursorPagesOptions<T> {
  source: SourceRef;
  fetchPage(request: CursorPageRequest): Promise<CursorPage<T>>;
  cursor: CursorDescriptor<T>;
  pageSize: number;
  maxPages: number;
  maxRows?: number;
  /** Must be explicitly true before a valid short page proves completion. */
  shortPageMeansComplete: boolean;
  rowKey?: (row: T) => string;
  /** Applied after validating/advancing the UNFILTERED page cursor. */
  include?: (row: T) => boolean;
}

function positiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Bounded enumeration with retained rows and explicit failure evidence. */
export async function collectCursorPages<T>(options: CollectCursorPagesOptions<T>): Promise<SourceSnapshot<readonly T[]>> {
  assertSourceRef(options.source);
  if (!positiveInt(options.pageSize) || !positiveInt(options.maxPages)
    || (options.maxRows !== undefined && !positiveInt(options.maxRows))
    || (options.maxRows === undefined && !Number.isSafeInteger(options.maxPages * options.pageSize))
    || typeof options.cursor.initial !== 'string') throw new Error('Invalid pagination bounds/cursor');
  const rows: T[] = [];
  const receivedKeys: string[] = [];
  const keys = new Set<string>();
  const cursorKeys = new Set<string>();
  const issues: EvidenceIssue[] = [];
  const failedIds: string[] = [];
  let cursor = options.cursor.initial;
  let pages = 0;
  let validPages = 0;
  let complete = false;
  let scanned = 0;
  let source = options.source;

  while (pages < options.maxPages) {
    pages++;
    const pageId = `page:${pages}`;
    let page: CursorPage<T>;
    try {
      page = await options.fetchPage({ cursor, first: options.pageSize, page: pages });
    } catch {
      issues.push({ code: 'PAGE_FAILED', id: pageId });
      failedIds.push(pageId);
      break;
    }
    const pageIssues: EvidenceIssue[] = [...(page?.issues ?? [])];
    if (page?.source) {
      try {
        assertSourceRef(page.source);
        assertPlanScope(page.source, options.source);
        if (page.source.indexed !== options.source.indexed || page.source.snapshot !== options.source.snapshot) throw new Error('source kind');
        const priorBlock = source.block;
        const nextBlock = page.source.block;
        if (priorBlock) assertSourceBlock(nextBlock, priorBlock);
        if (validPages > 0 && Boolean(priorBlock) !== Boolean(nextBlock)) throw new Error('block missing');
        source = page.source;
      } catch {
        pageIssues.push({ code: 'PAGE_SOURCE_MISMATCH', id: pageId });
      }
    }
    if (!Array.isArray(page?.rows)) {
      issues.push(...pageIssues, { code: 'MISSING_COLLECTION', id: pageId });
      failedIds.push(pageId);
      break;
    }
    validPages++;
    if (page.rows.length > options.pageSize) pageIssues.push({ code: 'PAGE_SIZE_EXCEEDED', id: pageId });
    let previous = cursor;
    for (const row of page.rows) {
      if (options.maxRows !== undefined && scanned >= options.maxRows) {
        pageIssues.push({ code: 'ROW_CAP', id: pageId });
        break;
      }
      scanned++;
      try {
        const next = options.cursor.fromRow(row);
        const key = options.rowKey ? options.rowKey(row) : next;
        if (typeof next !== 'string' || !next || typeof key !== 'string' || !key) throw new Error('Invalid row key/cursor');
        const order = options.cursor.compare(next, previous);
        if (!Number.isFinite(order) || order <= 0) pageIssues.push({ code: 'NONADVANCING_CURSOR', id: key });
        if (cursorKeys.has(next) || keys.has(key)) pageIssues.push({ code: 'DUPLICATE_CURSOR_OR_KEY', id: key });
        cursorKeys.add(next);
        previous = next;
        if (!keys.has(key)) {
          keys.add(key);
          receivedKeys.push(key);
          // Retain every decoded unique row, even when this page is incomplete.
          if (!options.include || options.include(row)) rows.push(row);
        }
      } catch {
        pageIssues.push({ code: 'INVALID_ROW', id: pageId });
      }
    }
    cursor = previous;
    if (pageIssues.length) {
      issues.push(...pageIssues);
      failedIds.push(pageId);
      break;
    }
    if (page.complete === true || (page.complete !== false && options.shortPageMeansComplete && page.rows.length < options.pageSize)) {
      complete = true;
      break;
    }
    if (page.rows.length === 0) {
      issues.push({ code: 'COMPLETION_UNPROVEN', id: pageId });
      break;
    }
    if (options.maxRows !== undefined && scanned >= options.maxRows) {
      issues.push({ code: 'ROW_CAP', id: pageId });
      break;
    }
  }
  if (!complete && !issues.length) issues.push({ code: 'PAGE_CAP' });
  const coverage: Coverage = {
    status: complete ? 'complete' : validPages > 0 ? 'incomplete' : 'unavailable',
    receivedKeys, missingIds: [], failedIds, issues, cursor,
    pages, cap: options.maxRows ?? options.maxPages * options.pageSize,
  };
  return { source, data: rows, coverage };
}
