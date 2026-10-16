import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { buildClientSchema, Kind, parse, validate } from 'graphql';
import { Coverage, Fact, knownFact, PlanScope, SourceRef, SourceSnapshot, unknownFact } from '../src/data/facts';
import { AuthorityMemberFact, AuthorityPermissionData } from '../src/authority/permissions';
import { deriveProjectCreatorAuthorization as sourceCreator, ProjectCreatorInput } from '../src/tasks/project-creator';
import { decideTaskActions as sourceDecisions, TaskPolicyFacts, TaskPolicyInput } from '../src/tasks/policy';
import { FETCH_TASK_APPLICATIONS_PAGE as sourceDocument } from '../src/graph/documents/task';
import { listTaskApplicationsComplete as sourceApplications, projectTaskApplicant as sourceApplicant, TaskApplicationPageOptions } from '../src/reads/task';
import { IndexedRow } from '../src/reads/protocol';
import { readAuthoritySnapshot as sourceAuthority, authorityAccountMembershipFacts as sourceMembers, AuthoritySnapshotQuery } from '../src/reads/authority';

// Replay these SAME protocol regressions through packed public exports when
// explicitly selected by the release check; no consumer app or transport.
const packedRequire = process.env.POA_CORE_PACKED_ROOT ? createRequire(resolve(process.env.POA_CORE_PACKED_ROOT, 'package.json')) : null;
const deriveProjectCreatorAuthorization: typeof sourceCreator = packedRequire ? packedRequire('@poa-box/core/tasks/project-creator').deriveProjectCreatorAuthorization : sourceCreator;
const decideTaskActions: typeof sourceDecisions = packedRequire ? packedRequire('@poa-box/core/tasks/policy').decideTaskActions : sourceDecisions;
const readAuthoritySnapshot: typeof sourceAuthority = packedRequire ? packedRequire('@poa-box/core/reads/authority').readAuthoritySnapshot : sourceAuthority;
const authorityAccountMembershipFacts: typeof sourceMembers = packedRequire ? packedRequire('@poa-box/core/reads/authority').authorityAccountMembershipFacts : sourceMembers;
const listTaskApplicationsComplete: typeof sourceApplications = packedRequire ? packedRequire('@poa-box/core/reads/task').listTaskApplicationsComplete : sourceApplications;
const projectTaskApplicant: typeof sourceApplicant = packedRequire ? packedRequire('@poa-box/core/reads/task').projectTaskApplicant : sourceApplicant;
const FETCH_TASK_APPLICATIONS_PAGE: string = packedRequire ? packedRequire('@poa-box/core/graph/documents/task').FETCH_TASK_APPLICATIONS_PAGE : sourceDocument;

const TM = `0x${'11'.repeat(20)}`, AUTH = `0x${'22'.repeat(20)}`, ACCOUNT = `0x${'33'.repeat(20)}`;
const OTHER = `0x${'44'.repeat(20)}`, ZERO = `0x${'00'.repeat(20)}`, ORG = `0x${'55'.repeat(32)}`;
const PID = `0x${'66'.repeat(32)}`, HASH = `0x${'77'.repeat(32)}`, TASK = '9007199254740993', ENTITY = `${TM}-${TASK}`;
const MAX = ((1n << 256n) - 1n).toString(), ROLE = ((1n << 224n) + 9007199254740993n).toString();
const source: SourceRef = { chainId: 100, orgId: ORG, contract: TM, endpoint: 'fixture://work', method: 'task-manager',
  indexed: true, snapshot: 'pinned', block: { number: '1000', hash: HASH, timestamp: '12345' } };
const scope: PlanScope = { chainId: 100, orgId: ORG, contract: TM, account: ACCOUNT, endpoint: source.endpoint,
  contracts: { membershipAuthority: AUTH } };
const complete: Coverage = { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] };
const snapshot = <T>(data: T, s = source): SourceSnapshot<T> => ({ source: { ...s, ...(s.block ? { block: { ...s.block } } : {}) }, data, coverage: complete });
function value<T>(fact: Fact<T>): T { if (fact.state !== 'known') throw new Error(fact.code); return fact.value; }
function creator(ids: readonly string[] = [MAX], member: Fact<boolean> = knownFact(true)): ProjectCreatorInput {
  const authority: AuthorityPermissionData = { subjects: [{ subjectId: ROLE, kind: 'Role', name: null }, { subjectId: MAX, kind: 'Group', name: 'Creators' }],
    groupEdges: [{ id: 'current-edge', groupSubjectId: MAX, roleSubjectId: ROLE, isActive: true }], permissions: [] };
  const authoritySource = { ...source, contract: AUTH, method: 'authority' };
  return { scope, taskManager: snapshot({ creatorSubjectIds: knownFact(ids), membershipAuthority: knownFact(AUTH), executor: knownFact(OTHER) }),
    authority: snapshot(authority, authoritySource), memberships: snapshot<readonly AuthorityMemberFact[]>([{ subjectId: ROLE, isMember: member }], { ...authoritySource, account: ACCOUNT }) };
}

