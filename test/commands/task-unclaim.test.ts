/**
 * pop task unclaim — v7 two-route release gate + receipt parsing.
 *
 * The permission matrix is the whole point of the command, so it is driven
 * end-to-end through the handler as well as unit-tested on the pure gate:
 *   - claimer, ANY deadline state (future / expired / none) → proceeds
 *   - third party + EXPIRED claim                           → proceeds, but
 *                            destructive: non-TTY without --yes exits ABORTED
 *   - third party + live claim                              → EXIT.PRECONDITION
 *   - third party + deadline-less claim                     → EXIT.PRECONDITION
 *                            pointing at `pop task update --deadline`, since
 *                            such a claim can never expire on its own
 *   - anything not CLAIMED                                  → EXIT.PRECONDITION
 *
 * Receipts differ from claim's: TaskUnclaimed names previousClaimer/caller and
 * TaskClaimDeadlineSet(id, 0) only *clears* a window — there is no claimDeadline
 * to echo, and TaskClaimExpired is never emitted, so copying claimReceiptFields'
 * assertions here would pass against the wrong parser.
 *
 * command.ts (getWriteContext/confirmWrite/finishWrite/withIdempotency) and
 * contracts.ts run REAL so the tests exercise the actual composition glue; the
 * module seams (tx, signer, resolve, preflight, task-lens.getTaskOnChain,
 * version.detectTaskManagerFeatures, idempotency, output) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  getTaskOnChain: vi.fn(),
  detectTaskManagerFeatures: vi.fn(),
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
vi.mock('../../src/lib/version', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/version')>();
  return { ...actual, detectTaskManagerFeatures: mocks.detectTaskManagerFeatures };
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
import {
  unclaimHandler,
  gateUnclaimableTask,
  unclaimReceiptFields,
} from '../../src/commands/task/unclaim';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { EXIT } from '../../src/lib/exit-codes';
import { PreconditionError } from '../../src/lib/errors';
import { TASK_STATUS, type TaskOnChain } from '../../src/lib/task-lens';
import type { TxResult } from '../../src/lib/tx';
import * as output from '../../src/lib/output';

const TM_ADDR = '0x1111111111111111111111111111111111111111';
/** The signer. Checksummed on purpose: the gate and the receipt parser both
 *  compare addresses case-insensitively, and lowercase-only constants would
 *  never exercise that. */
