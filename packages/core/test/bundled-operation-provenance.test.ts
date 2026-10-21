import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { getUserOperationHash } from 'viem/account-abstraction';
import { ENTRY_POINT } from '../src/accounts/constants';
import { exactTransactionCall, readCanonicalTransaction, requireCanonicalTransaction } from '../src/reads/provenance';
import { readRoleContinuation, readRoleConfigurationOutcome } from '../src/governance/role-continuation';
import { ACCOUNT, AUTH, EXECTX, HV, META, OTHER, TX, account, address, authority, configurationFixture, entryPoint, event, fixture, hash, operation, operationIdentity, voting } from './fixtures/bundled-operation-provenance';

beforeEach(() => { vi.stubGlobal('fetch', () => { throw new Error('OFFLINE_NETWORK_BLOCKED'); }); });
afterEach(() => vi.unstubAllGlobals());
async function observed(f: ReturnType<typeof fixture>, txHash = TX) {
  return readCanonicalTransaction({ source: f.input.rpcSource, provider: f.input.provider, transactionHash: txHash, freshness: f.input.freshness });
}
function select(f: ReturnType<typeof fixture>, selector = {}, txHash = TX) {
  return observed(f, txHash).then(proof => exactTransactionCall(proof.data, 100, selector));
}
const targetOp = (f: ReturnType<typeof fixture>) => operation(ACCOUNT, '9', HV, f.txs[TX].data, true, f.creationLogs);
const unrelated = (nonce = '10', sender = OTHER, success = true) => operation(sender, nonce, AUTH, '0x12345678', success, [event(authority, AUTH, 'SubjectCreated', ['900', 0, 'Other', META, 0])]);

