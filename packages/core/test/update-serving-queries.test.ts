import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildSchema, extendSchema, parse, print, validate, visit, Kind } from 'graphql';
import * as accounts from '../src/graph/documents/accounts';
import * as authority from '../src/graph/documents/authority';
import * as paymaster from '../src/graph/documents/paymaster';
import * as protocol from '../src/graph/documents/protocol';
import * as zkemail from '../src/graph/documents/zkemail';
import { GraphRequestError } from '../src/graph/client';
import { readCredentialFacts, projectCredentialFacts, ProtocolQuery, IndexedRow } from '../src/reads/protocol';
import { SourceRef, knownFact } from '../src/data/facts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/core-update/serving-queries/${name}`, import.meta.url), 'utf8');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const provenance = JSON.parse(fixture('provenance.json'));
const replay = JSON.parse(fixture('credential-responses.json'));
const contracts: Record<string, string> = JSON.parse(fixture('document-contracts.json'));
// Narrow additive metadata field, copied from independent both-chain introspection.
// The immutable original serving projection/hash and document contracts stay intact.
const schema = extendSchema(buildSchema(fixture('schema.graphql')), parse('extend type _Block_ { timestamp: Int }'));
// Hypothetical extension only: the retained serving schemas do NOT have these keys.
const modernSchema = extendSchema(schema, parse('extend type PasskeyCredential { publicKeyX: Bytes publicKeyY: Bytes }'));
const docs: Record<string, string> = {};
for (const [module, exports] of Object.entries({ accounts, authority, paymaster, protocol, zkemail })) {
  for (const [name, value] of Object.entries(exports)) {
    if (typeof value === 'string') docs[`${module}/${name}`] = value;
    else if (Array.isArray(value)) value.forEach((doc, i) => { docs[`${module}/${name}[${i}]`] = doc; });
  }
}
const normalized = (doc: string) => print(visit(parse(doc), {
  VariableDefinition: node => ({ ...node, type: { kind: Kind.NAMED_TYPE, name: { kind: Kind.NAME, value: 'String' } } }),
}));
const addedMeta = (name: string) => name.startsWith('accounts/') || name.startsWith('protocol/')
  || /^paymaster\/FETCH_PAYMASTER_(DEPOSITS|USAGE)_PAGE$/.test(name);
const originalSelections = (doc: string) => print(visit(parse(doc), {
  OperationDefinition: n => ({ ...n, selectionSet: { ...n.selectionSet,
    selections: n.selectionSet.selections.filter(f => !(f.kind === Kind.FIELD && f.name.value === '_meta')) } }),
}));
// Independent retained block number, NOT copied from the reader's request.
// These old HTTP bodies lack metadata; this supplies explicit mock proof for
// fallback tests. It does not claim the old HTTP responses contained proof.
const withBlockProof = (data: Record<string, unknown>, chainId = 100) => ({ ...data,
  _meta: { block: { number: replay.results.find((r: any) => r.chainId === chainId).indexedBlock.number, hash: null } },
});
const ACCOUNT = '0xbd51908f80389368fd9ea73ed7e66bb2510e9d44';
const CREDENTIAL = '0xbe319768218d22e081eb69890ae41622bae977aa805290af5f8efbe6aa4882b3';
const KEY_X = '0x' + '11'.repeat(32), KEY_Y = '0x' + '22'.repeat(32);
const source = (chainId = 100, discovery = false): SourceRef => ({
  chainId, endpoint: `fixture://serving-${chainId}`, method: 'credentials', indexed: true,
  snapshot: 'pinned', block: { number: chainId === 100 ? '48673720' : '513300634' },
  ...(!discovery ? { account: ACCOUNT } : {}),
});
const row = (id = 'credential-001', active = true): IndexedRow => ({
  id, account: { id: ACCOUNT, factory: { id: '0x6b5e116688a0903a80d9eb9e0cbbdbd3ad3ce025' } },
  credentialId: CREDENTIAL, active, signCount: '9007199254740993', createdAt: '1777253650',
  removedAt: active ? null : '1777253651', blockNumber: '45876827',
});
const keyErrors = [
  { message: 'Type `PasskeyCredential` has no field `publicKeyX`' },
  { message: 'Type `PasskeyCredential` has no field `publicKeyY`' },
];

