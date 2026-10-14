import { describe, expect, it } from 'vitest';
import { buildSchema, Kind, parse, validate } from 'graphql';
import { readFileSync } from 'node:fs';
import { SourceRef, requireCompleteSnapshot } from '../src/data/facts';
import { createDocumentQueryAdapter, DocumentQueryResult } from '../src/graph/sources';
import { AuthoritySnapshotQuery, authorityAccountMembershipFacts, readAuthoritySnapshot } from '../src/reads/authority';
import * as docs from '../src/graph/documents/authority';

// Independently observed serving block and scalar shapes (2026-10-10).
// The mock returns these constants, never values copied from the request.
const NUMBER = 48676579;
const HASH = '0xbbf4f665cb311693dadc9119f7707d0a6a126dea44295c617408f090452ac383';
const OTHER_HASH = `0x${'ae'.repeat(32)}`;
const ORG = '0x263b2b29f392647f0fb8ddbb26f099e812ab4ba2777e5e07b906277164181f6b';
const AUTH = '0x11a6a93ca42ae9c9f74af492362d1d7a8b2b0449';
const USER = '0x477e3bc9b7a80f53dceee3c2594d0e226046ef08';
const VOUCHER = '0xa6f4d9f44dd980b7168d829d5f74c2b00a46b2c9';
const ROLE = '1858869350675264688021600333922928388425107375208136503640312512513';
const GROUP = '1858869350675264688021600333922928388425107375208136503640312512514';
const KEY = '0x00b1374e979696384299a436b639bfb386104ff81e9fcbb4e053131135cd52e1';
const CTX = `0x${'00'.repeat(32)}`;
const source: SourceRef = { chainId: 100, orgId: ORG, contract: AUTH, endpoint: 'fixture://authority-serving', method: 'authority', indexed: true, snapshot: 'pinned', block: { number: String(NUMBER), hash: HASH } };
const pages = {
  subjects: docs.FETCH_AUTHORITY_SUBJECTS_PAGE,
  subjectMemberships: docs.FETCH_AUTHORITY_MEMBERSHIPS_PAGE,
  groupCompositions: docs.FETCH_AUTHORITY_GROUP_EDGES_PAGE,
  permRows: docs.FETCH_AUTHORITY_PERMS_PAGE,
  accessRules: docs.FETCH_AUTHORITY_RULES_PAGE,
  subjectVouchRecords: docs.FETCH_AUTHORITY_VOUCHES_PAGE,
  pendingActions: docs.FETCH_AUTHORITY_PENDING_PAGE,
};
type Field = keyof typeof pages;
interface Call { source: SourceRef; document: string; variables: Record<string, unknown>; field: Field | 'state'; page: number }
const clone = <T>(data: T): T => JSON.parse(JSON.stringify(data));