describe('canonical v0.7 multi-operation isolation', () => {
  it.each([0, 1, 2])('isolates operation at position %i with other senders, same-sender nonce and unrelated failure', async position => {
    const f = fixture(), selected = targetOp(f), others = [unrelated('10', ACCOUNT, false), unrelated('11')];
    others.splice(position, 0, selected); f.bundle(TX, others);
    const call = await select(f, { sender: ACCOUNT, target: HV });
    expect(call).toMatchObject({ caller: ACCOUNT, target: HV, operationStatus: 'succeeded', userOpHash: operationIdentity(selected).userOpHash });
    expect(call.logs).toHaveLength(1); expect(call.logs[0].topics[0]).toBe(voting.getEventTopic('NewProposal'));
    expect(call.logs[0].logIndex).toBe(f.receipts[TX].logs.find((l: any) => l.topics[0] === voting.getEventTopic('NewProposal')).logIndex);
    expect(f.counts).toEqual({ network: 1, blocks: 4, transactions: 1, receipts: 1, queries: 0 });
  });
  it('matches the existing hash oracle and independent viem v0.7 implementation with factory/paymaster data', async () => {
    const f = fixture(), op = targetOp(f);
    Object.assign(op.userOp, { factory: address('d'), factoryData: '0xabc123', paymaster: address('e'), paymasterVerificationGasLimit: '90000', paymasterPostOpGasLimit: '50000', paymasterData: '0xaabb' });
    f.bundle(TX, [unrelated(), op]);
    const call = await select(f, operationIdentity(op));
    const u = op.userOp;
    const independent = getUserOperationHash({ entryPointAddress: ENTRY_POINT, entryPointVersion: '0.7', chainId: 100,
      userOperation: { ...u, nonce: BigInt(u.nonce), callGasLimit: BigInt(u.callGasLimit), verificationGasLimit: BigInt(u.verificationGasLimit), preVerificationGas: BigInt(u.preVerificationGas),
        maxFeePerGas: BigInt(u.maxFeePerGas), maxPriorityFeePerGas: BigInt(u.maxPriorityFeePerGas), paymasterVerificationGasLimit: 90000n, paymasterPostOpGasLimit: 50000n } as any });
    expect(call.userOpHash).toBe(independent);
  });
  it('identical same-account intents remain ambiguous even with one failed outcome; exact hash or nonce selects', async () => {
    const f = fixture(), first = targetOp(f), second = { ...targetOp(f), userOp: { ...first.userOp, nonce: '10' }, success: false };
    f.bundle(TX, [first, second]);
    await expect(select(f, { sender: ACCOUNT, target: HV })).rejects.toThrow('EXACT_OPERATION_IDENTITY_REQUIRED');
    expect(await select(f, { userOpHash: operationIdentity(first).userOpHash })).toMatchObject({ operationStatus: 'succeeded' });
    expect(await select(f, { sender: ACCOUNT, nonce: '10' })).toMatchObject({ operationStatus: 'failed', userOpHash: operationIdentity(second).userOpHash });
  });
  it.each(['foreign event', 'duplicate event', 'reordered events', 'missing event', 'wrong sender', 'wrong nonce', 'wrong hash', 'wrong paymaster', 'noncanonical bool', 'trailing event', 'extra topic', 'missing before', 'duplicate before', 'foreign before', 'late before', 'malformed before', 'missing index', 'reordered index', 'duplicate index', 'missing receipt log'])('rejects %s', async mode => {
    const f = fixture(), op = targetOp(f); f.bundle(TX, [unrelated(), op, unrelated('12')]);
    const logs = f.receipts[TX].logs, indices = logs.flatMap((l: any, i: number) => l.topics[0] === entryPoint.getEventTopic('UserOperationEvent') ? [i] : []);
    const i = indices[1], terminal = logs[i];
    if (mode === 'foreign event') terminal.address = OTHER;
    if (mode === 'duplicate event') logs.splice(i, 0, { ...terminal });
    if (mode === 'reordered events') [logs[indices[0]], logs[i]] = [logs[i], logs[indices[0]]];
    if (mode === 'missing event') logs.splice(i, 1);
    if (mode === 'wrong sender') terminal.topics[2] = ethers.utils.hexZeroPad(OTHER, 32);
    if (mode === 'wrong nonce') terminal.data = ethers.utils.defaultAbiCoder.encode(['uint256','bool','uint256','uint256'], [10, true, 1, 1]);
    if (mode === 'wrong hash') terminal.topics[1] = hash('f');
    if (mode === 'wrong paymaster') terminal.topics[3] = ethers.utils.hexZeroPad(OTHER, 32);
    if (mode === 'noncanonical bool') terminal.data = ethers.utils.defaultAbiCoder.encode(['uint256','uint256','uint256','uint256'], [9, 2, 1, 1]);
    if (mode === 'trailing event') terminal.data += '00';
    if (mode === 'extra topic') terminal.topics.push(META);
    if (mode === 'missing before') logs.shift();
    if (mode === 'duplicate before') logs.splice(1, 0, { ...logs[0] });
    if (mode === 'foreign before') logs[0].address = OTHER;
    if (mode === 'late before') logs.push(logs.shift());
    if (mode === 'malformed before') logs[0].data = '0x00';
    if (mode === 'missing index') delete logs[i].logIndex;
    if (mode === 'reordered index') logs[i].logIndex = logs[i - 1].logIndex - 1;
    if (mode === 'duplicate index') logs[i].logIndex = logs[i - 1].logIndex;
    if (mode === 'missing receipt log') logs.splice(1, 1);
    // For semantic corruption, preserve plausible indices so boundary/identity checks do the work.
    if (!['missing index', 'reordered index', 'duplicate index', 'missing receipt log', 'reordered events'].includes(mode)) logs.forEach((l: any, j: number) => { l.logIndex = 120 + j; });
    await expect(select(f, operationIdentity(op))).rejects.toThrow();
  });
  it('excludes validation, unrelated operations and compensation; includes selected postOp window only', async () => {
    const f = fixture(), op = targetOp(f);
    const pollution = event(authority, AUTH, 'SubjectCreated', ['901', 0, 'Pollution', META, 0]);
    op.logs.push({ address: OTHER, topics: [], data: '0x' });
    f.bundle(TX, [unrelated(), op, unrelated('12')], [pollution], [pollution]);
    const call = await select(f, operationIdentity(op));
    expect(call.logs).toHaveLength(2); expect(call.logs.map(l => l.address)).toEqual([HV, OTHER]);
    expect(Object.isFrozen(call.logs)).toBe(true);
  });
  it('ignores foreign boundary lookalikes and cannot use them to replace actual EntryPoint events', async () => {
    const f = fixture(), op = targetOp(f);
    op.logs.push(event(entryPoint, OTHER, 'UserOperationEvent', [hash('f'), OTHER, ethers.constants.AddressZero, 3, true, 1, 1]));
    f.bundle(TX, [op, unrelated()]);
    expect((await select(f, operationIdentity(op))).logs).toHaveLength(2);
  });
  it.each(['hash', 'nonce', 'sender', 'entrypoint', 'chain', 'target', 'data'])('rejects wrong selector %s', async mode => {
    const f = fixture(), op = targetOp(f); f.bundle(TX, [unrelated(), op]);
    const identity: any = { ...operationIdentity(op), target: HV };
    if (mode === 'hash') identity.userOpHash = hash('f');
    if (mode === 'nonce') identity.nonce = '11';
    if (mode === 'sender') identity.sender = OTHER;
    if (mode === 'entrypoint') identity.entryPoint = OTHER;
    if (mode === 'target') identity.target = AUTH;
    if (mode === 'data') identity.data = '0x';
    const proof = await observed(f);
    expect(() => exactTransactionCall(proof.data, mode === 'chain' ? 42161 : 100, identity)).toThrow();
  });
  it.each(['account batch', 'account value', 'account trailing', 'outer trailing', 'duplicate identity', 'different EntryPoint', 'outer failure'])('rejects unsupported/malformed %s', async mode => {
    const f = fixture(), op = targetOp(f);
    if (mode === 'account batch') op.userOp.callData = account.encodeFunctionData('executeBatch', [[HV], [0], [f.txs[TX].data]]);
    if (mode === 'account value') op.userOp.callData = account.encodeFunctionData('execute', [HV, 1, f.txs[TX].data]);
    if (mode === 'account trailing') op.userOp.callData += '00';
    f.bundle(TX, mode === 'duplicate identity' ? [op, op] : [unrelated(), op]);
    if (mode === 'outer trailing') f.txs[TX].data += '00';
    if (mode === 'different EntryPoint') f.txs[TX].to = OTHER;
    if (mode === 'outer failure') f.receipts[TX].status = 0;
    await expect(select(f, operationIdentity(op))).rejects.toThrow();
  });
  it('intent predicates see only frozen canonical call fields, never outcome or mutable proof', async () => {
    const f = fixture(), op = targetOp(f); f.bundle(TX, [op, unrelated()]);
    const seen: string[][] = [];
    const call = await select(f, { matchesCall: (candidate: any) => {
      seen.push(Object.keys(candidate).sort()); expect(Object.isFrozen(candidate)).toBe(true);
      expect(() => { candidate.data = '0x'; }).toThrow();
      return candidate.target.toLowerCase() === HV;
    } });
    expect(seen).toEqual([['caller', 'data', 'target'], ['caller', 'data', 'target']]);
    expect(call.data).toBe(account.parseTransaction({ data: op.userOp.callData }).args.data);
  });
  it('unrelated account methods may co-bundle without pretending to decode them', async () => {
    const f = fixture(), op = targetOp(f), other = unrelated(); other.userOp.callData = '0x11223344';
    f.bundle(TX, [other, op]); expect(await select(f, operationIdentity(op))).toMatchObject({ target: HV, operationStatus: 'succeeded' });
  });
  it('retains legacy single-op call behavior and direct EOA support, and rejects clone/rebase attempts for isolated views', async () => {
    const f = fixture(), direct = await observed(f);
    expect(exactTransactionCall(direct.data, 100)).toMatchObject({ target: HV, caller: ACCOUNT });
    expect(exactTransactionCall(direct.data, 100, {}).logs).toBe(direct.data.logs);
    expect(() => exactTransactionCall({ ...direct.data }, 100, {})).toThrow('CANONICAL_TRANSACTION_CHAIN_PROOF_REQUIRED');
    expect(() => requireCanonicalTransaction({ ...direct }, f.input.rpcSource, f.input.freshness)).toThrow('CANONICAL_TRANSACTION_PROOF_REQUIRED');
    const op = targetOp(f); f.bundle(TX, [op]); const proof = await observed(f);
    expect(exactTransactionCall(proof.data, 100)).toMatchObject({ target: HV, userOpHash: operationIdentity(op).userOpHash });
    expect(exactTransactionCall(proof.data, 100, {}).logs).toHaveLength(1);
    f.bundle(TX, [op, unrelated()]); const bundled = await observed(f);
    expect(() => exactTransactionCall(bundled.data, 100)).toThrow('EXACT_OPERATION_ISOLATION_REQUIRED');
  });
});

