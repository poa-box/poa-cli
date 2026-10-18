import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSchema, extendSchema, graphql, parse, print, validate, visit } from 'graphql';
import { SourceRef, SourceSnapshot, requireCompleteSnapshot } from '../src/data/facts';
import * as readers from '../src/reads/protocol';
import { FETCH_CREDENTIAL_PAGE_LEGACY, FETCH_SOLIDARITY_STATE } from '../src/graph/documents/accounts';
import { FETCH_PROTOCOL_ORGS_PAGE } from '../src/graph/documents/protocol';

const oracle = JSON.parse(readFileSync(new URL('./fixtures/core-update/indexed-provenance/oracle.json', import.meta.url), 'utf8'));
const observed = JSON.parse(readFileSync(new URL('./fixtures/core-update/indexed-provenance/serving-meta.json', import.meta.url), 'utf8'));
const mixedPages = JSON.parse(readFileSync(new URL('./fixtures/core-update/indexed-provenance/mixed-pages.json', import.meta.url), 'utf8'));
const serving = readFileSync(new URL('./fixtures/core-update/serving-queries/schema.graphql', import.meta.url), 'utf8');
const schema = /timestamp: Int/.test(serving) ? buildSchema(serving) : extendSchema(buildSchema(serving), parse('extend type _Block_ { timestamp: Int }'));
const [block, nextBlock] = oracle.blocks;
const source = (chainId = 100, dimensions: Partial<SourceRef> = {}): SourceRef => ({
  chainId, endpoint: `fixture://graph-${chainId}`, method: 'indexed-read', indexed: true, snapshot: 'pinned',
  account: oracle.account, contract: oracle.hub, orgId: oracle.orgId,
  contracts: { manager: oracle.registry, registry: oracle.registry, accountRegistry: oracle.registry, hub: oracle.hub },
  block: { number: String(block.number), hash: block.hash }, ...dimensions,
});
const accepts = (result: SourceSnapshot<unknown>, src: SourceRef) => {
  try { requireCompleteSnapshot(result, { indexed: true, snapshot: src.snapshot, block: src.block, scope: src }); return true; }
  catch { return false; }
};
type Read = (source: SourceRef, query: readers.ProtocolQuery) => Promise<SourceSnapshot<unknown>>;
const paths: [string, Read][] = [
  ['generic-page', (source, query) => readers.readIndexedPageFacts({ source, query, document: FETCH_PROTOCOL_ORGS_PAGE, variables: { hub: oracle.hub }, collection: 'paymasterOrgConfigs', initialCursor: '', pageSize: 10 })],
  ['generic-singleton', (source, query) => readers.readIndexedSingletonFacts(source, query, FETCH_SOLIDARITY_STATE, { hub: oracle.hub }, ['paymasterHubContracts', 'onboardingConfigs'])],
  ['account', (source, query) => readers.readAccountFacts(source, query, oracle.registry)],
  ['factory', (source, query) => readers.readFactoryFacts(source, query, oracle.registry)],
  ['solidarity', readers.readSolidarityFacts],
  ['overview', readers.readProtocolOverviewFacts],
  ['credential-account', (source, query) => readers.readCredentialFacts({ source, query })],
  ['credential-discovery', (source, query) => readers.readCredentialFacts({ source, query, credentialId: block.hash })],
  ['orgs', (source, query) => readers.readProtocolOrgFacts({ source, query })],
  ['beacon', (source, query) => readers.readProtocolEventFacts({ source, query, kind: 'beacon' })],
  ['solidarity-events', (source, query) => readers.readProtocolEventFacts({ source, query, kind: 'solidarity' })],
  ['deposits', (source, query) => readers.readPaymasterHistoryFacts({ source, query, kind: 'deposits', orgConfig: 'orgcfg' })],
  ['usage', (source, query) => readers.readPaymasterHistoryFacts({ source, query, kind: 'usage', orgConfig: 'orgcfg' })],
];

/** Execute metadata selection/filter with GraphQL, against a store independent of SourceRef.
 * Entity rows are decoded fixtures; AST assertions separately prove their identical block filters.
 * This avoids inventing populated values for every non-null descriptive schema field. */
