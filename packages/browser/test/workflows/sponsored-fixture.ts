import { ethers } from 'ethers';
import { ENTRY_POINT } from '@poa-box/core/accounts/constants';
import { hashUserOperationV07, packUserOperationV07, UserOperationV07 } from '@poa-box/core/accounts/userop-v07';
import { USER_OPERATION_EVENTS } from '@poa-box/core/execute/outcome';
import { getAbi } from '@poa-box/core/contracts';
import { createSponsoredExecutionAdapter } from '../../src/wallet';
import { addr, fixture, hash } from './fixture';
import type { UnsignedCall } from '../../src/wallet';

const account = new ethers.utils.Interface(getAbi('PasskeyAccount'));
const entryPoint = new ethers.utils.Interface(['function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)', 'event BeforeExecution()']);
export function withSponsored(f = fixture()) {
  const state = { operation: undefined as UserOperationV07 | undefined, computedHash: '', signs: 0,
    innerSuccess: true, outerStatus: 1, eventHash: '', eventEntryPoint: ENTRY_POINT as string, eventSender: '',
    otherOperationLogs: [] as { address: string; topics: readonly string[]; data: string }[] };
  const callData = (call: Readonly<UnsignedCall>) => account.encodeFunctionData('execute', [call.to, call.value, call.data]);
  const event = (op: UserOperationV07, computedHash: string, success: boolean) => ({ address: state.eventEntryPoint,
    ...USER_OPERATION_EVENTS.encodeEventLog(USER_OPERATION_EVENTS.getEvent('UserOperationEvent'), [computedHash, state.eventSender || op.sender,
      ethers.constants.AddressZero, op.nonce, success, 1, 1]) });
  const ops = () => {
    const current = state.operation!;
    return state.otherOperationLogs.length ? [{ ...current, sender: addr('f'), nonce: '3' }, current] : [current];
  };
  const transaction = () => state.operation && ({ hash: f.txHash, from: addr('e'), to: ENTRY_POINT,
    data: entryPoint.encodeFunctionData('handleOps', [ops().map(packUserOperationV07), addr('e')]),
    value: '0', nonce: '12', chainId: '100', blockNumber: '101', blockHash: hash('c') });
  const receipt = () => {
    if (!state.operation || !f.control.mined) return null;
    const before = { address: ENTRY_POINT, ...entryPoint.encodeEventLog(entryPoint.getEvent('BeforeExecution'), []) };
    const other = state.otherOperationLogs.length ? [...state.otherOperationLogs, event(ops()[0], hashUserOperationV07(ops()[0], ENTRY_POINT, 100), true)] : [];
    const logs = [before, ...other, ...f.control.logs, event(state.operation, state.eventHash || state.computedHash, state.innerSuccess)].map((log, logIndex) => ({ ...log, logIndex }));
    return { status: state.outerStatus, transactionHash: f.txHash, blockNumber: '101', blockHash: hash('c'), logs };
  };
  const recoveryReaders = {
    getChainId: async () => 100,
    getUserOperationReceipt: async (opHash: string) => f.control.mined && opHash === state.computedHash ? { transactionHash: f.txHash } : null,
    getTransactionReceipt: async (txHash: string) => txHash === f.txHash ? receipt() : null,
    getTransaction: async (txHash: string) => txHash === f.txHash ? transaction() ?? null : null,
    getBlock: async (number: string) => ({ number, hash: number === '101' ? hash('c') : hash('a') }),
  };
  f.host.wallet = createSponsoredExecutionAdapter({
    getIdentity: async () => ({ chainId: f.control.chainId, accountAddress: f.control.account }), getNonce: async () => '7',
    encodeCall: callData,
    prepareOperation: async ({ call }) => {
      await f.control.walletSetup?.();
      return { operation: { sender: f.host.scope.account, nonce: '7', callData: callData(call), callGasLimit: '100000', verificationGasLimit: '100000', preVerificationGas: '10000', maxFeePerGas: '10', maxPriorityFeePerGas: '1' }, entryPoint: ENTRY_POINT, fromBlock: '100' };
    },
    signHash: async () => { state.signs++; return '0x1234'; },
    dispatchSignedOperation: async operation => {
      f.control.sends++; state.operation = { ...operation }; state.computedHash = hashUserOperationV07(operation, ENTRY_POINT, 100);
      if (f.control.lostAck) throw new Error('SYNTHETIC_BUNDLER_ACK_LOST'); return state.computedHash;
    }, recoveryReaders,
  });
  return { ...f, sponsored: state, recoveryReaders };
}