describe('current source-qualified V2 project creator authorization', () => {
  it('uses exact uint256/adopted subjects and current active groups without permission rows or Hats interpretation', () => {
    const input = creator();
    expect(value(deriveProjectCreatorAuthorization(input).creator)).toBe(true);
    input.authority.data.groupEdges = [{ ...input.authority.data.groupEdges[0], isActive: false }];
    expect(value(deriveProjectCreatorAuthorization(input).creator)).toBe(false);
    expect(value(deriveProjectCreatorAuthorization(creator([ROLE])).creator)).toBe(true);
    expect(value(deriveProjectCreatorAuthorization(creator([MAX], knownFact(false))).authorized)).toBe(false);
  });
  it('empty selectors never mean open; only the actual module Executor bypasses membership', () => {
    const input = creator([]);
    expect(value(deriveProjectCreatorAuthorization(input).authorized)).toBe(false);
    input.taskManager.data.executor = knownFact(ACCOUNT.toUpperCase().replace('0X', '0x'));
    const result = deriveProjectCreatorAuthorization(input);
    expect(value(result.creator)).toBe(false); expect(value(result.executor)).toBe(true); expect(value(result.authorized)).toBe(true);
  });
  it('keeps missing/unknown membership distinct from positive membership and proven nonmembership', () => {
    expect(deriveProjectCreatorAuthorization(creator([MAX], unknownFact('LAZY_RULE'))).creator.state).toBe('unknown');
    const input = creator(); input.memberships.data = [];
    expect(deriveProjectCreatorAuthorization(input).creator.state).toBe('unknown');
    expect(deriveProjectCreatorAuthorization(creator(['1'])).creator.state).toBe('unknown');
    expect(value(deriveProjectCreatorAuthorization(creator(['1', ROLE])).creator)).toBe(true);
    const partial = creator(); partial.memberships.coverage = { ...complete, status: 'incomplete' };
    expect(deriveProjectCreatorAuthorization(partial).creator.state).toBe('unknown');
  });
  it('Executor bypass is explicit when selector/member facts are unknown', () => {
    const input = creator([MAX], unknownFact('LAZY_RULE')); input.taskManager.data.executor = knownFact(ACCOUNT);
    expect(deriveProjectCreatorAuthorization(input)).toMatchObject({ creator: { state: 'unknown' }, authorized: { state: 'known', value: true } });
    input.taskManager.data.creatorSubjectIds = unknownFact('NO_SELECTORS');
    expect(value(deriveProjectCreatorAuthorization(input).authorized)).toBe(true);
    input.taskManager.data.executor = unknownFact('NO_EXECUTOR');
    expect(deriveProjectCreatorAuthorization(input).authorized.state).toBe('unknown');
    expect(value(deriveProjectCreatorAuthorization({ ...creator(), taskManager: { ...creator().taskManager, data: {
      ...creator().taskManager.data, executor: unknownFact('NO_EXECUTOR') } } }).authorized)).toBe(true);
  });
  for (const observation of ['taskManager', 'authority', 'memberships'] as const) {
    for (const [dimension, change] of Object.entries({ chainId: 42161, orgId: PID, contract: OTHER, endpoint: 'fixture://other',
      account: OTHER, indexed: false, snapshot: 'latest', block: { number: '1001', hash: HASH, timestamp: '12345' } })) {
      it(`rejects ${observation} ${dimension} changes, including alongside Executor`, () => {
        const input = creator(); input.taskManager.data.executor = knownFact(ACCOUNT);
        input[observation].source = { ...input[observation].source, [dimension]: change };
        expect(deriveProjectCreatorAuthorization(input).authorized.state).toBe('unknown');
      });
    }
    it(`rejects ${observation} incomplete/inconsistent coverage and missing block dimensions`, () => {
      for (const coverage of [{ ...complete, status: 'incomplete' as const }, { ...complete, issues: [{ code: 'BAD_PAGE' }] }]) {
        const input = creator(); input[observation].coverage = coverage;
        expect(deriveProjectCreatorAuthorization(input).authorized.state).toBe('unknown');
      }
      const input = creator(); input[observation].source.block = { number: '1000' };
      expect(deriveProjectCreatorAuthorization(input).authorized.state).toBe('unknown');
    });
  }
  it.each(['creatorSubjectIds', 'membershipAuthority', 'executor', 'member'] as const)('checks attached %s fact provenance', field => {
    for (const change of [{ chainId: 42161 }, { orgId: PID }, { contract: OTHER }, { endpoint: 'fixture://other' },
      { block: { number: '1001', hash: HASH } }, { snapshot: 'latest' as const }, { indexed: false }]) {
      const input = creator();
      if (field === 'member') input.memberships.data[0].isMember = knownFact(true, { ...input.memberships.source, ...change });
      else input.taskManager.data[field] = { ...input.taskManager.data[field], source: { ...source, ...change } } as never;
      expect(deriveProjectCreatorAuthorization(input).authorized.state).toBe('unknown');
    }
  });
  it('rejects attached foreign-account facts and a missing host-selected applicant block', async () => {
    const input = creator(); input.taskManager.data.creatorSubjectIds = knownFact([MAX], { ...source, account: OTHER });
    expect(deriveProjectCreatorAuthorization(input).authorized.state).toBe('unknown');
    const applications = await listTaskApplicationsComplete(pageOptions(async () => response()));
    expect(projectTaskApplicant({ applications, scope, task: TASK, block: undefined as never }).state).toBe('unknown');
  });
  it('rejects zero/foreign binding, missing account, malformed and rounded IDs and duplicate membership', () => {
    for (const binding of [ZERO, OTHER]) {
      const input = creator(); input.taskManager.data.membershipAuthority = knownFact(binding);
      expect(deriveProjectCreatorAuthorization(input).authorized.state).toBe('unknown');
    }
    for (const id of ['-1', ((1n << 256n)).toString(), 9007199254740992, undefined]) {
      const input = creator([id as string]); expect(deriveProjectCreatorAuthorization(input).authorized.state).toBe('unknown');
    }
    const input = creator(); input.memberships.data = [...input.memberships.data, input.memberships.data[0]];
    expect(deriveProjectCreatorAuthorization(input).creator.state).toBe('unknown');
    expect(deriveProjectCreatorAuthorization({ ...creator(), scope: { ...scope, account: undefined } }).authorized.state).toBe('unknown');
    expect(deriveProjectCreatorAuthorization({ ...creator(), scope: { ...scope, account: ZERO } }).authorized.state).toBe('unknown');
  });
  it('malformed supplied authority/membership data or inconsistent binding cannot piggyback on Executor', () => {
    for (const ids of [[], [MAX]]) {
      const input = creator(ids); input.taskManager.data.executor = knownFact(ACCOUNT);
      input.authority.data.subjects = [...input.authority.data.subjects, input.authority.data.subjects[0]];
      expect(deriveProjectCreatorAuthorization(input).authorized.state).toBe('unknown');
    }
    const input = creator(); input.taskManager.data.executor = knownFact(ACCOUNT);
    input.memberships.data[0].isMember = knownFact('invalid' as never);
    expect(deriveProjectCreatorAuthorization(input).authorized.state).toBe('unknown');
    for (const observation of ['taskManager', 'authority', 'memberships'] as const) {
      const input = creator(); input[observation].source.contracts = { membershipAuthority: OTHER };
      expect(deriveProjectCreatorAuthorization(input).authorized.state).toBe('unknown');
    }
    const fieldBinding = creator(); fieldBinding.taskManager.data.creatorSubjectIds = knownFact([MAX], { ...source, contracts: { membershipAuthority: OTHER } });
    expect(deriveProjectCreatorAuthorization(fieldBinding).authorized.state).toBe('unknown');
    const memberBinding = creator(); memberBinding.memberships.data[0].isMember = knownFact(true, { ...memberBinding.memberships.source, contracts: { membershipAuthority: OTHER } });
    expect(deriveProjectCreatorAuthorization(memberBinding).authorized.state).toBe('unknown');
  });
  it('feeds TaskPolicyFacts.creator without granting manager/CREATE project deletion or conflating Executor', () => {
    const facts: TaskPolicyFacts = { projectId: knownFact(PID), actor: knownFact(ACCOUNT), executor: knownFact(false),
      projectManager: knownFact(true), permissionMask: knownFact('1'), projectExists: knownFact(true),
      creator: deriveProjectCreatorAuthorization(creator([], knownFact(false))).creator,
      taskExists: knownFact(true), status: knownFact(0), claimer: knownFact(ZERO), absoluteDeadline: knownFact(0), claimDeadline: knownFact(0),
      requiresApplication: knownFact(false), alreadyApplied: knownFact(false) };
    const input = { projectId: PID, scope, snapshot: snapshot(facts, { ...source, account: ACCOUNT, contracts: scope.contracts }), now: 12345 };
    expect(decideTaskActions(input).create.state).toBe('allowed'); expect(decideTaskActions(input).deleteProject.state).toBe('denied');
    facts.creator = deriveProjectCreatorAuthorization(creator()).creator;
    expect(decideTaskActions(input).deleteProject.state).toBe('allowed');
  });
});