function transport(src: SourceRef, options: { empty?: boolean; hashCapability?: boolean; rows?: Record<string, readers.IndexedRow[]>; meta?: (meta: any) => any } = {}) {
  const calls: { document: string; variables: Record<string, unknown> }[] = [];
  const query: readers.ProtocolQuery = async (document, variables, actual) => {
    calls.push({ document, variables });
    expect(actual).toBe(src);
    expect(actual.endpoint).toBe(`fixture://graph-${src.chainId}`);
    const ast = parse(document);
    const op = ast.definitions.find(d => d.kind === 'OperationDefinition');
    if (!op || op.kind !== 'OperationDefinition') throw new Error('Missing operation');
    const fields = op.selectionSet.selections;
    if (src.snapshot === 'pinned') {
      for (const field of fields) {
        if (field.kind !== 'Field') throw new Error('Oracle supports direct fields');
        expect(field.arguments?.find(a => a.name.value === 'block')?.value).toMatchObject({ kind: 'Variable', name: { value: 'block' } });
      }
      expect(variables.block).toEqual(src.block?.hash ? { hash: src.block.hash } : { number: Number(src.block!.number) });
    } else expect(variables).not.toHaveProperty('block');
    // Serving schema determines fallback, rather than detecting string fragments in the query.
    const errors = validate(schema, ast);
    const unknownKeys = errors.filter(e => /Cannot query field "publicKey[XY]"/.test(e.message));
    if (unknownKeys?.length) return { errors: unknownKeys };
    expect(errors).toEqual([]);
    const metaFields = fields.filter(f => f.kind === 'Field' && f.name.value === '_meta');
    expect(metaFields).toHaveLength(1);
    const metaDoc = visit(ast, { OperationDefinition: n => ({ ...n, variableDefinitions: n.variableDefinitions?.filter(v => v.variable.name.value === 'block'), selectionSet: { ...n.selectionSet, selections: metaFields } }) });
    const supported = options.hashCapability === false ? buildSchema(serving.replace('  hash: Bytes\n  number: Int\n', '  number: Int\n')) : schema;
    const meta = await graphql({ schema: supported, source: print(metaDoc), variableValues: { block: variables.block }, rootValue: {
      _meta: ({ block: selector }: any) => {
        const selected = selector?.hash ? oracle.blocks.find((b: any) => b.hash.toLowerCase() === selector.hash.toLowerCase())
          : selector?.number !== undefined ? oracle.blocks.find((b: any) => b.number === selector.number) : nextBlock;
        if (!selected) throw new Error('Unknown block');
        return { block: { ...selected, hash: selector?.hash ? selected.hash : null } };
      },
    } });
    if (meta.errors?.length) return { errors: meta.errors };
    const rows = Object.fromEntries(fields.filter(f => f.kind === 'Field' && f.name.value !== '_meta').map(f => {
      if (f.kind !== 'Field') throw new Error('Not a field');
      const all = options.empty ? [] : (options.rows ?? oracle.rows)[f.name.value];
      return [f.name.value, all?.filter((r: any) => !variables.cursor || r.id > String(variables.cursor)).slice(0, Number(variables.first ?? 2))];
    }));
    return { ...rows, _meta: options.meta ? options.meta(meta.data?._meta) : meta.data?._meta };
  };
  return { query, calls };
}