const WALLET = ethers.utils.getAddress('0xa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
const OTHER = ethers.utils.getAddress('0xb1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0');
const THIRD = ethers.utils.getAddress('0xc1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0');
const ORG_ID = '0x' + 'ab'.repeat(32);
const PID = '0x' + '22'.repeat(32);

const GNOSIS = 100;
const ARBITRUM = 42161;

const NOW = Math.floor(Date.now() / 1000);
const FUTURE_DEADLINE = NOW + 7 * 86400;
const PAST_DEADLINE = NOW - 3600;

const ALL_FEATURES = {
  deadlines: true,
  batchCreate: true,
  editMeta: true,
  folders: true,
  legacyCreate7: false,
  unclaim: true,
};

function taskFixture(overrides: Partial<TaskOnChain> = {}): TaskOnChain {
  return {
    projectId: PID,
    payout: ethers.utils.parseUnits('5', 18),
    claimer: WALLET,
    bountyPayout: ethers.BigNumber.from(0),
    requiresApplication: false,
    status: TASK_STATUS.CLAIMED,
    bountyToken: ethers.constants.AddressZero,
    absoluteDeadline: 0,
    completionWindow: 0,
    claimDeadline: FUTURE_DEADLINE,
    ...overrides,
  };
}

function unclaimedLog(previousClaimer: string, caller: string) {
  return { name: 'TaskUnclaimed', args: { id: ethers.BigNumber.from(12), previousClaimer, caller } };
}

function deadlineSetLog(value: number) {
  return {
    name: 'TaskClaimDeadlineSet',
    args: { id: ethers.BigNumber.from(12), claimDeadline: ethers.BigNumber.from(value) },
  };
}

function txResult(overrides: Partial<TxResult> = {}): any {
  return {
    success: true,
    txHash: '0xabc',
    explorerUrl: 'https://explorer/tx/0xabc',
    logs: [unclaimedLog(WALLET, WALLET)],
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

/** The success fields object finishWrite handed to output.success. */
function successFields(): Record<string, any> {
  return (output.success as any).mock.calls[0][1];
}

describe('pop task unclaim — release gate + receipts', () => {
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
      chainId: GNOSIS,
    });
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      taskManagerAddress: TM_ADDR,
      participationTokenAddress: '',
    });
    mocks.getTaskOnChain.mockResolvedValue(taskFixture());
    mocks.detectTaskManagerFeatures.mockResolvedValue({ ...ALL_FEATURES });
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.checkGasBalance.mockReturnValue({ label: 'gas balance' });
    mocks.checkIdempotencyCache.mockReturnValue(null);
    mocks.executeTx.mockResolvedValue(txResult());
  });

  afterEach(() => {
    exitSpy.mockRestore();
    _setStreamsForTest();
  });

  // ── Permission matrix ───────────────────────────────────────────────────

  it('self-release of a LIVE claim: proceeds — the claimer needs no deadline and no mask', async () => {
    await unclaimHandler.handler(baseArgv());

    expect(mocks.getTaskOnChain).toHaveBeenCalledTimes(1);
    expect(mocks.runPreflight).toHaveBeenCalledWith(expect.anything(), expect.any(Array), { skip: false });

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args, opts] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('unclaimTask');
    expect(args).toEqual(['12']);
    expect(opts).toEqual({ dryRun: false });
    // Real TaskManagerNew ABI wired through createWriteContract
    expect(() => contract.interface.getFunction('unclaimTask')).not.toThrow();

    expect(output.success).toHaveBeenCalledWith(
      'Task 12 released back to the pool',
      expect.objectContaining({ taskId: '12', txHash: '0xabc', selfRelease: true }),
    );
    // No force-release notice on a self-release
    expect(output.info).not.toHaveBeenCalledWith(expect.stringContaining('Force-releas'));
  });

  it('self-release of an EXPIRED claim: needs --yes, because it is takeover-able mid-flight', async () => {
    // An already-expired claim can be taken over by anyone at any moment, with no
    // time pressure on the other party. `unclaimTask(uint256)` takes only an id —
    // the expected claimer CANNOT be bound on-chain — so if a takeover wins the
    // race, our transaction lands as a third-party FORCE-release after being
    // confirmed as a harmless self-release. That case takes destructive consent.
    mocks.getTaskOnChain.mockResolvedValue(taskFixture({ claimDeadline: PAST_DEADLINE }));

    await expect(unclaimHandler.handler(baseArgv())).rejects.toThrow();

    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(EXIT.ABORTED);
  });

  it('self-release of an EXPIRED claim: proceeds once --yes is given', async () => {
    mocks.getTaskOnChain.mockResolvedValue(taskFixture({ claimDeadline: PAST_DEADLINE }));

    await unclaimHandler.handler(baseArgv({ yes: true }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(mocks.executeTx.mock.calls[0][1]).toBe('unclaimTask');
  });

  it('the pre-flight/mining race is reported from the receipt when it actually bites', async () => {
    // Consented as a frictionless self-release (live claim), but the receipt
    // names someone else as previousClaimer — a takeover landed first.
    mocks.getTaskOnChain.mockResolvedValue(taskFixture({ claimDeadline: FUTURE_DEADLINE }));
    mocks.executeTx.mockResolvedValue(txResult({
      logs: [{ name: 'TaskUnclaimed', args: { previousClaimer: OTHER, caller: WALLET } }],
    }));

    await unclaimHandler.handler(baseArgv());

    expect(output.warn).toHaveBeenCalledWith(expect.stringContaining('confirmed as a self-release'));
    expect(output.success).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ selfRelease: false, consentWarning: expect.any(String) }),
    );
  });

  it('self-release of a DEADLINE-LESS claim: proceeds — no deadline never blocks the claimer', async () => {
    mocks.getTaskOnChain.mockResolvedValue(taskFixture({ claimDeadline: 0, absoluteDeadline: 0 }));

    await unclaimHandler.handler(baseArgv());

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(output.error).not.toHaveBeenCalled();
  });

  it('third-party force-release of an EXPIRED claim: destructive, so non-TTY without --yes exits ABORTED', async () => {
    mocks.getTaskOnChain.mockResolvedValue(taskFixture({ claimer: OTHER, claimDeadline: PAST_DEADLINE }));

    await expect(unclaimHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.ABORTED);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('destructive'),
      expect.anything(),
    );
  });

  it('third-party force-release of an EXPIRED claim with --yes: proceeds and names the displaced claimer', async () => {
    mocks.getTaskOnChain.mockResolvedValue(taskFixture({ claimer: OTHER, claimDeadline: PAST_DEADLINE }));
    mocks.executeTx.mockResolvedValue(txResult({
      logs: [unclaimedLog(OTHER, WALLET), deadlineSetLog(0)],
    }));

    await unclaimHandler.handler(baseArgv({ yes: true }));

    expect(output.info).toHaveBeenCalledWith(`Force-releasing the expired claim held by ${OTHER}`);
    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(successFields()).toMatchObject({
      previousClaimer: OTHER,
      releasedBy: WALLET,
      selfRelease: false,
      claimDeadlineCleared: true,
    });
    expect(output.info).toHaveBeenCalledWith(expect.stringContaining('Force-release confirmed'));
  });

  it('third party on a LIVE claim: exits PRECONDITION before executeTx, naming the claimer', async () => {
    mocks.getTaskOnChain.mockResolvedValue(taskFixture({ claimer: OTHER, claimDeadline: NOW + 7200 }));

    await expect(unclaimHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    const [message, opts] = (output.error as any).mock.calls[0];
    expect(message).toContain(OTHER);
    expect(message).toContain('has not expired');
    expect(message).toContain('left'); // formatCountdown time remaining
    expect(opts.suggestion).toContain('Wait for the claim to expire');
  });

  it('third party on a DEADLINE-LESS claim: PRECONDITION points at pop task update, never "wait for expiry"', async () => {
    mocks.getTaskOnChain.mockResolvedValue(taskFixture({
      claimer: OTHER,
      claimDeadline: 0,
      absoluteDeadline: 0,
    }));

    await expect(unclaimHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    const [message, opts] = (output.error as any).mock.calls[0];
    expect(message).toContain('can never expire');
    expect(opts.suggestion).toContain('pop task update --task 12 --deadline');
    // Such a claim never expires, so suggesting the wait would be a lie
    expect(opts.suggestion).not.toContain('Wait for the claim to expire');
  });

  // ── Status gate ─────────────────────────────────────────────────────────

  it('UNCLAIMED: exits PRECONDITION with the status name, executeTx never called', async () => {
    mocks.getTaskOnChain.mockResolvedValue(taskFixture({
      status: TASK_STATUS.UNCLAIMED,
      claimer: ethers.constants.AddressZero,
      claimDeadline: 0,
    }));

    await expect(unclaimHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('UNCLAIMED'),
      expect.anything(),
    );
  });

  it('SUBMITTED: PRECONDITION routing through pop task review --action reject first', async () => {
    mocks.getTaskOnChain.mockResolvedValue(taskFixture({ status: TASK_STATUS.SUBMITTED }));

    await expect(unclaimHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    const [message, opts] = (output.error as any).mock.calls[0];
    expect(message).toContain('SUBMITTED');
    expect(opts.suggestion).toContain('pop task review');
    expect(opts.suggestion).toContain('--action reject');
  });

  it.each([
    ['COMPLETED', TASK_STATUS.COMPLETED],
    ['CANCELLED', TASK_STATUS.CANCELLED],
  ])('%s: PRECONDITION with the status name', async (name, status) => {
    mocks.getTaskOnChain.mockResolvedValue(taskFixture({ status }));

    await expect(unclaimHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect((output.error as any).mock.calls[0][0]).toContain(name);
  });

  it('unreadable task: PRECONDITION rather than a raw lens error', async () => {
    mocks.getTaskOnChain.mockRejectedValue(new Error('call revert exception'));

    await expect(unclaimHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('Could not read task 12'),
      expect.anything(),
    );
  });

  it('reverted tx: finishWrite exits TX_FAILED with the decoded error name', async () => {
    mocks.executeTx.mockResolvedValue({
      success: false,
      error: 'execution reverted: BadStatus',
      errorCode: 'TX_REVERTED',
      errorName: 'BadStatus',
    });

    await expect(unclaimHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.TX_FAILED);
    expect(output.error).toHaveBeenCalledWith(
      'execution reverted: BadStatus',
      expect.objectContaining({ errorName: 'BadStatus' }),
    );
    expect(mocks.recordIdempotentResult).not.toHaveBeenCalled();
  });

  // ── Receipt parsing ─────────────────────────────────────────────────────

  it('TaskUnclaimed alone: reports the release parties and no claim-deadline echo', async () => {
    mocks.executeTx.mockResolvedValue(txResult({ logs: [unclaimedLog(WALLET, WALLET)] }));

    await unclaimHandler.handler(baseArgv());

    const fields = successFields();
    expect(fields).toMatchObject({
      taskId: '12',
      previousClaimer: WALLET,
      releasedBy: WALLET,
      selfRelease: true,
    });
    // A release has no new window: claim's deadline echo must not appear
    expect(fields).not.toHaveProperty('claimDeadline');
    expect(fields).not.toHaveProperty('submitBy');
    expect(fields).not.toHaveProperty('claimDeadlineCleared');
  });

  it('TaskUnclaimed + TaskClaimDeadlineSet(id, 0): reports the window as cleared, still no claimDeadline', async () => {
    mocks.executeTx.mockResolvedValue(txResult({
      logs: [unclaimedLog(WALLET, WALLET), deadlineSetLog(0)],
    }));

    await unclaimHandler.handler(baseArgv());

    const fields = successFields();
    expect(fields.claimDeadlineCleared).toBe(true);
    expect(fields).not.toHaveProperty('claimDeadline');
    expect(fields).not.toHaveProperty('submitBy');
  });

  it('a TaskClaimExpired log is ignored: unclaim never emits one, so takenOverFrom must not appear', async () => {
    mocks.executeTx.mockResolvedValue(txResult({
      logs: [
        { name: 'TaskClaimExpired', args: { id: ethers.BigNumber.from(12), previousClaimer: OTHER, newClaimer: WALLET } },
        unclaimedLog(WALLET, WALLET),
      ],
    }));

    await unclaimHandler.handler(baseArgv());

    expect(successFields()).not.toHaveProperty('takenOverFrom');
  });

  // ── Harness paths ───────────────────────────────────────────────────────

  it('--no-preflight --yes: skips the lens read and the gate, and still sends the tx', async () => {
    await unclaimHandler.handler(baseArgv({ preflight: false, yes: true }));

    expect(mocks.getTaskOnChain).not.toHaveBeenCalled();
    expect(mocks.runPreflight).toHaveBeenCalledWith(expect.anything(), expect.any(Array), { skip: true });
    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(output.success).toHaveBeenCalledWith(
      'Task 12 released back to the pool',
      expect.objectContaining({ taskId: '12' }),
    );
  });

  it('--no-preflight without --yes: skipping the CHECK does not downgrade CONSENT, so it aborts', async () => {
    await expect(unclaimHandler.handler(baseArgv({ preflight: false }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.ABORTED);
    expect(mocks.getTaskOnChain).not.toHaveBeenCalled();
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('idempotency cache hit: returns the prior result without re-sending', async () => {
    mocks.checkIdempotencyCache.mockReturnValue({ taskId: '12', txHash: '0xold' });

    await unclaimHandler.handler(baseArgv());

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
      method: 'unclaimTask',
      to: TM_ADDR,
    });

    await unclaimHandler.handler(baseArgv({ dryRun: true }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(mocks.executeTx.mock.calls[0][3]).toEqual({ dryRun: true });
    expect(mocks.checkIdempotencyCache).not.toHaveBeenCalled();
    expect(mocks.recordIdempotentResult).not.toHaveBeenCalled();
    expect(output.success).toHaveBeenCalledWith(
      expect.stringContaining('DRY RUN'),
      expect.objectContaining({ method: 'unclaimTask' }),
    );
  });

  it('success records the idempotent result under task.unclaim', async () => {
    await unclaimHandler.handler(baseArgv());

    expect(mocks.recordIdempotentResult).toHaveBeenCalledWith(
      ORG_ID, 'task.unclaim', 'idem-key',
      expect.objectContaining({ taskId: '12', txHash: '0xabc' }),
      900,
    );
  });

  it('implementation without unclaimTask: PRECONDITION before pre-flight and before any tx', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue({ ...ALL_FEATURES, unclaim: false });

    await expect(unclaimHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.runPreflight).not.toHaveBeenCalled();
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect((output.error as any).mock.calls[0][0]).toContain(
      "is unavailable: this org's TaskManager implementation predates TaskManager v7",
    );
  });

  // ── Cross-chain indexing warning ────────────────────────────────────────

  it('Arbitrum: warns that the release will stay invisible to list/view', async () => {
    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      provider: {},
      address: WALLET,
      chainId: ARBITRUM,
    });

    await unclaimHandler.handler(baseArgv());

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(output.warn).toHaveBeenCalledWith(
      expect.stringContaining('does not index task releases'),
    );
  });

  it('Gnosis: no indexing warning — the subgraph handles TaskUnclaimed there', async () => {
    await unclaimHandler.handler(baseArgv());

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(output.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('does not index task releases'),
    );
  });

  it('a DRY RUN never claims the on-chain release succeeded', async () => {
    // output.warn is the only channel that carried "The on-chain release itself
    // succeeded", and it used to fire on dry runs too — asserting a success for
    // a transaction that was never sent.
    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET), provider: {}, address: WALLET, chainId: ARBITRUM,
    });
    mocks.executeTx.mockResolvedValue(txResult({ dryRun: true }));

    await unclaimHandler.handler(baseArgv({ dryRun: true }));

    expect(output.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('does not index task releases'),
    );
    expect(output.warn).not.toHaveBeenCalledWith(expect.stringContaining('succeeded'));
  });

  it('a dry run carries no advisory keys — there is nothing to advise about', async () => {
    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET), provider: {}, address: WALLET, chainId: ARBITRUM,
    });
    mocks.executeTx.mockResolvedValue(txResult({ dryRun: true }));

    await unclaimHandler.handler(baseArgv({ dryRun: true }));

    const payload = output.success.mock.calls.map((c: any[]) => c[1]).find(Boolean) || {};
    expect(payload).not.toHaveProperty('subgraphIndexesReleases');
    expect(payload).not.toHaveProperty('indexingWarning');
  });

  // ── Machine-readable advisories (output.warn is a no-op under --json) ──────

  it('Arbitrum: the indexing caveat reaches JSON callers as payload keys', async () => {
    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET), provider: {}, address: WALLET, chainId: ARBITRUM,
    });

    await unclaimHandler.handler(baseArgv());

    expect(output.success).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        subgraphIndexesReleases: false,
        indexingWarning: expect.stringContaining('does not index task releases'),
      }),
    );
  });

  it('Gnosis: reports subgraphIndexesReleases true with no warning key', async () => {
    await unclaimHandler.handler(baseArgv());

    const payload = output.success.mock.calls.map((c: any[]) => c[1]).find(Boolean) || {};
    expect(payload.subgraphIndexesReleases).toBe(true);
    expect(payload).not.toHaveProperty('indexingWarning');
  });
});

