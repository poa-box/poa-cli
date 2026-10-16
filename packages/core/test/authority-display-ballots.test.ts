import { describe, expect, it } from 'vitest';
import { buildSchema, Kind, parse, validate } from 'graphql';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { SourceRef, requireCompleteSnapshot } from '../src/data/facts';
import { ProtocolQuery } from '../src/reads/protocol';
import { ProposalBallotOptions, readProposalBallotFacts } from '../src/reads/vote';
import { FETCH_AUTHORITY_CONFIG_LINTS_RECENT, FETCH_AUTHORITY_MEMBERSHIP_EVENTS_RECENT } from '../src/graph/documents/authority';
import { FETCH_DD_PROPOSAL_BALLOTS_PAGE, FETCH_HYBRID_PROPOSAL_BALLOTS_PAGE } from '../src/graph/documents/voting-classes';

const ORG = `0x${'ab'.repeat(32)}`, MODULE = `0x${'cd'.repeat(20)}`, OTHER = `0x${'ef'.repeat(20)}`;
const HASH = `0x${'12'.repeat(32)}`, TX = `0x${'34'.repeat(32)}`;
const ID = '9007199254740993123456789';
const source: SourceRef = { chainId: 100, orgId: ORG, contract: MODULE, endpoint: 'fixture://ballots', method: 'proposal-ballots',
  indexed: true, snapshot: 'pinned', block: { number: '1234', hash: HASH, timestamp: '10000' } };
const meta = { block: { number: 1234, hash: HASH, timestamp: 10000 } };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
type Lane = 'hybrid' | 'dd';
function fixture(lane: Lane, count = 3, change?: (response: any, page: number) => void) {
  const moduleKey = lane === 'hybrid' ? 'hybridVoting' : 'directDemocracyVoting';
  const parents = lane === 'hybrid' ? 'proposals' : 'ddvproposals', collection = lane === 'hybrid' ? 'votes' : 'ddvvotes';
  const parent = { id: `${MODULE}-${ID}`, proposalId: ID, numOptions: 3, createdAtBlock: '1000',
    [moduleKey]: { id: MODULE, organization: { id: ORG } } };
  const rows = Array.from({ length: count }, (_, i) => {
    const voter = `0x${(i + 1).toString(16).padStart(40, '0')}`;
    return { id: `${parent.id}-${voter}`, voter, voterUsername: i ? 'voter' : null, optionIndexes: [2, 0, 1], optionWeights: [33, 67, 0],
      ...(lane === 'hybrid' ? { classRawPowers: ['900719925474099312345678901', ((1n << 256n) - 1n).toString(), '0'] } : {}),
      votedAt: '9999', votedAtBlock: '1230', transactionHash: TX, proposal: parent };
  });
  const calls: { document: string; variables: Record<string, unknown>; source: SourceRef }[] = [];
  const query: ProtocolQuery = async (document, variables, src) => {
    calls.push({ document, variables, source: src });
    const response = clone({ _meta: meta, organization: { id: ORG, [moduleKey]: { id: MODULE } }, [parents]: [parent],
      [collection]: rows.filter(row => row.id > String(variables.cursor)).slice(0, Number(variables.first)) });
    change?.(response, calls.length);
    return response;
  };
  const options: ProposalBallotOptions = { source, query, lane, proposalId: ID, pageSize: 2, maxPages: 5 };
  return { options, calls, rows, parent, parents, collection, moduleKey };
}