function fixture(change?: (data: any, call: Call) => void) {
  const role = { id: ROLE, subjectId: ROLE, kind: 'Role', name: 'Bounty Reviewer', defaultAllow: false, maxMembers: 5, memberCount: 1, activeMemberCount: 1,
    createdAt: '1788538875', metadataCID: '0x87618150330f09828bfb029133c15a363752e31a396dcaab888c371b9cd77e37', imageURI: null,
    isLegacyAdopted: false, createdAtBlock: '48079390', lastUpdatedAt: '1788636040',
    vouchConfig: { id: ROLE, quorum: 1, epoch: '0', voucherSubjectId: GROUP, configuredAt: '1787859150', lastUpdatedAt: '1787859150' }, managerConfig: null };
  const group = { ...role, id: GROUP, subjectId: GROUP, kind: 'Group', name: null, maxMembers: 0, memberCount: 0, activeMemberCount: 0, vouchConfig: null };
  const rule = { id: 'rule-1', kind: 'Grant', author: 'Governance', delegable: false, sticky: true, setAt: '1788538875', clearedAt: null, managerSubject: null };
  const membership = { id: 'membership-1', user: USER, userUsername: 'e2e_burner', accepted: true, acceptedAt: '1788538875', seededWhilePaused: false,
    eligible: true, isMember: true, claimable: false, ruleKind: 'Grant', eligibilitySource: 'ExplicitGrant', emailVerified: false,
    vouchCount: 0, vouchEpoch: '0', vouchMet: false, firstSeenAt: '1788538875', lastUpdatedAt: '1788636040', subject: role, rule, pendingAction: null };
  const pending = { id: 'pending-1', pendingId: '9007199254740993', action: 'Offer', status: 'Pending', actor: USER, user: VOUCHER,
    actorUsername: 'e2e_burner', activatesAt: '1788636040', createdAt: '1788538875', resolvedAt: null, cancelledBy: null, transactionHash: OTHER_HASH, subject: role };
  const vouch = { id: 'vouch-1', subject: role, user: USER, voucher: VOUCHER, voucherUsername: null, active: true, epoch: '0', seeded: false,
    vouchedAt: '1787864075', revokedAt: null, config: role.vouchConfig };
  const rows: Record<Field, any[]> = {
    subjects: [role, group],
    subjectMemberships: [membership, { ...membership, id: 'membership-2', user: VOUCHER, accepted: false, acceptedAt: null, ruleKind: 'None', rule: { ...rule, kind: 'None', sticky: false, clearedAt: '1788636040' } }],
    groupCompositions: [{ id: 'edge-1', groupSubjectId: GROUP, roleSubjectId: ROLE, isActive: true, group, role }, { id: 'edge-2', groupSubjectId: GROUP, roleSubjectId: ROLE, isActive: false, group, role }],
    // Independent on-chain word: EXISTS (bit255) + raw1. Keep every digit.
    permRows: [{ id: 'permission-1', subject: role, permKey: KEY, ctx: CTX, word: '57896044618658097711785492504343953926634992332820282019728792003956564819969', value: '1', exists: true, inheritGlobal: false },
      { id: 'permission-2', subject: group, permKey: KEY, ctx: CTX, word: '0', value: '0', exists: false, inheritGlobal: false }],
    accessRules: [{ ...rule, id: 'rule-1', subject: role, user: USER }, { ...rule, id: 'rule-2', subject: role, user: VOUCHER, kind: 'None', sticky: false, clearedAt: '1788636040' }],
    subjectVouchRecords: [vouch, { ...vouch, id: 'vouch-2', epoch: '1' }],
    pendingActions: [pending, { ...pending, id: 'pending-2', pendingId: '9007199254740994', action: 'Grant', status: 'Finalized', resolvedAt: '1788636040' }],
  };
  const authority = { id: AUTH, isRouterBound: true, cutoverAt: '1787859040', paused: false, executor: USER,
    subjectCount: 2, roleSubjectCount: 1, groupSubjectCount: 1, acceptedMembershipCount: 1 };
  const calls: Call[] = [];
  const adapter = createDocumentQueryAdapter({
    parse: (document: string) => document,
    createClient: (endpoint: string) => endpoint,
    execute: async <T>(endpoint: string, request: { document: string; variables?: Record<string, unknown>; source: SourceRef }) => {
      expect(endpoint).toBe(source.endpoint);
      const field: Field | 'state' = request.document === docs.FETCH_AUTHORITY_STATE ? 'state'
        : (Object.keys(pages) as Field[]).find(f => pages[f] === request.document)!;
      if (!field) throw new Error('Unrecognized authority document');
      const call: Call = { ...request, variables: request.variables!, field, page: calls.filter(c => c.field === field).length + 1 };
      calls.push(call);
      const variables = request.variables!;
      const data = clone({ _meta: { block: { number: NUMBER, hash: HASH } }, ...(field === 'state'
        ? { organization: { id: ORG, membershipAuthority: authority } }
        : { [field]: rows[field].filter(row => row.id > (variables.lastId as string)).slice(0, variables.first as number) }) });
      change?.(data, call);
      return { data: data as T };
    },
  });
  return { query: adapter.query, calls, rows, authority };
}

function wrap(query: AuthoritySnapshotQuery, transform: (result: DocumentQueryResult<any>, field: string, src: SourceRef) => void): AuthoritySnapshotQuery {
  return async <T>(src: SourceRef, document: string, vars: Record<string, unknown>) => {
    const result = await query<T>(src, document, vars);
    const field = document === docs.FETCH_AUTHORITY_STATE ? 'state' : src.method;
    transform(result, field, src);
    return result;
  };
}

function unproven(result: Awaited<ReturnType<typeof readAuthoritySnapshot>>) {
  expect(result.coverage.status).toBe('unavailable');
  expect(result.source.snapshot).toBe('unknown');
  expect(result.source.block).toBeUndefined();
  expect(result.data.ready.state).toBe('unknown');
  expect(result.data.paused.state).toBe('unknown');
  expect(result.data.subjects).toEqual([]);
}