describe('independently enforced indexed block provenance', () => {
  for (const record of observed.report) it(`retained serving metadata: ${record.chainId} ${record.kind} gate replays without a network or population claim`, async () => {
    const src: SourceRef = { ...record.source, snapshot: 'pinned', block: record.requested, endpoint: 'fixture://retained-meta' };
    const response = record.calls.at(-1);
    const result = await readers.readIndexedSingletonFacts(src, async (_doc, vars, actual) => {
      expect(actual).toBe(src); expect(vars.block).toEqual(response.variables.block);
      return { _meta: response.meta };
    }, FETCH_SOLIDARITY_STATE, {}, []);
    expect(accepts(result, src)).toBe(record.accepted);
    if (record.kind === 'number') expect(result.source.block).not.toHaveProperty('hash');
    if (record.kind === 'hash') expect(result.source.block?.hash).toBe(record.headMeta.block.hash);
    if (record.kind === 'conflict') expect(result.source.block).toBeUndefined();
  });
  for (const chainId of [100, 42161]) for (const [name, read] of paths) {
    for (const empty of [false, true]) it(`${chainId} ${name}: ${empty ? 'empty' : 'nonempty'} hash-filter identity plus independent number proof`, async () => {
      const src = source(chainId); const tx = transport(src, { empty }); const result = await read(src, tx.query);
      expect(result.coverage.status).toBe('complete'); expect(accepts(result, src)).toBe(true);
      expect(result.source.block).toMatchObject({ number: String(block.number), hash: block.hash });
      expect(tx.calls.length).toBe(name.startsWith('credential') ? 2 : 1);
    });
    it(`${chainId} ${name}: numeric-only null hash is honest complete evidence`, async () => {
      const src = source(chainId, { block: { number: String(block.number) } }); const result = await read(src, transport(src).query);
      expect(accepts(result, src)).toBe(true); expect(result.source.block).not.toHaveProperty('hash');
      expect(accepts(result, source(chainId))).toBe(false);
    });
    for (const [caseName, meta] of [
      ['missing', () => undefined], ['null', () => null], ['missing block', () => ({})],
      ['missing selected hash', (m: any) => ({ block: { ...m.block, hash: undefined } })],
      ['wrong number', (m: any) => ({ block: { ...m.block, number: nextBlock.number } })],
      ['wrong hash', (m: any) => ({ block: { ...m.block, hash: nextBlock.hash } })],
      ['invalid hash', (m: any) => ({ block: { ...m.block, hash: '0x01' } })],
    ] as const) it(`${chainId} ${name}: ${caseName} metadata cannot certify requested block`, async () => {
      const src = source(chainId); const result = await read(src, transport(src, { meta }).query);
      expect(accepts(result, src)).toBe(false); expect(result.coverage.status).toBe('unavailable');
      expect(result.source.snapshot).toBe('unknown'); expect(result.source.block).toBeUndefined();
    });
    it(`${chainId} ${name}: supported hash filter and null hash still prove number`, async () => {
      const src = source(chainId); const result = await read(src, transport(src, { meta: m => ({ block: { ...m.block, hash: null } }) }).query);
      expect(accepts(result, src)).toBe(true);
    });
    it(`${chainId} ${name}: conflicting number/hash and unsupported hash capability fail without numeric retry`, async () => {
      const conflict = source(chainId, { block: { number: String(nextBlock.number), hash: block.hash } });
      expect(accepts(await read(conflict, transport(conflict).query), conflict)).toBe(false);
      const src = source(chainId); const tx = transport(src, { hashCapability: false });
      expect(accepts(await read(src, tx.query), src)).toBe(false);
      expect(tx.calls.every(c => (c.variables.block as any)?.hash === block.hash)).toBe(true);
    });
  }
  for (const [name, read] of paths) it(`${name}: missing proof reproduces the original hash-echo counterexample`, async () => {
    const src = source(); const variables: Record<string, unknown>[] = [];
    const result = await read(src, async (_doc, vars) => { variables.push(vars); return oracle.rows; });
    expect(accepts(result, src)).toBe(false); expect(result.source.block).toBeUndefined();
    expect(variables.every(v => (v.block as any)?.hash === block.hash)).toBe(true);
  });
  for (const [name, read] of paths) it(`${name}: latest retains compatibility without asserting a pinned identity`, async () => {
    const src = source(100, { snapshot: 'latest', block: undefined }); const result = await read(src, transport(src).query);
    expect(accepts(result, src)).toBe(true); expect(result.source).toBe(src); expect(result.source.block).toBeUndefined();
  });
  for (const [name, read] of paths) for (const [proof, meta] of [['missing', () => undefined], ['null', () => null]] as const) it(`${name}: an empty collection with ${proof} metadata still needs block proof`, async () => {
    const src = source(); const result = await read(src, transport(src, { empty: true, meta }).query);
    expect(result.coverage.status).toBe('unavailable'); expect(accepts(result, src)).toBe(false);
    expect(result.source.snapshot).toBe('unknown'); expect(result.source.block).toBeUndefined();
  });
  for (const failure of ['transport', 'wrong number', 'changed hash', 'missing meta', 'missing hash'] as const) it(`later ${failure} preserves prior page but cannot certify mixed evidence`, async () => {
    const src = source(100, failure === 'changed hash' || failure === 'missing hash' ? { block: { number: String(block.number) } } : {});
    let pages = 0;
    const tx = transport(src, { meta: m => { pages++; return pages === 1 ? { block: { ...m.block, hash: block.hash } }
      : failure === 'missing meta' ? null : { block: { ...m.block, number: failure === 'wrong number' ? nextBlock.number : block.number, hash: failure === 'changed hash' ? nextBlock.hash : failure === 'missing hash' ? null : block.hash } }; } });
    let calls = 0;
    const result = await readers.readProtocolOrgFacts({ source: src, pageSize: 1, query: async (...args) => {
      if (++calls === 2 && failure === 'transport') throw new Error('Network failure'); return tx.query(...args);
    } });
    expect(result.data).toEqual(oracle.rows.paymasterOrgConfigs); expect(result.coverage.status).toBe('incomplete');
    expect(result.coverage.failedIds).toEqual(['page:2']); expect(accepts(result, src)).toBe(false);
    expect(readers.sumIndexedOrgGasFacts(result).totalSpent.state).toBe('unknown');
  });
  it('every explicitly requested timestamp requires observed matching seconds', async () => {
    const src = source(100, { block: { number: String(block.number), hash: block.hash, timestamp: String(block.timestamp) } });
    const good = await readers.readSolidarityFacts(src, transport(src).query); expect(accepts(good, src)).toBe(true);
    for (const timestamp of [undefined, null, nextBlock.timestamp, '1000000']) {
      const result = await readers.readSolidarityFacts(src, transport(src, { meta: m => ({ block: { ...m.block, timestamp } }) }).query);
      expect(accepts(result, src)).toBe(false);
    }
  });
  it('scope checks survive proven block identity for account/factory/registry/hub/org/credentials', async () => {
    const src = source();
    for (const [name, read] of paths.filter(([n]) => !n.startsWith('generic'))) {
      const tx = transport(src); const result = await read(src, async (...args) => {
        const response = await tx.query(...args); if (response.errors) return response;
        return Object.fromEntries(Object.entries(response).map(([key, value]) => [key, key === '_meta' ? value : (value as any[]).map(row => ({ ...row, id: nextBlock.hash, account: { id: oracle.hub }, paymasterHub: { id: oracle.account }, poaManager: { id: oracle.account }, orgConfig: { id: 'wrong', orgId: nextBlock.hash, paymasterHub: { id: oracle.account } } }))]));
      });
      expect(result.coverage.status, name).toBe('incomplete'); expect(accepts(result, src), name).toBe(false);
    }
    expect(() => readers.readAccountFacts(src, transport(src).query, oracle.hub)).toThrow('SCOPE_MISMATCH');
    expect(() => readers.readFactoryFacts(src, transport(src).query, oracle.hub)).toThrow('SCOPE_MISMATCH');
  });
  it('legacy tier keeps exact hash filter and unknown keys, and mixed errors cannot create proof', async () => {
    const src = source(); const tx = transport(src);
    const result = await readers.readCredentialFacts({ source: src, query: tx.query });
    expect(accepts(result, src)).toBe(true); expect(tx.calls[1].document).toBe(FETCH_CREDENTIAL_PAGE_LEGACY);
    expect(tx.calls[1].variables).toEqual(tx.calls[0].variables);
    expect(readers.projectCredentialFacts(result.data[0], result.source).publicKeyX.state).toBe('unknown');
    let calls = 0;
    const failed = await readers.readCredentialFacts({ source: src, query: async () => { calls++; return { errors: [{ message: 'Cannot query field "publicKeyX"' }, { message: 'hash unavailable' }] }; } });
    expect(calls).toBe(1); expect(accepts(failed, src)).toBe(false);
  });
});

