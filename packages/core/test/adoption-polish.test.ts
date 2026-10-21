import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { entryPoint07Address } from 'viem/account-abstraction';
import { keccak256, stringToHex, encodeFunctionData, encodeEventTopics, encodeAbiParameters, toHex } from 'viem';
import bs58 from 'bs58';
import { build } from 'esbuild';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { requireValidVoteWeights } from '../src/governance/validation';
import { ENTRY_POINT, EOA_DELEGATION } from '../src/accounts/constants';
import { legacyPointerToBytes32, legacyBytes32ToIpfsCid } from '../src/encoding/legacy-pointer';
import { metadataPointerToBytes32, bytes32ToCidV0 } from '../src/encoding/cid';
import { buildVote } from '../src/tx/vote';
import { buildCreateTaskRaw, buildCreateAndAssignTaskRaw, buildCreateTasksBatchRaw, buildCreateTasksBatch, type CreateTaskBatchRawRow } from '../src/tx/task';
import { encodeIntent } from '../src/tx/intent';
import { parseTaskCreatedReceipt, type TaskCreationEvidence, type TaskReceiptInput } from '../src/tasks/receipts';

const TM = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const ASSIGNEE = '0x3333333333333333333333333333333333333333';
const HASH = '0x' + 'AB'.repeat(32);
const ZERO = ethers.constants.HashZero;
const ADDRESS_ZERO = ethers.constants.AddressZero;

describe('strict public vote vector validation without changing legacy calldata', () => {
  it.each([[100], [0, 100], [20, 30, 50]].map(weights => [weights]))('validates weights %j', weights => {
    expect(requireValidVoteWeights(weights)).toEqual({ weights });
  });
  it('returns independent arrays and preserves option order', () => {
    const weights = [0, 40, 60], indices = [Number.MAX_SAFE_INTEGER, 3, 0];
    const result = requireValidVoteWeights(weights, indices);
    expect(result).toEqual({ weights, optionIndices: indices });
    weights[1] = 1; indices[1] = 2;
    expect(result).toEqual({ weights: [0, 40, 60], optionIndices: [Number.MAX_SAFE_INTEGER, 3, 0] });
  });
  it.each([[], [1], [99], [101], [-1, 101], [0.5, 99.5], [NaN, 100], [Infinity], ['100'], null, undefined, Array(1)].map(weights => [weights]))('rejects invalid weights %j', weights => {
    expect(() => requireValidVoteWeights(weights as number[])).toThrow();
  });
  it.each([[], [0], [0, 0], [-1, 1], [0.5, 1], [NaN, 1], [Infinity, 1], [Number.MAX_SAFE_INTEGER + 1, 1], ['0', 1], null, Array(2)].map(indices => [indices]))('rejects invalid paired options %j', indices => {
    expect(() => requireValidVoteWeights([40, 60], indices as number[])).toThrow();
  });
  it('keeps the old permissive builder: weight total 1 still encodes', () => {
    expect(encodeIntent(buildVote({ votingAddress: TM, votingAbiName: 'HybridVotingNew', proposalId: '1', optionIndices: [0], weights: [1] })).data).toMatch(/^0x/);
    expect(() => requireValidVoteWeights([1], [0])).toThrow('total 100');
  });
});

describe('lightweight account constants', () => {
  it('matches the existing executor values and viem EntryPoint oracle', async () => {
    const sponsored = await import('../src/execute/sponsored');
    expect(ENTRY_POINT).toBe(entryPoint07Address);
    expect(EOA_DELEGATION).toBe('0x776ec88A88E86e38d54a985983377f1A2A25ef8b');
    expect(sponsored.ENTRY_POINT).toBe(ENTRY_POINT);
    expect(sponsored.EOA_DELEGATION).toBe(EOA_DELEGATION);
  });
});