describe.each(['hybrid', 'dd'] as const)('%s complete scoped ballot evidence', lane => {
  it.each([0, 1, 3, 4])('enumerates %i ballots with exact values and terminal cursor proof', async count => {
    const f = fixture(lane, count), result = await readProposalBallotFacts(f.options);
    expect(requireCompleteSnapshot(result, { scope: source, snapshot: 'pinned', block: source.block })).toEqual(f.rows);
    expect(result.coverage).toMatchObject({ pages: Math.floor(count / 2) + 1, cap: 10, cursor: f.rows.at(-1)?.id ?? '' });
    expect(f.calls).toHaveLength(Math.floor(count / 2) + 1);
    for (const call of f.calls) {
      expect(call.document).toBe(lane === 'hybrid' ? FETCH_HYBRID_PROPOSAL_BALLOTS_PAGE : FETCH_DD_PROPOSAL_BALLOTS_PAGE);
      expect(call.variables).toEqual({ block: { hash: HASH }, orgId: ORG, compositeId: `${MODULE}-${ID}`,
        cursor: call === f.calls[0] ? '' : f.rows[f.calls.indexOf(call) * 2 - 1].id, first: 2 });
      expect(call.source).toBe(source);
    }
  });
  it('retains a full bounded final page without claiming completion', async () => {
    const f = fixture(lane, 4);
    const result = await readProposalBallotFacts({ ...f.options, maxPages: 2 });
    expect(result.data).toEqual(f.rows); expect(result.coverage).toMatchObject({ status: 'incomplete', pages: 2, cap: 4, issues: [{ code: 'PAGE_CAP' }] });
  });
  it.each(['org', 'module', 'absent', 'ambiguous', 'proposal', 'numOptions', 'createdAtBlock', 'futureCreation'])('rejects %s binding on the terminal empty page', async kind => {
    const f = fixture(lane, 2, (r, page) => { if (page !== 2) return;
      const parents = r[lane === 'hybrid' ? 'proposals' : 'ddvproposals'];
      if (kind === 'org') r.organization.id = 'another-org';
      if (kind === 'module') r.organization[lane === 'hybrid' ? 'hybridVoting' : 'directDemocracyVoting'].id = OTHER;
      if (kind === 'absent') parents.pop();
      if (kind === 'ambiguous') parents.push(parents[0]);
      if (kind === 'proposal') parents[0].proposalId = '1';
      if (kind === 'numOptions') parents[0].numOptions = 2;
      if (kind === 'createdAtBlock') parents[0].createdAtBlock = '999';
      if (kind === 'futureCreation') parents[0].createdAtBlock = '1235';
    });
    const result = await readProposalBallotFacts(f.options);
    expect(result.coverage.status).toBe('incomplete');
    expect(result.coverage.issues).toContainEqual({ code: 'BALLOT_PROPOSAL_BINDING_MISMATCH' });
    expect(() => requireCompleteSnapshot(result)).toThrow();
  });
  it.each(['number', 'hash', 'missing', 'timestamp'])('rejects %s metadata on the terminal empty page', async kind => {
    const f = fixture(lane, 2, (r, page) => { if (page !== 2) return;
      if (kind === 'missing') delete r._meta;
      else r._meta.block[kind] = kind === 'hash' ? TX : 0;
    });
    const result = await readProposalBallotFacts(f.options);
    expect(result.coverage.status).toBe('incomplete');
    expect(result.coverage.issues.some(i => /^BLOCK_EVIDENCE/.test(i.code))).toBe(true);
  });
  it('does not attest empty ballots without first-page block or proposal evidence', async () => {
    for (const change of [(r: any) => { delete r._meta; }, (r: any) => { r[lane === 'hybrid' ? 'proposals' : 'ddvproposals'] = []; }]) {
      const f = fixture(lane, 0, change), result = await readProposalBallotFacts(f.options);
      expect(result.coverage.status).toBe('unavailable'); expect(result.source.snapshot).toBe('unknown');
    }
  });
  it.each(['proposal', 'module', 'org', 'identity', 'voter', 'weights', 'weightStrings', 'indices', 'indexStrings', 'indexRange',
    'timestamp', 'futureBlock', 'precreationBlock', 'transaction', 'missingCollection', 'graphqlError', 'repeatCursor'])('rejects %s rows/transport', async kind => {
    const f = fixture(lane, 3, (r, page) => {
      const key = lane === 'hybrid' ? 'votes' : 'ddvvotes', row = r[key][0];
      if (kind === 'repeatCursor') { if (page === 2) { r[key] = [clone(f.rows[0])]; } return; }
      if (page !== 1) return;
      if (kind === 'proposal') row.proposal.id = `${MODULE}-1`;
      if (kind === 'module') row.proposal[lane === 'hybrid' ? 'hybridVoting' : 'directDemocracyVoting'].id = OTHER;
      if (kind === 'org') row.proposal[lane === 'hybrid' ? 'hybridVoting' : 'directDemocracyVoting'].organization.id = 'other';
      if (kind === 'identity') row.id += '-foreign';
      if (kind === 'voter') row.voter = 'invalid';
      if (kind === 'weights') row.optionWeights = [33, 66, 0];
      if (kind === 'weightStrings') row.optionWeights = ['33', '67', '0'];
      if (kind === 'indices') row.optionIndexes = [0, 0, 1];
      if (kind === 'indexStrings') row.optionIndexes = ['2', '0', '1'];
      if (kind === 'indexRange') row.optionIndexes = [3, 0, 1];
      if (kind === 'timestamp') row.votedAt = null;
      if (kind === 'futureBlock') row.votedAtBlock = '1235';
      if (kind === 'precreationBlock') row.votedAtBlock = '999';
      if (kind === 'transaction') row.transactionHash = '0x1';
      if (kind === 'missingCollection') delete r[key];
      if (kind === 'graphqlError') r.errors = [{ message: 'fixture failure' }];
    });
    const result = await readProposalBallotFacts(f.options);
    expect(result.coverage.status).not.toBe('complete'); expect(() => requireCompleteSnapshot(result)).toThrow();
  });
  it.each([{ pageSize: 0 }, { pageSize: 1001 }, { maxPages: 1001 }, { maxPages: 0 }, { maxPages: 1.5 }, { proposalId: '1.5' },
    { proposalId: '1e5' }, { proposalId: (1n << 256n).toString() }, { proposalId: 9007199254740992 }])('rejects invalid options %j before transport', async patch => {
    const f = fixture(lane);
    await expect(readProposalBallotFacts({ ...f.options, ...patch } as ProposalBallotOptions)).rejects.toThrow(); expect(f.calls).toEqual([]);
  });
  it.each([{ snapshot: 'latest' }, { indexed: false }, { contract: undefined }, { orgId: undefined }, { block: undefined }])('rejects invalid source %j before transport', async patch => {
    const f = fixture(lane);
    await expect(readProposalBallotFacts({ ...f.options, source: { ...source, ...patch } as SourceRef })).rejects.toThrow(); expect(f.calls).toEqual([]);
  });
});

