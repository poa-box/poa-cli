/**
 * pop task create — v6 vs legacy TaskManager signature selection.
 *
 * The removed 7-arg createTask(uint256,bytes,bytes32,bytes32,address,uint256,bool)
 * hard-reverts on v6 orgs, so the command feature-detects and picks:
 *   - v6 (features.deadlines): 9-arg createTask with absoluteDeadline + completionWindow
 *   - legacy: 7-arg createTask on a contract built from LEGACY_TM_FRAGMENTS
 *
 * executeTx is mocked; contracts are real ethers.Contract instances so the
 * tests verify the actual ABI/fragment wiring (including that the legacy
 * fragment set can still parse TaskCreated for task-id extraction).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  detectTaskManagerFeatures: vi.fn(),
  pinJson: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  query: vi.fn(),
  checkIdempotencyCache: vi.fn(),
  recordIdempotentResult: vi.fn(),
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
vi.mock('../../src/lib/idempotency', () => ({
  argvToIdempotencyString: vi.fn(() => 'idem-key'),
  checkIdempotencyCache: mocks.checkIdempotencyCache,
  recordIdempotentResult: mocks.recordIdempotentResult,
}));
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
import { createHandler } from '../../src/commands/task/create';
import { ipfsCidToBytes32, formatDeadline } from '../../src/lib/encoding';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const TM_ADDR = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const ORG_ID = '0x' + 'ab'.repeat(32);
const PID = '0x' + '22'.repeat(32);
const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

/** 2100-01-01T00:00:00Z — fixed unix-seconds fixture, comfortably future */
const DEADLINE_TS = 4102444800;

const V6_FEATURES = { deadlines: true, batchCreate: true, editMeta: true, folders: true, legacyCreate7: false };
const LEGACY_FEATURES = { deadlines: false, batchCreate: false, editMeta: false, folders: false, legacyCreate7: true };

const SIG_V6 = 'createTask(uint256,bytes,bytes32,bytes32,address,uint256,bool,uint48,uint32)';
const SIG_LEGACY = 'createTask(uint256,bytes,bytes32,bytes32,address,uint256,bool)';

/** Thrown by the process.exit spy so handlers stop like the real thing. */
class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    project: PID,
    name: 'Ship the relayer harness',
    description: 'Build it',
    payout: 5,
    difficulty: 'medium',
    estHours: 0,
    location: '',
    requiresApplication: false,
    force: true,
    noIdempotency: false,
    dryRun: false,
    ...overrides,
  };
}

