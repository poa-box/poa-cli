import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { buildSchema, execute, parse, validate, visit } from 'graphql';
import * as identityDocs from '../src/graph/documents/identity';
import * as orgDocs from '../src/graph/documents/org';
import { FETCH_USER_DATA, FETCH_USER_DATA_WITH_CHURN } from '../src/graph/documents/user';
import { readIdentityFacts, lookupIdentityFact } from '../src/reads/identity';
import { readOrganizationDirectoryFacts, readOrganizationTaskCounts, readMembershipCardFacts } from '../src/reads/org';
import { getOrgUserProfile, isIndexedOrgUser } from '../src/reads/user';
import { projectAuthorityUsers } from '../src/reads/authority';
import { buildUserProfileMetadata, replaceUserProfileMetadata, serializeUserProfileMetadata, USER_PROFILE_FIELDS } from '../src/metadata/user';
import { preparedProfileMetadataIntent, changeUsernameIntent, buildChangeUsername, setProfileMetadataIntent } from '../src/tx/user';
import { SourceRef, requireCompleteSnapshot } from '../src/data/facts';
import { composeSubjectId, HATS_NAMESPACE_FLOOR } from '../src/authority/ids';
import { ProtocolQuery } from '../src/reads/protocol';
import { assertServingCapabilities } from './fixtures/core-update/identity/serving-capability';
import { HOME_CHAIN_ID } from '../src/chains';

const fixture = (file: string) => readFileSync(new URL(`./fixtures/core-update/identity/${file}`, import.meta.url), 'utf8');
const schema = buildSchema(fixture('serving-schema.graphql'));
const provenance = JSON.parse(fixture('provenance.json'));
const account = '0x' + '11'.repeat(20), registry = '0x' + '22'.repeat(20), authority = '0x' + '33'.repeat(20);
const orgId = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const src = (chainId = 100, method = 'fixture-read', extra: Partial<SourceRef> = {}): SourceRef => ({ chainId, method, endpoint: `fixture://chain-${chainId}`, indexed: true, snapshot: 'latest', ...extra });
const ready = { id: authority, isRouterBound: true, cutoverAt: '123' };
const org = (n: number, supported = true, flag: boolean | null = false, symbol = 'MiXeD') => ({
  id: orgId(n), name: 'SameName', deployedAt: '1', metadataHash: null,
  metadata: { id: `metadata-${n}`, logo: 'logo-cid', description: 'Description', backgroundColor: null, useTokenSymbol: flag },
  membershipAuthority: supported ? ready : null,
  participationToken: { id: registry, name: 'Participation', symbol, totalSupply: '900719925474099312345' }, taskManager: { id: addr(1000 + n), organization: { id: orgId(n) } },
});
const metadata = { id: 'metadata', bio: 'old bio', avatar: 'old avatar', github: 'old github', twitter: 'old twitter', website: 'old website' };
const identity = (n: number, reg = registry, username = 'same_name') => ({
  id: addr(n), user: addr(n), username, isDeleted: false, registry: { id: reg }, profileMetadataHash: null,
  registeredAt: '101', registeredAtBlock: '201', lastUpdatedAt: '301', metadata,
});
const history = (n = 1) => ({ id: `${orgId(n)}-${account}`, address: account, firstSeenAt: '1500000000', lastActiveAt: '1700000000',
  participationTokenBalance: '900719925474099312345', totalTasksCompleted: '7', totalVotes: '0', totalModulesCompleted: '3', organization: org(n) });
const membership = (n = 1, userEntity: ReturnType<typeof history> | null = null) => ({
  id: `member-${String(n).padStart(4, '0')}`, user: account, accepted: true, eligible: true, isMember: true, claimable: false,
  acceptedAt: '1', seededWhilePaused: true, ruleKind: 'Grant', emailVerified: false, vouchCount: 0, vouchEpoch: '0', vouchMet: false,
  eligibilitySource: 'ExplicitGrant', subject: { kind: 'Role', subjectId: composeSubjectId(authority, n), defaultAllow: false, vouchConfig: null },
  organization: org(n), userEntity,
});
const executeQuery = (roots: Record<string, unknown>): ProtocolQuery => async (document, variables) => {
  assertServingCapabilities(document, variables);
  const errors = validate(schema, parse(document));
  if (errors.length) throw new Error(errors.map(error => error.message).join('; '));
  const result = await execute({ schema, document: parse(document), rootValue: roots, variableValues: variables });
  if (result.errors) throw new Error(result.errors.map(error => error.message).join('; '));
  return result.data as Record<string, unknown>;
};
const slicePage = <T extends { id: string }>(rows: T[], args: any) => rows.filter(row => row.id > args.where.id_gt).slice(0, args.first);
const oldFields = { bio: 'B', avatar: 'A', github: 'G', twitter: 'T', website: 'W', extension: 'not a profile field' };
const VALID_CID = 'QmYwAPJzv5CZsnAzt8auVTL9LRzViHWGLJ1EKCwBYV3H5r';

const newDocs = {
  ...identityDocs,
  FETCH_ORG_DIRECTORY_PAGE: orgDocs.FETCH_ORG_DIRECTORY_PAGE,
  FETCH_ORG_TASK_COUNT_PAGE: orgDocs.FETCH_ORG_TASK_COUNT_PAGE,
  FETCH_AUTHORITY_MEMBERSHIP_CARDS_PAGE: orgDocs.FETCH_AUTHORITY_MEMBERSHIP_CARDS_PAGE,
  FETCH_USER_MEMBERSHIP_HISTORY_PAGE: orgDocs.FETCH_USER_MEMBERSHIP_HISTORY_PAGE,
};