describe('explicit historical pointer compatibility', () => {
  it.each([0, 1, 127, 255])('preserves CIDv0 digest bytes (seed %i)', seed => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => (seed + i) % 256);
    const cid = bs58.encode(Uint8Array.from([0x12, 0x20, ...bytes]));
    const hash = toHex(bytes);
    expect(legacyPointerToBytes32(cid)).toBe(hash);
    expect(legacyBytes32ToIpfsCid(hash)).toBe(cid);
    expect(legacyBytes32ToIpfsCid(bytes)).toBe(cid);
    expect(legacyBytes32ToIpfsCid([...bytes])).toBe(cid);
  });
  it.each(['legacy project name', 'Community 🌱', 'bafy-legacy-fallback', '0x01'])('hashes legacy UTF-8 text %s using an independent viem oracle', text => {
    expect(legacyPointerToBytes32(text)).toBe(keccak256(stringToHex(text)));
  });
  it('preserves unchecked literal hex case and malformed UTF-16 failure', () => {
    expect(legacyPointerToBytes32(HASH)).toBe(HASH);
    const malformed = '0x' + 'gg'.repeat(32);
    expect(legacyPointerToBytes32(malformed)).toBe(malformed);
    expect(() => legacyPointerToBytes32('\ud800')).toThrow();
  });
  it.each([null, undefined, ''])('keeps empty/absent sentinels %j', input => {
    expect(legacyPointerToBytes32(input)).toBe(ZERO);
    expect(legacyBytes32ToIpfsCid(input)).toBeNull();
  });
  it('preserves permissive short/empty digest decoding and zero-array distinction', () => {
    expect(legacyBytes32ToIpfsCid(ZERO)).toBeNull();
    for (const bytes of [new Uint8Array(0), new Uint8Array(32), Uint8Array.of(1, 255)]) {
      expect(legacyBytes32ToIpfsCid(bytes)).toBe(bs58.encode(Uint8Array.from([0x12, 0x20, ...bytes])));
      expect(legacyBytes32ToIpfsCid(toHex(bytes))).toBe(bytes.length === 32 ? null : bs58.encode(Uint8Array.from([0x12, 0x20, ...bytes])));
    }
  });
  it('returns recoverable invalid sentinels without logging', () => {
    const error = vi.spyOn(console, 'error'), warn = vi.spyOn(console, 'warn');
    try {
      expect(legacyPointerToBytes32('Qm0-invalid-base58')).toBe(ZERO);
      for (const input of ['0x1', 'not hex', '0xgg']) expect(legacyBytes32ToIpfsCid(input)).toBeNull();
      expect(error).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
    } finally { error.mockRestore(); warn.mockRestore(); }
  });
  it('retains the historical arrayify numeric and Hexable input boundary', () => {
    expect(legacyBytes32ToIpfsCid(0)).toBeNull();
    expect(legacyBytes32ToIpfsCid(1)).toBe(legacyBytes32ToIpfsCid('0x01'));
    expect(legacyBytes32ToIpfsCid({ toHexString: () => '0x01' })).toBe(legacyBytes32ToIpfsCid('0x01'));
    expect(legacyBytes32ToIpfsCid(-1)).toBeNull();
  });
  it('does not relax strict CID APIs or describe CIDv1 text as a digest', () => {
    for (const input of [ZERO, '0x01', '', 'legacy project name', 'bafy-legacy-fallback']) expect(() => metadataPointerToBytes32(input)).toThrow();
    expect(() => bytes32ToCidV0('0x01')).toThrow();
  });
});

