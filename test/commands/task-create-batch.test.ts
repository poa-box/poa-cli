/**
 * pop task create-batch — v6 createTasksBatch vs legacy per-task loop.
 *
 * v6 orgs get a single all-or-nothing createTasksBatch(bytes32, CreateTaskInput[])
 * transaction whose tuple field order must match the ABI components (no pid
 * inside the tuple). Legacy orgs keep the per-task 7-arg createTask loop via
 * LEGACY_TM_FRAGMENTS, where --continue-on-error remains meaningful.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  detectTaskManagerFeatures: vi.fn(),
  pinJson: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/version', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/version')>();
  return { ...actual, detectTaskManagerFeatures: mocks.detectTaskManagerFeatures };
});
vi.mock('../../src/lib/ipfs', () => ({ pinJson: mocks.pinJson }));
vi.mock('../../src/lib/signer', () => ({ createSigner: mocks.createSigner }));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => modules[key],
}));
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
vi.mock('../../src/lib/output', () => {
  const makeSpinner = () => {
    const s: any = { text: '' };
    s.start = () => s;
    s.stop = () => s;
    s.succeed = () => s;
    s.fail = () => s;
    return s;
  };
  return {
    spinner: vi.fn(makeSpinner),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    json: vi.fn(),
    isJsonMode: vi.fn(() => false),
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import { createBatchHandler } from '../../src/commands/task/create-batch';
import { ipfsCidToBytes32 } from '../../src/lib/encoding';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';
import tmAbi from '../../src/abi/TaskManagerNew.json';

const TM_ADDR = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const ORG_ID = '0x' + 'ab'.repeat(32);
const PID = '0x' + '22'.repeat(32);
const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

/** 2100-01-01T00:00:00Z and 2100-01-02T00:00:00Z — fixed future fixtures */
const DEADLINE_TS = 4102444800;
const OVERRIDE_TS = 4102531200;

const V6_FEATURES = { deadlines: true, batchCreate: true, editMeta: true, folders: true, legacyCreate7: false };
const LEGACY_FEATURES = { deadlines: false, batchCreate: false, editMeta: false, folders: false, legacyCreate7: true };

const SIG_V6 = 'createTask(uint256,bytes,bytes32,bytes32,address,uint256,bool,uint48,uint32)';
const SIG_LEGACY = 'createTask(uint256,bytes,bytes32,bytes32,address,uint256,bool)';

/** CreateTaskInput component order straight from the synced ABI. */
const batchAbiEntry = (tmAbi as any[]).find(
  (e: any) => e.type === 'function' && e.name === 'createTasksBatch'
);
const COMPONENT_NAMES: string[] = batchAbiEntry.inputs[1].components.map((c: any) => c.name);

const ROWS = [
  { name: 'Alpha task', description: 'd1', payout: 1 },
  { name: 'Beta task', description: 'd2', payout: 2, deadline: String(OVERRIDE_TS), completionWindow: '24h' },
  { name: 'Gamma task', description: 'd3', payout: 3 },
];
const ROWS_NO_DEADLINE = [
  { name: 'Alpha task', description: 'd1', payout: 1 },
  { name: 'Beta task', description: 'd2', payout: 2 },
  { name: 'Gamma task', description: 'd3', payout: 3 },
];

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

function batchArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    project: PID,
    continueOnError: false,
    dryRun: false,
    ...overrides,
  };
}