describe('serving schema and user assignment regressions', () => {
  it('pins portable two-source serving-schema provenance', () => {
    expect(createHash('sha256').update(fixture('schema.graphql')).digest('hex')).toBe(provenance.sha256);
    expect(provenance.fullIntrospectionSha256).toBe('2fefb5c645d84d3a8c65f1f8522fe016ef6a64cca2441b21bcfabb43c14b3047');
    expect(provenance.sources.map((source: any) => source.chainId)).toEqual([100, 42161]);
  });
  for (const [name, document] of Object.entries({ ...newDocs, FETCH_USER_DATA, FETCH_USER_DATA_WITH_CHURN })) it(`${name}: full argument/variable-position validation`, () => {
    expect(validate(schema, parse(document)).map(error => error.message)).toEqual([]);
  });
  it('rejects output-scalar-as-filter and cursor-type counterexamples', () => {
    expect(validate(schema, parse(identityDocs.SEARCH_ACCOUNTS_PAGE.replace('$registry: String!', '$registry: Bytes!')))).not.toHaveLength(0);
    expect(validate(schema, parse(orgDocs.FETCH_ORG_DIRECTORY_PAGE.replace('$cursor: Bytes!', '$cursor: String!')))).not.toHaveLength(0);
    expect(validate(schema, parse(orgDocs.FETCH_ORG_TASK_COUNT_PAGE.replace('$taskManagers: [Bytes!]!', '$taskManagers: [String!]!')))).not.toHaveLength(0);
  });
  it('retains the reviewed baseline counterexample: missing deleted-project filter and invalid singleton scalar positions', () => {
    const old = fixture('baseline-user-data.graphql');
    let assignments: any;
    visit(parse(old), { Field(node) { if (node.name.value === 'assignedTasks') assignments = node; } });
    expect(assignments.arguments.map((argument: any) => argument.name.value)).toEqual(['first']);
    expect(validate(schema, parse(old)).map(error => error.message)).toEqual([
      'Variable "$orgUserID" of type "String!" used in position expecting type "ID!".',
      'Variable "$userAddress" of type "Bytes!" used in position expecting type "ID!".',
    ]);
    expect(JSON.parse(fixture('baseline-provenance.json')).coreCommit).toBe('29f76287743d0cac43533f3683992d1c8ecc48e8');
  });
  for (const document of [FETCH_USER_DATA, FETCH_USER_DATA_WITH_CHURN]) it(`tier ${document === FETCH_USER_DATA ? 'base' : 'churn'} excludes deleted-project assignments and retains completed work and lessons`, async () => {
    let assignmentArgs: any;
    const task = (id: string, deleted: boolean) => ({ id, taskId: id, title: id, payout: '0', status: 'Assigned', project: { deleted } });
    const tasks = [task('1', true), task('2', false)];
    const roots = { user: () => ({ id: 'profile', address: account, participationTokenBalance: '0', membershipStatus: 'Inactive', currentHatIds: [], joinMethod: 'QuickJoin',
      totalTasksCompleted: '1', totalTasksReleased: '0', totalTasksLostToExpiry: '0', totalVotes: '0', totalModulesCompleted: '1', firstSeenAt: '1', lastActiveAt: '2',
      assignedTasks: (args: any) => { assignmentArgs = args; return tasks.filter(row => args.where?.project_?.deleted === undefined || row.project.deleted === args.where.project_.deleted).slice(0, args.first); },
      completedTasks: [task('3', true)], hybridProposalsCreated: [], modulesCompleted: [{ moduleId: '1', completedAt: '2' }],
    }), account: () => ({ id: account, username: 'tester' }) };
    const result = await executeQuery(roots)(document, { orgUserID: 'profile', userAddress: account }, src());
    expect(assignmentArgs).toEqual({ first: 20, where: { project_: { deleted: false } } });
    expect((result.user as any).assignedTasks.map((row: any) => row.id)).toEqual(['2']);
    expect((result.user as any).completedTasks.map((row: any) => row.id)).toEqual(['3']);
    expect((result.user as any).modulesCompleted).toEqual([{ moduleId: '1', completedAt: '2' }]);
  });
});