// Independent hand-written deployed signatures: no builder ABI/tuple reuse.
const taskInputs = [
  { name: 'payout', type: 'uint256' }, { name: 'title', type: 'bytes' }, { name: 'metadataHash', type: 'bytes32' },
  { name: 'bountyToken', type: 'address' }, { name: 'bountyPayout', type: 'uint256' }, { name: 'requiresApplication', type: 'bool' },
  { name: 'absoluteDeadline', type: 'uint48' }, { name: 'completionWindow', type: 'uint32' },
] as const;
const createInputs = [...taskInputs.slice(0, 3), { name: 'pid', type: 'bytes32' }, ...taskInputs.slice(3)];
const oracleAbi = [
  { type: 'function', name: 'createTask', stateMutability: 'nonpayable', inputs: createInputs, outputs: [] },
  { type: 'function', name: 'createAndAssignTask', stateMutability: 'nonpayable', inputs: [...createInputs.slice(0, 4), { name: 'assignee', type: 'address' }, ...createInputs.slice(4)], outputs: [] },
  { type: 'function', name: 'createTasksBatch', stateMutability: 'nonpayable', inputs: [{ name: 'pid', type: 'bytes32' }, { name: 'tasks', type: 'tuple[]', components: taskInputs }], outputs: [] },
] as const;
const rawRow: CreateTaskBatchRawRow = { title: 'Community 🌱', metadataHash: ZERO, payoutRaw: '9007199254740993000001', bountyToken: TOKEN,
  bountyPayoutRaw: '9007199254740993', requiresApplication: false, absoluteDeadline: 0, completionWindow: 3600 };
const raw = { ...rawRow, taskManagerAddress: TM, projectId: ZERO, features: { deadlines: true } };
const rowValues = (row: CreateTaskBatchRawRow) => [BigInt(row.payoutRaw.toString()), stringToHex(row.title), row.metadataHash,
  row.bountyToken ?? ADDRESS_ZERO, BigInt(row.bountyPayoutRaw?.toString() ?? '0'), row.requiresApplication ?? false,
  row.absoluteDeadline ?? 0, row.completionWindow ?? 0];

describe('canonical raw task creation and optional zero metadata', () => {
  it('anchors zero metadata and atomic row order to checked-in contract source', () => {
    const source = readFileSync(resolve(__dirname, 'fixtures/core-update/work/TaskManager.sol.txt'), 'utf8');
    for (const name of ['_createTask', '_createAndAssignTask']) {
      const body = source.slice(source.indexOf(`function ${name}(`)).split('\n    }')[0];
      expect(body).toContain('ValidationLib.requireValidTitle(title)');
      expect(body).toContain('ValidationLib.requireValidPayout96(payout)');
      expect(body).toContain('ValidationLib.requireValidBountyConfig(bountyToken, bountyPayout)');
      expect(body).toContain('emit TaskCreated(');
      expect(body).not.toMatch(/\b(?:require|revert)\b[^;\n]*metadataHash/);
    }
    expect(source).toContain('if (tasks.length == 0) revert EmptyBatch()');
    expect(source).toContain('CreateTaskInput calldata t = tasks[i]');
    expect(source).toContain('taskIds[i] = id');
  });
  it.each(['createTask', 'createAndAssignTask'] as const)('%s preserves exact zero-metadata ABI calldata and raw amounts', method => {
    const row = rowValues(rawRow);
    const args = [...row.slice(0, 3), ZERO, ...(method === 'createAndAssignTask' ? [ASSIGNEE] : []), ...row.slice(3)];
    const intent = method === 'createTask' ? buildCreateTaskRaw(raw) : buildCreateAndAssignTaskRaw({ ...raw, assignee: ASSIGNEE });
    expect(encodeIntent(intent).data).toBe(encodeFunctionData({ abi: oracleAbi, functionName: method, args } as any));
  });
  it('emits one atomic batch, using named raw amounts once with no token decimal lookup', () => {
    const second = { ...rawRow, title: 'Second', metadataHash: HASH, payoutRaw: '1', bountyPayoutRaw: '1', requiresApplication: true, absoluteDeadline: 1800000000 };
    const intent = buildCreateTasksBatchRaw({ taskManagerAddress: TM, projectId: ZERO, tasks: [rawRow, second] });
    expect(intent.method).toBe('createTasksBatch');
    expect(encodeIntent(intent).data).toBe(encodeFunctionData({ abi: oracleAbi, functionName: 'createTasksBatch', args: [ZERO, [rowValues(rawRow), rowValues(second)]] } as any).toLowerCase());
    expect(rawRow.metadataHash).toBe(ZERO);
  });
  it.each([{ payoutRaw: '0' }, { payoutRaw: '1.2' }, { payoutRaw: Number.MAX_SAFE_INTEGER + 1 }, { payoutRaw: (10n ** 24n + 1n).toString() },
    { bountyPayoutRaw: '-1' }, { bountyToken: ADDRESS_ZERO }, { title: '' }, { title: '🌱'.repeat(65) }, { requiresApplication: 1 },
    { absoluteDeadline: 2 ** 48 }, { completionWindow: 2 ** 32 }, { metadataHash: '' }, { metadataHash: '0x01' }, { metadataHash: 'legacy text' },
    { metadataHash: '0x' + 'gg'.repeat(32) }])('all raw creation paths reject invalid row %j', change => {
    const bad = { ...raw, ...change } as any;
    expect(() => buildCreateTaskRaw(bad)).toThrow();
    expect(() => buildCreateAndAssignTaskRaw({ ...bad, assignee: ASSIGNEE })).toThrow();
    expect(() => buildCreateTasksBatchRaw({ taskManagerAddress: TM, projectId: ZERO, tasks: [rawRow, bad] })).toThrow();
  });
  it('rejects empty/sparse batches and invalid shared scope', () => {
    for (const tasks of [[], Array(1), null]) expect(() => buildCreateTasksBatchRaw({ taskManagerAddress: TM, projectId: ZERO, tasks } as any)).toThrow();
    for (const change of [{ taskManagerAddress: ADDRESS_ZERO }, { taskManagerAddress: 'bad' }, { projectId: 'bad' }])
      expect(() => buildCreateTasksBatchRaw({ taskManagerAddress: TM, projectId: ZERO, tasks: [rawRow], ...change })).toThrow();
  });
  it('preserves the old human batch builder scaling', () => {
    const old = buildCreateTasksBatch({ taskManagerAddress: TM, projectId: ZERO, tasks: [{ title: 'Old', metadataHash: ZERO, payout: '1' }] });
    const current = buildCreateTasksBatchRaw({ taskManagerAddress: TM, projectId: ZERO, tasks: [{ title: 'Old', metadataHash: ZERO, payoutRaw: '1000000000000000000' }] });
    expect(encodeIntent(old).data).toBe(encodeIntent(current).data);
  });
});