type PageRead = (source: SourceRef, query: readers.ProtocolQuery, pageSize: number) => Promise<SourceSnapshot<readonly readers.IndexedRow[]>>;
const pagePaths: [string, PageRead, string][] = [
  ['generic-page', (source, query, pageSize) => readers.readIndexedPageFacts({ source, query, pageSize, document: FETCH_PROTOCOL_ORGS_PAGE, variables: { hub: oracle.hub }, collection: 'paymasterOrgConfigs', initialCursor: '' }), 'paymasterOrgConfigs'],
  ['orgs', (source, query, pageSize) => readers.readProtocolOrgFacts({ source, query, pageSize }), 'paymasterOrgConfigs'],
  ['credential-account', (source, query, pageSize) => readers.readCredentialFacts({ source, query, pageSize }), 'passkeyCredentials'],
  ['credential-discovery', (source, query, pageSize) => readers.readCredentialFacts({ source, query, pageSize, credentialId: block.hash }), 'passkeyCredentials'],
  ['beacon', (source, query, pageSize) => readers.readProtocolEventFacts({ source, query, pageSize, kind: 'beacon' }), 'beaconUpgradeEvents'],
  ['solidarity-events', (source, query, pageSize) => readers.readProtocolEventFacts({ source, query, pageSize, kind: 'solidarity' }), 'solidarityEvents'],
  ['deposits', (source, query, pageSize) => readers.readPaymasterHistoryFacts({ source, query, pageSize, kind: 'deposits', orgConfig: 'orgcfg' }), 'paymasterDepositEvents'],
  ['usage', (source, query, pageSize) => readers.readPaymasterHistoryFacts({ source, query, pageSize, kind: 'usage', orgConfig: 'orgcfg' }), 'usageEvents'],
];
// Independent store has two ordered rows: full first/intermediate pages, then
// an empty page proving exhaustion. No response derives proof from SourceRef.
const twoPageRows = Object.fromEntries(Object.entries(oracle.rows).map(([key, rows]) => {
  const row = (rows as readers.IndexedRow[])[0];
  return [key, [row, { ...row, id: `${row.id}${String(row.id).startsWith('0x') ? '02' : '-2'}` }]];
}));
const hashValue = (hash: string | null) => hash === null ? null : hash === 'H' ? block.hash : nextBlock.hash;