describe('complete directory and task count streams', () => {
  it('traverses 250 orgs and a whole retired page before filtering, with one directory stream', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => org(i + 1, i < 100 || i >= 200));
    const query = vi.fn(executeQuery({ organizations: (args: any) => slicePage(rows, args) }));
    const result = await readOrganizationDirectoryFacts({ source: src(), query, pageSize: 100 });
    expect(result.coverage.status).toBe('complete'); expect(result.coverage.receivedKeys).toHaveLength(250);
    expect(result.data).toHaveLength(150); expect(result.data[100].id).toBe(orgId(201));
    expect(query).toHaveBeenCalledTimes(3); expect(query.mock.calls.map(call => call[1].cursor)).toEqual(['0x', orgId(100), orgId(200)]);
    expect(result.data[0].source).toMatchObject({ chainId: 100, orgId: orgId(1), endpoint: 'fixture://chain-100' });
    expect(query.mock.calls.every(call => call[0] === orgDocs.FETCH_ORG_DIRECTORY_PAGE)).toBe(true);
  });
  it.each(['zero', 'unbound', 'not-cut-over', 'invalid'] as const)('refuses %s authority without name/date rescue', async kind => {
    const row = org(1); row.membershipAuthority = kind === 'zero' ? { ...ready, id: '0x' + '0'.repeat(40) } : kind === 'unbound' ? { ...ready, isRouterBound: false }
      : kind === 'not-cut-over' ? { ...ready, cutoverAt: '0' } : { ...ready, id: 'not-an-address' };
    const result = await readOrganizationDirectoryFacts({ source: src(), query: async () => ({ organizations: [row] }) });
    expect(result.data).toEqual([]);
  });
  it.each(['missing', 'error', 'cap', 'duplicate'] as const)('%s directory completion never becomes empty success', async end => {
    const query = vi.fn(async (_document, variables) => {
      if (!variables.cursor || variables.cursor === '0x') return { organizations: [org(1), org(2)] };
      if (end === 'error') throw new Error('unavailable');
      if (end === 'missing') return {};
      return { organizations: [org(2)] };
    });
    const result = await readOrganizationDirectoryFacts({ source: src(), query, pageSize: 2, maxPages: end === 'cap' ? 1 : 5 });
    expect(result.coverage.status).toBe('incomplete'); expect(result.data.slice(0, 2).map(row => row.id)).toEqual([orgId(1), orgId(2)]);
  });
  it('streams 1205 tasks over 121 projects and counts every status exactly without full-org reads', async () => {
    const source = src();
    const directory = await readOrganizationDirectoryFacts({ source, query: async () => ({ organizations: [org(1), org(2), org(3, false)] }) });
    const tasks = Array.from({ length: 1205 }, (_, i) => ({ id: String(i + 1).padStart(6, '0'), taskManager: addr(1001), status: i < 1000 ? 'Completed' : 'Assigned',
      project: { id: `p-${i % 121}`, deleted: false, taskManager: { id: addr(1001), organization: { id: orgId(1) } } } }));
    tasks.push({ id: '999998', taskManager: addr(1001), status: 'Cancelled', project: { id: 'deleted', deleted: true, taskManager: { id: addr(1001), organization: { id: orgId(1) } } } });
    tasks.push({ id: '999999', taskManager: addr(1003), status: 'Assigned', project: { id: 'retired', deleted: false, taskManager: { id: addr(1003), organization: { id: orgId(3) } } } });
    const query = vi.fn(executeQuery({ tasks: (args: any) => slicePage(tasks.filter(row => row.project.deleted === args.where.project_.deleted
      && args.where.taskManager_in.includes(row.taskManager)), args) }));
    const result = await readOrganizationTaskCounts({ source, query, directory, pageSize: 1000 });
    expect(result.coverage.status).toBe('complete'); expect(result.data.rows).toHaveLength(1205); expect(query).toHaveBeenCalledTimes(2);
    expect(result.data.counts.map(row => [row.orgId, row.total])).toEqual([[orgId(1), { state: 'known', value: '1205', source: { ...source, orgId: orgId(1) } }],
      [orgId(2), { state: 'known', value: '0', source: { ...source, orgId: orgId(2) } }]]);
    expect(result.data.counts[0].byStatus).toMatchObject({ state: 'known', value: { Completed: '1000', Assigned: '205' } });
    expect(query.mock.calls[0][1].taskManagers).toEqual([addr(1001), addr(1002)]);
    expect(query.mock.calls.every(call => call[0] === orgDocs.FETCH_ORG_TASK_COUNT_PAGE)).toBe(true);
  });
  it('later task failure retains partial rows and leaves total unknown, including observed zero', async () => {
    const source = src(); const directory = await readOrganizationDirectoryFacts({ source, query: async () => ({ organizations: [org(1), org(2)] }) });
    const query = vi.fn(async (_document, variables) => { if (variables.cursor) throw new Error('later failure'); return { tasks: [
      { id: '001', taskManager: addr(1001), status: 'Completed', project: { id: 'p-1', deleted: false, taskManager: { id: addr(1001), organization: { id: orgId(1) } } } },
    ] }; });
    const result = await readOrganizationTaskCounts({ source, query, directory, pageSize: 1 });
    expect(result.coverage.status).toBe('incomplete'); expect(result.data.rows).toHaveLength(1);
    expect(result.data.counts.map(row => row.total.state)).toEqual(['unknown', 'unknown']);
    expect(result.data.counts.map(row => row.observedTotal)).toEqual(['1', '0']);
  });
  it('counts the full serving task status vocabulary and rejects unknown status/deleted/wrong-org rows', async () => {
    const source = src(); const directory = await readOrganizationDirectoryFacts({ source, query: async () => ({ organizations: [org(1)] }) });
    const statuses = ['Open', 'Assigned', 'Submitted', 'Completed', 'Cancelled'];
    const tasks = statuses.map((status, i) => ({ id: `task-${i}`, taskManager: addr(1001), status, project: { id: 'p-1', deleted: false, taskManager: { id: addr(1001), organization: { id: orgId(1) } } } }));
    const result = await readOrganizationTaskCounts({ source, directory, query: async () => ({ tasks }) });
    expect(result.data.counts[0].byStatus).toMatchObject({ state: 'known', value: { Open: '1', Assigned: '1', Submitted: '1', Completed: '1', Cancelled: '1' } });
    for (const bad of [{ ...tasks[0], status: 'Unassigned' }, { ...tasks[0], project: { ...tasks[0].project, deleted: true } },
      { ...tasks[0], project: { deleted: false, taskManager: { organization: { id: orgId(2) } } } }]) {
      const badResult = await readOrganizationTaskCounts({ source, directory, query: async () => ({ tasks: [bad] }) });
      expect(badResult.coverage.status).toBe('incomplete'); expect(badResult.data.counts[0].total.state).toBe('unknown');
    }
  });
  it('incomplete directory refuses counts before querying and mismatched source throws', async () => {
    const source = src(); const directory = await readOrganizationDirectoryFacts({ source, query: async () => ({}) }); const query = vi.fn();
    const result = await readOrganizationTaskCounts({ source, query, directory });
    expect(result.coverage.status).toBe('unavailable'); expect(query).not.toHaveBeenCalled();
    await expect(readOrganizationTaskCounts({ source: src(42161), query, directory })).rejects.toThrow('SCOPE_MISMATCH');
  });
});

