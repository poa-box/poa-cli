import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { knownFact } from '../../../src/data/facts';
import { AUTHORITY_KEYS, permissionWord, projectContext } from '../../../src/tx/authority';
import { ENTRY_POINT } from '../../../src/accounts/constants';
import { getAbi } from '../../../src/contracts';
import { createBallotWorkflow, createTaskWorkflow } from '../../../src/workflows';
import type { BallotEvidence, BallotRequest, TaskWorkflowEvidence, TaskWorkflowRequest } from '../../../src/workflows';
import { addr, assertReady, authorityData, hash, memberData, scope } from './fixture';
import { withSponsored } from './sponsored-fixture';

function sponsoredBallot() {
  const f = withSponsored(), policy = { allowed: true }, request: BallotRequest = { lane: 'dd', proposalId: '41', optionIndices: [0], weights: [100] };
  const read = async (): Promise<BallotEvidence> => ({
    proposal: f.snapshot({ proposalId: '41', paused: knownFact(false), executor: knownFact(scope.contracts.executor), membershipAuthority: knownFact(scope.contracts.membershipAuthority), exists: knownFact(true), alreadyVoted: knownFact(false), startTimestamp: knownFact('900'), endTimestamp: knownFact('1100'), numOptions: knownFact(2) }, scope.contracts.directDemocracyVoting, false, true),
    ddAuthorization: f.snapshot({ proposalId: '41', createdAt: knownFact('800'), membershipAuthority: knownFact(scope.contracts.membershipAuthority), executor: knownFact(scope.contracts.executor), restricted: knownFact(false), restrictedSubjectIds: knownFact([]) }, scope.contracts.directDemocracyVoting),
    authority: f.snapshot(authorityData(AUTHORITY_KEYS.DD_VOTE, permissionWord(policy.allowed ? '1' : '0').toString()), scope.contracts.membershipAuthority, true),
    memberships: f.snapshot(memberData, scope.contracts.membershipAuthority, true, true),
  });
  return { ...f, request, policy, create: () => createBallotWorkflow(f.host, { read }) };
}
async function prepareBallot(f: ReturnType<typeof sponsoredBallot>) { const w = f.create(), review = assertReady(await w.review(f.request)); return { w, prepared: assertReady(await w.prepare({ review })) }; }
describe('native passkey sponsored workflow transport', () => {
  it('persists exact user-operation identity, keeps hashes distinct and recovers after acknowledgement loss/reload', async () => {
    const f = sponsoredBallot(), p = await prepareBallot(f); f.control.lostAck = true;
    const sent = await p.w.submit({ prepared: p.prepared }); expect(sent.codes).toEqual(['SUBMISSION_OUTCOME_UNKNOWN']);
    const stored = JSON.stringify(f.control.database), record = (f.control.database!.data as any).workflows['workflow-test'].stages.operation.submission;
    expect(record.kind).toBe('user-operation'); expect(record.entryPoint).toBe(ENTRY_POINT.toLowerCase()); expect(record.computedHash).toBe(f.sponsored.computedHash);
    expect(record.txHash).toBeUndefined(); expect(record.nonce).toBe('7');
    expect(stored).not.toContain('signature'); expect(stored).not.toContain('callData'); expect(f.control.sends).toBe(1);
    expect((await f.create().review(f.request)).codes).toEqual(['ACCOUNT_RECOVERY_REQUIRED']);
    expect((await f.create().recover()).status).toBe('unknown');
    f.control.mined = true;
    expect((await f.create().recover({ candidateUserOpHash: f.sponsored.computedHash })).status).toBe('confirmed');
    expect(f.control.sends).toBe(1);
  });
  it('acknowledges the computed operation hash without manufacturing an outer transaction hash', async () => {
    const f = sponsoredBallot(), p = await prepareBallot(f), sent = await p.w.submit({ prepared: p.prepared });
    expect(sent.status).toBe('pending'); expect(sent.data).toMatchObject({ userOpHash: f.sponsored.computedHash, computedHash: f.sponsored.computedHash, entryPoint: ENTRY_POINT.toLowerCase() });
    expect((sent.data as any).txHash).toBeUndefined(); f.control.mined = true; expect((await p.w.recover()).status).toBe('confirmed');
  });
  it.each(['inner-failure', 'outer-failure', 'foreign-entrypoint', 'foreign-hash', 'foreign-sender'] as const)('never confirms %s from a successful-looking outer receipt', async failure => {
    const f = sponsoredBallot(), p = await prepareBallot(f); await p.w.submit({ prepared: p.prepared }); f.control.mined = true;
    if (failure === 'inner-failure') f.sponsored.innerSuccess = false;
    if (failure === 'outer-failure') f.sponsored.outerStatus = 0;
    if (failure === 'foreign-entrypoint') f.sponsored.eventEntryPoint = addr('a');
    if (failure === 'foreign-hash') f.sponsored.eventHash = hash('a');
    if (failure === 'foreign-sender') f.sponsored.eventSender = addr('a');
    const observed = await f.create().recover(); expect(observed.status).toBe(failure.endsWith('failure') ? 'blocked' : 'unknown');
    expect(f.control.sends).toBe(1);
  });
  it('rejects candidate transaction/operation hash confusion', async () => {
    const f = sponsoredBallot(), p = await prepareBallot(f); await p.w.submit({ prepared: p.prepared }); f.control.mined = true;
    expect((await p.w.recover({ candidateTxHash: f.sponsored.computedHash })).codes).toEqual(['TRANSACTION_CANDIDATE_FOR_USER_OPERATION']);
    expect((await p.w.recover({ candidateUserOpHash: hash('f') })).codes).toEqual(['USER_OPERATION_CANDIDATE_MISMATCH']); expect(f.control.sends).toBe(1);
  });
  it('requires exact operation receipt readers before allowing a sponsored dispatch', async () => {
    const f = sponsoredBallot(), p = await prepareBallot(f); delete f.host.wallet.recoveryReaders.getTransaction;
    expect((await p.w.submit({ prepared: p.prepared })).codes).toEqual(['USER_OPERATION_RECEIPT_READERS_REQUIRED']); expect(f.control.sends).toBe(0);
  });
  it('revoked journal ownership prevents signing after asynchronous sponsored setup', async () => {
    const f = sponsoredBallot(), p = await prepareBallot(f); f.control.walletSetup = () => { f.control.lockRevoked = true; };
    expect((await p.w.submit({ prepared: p.prepared })).status).not.toBe('pending'); expect(f.sponsored.signs).toBe(0); expect(f.control.sends).toBe(0);
  });
  it.each(['declined', 'policy', 'identity', 'lock'] as const)('performs no biometric signing after send consent is %s', async change => {
    const f = sponsoredBallot();
    f.host.confirm = async approval => {
      if (approval.kind !== 'send') return true;
      if (change === 'policy') f.policy.allowed = false;
      if (change === 'identity') f.control.account = addr('a');
      if (change === 'lock') f.control.lockRevoked = true;
      return change !== 'declined';
    };
    const p = await prepareBallot(f); expect(f.sponsored.signs).toBe(0);
    expect((await p.w.submit({ prepared: p.prepared })).status).not.toBe('pending'); expect(f.sponsored.signs).toBe(0); expect(f.control.sends).toBe(0);
  });
  it('isolates the selected operation creation event from another bundled task creation', async () => {
    const f = withSponsored(), projectId = hash('0');
    const request: TaskWorkflowRequest = { action: 'create', projectId, task: { payoutRaw: '123', title: 'Task' }, metadata: { name: 'Task', description: 'Current draft', location: '', difficulty: '', estHours: 0, submission: '' } };
    const read = async (): Promise<TaskWorkflowEvidence> => ({
      module: f.snapshot({ paused: knownFact(false), membershipAuthority: knownFact(scope.contracts.membershipAuthority), executor: knownFact(scope.contracts.executor), deadlines: knownFact(true) }, scope.contracts.taskManager),
      policy: f.snapshot({ taskId: null, projectId: knownFact(projectId), actor: knownFact(scope.account), executor: knownFact(false), projectManager: knownFact(false), permissionMask: knownFact('0'), projectExists: knownFact(true), creator: knownFact(false), taskExists: knownFact(false), status: knownFact(0), claimer: knownFact(addr('a')), absoluteDeadline: knownFact(0), claimDeadline: knownFact(0), requiresApplication: knownFact(false), alreadyApplied: knownFact(false) }, scope.contracts.taskManager, true, true),
      authority: f.snapshot(authorityData(AUTHORITY_KEYS.TM_PERMS, permissionWord('255').toString(), projectContext(projectId)), scope.contracts.membershipAuthority, true), memberships: f.snapshot(memberData, scope.contracts.membershipAuthority, true, true),
    });
    const create = () => createTaskWorkflow(f.host, { read }), w = create(), prepared = assertReady(await w.prepare({ review: assertReady(await w.review(request)) }));
    const iface = new ethers.utils.Interface(getAbi('TaskManagerNew')), call = iface.parseTransaction({ data: prepared.call.data });
    const event = (id: number) => ({ address: scope.contracts.taskManager, ...iface.encodeEventLog(iface.getEvent('TaskCreated'), [id, projectId, call.args[0], ethers.constants.AddressZero, 0, false, call.args[1], call.args[2]]) });
    f.control.logs = [event(83)]; f.sponsored.otherOperationLogs = [event(999)];
    await w.submit({ prepared }); f.control.mined = true;
    const recovered = await create().recover(); expect(recovered.status).toBe('confirmed'); expect(recovered.data).toMatchObject({ taskId: '83' });
  });
});