it.each([undefined, [], ['-1'], ['1.5'], [1], [(1n << 256n).toString()], Array(9).fill('1')])('Hybrid malformed raw powers %j remain incomplete', async value => {
  const f = fixture('hybrid', 1, r => { r.votes[0].classRawPowers = value; });
  expect((await readProposalBallotFacts(f.options)).coverage.status).toBe('incomplete');
});

describe('canonical display/ballot serving-schema and scalar contracts', () => {
  const base = new URL('./fixtures/core-update/authority/', import.meta.url);
  const fixtureText = readFileSync(new URL('display-ballots-serving-schema.graphql', base), 'utf8');
  const schema = buildSchema(fixtureText);
  const documents = { FETCH_AUTHORITY_CONFIG_LINTS_RECENT, FETCH_AUTHORITY_MEMBERSHIP_EVENTS_RECENT,
    FETCH_DD_PROPOSAL_BALLOTS_PAGE, FETCH_HYBRID_PROPOSAL_BALLOTS_PAGE };
  it('pins fixture provenance and copies only exact entity definitions from the cached source', () => {
    const provenance = JSON.parse(readFileSync(new URL('display-ballots-provenance.json', base), 'utf8'));
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(sha(fixtureText)).toBe(provenance.fixture.sha256);
    expect(provenance.sourceEntitySchema.sha256).toBe('5f9d3a3fcfceabcb81ffa8bb847e954ef50bf32df2c5fc68d0184a32f9c76a3c');
    const entity = readFileSync(new URL('schema.graphql', base), 'utf8');
    expect(entity).toContain('type SubjectMembershipEvent @entity(immutable: true)');
    expect(entity).toContain('type ConfigLintEvent @entity(immutable: true)');
    expect(schema.getType('SubjectMembershipEvent')!.toString()).toBe('SubjectMembershipEvent');
  });
  for (const [name, document] of Object.entries(documents)) it(`${name} validates and uses one $block on every root selection`, () => {
    expect(validate(schema, parse(document))).toEqual([]);
    const op = parse(document).definitions[0]; if (op.kind !== Kind.OPERATION_DEFINITION) throw new Error('Query expected');
    for (const field of op.selectionSet.selections) {
      if (field.kind !== Kind.FIELD) throw new Error('Root field expected');
      const block = field.arguments?.find(a => a.name.value === 'block')?.value;
      expect(block?.kind).toBe(Kind.VARIABLE); if (block?.kind === Kind.VARIABLE) expect(block.name.value).toBe('block');
    }
  });
  it.each([[FETCH_AUTHORITY_MEMBERSHIP_EVENTS_RECENT, 50, 'timestamp'], [FETCH_AUTHORITY_CONFIG_LINTS_RECENT, 200, 'emittedAt']] as const)(
    'retains bounded recent-window defaults/scalars/order (%i)', (document, first, order) => {
      const op = parse(document).definitions[0]; if (op.kind !== Kind.OPERATION_DEFINITION) throw new Error('Query expected');
      expect(op.variableDefinitions?.find(v => v.variable.name.value === 'first')?.defaultValue).toMatchObject({ kind: Kind.INT, value: String(first) });
      expect(document).toContain(`orderBy: ${order}, orderDirection: desc`);
      expect(validate(schema, parse(document.replace('$authority: String!', '$authority: Bytes!'))).length).toBeGreaterThan(0);
    });
  it('enforces generated String relation filters and Int vectors, not invented DD fields', () => {
    expect(validate(schema, parse(FETCH_DD_PROPOSAL_BALLOTS_PAGE.replace('$compositeId: String!', '$compositeId: BigInt!'))).length).toBeGreaterThan(0);
    expect(FETCH_DD_PROPOSAL_BALLOTS_PAGE).not.toContain('classRawPowers');
    expect(String((schema.getType('Vote') as any).getFields().optionWeights.type)).toBe('[Int!]!');
    expect(String((schema.getType('Vote') as any).getFields().classRawPowers.type)).toBe('[BigInt!]!');
  });
  it('retains exact display fields and nullable lint subjects/actors/bans', () => {
    const selections = (doc: string, collection: string) => {
      const op = parse(doc).definitions[0]; if (op.kind !== Kind.OPERATION_DEFINITION) throw new Error('Query expected');
      const field = op.selectionSet.selections.find(s => s.kind === Kind.FIELD && s.name.value === collection);
      if (field?.kind !== Kind.FIELD) throw new Error('Collection expected');
      return field.selectionSet!.selections.map(s => s.kind === Kind.FIELD ? s.name.value : '');
    };
    expect(selections(FETCH_AUTHORITY_MEMBERSHIP_EVENTS_RECENT, 'subjectMembershipEvents'))
      .toEqual(['id', 'action', 'user', 'userUsername', 'actor', 'actorUsername', 'banned', 'delegated', 'timestamp', 'transactionHash', 'subject']);
    expect(selections(FETCH_AUTHORITY_CONFIG_LINTS_RECENT, 'configLintEvents')).toEqual(['id', 'code', 'lintCode', 'subjectId', 'emittedAt', 'subject']);
    expect(String((schema.getType('ConfigLintEvent') as any).getFields().subject.type)).toBe('Subject');
    expect(String((schema.getType('SubjectMembershipEvent') as any).getFields().actor.type)).toBe('Bytes');
    expect(String((schema.getType('SubjectMembershipEvent') as any).getFields().banned.type)).toBe('Boolean');
  });
});

describe('new public browser leaves', () => {
  it.each(['governance/dd-authorization', 'reads/vote', 'tx/paymaster', 'graph/documents/authority', 'graph/documents/voting-classes'])(
    '%s bundles for browser without Node or optional executors', async leaf => {
      const result = await build({ entryPoints: [resolve(__dirname, `../src/${leaf}.ts`)], bundle: true,
        platform: 'browser', format: 'esm', write: false, metafile: true });
      expect(Object.keys(result.metafile!.inputs).filter(path => /\/execute\/|\/viem\/|\/permissionless\/|src\/index\.ts/.test(path))).toEqual([]);
      expect(result.outputFiles[0].text.length).toBeGreaterThan(0);
    });
});