function mixedCreator(): ProjectCreatorInput & { sources: NonNullable<ProjectCreatorInput['sources']> } {
  const input = creator();
  // The serving schema has no module executor/authority binding. Only these
  // settings use RPC; authority subjects/edges and account memberships stay indexed.
  input.taskManager.source = { ...input.taskManager.source, endpoint: 'fixture://rpc', method: 'eth_call', indexed: false,
    block: { number: '1000', hash: HASH } };
  return { ...input, sources: {
    taskManager: { endpoint: 'fixture://rpc', method: 'eth_call', indexed: false },
    authority: { endpoint: source.endpoint, method: 'authority', indexed: true },
    memberships: { endpoint: source.endpoint, method: 'authority', indexed: true },
    block: { number: '1000', hash: HASH },
  } };
}
function indexedPolicy(projectCreator = mixedCreator()): TaskPolicyInput {
  const facts: TaskPolicyFacts = { projectId: knownFact(PID), actor: knownFact(ACCOUNT), executor: unknownFact('NOT_INDEXED'),
    projectManager: knownFact(false), permissionMask: knownFact('0'), projectExists: knownFact(true), creator: unknownFact('NOT_INDEXED'),
    taskExists: knownFact(true), status: knownFact(0), claimer: knownFact(ZERO), absoluteDeadline: knownFact(0), claimDeadline: knownFact(0),
    requiresApplication: knownFact(false), alreadyApplied: knownFact(false) };
  return { projectId: PID, scope: { ...scope }, snapshot: snapshot(facts, { ...source, account: ACCOUNT, contracts: scope.contracts }), now: 12345, projectCreator };
}
describe('actual indexed task policy with bounded RPC creator settings', () => {
  it('consumes the actual exported indexed authority reader/account adapter, without RPC authority reconstruction', async () => {
    const input = mixedCreator();
    const subjects = [{ id: ROLE, subjectId: ROLE, kind: 'Role', name: 'Current role' }, { id: MAX, subjectId: MAX, kind: 'Group', name: 'Creators' }]
      .map(row => ({ ...row, defaultAllow: true, maxMembers: '0', memberCount: row.kind === 'Role' ? '1' : '0', activeMemberCount: '0',
        createdAt: '1', vouchConfig: null, managerConfig: null })).sort((a, b) => a.id < b.id ? -1 : 1);
    const collections: Record<string, IndexedRow[]> = { subjects, groupCompositions: [{ id: 'edge', groupSubjectId: MAX, roleSubjectId: ROLE, isActive: true }],
      subjectMemberships: [{ id: 'member', subject: subjects.find(row => row.kind === 'Role')!, user: ACCOUNT, accepted: true, acceptedAt: '1', seededWhilePaused: false,
        ruleKind: 'None', rule: null, emailVerified: false, vouchCount: '0', vouchEpoch: '0', pendingAction: null }],
      permRows: [], accessRules: [], subjectVouchRecords: [], pendingActions: [] };
    const query: AuthoritySnapshotQuery = vi.fn(async <T>(src: SourceRef, _document: string, variables: Record<string, unknown>) => {
      expect(src.indexed).toBe(true); expect(variables.block).toEqual({ hash: HASH });
      const data = { organization: { id: ORG, membershipAuthority: { id: AUTH, isRouterBound: true, cutoverAt: '1', paused: false,
        subjectCount: '2', roleSubjectCount: '1', groupSubjectCount: '1', acceptedMembershipCount: '1' } },
        _meta: { block: { number: '1000', hash: HASH, timestamp: '12345' } },
        ...Object.fromEntries(Object.entries(collections).map(([key, rows]) => [key, rows.filter(row => String(row.id) > String(variables.lastId ?? '')).slice(0, Number(variables.first ?? 10))])) };
      return { source: src, data: data as T, issues: [] };
    });
    const authority = await readAuthoritySnapshot({ source: input.authority.source, query, pageSize: 10, maxPages: 2 });
    expect(authority.coverage.status, JSON.stringify(authority.coverage)).toBe('complete');
    input.authority = authority; input.memberships = authorityAccountMembershipFacts(authority, ACCOUNT);
    expect(input.memberships.data).toHaveLength(1); // role facts; the selected Group stays a Group
    expect(input.authority.data.subjects.find(row => row.subjectId === MAX)?.kind).toBe('Group');
    expect(value(deriveProjectCreatorAuthorization(input).authorized)).toBe(true);
    expect(decideTaskActions(indexedPolicy(input)).deleteProject.state).toBe('allowed');
    expect(query).toHaveBeenCalledTimes(8);
  });
  it('preserves both original source kinds/endpoints and composes public createProject/deleteProject authorization', () => {
    const input = mixedCreator();
    const before = JSON.stringify(input);
    const creators = deriveProjectCreatorAuthorization(input);
    expect(creators.creator).toMatchObject({ state: 'known', value: true, source: { endpoint: 'fixture://rpc', indexed: false } });
    expect(value(creators.authorized)).toBe(true); // createProject gate, including first project
    const policy = indexedPolicy(input);
    expect(decideTaskActions(policy).deleteProject.state).toBe('allowed');
    expect(decideTaskActions(policy).create.state).toBe('unknown'); // the absent indexed Executor stays unknown for other task actions
    policy.snapshot.data.projectExists = knownFact(false);
    expect(decideTaskActions(policy).deleteProject).toMatchObject({ state: 'denied', reasons: ['NOT_FOUND'] });
    policy.snapshot.data.projectExists = unknownFact('PROJECT_UNAVAILABLE');
    expect(decideTaskActions(policy).deleteProject.state).toBe('unknown');
    for (const key of ['actor', 'projectId'] as const) {
      const unidentified = indexedPolicy(input); unidentified.snapshot.data[key] = unknownFact('IDENTITY_UNAVAILABLE');
      expect(decideTaskActions(unidentified).deleteProject.state).toBe('unknown');
    }
    expect(JSON.stringify(input)).toBe(before);
  });
  it('keeps arbitrary mixed inputs rejected, including directly injected RPC facts without the scoped seam', () => {
    const input = mixedCreator();
    const { sources: _sources, ...unqualified } = input;
    expect(deriveProjectCreatorAuthorization(unqualified).authorized.state).toBe('unknown');
    const policy = indexedPolicy(); delete policy.projectCreator;
    policy.snapshot.data.creator = deriveProjectCreatorAuthorization(input).creator;
    expect(decideTaskActions(policy).deleteProject).toMatchObject({ state: 'unknown', reasons: ['INVALID_FACT'] });
  });
  it('preserves groups, empty selector denial, unknown members and module Executor without granting unrelated task actions', () => {
    const input = mixedCreator(); input.taskManager.data.creatorSubjectIds = knownFact([]);
    expect(value(deriveProjectCreatorAuthorization(input).authorized)).toBe(false);
    expect(decideTaskActions(indexedPolicy(input)).deleteProject.state).toBe('denied');
    input.taskManager.data.executor = knownFact(ACCOUNT);
    const decisions = decideTaskActions(indexedPolicy(input));
    expect(decisions.deleteProject.state).toBe('allowed'); expect(decisions.budget.state).toBe('unknown');
    input.taskManager.data.executor = knownFact(OTHER);
    input.taskManager.data.creatorSubjectIds = knownFact([MAX]); input.memberships.data[0].isMember = unknownFact('LAZY_RULE');
    expect(decideTaskActions(indexedPolicy(input)).deleteProject.state).toBe('unknown');
    input.taskManager.data.executor = knownFact(ACCOUNT);
    expect(decideTaskActions(indexedPolicy(input)).deleteProject.state).toBe('allowed');
  });
  for (const observation of ['taskManager', 'authority', 'memberships'] as const) {
    for (const [dimension, change] of Object.entries({ chainId: 42161, orgId: PID, contract: OTHER, account: OTHER,
      endpoint: 'fixture://foreign', method: 'foreign', indexed: observation === 'taskManager', snapshot: 'latest',
      block: { number: '1000', hash: PID }, missingHash: { number: '1000' }, number: { number: '1001', hash: HASH } })) {
      it(`rejects explicitly composed ${observation} ${dimension}, even for Executor`, () => {
        const input = mixedCreator(); input.taskManager.data.executor = knownFact(ACCOUNT);
        const field = ['missingHash', 'number'].includes(dimension) ? 'block' : dimension;
        input[observation].source = { ...input[observation].source, [field]: change };
        expect(deriveProjectCreatorAuthorization(input).authorized.state).toBe('unknown');
        expect(decideTaskActions(indexedPolicy(input)).deleteProject.state).toBe('unknown');
      });
    }
    it(`rejects partial ${observation} and inconsistent attached fact sources`, () => {
      const input = mixedCreator(); input[observation].coverage = { ...complete, status: 'incomplete' };
      expect(decideTaskActions(indexedPolicy(input)).deleteProject.state).toBe('unknown');
      const attached = mixedCreator();
      if (observation === 'taskManager') attached.taskManager.data.executor = knownFact(ACCOUNT, source);
      else attached.memberships.data[0].isMember = knownFact(true, { ...attached.memberships.source, endpoint: 'fixture://foreign' });
      expect(decideTaskActions(indexedPolicy(attached)).deleteProject.state).toBe('unknown');
    });
  }
  it('requires explicit complete expected sources and canonical block hash', () => {
    for (const mutate of [
      (i: ReturnType<typeof mixedCreator>) => { delete (i.sources as any).taskManager; },
      (i: ReturnType<typeof mixedCreator>) => { delete (i.sources.taskManager as any).indexed; },
      (i: ReturnType<typeof mixedCreator>) => { delete (i.sources.block as any).hash; },
      (i: ReturnType<typeof mixedCreator>) => { i.sources.block.hash = PID; },
      (i: ReturnType<typeof mixedCreator>) => { i.sources.block.timestamp = '1'; },
      (i: ReturnType<typeof mixedCreator>) => { i.memberships.source.block!.timestamp = '1'; },
    ]) {
      const input = mixedCreator(); mutate(input);
      expect(deriveProjectCreatorAuthorization(input).authorized.state).toBe('unknown');
      expect(decideTaskActions(indexedPolicy(input)).deleteProject.state).toBe('unknown');
    }
  });
  it('checks the indexed policy source and scope against creator proof without relaxing other fact validation', () => {
    for (const change of [{ chainId: 42161 }, { orgId: PID }, { contract: OTHER }, { account: OTHER }, { endpoint: 'fixture://foreign' },
      { indexed: false }, { snapshot: 'latest' }, { block: { number: '1000', hash: PID } }, { block: { number: '1000' } }]) {
      const policy = indexedPolicy(); policy.snapshot.source = { ...policy.snapshot.source, ...change } as SourceRef;
      expect(decideTaskActions(policy).deleteProject.state).toBe('unknown');
    }
    for (const change of [{ chainId: 42161 }, { orgId: PID }, { contract: OTHER }, { account: OTHER }, { contracts: { membershipAuthority: OTHER } }]) {
      const policy = indexedPolicy(); policy.projectCreator!.scope = { ...policy.projectCreator!.scope, ...change };
      expect(decideTaskActions(policy).deleteProject.state).toBe('unknown');
    }
    const policy = indexedPolicy(); delete policy.scope.endpoint;
    expect(decideTaskActions(policy).deleteProject.state).toBe('unknown');
    const invalid = indexedPolicy(); invalid.snapshot.data.permissionMask = knownFact('256');
    expect(decideTaskActions(invalid).deleteProject.state).toBe('unknown');
    for (const key of ['projectId', 'actor', 'projectExists'] as const) {
      for (const change of [{ endpoint: 'fixture://foreign' }, { indexed: false }, { snapshot: 'latest' }]) {
        const scoped = indexedPolicy();
        scoped.snapshot.data[key] = { ...scoped.snapshot.data[key], source: { ...scoped.snapshot.source, ...change } as SourceRef } as never;
        expect(decideTaskActions(scoped).deleteProject.state).toBe('unknown');
      }
    }
  });
});