const event = { type: 'event', name: 'TaskCreated', inputs: [
  { type: 'uint256', name: 'taskId', indexed: true }, { type: 'bytes32', name: 'projectId', indexed: true },
  { type: 'uint256', name: 'payout', indexed: false }, { type: 'address', name: 'bountyToken', indexed: false },
  { type: 'uint256', name: 'bountyPayout', indexed: false }, { type: 'bool', name: 'requiresApplication', indexed: false },
  { type: 'bytes', name: 'title', indexed: false }, { type: 'bytes32', name: 'metadataHash', indexed: false },
] } as const;
const expected: TaskCreationEvidence = { projectId: ZERO, payoutRaw: '1', title: 'Same', metadataHash: ZERO, bountyToken: ADDRESS_ZERO, bountyPayoutRaw: '0', requiresApplication: false };
const log = (id: string, evidence = expected, address = TM) => ({ address,
  topics: encodeEventTopics({ abi: [event], eventName: 'TaskCreated', args: { taskId: BigInt(id), projectId: evidence.projectId as `0x${string}` } }) as string[],
  data: encodeAbiParameters(event.inputs.filter(input => !input.indexed), [BigInt(evidence.payoutRaw.toString()), evidence.bountyToken, BigInt(evidence.bountyPayoutRaw.toString()), evidence.requiresApplication, stringToHex(evidence.title), evidence.metadataHash] as any),
});
const receipt = (logs: TaskReceiptInput['logs'], creations = [expected, { ...expected }]): TaskReceiptInput => ({ taskManagerAddress: TM, status: 1, logs, creations, creationLogScope: 'ordered-single-operation' });