describe('source-qualified identity batches and unknown absence', () => {
  it('same name/address across two production chains retains distinct registry provenance', async () => {
    const sources = [src(100, 'identities', { contract: registry }), src(42161, 'identities', { contract: authority })];
    const query = vi.fn(async (_document, _variables, source) => ({ accounts: [identity(1, source.contract)] }));
    const result = await readIdentityFacts({ sources, query, selector: { kind: 'names', names: ['same_name'] } });
    expect(query).toHaveBeenCalledTimes(2); expect(result.data.map(row => [row.source.chainId, row.registry.id, row.source.account])).toEqual([[100, registry, addr(1)], [42161, authority, addr(1)]]);
    expect(lookupIdentityFact(result, { username: 'same_name' })).toMatchObject({ state: 'known', value: result.data });
    expect(result.data[0].registeredAt).toBe('101'); expect(result.data[0].metadata).toEqual(metadata);
  });
  it('1001 requested addresses are paged in one source batch, including null metadata', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ ...identity(i + 1), metadata: i === 1000 ? null : metadata }));
    const query = vi.fn(executeQuery({ accounts: (args: any) => slicePage(rows.filter(row => args.where.id_in.includes(row.id) && row.registry.id === args.where.registry), args) }));
    const result = await readIdentityFacts({ sources: [src(100, 'profiles', { contract: registry })], query, selector: { kind: 'addresses', addresses: rows.map(row => row.id) } });
    expect(result.coverage.status).toBe('complete'); expect(result.data).toHaveLength(1001); expect(query).toHaveBeenCalledTimes(2);
    expect(result.data[1000].metadata).toBeNull(); expect(query.mock.calls[1][1].cursor).toBe(addr(1000));
  });
  it.each(['names', 'addresses', 'search'] as const)('%s selectors execute with correct generated filter types and caps', async kind => {
    const rows = [identity(1, registry, 'MiXeD'), { ...identity(2, registry, 'MiXeD'), isDeleted: true }, identity(3, authority, 'MiXeD')];
    const query = vi.fn(executeQuery({ accounts: (args: any) => slicePage(rows.filter(row => row.registry.id === args.where.registry
      && (args.where.id_in === undefined || args.where.id_in.includes(row.id))
      && (args.where.username_in === undefined || args.where.username_in.includes(row.username))
      && (args.where.username_contains_nocase === undefined || row.username.toLowerCase().includes(args.where.username_contains_nocase.toLowerCase()))
      && (args.where.isDeleted === undefined || row.isDeleted === args.where.isDeleted)), args) }));
    const selector = kind === 'names' ? { kind, names: ['MiXeD'] } : kind === 'addresses' ? { kind, addresses: [addr(1), addr(2)] } : { kind, query: 'mixed' };
    const result = await readIdentityFacts({ sources: [src(100, 'identities', { contract: registry })], query, selector });
    expect(result.data.map(row => row.id)).toEqual(kind === 'addresses' ? [addr(1), addr(2)] : [addr(1)]);
    expect(result.coverage.status).toBe('complete'); expect(query.mock.calls[0][1].first).toBe(1000);
    expect(lookupIdentityFact(result, { username: 'other' }).state).toBe('unknown');
  });
  it('outage retains known other-chain data and cannot declare global name free', async () => {
    const sources = [src(100, 'identities', { contract: registry }), src(42161, 'identities', { contract: authority })];
    const result = await readIdentityFacts({ sources, selector: { kind: 'names', names: ['same_name', 'free_name'] }, query: async (_document, _variables, source) => {
      if (source.chainId === 42161) throw new Error('network down'); return { accounts: [identity(1)] };
    } });
    expect(result.coverage.status).toBe('incomplete'); expect(result.data).toHaveLength(1); expect(result.coverage.failedIds).toHaveLength(1);
    expect(result.observations.map(observation => observation.coverage.status)).toEqual(['complete', 'unavailable']);
    expect(lookupIdentityFact(result, { username: 'free_name' })).toEqual({ state: 'unknown', code: 'IDENTITY_SOURCES_INCOMPLETE' });
  });
  it('complete empty is known absence; missing collection, empty sweep and bad registry are unknown', async () => {
    const sources = [src(100, 'identities', { contract: registry })]; const selector = { kind: 'names' as const, names: ['free_name'] };
    const empty = await readIdentityFacts({ sources, selector, query: async () => ({ accounts: [] }) });
    expect(lookupIdentityFact(empty, { username: 'free_name' })).toEqual({ state: 'known', value: [] });
    for (const response of [{}, { accounts: [identity(1, authority, 'free_name')] }]) {
      const result = await readIdentityFacts({ sources, selector, query: async () => response });
      expect(lookupIdentityFact(result, { username: 'free_name' }).state).toBe('unknown');
    }
    const none = await readIdentityFacts({ sources: [], selector, query: vi.fn() });
    expect(lookupIdentityFact(none, { username: 'free_name' }).state).toBe('unknown');
  });
  it('invalid selector, duplicate source and excessive page size refuse before transport', async () => {
    const source = src(100, 'identities', { contract: registry }); const query = vi.fn();
    await expect(readIdentityFacts({ sources: [source], query, selector: { kind: 'addresses', addresses: ['invalid'] } })).rejects.toThrow('Invalid account');
    await expect(readIdentityFacts({ sources: [source, source], query, selector: { kind: 'names', names: [] } })).rejects.toThrow('Duplicate');
    await expect(readIdentityFacts({ sources: [source], query, selector: { kind: 'names', names: [] }, pageSize: 1001 })).rejects.toThrow('Page size');
    expect(query).not.toHaveBeenCalled();
  });
  it.each(['error', 'cap', 'duplicate'] as const)('later %s identity page retains valid earlier rows and makes lookup unknown', async end => {
    const query: ProtocolQuery = async (_document, variables) => {
      if (variables.cursor === '0x') return { accounts: [identity(1), identity(2)] };
      if (end === 'error') throw new Error('later page outage');
      return { accounts: [identity(2)] };
    };
    const result = await readIdentityFacts({ sources: [src(100, 'batch', { contract: registry })], query, pageSize: 2, maxPages: end === 'cap' ? 1 : 3,
      selector: { kind: 'names', names: ['same_name'] } });
    expect(result.data.map(row => row.id)).toEqual([addr(1), addr(2)]);
    expect(result.coverage.status).toBe('incomplete'); expect(lookupIdentityFact(result, { username: 'same_name' }).state).toBe('unknown');
  });
});