const project = () => ({ id: `${TM}-${PID}`, projectId: PID, deleted: false, taskManager: { id: TM, organization: { id: ORG } } });
const parent = () => ({ id: ENTITY, taskId: TASK, taskManager: TM, project: project() });
function application(i: number): IndexedRow {
  return { id: `app-${String(i).padStart(5, '0')}`, applicant: i === 150 ? ACCOUNT : `0x${BigInt(i + 1).toString(16).padStart(40, '0')}`,
    applicantUsername: null, applicationHash: HASH, metadata: { id: `metadata-${i}`, notes: `notes-${i}`, experience: 'original', indexedAt: null },
    approved: false, approver: null, approverUsername: null, appliedAt: '123', appliedAtBlock: '999', approvedAt: null, task: parent() };
}
function response(rows: IndexedRow[] = []) { return { organization: { id: ORG, taskManager: { id: TM, organization: { id: ORG } } },
  tasks: [parent()], taskApplications: rows, _meta: { block: { number: 1000, hash: HASH, timestamp: 12345 } } }; }
const pageOptions = (query: TaskApplicationPageOptions['query']): TaskApplicationPageOptions => ({ source, task: TASK, pageSize: 100, maxPages: 5, query });
async function list(rows: IndexedRow[]) {
  const query = vi.fn(async (_doc: string, variables: Record<string, unknown>) => response(rows.filter(r => String(r.id) > String(variables.cursor)).slice(0, Number(variables.first))));
  return { result: await listTaskApplicationsComplete(pageOptions(query)), query };
}
const applied = (applications: Awaited<ReturnType<typeof listTaskApplicationsComplete>>, account = ACCOUNT, task = TASK) => projectTaskApplicant({
  applications, scope: { chainId: source.chainId, orgId: ORG, contract: TM, endpoint: source.endpoint, account }, task, block: source.block! });