describe('pop task create-batch — v6 batch vs legacy loop', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  function writeJsonl(rows: any[]): string {
    const file = path.join(tmpDir, 'tasks.jsonl');
    fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    return file;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-batch-'));
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);

    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      provider: {},
      address: WALLET,
      chainId: 11155111,
    });
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      taskManagerAddress: TM_ADDR,
      participationTokenAddress: '',
    });
    mocks.pinJson.mockResolvedValue(CID);
    // Payout-config query: org row present, no configured pricing. Every ROWS
    // fixture carries explicit payouts, so this only keeps the handler's
    // unconditional config fetch off the network.
    mocks.query.mockResolvedValue({ organization: { metadata: null } });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sanity: the synced ABI tuple order matches what the command encodes', () => {
    expect(COMPONENT_NAMES).toEqual([
      'payout',
      'title',
      'metadataHash',
      'bountyToken',
      'bountyPayout',
      'requiresApplication',
      'absoluteDeadline',
      'completionWindow',
    ]);
  });

  it('v6 org: 3-row JSONL → single createTasksBatch call with ABI-ordered tuples; per-row deadline beats batch default', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(V6_FEATURES);
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xbatch',
      explorerUrl: 'https://explorer/tx/0xbatch',
      logs: [10, 11, 12].map(id => ({ name: 'TaskCreated', args: { id: ethers.BigNumber.from(id) } })),
    });
    const file = writeJsonl(ROWS);

    await createBatchHandler.handler(batchArgv({ file, deadline: String(DEADLINE_TS), completionWindow: '48h' }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('createTasksBatch');
    expect(args).toHaveLength(2);
    const [pid, inputs] = args;
    expect(pid).toBe(PID);
    expect(inputs).toHaveLength(3);
    for (const tuple of inputs) {
      expect(tuple).toHaveLength(COMPONENT_NAMES.length);
    }

    // Positional fields per the ABI component order (no pid inside the tuple)
    expect(inputs[0][0].toString()).toBe(ethers.utils.parseUnits('1', 18).toString()); // payout
    expect(ethers.utils.toUtf8String(inputs[0][1])).toBe('Alpha task'); // title
    expect(inputs[0][2]).toBe(ipfsCidToBytes32(CID)); // metadataHash
    expect(inputs[0][3]).toBe(ethers.constants.AddressZero); // bountyToken
    expect(inputs[0][4]).toBe(0); // bountyPayout
    expect(inputs[0][5]).toBe(false); // requiresApplication

    // Rows 1 and 3 use the batch-wide defaults
    expect(inputs[0][6]).toBe(DEADLINE_TS);
    expect(inputs[0][7]).toBe(48 * 3600);
    expect(inputs[2][6]).toBe(DEADLINE_TS);
    expect(inputs[2][7]).toBe(48 * 3600);
    // Row 2's own deadline/completionWindow win over the batch default
    expect(inputs[1][6]).toBe(OVERRIDE_TS);
    expect(inputs[1][7]).toBe(24 * 3600);

    // The real v6 ABI encodes the [pid, tuples] shape as passed
    expect(() => contract.interface.encodeFunctionData('createTasksBatch', args)).not.toThrow();

    // One pin per task, task ids extracted from TaskCreated logs in order
    expect(mocks.pinJson).toHaveBeenCalledTimes(3);
    expect(output.success).toHaveBeenCalledWith(
      expect.stringContaining('3 tasks'),
      expect.objectContaining({ taskIds: '10, 11, 12', txHash: '0xbatch' })
    );
  });

  it('v6 org + --continue-on-error: warns it has no effect (batch is all-or-nothing) and still sends one tx', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(V6_FEATURES);
    mocks.executeTx.mockResolvedValue({ success: true, txHash: '0xb', explorerUrl: 'e', logs: [] });
    const file = writeJsonl(ROWS_NO_DEADLINE);

    await createBatchHandler.handler(batchArgv({ file, continueOnError: true }));

    expect(output.warn).toHaveBeenCalledWith(expect.stringContaining('no effect'));
    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(mocks.executeTx.mock.calls[0][1]).toBe('createTasksBatch');
  });

  it('legacy org: falls back to a per-task loop of 7-arg createTask calls on legacy fragments', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(LEGACY_FEATURES);
    let nextId = 100;
    mocks.executeTx.mockImplementation(async () => ({
      success: true,
      txHash: `0xtx${nextId}`,
      explorerUrl: 'e',
      logs: [{ name: 'TaskCreated', args: { id: ethers.BigNumber.from(nextId++) } }],
    }));
    const file = writeJsonl(ROWS_NO_DEADLINE);

    await createBatchHandler.handler(batchArgv({ file }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(3);
    for (const call of mocks.executeTx.mock.calls) {
      const [contract, method, args] = call;
      expect(method).toBe('createTask');
      expect(args).toHaveLength(7);
      expect(args[3]).toBe(PID); // pid stays a positional arg on the legacy path
      const fnSigs = Object.keys(contract.interface.functions);
      expect(fnSigs).toContain(SIG_LEGACY);
      expect(fnSigs).not.toContain(SIG_V6);
      expect(() => contract.interface.getEvent('TaskCreated')).not.toThrow();
    }
    // Per-task success lines with the extracted ids
    expect(output.success).toHaveBeenCalledTimes(3);
    expect(output.success).toHaveBeenCalledWith(
      expect.stringContaining('Alpha task'),
      expect.objectContaining({ taskId: '100' })
    );
  });

  it('row with deadline on a legacy org: exits EXIT.PRECONDITION before any pin or tx', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(LEGACY_FEATURES);
    const file = writeJsonl(ROWS); // row 2 carries deadline/completionWindow

    await expect(createBatchHandler.handler(batchArgv({ file }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('predates TaskManager v6'));
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(mocks.pinJson).not.toHaveBeenCalled();
  });

  it('batch-wide --deadline on a legacy org: same precondition failure', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(LEGACY_FEATURES);
    const file = writeJsonl(ROWS_NO_DEADLINE);

    await expect(
      createBatchHandler.handler(batchArgv({ file, deadline: String(DEADLINE_TS) }))
    ).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('per-row deadline parse errors exit before any network work', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(V6_FEATURES);
    const file = writeJsonl([
      { name: 'Alpha task', description: 'd1', payout: 1, deadline: '2020-01-01' },
    ]);

    await expect(createBatchHandler.handler(batchArgv({ file }))).rejects.toBeInstanceOf(ExitError);

    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('Line 1'));
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('in the past'));
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(mocks.pinJson).not.toHaveBeenCalled();
    expect(mocks.resolveOrgModules).not.toHaveBeenCalled();
  });

  it('file that parses to 0 valid tasks errors out client-side (EmptyBatch)', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(V6_FEATURES);
    const file = path.join(tmpDir, 'bad.jsonl');
    fs.writeFileSync(file, '{"name":"only-a-name"}\n');

    await expect(
      createBatchHandler.handler(batchArgv({ file, continueOnError: true }))
    ).rejects.toBeInstanceOf(ExitError);

    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('EmptyBatch'));
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(mocks.resolveOrgModules).not.toHaveBeenCalled();
  });

  it('v6 batch failure surfaces the error and exits with the tx-failed code', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(V6_FEATURES);
    mocks.executeTx.mockResolvedValue({ success: false, error: 'reverted: NotOrgExecutor', errorCode: 'TX_REVERTED' });
    const file = writeJsonl(ROWS_NO_DEADLINE);

    await expect(createBatchHandler.handler(batchArgv({ file }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(2);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('Batch creation failed'),
      expect.objectContaining({ errorCode: 'TX_REVERTED' })
    );
  });
});

