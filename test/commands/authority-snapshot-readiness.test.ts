import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resolveOrgId: vi.fn(), query: vi.fn(), createSource: vi.fn(), json: vi.fn() }));
vi.mock('../../src/lib/resolve', () => ({ resolveOrgId: mocks.resolveOrgId }));
vi.mock('../../src/lib/indexed-source', () => ({ createIndexedSource: mocks.createSource }));
vi.mock('../../src/lib/output', () => ({ isJsonMode: () => true, json: mocks.json }));
import { authoritySnapshotHandler } from '../../src/commands/role/snapshot';
const ORG = `0x${'11'.repeat(32)}`, AUTH = `0x${'22'.repeat(20)}`, HASH = `0x${'33'.repeat(32)}`;
const source = { chainId: 100, orgId: ORG, endpoint: 'fixture://index', method: 'snapshot', indexed: true,
  snapshot: 'pinned' as const, block: { number: '100', hash: HASH } };
const meta = { _meta: { block: { number: 100, hash: HASH } } };
beforeEach(() => {
  vi.clearAllMocks(); mocks.resolveOrgId.mockResolvedValue(ORG); mocks.createSource.mockResolvedValue({ source, query: mocks.query });
});
describe('read-only authority snapshots before readiness', () => {
  it('uses the exact org ID without a ready-only module resolver, exposing observed false cutover readiness', async () => {
    mocks.query.mockImplementation(async (requested, document) => ({ source: requested, issues: [], data: { ...meta, organization: { id: ORG,
      membershipAuthority: document.includes('AuthorityState') ? { id: AUTH, executor: AUTH, paused: true, isRouterBound: false, cutoverAt: '0',
        subjectCount: '0', roleSubjectCount: '0', groupSubjectCount: '0', acceptedMembershipCount: '0' } : { id: AUTH } } } }));
    await authoritySnapshotHandler.handler({ org: ORG, chain: 100 });
    expect(mocks.resolveOrgId).toHaveBeenCalledWith(ORG, 100);
    expect(mocks.json.mock.calls[0][0]).toMatchObject({ orgId: ORG, readiness: { state: 'known', value: false },
      snapshot: { coverage: { status: 'unavailable' }, data: { ready: { state: 'known', value: false } } } });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
  it('reports a proven absent authority as false and unavailable without substituting a contract', async () => {
    mocks.query.mockImplementation(async requested => ({ source: requested, issues: [], data: { ...meta, organization: { id: ORG, membershipAuthority: null } } }));
    await authoritySnapshotHandler.handler({ org: ORG, chain: 100 });
    expect(mocks.json.mock.calls[0][0]).toMatchObject({ readiness: { state: 'known', value: false }, snapshot: null, coverage: { status: 'unavailable' } });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
  it('retains unknown readiness when the binding response is unavailable or belongs to another block', async () => {
    mocks.query.mockImplementation(async requested => ({ source: requested, issues: [], data: { _meta: { block: { number: 99, hash: HASH } },
      organization: { id: ORG, membershipAuthority: { id: AUTH } } } }));
    await authoritySnapshotHandler.handler({ org: ORG, chain: 100 });
    expect(mocks.json.mock.calls[0][0]).toMatchObject({ readiness: { state: 'unknown' }, snapshot: null });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});