describe('role continuation and configuration use independently selected execution logs', () => {
  it.each(['Role', 'Group'] as const)('proves %s creation among other create events, with a different bundled announcer account', async kind => {
    const f = fixture(kind), op = targetOp(f), exec = operation(OTHER, '20', HV, f.txs[EXECTX].data, true, f.executionLogs);
    f.bundle(TX, [unrelated(), op, unrelated('12', ACCOUNT)]);
    f.bundle(EXECTX, [unrelated('21'), exec, unrelated('22', OTHER)]);
    expect(await readRoleContinuation(f.input)).toMatchObject({ state: 'created', subjectId: f.subjectId, executionTransactionHash: EXECTX });
    expect(f.counts).toEqual({ network: 2, blocks: 8, transactions: 2, receipts: 2, queries: 1 });
  });
  it('same-account competing proposal intents require exact identity even when saved proposal ID is known', async () => {
    const f = fixture(), op = targetOp(f), duplicate = targetOp(f); duplicate.userOp.nonce = '10';
    duplicate.logs = [event(voting, HV, 'NewProposal', [8, f.title, META, 2, 1600, 1000])];
    f.bundle(TX, [op, duplicate]);
    await expect(readRoleContinuation(f.input)).rejects.toThrow('EXACT_OPERATION_IDENTITY_REQUIRED');
    f.input.creationOperation = operationIdentity(op);
    expect(await readRoleContinuation(f.input)).toMatchObject({ state: 'created', subjectId: f.subjectId });
  });
  it.each(['creation', 'execution'])('rejects failed %s operation despite successful outer receipt', async stage => {
    const f = fixture();
    if (stage === 'creation') { const op = targetOp(f); op.success = false; f.bundle(TX, [op, unrelated()]); }
    else f.bundle(EXECTX, [operation(OTHER, '20', HV, f.txs[EXECTX].data, false, f.executionLogs), unrelated()]);
    await expect(readRoleContinuation(f.input)).rejects.toThrow();
  });
  it('does not accept validation or other operations as missing SubjectCreated/proposal execution proof', async () => {
    const f = fixture(), exec = operation(OTHER, '20', HV, f.txs[EXECTX].data, true, []);
    f.bundle(EXECTX, [exec, operation(ACCOUNT, '21', AUTH, '0x12345678', true, f.executionLogs)], f.executionLogs);
    await expect(readRoleContinuation(f.input)).rejects.toThrow('EXACT_ROLE_EXECUTION_EVENTS_REQUIRED');
  });
  it.each(['foreign subject', 'foreign executor', 'duplicate subject', 'wrong actual subject', 'stale index'])('rejects isolated %s', async mode => {
    const f = fixture(), op = targetOp(f), exec = operation(OTHER, '20', HV, f.txs[EXECTX].data, true, [...f.executionLogs]);
    if (mode === 'foreign subject') exec.logs[0] = { ...exec.logs[0], address: OTHER };
    if (mode === 'foreign executor') exec.logs[1] = { ...exec.logs[1], address: OTHER };
    if (mode === 'duplicate subject') exec.logs.push(exec.logs[0]);
    if (mode === 'wrong actual subject') exec.logs[0] = event(authority, AUTH, 'SubjectCreated', ['999', 0, 'Builders', META, 2]);
    if (mode === 'stale index') f.input.subjects = { ...f.input.subjects, data: [] };
    f.bundle(TX, [op]); f.bundle(EXECTX, [unrelated(), exec]);
    await expect(readRoleContinuation(f.input)).rejects.toThrow();
  });
  it('ambiguous announceWinner calls require independent execution identity, never the creator account', async () => {
    const f = fixture(), first = operation(OTHER, '20', HV, f.txs[EXECTX].data, true, f.executionLogs), second = operation(ACCOUNT, '21', HV, f.txs[EXECTX].data, false);
    f.bundle(EXECTX, [first, second]);
    await expect(readRoleContinuation(f.input)).rejects.toThrow('EXACT_OPERATION_IDENTITY_REQUIRED');
    f.input.executionOperation = operationIdentity(first);
    expect(await readRoleContinuation(f.input)).toMatchObject({ state: 'created' });
    f.input.executionOperation = operationIdentity(second);
    await expect(readRoleContinuation(f.input)).rejects.toThrow('EXACT_ROLE_EXECUTION_REQUIRED');
  });
  it.each([0, 1, 2])('proves separate configuration creation/execution among operations at %i', async index => {
    const f = configurationFixture(), creation = operation(ACCOUNT, '9', HV, f.txs[TX].data, true, f.creationLogs), execution = operation(OTHER, '20', HV, f.txs[EXECTX].data, true, f.executionLogs);
    const createOps = [unrelated(), unrelated('12', ACCOUNT)], execOps = [unrelated('21'), unrelated('22', OTHER)];
    createOps.splice(index, 0, creation); execOps.splice(2 - index, 0, execution);
    f.bundle(TX, createOps, f.creationLogs); f.bundle(EXECTX, execOps, f.executionLogs, f.executionLogs);
    expect(await readRoleConfigurationOutcome(f.input)).toMatchObject({ state: 'executed', proposalId: '7' });
  });
  it.each(['creation ambiguity', 'execution ambiguity', 'wrong batch', 'missing execution', 'wrong emitter', 'failed inner execution'])('configuration rejects %s and uses its own exact selectors', async mode => {
    const f = configurationFixture(), creation = operation(ACCOUNT, '9', HV, f.txs[TX].data, true, f.creationLogs), execution = operation(OTHER, '20', HV, f.txs[EXECTX].data, true, f.executionLogs);
    const secondCreation = { ...creation, userOp: { ...creation.userOp, nonce: '10' } }, secondExecution = { ...execution, userOp: { ...execution.userOp, nonce: '21' } };
    if (mode === 'wrong batch') f.input.batch = [{ ...f.input.batch[0], value: '1' }];
    if (mode === 'missing execution') execution.logs = [];
    if (mode === 'wrong emitter') execution.logs = execution.logs.map(l => ({ ...l, address: OTHER }));
    if (mode === 'failed inner execution') execution.success = false;
    f.bundle(TX, mode === 'creation ambiguity' ? [creation, secondCreation] : [creation, unrelated()]);
    f.bundle(EXECTX, mode === 'execution ambiguity' ? [execution, secondExecution] : [execution, unrelated()]);
    await expect(readRoleConfigurationOutcome(f.input)).rejects.toThrow();
    if (mode === 'creation ambiguity' || mode === 'execution ambiguity') {
      f.input.creationOperation = operationIdentity(creation); f.input.executionOperation = operationIdentity(execution);
      expect(await readRoleConfigurationOutcome(f.input)).toMatchObject({ state: 'executed' });
    }
  });
});