describe('strict serving GraphQL compatibility and selector parity', () => {
  it('pins independent identical Gnosis/Arbitrum schema provenance and missing-key capability', () => {
    expect(hash(fixture('schema.graphql'))).toBe(provenance.sha256);
    expect(provenance.fullIntrospectionSha256).toBe('2fefb5c645d84d3a8c65f1f8522fe016ef6a64cca2441b21bcfabb43c14b3047');
    expect(provenance.sources.map((s: { chainId: number }) => s.chainId)).toEqual([100, 42161]);
    expect(schema.getType('PasskeyCredential')).toBeDefined();
  });
  it('retains reviewed names/tiers/selectors/entity fields and adds only same-block metadata', () => {
    expect(Object.keys(docs).sort()).toEqual(Object.keys(contracts).sort());
    for (const [name, doc] of Object.entries(docs)) {
      if (addedMeta(name)) {
        const operation = parse(doc).definitions.find(d => d.kind === Kind.OPERATION_DEFINITION);
        if (!operation || operation.kind !== Kind.OPERATION_DEFINITION) throw new Error('Missing operation');
        const selections = operation.selectionSet.selections.filter(f => f.kind === Kind.FIELD && f.name.value === '_meta');
        expect(selections, name).toHaveLength(1);
        expect(print(selections[0]), name).toBe('_meta(block: $block) {\n  block {\n    number\n    hash\n    timestamp\n  }\n}');
      }
      expect(hash(normalized(addedMeta(name) ? originalSelections(doc) : doc)), name).toBe(contracts[name]);
    }
  });
  for (const [name, doc] of Object.entries(docs)) it(`${name} validates arguments and variable positions against serving schema`, () => {
    const errors = validate(schema, parse(doc)).map(e => e.message);
    if (/\bpublicKeyX\b/.test(doc)) {
      expect(errors).toEqual([
        'Cannot query field "publicKeyX" on type "PasskeyCredential".',
        'Cannot query field "publicKeyY" on type "PasskeyCredential".',
      ]);
      expect(validate(modernSchema, parse(doc)).map(e => e.message)).toEqual([]);
    } else expect(errors).toEqual([]);
  });
  it('rejects scalar counterexamples while retaining real Bytes filters/cursors', () => {
    for (const [doc, before, bad] of [
      [authority.FETCH_ORG_AUTHORITY, '$id: ID!', '$id: Bytes!'],
      [authority.FETCH_AUTHORITY_SUBJECTS_PAGE, '$orgId: String!', '$orgId: Bytes!'],
      [accounts.FETCH_CREDENTIAL_PAGE_LEGACY, '$account: String!', '$account: Bytes!'],
      [protocol.FETCH_PROTOCOL_ORGS_PAGE, '$hub: String!', '$hub: Bytes!'],
      [paymaster.FETCH_PAYMASTER_DEPOSITS_PAGE, '$hub: String!', '$hub: Bytes!'],
      [zkemail.FETCH_ZKEMAIL_ACTIVE_ROOT, '$orgId: ID!', '$orgId: Bytes!'],
    ]) {
      expect(doc).toContain(before);
      expect(validate(schema, parse(doc.replace(before, bad))).some(e => /used in position expecting type/.test(e.message))).toBe(true);
    }
    expect(accounts.FETCH_ACCOUNT_FACTS).toContain('$account: Bytes!');
    expect(accounts.FETCH_FACTORY_FACTS).toContain('$registry: Bytes!');
    expect(accounts.FETCH_CREDENTIAL_DISCOVERY_PAGE).toContain('$credentialId: Bytes!');
    expect(paymaster.FETCH_PAYMASTER_STATE).toContain('$orgId: Bytes!');
    expect(protocol.FETCH_BEACON_EVENTS_PAGE).toContain('$cursor: Bytes!');
    expect(validate(schema, parse(accounts.FETCH_ACCOUNT_FACTS.replace('$account: Bytes!', '$account: String!')))).not.toHaveLength(0);
  });
});