describe('whole indexed snapshot page proof', () => {
  for (const chainId of [100, 42161]) for (const [name, read, collection] of pagePaths) {
    for (const record of mixedPages.hashSequences) it(`${chainId} ${name}: numeric ${record.name} cannot strengthen earlier page proof`, async () => {
      const src = source(chainId, { block: { number: String(block.number) } });
      let page = 0;
      const tx = transport(src, { rows: twoPageRows, meta: m => ({ block: { ...m.block, hash: hashValue(record.hashes[page++]) } }) });
      const result = await read(src, tx.query, 1);
      expect(result.coverage.status).toBe(record.coverage);
      expect(result.coverage.pages).toBe(record.pages);
      expect(result.coverage.failedIds).toEqual(record.failedPage ? [`page:${record.failedPage}`] : []);
      expect(result.data).toEqual(twoPageRows[collection]);
      expect(result.source.block).toEqual({ number: String(block.number), timestamp: String(block.timestamp), ...(record.hashes[0] === null ? {} : { hash: hashValue(record.hashes[0]) }) });
      expect(accepts(result, src)).toBe(record.coverage === 'complete');
      expect(accepts(result, source(chainId))).toBe(record.acceptsH);
      if (record.failedPage) expect(result.coverage.issues).toContainEqual({ code: 'PAGE_SOURCE_MISMATCH', id: `page:${record.failedPage}` });
      expect(tx.calls.length).toBe(record.pages * (name.startsWith('credential') ? 2 : 1));
      if (name === 'orgs') {
        const total = readers.sumIndexedOrgGasFacts(result).totalSpent;
        expect(total.state).toBe(record.coverage === 'complete' ? 'known' : 'unknown');
        if (total.state === 'known') expect(total.value).toBe('18014398509481986');
      }
    });
    for (const record of mixedPages.hashSequences.filter((r: any) => !r.hashes.includes('K'))) it(`${chainId} ${name}: exact hash ${record.name} proves all pages even with null hash metadata`, async () => {
      const src = source(chainId); let page = 0;
      const tx = transport(src, { rows: twoPageRows, meta: m => ({ block: { ...m.block, hash: hashValue(record.hashes[page++]) } }) });
      const result = await read(src, tx.query, 1);
      expect(result.coverage.status).toBe('complete'); expect(accepts(result, src)).toBe(true);
      expect(result.source.block?.hash).toBe(block.hash); expect(result.data).toEqual(twoPageRows[collection]);
      expect(tx.calls.length).toBe(3 * (name.startsWith('credential') ? 2 : 1));
      expect(tx.calls.every(c => (c.variables.block as any).hash === block.hash)).toBe(true);
    });
    for (const record of mixedPages.timestampSequences) it(`${chainId} ${name}: optional timestamp ${record.name} cannot strengthen earlier page proof`, async () => {
      const src = source(chainId); let page = 0;
      const tx = transport(src, { rows: twoPageRows, meta: m => ({ block: { ...m.block, timestamp: record.timestamps[page++] } }) });
      const result = await read(src, tx.query, 1);
      expect(result.coverage.status).toBe(record.coverage); expect(result.coverage.pages).toBe(record.pages);
      expect(accepts(result, src)).toBe(record.coverage === 'complete');
      expect(result.source.block?.timestamp).toBe(record.timestamps[0] === null ? undefined : String(record.timestamps[0]));
      expect(result.data).toEqual(twoPageRows[collection]);
      if (record.failedPage) expect(result.coverage.issues).toContainEqual({ code: 'PAGE_SOURCE_MISMATCH', id: `page:${record.failedPage}` });
    });
    for (const failPage of [1, 2, 3]) for (const failure of ['missing metadata', 'null metadata', 'missing block', 'missing hash', 'wrong number', 'transport'] as const) it(`${chainId} ${name}: page ${failPage} ${failure} stays distinct from explicit null hash`, async () => {
      const src = source(chainId, { block: { number: String(block.number) } }); let page = 0;
      const tx = transport(src, { rows: twoPageRows, meta: m => {
        if (++page !== failPage) return m;
        if (failure === 'transport') throw new Error('Offline transport failure');
        if (failure === 'missing metadata') return undefined;
        if (failure === 'null metadata') return null;
        if (failure === 'missing block') return {};
        return { block: { ...m.block, ...(failure === 'missing hash' ? { hash: undefined } : { number: nextBlock.number }) } };
      } });
      const result = await read(src, tx.query, 1);
      expect(result.coverage.status).toBe(failPage === 1 ? 'unavailable' : 'incomplete');
      expect(result.coverage.failedIds).toEqual([`page:${failPage}`]); expect(result.coverage.pages).toBe(failPage);
      expect(result.data).toEqual(twoPageRows[collection].slice(0, failPage - 1)); expect(accepts(result, src)).toBe(false);
      if (failPage === 1) { expect(result.source.snapshot).toBe('unknown'); expect(result.source.block).toBeUndefined(); }
      else { expect(result.source.block?.number).toBe(String(block.number)); expect(result.source.block).not.toHaveProperty('hash'); }
      if (failure !== 'transport') expect(result.coverage.issues).toContainEqual({ code: failure === 'wrong number' ? 'BLOCK_EVIDENCE_MISMATCH' : 'BLOCK_EVIDENCE_UNAVAILABLE', id: `page:${failPage}` });
    });
    for (const empty of [false, true]) for (const hash of [null, 'H']) it(`${chainId} ${name}: first ${empty ? 'empty' : 'partial'} page proves only its own numeric/hash dimensions (${hash})`, async () => {
      const src = source(chainId, { block: { number: String(block.number) } });
      const tx = transport(src, { empty, meta: m => ({ block: { ...m.block, hash: hashValue(hash) } }) });
      const result = await read(src, tx.query, 2);
      expect(result.coverage.status).toBe('complete'); expect(result.coverage.pages).toBe(1);
      expect(result.data).toEqual(empty ? [] : oracle.rows[collection]); expect(accepts(result, src)).toBe(true);
      expect(accepts(result, source(chainId))).toBe(hash === 'H');
    });
    it(`${chainId} ${name}: latest pagination retains compatibility despite changing metadata`, async () => {
      const src = source(chainId, { snapshot: 'latest', block: undefined }); let page = 0;
      const tx = transport(src, { rows: twoPageRows, meta: m => (++page === 1 ? undefined : { block: { ...m.block, hash: page === 2 ? block.hash : nextBlock.hash } }) });
      const result = await read(src, tx.query, 1);
      expect(result.coverage.status).toBe('complete'); expect(result.source).toBe(src);
      expect(result.source.block).toBeUndefined(); expect(result.data).toEqual(twoPageRows[collection]);
      expect(tx.calls.every(c => !('block' in c.variables))).toBe(true);
    });
  }
});
