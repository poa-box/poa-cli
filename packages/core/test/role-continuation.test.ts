import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { getAbi } from '../src/contracts';
import { composeSubjectId } from '../src/authority/ids';
import { readRoleContinuation, readRoleConfigurationOutcome } from '../src/governance/role-continuation';
import { knownFact } from '../src/data/facts';
import { planExistingRoleConfiguration } from '../src/governance/role-planning';
const addr = (x: string) => '0x' + x.repeat(40), hash = (x: string) => '0x' + x.repeat(64);
const AUTH = addr('1'), HV = addr('2'), EXEC = addr('3'), ACCOUNT = addr('4'), ORG = hash('5');
const TX = hash('6'), EXECTX = hash('7'), HEAD = hash('8'), OLD = hash('9'), EXECBLOCK = hash('a'), META = hash('b');
const a = new ethers.utils.Interface(getAbi('MembershipAuthority')), h = new ethers.utils.Interface(getAbi('HybridVotingNew')), e = new ethers.utils.Interface(getAbi('Executor'));
function fixture(kind: 'Role' | 'Group' = 'Role') {
  const subjectId = composeSubjectId(AUTH, 15);
  const creationCall = { target: AUTH, value: '0', calldata: a.encodeFunctionData(kind === 'Role' ? 'createRole' : 'createGroup', ['Builders', META, 'image', kind === 'Role' ? 2 : []]) };
  const title = ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Create Builders'));
  const txs: any = {
    [TX]: { hash: TX, to: HV, from: ACCOUNT, chainId: 100, blockNumber: 50, blockHash: OLD, value: ethers.constants.Zero,
      data: h.encodeFunctionData('createProposal', [title, META, 10, 2, [[[AUTH, 0, creationCall.calldata]], []], []]) },
    [EXECTX]: { hash: EXECTX, to: HV, from: ACCOUNT, chainId: 100, blockNumber: 90, blockHash: EXECBLOCK, value: ethers.constants.Zero, data: h.encodeFunctionData('announceWinner', [7]) },
  };
  const log = (iface: ethers.utils.Interface, emitter: string, name: string, args: any[], txHash: string) => ({
    ...iface.encodeEventLog(iface.getEvent(name), args), address: emitter, transactionHash: txHash, blockNumber: txs[txHash].blockNumber, blockHash: txs[txHash].blockHash, removed: false,
  });
  const receipts: any = {
    [TX]: { status: 1, transactionHash: TX, blockNumber: 50, blockHash: OLD, logs: [log(h, HV, 'NewProposal', [7, title, META, 2, 1600, 1000], TX)] },
    [EXECTX]: { status: 1, transactionHash: EXECTX, blockNumber: 90, blockHash: EXECBLOCK, logs: [
      log(a, AUTH, 'SubjectCreated', [subjectId, kind === 'Role' ? 0 : 1, 'Builders', META, kind === 'Role' ? 2 : 0], EXECTX),
      log(e, EXEC, 'CallExecuted', [7, 0, AUTH, 0], EXECTX), log(e, EXEC, 'BatchExecuted', [7, 1], EXECTX), log(h, HV, 'ProposalExecuted', [7, 0, 1], EXECTX),
    ] },
  };
  const row: any = { id: HV + '-7', proposalId: '7', transactionHash: TX, createdAtBlock: '50', wasExecuted: true,
    executionFailed: false, isValid: true, winningOption: '0', status: 'Executed', hybridVoting: { id: HV, organization: { id: ORG } },
    batchExecutions: [{ proposalId: '7', callCount: '1', transactionHash: EXECTX, executedAtBlock: '90', executor: { id: EXEC } }] };
  const response: any = { _meta: { block: { number: 100, hash: HEAD } }, organization: { id: ORG, membershipAuthority: { id: AUTH }, hybridVoting: { id: HV }, executorContract: { id: EXEC } }, proposals: [row] };
  const scope = { chainId: 100, orgId: ORG, contract: AUTH, account: ACCOUNT, contracts: { membershipAuthority: AUTH, hybridVoting: HV, executor: EXEC } };
  const source = { ...scope, endpoint: 'mock://index', method: 'continuation', indexed: true, snapshot: 'pinned' as const, block: { number: '100', hash: HEAD }, observedAt: 1000 };
  const provider = { getNetwork: vi.fn(async () => ({ chainId: 100 })), getTransaction: vi.fn(async (x: string) => txs[x]),
    getTransactionReceipt: vi.fn(async (x: string) => receipts[x]), getBlock: vi.fn(async (x: string) => ({ number: x === '0x32' ? 50 : x === '0x5a' ? 90 : 100, hash: x === '0x32' ? OLD : x === '0x5a' ? EXECBLOCK : HEAD, timestamp: 1000 })) };
  const subjects = { source, coverage: { status: 'complete' as const, receivedKeys: [], missingIds: [], failedIds: [], issues: [] }, data: [{ subjectId, kind }] };
  const input = { scope, source, rpcSource: { ...source, endpoint: 'mock://rpc', indexed: false }, provider: provider as any,
    query: vi.fn(async () => response), creationTransactionHash: TX, proposalId: '7', creationCall, subjects, freshness: { now: 1000, maxAgeSeconds: 0 } };
  return { input, txs, receipts, row, response, subjectId, log };
}
describe('exact staged role continuation, browser-pure bounded reads', () => {
  it.each(['Role', 'Group'] as const)('resolves a %s actual ID from its executed proposal, never its name or predicted sequence', async kind => {
    const f = fixture(kind); expect(await readRoleContinuation(f.input)).toMatchObject({ state: 'created', subjectId: f.subjectId, proposalId: '7' });
    expect(f.input.query).toHaveBeenCalledOnce();
    expect(f.input.query.mock.calls[0][1]).toEqual({ orgId: ORG, id: HV + '-7', block: { hash: HEAD } });
    expect(f.input.provider.getTransaction).toHaveBeenCalledTimes(2);
  });
  it.each(['pending', 'failed', 'rejected'])('retains %s without fetching an execution or allowing a duplicate create', async state => {
    const f = fixture(); f.row.wasExecuted = false; f.row.isValid = null; f.row.winningOption = null; f.row.batchExecutions = [];
    if (state === 'failed') f.row.executionFailed = true;
    if (state === 'rejected') f.row.isValid = false;
    expect(await readRoleContinuation(f.input)).toMatchObject({ state });
    expect(f.input.provider.getTransaction).toHaveBeenCalledOnce();
  });
  it('recovers the exact created proposal ID after uncertain submission without resending', async () => {
    const f = fixture(); delete (f.input as any).proposalId;
    expect(await readRoleContinuation(f.input)).toMatchObject({ state: 'created', proposalId: '7' });
  });
  it.each(['account', 'org', 'authority', 'executor', 'proposal', 'creation call', 'execution association', 'chain', 'canonical block', 'receipt', 'event emitter', 'duplicate event', 'wrong subject', 'fresh index', 'failed execution', 'different execution call', 'trailing data'])('rejects mismatched %s', async mode => {
    const f = fixture();
    if (mode === 'account') f.input.scope.account = addr('c');
    if (mode === 'org') f.response.organization.id = hash('c');
    if (mode === 'authority') f.response.organization.membershipAuthority.id = addr('c');
    if (mode === 'executor') f.response.organization.executorContract.id = addr('c');
    if (mode === 'proposal') f.input.proposalId = '8';
    if (mode === 'creation call') f.input.creationCall.calldata = a.encodeFunctionData('createRole', ['Other', META, '', 2]);
    if (mode === 'execution association') f.row.batchExecutions[0].proposalId = '8';
    if (mode === 'chain') f.txs[EXECTX].chainId = 42161;
    if (mode === 'canonical block') f.input.provider.getBlock.mockImplementation(async () => ({ number: 100, hash: OLD, timestamp: 1000 }));
    if (mode === 'receipt') f.receipts[EXECTX].status = 0;
    if (mode === 'event emitter') f.receipts[EXECTX].logs[0].address = addr('c');
    if (mode === 'duplicate event') f.receipts[EXECTX].logs.push(f.receipts[EXECTX].logs[0]);
    if (mode === 'wrong subject') f.receipts[EXECTX].logs[0] = f.log(a, AUTH, 'SubjectCreated', [f.subjectId, 1, 'Builders', META, 0], EXECTX);
    if (mode === 'fresh index') f.input.subjects.data = [];
    if (mode === 'failed execution') f.receipts[EXECTX].logs.push(f.log(h, HV, 'ProposalExecutionFailed', [7, 0, '0x'], EXECTX));
    if (mode === 'different execution call') f.txs[EXECTX].data = h.encodeFunctionData('announceWinner', [8]);
    if (mode === 'trailing data') f.txs[TX].data += '00';
    await expect(readRoleContinuation(f.input)).rejects.toThrow();
  });
  it('does not count an already accepted holder twice against a full existing cap', () => {
    const f = fixture(); const plan = planExistingRoleConfiguration({ scope: f.input.scope,
      freshness: { now: 1000, maxAgeSeconds: 0, block: f.input.source.block }, subjectId: f.subjectId,
      context: { ...f.input.subjects, source: f.input.rpcSource, data: { readiness: { membershipAuthority: { id: AUTH, isRouterBound: true, cutoverAt: '1' } },
        executorAuthorized: knownFact(true), subjects: [{ subjectId: f.subjectId, kind: 'Role', metadataPointer: ethers.constants.HashZero, imageURI: '', maxMembers: '2', memberCount: '2' }], groupEdges: [],
        accounts: [{ account: ACCOUNT, acceptedAnywhere: knownFact(true), acceptedInSubject: knownFact(true), acceptedSubjectId: f.subjectId }] } },
      request: { kind: 'Role', name: 'Builders', holders: [{ account: ACCOUNT, sticky: false }] } });
    expect(plan.status).toBe('ready');
  });
});


