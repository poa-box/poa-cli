import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ request: vi.fn(), plan: vi.fn() }));
vi.mock('graphql-request', () => ({ GraphQLClient: class { request = mocks.request; } }));
vi.mock('../../src/lib/subgraph', () => ({ resolveTransportPlan: mocks.plan,
  redactSubgraphUrl: () => 'https://index.example/redacted' }));
import { createIndexedSource } from '../../src/lib/indexed-source';
import { listTasksComplete } from '@poa-box/core/reads/task';
import { readCredentialFacts } from '@poa-box/core/reads/protocol';
const HASH = `0x${'11'.repeat(32)}`, ORG = `0x${'22'.repeat(32)}`, AUTH = `0x${'33'.repeat(20)}`;
const meta = { _meta: { block: { number: 100, hash: HASH } } };
const options = { chainId: 100, orgId: ORG, contract: AUTH };
beforeEach(() => { vi.clearAllMocks(); mocks.plan.mockReturnValue({ attempts: [{ tier: 'free', url: 'https://index.example/secret-credential' }] }); });
describe('pinned CLI source adapter', () => {
  it('records the observed index block and preserves explicit request hash selection', async () => {
    mocks.request.mockResolvedValue(meta);
    const source = await createIndexedSource({ ...options, block: { number: '100', hash: HASH } });
    expect(mocks.request.mock.calls[0][1]).toEqual({ block: { hash: HASH } });
    expect(source.source).toMatchObject({ block: { number: '100', hash: HASH }, snapshot: 'pinned', endpoint: expect.stringMatching(/^https:\/\/index.example\/source-[a-f0-9]{20}$/) });
  });
  it('rejects a response at a different block, and sanitizes startup transport errors', async () => {
    mocks.request.mockResolvedValue(meta);
    await expect(createIndexedSource({ ...options, block: { number: '101' } })).rejects.toThrow();
    mocks.request.mockRejectedValue(new Error('https://index.example/secret-credential'));
    await expect(createIndexedSource(options)).rejects.toThrow('INDEXED_SOURCE_UNAVAILABLE');
  });
  it('proves explicitly requested timestamps from response metadata and rejects missing or different timestamps', async () => {
    mocks.request.mockResolvedValue({ _meta: { block: { number: 100, hash: HASH, timestamp: 1234 } } });
    const adapter = await createIndexedSource({ ...options, block: { number: '100', hash: HASH, timestamp: '1234' } });
    expect(adapter.source.block?.timestamp).toBe('1234');
    await expect(createIndexedSource({ ...options, block: { number: '100', timestamp: '1235' } })).rejects.toThrow();
    mocks.request.mockResolvedValue(meta);
    await expect(createIndexedSource({ ...options, block: { number: '100', timestamp: '1234' } })).rejects.toThrow();
  });
  it('preserves only safe structured schema errors so core task compatibility fallback works end-to-end', async () => {
    mocks.request.mockResolvedValueOnce(meta).mockRejectedValueOnce({ response: { status: 200,
      errors: [{ message: 'Cannot query field "absoluteDeadline" on type "Task".' }] }, request: { url: 'secret' } }).mockResolvedValueOnce({ ...meta, tasks: [],
        organization: { id: ORG, taskManager: { id: AUTH, organization: { id: ORG } } } });
    const adapter = await createIndexedSource(options);
    const result = await listTasksComplete({ source: adapter.source, query: adapter.protocolQuery });
    expect(result.coverage.status).toBe('complete');
    expect(mocks.request).toHaveBeenCalledTimes(3);
    expect(mocks.request.mock.calls[2][0]).not.toContain('absoluteDeadline');
  });
  it('preserves safe credential fallback but mixed errors never select legacy fields', async () => {
    mocks.request.mockResolvedValueOnce(meta).mockRejectedValueOnce({ response: { status: 200,
      errors: [{ message: 'Type `PasskeyCredential` has no field `publicKeyX`' }] } }).mockResolvedValueOnce({ ...meta, passkeyCredentials: [] });
    const adapter = await createIndexedSource({ ...options, account: AUTH });
    const result = await readCredentialFacts({ source: adapter.source, query: adapter.protocolQuery });
    expect(result.coverage.status).toBe('complete');
    expect(mocks.request).toHaveBeenCalledTimes(3);
    mocks.request.mockRejectedValue({ response: { status: 200, errors: [
      { message: 'Cannot query field "publicKeyX" on type "PasskeyCredential".' }, { message: 'https://secret-endpoint' }] } });
    await expect(adapter.protocolQuery('query { x }', {}, adapter.source)).rejects.toThrow('INDEXED_QUERY_UNAVAILABLE');
  });
  it('does not promote failed requests into pinned evidence or leak transport details', async () => {
    mocks.request.mockResolvedValueOnce(meta).mockRejectedValue(new Error('secret-endpoint'));
    const adapter = await createIndexedSource(options);
    const result = await adapter.query(adapter.source, 'query { x }', {});
    expect(result).toMatchObject({ source: { snapshot: 'unknown' }, issues: [{ code: 'INDEXED_QUERY_UNAVAILABLE' }] });
    expect(result.source.block).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