describe('gateUnclaimableTask', () => {
  it('claimer with a live claim → self-release', () => {
    expect(gateUnclaimableTask(taskFixture(), '12', WALLET)).toBe(true);
  });

  it('claimer with an expired claim → self-release', () => {
    expect(gateUnclaimableTask(taskFixture({ claimDeadline: PAST_DEADLINE }), '12', WALLET)).toBe(true);
  });

  it('claimer with no deadline at all → self-release', () => {
    const task = taskFixture({ claimDeadline: undefined, absoluteDeadline: undefined });
    expect(gateUnclaimableTask(task, '12', WALLET)).toBe(true);
  });

  it('claimer matched case-insensitively', () => {
    expect(gateUnclaimableTask(taskFixture(), '12', WALLET.toLowerCase())).toBe(true);
  });

  it('third party on an expired claim → permitted forced release', () => {
    const task = taskFixture({ claimer: OTHER, claimDeadline: PAST_DEADLINE });
    expect(gateUnclaimableTask(task, '12', THIRD)).toBe(false);
  });

  it('third party falls back to absoluteDeadline for expiry', () => {
    const task = taskFixture({ claimer: OTHER, claimDeadline: 0, absoluteDeadline: PAST_DEADLINE });
    expect(gateUnclaimableTask(task, '12', THIRD)).toBe(false);
  });

  it('third party on a live claim → PreconditionError naming the claimer', () => {
    const task = taskFixture({ claimer: OTHER, claimDeadline: FUTURE_DEADLINE });
    try {
      gateUnclaimableTask(task, '12', THIRD);
      expect.unreachable('expected a PreconditionError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(PreconditionError);
      expect(err.code).toBe(EXIT.PRECONDITION);
      expect(err.message).toContain(OTHER);
      expect(err.suggestion).toContain('pop task unclaim --task 12');
    }
  });

  it('third party on a deadline-less claim → PreconditionError with the update-then-unclaim unstick', () => {
    const task = taskFixture({ claimer: OTHER, claimDeadline: 0, absoluteDeadline: 0 });
    try {
      gateUnclaimableTask(task, '12', THIRD);
      expect.unreachable('expected a PreconditionError');
    } catch (err: any) {
      expect(err.message).toContain('can never expire');
      expect(err.suggestion).toContain('pop task update --task 12 --deadline');
    }
  });

  it.each([
    ['UNCLAIMED', TASK_STATUS.UNCLAIMED],
    ['SUBMITTED', TASK_STATUS.SUBMITTED],
    ['COMPLETED', TASK_STATUS.COMPLETED],
    ['CANCELLED', TASK_STATUS.CANCELLED],
  ])('%s → PreconditionError even for the claimer', (name, status) => {
    expect(() => gateUnclaimableTask(taskFixture({ status }), '12', WALLET))
      .toThrow(new RegExp(`is ${name}`));
  });
});

describe('unclaimReceiptFields', () => {
  it('dry runs and failures yield nothing', () => {
    expect(unclaimReceiptFields({ success: true, dryRun: true } as TxResult)).toEqual({});
    expect(unclaimReceiptFields({ success: false } as TxResult)).toEqual({});
  });

  it('a success with no logs yields nothing', () => {
    expect(unclaimReceiptFields({ success: true } as TxResult)).toEqual({});
  });

  it('TaskUnclaimed alone: parties plus selfRelease, no deadline key', () => {
    const fields = unclaimReceiptFields(txResult({ logs: [unclaimedLog(WALLET, WALLET)] }));
    expect(fields).toEqual({ previousClaimer: WALLET, releasedBy: WALLET, selfRelease: true });
  });

  it('selfRelease compares addresses case-insensitively', () => {
    const fields = unclaimReceiptFields(txResult({
      logs: [unclaimedLog(WALLET, WALLET.toLowerCase())],
    }));
    expect(fields.selfRelease).toBe(true);
  });

  it('a different caller is a forced release', () => {
    const fields = unclaimReceiptFields(txResult({ logs: [unclaimedLog(OTHER, WALLET)] }));
    expect(fields.selfRelease).toBe(false);
    expect(fields.previousClaimer).toBe(OTHER);
    expect(fields.releasedBy).toBe(WALLET);
  });

  it('TaskClaimDeadlineSet(id, 0) marks the window cleared', () => {
    const fields = unclaimReceiptFields(txResult({
      logs: [unclaimedLog(WALLET, WALLET), deadlineSetLog(0)],
    }));
    expect(fields.claimDeadlineCleared).toBe(true);
    expect(fields).not.toHaveProperty('claimDeadline');
  });

  it('a non-zero TaskClaimDeadlineSet is not a clear', () => {
    const fields = unclaimReceiptFields(txResult({
      logs: [unclaimedLog(WALLET, WALLET), deadlineSetLog(FUTURE_DEADLINE)],
    }));
    expect(fields.claimDeadlineCleared).toBe(false);
  });

  it('TaskClaimExpired is never consulted', () => {
    const fields = unclaimReceiptFields(txResult({
      logs: [
        { name: 'TaskClaimExpired', args: { previousClaimer: OTHER, newClaimer: WALLET } },
        unclaimedLog(WALLET, WALLET),
      ],
    }));
    expect(fields).not.toHaveProperty('takenOverFrom');
  });
});