describe('exact configuration vote outcome', () => {
  const configured = () => {
    const f = fixture();
    const calldata = a.encodeFunctionData('setSubjectDefault', [f.subjectId, true, false]);
    const original = h.parseTransaction({ data: f.txs[TX].data });
    const args = [...original.args]; args[4] = [[[AUTH, 0, calldata]], []];
    f.txs[TX].data = h.encodeFunctionData(original.signature, args);
    const { creationCall: _, subjects: __, ...base } = f.input;
    return { ...f, input: { ...base, batch: [{ target: AUTH, value: '0', calldata }] } };
  };
  it.each(['pending', 'failed', 'rejected', 'executed'])('proves %s from the exact separate vote without resending', async state => {
    const f = configured();
    if (state !== 'executed') { f.row.wasExecuted = false; f.row.isValid = null; f.row.winningOption = null; f.row.batchExecutions = []; }
    if (state === 'failed') f.row.executionFailed = true;
    if (state === 'rejected') f.row.isValid = false;
    expect(await readRoleConfigurationOutcome(f.input)).toMatchObject({ state, proposalId: '7' });
  });
  it.each(['batch', 'account', 'proposal', 'executor', 'event', 'chain'])('rejects configuration %s mismatch', async mode => {
    const f = configured();
    if (mode === 'batch') f.input.batch[0].calldata += '00';
    if (mode === 'account') f.input.scope.account = addr('c');
    if (mode === 'proposal') f.input.proposalId = '9';
    if (mode === 'executor') f.row.batchExecutions[0].executor.id = addr('c');
    if (mode === 'event') f.receipts[EXECTX].logs.pop();
    if (mode === 'chain') f.txs[EXECTX].chainId = 42161;
    await expect(readRoleConfigurationOutcome(f.input)).rejects.toThrow();
  });
});


