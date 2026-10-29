import { describe, expect, test, vi } from 'vitest';
import { createTaskWorkflow } from '../../src/workflows';
import { fixture as hostFixture } from '../workflows/fixture';
import { fixture, scope, PROJECT } from './fixture';
const create = { action: 'create' as const, projectId: PROJECT,
  task: { payoutRaw: '1', title: 'Prepare a shared meal' }, metadata: { name: 'Prepare a shared meal', description: 'Plan and cook together.', location: 'Remote', difficulty: 'medium', estHours: '2', submission: '' } };
const hostFor = (f: ReturnType<typeof fixture>) => {
  const host = hostFixture().host;
  return { ...host, scope, sources: f.sources, simulate: f.readers.simulate,
    wallet: { ...host.wallet, getIdentity: async () => ({ chainId: 100, accountAddress: scope.account }) } };
};
describe('task workflow observations', () => {
  test.each(['create', 'claim', 'complete'] as const)('feeds real %s policy with canonical index, authority projection and actual TaskManager lens calls', async action => {
    const f = fixture(); if (action === 'complete') f.state.taskStatus = 'Submitted';
    const request = action === 'create' ? create : { action, projectId: PROJECT, taskId: '1' };
    const evidence = await f.readers.task.read(request, { scope });
    expect(evidence.module.data.paused).toMatchObject({ state: 'unknown', code: 'MODULE_PAUSE_UNSUPPORTED' });
    expect(evidence.authorityPaused).toMatchObject({ state: 'known', value: false, source: { indexed: true, contract: scope.contracts.membershipAuthority } });
    expect(evidence.policy.data.permissionMask.state).toBe('unknown');
    const result = await createTaskWorkflow(hostFor(f), f.readers.task).review(request);
    expect(result.status, JSON.stringify(result.codes)).toBe('ready');
    const keys = f.state.calls.filter(call => call.name === 'getLensData').map(call => Number(call.args[0]));
    expect(keys).toEqual(expect.arrayContaining(action === 'create' ? [2, 4, 12] : [1, 2, 4, 12]));
    expect(f.state.calls.every(call => call.block === 100)).toBe(true);
    expect(f.state.calls.some(call => ['paused', 'executor', 'membershipAuthority'].includes(call.name))).toBe(false);
  });
  test.each(['legacy', 'outage', 'missing-port'])('does not invent a current create signature for %s feature evidence', async mode => {
    const f = fixture();
    if (mode === 'legacy') f.state.legacyFeature = true;
    if (mode === 'outage') f.state.featureOutage = true;
    if (mode === 'missing-port') f.provider.getCode = undefined as never;
    const evidence = await f.readers.task.read(create, { scope });
    expect(evidence.module.data.deadlines).toMatchObject(mode === 'legacy' ? { state: 'known', value: false } : { state: 'unknown' });
    const result = await createTaskWorkflow(hostFor(f), f.readers.task).review(create);
    expect(result.status).not.toBe('ready');
  });
  test('pins implementation storage/code reads and keeps ambiguous proxy slots unknown', async () => {
    const f = fixture(), storage = vi.spyOn(f.provider, 'getStorageAt'), code = vi.spyOn(f.provider, 'getCode');
    await f.readers.task.read(create, { scope });
    expect(storage.mock.calls.every(call => call[2] === 100)).toBe(true);
    expect(code.mock.calls.every(call => call[1] === 100)).toBe(true);
    f.state.ambiguousProxy = true;
    const ambiguous = await f.readers.task.read(create, { scope });
    expect(ambiguous.module.data.deadlines.state).toBe('unknown');
    expect((await createTaskWorkflow(hostFor(f), f.readers.task).review(create)).status).toBe('unknown');
  });
  test('leaves missing indexed deadlines unknown and refuses an uncertain claimed-task takeover', async () => {
    const f = fixture(); f.state.taskStatus = 'Assigned'; f.state.missingDeadline = true;
    const request = { action: 'claim' as const, projectId: PROJECT, taskId: '1' };
    const evidence = await f.readers.task.read(request, { scope });
    expect(evidence.policy.data.absoluteDeadline.state).toBe('unknown');
    expect(evidence.policy.data.claimDeadline.state).toBe('unknown');
    const result = await createTaskWorkflow(hostFor(f), f.readers.task).review(request);
    expect(result.status).toBe('unknown');
  });
  test('retains a null indexed assignee as unknown while permitting an otherwise verified open-task claim', async () => {
    const f = fixture(); f.state.nullAssignee = true;
    const request = { action: 'claim' as const, projectId: PROJECT, taskId: '1' };
    const evidence = await f.readers.task.read(request, { scope });
    expect(evidence.policy.data.claimer.state).toBe('unknown');
    expect((await createTaskWorkflow(hostFor(f), f.readers.task).review(request)).status).toBe('ready');
  });
  test('rejects inconsistent indexed/RPC task state at the pinned block', async () => {
    const f = fixture(); f.state.rpcTaskStatus = 3;
    await expect(f.readers.task.read({ action: 'claim', projectId: PROJECT, taskId: '1' }, { scope })).rejects.toThrow('TASK_RPC_INDEX_MISMATCH');
  });
  test('the simulation adapter verifies TaskManager executor through lens key four', async () => {
    const f = fixture();
    const evidence = await f.readers.simulate({ to: scope.contracts.taskManager, data: '0x12345678', value: '0' }, { scope });
    expect(evidence.data.succeeds).toMatchObject({ state: 'known', value: true });
    expect(f.state.calls[0]).toMatchObject({ name: 'getLensData', args: [4, '0x'] });
  });
});
