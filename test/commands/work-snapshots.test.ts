import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ source: vi.fn(), resolve: vi.fn(), network: vi.fn(), json: vi.fn(), error: vi.fn() }));
vi.mock('../../src/lib/indexed-source', () => ({ createIndexedSource: mocks.source }));
vi.mock('../../src/lib/resolve', () => ({ resolveOrgModules: mocks.resolve, requireModule: (modules: any, key: string) => modules[key] }));
vi.mock('../../src/config/networks', () => ({ resolveNetworkConfig: mocks.network }));
vi.mock('../../src/lib/output', () => ({ json: mocks.json, error: mocks.error, isJsonMode: () => true, info: vi.fn(), warn: vi.fn(),
  table: vi.fn(), spinner: () => ({ start() {}, stop() {} }) }));
import { snapshotHandler } from '../../src/commands/task/snapshot';
import { lookupHandler, credentialsHandler } from '../../src/commands/user/lookup';
import { listHandler as educationList } from '../../src/commands/education/list';
import * as output from '../../src/lib/output';

const TM = '0x1111111111111111111111111111111111111111', ACCOUNT = '0x2222222222222222222222222222222222222222';
const ORG = '0x' + '33'.repeat(32), HASH = '0x' + '44'.repeat(32), PID = '0x' + '00'.repeat(32);
const source = { chainId: 42161, endpoint: 'fixture://selected', method: 'indexed', indexed: true, snapshot: 'pinned' as const,
  block: { number: '50', hash: HASH }, orgId: ORG, contract: TM };
const project = { id: `project-0`, projectId: PID, cap: '1', deleted: false, taskManager: { id: TM, organization: { id: ORG } } };
const meta = { block: { number: 50, hash: HASH } };