describe('complete on-demand task application pages and applicant facts', () => {
  it('pages beyond the 100-row preview, retaining raw identities, metadata and exact task IDs', async () => {
    const rows = Array.from({ length: 251 }, (_, i) => application(i));
    const { result, query } = await list(rows);
    expect(result.coverage).toMatchObject({ status: 'complete', pages: 3, cap: 500, cursor: 'app-00250' });
    expect(result.data.applications).toEqual(rows); expect(result.data.applications[150]).toBe(rows[150]);
    expect(query).toHaveBeenCalledTimes(3);
    for (const [doc, vars, src] of query.mock.calls as unknown as [string, Record<string, unknown>, SourceRef][]) {
      expect(doc).toBe(FETCH_TASK_APPLICATIONS_PAGE); expect(vars).toMatchObject({ orgId: ORG, taskManager: TM, taskId: ENTITY, first: 100, block: { hash: HASH } }); expect(src).toBe(source);
    }
    expect(value(applied(result))).toBe(true); expect(value(applied(result, OTHER))).toBe(false);
    expect(applied(result, ACCOUNT, '1').state).toBe('unknown');
  });
  it('attests a terminal empty page and binds an initially empty collection to the exact parent', async () => {
    const { result, query } = await list(Array.from({ length: 200 }, (_, i) => application(i)));
    expect(result.coverage).toMatchObject({ status: 'complete', pages: 3 }); expect(query).toHaveBeenCalledTimes(3);
    const empty = (await list([])).result;
    expect(value(applied(empty))).toBe(false); expect(empty.data.task).toEqual(parent()); expect(applied(empty, ACCOUNT, '1').state).toBe('unknown');
  });
  it('a full page at the bound cannot prove presence or absence; duplicates/nonadvancing order stay incomplete', async () => {
    const capped = await listTaskApplicationsComplete({ ...pageOptions(async () => response(Array.from({ length: 100 }, (_, i) => application(i)))), maxPages: 1 });
    expect(capped.coverage).toMatchObject({ status: 'incomplete', issues: [{ code: 'PAGE_CAP' }] }); expect(applied(capped).state).toBe('unknown');
    for (const rows of [[application(1), application(1)], [application(2), application(1)], [application(1), { ...application(2), applicant: application(1).applicant }]]) {
      const result = await listTaskApplicationsComplete(pageOptions(async () => response(rows)));
      expect(applied(result).state).toBe('unknown');
      if (rows[0].id === rows[1].id || rows[0].id! > rows[1].id!) expect(result.coverage.status).toBe('incomplete');
    }
    const query = vi.fn(async () => response(Array.from({ length: 100 }, (_, i) => application(i))));
    expect((await listTaskApplicationsComplete(pageOptions(query))).coverage.issues.some(i => i.code === 'NONADVANCING_CURSOR')).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });
  const badResponses: Record<string, (r: ReturnType<typeof response>) => Record<string, unknown>> = {
    'missing parent': r => ({ ...r, tasks: [] }), 'ambiguous parent': r => ({ ...r, tasks: [parent(), parent()] }),
    'wrong task': r => ({ ...r, tasks: [{ ...parent(), id: `${TM}-1`, taskId: '1' }] }),
    'wrong module': r => ({ ...r, organization: { id: ORG, taskManager: { id: OTHER, organization: { id: ORG } } } }),
    'wrong org': r => ({ ...r, organization: { id: PID, taskManager: { id: TM, organization: { id: ORG } } } }),
    'missing block': r => ({ ...r, _meta: undefined }),
    'wrong block': r => ({ ...r, _meta: { block: { number: 1001, hash: HASH, timestamp: 12345 } } }),
    'wrong hash': r => ({ ...r, _meta: { block: { number: 1000, hash: PID, timestamp: 12345 } } }),
    'missing collection': r => ({ ...r, taskApplications: null }), 'GraphQL error': r => ({ ...r, errors: [{ message: 'fixture failure' }] }),
  };
  for (const [name, mutate] of Object.entries(badResponses)) it(`rejects ${name} on first and empty terminal pages`, async () => {
    for (const terminal of [false, true]) {
      let page = 0;
      const query = vi.fn(async () => { page++; return terminal && page === 1 ? response(Array.from({ length: 100 }, (_, i) => application(i))) : mutate(response()); });
      const result = await listTaskApplicationsComplete(pageOptions(query));
      expect(result.coverage.status).toBe(terminal ? 'incomplete' : 'unavailable'); expect(applied(result).state).toBe('unknown');
    }
  });
  it.each(['task', 'applicant', 'applicationHash', 'metadata', 'appliedAtBlock', 'approved'])('malformed or mixed-parent %s is retained only diagnostically', async field => {
    const row = application(0);
    row[field] = ({ task: { ...parent(), id: `${TM}-1`, taskId: '1' }, applicant: ZERO, applicationHash: '0x12', metadata: {}, appliedAtBlock: '1001', approved: null } as Record<string, unknown>)[field];
    const result = await listTaskApplicationsComplete(pageOptions(async () => response([row])));
    expect(result.coverage.status).toBe('incomplete'); expect(result.data.applications[0]).toBe(row); expect(applied(result).state).toBe('unknown');
  });
  it('checks row/parent project authority, changed parent, endpoint/account/block and source-kind boundaries', async () => {
    const row = application(0); (row.task as any).project.taskManager.organization.id = PID;
    expect((await listTaskApplicationsComplete(pageOptions(async () => response([row])))).coverage.status).toBe('incomplete');
    const query = vi.fn(async () => { const r = response(query.mock.calls.length === 1 ? Array.from({ length: 100 }, (_, i) => application(i)) : []);
      if (query.mock.calls.length > 1) r.tasks[0].project.id = 'changed-parent'; return r; });
    expect((await listTaskApplicationsComplete(pageOptions(query))).coverage.status).toBe('incomplete');
    const result = (await list([])).result;
    for (const change of [{ chainId: 42161 }, { orgId: PID }, { contract: OTHER }, { endpoint: 'fixture://other' }, { account: OTHER }, { indexed: false }, { snapshot: 'latest' as const }]) {
      expect(applied({ ...result, source: { ...result.source, ...change } }).state).toBe('unknown');
    }
    expect(projectTaskApplicant({ applications: result, scope: { ...scope, contracts: undefined }, task: TASK, block: { number: '1001' } }).state).toBe('unknown');
  });
  it('requires explicit valid bounds, pinned indexed nonzero module and exact task IDs before querying', async () => {
    const query = vi.fn(async () => response());
    for (const changes of [{ pageSize: undefined }, { maxPages: 0 }, { pageSize: 1001 }, { maxPages: 1.5 },
      { task: 9007199254740992 }, { task: `${OTHER}-1` }, { task: (1n << 256n).toString() }, { source: { ...source, snapshot: 'latest' } },
      { source: { ...source, indexed: false } }, { source: { ...source, contract: ZERO } }]) {
      await expect(listTaskApplicationsComplete({ ...pageOptions(query), ...changes } as TaskApplicationPageOptions)).rejects.toThrow();
    }
    expect(query).not.toHaveBeenCalled();
  });
  it('does not expose transport/provider errors in retained diagnostics', async () => {
    const result = await listTaskApplicationsComplete(pageOptions(async () => { throw new Error('private transport fixture'); }));
    expect(JSON.stringify(result)).not.toContain('private transport fixture'); expect(applied(result).state).toBe('unknown');
  });
  it('malformed collections and dropped/replaced/duplicated rows cannot reuse complete coverage to prove absence', async () => {
    const result = (await list([application(150), application(151)])).result;
    for (const rows of ['', [], [application(1), application(2)], [application(150), application(150)]]) {
      expect(applied({ ...result, data: { ...result.data, applications: rows as never } }).state).toBe('unknown');
    }
  });
});

