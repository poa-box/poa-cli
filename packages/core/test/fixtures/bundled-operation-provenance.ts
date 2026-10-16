import { ethers } from 'ethers';
import { getAbi } from '../../src/contracts';
import { ENTRY_POINT } from '../../src/accounts/constants';
import { hashUserOperationV07, packUserOperationV07, UserOperationV07 } from '../../src/accounts/userop-v07';
import { composeSubjectId } from '../../src/authority/ids';
import { RoleContinuationInput, RoleConfigurationOutcomeInput } from '../../src/governance/role-continuation';

export const address = (x: string) => '0x' + x.repeat(40), hash = (x: string) => '0x' + x.repeat(64);
export const AUTH = address('1'), HV = address('2'), EXEC = address('3'), ACCOUNT = address('4'), OTHER = address('c');
export const ORG = hash('5'), TX = hash('6'), EXECTX = hash('7'), HEAD = hash('8'), OLD = hash('9'), EXECBLOCK = hash('a'), META = hash('b');
export const authority = new ethers.utils.Interface(getAbi('MembershipAuthority'));
export const voting = new ethers.utils.Interface(getAbi('HybridVotingNew'));
export const executor = new ethers.utils.Interface(getAbi('Executor'));
export const account = new ethers.utils.Interface(getAbi('PasskeyAccount'));
// Independent contract-shaped ABI, not an exported isolator implementation detail.
export const entryPoint = new ethers.utils.Interface([
  'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)',
  'event BeforeExecution()',
  'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)',
  'event UserOperationRevertReason(bytes32 indexed userOpHash,address indexed sender,uint256 nonce,bytes revertReason)',
  'event PostOpRevertReason(bytes32 indexed userOpHash,address indexed sender,uint256 nonce,bytes revertReason)',
]);
export interface Log { address: string; topics: string[]; data: string; logIndex?: number }
export function event(iface: ethers.utils.Interface, emitter: string, name: string, args: unknown[]): Log {
  return { ...iface.encodeEventLog(iface.getEvent(name), args), address: emitter };
}
export function operation(sender = ACCOUNT, nonce = '9', target = HV, data = voting.encodeFunctionData('announceWinner', [7]), success = true, logs: Log[] = []) {
  const userOp: UserOperationV07 = { sender, nonce, callData: account.encodeFunctionData('execute', [target, 0, data]),
    callGasLimit: '200000', verificationGasLimit: '300000', preVerificationGas: '50000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '10', signature: '0x1234' };
  return { userOp, success, logs };
}
export type Operation = ReturnType<typeof operation>;
export function operationIdentity(op: Operation) {
  return { userOpHash: hashUserOperationV07(op.userOp, ENTRY_POINT, '100'), sender: op.userOp.sender, nonce: op.userOp.nonce, entryPoint: ENTRY_POINT };
}
export function fixture(kind: 'Role' | 'Group' = 'Role') {
  const subjectId = composeSubjectId(AUTH, 15);
  const creationCall = { target: AUTH, value: '0', calldata: authority.encodeFunctionData(kind === 'Role' ? 'createRole' : 'createGroup', ['Builders', META, 'image', kind === 'Role' ? 2 : []]) };
  const title = ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Create Builders'));
  const txs: Record<string, any> = {
    [TX]: { hash: TX, to: HV, from: ACCOUNT, chainId: 100, blockNumber: 50, blockHash: OLD, value: ethers.constants.Zero,
      data: voting.encodeFunctionData('createProposal', [title, META, 10, 2, [[[AUTH, 0, creationCall.calldata]], []], []]) },
    [EXECTX]: { hash: EXECTX, to: HV, from: OTHER, chainId: 100, blockNumber: 90, blockHash: EXECBLOCK, value: ethers.constants.Zero, data: voting.encodeFunctionData('announceWinner', [7]) },
  };
  const creationLogs = [event(voting, HV, 'NewProposal', [7, title, META, 2, 1600, 1000])];
  const executionLogs = [event(authority, AUTH, 'SubjectCreated', [subjectId, kind === 'Role' ? 0 : 1, 'Builders', META, kind === 'Role' ? 2 : 0]),
    event(executor, EXEC, 'CallExecuted', [7, 0, AUTH, 0]), event(executor, EXEC, 'BatchExecuted', [7, 1]), event(voting, HV, 'ProposalExecuted', [7, 0, 1])];
  const receipts: Record<string, any> = {
    [TX]: { status: 1, transactionHash: TX, blockNumber: 50, blockHash: OLD, logs: [] },
    [EXECTX]: { status: 1, transactionHash: EXECTX, blockNumber: 90, blockHash: EXECBLOCK, logs: [] },
  };
  const setLogs = (txHash: string, logs: Log[]) => { receipts[txHash].logs = logs.map((log, i) => ({ ...log, logIndex: 120 + i,
    transactionHash: txHash, blockHash: txs[txHash].blockHash, blockNumber: txs[txHash].blockNumber, removed: false })); };
  setLogs(TX, creationLogs); setLogs(EXECTX, executionLogs);
  const row: any = { id: HV + '-7', proposalId: '7', transactionHash: TX, createdAtBlock: '50', wasExecuted: true,
    executionFailed: false, isValid: true, winningOption: '0', status: 'Executed', hybridVoting: { id: HV, organization: { id: ORG } },
    batchExecutions: [{ proposalId: '7', callCount: '1', transactionHash: EXECTX, executedAtBlock: '90', executor: { id: EXEC } }] };
  const response: any = { _meta: { block: { number: 100, hash: HEAD } }, organization: { id: ORG, membershipAuthority: { id: AUTH }, hybridVoting: { id: HV }, executorContract: { id: EXEC } }, proposals: [row] };
  const scope = { chainId: 100, orgId: ORG, contract: AUTH, account: ACCOUNT, contracts: { membershipAuthority: AUTH, hybridVoting: HV, executor: EXEC } };
  const source = { ...scope, endpoint: 'mock://index', method: 'continuation', indexed: true, snapshot: 'pinned' as const, block: { number: '100', hash: HEAD }, observedAt: 1000 };
  const counts = { network: 0, blocks: 0, transactions: 0, receipts: 0, queries: 0 };
  const provider = { getNetwork: async () => { counts.network++; return { chainId: 100 }; },
    getTransaction: async (x: string) => { counts.transactions++; return txs[x]; },
    getTransactionReceipt: async (x: string) => { counts.receipts++; return receipts[x]; },
    getBlock: async (x: string) => { counts.blocks++; return { number: x === '0x32' ? 50 : x === '0x5a' ? 90 : 100,
      hash: x === '0x32' ? OLD : x === '0x5a' ? EXECBLOCK : HEAD, timestamp: 1000 }; } };
  const input: RoleContinuationInput = { scope, source, rpcSource: { ...source, endpoint: 'mock://rpc', indexed: false }, provider: provider as any,
    query: async () => { counts.queries++; return response; }, creationTransactionHash: TX, proposalId: '7', creationCall,
    subjects: { source, coverage: { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] }, data: [{ subjectId, kind }] }, freshness: { now: 1000, maxAgeSeconds: 0 } };
  const bundle = (txHash: string, ops: Operation[], validation: Log[] = [], compensation: Log[] = []) => {
    const packed = ops.map(op => packUserOperationV07(op.userOp));
    txs[txHash].to = ENTRY_POINT; txs[txHash].from = address('d');
    txs[txHash].data = entryPoint.encodeFunctionData('handleOps', [packed, address('e')]);
    setLogs(txHash, [...validation, event(entryPoint, ENTRY_POINT, 'BeforeExecution', []), ...ops.flatMap(op => [...op.logs,
      event(entryPoint, ENTRY_POINT, 'UserOperationEvent', [operationIdentity(op).userOpHash, op.userOp.sender, op.userOp.paymaster ?? ethers.constants.AddressZero, op.userOp.nonce, op.success, 1, 1])]), ...compensation]);
  };
  return { input, txs, receipts, row, response, subjectId, title, creationLogs, executionLogs, counts, setLogs, bundle };
}
export function configurationFixture() {
  const f = fixture();
  const batch = [{ target: AUTH, value: '0', calldata: authority.encodeFunctionData('setSubjectDefault', [f.subjectId, true, false]) },
    { target: AUTH, value: '0', calldata: authority.encodeFunctionData('setMaxMembers', [f.subjectId, 5]) }];
  const args = [...voting.parseTransaction({ data: f.txs[TX].data }).args];
  args[4] = [batch.map(c => [c.target, c.value, c.calldata]), []];
  f.txs[TX].data = voting.encodeFunctionData('createProposal', args);
  f.row.batchExecutions[0].callCount = '2';
  f.executionLogs.splice(0, f.executionLogs.length,
    event(executor, EXEC, 'CallExecuted', [7, 0, AUTH, 0]), event(executor, EXEC, 'CallExecuted', [7, 1, AUTH, 0]),
    event(executor, EXEC, 'BatchExecuted', [7, 2]), event(voting, HV, 'ProposalExecuted', [7, 0, 2]));
  f.setLogs(EXECTX, f.executionLogs);
  const { creationCall: _, subjects: __, ...base } = f.input;
  const input: RoleConfigurationOutcomeInput = { ...base, batch };
  return { ...f, input };
}