describe('authority membership cards and truthful history', () => {
  it.each([[null, 'MiXeD', 'Shares'], [false, 'MiXeD', 'Shares'], [true, 'MiXeD', 'MiXeD'], [true, '  ', 'Shares']] as const)('flag=%s symbol=%s yields %s with unknown authority-only metrics', async (flag, symbol, label) => {
    const row = membership(); row.organization = org(1, true, flag, symbol);
    const query = executeQuery({ subjectMemberships: () => [row], users: () => [] });
    const result = await readMembershipCardFacts({ source: src(100, 'cards', { account }), query });
    expect(result.coverage.status).toBe('complete'); expect(result.data[0]).toMatchObject({ tokenLabel: label, historyIndexed: false, firstSeenAt: null,
      totalVotes: null, totalTasksCompleted: null, participationTokenBalance: null, currentMembership: { state: 'known', value: true } });
    expect(result.data[0].organization.metadata).toMatchObject({ logo: 'logo-cid', useTokenSymbol: flag });
    expect(result.data[0].source).toMatchObject({ chainId: 100, orgId: orgId(1), account });
  });
  it('historical contributors, inactive memberships and seeded old join date survive migrated orgs', async () => {
    const historical = history(); const inactive = { ...membership(1, historical), ruleKind: 'Ban', isMember: true }; // deliberately stale indexed cache
    const historicalOnly = history(2); const retired = history(3); retired.organization = org(3, false);
    const roots = { subjectMemberships: () => [inactive], users: () => [historical, historicalOnly, retired] };
    const result = await readMembershipCardFacts({ source: src(100, 'cards', { account }), query: executeQuery(roots) });
    expect(result.coverage.status).toBe('complete'); expect(result.data.map(row => row.orgId)).toEqual([orgId(1), orgId(2)]);
    expect(result.data[0]).toMatchObject({ historyIndexed: true, firstSeenAt: '1500000000', totalTasksCompleted: '7', totalVotes: '0', currentMembership: { state: 'known', value: false } });
    expect(result.data[1].currentMembership).toMatchObject({ state: 'known', value: false });
    expect(result.data[0].firstSeenAt).not.toBe(inactive.acceptedAt);
  });
  it('same org and wallet across chains keeps source qualification and absent history is null', async () => {
    const query: ProtocolQuery = async document => document.includes('AuthorityMembershipCardsPage') ? { subjectMemberships: [membership()] } : { users: [] };
    const results = await Promise.all([100, 42161].map(chainId => readMembershipCardFacts({ source: src(chainId, 'cards', { account }), query })));
    expect(results.map(result => [result.data[0].source.chainId, result.data[0].orgId])).toEqual([[100, orgId(1)], [42161, orgId(1)]]);
    expect(results.map(result => result.data[0].firstSeenAt)).toEqual([null, null]);
  });
  it('membership page outage preserves historical activity and current membership becomes unknown', async () => {
    const result = await readMembershipCardFacts({ source: src(100, 'cards', { account }), query: async document => {
      if (document.includes('AuthorityMembershipCardsPage')) throw new Error('outage'); return { users: [history()] };
    } });
    expect(result.coverage.status).toBe('incomplete'); expect(result.data[0].totalTasksCompleted).toBe('7');
    expect(result.data[0].historySource).toMatchObject({ chainId: 100, orgId: orgId(1), account, method: 'cards:history' });
    expect(result.data[0].currentMembership.state).toBe('unknown');
  });
  it('structural roots do not supply user-facing current roles', async () => {
    const row = membership(); row.subject.subjectId = HATS_NAMESPACE_FLOOR.toString();
    const result = await readMembershipCardFacts({ source: src(100, 'cards', { account }), query: async document => document.includes('AuthorityMembershipCardsPage') ? { subjectMemberships: [row] } : { users: [] } });
    expect(result.data[0].currentMembership).toMatchObject({ state: 'known', value: false });
  });
  it('runtime projection without a User has null metrics and no history arrays; indexed zero and churn survive', () => {
    const rows = projectAuthorityUsers([], [membership()]);
    expect(rows[0]).toMatchObject({ historyIndexed: false, participationTokenBalance: null, totalVotes: null, firstSeenAt: null });
    for (const field of ['assignedTasks', 'completedTasks', 'hybridProposalsCreated', 'modulesCompleted']) expect(rows[0][field]).toBeUndefined();
    expect(isIndexedOrgUser({ ...rows[0], id: 'row' })).toBe(false);
    const indexed = { ...history(), participationTokenBalance: '0', totalTasksReleased: '0', assignedTasks: [], completedTasks: [], hybridProposalsCreated: [], modulesCompleted: [] };
    const present = projectAuthorityUsers([indexed], [membership()])[0];
    expect(present).toMatchObject({ participationTokenBalance: '0', totalTasksReleased: '0', historyIndexed: true, firstSeenAt: '1500000000' });
    expect(isIndexedOrgUser(present)).toBe(true);
    expect(isIndexedOrgUser({ ...present, assignedTasks: undefined })).toBe(false);
  });
  it('strict skipLibCheck:false consumer checks absence and narrows populated profile relations', () => {
    const file = new URL('./fixtures/core-update/identity/consumer.ts', import.meta.url).pathname;
    const program = ts.createProgram([file], { strict: true, skipLibCheck: false, noEmit: true, esModuleInterop: true,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 });
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });
  it('getOrgUserProfile exposes a type-safe authority-only identity without creating empty history arrays', async () => {
    const query = vi.fn(async (document: string) => {
      if (document.includes('AuthorityUserHistory')) return { organization: { executorContract: null, eligibilityModule: null }, users: [] };
      if (document.includes('AuthorityMemberships')) return { subjectMemberships: [membership()] };
      return { organization: org(1) };
    });
    const client = { query, queryWithFieldFallback: async () => ({ data: { user: null, account: { id: account, username: 'tester' } }, tierIndex: 0 }) } as any;
    const result = await getOrgUserProfile(client, orgId(1), account, 100);
    expect(result.user).toMatchObject({ historyIndexed: false, id: `${orgId(1)}-${account}`, totalTasksCompleted: null, participationTokenBalance: null });
    expect(result.user!.assignedTasks).toBeUndefined(); expect(result.hasChurnCounters).toBe(true);
    expect(result.user!.totalTasksReleased).toBeUndefined(); expect(isIndexedOrgUser(result.user!)).toBe(false);
  });
  it('baseline declaration wrongly accepts unguarded arrays that authority-only runtime omits', () => {
    const path = new URL('./fixtures/core-update/identity/baseline-consumer.ts', import.meta.url).pathname;
    const text = fixture('baseline-org-user.ts.txt') + '\nexport function unsafe(user: OrgUser): number { return user.assignedTasks.length + user.completedTasks.length + user.hybridProposalsCreated.length + user.modulesCompleted.length; }';
    const options: ts.CompilerOptions = { strict: true, skipLibCheck: false, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS };
    const host = ts.createCompilerHost(options), read = host.getSourceFile.bind(host);
    host.getSourceFile = (file, version, ...rest) => file === path ? ts.createSourceFile(file, text, version) : read(file, version, ...rest);
    const program = ts.createProgram([path], options, host);
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    const actual = projectAuthorityUsers([], [membership()])[0];
    expect(() => actual.assignedTasks.length).toThrow(TypeError);
  });
});

