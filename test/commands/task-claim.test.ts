/**
 * pop task claim — v6 expired-claim takeover UX + fail-fast pre-flight.
 *
 * The command reads the authoritative task state through the TaskManager
 * lens BEFORE sending anything:
 *   - UNCLAIMED            → proceeds
 *   - CLAIMED, not expired → exits EXIT.PRECONDITION before executeTx,
 *                            naming the claimer + the countdown
 *   - CLAIMED, expired     → proceeds as a takeover (info line pre-tx,
 *                            TaskClaimExpired parsed post-success)
 *   - terminal statuses    → exits EXIT.PRECONDITION with the status name
 *   - --no-preflight       → skips the lens read entirely, straight to tx
 *
 * command.ts (getWriteContext/confirmWrite/finishWrite/withIdempotency) runs
 * REAL so the tests exercise the actual composition glue; the module seams
 * (tx, signer, resolve, preflight, task-lens.getTaskOnChain, idempotency,
 * output) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  getTaskOnChain: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
  checkTaskStatus: vi.fn(),
  checkIdempotencyCache: vi.fn(),
  recordIdempotentResult: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/signer', () => ({ createSigner: mocks.createSigner }));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => modules[key],
}));
vi.mock('../../src/lib/task-lens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/task-lens')>();
  return { ...actual, getTaskOnChain: mocks.getTaskOnChain };
});
vi.mock('../../src/lib/preflight', () => ({
  runPreflight: mocks.runPreflight,
  checkGasBalance: mocks.checkGasBalance,
  checkTaskStatus: mocks.checkTaskStatus,
}));
vi.mock('../../src/lib/idempotency', () => ({
  argvToIdempotencyString: vi.fn(() => 'idem-key'),
  checkIdempotencyCache: mocks.checkIdempotencyCache,
  recordIdempotentResult: mocks.recordIdempotentResult,
  resolveTtlSeconds: vi.fn(() => 900),
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
    keyValueBlock: vi.fn(),
    isJsonMode: vi.fn(() => false),
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import { claimHandler } from '../../src/commands/task/claim';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { formatDeadline } from '../../src/lib/encoding';
import { EXIT } from '../../src/lib/exit-codes';
import type { TaskOnChain } from '../../src/lib/task-lens';
import * as output from '../../src/lib/output';

const TM_ADDR = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const ORG_ID = '0x' + 'ab'.repeat(32);
const PID = '0x' + '22'.repeat(32);

const NOW = Math.floor(Date.now() / 1000);
const FUTURE_DEADLINE = NOW + 7 * 86400;
const PAST_DEADLINE = NOW - 3600;

function taskFixture(overrides: Partial<TaskOnChain> = {}): TaskOnChain {
  return {
    projectId: PID,
    payout: ethers.utils.parseUnits('5', 18),
    claimer: ethers.constants.AddressZero,
    bountyPayout: ethers.BigNumber.from(0),
    requiresApplication: false,
    status: 0, // UNCLAIMED
    bountyToken: ethers.constants.AddressZero,
    absoluteDeadline: 0,
    completionWindow: 0,
    claimDeadline: 0,
    ...overrides,
  };
}

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
    task: '12',
    yes: false,
    preflight: true,
    noIdempotency: false,
    dryRun: false,
    ...overrides,
  };
}

describe('pop task claim — takeover-aware pre-flight + receipts', () => {
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
      provider: {},
      address: WALLET,
      chainId: 11155111,
    });
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      taskManagerAddress: TM_ADDR,
      participationTokenAddress: '',
    });
    mocks.getTaskOnChain.mockResolvedValue(taskFixture());
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.checkGasBalance.mockReturnValue({ label: 'gas balance' });
    mocks.checkIdempotencyCache.mockReturnValue(null);
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xabc',
      explorerUrl: 'https://explorer/tx/0xabc',
      logs: [{ name: 'TaskClaimed', args: { id: ethers.BigNumber.from(12), claimer: WALLET } }],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    _setStreamsForTest();
  });

  it('UNCLAIMED task: proceeds to claimTask and echoes the claim deadline from the receipt', async () => {
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xabc',
      explorerUrl: 'https://explorer/tx/0xabc',
      logs: [
        { name: 'TaskClaimed', args: { id: ethers.BigNumber.from(12), claimer: WALLET } },
        { name: 'TaskClaimDeadlineSet', args: { id: ethers.BigNumber.from(12), claimDeadline: ethers.BigNumber.from(FUTURE_DEADLINE) } },
      ],
    });

    await claimHandler.handler(baseArgv());

    expect(mocks.getTaskOnChain).toHaveBeenCalledTimes(1);
    expect(mocks.runPreflight).toHaveBeenCalledWith(expect.anything(), expect.any(Array), { skip: false });

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args, opts] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('claimTask');
    expect(args).toEqual(['12']);
    expect(opts).toEqual({ dryRun: false });
    // Real TaskManagerNew ABI wired through createWriteContract
    expect(() => contract.interface.getFunction('claimTask')).not.toThrow();

    // Success keeps the legacy message + fields (additive only) and gains
    // the claim-deadline echo from TaskClaimDeadlineSet
    expect(output.success).toHaveBeenCalledWith('Task 12 claimed', expect.objectContaining({
      taskId: '12',
      txHash: '0xabc',
      explorerUrl: 'https://explorer/tx/0xabc',
      claimDeadline: FUTURE_DEADLINE,
      submitBy: formatDeadline(FUTURE_DEADLINE),
    }));
    expect(output.info).toHaveBeenCalledWith(expect.stringContaining('Submit before'));

    expect(mocks.recordIdempotentResult).toHaveBeenCalledWith(
      ORG_ID, 'task.claim', 'idem-key',
      expect.objectContaining({ taskId: '12', txHash: '0xabc' }),
      900,
    );
  });

  it('CLAIMED + unexpired: exits EXIT.PRECONDITION BEFORE executeTx, naming the claimer and the countdown', async () => {
    mocks.getTaskOnChain.mockResolvedValue(taskFixture({
      status: 1, // CLAIMED
      claimer: OTHER,
      claimDeadline: NOW + 7200,
    }));

    await expect(claimHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    const [message] = (output.error as any).mock.calls[0];
    expect(message).toContain(OTHER); // current claimer named
    expect(message).toContain('left'); // formatCountdown time remaining
    expect(message).toContain('already claimed');
  });

  it('CLAIMED + expired: proceeds as takeover with the info line, and parses TaskClaimExpired post-success', async () => {
    mocks.getTaskOnChain.mockResolvedValue(taskFixture({
      status: 1,
      claimer: OTHER,
      claimDeadline: PAST_DEADLINE,
    }));
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xdef',
      explorerUrl: 'https://explorer/tx/0xdef',
      logs: [
        { name: 'TaskClaimExpired', args: { id: ethers.BigNumber.from(12), previousClaimer: OTHER, newClaimer: WALLET } },
        { name: 'TaskClaimed', args: { id: ethers.BigNumber.from(12), claimer: WALLET } },
        { name: 'TaskClaimDeadlineSet', args: { id: ethers.BigNumber.from(12), claimDeadline: ethers.BigNumber.from(FUTURE_DEADLINE) } },
      ],
    });

    await claimHandler.handler(baseArgv());

    // Pre-tx takeover notice
    expect(output.info).toHaveBeenCalledWith(`Taking over expired claim from ${OTHER}`);
    expect(mocks.executeTx).toHaveBeenCalledTimes(1);

    // Post-success: TaskClaimExpired surfaces as an additive success field
    // plus a human confirmation line
    expect(output.success).toHaveBeenCalledWith('Task 12 claimed', expect.objectContaining({
      taskId: '12',
      takenOverFrom: OTHER,
      claimDeadline: FUTURE_DEADLINE,
    }));
    expect(output.info).toHaveBeenCalledWith(expect.stringContaining('Takeover confirmed'));
  });

  it('SUBMITTED/COMPLETED/CANCELLED: fails fast with the status name', async () => {
    mocks.getTaskOnChain.mockResolvedValue(taskFixture({ status: 3, claimer: OTHER })); // COMPLETED

    await expect(claimHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('COMPLETED'),
      expect.anything(),
    );
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('UNCLAIMED but requiresApplication: fails fast pointing at pop task apply', async () => {
    mocks.getTaskOnChain.mockResolvedValue(taskFixture({ requiresApplication: true }));

    await expect(claimHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('requires an application'),
      expect.objectContaining({ suggestion: expect.stringContaining('pop task apply') }),
    );
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('--no-preflight: skips the lens read entirely and goes straight to the tx', async () => {
    await claimHandler.handler(baseArgv({ preflight: false }));

    expect(mocks.getTaskOnChain).not.toHaveBeenCalled();
    expect(mocks.runPreflight).toHaveBeenCalledWith(expect.anything(), expect.any(Array), { skip: true });
    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(output.success).toHaveBeenCalledWith('Task 12 claimed', expect.objectContaining({ taskId: '12' }));
  });

  it('idempotency cache hit: returns the prior result without re-sending', async () => {
    mocks.checkIdempotencyCache.mockReturnValue({ taskId: '12', txHash: '0xold' });

    await claimHandler.handler(baseArgv());

    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(mocks.recordIdempotentResult).not.toHaveBeenCalled();
    expect(output.success).toHaveBeenCalledWith(
      expect.stringContaining('idempotency cache hit'),
      expect.objectContaining({ taskId: '12', txHash: '0xold', cached: true }),
    );
  });

  it('--dry-run: simulates without touching the idempotency cache', async () => {
    mocks.executeTx.mockResolvedValue({
      success: true,
      dryRun: true,
      gasEstimate: '100000',
      method: 'claimTask',
      to: TM_ADDR,
    });

    await claimHandler.handler(baseArgv({ dryRun: true }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(mocks.executeTx.mock.calls[0][3]).toEqual({ dryRun: true });
    expect(mocks.checkIdempotencyCache).not.toHaveBeenCalled();
    expect(mocks.recordIdempotentResult).not.toHaveBeenCalled();
    expect(output.success).toHaveBeenCalledWith(
      expect.stringContaining('DRY RUN'),
      expect.objectContaining({ method: 'claimTask' }),
    );
  });
});