describe('CLI host adoption of independently paged work and identity readers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.network.mockReturnValue({ chainId: 42161 });
    mocks.resolve.mockResolvedValue({ orgId: ORG, taskManagerAddress: TM, educationHubAddress: TM });
  });

  it('reads beyond the page size and retains a failed later stream as incomplete', async () => {
    const rows = [0, 1, 2].map(i => ({ id: `task-${i}`, taskId: String(i), taskManager: TM, project, payout: '900719925474099300001', bountyPayout: '0' }));
    const query = vi.fn(async (document: string, vars: any, actual: any) => {
      expect(actual).toMatchObject(source); expect(vars.block).toEqual({ hash: HASH });
      const collection = document.includes('query TasksPage') ? 'tasks' : document.includes('query ProjectsPage') ? 'projects' : 'projectManagers';
      if (collection === 'projectManagers') throw new Error('Unavailable history');
      const all = collection === 'tasks' ? rows : [project];
      return { [collection]: all.filter(row => row.id > vars.cursor).slice(0, vars.first),
        organization: { id: ORG, taskManager: { id: TM, organization: { id: ORG } } }, _meta: meta };
    });
    mocks.source.mockResolvedValue({ source, protocolQuery: query });
    await snapshotHandler.handler({ org: 'org', chain: 42161, pageSize: 2, maxPages: 10 } as any);
    const result = mocks.json.mock.calls[0][0];
    expect(result.tasks.coverage.status).toBe('complete'); expect(result.tasks.data).toHaveLength(3);
    expect(result.tasks.data[2].payout).toBe('900719925474099300001');
    expect(result.projects.coverage.status).toBe('complete'); expect(result.managers.coverage.status).toBe('unavailable');
    expect(result.managers.source.snapshot).toBe('unknown');
  });

  it('does not turn a bounded full page into a complete task board', async () => {
    mocks.source.mockResolvedValue({ source, protocolQuery: async (document: string) => ({
      tasks: document.includes('query TasksPage') ? [{ id: 'task-0', taskId: '0', taskManager: TM, project, payout: '1', bountyPayout: '0' }] : [],
      projects: [], projectManagers: [], organization: { id: ORG, taskManager: { id: TM, organization: { id: ORG } } }, _meta: meta,
    }) });
    await snapshotHandler.handler({ org: 'org', pageSize: 1, maxPages: 1 } as any);
    expect(mocks.json.mock.calls[0][0].tasks.coverage.status).toBe('incomplete');
  });

  it.each(['present', 'absent', 'unavailable'] as const)('projects applicant %s only from complete exact-task evidence', async state => {
    const parent = { id: `${TM}-7`, taskId: '7', taskManager: TM, project };
    const application = { id: 'application-0', task: parent, applicant: ACCOUNT, applicantUsername: null, approverUsername: null,
      approved: false, applicationHash: HASH, approver: null, appliedAt: '1', appliedAtBlock: '40', approvedAt: null, metadata: null };
    mocks.source.mockResolvedValue({ source, protocolQuery: async (document: string) => {
      const detail = document.includes('query TaskApplicationsPage');
      if (detail && state === 'unavailable') throw new Error('Detail unavailable');
      return { tasks: detail ? [parent] : [], projects: [], projectManagers: [], taskClaimExpiries: [],
        taskApplications: detail && state === 'present' ? [application] : [],
        organization: { id: ORG, taskManager: { id: TM, organization: { id: ORG } } }, _meta: meta };
    } });
    await snapshotHandler.handler({ org: 'org', task: '7', account: ACCOUNT, pageSize: 100, maxPages: 10 } as any);
    const result = mocks.json.mock.calls[0][0];
    expect(result.applicant).toMatchObject(state === 'unavailable' ? { state: 'unknown' } : { state: 'known', value: state === 'present' });
    if (state !== 'unavailable') expect(result.applicant.source).toMatchObject({ account: ACCOUNT, contract: TM, endpoint: source.endpoint, block: source.block });
  });

  it('preserves unknown credential keys through the exact serving-schema fallback', async () => {
    const { orgId: _org, contract: _contract, ...global } = source;
    const query = vi.fn(async (document: string, vars: any) => {
      if (document.includes('publicKeyX')) throw { response: { status: 200, errors: [{ message: 'Type `PasskeyCredential` has no field `publicKeyX`' }] } };
      return { passkeyCredentials: vars.cursor ? [] : [{ id: 'credential-0', credentialId: HASH, account: { id: ACCOUNT }, active: false,
        createdAt: '1', removedAt: '2' }], _meta: meta };
    });
    mocks.source.mockResolvedValue({ source: { ...global, account: ACCOUNT }, protocolQuery: query });
    await credentialsHandler.handler({ account: ACCOUNT, chain: 42161, pageSize: 100, maxPages: 10 } as any);
    const result = mocks.json.mock.calls[0][0];
    expect(result.coverage.status).toBe('complete'); expect(result.credentials[0].active).toMatchObject({ state: 'known', value: false });
    expect(result.credentials[0].publicKeyX).toMatchObject({ state: 'unknown' }); expect(query).toHaveBeenCalledTimes(2);
  });

  it('keeps a complete scoped identity no-match distinct from an unavailable source', async () => {
    const { orgId: _org, contract: _contract, ...global } = source;
    mocks.source.mockResolvedValue({ source: global, protocolQuery: async () => ({ accounts: [], _meta: meta }) });
    await lookupHandler.handler({ registry: [TM], account: [ACCOUNT], pageSize: 100, maxPages: 10 } as any);
    expect(mocks.json.mock.calls[0][0]).toMatchObject({ data: [], coverage: { status: 'complete' }, selector: { kind: 'addresses', addresses: [ACCOUNT] } });
    expect(mocks.source).toHaveBeenCalledWith({ chainId: 42161 });
  });

  it('lists every education module while leaving unavailable completion counts unknown', async () => {
    const modules = Array.from({ length: 101 }, (_, i) => ({ id: `module-${String(i).padStart(3, '0')}`, moduleId: String(i), title: `Module ${i}`,
      payout: '1', status: 'Active', educationHub: { id: TM, organization: { id: ORG } }, metadata: null }));
    mocks.source.mockResolvedValue({ source, protocolQuery: async (document: string, vars: any) => {
      if (!document.includes('query ModulesPage')) throw new Error('Completion history unavailable');
      return { educationModules: modules.filter(row => row.id > vars.cursor).slice(0, vars.first), _meta: meta };
    } });
    await educationList.handler({ org: 'org', chain: 42161 } as any);
    const [headers, rows] = vi.mocked(output.table).mock.calls[0];
    expect(headers).toContain('Completions'); expect(rows).toHaveLength(101); expect(rows[100][4]).toBe('(unknown)');
  });
});