describe('new indexed readers enforce pinned provenance through the shared repaired reader', () => {
  const HASH = '0x' + 'ab'.repeat(32), WRONG = '0x' + 'cd'.repeat(32);
  const pinned = (extra: Partial<SourceRef> = {}) => src(100, 'pinned-read', { snapshot: 'pinned', block: { number: '42', hash: HASH, timestamp: '1234' }, ...extra });
  const attestation = (number = 42, hash: string | null = HASH, timestamp = 1234) => ({ _meta: { block: { number, hash, timestamp } } });
  for (const kind of ['directory', 'identities', 'cards', 'counts'] as const) {
    const run = async (query: ProtocolQuery) => {
      if (kind === 'directory') return readOrganizationDirectoryFacts({ source: pinned(), query });
      if (kind === 'identities') {
        const result = await readIdentityFacts({ sources: [pinned({ contract: registry })], query, selector: { kind: 'names', names: ['same_name'] } });
        return { source: result.sources[0]?.source, data: result.data, coverage: result.coverage };
      }
      if (kind === 'cards') return readMembershipCardFacts({ source: pinned({ account }), query });
      const source = pinned(); const directory = await readOrganizationDirectoryFacts({ source, query: async () => ({ ...attestation(), organizations: [org(1)] }) });
      return readOrganizationTaskCounts({ source, directory, query });
    };
    it(`${kind} preserves hash-filter and independently returned number/timestamp, including complete empty`, async () => {
      const query = vi.fn<Parameters<ProtocolQuery>, ReturnType<ProtocolQuery>>(async () => ({ ...attestation(42, null), organizations: [], accounts: [], users: [], subjectMemberships: [], tasks: [] }));
      const result = await run(query);
      expect(result.coverage.status).toBe('complete'); expect(result.source?.block).toEqual({ number: '42', hash: HASH, timestamp: '1234' });
      expect(query.mock.calls.every(call => JSON.stringify(call[1].block) === JSON.stringify({ hash: HASH }))).toBe(true);
      expect(query.mock.calls.every(call => call[0].includes('_meta(block: $block) { block { number hash timestamp } }'))).toBe(true);
      requireCompleteSnapshot(result as any, { snapshot: 'pinned', block: pinned().block });
    });
    it.each(['no-meta', 'wrong-number', 'wrong-hash', 'wrong-time'] as const)(`${kind}: %s cannot echo requested block into complete evidence`, async failure => {
      const meta = failure === 'no-meta' ? {} : failure === 'wrong-number' ? attestation(43) : failure === 'wrong-hash' ? attestation(42, WRONG) : attestation(42, HASH, 1235);
      const result = await run(async () => ({ ...meta, organizations: [], accounts: [], users: [], subjectMemberships: [], tasks: [] }));
      expect(result.coverage.status).not.toBe('complete'); expect(result.source?.block?.hash).not.toBe(HASH);
    });
  }
  it('latest requests cannot smuggle an unqueried supplied block into reported provenance', async () => {
    const query = vi.fn(); const bad = src(100, 'latest-with-block', { block: { number: '42', hash: HASH } });
    await expect(readOrganizationDirectoryFacts({ source: bad, query })).rejects.toThrow('requires pinned');
    await expect(readIdentityFacts({ sources: [{ ...bad, contract: registry }], query, selector: { kind: 'names', names: ['name'] } })).rejects.toThrow('requires pinned');
    await expect(readMembershipCardFacts({ source: { ...bad, account }, query })).rejects.toThrow('requires pinned');
    expect(query).not.toHaveBeenCalled();
  });
  it('failed pinned identity observations remain available with unknown provenance and their actual error code', async () => {
    const result = await readIdentityFacts({ sources: [pinned({ contract: registry })], query: async () => ({ accounts: [] }), selector: { kind: 'names', names: ['name'] } });
    expect(result.coverage.status).toBe('unavailable'); expect(result.observations).toHaveLength(1);
    expect(result.observations[0].source.snapshot).toBe('unknown'); expect(result.observations[0].source.block).toBeUndefined();
    expect(result.observations[0].coverage.issues).toContainEqual({ code: 'BLOCK_EVIDENCE_UNAVAILABLE', id: 'page:1' });
    expect(lookupIdentityFact(result, { username: 'name' }).state).toBe('unknown');
  });
});

describe('profile patch/replacement policy and prepared intents', () => {
  it('old patch bytes/order remain unchanged and omission/undefined retain truthy old fields', () => {
    expect(serializeUserProfileMetadata(buildUserProfileMetadata({}, oldFields))).toBe('{"bio":"B","avatar":"A","github":"G","twitter":"T","website":"W"}');
    expect(buildUserProfileMetadata({ bio: undefined }, oldFields)).toEqual({ bio: 'B', avatar: 'A', github: 'G', twitter: 'T', website: 'W' });
    expect(buildUserProfileMetadata({}, { bio: '', avatar: null })).toEqual({});
  });
  for (const field of USER_PROFILE_FIELDS) it(`explicit ${field} clear retains other patch fields and canonical order`, () => {
    const patch = buildUserProfileMetadata({ [field]: '' }, oldFields);
    expect(patch[field]).toBe(''); expect(Object.keys(patch)).toEqual([...USER_PROFILE_FIELDS]);
    for (const other of USER_PROFILE_FIELDS.filter(other => other !== field)) expect(patch[other]).toBe(oldFields[other]);
    expect(oldFields[field]).not.toBe('');
  });
  it('replacement clears all five omitted or empty fields without resurrecting an old profile', () => {
    expect(serializeUserProfileMetadata(replaceUserProfileMetadata({}))).toBe('{"bio":"","avatar":"","github":"","twitter":"","website":""}');
    expect(replaceUserProfileMetadata({ website: 'new', bio: undefined })).toEqual({ bio: '', avatar: '', github: '', twitter: '', website: 'new' });
    expect(replaceUserProfileMetadata({ bio: '', avatar: '', github: '', twitter: '', website: '' })).toEqual({ bio: '', avatar: '', github: '', twitter: '', website: '' });
  });
  it('selected cross-chain patch base is used verbatim, without resolution or ranking', async () => {
    const chosen = { bio: 'selected sparse chain', website: 'https://example.org' };
    const final = buildUserProfileMetadata({ bio: '' }, chosen); const upload = vi.fn(async () => VALID_CID);
    const source = src(42161, 'chosen-profile', { account, contract: authority });
    const result = await preparedProfileMetadataIntent({ source, metadata: final, upload });
    expect(upload).toHaveBeenCalledWith('{"bio":"","website":"https://example.org"}');
    expect(result).toMatchObject({ to: authority, method: 'setProfileMetadata', meta: { summary: { chainId: 42161, account }, ipfs: { cid: VALID_CID, metadata: final } } });
    expect(chosen).toEqual({ bio: 'selected sparse chain', website: 'https://example.org' });
  });
  it('upload failure leaves chosen document and previous profile intact and returns no intent', async () => {
    const final = replaceUserProfileMetadata({}); const before = JSON.stringify(final); const old = JSON.stringify(oldFields);
    const upload = vi.fn(async () => { throw new Error('pin failure'); });
    await expect(preparedProfileMetadataIntent({ source: src(100, 'edit', { account, contract: registry }), metadata: final, upload })).rejects.toThrow('pin failure');
    expect(JSON.stringify(final)).toBe(before); expect(JSON.stringify(oldFields)).toBe(old); expect(upload).toHaveBeenCalledTimes(1);
  });
  it('invalid bio, field type or source refuses before any upload', async () => {
    const upload = vi.fn(); const source = src(100, 'edit', { account, contract: registry });
    for (const params of [{ source, metadata: { bio: 'x'.repeat(281) } }, { source, metadata: { avatar: null } }, { source: { ...source, contract: undefined }, metadata: {} }]) {
      await expect(preparedProfileMetadataIntent({ ...params, upload } as any)).rejects.toThrow();
    }
    expect(upload).not.toHaveBeenCalled(); expect(() => replaceUserProfileMetadata({ bio: 'x'.repeat(281) })).toThrow('Bio too long');
  });
  it('replacement upload serializes all five clears and an invalid CID yields no intent', async () => {
    const upload = vi.fn(async () => VALID_CID); const source = src(100, 'edit', { account, contract: registry });
    const result = await preparedProfileMetadataIntent({ source, metadata: replaceUserProfileMetadata({}), upload });
    expect(upload).toHaveBeenCalledWith('{"bio":"","avatar":"","github":"","twitter":"","website":""}');
    expect(result.args[0]).toMatch(/^0x[\da-f]{64}$/);
    await expect(preparedProfileMetadataIntent({ source, metadata: {}, upload: async () => 'invalid-cid' })).rejects.toThrow();
  });
  it('existing resolved profile patch still defaults HOME, merges prior fields and uses mocked content service', async () => {
    const query = vi.fn(async (_document: string, _variables: Record<string, unknown>, _chainId?: number) => ({ universalAccountRegistries: [{ id: registry }], account: { metadata: oldFields } }));
    const pinJson = vi.fn(async () => VALID_CID);
    const ctx = { chainId: 100, client: { query }, ipfs: { service: { pinJson, pinFile: vi.fn(), fetchJson: vi.fn() } } } as any;
    const result = await setProfileMetadataIntent(ctx, { address: account, bio: '' });
    expect(query.mock.calls[0][2]).toBe(HOME_CHAIN_ID);
    expect(pinJson).toHaveBeenCalledWith('{"bio":"","avatar":"A","github":"G","twitter":"T","website":"W"}');
    expect(result.to).toBe(registry); expect(oldFields.bio).toBe('B');
  });
  it('existing rename defaults HOME independently of context; explicit chain/registry remain supported', async () => {
    const query = vi.fn(async (_document: string, _variables: Record<string, unknown>, _chainId?: number) => ({ universalAccountRegistries: [{ id: registry }], account: null }));
    const ctx = { chainId: 100, client: { query } } as any;
    await changeUsernameIntent(ctx, { address: account, newUsername: 'next_name' });
    expect(query.mock.calls[0][2]).toBe(HOME_CHAIN_ID);
    await changeUsernameIntent(ctx, { address: account, newUsername: 'next_name', chainId: 100 });
    expect(query.mock.calls[1][2]).toBe(100);
    expect(buildChangeUsername({ registryAddress: authority, newUsername: 'next_name' })).toMatchObject({ to: authority, method: 'changeUsername', args: ['next_name'] });
  });
});