describe('full cached serving schemas and inspected creator source', () => {
  const base = new URL('./fixtures/core-update/work/project-applications/', import.meta.url);
  const provenance = JSON.parse(readFileSync(new URL('provenance.json', base), 'utf8'));
  for (const fixture of provenance.sources) {
    const packed = readFileSync(new URL(fixture.fixture, base)); const bytes = gunzipSync(packed);
    const raw = JSON.parse(bytes.toString()); const schema = buildClientSchema(raw.data);
    it(`validates actual application document with FULL chain ${fixture.chainId} buildClientSchema(raw.data)`, () => {
      expect(createHash('sha256').update(packed).digest('hex')).toBe(fixture.gzipSha256);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.rawSha256); expect(bytes.length).toBe(fixture.rawBytes);
      expect(Object.keys(schema.getTypeMap()).length).toBeGreaterThan(500);
      expect(validate(schema, parse(FETCH_TASK_APPLICATIONS_PAGE)).map(e => e.message)).toEqual([]);
      const op = parse(FETCH_TASK_APPLICATIONS_PAGE).definitions[0]; if (op.kind !== Kind.OPERATION_DEFINITION) throw new Error('Operation expected');
      for (const field of op.selectionSet.selections) {
        if (field.kind !== Kind.FIELD) throw new Error('Field expected');
        expect(field.arguments?.find(a => a.name.value === 'block')?.value).toMatchObject({ kind: Kind.VARIABLE, name: { value: 'block' } });
      }
      expect(FETCH_TASK_APPLICATIONS_PAGE).toContain('where: { task: $taskId, task_: { taskManager: $taskManager }, id_gt: $cursor }');
      expect(FETCH_TASK_APPLICATIONS_PAGE).toContain('orderBy: id, orderDirection: asc');
      for (const [from, to] of [['$taskId: String!', '$taskId: Bytes!'], ['$cursor: String!', '$cursor: Bytes!'], ['$taskManager: Bytes!', '$taskManager: String!'], ['applicationHash metadata', 'transactionHash metadata']]) {
        expect(validate(schema, parse(FETCH_TASK_APPLICATIONS_PAGE.replace(from, to))).length).toBeGreaterThan(0);
      }
      const task = schema.getType('Task') as any;
      expect(task.getFields().applications.args.find((a: any) => a.name === 'first').defaultValue).toBe(100);
      expect((schema.getType('TaskManager') as any).getFields().membershipAuthority).toBeUndefined();
      expect((schema.getType('TaskManager') as any).getFields().executor).toBeUndefined();
    });
  }
  it('retains exact V2 creator-rule provenance without a deployed-bytecode claim', () => {
    const bytes = readFileSync(new URL('../TaskManager.sol.txt', base)); const contract = bytes.toString();
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(provenance.contractSha256);
    expect(contract).toContain('if (!_hasCreatorHat(s) && s != l.executor) revert NotCreator();');
    expect(contract).toContain('return _authorityHoldsAny(a, l.creatorHatIds, user);');
    expect(contract).toContain('if (IMembershipAuthority(authority).isMember(subjectIds[i], user)) return true;');
    expect(contract.match(/_requireCreator\(\);/g)).toHaveLength(2);
  });
});