describe('host-attested ordered single-operation creation receipts', () => {
  it('maps identical drafts by original log occurrence with exact large IDs', () => {
    expect(parseTaskCreatedReceipt(receipt([log('9007199254740994'), log('9007199254740993')]))).toEqual({ state: 'known', value: ['9007199254740994', '9007199254740993'] });
  });
  it('keeps unscoped identical drafts unknown even when the outer receipt succeeds', () => {
    const input = receipt([log('7'), log('8')]);
    delete input.creationLogScope;
    expect(parseTaskCreatedReceipt(input).state).toBe('unknown');
    expect(parseTaskCreatedReceipt({ ...input, logs: [log('7')] }).state).toBe('unknown');
  });
  it('preserves distinct expected payload ordering and repeated occurrence ordering', () => {
    const second = { ...expected, title: 'Distinct', metadataHash: HASH };
    for (const scope of [undefined, 'ordered-single-operation'] as const)
      expect(parseTaskCreatedReceipt({ ...receipt([log('7'), log('8', second)], [second, expected]), creationLogScope: scope })).toEqual({ state: 'known', value: ['8', '7'] });
    expect(parseTaskCreatedReceipt(receipt([log('7'), log('8', second), log('9')], [expected, expected, second]))).toEqual({ state: 'known', value: ['7', '9', '8'] });
  });
  it.each(['missing', 'extra-identical', 'extra-distinct', 'foreign-emitter', 'foreign-extra', 'duplicate-id', 'duplicate-id-distinct', 'malformed-data', 'extra-topics', 'trailing-data', 'corrupt-topic', 'wrong-payload', 'multiplicity'] as const)('rejects %s evidence', failure => {
    const second = { ...expected, title: 'Distinct' };
    const logs = [log('7'), log('8')];
    if (failure === 'missing') logs.pop();
    if (failure === 'extra-identical') logs.push(log('9'));
    if (failure === 'extra-distinct') logs.push(log('9', second));
    if (failure === 'foreign-emitter') logs[1] = log('8', expected, TOKEN);
    if (failure === 'foreign-extra') logs.push(log('9', expected, TOKEN));
    if (failure === 'duplicate-id') logs[1] = log('7');
    if (failure === 'duplicate-id-distinct') logs[1] = log('7', second);
    if (failure === 'malformed-data') logs[1].data = '0x';
    if (failure === 'extra-topics') logs[1].topics.push(ZERO);
    if (failure === 'trailing-data') logs[1].data += '00'.repeat(32);
    if (failure === 'corrupt-topic') logs[1].topics[0] = HASH;
    if (failure === 'wrong-payload') logs[1] = log('8', second);
    if (failure === 'multiplicity') logs.push(log('9', second));
    expect(parseTaskCreatedReceipt(receipt(logs, failure === 'multiplicity' ? [expected, second, second] : [expected, expected])).state).toBe('unknown');
  });
  it('rejects failed, unattested-invalid, empty or invalid expected evidence', () => {
    const input = receipt([log('7'), log('8')]);
    for (const status of [0, false, 2]) expect(parseTaskCreatedReceipt({ ...input, status }).state).toBe('unknown');
    expect(parseTaskCreatedReceipt({ ...input, creationLogScope: 'outer-receipt' } as any).state).toBe('unknown');
    expect(parseTaskCreatedReceipt({ ...input, creations: [] }).state).toBe('unknown');
    for (const metadataHash of ['', '0x01', 'bad']) expect(parseTaskCreatedReceipt({ ...input, creations: [{ ...expected, metadataHash }, expected] }).state).toBe('unknown');
  });
});

describe('lightweight browser import closures', () => {
  it.each(['accounts/constants', 'governance/validation', 'encoding/legacy-pointer'])('%s excludes full ethers/root/ABIs and optional executors', async leaf => {
    const result = await build({ entryPoints: [resolve(__dirname, `../src/${leaf}.ts`)], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true });
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs.filter(path => /(?:^|\/)ethers\/|\/abis\/|\/execute\/|\/viem\/|\/permissionless\/|src\/index/.test(path))).toEqual([]);
    expect(result.outputFiles[0].text.length).toBeGreaterThan(0);
  });
});