describe('authority serving selectors and independent observed evidence', () => {
  it('hash-pins state and all seven independently paged collections, including terminal empty pages', async () => {
    const f = fixture();
    const result = await readAuthoritySnapshot({ source, query: f.query, pageSize: 1, maxPages: 4 });
    requireCompleteSnapshot(result, { scope: source, indexed: true, snapshot: 'pinned', block: source.block });
    expect(result.source.block).toEqual({ number: String(NUMBER), hash: HASH });
    expect(f.calls).toHaveLength(22); // state + 3 pages per independent two-row collection
    for (const call of f.calls) {
      expect(call.variables.block).toEqual({ hash: HASH });
      expect(call.variables.orgId).toBe(ORG);
      expect(call.source.chainId).toBe(100); expect(call.source.orgId).toBe(ORG);
      expect(call.source.contract).toBe(AUTH); expect(call.source.endpoint).toBe(source.endpoint);
      expect(call.source.method).toBe(call.field === 'state' ? 'authority' : call.field);
    }
    for (const field of Object.keys(pages) as Field[]) {
      const collection = result.data.collections[field];
      expect(collection.data).toEqual(f.rows[field]);
      expect(collection.coverage).toMatchObject({ status: 'complete', pages: 3 });
      expect(collection.source.block).toEqual(result.source.block);
      expect(f.calls.filter(c => c.field === field).map(c => c.variables.lastId)).toEqual(['', f.rows[field][0].id, f.rows[field][1].id]);
    }
    expect(result.data.subjects.map(s => s.subjectId)).toEqual([ROLE, GROUP]);
    expect(result.data.subjects[0]).toMatchObject({ maxMembers: '5', memberCount: '1', vouchConfig: { quorum: '1', epoch: '0' } });
    expect(result.data.subjects[1].name).toBeNull();
    expect(result.data.memberships.map(m => m.vouchCount)).toEqual(['0', '0']);
    expect(result.data.memberships[1].rule).toMatchObject({ kind: 'None', clearedAt: '1788636040' });
    expect(result.data.permissions[0].word).toBe('57896044618658097711785492504343953926634992332820282019728792003956564819969');
    expect(result.data.activeVouches.map(v => v.id)).toEqual(['vouch-1']);
    expect(result.data.vouches).toHaveLength(2);
    expect(result.data.pendingActions[0]).toMatchObject({ pendingId: '9007199254740993', actorName: { state: 'known', value: 'e2e_burner' } });
    expect(result.data.ready).toMatchObject({ state: 'known', value: true, source: result.source });
    expect(authorityAccountMembershipFacts(result, USER).data[0].isMember).toMatchObject({ state: 'known', value: true });
  });

  it('number-only requests accept explicit null hashes without inventing identity evidence', async () => {
    const f = fixture(data => { data._meta.block.hash = null; });
    const numericSource = { ...source, block: { number: String(NUMBER) } };
    const result = await readAuthoritySnapshot({ source: numericSource, query: f.query });
    requireCompleteSnapshot(result, { snapshot: 'pinned', block: numericSource.block });
    expect(result.source.block).toEqual({ number: String(NUMBER) });
    for (const c of Object.values(result.data.collections)) expect(c.source.block).toEqual({ number: String(NUMBER) });
    for (const call of f.calls) expect(call.variables.block).toEqual({ number: NUMBER });
    expect(() => requireCompleteSnapshot(result, { block: source.block })).toThrow('BLOCK_MISMATCH');
  });

  it('returns canonical observed metadata, including differently cased hash and number text', async () => {
    const requested = { ...source, block: { number: `0${NUMBER}`, hash: HASH.toUpperCase().replace('0X', '0x') } };
    const result = await readAuthoritySnapshot({ source: requested, query: fixture().query });
    expect(result.coverage.status).toBe('complete');
    expect(result.source.block).toEqual({ number: String(NUMBER), hash: HASH });
    expect(result.source.block).not.toBe(requested.block);
    expect(result.data.ready.source?.block).toEqual(result.source.block);
  });

  it('retains additional hash evidence on a number-only request only when every response observes it', async () => {
    const f = fixture();
    const result = await readAuthoritySnapshot({ source: { ...source, block: { number: String(NUMBER) } }, query: f.query });
    expect(result.coverage.status).toBe('complete');
    expect(result.source.block).toEqual(source.block);
    expect(f.calls.every(c => JSON.stringify(c.variables.block) === JSON.stringify({ number: NUMBER }))).toBe(true);
  });

  it.each([
    ['requested number contradicts observed hash', { number: String(NUMBER - 1), hash: HASH }, 'BLOCK_MISMATCH'],
    ['requested hash contradicts observed hash', { number: String(NUMBER), hash: OTHER_HASH }, 'BLOCK_MISMATCH'],
    ['number-only request contradicts observed number', { number: String(NUMBER - 1) }, 'BLOCK_MISMATCH'],
    ['requested timestamp has no observed proof', { number: String(NUMBER), hash: HASH, timestamp: '1788636040' }, 'BLOCK_MISMATCH'],
  ] as const)('%s refuses echoed request evidence', async (_name, block, code) => {
    const f = fixture();
    const result = await readAuthoritySnapshot({ source: { ...source, block }, query: f.query });
    unproven(result); expect(result.coverage.issues).toContainEqual({ code }); expect(f.calls).toHaveLength(1);
  });

  it.each(['meta', 'block', 'number', 'hash', 'null-hash'] as const)('missing %s cannot promote request identity, even for empty state/rows', async missing => {
    const f = fixture(data => {
      if (missing === 'meta') delete data._meta;
      else if (missing === 'block') delete data._meta.block;
      else if (missing === 'null-hash') data._meta.block.hash = null;
      else delete data._meta.block[missing];
    });
    const result = await readAuthoritySnapshot({ source, query: f.query });
    unproven(result); expect(result.coverage.issues).toContainEqual({ code: 'INDEX_BLOCK_UNAVAILABLE' });
  });

  it.each([null, '', 'not-hash', 123])('malformed observed hash %s never becomes a complete snapshot', async hash => {
    const result = await readAuthoritySnapshot({ source, query: fixture(data => { data._meta.block.hash = hash; }).query });
    unproven(result);
  });

  it('requested timestamps need independent, matching seconds on every response', async () => {
    const timed = { ...source, block: { ...source.block!, timestamp: '1788636040' } };
    const result = await readAuthoritySnapshot({ source: timed, query: fixture(data => { data._meta.block.timestamp = 1788636040; }).query });
    expect(result.coverage.status).toBe('complete'); expect(result.source.block).toEqual(timed.block);
    const wrong = await readAuthoritySnapshot({ source: timed, query: fixture(data => { data._meta.block.timestamp = 1788636041; }).query });
    unproven(wrong);
  });
});