describe('project creator/application browser leaves', () => {
  it.each(['tasks/project-creator', 'tasks/policy', 'reads/task', 'graph/documents/task'])('%s bundles without Node or optional signing closure', async leaf => {
    const entry = packedRequire ? packedRequire.resolve(`@poa-box/core/${leaf}`) : resolve(__dirname, `../src/${leaf}.ts`);
    const result = await build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true });
    expect(Object.keys(result.metafile!.inputs).filter(path => /\/execute\/|\/viem\/|\/permissionless\/|(?:src\/index\.ts|dist\/index\.js)$/.test(path))).toEqual([]);
    expect(result.outputFiles[0].text.length).toBeGreaterThan(0);
  });
  if (packedRequire) it('packed root/barrels preserve old and new public exports and shipped documentation/declarations', () => {
    for (const leaf of ['tasks/project-creator', 'tasks/policy', 'reads/authority', 'reads/task', 'graph/documents/task']) {
      expect(packedRequire.resolve(`@poa-box/core/${leaf}`)).toBe(resolve(process.env.POA_CORE_PACKED_ROOT!, `dist/${leaf}.js`));
    }
    const root = packedRequire('@poa-box/core');
    expect(typeof root.tasks.decideTaskActions).toBe('function');
    expect(typeof root.tasks.deriveProjectCreatorAuthorization).toBe('function');
    expect(typeof root.reads.task.fetchTaskData).toBe('function');
    expect(typeof root.reads.task.listTaskApplicationsComplete).toBe('function');
    expect(packedRequire('@poa-box/core/tasks').deriveProjectCreatorAuthorization).toBe(deriveProjectCreatorAuthorization);
    expect(packedRequire('@poa-box/core/graph/documents').taskDocuments.FETCH_TASK_APPLICATIONS_PAGE).toBe(FETCH_TASK_APPLICATIONS_PAGE);
    for (const path of ['dist/tasks/project-creator.d.ts', 'dist/reads/task.d.ts', 'docs/frontend-adoption.md']) {
      expect(readFileSync(resolve(process.env.POA_CORE_PACKED_ROOT!, path), 'utf8').length).toBeGreaterThan(0);
    }
    expect(Object.keys(packedRequire.cache).filter(path => /\/node_modules\/(viem|permissionless)\//.test(path))).toEqual([]);
  });
});