describe('credential capability fallback using observed serving responses', () => {
  for (const chainId of [100, 42161]) for (const discovery of [false, true]) {
    for (const transport of ['returned-errors', 'thrown-message', 'thrown-response', 'thrown-envelope'] as const) {
      it(`chain=${chainId} discovery=${discovery} ${transport} uses legacy tier with unchanged scope/variables`, async () => {
        const name = discovery ? 'accounts/FETCH_CREDENTIAL_DISCOVERY_PAGE' : 'accounts/FETCH_CREDENTIAL_PAGE';
        const observed = replay.results.find((r: any) => r.chainId === chainId && r.name === name);
        const legacy = replay.results.find((r: any) => r.chainId === chainId && r.name === 'accounts/FETCH_CREDENTIAL_PAGE_LEGACY').response.data;
        const src = source(chainId, discovery);
        const query = vi.fn<Parameters<ProtocolQuery>, ReturnType<ProtocolQuery>>(async () => {
          if (query.mock.calls.length === 1) {
            if (transport === 'thrown-message') throw new Error(observed.response.errors.map((e: any) => e.message).join('; '));
            if (transport === 'thrown-response') throw new GraphRequestError(observed.response.errors[0].message, { status: 200, errors: observed.response.errors });
            if (transport === 'thrown-envelope') throw { errors: observed.response.errors };
            return observed.response;
          }
          return withBlockProof(legacy, chainId);
        });
        const result = await readCredentialFacts({ source: src, query, pageSize: 10, ...(discovery ? { credentialId: CREDENTIAL } : {}) });
        expect(result.coverage.status).toBe('complete');
        expect(result.data).toEqual(legacy.passkeyCredentials);
        expect(result.source).toBe(src);
        expect(query).toHaveBeenCalledTimes(2);
        expect(query.mock.calls[0][0]).toBe(discovery ? accounts.FETCH_CREDENTIAL_DISCOVERY_PAGE : accounts.FETCH_CREDENTIAL_PAGE);
        expect(query.mock.calls[1][0]).toBe(discovery ? accounts.FETCH_CREDENTIAL_DISCOVERY_PAGE_TIERS[1] : accounts.FETCH_CREDENTIAL_PAGE_LEGACY);
        const variables = { ...(discovery ? { credentialId: CREDENTIAL } : { account: ACCOUNT }), block: { number: Number(src.block!.number) }, cursor: '', first: 10 };
        for (const call of query.mock.calls) { expect(call[1]).toEqual(variables); expect(call[2]).toBe(src); }
        for (const raw of result.data) {
          const facts = projectCredentialFacts(raw, { ...result.source, account: ACCOUNT });
          expect(facts.publicKeyX.state).toBe('unknown'); expect(facts.publicKeyY.state).toBe('unknown');
          expect(facts.active).toEqual(knownFact(raw.active as boolean, { ...src, account: ACCOUNT }));
        }
      });
    }
  }
  for (const message of ['Cannot query field "publicKeyX"', 'Cannot query field "publicKeyY" on type "PasskeyCredential".', 'Type `PasskeyCredential` has no field `publicKeyX`']) {
    it(`retains recognized prior/serving capability message: ${message}`, async () => {
      const query = vi.fn(async () => { if (query.mock.calls.length === 1) throw new Error(message); return withBlockProof({ passkeyCredentials: [] }); });
      expect((await readCredentialFacts({ source: source(), query })).coverage.status).toBe('complete');
      expect(query).toHaveBeenCalledTimes(2);
    });
  }
  const failures: [string, unknown][] = [
    ['transport', new Error('fetch failed')],
    ['unrelated field', { errors: [{ message: 'Cannot query field "guardian" on type "PasskeyAccount".' }] }],
    ['wrong parent type', { errors: [{ message: 'Type `OtherType` has no field `publicKeyX`' }] }],
    ['wrong quoted parent', { errors: [{ message: 'Cannot query field "publicKeyX" on type "OtherType".' }] }],
    ['mixed returned schema/execution errors', { errors: [...keyErrors, { message: 'database unavailable' }] }],
    ['mixed prior quoted errors', { errors: [{ message: 'Cannot query field "publicKeyX" on type "PasskeyCredential".' }, { message: 'database unavailable' }] }],
    ['mixed prior quoted thrown response', new GraphRequestError('Cannot query field "publicKeyX"', { status: 200, errors: [{ message: 'Cannot query field "publicKeyX"' }, { message: 'database unavailable' }] })],
    ['mixed thrown response', new GraphRequestError(keyErrors[0].message, { status: 200, errors: [...keyErrors, { message: 'database unavailable' }] })],
    ['mixed joined message', new Error(keyErrors.map(e => e.message).join('; ') + '; socket hang up')],
    ['HTTP transport status', new GraphRequestError(keyErrors[0].message, { status: 503, errors: keyErrors })],
    ['returned HTTP transport status', { httpStatus: 503, errors: keyErrors }],
    ['malformed HTTP transport status', { status: NaN, errors: keyErrors }],
    ['malformed errors entry', { errors: [keyErrors[0], null] }],
    ['malformed thrown response errors', Object.assign(new Error(keyErrors[0].message), { response: { errors: 'invalid' } })],
    ['empty thrown response errors', Object.assign(new Error(keyErrors[0].message), { response: { errors: [] } })],
    ['explicit transport cause', Object.assign(new Error(keyErrors[0].message), { cause: new Error('socket hang up'), response: { errors: keyErrors } })],
    ['returned mixed response error', { errors: keyErrors, error: 'gateway timeout' }],
  ];
  for (const [name, failure] of failures) for (const discovery of [false, true]) it(`${name}, discovery=${discovery}: no fallback can conceal failure`, async () => {
    const query = vi.fn(async () => {
      if (failure instanceof Error || name.startsWith('malformed thrown') || name.startsWith('empty thrown')) throw failure;
      return failure as Record<string, unknown>;
    });
    const result = await readCredentialFacts({ source: source(100, discovery), query, ...(discovery ? { credentialId: CREDENTIAL } : {}) });
    expect(query).toHaveBeenCalledTimes(1); expect(result.data).toEqual([]); expect(result.coverage.status).toBe('unavailable');
    expect(result.coverage.failedIds).toEqual(['page:1']);
  });
  for (const discovery of [false, true]) it(`modern key-capable responses, discovery=${discovery}, keep known exact keys and make no fallback request`, async () => {
    const raw = { ...row(), publicKeyX: KEY_X, publicKeyY: KEY_Y };
    const query = vi.fn(async () => withBlockProof({ passkeyCredentials: [raw] }));
    const src = source(100, discovery); const result = await readCredentialFacts({ source: src, query, ...(discovery ? { credentialId: CREDENTIAL } : {}) });
    expect(query).toHaveBeenCalledTimes(1); expect(result.coverage.status).toBe('complete');
    const accountSource = { ...src, account: ACCOUNT };
    expect(projectCredentialFacts(result.data[0], accountSource).publicKeyX).toEqual(knownFact(KEY_X, accountSource));
    expect(projectCredentialFacts(result.data[0], accountSource).publicKeyY).toEqual(knownFact(KEY_Y, accountSource));
  });
  for (const end of ['complete', 'failure', 'cap', 'missing', 'bad-scope', 'mixed-errors'] as const) it(`legacy paging preserves revoked rows, cursor and ${end} completeness`, async () => {
    const rows = [row('credential-001', false), row('credential-002')];
    const query = vi.fn<Parameters<ProtocolQuery>, ReturnType<ProtocolQuery>>(async (doc, variables) => {
      if (doc === accounts.FETCH_CREDENTIAL_PAGE) return { errors: keyErrors };
      if (variables.cursor === '') return withBlockProof({ passkeyCredentials: rows });
      if (end === 'failure') throw new Error('transport failed on page two');
      if (end === 'missing') return withBlockProof({});
      if (end === 'bad-scope') return withBlockProof({ passkeyCredentials: [{ ...row('credential-003'), account: { id: '0x' + '22'.repeat(20) } }] });
      if (end === 'mixed-errors') return { errors: [...keyErrors, { message: 'database failed' }] };
      return withBlockProof({ passkeyCredentials: [] });
    });
    const src = source(); const result = await readCredentialFacts({ source: src, query, pageSize: 2, maxPages: end === 'cap' ? 1 : 10 });
    expect(result.source).toBe(src); expect(result.data.slice(0, 2)).toEqual(rows);
    expect(result.coverage.status).toBe(end === 'complete' ? 'complete' : 'incomplete');
    expect(result.coverage.cursor).toBe(end === 'bad-scope' ? 'credential-003' : 'credential-002');
    expect(projectCredentialFacts(result.data[0], src)).toMatchObject({ active: { state: 'known', value: false }, publicKeyX: { state: 'unknown' }, publicKeyY: { state: 'unknown' }, removedAt: { state: 'known', value: '1777253651' } });
    expect(result.data[0].signCount).toBe('9007199254740993');
    expect(query.mock.calls[1][1].cursor).toBe('');
    if (end !== 'cap') expect(query.mock.calls[2][1]).toMatchObject({ cursor: 'credential-002', first: 2 });
  });
  it('failed legacy tier stops after one fallback instead of retrying another tier', async () => {
    const query = vi.fn(async () => { if (query.mock.calls.length === 1) throw new Error(keyErrors[0].message); throw new Error('legacy transport failed'); });
    expect((await readCredentialFacts({ source: source(), query })).coverage.status).toBe('unavailable');
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('a later mixed modern page stays incomplete and preserves prior rows without a legacy request', async () => {
    const rows = [row('credential-001', false), row('credential-002')];
    const query = vi.fn(async (_doc: string, variables: Record<string, unknown>) => variables.cursor === ''
      ? withBlockProof({ passkeyCredentials: rows })
      : { errors: [{ message: 'Cannot query field "publicKeyX"' }, { message: 'database unavailable' }] });
    const result = await readCredentialFacts({ source: source(), query, pageSize: 2 });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.every(call => call[0] === accounts.FETCH_CREDENTIAL_PAGE)).toBe(true);
    expect(result.data).toEqual(rows); expect(result.coverage.status).toBe('incomplete');
    expect(result.coverage.cursor).toBe('credential-002'); expect(result.coverage.failedIds).toEqual(['page:2']);
  });
});
