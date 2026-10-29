import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { ENTRY_POINT } from '@poa-box/core/accounts/constants';
import { hashUserOperationV07, packUserOperationV07 } from '@poa-box/core/accounts/userop-v07';
import { USER_OPERATION_EVENTS } from '@poa-box/core/execute/outcome';
import { getAbi } from '@poa-box/core/contracts';
import { createSponsoredExecutionAdapter } from '../../src/wallet';
import { createRoleWorkflow } from '../../src/workflows';
import { assertReady } from './fixture';
import { createWorkflowFixture } from '../../../../examples/role-consumer/src/workflow-fixture.mjs';

const config = () => JSON.parse(readFileSync(new URL('../../../../examples/role-consumer/fixtures/role-workflow.v1.json', import.meta.url), 'utf8'));
const proposal = { title: 'Synthetic reviewed role', description: 'No external actions', durationMinutes: '1440' };
const entryPoint = new ethers.utils.Interface(['function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)', 'event BeforeExecution()']);
const account = new ethers.utils.Interface(getAbi('PasskeyAccount'));
function sponsoredRoleFixture() {
  const f = createWorkflowFixture(config()), operations = new Map<string, any>(), hashes = new Map<string, string>();
  const provider = f.adapter.sources.rpc.provider, getTransaction = provider.getTransaction, getReceipt = provider.getTransactionReceipt;
  const encodeCall = (call: any) => account.encodeFunctionData('execute', [call.to, call.value, call.data]);
  provider.getTransaction = async (hash: string) => {
    const tx = await getTransaction(hash), op = operations.get(hash);
    return tx && op ? { ...tx, to: ENTRY_POINT, from: '0x' + 'ee'.repeat(20), data: entryPoint.encodeFunctionData('handleOps', [[packUserOperationV07(op)], '0x' + 'ee'.repeat(20)]) } : tx;
  };
  provider.getTransactionReceipt = async (hash: string) => {
    const receipt = await getReceipt(hash), op = operations.get(hash); if (!receipt || !op) return receipt;
    const before = { ...receipt.logs[0], address: ENTRY_POINT, ...entryPoint.encodeEventLog(entryPoint.getEvent('BeforeExecution'), []) };
    const event = { ...receipt.logs[0], address: ENTRY_POINT, ...USER_OPERATION_EVENTS.encodeEventLog(USER_OPERATION_EVENTS.getEvent('UserOperationEvent'),
      [hashUserOperationV07(op, ENTRY_POINT, f.adapter.scope.chainId), op.sender, ethers.constants.AddressZero, op.nonce, true, 1, 1]) };
    return { ...receipt, logs: [before, ...receipt.logs, event].map((log, logIndex) => ({ ...log, logIndex })) };
  };
  const wallet = createSponsoredExecutionAdapter({
    getIdentity: async () => ({ chainId: f.adapter.scope.chainId, accountAddress: f.adapter.scope.account }),
    getNonce: async () => String(f.adapter.trace.sends.length), encodeCall,
    prepareOperation: async ({ call }) => ({ operation: { sender: f.adapter.scope.account, nonce: String(f.adapter.trace.sends.length), callData: encodeCall(call), callGasLimit: '100000', verificationGasLimit: '100000', preVerificationGas: '10000', maxFeePerGas: '10', maxPriorityFeePerGas: '1' }, entryPoint: ENTRY_POINT, fromBlock: String(f.adapter.config.block.number) }),
    signHash: async () => '0x1234',
    dispatchSignedOperation: async operation => {
      const call = account.decodeFunctionData('execute', operation.callData), stage = f.adapter.trace.sends.length ? 'configuration' : 'creation';
      let error: unknown;
      try { await f.adapter.send({ to: call.target, data: call.data, value: call.value.toString() }, stage); } catch (cause) { error = cause; }
      const txHash = f.adapter.trace.sends.at(-1).txHash, opHash = hashUserOperationV07(operation, ENTRY_POINT, f.adapter.scope.chainId);
      operations.set(txHash, operation); hashes.set(opHash, txHash);
      if (error) throw error; return opHash;
    },
    recoveryReaders: { ...f.adapter.recoveryReaders, getTransaction: async hash => {
      const tx = await provider.getTransaction(hash); return tx && { ...tx, value: tx.value.toString() };
    }, getTransactionReceipt: hash => provider.getTransactionReceipt(hash), getUserOperationReceipt: async hash => hashes.has(hash) ? { transactionHash: hashes.get(hash)! } : null },
  });
  const create = () => createRoleWorkflow({ workflowId: 'synthetic-sponsored-role', scope: f.adapter.scope, sources: f.adapter.sources,
    wallet, journal: f.journal, documents: f.documents, isCurrent: () => f.control.current, confirm: async () => true });
  return { ...f, create };
}
it('native passkey role workflow recovers exact operation, uses actual emitted subject and proves separate configuration', async () => {
  const f = sponsoredRoleFixture(); let w = f.create();
  const prepared = assertReady(await w.prepare({ review: assertReady(await w.review(f.adapter.request)), proposal }));
  expect((await w.submit({ prepared })).status).toBe('unknown'); expect(f.adapter.trace.sends).toHaveLength(1);
  w = f.create(); const first = await w.recover(); expect(first.status, JSON.stringify(first)).toBe('confirmed');
  expect(first.data!.creation.subjectId).toBe(f.adapter.ids.actual); expect(first.data!.complete).toBe(false);
  const next = assertReady(await w.continuation()); expect(next.request!.subjectId).toBe(f.adapter.ids.actual);
  expect(next.request!.continuation!.operation).toMatchObject({ sender: f.adapter.scope.account, entryPoint: ENTRY_POINT.toLowerCase() });
  const second = assertReady(await w.prepare({ review: assertReady(await w.review(next.request!)), proposal }));
  const submitted = await w.submit({ prepared: second }); expect(submitted.status).toBe('pending'); expect((submitted.data as any).userOpHash).toMatch(/^0x/); expect((submitted.data as any).txHash).toBeUndefined();
  const final = await f.create().recover(); expect(final.status, JSON.stringify(final)).toBe('confirmed'); expect(final.data!.complete).toBe(true); expect(f.adapter.trace.sends).toHaveLength(2);
});
