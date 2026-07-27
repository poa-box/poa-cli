/**
 * pop project delete — destructive gate + lens exists-preflight.
 *
 * deleteProject(bytes32) is irreversible on-chain (verified against
 * contracts origin/main src/TaskManager.sol: _requireCreator + NotFound),
 * so the command must:
 *   - refuse in non-TTY sessions without an explicit --yes (AbortedError,
 *     exit EXIT.ABORTED) BEFORE any transaction
 *   - pre-flight existence via the TaskManager lens PROJECT_INFO variant
 *     ((uint128 cap, uint128 spent, bool exists)) so bad IDs fail fast
 *   - resolve --project as bytes32 hex, decimal counter (pids are
 *     bytes32(uint256(nextProjectId++)) — verified _createProjectCore), or
 *     title via the subgraph
 *
 * command.ts (getWriteContext/confirmWrite/finishWrite) runs REAL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  query: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/signer', () => ({ createSigner: mocks.createSigner }));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => {
    if (!modules?.[key]) throw new Error(`missing module ${key}`);
    return modules[key];
  },
}));
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
vi.mock('../../src/lib/preflight', () => ({
  runPreflight: mocks.runPreflight,
  checkGasBalance: mocks.checkGasBalance,
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
    debug: vi.fn(),
    json: vi.fn(),
    table: vi.fn(),
    keyValueBlock: vi.fn(),
    isJsonMode: vi.fn(() => false),
    isQuietMode: vi.fn(() => false),
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import { deleteHandler, checkProjectExists } from '../../src/commands/project/delete';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { STORAGE_KEYS, encodeLensCall } from '../../src/lib/task-lens';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const TM_ADDR = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const ORG_ID = '0x' + 'ab'.repeat(32);
const PID = '0x' + '22'.repeat(32);
const PID_3 = ethers.utils.hexZeroPad('0x03', 32);

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

/** Raw getLensData return for PROJECT_INFO: bytes(abi.encode(cap, spent, exists)). */
function lensProjectInfoReturn(cap: number, spent: number, exists: boolean): string {
  const payload = ethers.utils.defaultAbiCoder.encode(
    ['uint128', 'uint128', 'bool'],
    [cap, spent, exists]
  );
  return ethers.utils.defaultAbiCoder.encode(['bytes'], [payload]);
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    project: PID,
    yes: false,
    preflight: true,
    dryRun: false,
    ...overrides,
  };
}

describe('pop project delete — destructive gate + exists pre-flight', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _clearWriteContextCacheForTest();
    _setStreamsForTest(undefined, undefined, false); // deterministic non-TTY

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);

    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      provider: {}, // best-effort cap echo degrades (no .call) — preflight is mocked
      address: WALLET,
      chainId: 11155111,
    });
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      taskManagerAddress: TM_ADDR,
    });
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.checkGasBalance.mockReturnValue({ label: 'gas balance' });
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xabc',
      explorerUrl: 'https://explorer/tx/0xabc',
      logs: [],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    _setStreamsForTest();
  });

  it('non-TTY without --yes: REFUSES with EXIT.ABORTED before any tx (destructive gate)', async () => {
    await expect(deleteHandler.handler(baseArgv({ yes: false }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.ABORTED);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('destructive'),
      expect.anything(),
    );
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('--yes: proceeds to deleteProject with the bytes32 pid', async () => {
    await deleteHandler.handler(baseArgv({ yes: true }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args, opts] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('deleteProject');
    expect(args).toEqual([PID]);
    expect(opts).toEqual({ dryRun: false });
    expect(() => contract.interface.getFunction('deleteProject')).not.toThrow();

    expect(output.success).toHaveBeenCalledWith('Project deleted', expect.objectContaining({
      projectId: PID,
      txHash: '0xabc',
      explorerUrl: 'https://explorer/tx/0xabc',
    }));
  });

  it('runs the gas + project-exists pre-flight before the tx (and skips it with --no-preflight)', async () => {
    await deleteHandler.handler(baseArgv({ yes: true }));
    let [, checks, opts] = mocks.runPreflight.mock.calls[0];
    expect(checks).toHaveLength(2); // gas balance + lens PROJECT_INFO existence
    expect(opts).toEqual({ skip: false });

    vi.clearAllMocks();
    mocks.executeTx.mockResolvedValue({ success: true, txHash: '0xabc', logs: [] });
    await deleteHandler.handler(baseArgv({ yes: true, preflight: false }));
    [, , opts] = mocks.runPreflight.mock.calls[0];
    expect(opts).toEqual({ skip: true });
  });

  it('decimal --project maps to bytes32(uint) (on-chain pids are counters)', async () => {
    await deleteHandler.handler(baseArgv({ yes: true, project: '3' }));

    const [, , args] = mocks.executeTx.mock.calls[0];
    expect(args).toEqual([PID_3]);
    expect(mocks.query).not.toHaveBeenCalled(); // no subgraph needed for id forms
  });

  it('title --project resolves through the subgraph to the composite id\'s pid', async () => {
    mocks.query.mockResolvedValue({
      organization: {
        taskManager: {
          projects: [
            { id: `${TM_ADDR}-${PID}`, title: 'Old Initiative' },
            { id: `${TM_ADDR}-${PID_3}`, title: 'Other' },
          ],
        },
      },
    });

    await deleteHandler.handler(baseArgv({ yes: true, project: 'old initiative' }));

    const [, , args] = mocks.executeTx.mock.calls[0];
    expect(args).toEqual([PID]);
  });

  it('unknown title fails with usage error naming the available projects, before any tx', async () => {
    mocks.query.mockResolvedValue({
      organization: { taskManager: { projects: [{ id: `${TM_ADDR}-${PID}`, title: 'Real Project' }] } },
    });

    await expect(
      deleteHandler.handler(baseArgv({ yes: true, project: 'Ghost Project' }))
    ).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
      expect.objectContaining({ suggestion: expect.stringContaining('Real Project') }),
    );
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  describe('checkProjectExists — lens PROJECT_INFO interpretation', () => {
    it('encodes getLensData(PROJECT_INFO, abi.encode(pid)) against the TaskManager', () => {
      const check = checkProjectExists(TM_ADDR, PID);
      expect(check.call?.to).toBe(TM_ADDR);
      expect(check.call?.data).toBe(
        encodeLensCall(STORAGE_KEYS.PROJECT_INFO, ethers.utils.defaultAbiCoder.encode(['bytes32'], [PID]))
      );
    });

    it('exists=true → ok', () => {
      const check = checkProjectExists(TM_ADDR, PID);
      expect(check.interpret!(lensProjectInfoReturn(500, 10, true), true)).toEqual({ ok: true });
    });

    it('exists=false → fail with a pop project list suggestion', () => {
      const check = checkProjectExists(TM_ADDR, PID);
      const result = check.interpret!(lensProjectInfoReturn(0, 0, false), true);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('does not exist');
      expect(result.suggestion).toContain('pop project list');
    });

    it('failed call / empty returndata → fail (could not read)', () => {
      const check = checkProjectExists(TM_ADDR, PID);
      expect(check.interpret!('0x', true).ok).toBe(false);
      expect(check.interpret!(lensProjectInfoReturn(1, 0, true), false).ok).toBe(false);
    });
  });
});