/**
 * Row-level payout derivation vs the org payout config.
 *
 * Same convention as `pop task create`: a row may omit `payout` and be priced
 * from the org's config + its difficulty/estHours. When ANY row needs
 * derivation and the config cannot be read (query failed, or the org row is
 * not indexed yet), the whole batch must refuse BEFORE any pin or tx —
 * pricing from the hard-coded default would silently misprice every derived
 * row on-chain. An org row with null metadata is the legit default-pricing
 * case, and rows with explicit payouts never depend on the config at all.
 */
describe('pop task create-batch — payout derivation for rows omitting payout', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  /** Row 1 omits payout (needs derivation); row 2 is explicit. */
  const ROWS_MIXED = [
    { name: 'Alpha task', description: 'd1' },
    { name: 'Beta task', description: 'd2', payout: 2 },
  ];

  function writeJsonl(rows: any[]): string {
    const file = path.join(tmpDir, 'tasks.jsonl');
    fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    return file;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-batch-payout-'));
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);

    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      provider: {},
      address: WALLET,
      chainId: 11155111,
    });
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      taskManagerAddress: TM_ADDR,
      participationTokenAddress: '',
    });
    mocks.pinJson.mockResolvedValue(CID);
    mocks.detectTaskManagerFeatures.mockResolvedValue(V6_FEATURES);
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xbatch',
      explorerUrl: 'https://explorer/tx/0xbatch',
      logs: [10, 11].map(id => ({ name: 'TaskCreated', args: { id: ethers.BigNumber.from(id) } })),
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('row omits payout + config query rejects: refuses naming the row, BEFORE any pin or tx', async () => {
    mocks.query.mockRejectedValue(new Error('subgraph unreachable'));
    const file = writeJsonl(ROWS_MIXED);

    await expect(createBatchHandler.handler(batchArgv({ file }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('Could not read the org payout config'));
    // Names exactly the rows that needed derivation
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('Alpha task'));
    expect(output.error).not.toHaveBeenCalledWith(expect.stringContaining('Beta task'));
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(mocks.pinJson).not.toHaveBeenCalled();
  });

  it('row omits payout + query resolves {organization: null} (indexer lag): same refusal', async () => {
    mocks.query.mockResolvedValue({ organization: null });
    const file = writeJsonl(ROWS_MIXED);

    await expect(createBatchHandler.handler(batchArgv({ file }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('Could not read the org payout config'));
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(mocks.pinJson).not.toHaveBeenCalled();
  });

  it('row omits payout + org row present with null metadata: derives default pricing (medium/0h → 4)', async () => {
    mocks.query.mockResolvedValue({ organization: { metadata: null } });
    const file = writeJsonl(ROWS_MIXED);

    await createBatchHandler.handler(batchArgv({ file }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('createTasksBatch');
    const [, inputs] = args;
    // DIFFICULTY_CONFIG.medium: base 4 + 24 x 0h = 4 (frontend convention)
    expect(inputs[0][0].toString()).toBe(ethers.utils.parseUnits('4', 18).toString());
    // The explicit row keeps its own payout untouched
    expect(inputs[1][0].toString()).toBe(ethers.utils.parseUnits('2', 18).toString());
    expect(output.error).not.toHaveBeenCalled();
  });

  it('all rows explicit + config query rejects: proceeds — no row depends on org pricing', async () => {
    mocks.query.mockRejectedValue(new Error('subgraph unreachable'));
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xbatch',
      explorerUrl: 'https://explorer/tx/0xbatch',
      logs: [10, 11, 12].map(id => ({ name: 'TaskCreated', args: { id: ethers.BigNumber.from(id) } })),
    });
    const file = writeJsonl(ROWS_NO_DEADLINE); // payouts 1, 2, 3 — all explicit

    await createBatchHandler.handler(batchArgv({ file }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [, , args] = mocks.executeTx.mock.calls[0];
    const [, inputs] = args;
    expect(inputs.map((t: any[]) => t[0].toString())).toEqual([
      ethers.utils.parseUnits('1', 18).toString(),
      ethers.utils.parseUnits('2', 18).toString(),
      ethers.utils.parseUnits('3', 18).toString(),
    ]);
    expect(output.error).not.toHaveBeenCalled();
  });
});
