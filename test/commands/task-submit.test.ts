/**
 * pop task submit — pre-flight BEFORE the IPFS pin (the v6-migration fix).
 *
 * Previously the command pinned the submission to IPFS before any status
 * check could fail, wasting pins on doomed submissions. The migrated order
 * is: pre-flight (status CLAIMED + claimer==signer via checkTaskStatus, gas
 * balance) → metadata fetch → pin → tx. A lapsed claim deadline never blocks
 * the ORIGINAL claimer's submitTask — it only warns that the task is
 * takeover-able until the submission lands.
 *
 * command.ts (getWriteContext/finishWrite/withIdempotency) runs REAL; the
 * module seams (tx, signer, resolve, subgraph, ipfs, preflight,
 * task-lens.getTaskOnChain, idempotency, output) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  pinJson: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  query: vi.fn(),
  getTaskOnChain: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
  checkTaskStatus: vi.fn(),
  checkIdempotencyCache: vi.fn(),
  recordIdempotentResult: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/ipfs', () => ({ pinJson: mocks.pinJson }));
vi.mock('../../src/lib/signer', () => ({ createSigner: mocks.createSigner }));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => modules[key],
}));
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
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
import { submitHandler } from '../../src/commands/task/submit';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { ipfsCidToBytes32 } from '../../src/lib/encoding';
import { PreconditionError } from '../../src/lib/errors';
import { EXIT } from '../../src/lib/exit-codes';
import { TASK_STATUS, type TaskOnChain } from '../../src/lib/task-lens';
import * as output from '../../src/lib/output';

const TM_ADDR = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const ORG_ID = '0x' + 'ab'.repeat(32);
const PID = '0x' + '22'.repeat(32);
const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

const NOW = Math.floor(Date.now() / 1000);

function claimedTask(overrides: Partial<TaskOnChain> = {}): TaskOnChain {
  return {
    projectId: PID,
    payout: ethers.utils.parseUnits('5', 18),
    claimer: WALLET,
    bountyPayout: ethers.BigNumber.from(0),
    requiresApplication: false,
    status: 1, // CLAIMED
    bountyToken: ethers.constants.AddressZero,
    absoluteDeadline: 0,
    completionWindow: 0,
    claimDeadline: NOW + 86400,
    ...overrides,
  };
}

const SUBGRAPH_PROJECTS = {
  organization: {
    taskManager: {
      projects: [
        {
          tasks: [
            {
              taskId: '12',
              id: `${TM_ADDR}-12`,
              metadata: {
                name: 'Fix bug',
                description: 'd',
                location: '',
                difficulty: 'hard',
                estimatedHours: '2',
              },
            },
          ],
        },
      ],
    },
  },
};

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
    submission: 'done',
    commit: false,
    yes: false,
    preflight: true,
    noIdempotency: false,
    dryRun: false,
    ...overrides,
  };
}

describe('pop task submit — preflight-first ordering', () => {
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
    mocks.getTaskOnChain.mockResolvedValue(claimedTask());
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.checkGasBalance.mockReturnValue({ label: 'gas balance' });
    mocks.checkTaskStatus.mockReturnValue({ label: 'task 12 status' });
    mocks.checkIdempotencyCache.mockReturnValue(null);
    mocks.query.mockResolvedValue(SUBGRAPH_PROJECTS);
    mocks.pinJson.mockResolvedValue(CID);
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xsub',
      explorerUrl: 'https://explorer/tx/0xsub',
      logs: [{ name: 'TaskSubmitted', args: { id: ethers.BigNumber.from(12), submissionHash: ipfsCidToBytes32(CID) } }],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    _setStreamsForTest();
  });

  it('preflight failure (not the claimer): exits EXIT.PRECONDITION and pinJson is NEVER called', async () => {
    mocks.getTaskOnChain.mockResolvedValue(claimedTask({ claimer: OTHER }));
    mocks.runPreflight.mockRejectedValue(new PreconditionError(
      `Pre-flight checks failed:\n  ✗ task 12 status: claimed by ${OTHER}, not ${WALLET}`
    ));

    await expect(submitHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining(`claimed by ${OTHER}`),
      expect.anything(),
    );
    // THE fix: nothing was pinned, nothing was fetched, nothing was sent
    expect(mocks.pinJson).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.executeTx).not.toHaveBeenCalled();

    // Status gate wired with the CLAIMED requirement + claimer binding
    expect(mocks.checkTaskStatus).toHaveBeenCalledWith(
      TM_ADDR, '12', [TASK_STATUS.CLAIMED], { claimerMustBe: WALLET },
    );
  });

  it('success path: preflight → metadata fetch → pin → submitTask, in that order', async () => {
    await submitHandler.handler(baseArgv());

    // Ordering: preflight strictly before pin, pin strictly before tx
    const preflightOrder = mocks.runPreflight.mock.invocationCallOrder[0];
    const pinOrder = mocks.pinJson.mock.invocationCallOrder[0];
    const txOrder = mocks.executeTx.mock.invocationCallOrder[0];
    expect(preflightOrder).toBeLessThan(pinOrder);
    expect(pinOrder).toBeLessThan(txOrder);

    // Existing metadata preserved through the merge (frontend key order)
    expect(mocks.pinJson).toHaveBeenCalledWith(JSON.stringify({
      name: 'Fix bug',
      description: 'd',
      location: '',
      difficulty: 'hard',
      estHours: 2,
      submission: 'done',
    }));

    const [contract, method, args, opts] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('submitTask');
    expect(args).toEqual(['12', ipfsCidToBytes32(CID)]);
    expect(opts).toEqual({ dryRun: false });
    expect(() => contract.interface.getFunction('submitTask')).not.toThrow();

    // No expiry warning on an on-track claim
    expect(output.warn).not.toHaveBeenCalled();

    expect(output.success).toHaveBeenCalledWith('Task 12 submitted', expect.objectContaining({
      taskId: '12',
      ipfsCid: CID,
      txHash: '0xsub',
    }));
    expect(mocks.recordIdempotentResult).toHaveBeenCalledWith(
      ORG_ID, 'task.submit', 'idem-key',
      expect.objectContaining({ taskId: '12', txHash: '0xsub', ipfsCid: CID }),
      900,
    );
  });

  it('expired claim deadline: warns the task is takeover-able but the submission proceeds', async () => {
    mocks.getTaskOnChain.mockResolvedValue(claimedTask({ claimDeadline: NOW - 3600 }));

    await submitHandler.handler(baseArgv());

    expect(output.warn).toHaveBeenCalledWith(expect.stringContaining('takeover-able'));
    // Never blocked: the original claimer may submit past the deadline
    expect(mocks.pinJson).toHaveBeenCalledTimes(1);
    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(output.success).toHaveBeenCalledWith('Task 12 submitted', expect.objectContaining({ taskId: '12' }));
  });

  it('--no-preflight: skips the lens read, passes skip:true, still pins and submits', async () => {
    await submitHandler.handler(baseArgv({ preflight: false }));

    expect(mocks.getTaskOnChain).not.toHaveBeenCalled();
    expect(mocks.runPreflight).toHaveBeenCalledWith(expect.anything(), expect.any(Array), { skip: true });
    expect(mocks.pinJson).toHaveBeenCalledTimes(1);
    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
  });

  it('idempotency cache hit: returns the prior result before preflight, fetch, or pin', async () => {
    mocks.checkIdempotencyCache.mockReturnValue({ taskId: '12', txHash: '0xold', ipfsCid: CID });

    await submitHandler.handler(baseArgv());

    expect(mocks.runPreflight).not.toHaveBeenCalled();
    expect(mocks.pinJson).not.toHaveBeenCalled();
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.success).toHaveBeenCalledWith(
      expect.stringContaining('idempotency cache hit'),
      expect.objectContaining({ taskId: '12', txHash: '0xold', cached: true }),
    );
  });
});