describe('pop task create — v6/legacy signature selection', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.checkIdempotencyCache.mockReturnValue(null);
    mocks.query.mockResolvedValue({ organization: { taskManager: { projects: [] } } });
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xhash',
      explorerUrl: 'https://explorer/tx/0xhash',
      logs: [{ name: 'TaskCreated', args: { id: ethers.BigNumber.from(42) } }],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('v6 org: sends the 9-arg createTask with parsed deadline values', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(V6_FEATURES);
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xhash',
      explorerUrl: 'https://explorer/tx/0xhash',
      logs: [
        { name: 'TaskCreated', args: { id: ethers.BigNumber.from(42) } },
        {
          name: 'TaskDeadlinesSet',
          args: {
            id: ethers.BigNumber.from(42),
            absoluteDeadline: ethers.BigNumber.from(DEADLINE_TS),
            completionWindow: 172800,
          },
        },
      ],
    });

    await createHandler.handler(baseArgv({ deadline: String(DEADLINE_TS), completionWindow: '48h' }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('createTask');
    expect(args).toHaveLength(9);
    expect(args[0].toString()).toBe(ethers.utils.parseUnits('5', 18).toString());
    expect(args[2]).toBe(ipfsCidToBytes32(CID));
    expect(args[3]).toBe(PID);
    expect(args[4]).toBe(ethers.constants.AddressZero);
    expect(args[6]).toBe(false);
    expect(args[7]).toBe(DEADLINE_TS);
    expect(args[8]).toBe(48 * 3600);

    // Contract was built from the real v6 ABI and the args encode against it
    expect(contract.interface.functions[SIG_V6]).toBeDefined();
    expect(() => contract.interface.encodeFunctionData('createTask', args)).not.toThrow();

    // Metadata pin preserved exactly (frontend key order)
    expect(mocks.pinJson).toHaveBeenCalledWith(JSON.stringify({
      name: 'Ship the relayer harness',
      description: 'Build it',
      location: '',
      difficulty: 'medium',
      estHours: 0,
      submission: '',
    }));

    // Success fields surface the recorded deadlines from TaskDeadlinesSet
    expect(output.success).toHaveBeenCalledWith('Task created', expect.objectContaining({
      taskId: '42',
      ipfsCid: CID,
      deadline: formatDeadline(DEADLINE_TS),
      completionWindowSeconds: 172800,
    }));
    expect(mocks.recordIdempotentResult).toHaveBeenCalled();
  });

  it('v6 org without deadline flags: 9-arg createTask with 0/0 defaults, no deadline fields in output', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(V6_FEATURES);

    await createHandler.handler(baseArgv());

    const [, , args] = mocks.executeTx.mock.calls[0];
    expect(args).toHaveLength(9);
    expect(args[7]).toBe(0);
    expect(args[8]).toBe(0);
    const fields = (output.success as any).mock.calls[0][1];
    expect(fields.taskId).toBe('42');
    expect(fields.deadline).toBeUndefined();
    expect(fields.completionWindowSeconds).toBeUndefined();
  });

  it('legacy org without flags: 7-arg createTask on a LEGACY_TM_FRAGMENTS contract that still parses TaskCreated', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(LEGACY_FEATURES);

    await createHandler.handler(baseArgv());

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('createTask');
    expect(args).toHaveLength(7);
    expect(args[6]).toBe(false);

    const fnSigs = Object.keys(contract.interface.functions);
    expect(fnSigs).toContain(SIG_LEGACY);
    expect(fnSigs).not.toContain(SIG_V6);
    // Legacy fragments must include the TaskCreated event so executeTx's
    // receipt log parsing can still extract the created task id
    expect(() => contract.interface.getEvent('TaskCreated')).not.toThrow();
    expect(() => contract.interface.encodeFunctionData('createTask', args)).not.toThrow();

    expect(output.success).toHaveBeenCalledWith('Task created', expect.objectContaining({ taskId: '42' }));
  });

  it('legacy org + --deadline: exits EXIT.PRECONDITION with featureUnavailable text before any pin/tx', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(LEGACY_FEATURES);

    await expect(createHandler.handler(baseArgv({ deadline: '7d' }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('task deadlines is unavailable'));
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('predates TaskManager v6'));
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('Re-run without --deadline/--completion-window'));
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(mocks.pinJson).not.toHaveBeenCalled();
  });

  it('legacy org + --completion-window only: same precondition failure', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(LEGACY_FEATURES);

    await expect(createHandler.handler(baseArgv({ completionWindow: '48h' }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('deadline parse errors (past date) exit before any network work or tx', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(V6_FEATURES);

    await expect(createHandler.handler(baseArgv({ deadline: '2020-01-01' }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy).toHaveBeenCalledWith(1);
    // The CliError-aware catch (v6 consistency migration) now surfaces the
    // parse error's suggestion as a second output.error argument (additive).
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('in the past'),
      expect.objectContaining({ suggestion: expect.stringContaining('future') }),
    );
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(mocks.pinJson).not.toHaveBeenCalled();
    expect(mocks.detectTaskManagerFeatures).not.toHaveBeenCalled();
    expect(mocks.resolveOrgModules).not.toHaveBeenCalled();
  });

  it('unparseable completion window exits before any tx', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(V6_FEATURES);

    await expect(createHandler.handler(baseArgv({ completionWindow: 'soonish' }))).rejects.toBeInstanceOf(ExitError);

    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('Unparseable duration'),
      expect.anything(), // suggestion payload from the CliError-aware catch
    );
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('--dry-run passes through on both the v6 and legacy paths', async () => {
    mocks.executeTx.mockResolvedValue({
      success: true,
      dryRun: true,
      gasEstimate: '100000',
      method: 'createTask',
      to: TM_ADDR,
    });

    mocks.detectTaskManagerFeatures.mockResolvedValueOnce(V6_FEATURES);
    await createHandler.handler(baseArgv({ dryRun: true, deadline: String(DEADLINE_TS) }));

    mocks.detectTaskManagerFeatures.mockResolvedValueOnce(LEGACY_FEATURES);
    await createHandler.handler(baseArgv({ dryRun: true }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(2);
    expect(mocks.executeTx.mock.calls[0][2]).toHaveLength(9);
    expect(mocks.executeTx.mock.calls[0][3]).toEqual({ dryRun: true });
    expect(mocks.executeTx.mock.calls[1][2]).toHaveLength(7);
    expect(mocks.executeTx.mock.calls[1][3]).toEqual({ dryRun: true });
  });
});

/**
 * Payout derivation vs the org payout config (FETCH_ORG_PAYOUT_CONFIG).
 *
 * The payout goes on-chain, so when --payout is omitted the command must
 * DERIVE it from the org's convention — and REFUSE when that convention
 * cannot be read (subgraph down, or org row not yet indexed). Deriving from
 * the hard-coded default in those cases would silently misprice the task.
 * An org row with NULL metadata is different: that org never configured
 * pricing, and default pricing is correct. An explicit --payout never
 * depends on the config, so a failed fetch must not block it.
 *
 * argv uses force:true + a 0x…(66) project ID, so the ONLY subgraph query
 * the handler issues is the payout-config one — mocks.query targets it
 * unambiguously.
 */
describe('pop task create — payout derivation vs org payout config', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.checkIdempotencyCache.mockReturnValue(null);
    mocks.detectTaskManagerFeatures.mockResolvedValue(V6_FEATURES);
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xhash',
      explorerUrl: 'https://explorer/tx/0xhash',
      logs: [{ name: 'TaskCreated', args: { id: ethers.BigNumber.from(42) } }],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('--payout omitted + config query rejects: refuses (EXIT.PRECONDITION) BEFORE any pin or tx', async () => {
    mocks.query.mockRejectedValue(new Error('subgraph unreachable'));

    await expect(createHandler.handler(baseArgv({ payout: undefined }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('payout cannot be derived safely'),
      expect.objectContaining({ suggestion: expect.stringContaining('--payout') }),
    );
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(mocks.pinJson).not.toHaveBeenCalled();
    expect(mocks.recordIdempotentResult).not.toHaveBeenCalled();
  });

  it('--payout omitted + query resolves {organization: null} (indexer lag): same refusal', async () => {
    // A successful query with NO org row is indistinguishable from "no pricing
    // configured" only by accident — it must be treated like a failed fetch.
    mocks.query.mockResolvedValue({ organization: null });

    await expect(createHandler.handler(baseArgv({ payout: undefined }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('payout cannot be derived safely'),
      expect.objectContaining({ suggestion: expect.stringContaining('--payout') }),
    );
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(mocks.pinJson).not.toHaveBeenCalled();
  });

  it('--payout omitted + org row present with null metadata: derives default pricing (medium/0h → 4)', async () => {
    // A real org that never configured pricing — the LEGIT default case.
    mocks.query.mockResolvedValue({ organization: { metadata: null, participationToken: null } });

    await createHandler.handler(baseArgv({ payout: undefined }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('createTask');
    // DIFFICULTY_CONFIG.medium: base 4 + 24 x 0h = 4 (frontend convention)
    expect(args[0].toString()).toBe(ethers.utils.parseUnits('4', 18).toString());
    expect(output.error).not.toHaveBeenCalled();
    expect(output.success).toHaveBeenCalledWith('Task created', expect.objectContaining({ taskId: '42' }));
  });

  it('explicit --payout + config query rejects: proceeds — the config is advisory there', async () => {
    mocks.query.mockRejectedValue(new Error('subgraph unreachable'));

    await createHandler.handler(baseArgv({ payout: 5 }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [, , args] = mocks.executeTx.mock.calls[0];
    expect(args[0].toString()).toBe(ethers.utils.parseUnits('5', 18).toString());
    expect(output.error).not.toHaveBeenCalled();
    expect(output.success).toHaveBeenCalledWith('Task created', expect.objectContaining({ taskId: '42' }));
  });
});