describe('existing-role metadata and indexed attribution', () => {
  function input() {
    const f = fixture();
    return { scope: f.input.scope, subjectId: f.subjectId, freshness: { now: 1000, maxAgeSeconds: 0, block: f.input.source.block },
      context: { ...f.input.subjects, source: f.input.rpcSource, data: { readiness: { membershipAuthority: { id: AUTH, isRouterBound: true, cutoverAt: '1' } },
        executorAuthorized: knownFact(true), indexedAuthoritySource: f.input.source,
        subjects: [{ subjectId: f.subjectId, kind: 'Role' as const, maxMembers: '2', memberCount: '2', metadataPointer: META, imageURI: 'keep-image' }],
        groupEdges: [], accounts: [{ account: ACCOUNT, acceptedAnywhere: knownFact(true), acceptedInSubject: knownFact(true), acceptedSubjectId: f.subjectId }] } },
      request: { kind: 'Role' as const, name: 'Updated name', holders: [{ account: ACCOUNT, sticky: false }] } };
  }
  it('preserves existing metadata/image when an edit does not replace them', () => {
    const i = input(), plan = planExistingRoleConfiguration(i); expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') throw new Error('blocked');
    const call = a.parseTransaction({ data: plan.data.batch[0].calldata });
    expect(call.args[2]).toBe(META); expect(call.args[3]).toBe('keep-image');
  });
  it.each(['unknown metadata', 'indexed source kind', 'indexed source block', 'accepted subject'])('blocks %s without guessed metadata or capacity', mode => {
    const i = input();
    if (mode === 'unknown metadata') delete (i.context.data.subjects[0] as any).metadataPointer;
    if (mode === 'indexed source kind') i.context.data.indexedAuthoritySource = i.context.source as any;
    if (mode === 'indexed source block') i.context.data.indexedAuthoritySource = { ...i.context.data.indexedAuthoritySource, block: { number: '101', hash: HEAD } };
    if (mode === 'accepted subject') i.context.data.accounts[0].acceptedSubjectId = composeSubjectId(AUTH, 16);
    expect(planExistingRoleConfiguration(i).status).toBe('blocked');
  });
});