describe('state, collection and terminal-page provenance invariants', () => {
  it.each(Object.keys(pages) as Field[])('missing %s page metadata cannot borrow state or request proof', async field => {
    const f = fixture((data, call) => { if (call.field === field) delete data._meta; });
    const result = await readAuthoritySnapshot({ source, query: f.query });
    expect(result.coverage.status).toBe('incomplete');
    expect(result.source.block).toEqual(source.block); // valid independent state proof survives
    expect(result.data.collections[field].source).toMatchObject({ snapshot: 'unknown' });
    expect(result.data.collections[field].source.block).toBeUndefined();
    expect(result.data.collections[field].data).toEqual([]);
    expect(() => requireCompleteSnapshot(result)).toThrow('INCOMPLETE_SNAPSHOT');
  });

  it.each(Object.keys(pages) as Field[])('a contradictory %s page cannot claim alignment with state', async field => {
    const f = fixture((data, call) => { if (call.field === field) data._meta.block.number = NUMBER + 1; });
    const result = await readAuthoritySnapshot({ source, query: f.query });
    expect(result.coverage.status).toBe('incomplete');
    expect(result.data.collections[field].coverage.status).toBe('unavailable');
    expect(result.data.collections[field].source.block).toBeUndefined();
  });

  it.each(Object.keys(pages) as Field[])('invalid proof on %s terminal empty page retains earlier rows and refuses completeness', async field => {
    const f = fixture((data, call) => { if (call.field === field && call.page === 3) delete data._meta; });
    const result = await readAuthoritySnapshot({ source, query: f.query, pageSize: 1 });
    expect(result.coverage.status).toBe('incomplete');
    const collection = result.data.collections[field];
    expect(collection.data).toEqual(f.rows[field]); expect(collection.source.block).toEqual(source.block);
    expect(collection.coverage).toMatchObject({ status: 'incomplete', pages: 3, failedIds: ['page:3'] });
  });

  it.each(['state-null-page-hash', 'state-hash-page-null', 'first-null-next-hash', 'first-hash-next-null', 'terminal-null', 'different-hash'] as const)('number-only mixed evidence: %s is incomplete', async kind => {
    const f = fixture((data, call) => {
      data._meta.block.hash = kind === 'state-null-page-hash' || kind === 'first-null-next-hash' ? null : HASH;
      if (kind === 'state-null-page-hash' && call.field === 'permRows') data._meta.block.hash = HASH;
      if (kind === 'state-hash-page-null' && call.field === 'permRows') data._meta.block.hash = null;
      if (kind === 'first-null-next-hash' && call.field === 'permRows' && call.page === 2) data._meta.block.hash = HASH;
      if (kind === 'first-hash-next-null' && call.field === 'permRows' && call.page === 2) data._meta.block.hash = null;
      if (kind === 'terminal-null' && call.field === 'permRows' && call.page === 3) data._meta.block.hash = null;
      if (kind === 'different-hash' && call.field === 'permRows') data._meta.block.hash = OTHER_HASH;
    });
    const result = await readAuthoritySnapshot({ source: { ...source, block: { number: String(NUMBER) } }, query: f.query, pageSize: 1 });
    expect(result.coverage.status).toBe('incomplete');
    const c = result.data.collections.permRows;
    expect(c.coverage.status).not.toBe('complete');
    if (kind.startsWith('first-')) expect(c.data).toEqual(f.rows.permRows.slice(0, 1));
    if (kind === 'terminal-null') expect(c.data).toEqual(f.rows.permRows);
  });

  it('optional timestamp appearance/disappearance cannot attest earlier state or pages', async () => {
    for (const atState of [false, true]) {
      const f = fixture((data, call) => {
        if (atState ? call.field !== 'permRows' : call.field === 'permRows') data._meta.block.timestamp = 1788636040;
      });
      const result = await readAuthoritySnapshot({ source, query: f.query });
      expect(result.coverage.status).toBe('incomplete');
      expect(result.data.collections.permRows.coverage.status).toBe('unavailable');
    }
  });

  for (const field of ['state', ...Object.keys(pages)]) {
    it.each([
      { chainId: 42161 }, { orgId: `0x${'ff'.repeat(32)}` }, { contract: VOUCHER }, { account: VOUCHER },
      { endpoint: 'fixture://wrong-endpoint' }, { method: 'wrong-method' }, { indexed: false }, { snapshot: 'latest' as const },
    ])(`${field}: returned request scope %j cannot be laundered through valid metadata`, async mismatch => {
      const scoped = { ...source, account: USER };
      const f = fixture();
      const query = wrap(f.query, (result, got) => { if (field === got) result.source = { ...result.source, ...mismatch }; });
      const result = await readAuthoritySnapshot({ source: scoped, query });
      if (field === 'state') unproven(result);
      else { expect(result.coverage.status).toBe('incomplete'); expect(result.data.collections[field].source.block).toBeUndefined(); }
    });
  }

  it('partial state errors and collection errors refuse decisions without legacy fallback', async () => {
    for (const field of ['state', 'permRows']) {
      const f = fixture();
      const query = wrap(f.query, (result, got) => { if (field === got) result.issues = [{ code: 'GRAPHQL_PARTIAL_ERROR' }]; });
      const result = await readAuthoritySnapshot({ source, query });
      if (field === 'state') unproven(result); else {
        expect(result.coverage.status).toBe('incomplete');
        expect(result.data.collections.permRows.data).toEqual(f.rows.permRows);
      }
      expect(f.calls.every(c => c.document === docs.FETCH_AUTHORITY_STATE || Object.values(pages).includes(c.document))).toBe(true);
    }
  });
});

