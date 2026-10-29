import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { knownFact, unknownFact } from '@poa-box/core/data/facts';
import { AUTHORITY_KEYS, permissionWord, projectContext } from '@poa-box/core/tx/authority';
import { getAbi } from '@poa-box/core/contracts';
import { createTaskWorkflow } from '../../src/workflows';
import type { TaskWorkflowEvidence, TaskWorkflowRequest } from '../../src/workflows';
import { addr, assertReady, authorityData, fixture, hash, memberData, scope } from './fixture';

function taskFixture(action: 'create' | 'claim' | 'complete' = 'create') {
  const f = fixture(), projectId = hash('0');
  const request: TaskWorkflowRequest = action === 'create' ? { action, projectId,
    task: { payoutRaw: '123456789012345678', title: 'Synthetic task', requiresApplication: false, absoluteDeadline: 2000, completionWindow: 60 },
    metadata: { name: 'Synthetic task', description: 'Work', location: 'Remote', difficulty: 'medium', estHours: '2', submission: '' } }
    : { action, projectId, taskId: '9' };
  const evidence = (): TaskWorkflowEvidence => ({
    module: f.snapshot({ paused: knownFact(false), membershipAuthority: knownFact(scope.contracts.membershipAuthority), executor: knownFact(scope.contracts.executor), deadlines: knownFact(true) }, scope.contracts.taskManager),
    policy: f.snapshot({ taskId: action === 'create' ? null : '9', projectId: knownFact(projectId), actor: knownFact(scope.account), executor: knownFact(false), projectManager: knownFact(false),
      permissionMask: unknownFact('MUST_BE_DERIVED_FROM_AUTHORITY'), projectExists: knownFact(true), creator: knownFact(false), taskExists: knownFact(action !== 'create'), status: knownFact(action === 'complete' ? 2 : 0),
      claimer: knownFact(addr('a')), absoluteDeadline: knownFact(0), claimDeadline: knownFact(0), requiresApplication: knownFact(false), alreadyApplied: knownFact(false) }, scope.contracts.taskManager, true, true),
    authority: f.snapshot(authorityData(AUTHORITY_KEYS.TM_PERMS, permissionWord('255').toString(), projectContext(projectId)), scope.contracts.membershipAuthority, true),
    memberships: f.snapshot(memberData, scope.contracts.membershipAuthority, true, true),
  });
  return { ...f, request, evidence, create: (e = evidence()) => createTaskWorkflow(f.host, { read: async () => e }) };
}
describe('task workflow', () => {
  for (const action of ['create', 'claim', 'complete'] as const) it(`encodes ${action} using core builder after current user policy`, async () => {
    const f = taskFixture(action), w = f.create(), review = assertReady(await w.review(f.request)), prepared = assertReady(await w.prepare({ review }));
    const iface = new ethers.utils.Interface(getAbi('TaskManagerNew')), parsed = iface.parseTransaction({ data: prepared.call.data });
    expect(parsed.name).toBe(action === 'create' ? 'createTask' : action === 'claim' ? 'claimTask' : 'completeTask');
    if (action === 'create') {
      expect(parsed.args[0].toString()).toBe('123456789012345678'); expect(parsed.args[3]).toBe(hash('0'));
      expect(parsed.args[7].toString()).toBe('2000'); expect(parsed.args[8].toString()).toBe('60');
      const event = iface.encodeEventLog(iface.getEvent('TaskCreated'), [83, hash('0'), parsed.args[0], ethers.constants.AddressZero, 0, false, parsed.args[1], parsed.args[2]]);
      f.control.logs = [{ address: scope.contracts.taskManager, ...event }];
    }
    expect((await w.submit({ prepared })).status).toBe('pending'); f.control.mined = true;
    const confirmed = await w.recover(); expect(confirmed.status).toBe('confirmed'); expect(confirmed.data).toMatchObject({ taskId: action === 'create' ? '83' : '9' });
  });
  it('never accepts potential subject permissions without current user membership', async () => {
    const f = taskFixture(), e = f.evidence(); e.memberships.data[0].isMember = knownFact(false);
    expect((await f.create(e).review(f.request)).status).toBe('blocked'); expect(f.control.publishes).toBe(0);
  });
  it('unknown current membership remains unknown despite a permissive injected mask', async () => {
    const f = taskFixture(), e = f.evidence(); e.memberships.data[0].isMember = unknownFact('MEMBERSHIP_UNKNOWN'); e.policy.data.permissionMask = knownFact('255');
    expect((await f.create(e).review(f.request)).status).toBe('unknown');
  });
  it('does not trust an injected Executor boolean for a non-Executor wallet', async () => {
    const f = taskFixture(), e = f.evidence(); e.policy.data.executor = knownFact(true); e.authority.data.permissions[0].word = permissionWord('0').toString();
    expect((await f.create(e).review(f.request)).status).toBe('blocked');
  });
  for (const variant of ['foreign-task', 'foreign-project', 'foreign-authority', 'foreign-actor', 'incomplete', 'wrong-status', 'application'] as const) it(`blocks claim ${variant}`, async () => {
    const f = taskFixture('claim'), e = f.evidence();
    if (variant === 'foreign-task') e.policy.data.taskId = '10';
    if (variant === 'foreign-project') e.policy.data.projectId = knownFact(hash('a'));
    if (variant === 'foreign-authority') e.authority.source.contract = addr('f');
    if (variant === 'foreign-actor') e.policy.data.actor = knownFact(addr('f'));
    if (variant === 'incomplete') e.policy.coverage.status = 'incomplete';
    if (variant === 'wrong-status') e.policy.data.status = knownFact(4);
    if (variant === 'application') e.policy.data.requiresApplication = knownFact(true);
    expect((await f.create(e).review(f.request)).status).not.toBe('ready'); expect(f.control.sends).toBe(0);
  });
  it('applies the complete self-review gate and cannot silently replace claim with cancellation', async () => {
    const f = taskFixture('complete'), e = f.evidence(); e.policy.data.claimer = knownFact(scope.account);
    e.authority.data.permissions[0].word = permissionWord('4').toString();
    expect((await f.create(e).review(f.request)).status).toBe('blocked');
    e.authority.data.permissions[0].word = permissionWord('20').toString();
    expect((await f.create(e).review(f.request)).status).toBe('ready');
    expect((await f.create().review({ ...f.request, action: 'cancel' } as never)).status).toBe('blocked');
  });
  it('does not confirm task creation from a foreign or mismatched creation log', async () => {
    const f = taskFixture(), w = f.create(), review = assertReady(await w.review(f.request)), prepared = assertReady(await w.prepare({ review }));
    const iface = new ethers.utils.Interface(getAbi('TaskManagerNew')), parsed = iface.parseTransaction({ data: prepared.call.data });
    const event = iface.encodeEventLog(iface.getEvent('TaskCreated'), [83, hash('0'), parsed.args[0], ethers.constants.AddressZero, 0, false, parsed.args[1], hash('e')]);
    f.control.logs = [{ address: scope.contracts.taskManager, ...event }];
    await w.submit({ prepared }); f.control.mined = true; expect((await w.recover()).status).toBe('unknown');
  });
  it('requires actual RPC success for the exact funded creation call', async () => {
    const f = taskFixture(), w = f.create(), review = assertReady(await w.review(f.request)); f.control.simulateAllowed = false;
    expect((await w.prepare({ review })).status).toBe('blocked'); expect(f.control.sends).toBe(0);
  });
  it('binds recovery metadata to the submitted edited preparation', async () => {
    const f = taskFixture(), w = f.create();
    assertReady(await w.prepare({ review: assertReady(await w.review(f.request)) }));
    const edited = { ...f.request, metadata: { ...(f.request as Extract<TaskWorkflowRequest, { action: 'create' }>).metadata, description: 'Edited approved draft' } } as TaskWorkflowRequest;
    const prepared = assertReady(await w.prepare({ review: assertReady(await w.review(edited)) }));
    expect(f.control.publishes).toBe(2);
    const iface = new ethers.utils.Interface(getAbi('TaskManagerNew')), call = iface.parseTransaction({ data: prepared.call.data });
    const event = iface.encodeEventLog(iface.getEvent('TaskCreated'), [83, hash('0'), call.args[0], ethers.constants.AddressZero, 0, false, call.args[1], call.args[2]]);
    f.control.logs = [{ address: scope.contracts.taskManager, ...event }];
    await w.submit({ prepared }); f.control.mined = true; expect((await w.recover()).status).toBe('confirmed');
  });
  it('normalizes bigint raw amounts above 2^53 exactly before review and journaling', async () => {
    const f = taskFixture(), request = f.request as Extract<TaskWorkflowRequest, { action: 'create' }>;
    request.task.payoutRaw = 900719925474099312345n;
    request.task.bountyToken = addr('f'); request.task.bountyPayoutRaw = 900719925474099312346n;
    const w = f.create(), review = assertReady(await w.review(request)), prepared = assertReady(await w.prepare({ review }));
    const decoded = new ethers.utils.Interface(getAbi('TaskManagerNew')).parseTransaction({ data: prepared.call.data });
    expect(decoded.args[0].toString()).toBe('900719925474099312345'); expect(decoded.args[5].toString()).toBe('900719925474099312346');
    expect(JSON.stringify(f.control.database)).toContain('900719925474099312345');
  });
  it.each(['running', 'paused', 'unknown', 'foreign', 'unsourced'] as const)('uses accurately sourced authority pause when module pause is unsupported: %s', async state => {
    const f = taskFixture('claim'), e = f.evidence(); e.module.data.paused = unknownFact('MODULE_PAUSE_UNSUPPORTED');
    e.authorityPaused = state === 'unknown' ? unknownFact('PAUSE_UNAVAILABLE', e.authority.source) : knownFact(state === 'paused', e.authority.source);
    if (state === 'foreign') e.authorityPaused = knownFact(false, { ...e.authority.source, contract: addr('f') });
    if (state === 'unsourced') e.authorityPaused = knownFact(false);
    expect((await f.create(e).review(f.request)).status).toBe(state === 'running' ? 'ready' : state === 'paused' ? 'blocked' : 'unknown');
  });
});