describe('serving-compatible directory count plans', () => {
  it('retains both original schema-valid planner failures and exact schema projection provenance', () => {
    const original = fixture('unsupported-fetch_org_task_count_page.graphql');
    expect(validate(schema, parse(original))).toEqual([]);
    const errors = JSON.parse(fixture('serving-errors.json'));
    expect(errors.sources.map((s: any) => s.chainId)).toEqual([100, 42161]);
    for (const s of errors.sources) {
      expect(s.errors[0].errors[0].message).toContain('Child filter nesting not supported by value `taskManager`');
      expect(() => assertServingCapabilities(original, s.errors[0].variables)).toThrow('Child filter nesting');
    }
    const p = JSON.parse(fixture('serving-plan-provenance.json'));
    expect(createHash('sha256').update(fixture(p.schemaFixture)).digest('hex')).toBe(p.sha256);
  });
  it('counts >100 modules and >1000 tasks in one complete stream, excluding retired and deleted projects', async () => {
    const source = src(), organizations = Array.from({ length: 122 }, (_, i) => org(i + 1, i !== 121));
    organizations[120].taskManager = null as any;
    const directory = await readOrganizationDirectoryFacts({ source, query: executeQuery({ organizations: (args: any) => slicePage(organizations, args) }), pageSize: 100 });
    const tasks = Array.from({ length: 1205 }, (_, i) => {
      const n = i % 120 + 1;
      return { id: String(i).padStart(6, '0'), taskManager: addr(1000 + n), status: i % 2 ? 'Open' : 'Completed', project: { id: `project-${i % 121}`, deleted: false, taskManager: { id: addr(1000 + n), organization: { id: orgId(n) } } } };
    });
    tasks.push({ ...tasks[0], id: '999998', project: { ...tasks[0].project, deleted: true } });
    tasks.push({ ...tasks[0], id: '999999', taskManager: addr(1122), project: { ...tasks[0].project, taskManager: { id: addr(1122), organization: { id: orgId(122) } } } });
    const query = vi.fn(executeQuery({ tasks: (args: any) => slicePage(tasks.filter(row => args.where.taskManager_in.includes(row.taskManager) && row.project.deleted === args.where.project_.deleted), args) }));
    const result = await readOrganizationTaskCounts({ source, directory, query, pageSize: 1000 });
    expect(result.coverage.status).toBe('complete'); expect(result.data.rows).toHaveLength(1205);
    expect(query).toHaveBeenCalledTimes(2); expect(query.mock.calls[0][1].taskManagers).toHaveLength(120); expect(query.mock.calls[1][1].cursor).toBe('000999');
    expect(result.data.counts.map(c => c.total.state === 'known' ? c.total.value : 'unknown')).toEqual([...Array(5).fill('11'), ...Array(115).fill('10'), '0']);
    expect(result.data.counts.reduce((n, c) => n + BigInt(c.observedTotal), 0n)).toBe(1205n);
  });
  it.each(['missing', 'undefined', 'wrong-org', 'zero'] as const)('%s directory module selection cannot establish zero', async kind => {
    const row: any = org(1);
    if (kind === 'missing') delete row.taskManager;
    if (kind === 'undefined') row.taskManager = undefined;
    if (kind === 'wrong-org') row.taskManager.organization.id = orgId(2);
    if (kind === 'zero') row.taskManager.id = addr(0);
    const directory = await readOrganizationDirectoryFacts({ source: src(), query: async () => ({ organizations: [row] }) });
    expect(directory.coverage.status).toBe('incomplete');
    const query = vi.fn(), result = await readOrganizationTaskCounts({ source: src(), directory, query });
    expect(result.coverage.status).toBe('unavailable'); expect(query).not.toHaveBeenCalled();
  });
  it.each(['duplicate-module', 'missing-id', 'duplicate-org', 'missing-module', 'wrong-module-org'] as const)('%s complete directory counterexample refuses before transport', async failure => {
    const directory = await readOrganizationDirectoryFacts({ source: src(), query: async () => ({ organizations: [org(1), org(2)] }) });
    const data: any[] = directory.data.map(row => ({ ...row, taskManager: row.taskManager ? { ...row.taskManager, organization: { ...row.taskManager.organization } } : null }));
    if (failure === 'duplicate-module') data[1].taskManager.id = data[0].taskManager.id;
    if (failure === 'missing-id') delete data[1].id;
    if (failure === 'duplicate-org') data[1] = data[0];
    if (failure === 'missing-module') delete data[1].taskManager;
    if (failure === 'wrong-module-org') data[1].taskManager.organization.id = orgId(1);
    const query = vi.fn(), result = await readOrganizationTaskCounts({ source: src(), directory: { ...directory, data }, query });
    expect(result.coverage.status).toBe('unavailable'); expect(query).not.toHaveBeenCalled(); expect(result.data.counts.every(c => c.total.state === 'unknown')).toBe(true);
  });
  it('established null module becomes known zero only after successful complete empty stream', async () => {
    const directory = await readOrganizationDirectoryFacts({ source: src(), query: async () => ({ organizations: [{ ...org(1), taskManager: null }] }) });
    const query = vi.fn(executeQuery({ tasks: () => [] })), result = await readOrganizationTaskCounts({ source: src(), directory, query });
    expect(result.coverage.status).toBe('complete'); expect(query.mock.calls[0][1].taskManagers).toEqual([]); expect(result.data.counts[0].total).toMatchObject({ state: 'known', value: '0' });
  });
  it.each(['foreign-manager', 'foreign-org', 'missing-project-id', 'missing-task-id', 'missing-manager', 'duplicate'] as const)('%s returned tasks retain incomplete evidence', async failure => {
    const directory = await readOrganizationDirectoryFacts({ source: src(), query: async () => ({ organizations: [org(1)] }) });
    const task: any = { id: 'task-1', taskManager: addr(1001), status: 'Open', project: { id: 'p-1', deleted: false, taskManager: { id: addr(1001), organization: { id: orgId(1) } } } };
    if (failure === 'foreign-manager') task.taskManager = addr(1002);
    if (failure === 'foreign-org') task.project.taskManager.organization.id = orgId(2);
    if (failure === 'missing-project-id') delete task.project.id;
    if (failure === 'missing-task-id') delete task.id;
    if (failure === 'missing-manager') delete task.project.taskManager.id;
    const result = await readOrganizationTaskCounts({ source: src(), directory, query: async () => ({ tasks: failure === 'duplicate' ? [task, task] : [task] }) });
    expect(result.coverage.status).toBe('incomplete'); expect(result.data.counts[0].total.state).toBe('unknown');
    if (failure !== 'missing-task-id') expect(result.data.rows).toHaveLength(1);
  });
  for (const chainId of [100, 42161]) for (const dh of [null, '0x' + 'ab'.repeat(32)]) for (const th of [null, '0x' + 'ab'.repeat(32)]) it(`chain ${chainId} directory/task optional hash ${dh}/${th} must agree`, async () => {
    const source = src(chainId, 'numeric-counts', { snapshot: 'pinned', block: { number: '42' } });
    const directory = await readOrganizationDirectoryFacts({ source, query: async () => ({ organizations: [org(1)], _meta: { block: { number: 42, hash: dh } } }) });
    const result = await readOrganizationTaskCounts({ source, directory, query: async () => ({ tasks: [], _meta: { block: { number: 42, hash: th } } }) });
    expect(result.coverage.status).toBe(dh === th ? 'complete' : 'incomplete'); expect(result.data.counts[0].total.state).toBe(dh === th ? 'known' : 'unknown');
    if (dh !== th) expect(result.coverage.issues).toContainEqual({ code: 'DIRECTORY_PAGE_SOURCE_MISMATCH' });
  });
});