describe('empty, absent and capped authority snapshots stay distinct', () => {
  it('a present ready empty authority is complete only after all seven empty collections prove their block', async () => {
    const f = fixture((data, call) => {
      if (call.field === 'state') Object.assign(data.organization.membershipAuthority, { subjectCount: 0, roleSubjectCount: 0, groupSubjectCount: 0, acceptedMembershipCount: 0 });
      else data[call.field] = [];
    });
    const result = await readAuthoritySnapshot({ source, query: f.query });
    expect(result.coverage.status).toBe('complete'); expect(result.data.ready).toMatchObject({ state: 'known', value: true });
    expect(f.calls).toHaveLength(8);
    expect(Object.values(result.data.collections).every(c => c.coverage.status === 'complete' && !c.data.length)).toBe(true);
  });

  it('an absent organization is unavailable with observed absence block, never a ready empty authority', async () => {
    const f = fixture((data, call) => { if (call.field === 'state') data.organization = null; });
    const result = await readAuthoritySnapshot({ source, query: f.query });
    expect(result.coverage).toMatchObject({ status: 'unavailable', issues: [{ code: 'ORGANIZATION_UNAVAILABLE' }] });
    expect(result.source.block).toEqual(source.block); expect(result.data.ready.state).toBe('unknown');
    expect(result.data.collections).toEqual({}); expect(f.calls).toHaveLength(1);
  });

  it('an organization without authority is unavailable without querying retired documents', async () => {
    const f = fixture((data, call) => { if (call.field === 'state') data.organization.membershipAuthority = null; });
    const result = await readAuthoritySnapshot({ source, query: f.query });
    expect(result.coverage).toMatchObject({ status: 'unavailable', issues: [{ code: 'AUTHORITY_SCOPE_MISMATCH' }] });
    expect(f.calls).toHaveLength(1); expect(result.source.block).toEqual(source.block);
  });

  it.each(Object.keys(pages) as Field[])('missing %s array remains unavailable even with valid metadata', async field => {
    const f = fixture((data, call) => { if (call.field === field) delete data[field]; });
    const result = await readAuthoritySnapshot({ source, query: f.query });
    expect(result.coverage.status).toBe('incomplete');
    expect(result.data.collections[field].coverage).toMatchObject({ status: 'unavailable', issues: [{ code: 'MISSING_COLLECTION', id: 'page:1' }] });
  });

  it.each([{ maxPages: 1, issue: 'PAGE_CAP' }, { maxRows: 1, issue: 'ROW_CAP' }])('independent collection $issue retains one row and blocks decisions', async ({ issue, ...bounds }) => {
    const f = fixture();
    const result = await readAuthoritySnapshot({ source, query: f.query, pageSize: 1, ...bounds });
    expect(result.coverage.status).toBe('incomplete');
    for (const collection of Object.values(result.data.collections)) {
      expect(collection.data).toHaveLength(1); expect(collection.coverage.status).toBe('incomplete');
      expect(collection.coverage.issues).toContainEqual({ code: issue, ...(issue === 'ROW_CAP' ? { id: 'page:1' } : {}) });
    }
    expect(f.calls).toHaveLength(8);
    expect(authorityAccountMembershipFacts(result, USER).data.every(m => m.isMember.state === 'unknown')).toBe(true);
  });

  it('a full last allowed page cannot prove completion, including when it equals the known counts', async () => {
    const f = fixture();
    const result = await readAuthoritySnapshot({ source, query: f.query, pageSize: 2, maxPages: 1 });
    expect(result.coverage.status).toBe('incomplete'); expect(result.data.subjects).toHaveLength(2);
    expect(result.coverage.issues.some(i => i.code === 'AUTHORITY_COUNT_MISMATCH')).toBe(false);
    expect(Object.values(result.data.collections).every(c => c.coverage.issues.some(i => i.code === 'PAGE_CAP'))).toBe(true);
  });

  it.each([{ maxPages: 0 }, { maxRows: 0 }, { maxPages: Number.MAX_SAFE_INTEGER }, { pageSize: 1001 }])('invalid bounds %j fail before queries', async bounds => {
    const f = fixture();
    await expect(readAuthoritySnapshot({ source, query: f.query, ...bounds })).rejects.toThrow(); expect(f.calls).toEqual([]);
  });
});

describe('authority serving documents bind every selected state/collection to the same selector', () => {
  const schema = buildSchema(readFileSync(new URL('./fixtures/core-update/serving-queries/schema.graphql', import.meta.url), 'utf8'));
  for (const [field, document] of Object.entries({ organization: docs.FETCH_AUTHORITY_STATE, ...pages })) {
    it(`${field} validates serving schema and binds root entity plus metadata to $block`, () => {
      expect(validate(schema, parse(document))).toEqual([]);
      const operation = parse(document).definitions[0];
      if (operation.kind !== Kind.OPERATION_DEFINITION) throw new Error('Expected query');
      const selections = operation.selectionSet.selections;
      expect(selections.map(s => s.kind === Kind.FIELD ? s.name.value : null).sort()).toEqual(['_meta', field].sort());
      for (const s of selections) {
        if (s.kind !== Kind.FIELD) throw new Error('Expected field');
        expect(s.arguments?.find(a => a.name.value === 'block')?.value).toEqual({ kind: Kind.VARIABLE, name: { kind: Kind.NAME, value: 'block', loc: expect.anything() }, loc: expect.anything() });
      }
    });
  }
});