describe('count source replay and cross-page proof continuity', () => {
  it('pins the corrected count bytes actually served on both sources, including empty direct selection', () => {
    const saved = JSON.parse(fixture('serving-successes.json'));
    for (const s of saved.sources) {
      expect(s.documents[0].httpStatus).toBe(200); expect(s.documents[0].errors).toBeUndefined();
      expect(createHash('sha256').update(orgDocs.FETCH_ORG_TASK_COUNT_PAGE).digest('hex')).toBe(s.documents[0].documentSha256);
      expect(s.documents[0].data.tasks.length).toBe(s.test6Present ? 1 : 0);
    }
    expect(saved.legitimateEmpty.countDocument.tasks).toEqual([]);
  });
  for (const chainId of [100, 42161]) for (const end of ['mixed-hash', 'wrong-number', 'missing-meta', 'missing-binding'] as const) it(`counts chain ${chainId}: terminal ${end} cannot certify partial counts`, async () => {
    const source = src(chainId, 'counts-proof', { snapshot: 'pinned', block: { number: '42' } });
    const meta = { _meta: { block: { number: 42, hash: null } } };
    const directory = await readOrganizationDirectoryFacts({ source, query: async () => ({ ...meta, organizations: [org(1)] }) });
    const task: any = { id: 'task-1', taskManager: addr(1001), status: 'Open', project: { id: 'p', deleted: false, taskManager: { id: addr(1001), organization: { id: orgId(1) } } } };
    const result = await readOrganizationTaskCounts({ source, directory, pageSize: 1, query: async (_doc, vars) => {
      if (!vars.cursor) return { ...meta, tasks: [task] };
      if (end === 'missing-meta') return { tasks: [] };
      if (end === 'missing-binding') return { ...meta, tasks: [{ ...task, id: 'task-2', taskManager: undefined }] };
      return { tasks: [], _meta: { block: { number: end === 'wrong-number' ? 43 : 42, hash: end === 'mixed-hash' ? '0x' + 'ab'.repeat(32) : null } } };
    } });
    expect(result.coverage.status).toBe('incomplete'); expect(result.data.rows.length).toBeGreaterThan(0); expect(result.data.counts[0].total.state).toBe('unknown'); expect(result.source.block).toEqual({ number: '42' });
  });
});
