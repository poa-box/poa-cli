/**
 * pop task update — read-then-merge semantics for the v6 full-overwrite
 * updateTask(id, newPayout, newTitle, newMetadataHash, newBountyToken,
 * newBountyPayout, newAbsoluteDeadline, newCompletionWindow).
 *
 * The command must:
 *  - read current on-chain fields (task-lens) + current metadata (subgraph),
 *  - merge only the flags the caller passed,
 *  - re-pin metadata to IPFS ONLY when name/description actually change,
 *  - refuse cleanly on pre-v6 orgs (featureUnavailable, no 6-arg attempt),
 *  - accept a PAST --deadline (verified contract admin lever for takeover).
 *
 * Status gate encoded here was VERIFIED against contracts origin/main
 * src/TaskManager.sol: only COMPLETED/CANCELLED revert BadStatus, so
 * UNCLAIMED/CLAIMED/SUBMITTED are all editable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  detectTaskManagerFeatures: vi.fn(),
  pinJson: vi.fn(),
  fetchJson: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  query: vi.fn(),
  getTaskOnChain: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/version', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/version')>();
  return { ...actual, detectTaskManagerFeatures: mocks.detectTaskManagerFeatures };
});
vi.mock('../../src/lib/ipfs', () => ({ pinJson: mocks.pinJson, fetchJson: mocks.fetchJson }));
vi.mock('../../src/lib/signer', () => ({ createSigner: mocks.createSigner }));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => {
    if (!modules?.[key]) throw new Error(`missing module ${key}`);
    return modules[key];
  },
}));
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
// Deterministic non-TTY: confirmWrite must auto-pass (non-destructive path)
// regardless of the terminal vitest happens to run in.
vi.mock('../../src/lib/prompt', () => ({
  isInteractive: () => false,
  confirm: vi.fn(),
  input: vi.fn(),
  select: vi.fn(),
}));
vi.mock('../../src/lib/task-lens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/task-lens')>();
  return { ...actual, getTaskOnChain: mocks.getTaskOnChain };
});
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
import { updateHandler, parseUpdateDeadline } from '../../src/commands/task/update';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { ipfsCidToBytes32 } from '../../src/lib/encoding';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const TM_ADDR = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const ORG_ID = '0x' + 'ab'.repeat(32);
const PID = '0x' + '22'.repeat(32);
const BOUNTY_TOKEN = '0x4ECaBa5870353805a9F068101A40E0f32ed605C6';
const CURRENT_META_HASH = '0x' + 'cd'.repeat(32);
const NEW_CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

/** 2100-01-01T00:00:00Z */
const DEADLINE_TS = 4102444800;
/** 2020-01-01T00:00:00Z — the past-deadline admin lever */
const PAST_TS = 1577836800;

const V6_FEATURES = { deadlines: true, batchCreate: true, editMeta: true, folders: true, legacyCreate7: false, unclaim: false };
const LEGACY_FEATURES = { deadlines: false, batchCreate: false, editMeta: false, folders: false, legacyCreate7: true, unclaim: false };

const SIG_V6 = 'updateTask(uint256,uint256,bytes,bytes32,address,uint256,uint48,uint32)';

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

function currentTaskOnChain(overrides: Record<string, any> = {}) {
  return {
    projectId: PID,
    payout: ethers.utils.parseUnits('5', 18),
    claimer: '0x3333333333333333333333333333333333333333',
    bountyPayout: ethers.BigNumber.from('777000000'),
    requiresApplication: false,
    status: 1, // CLAIMED — editable per the verified non-terminal gate
    bountyToken: BOUNTY_TOKEN,
    absoluteDeadline: DEADLINE_TS,
    completionWindow: 3600,
    claimDeadline: DEADLINE_TS,
    ...overrides,
  };
}

function subgraphWithTask(taskOverrides: Record<string, any> = {}) {
  return {
    organization: {
      taskManager: {
        projects: [{
          id: `${TM_ADDR}-${PID}`,
          title: 'Protocol Work',
          tasks: [{
            id: `${TM_ADDR}-12`,
            taskId: '12',
            title: 'Current title',
            metadataHash: CURRENT_META_HASH,
            metadata: {
              name: 'Current title',
              description: 'Current desc',
              difficulty: 'hard',
              estimatedHours: 6,
              submission: '',
            },
            ...taskOverrides,
          }],
        }],
      },
    },
  };
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    task: '12',
    preflight: false, // unit tests target merge logic, not multicall
    dryRun: false,
    ...overrides,
  };
}

describe('pop task update — read-then-merge', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _clearWriteContextCacheForTest();
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
      hybridVotingAddress: null,
    });
    mocks.detectTaskManagerFeatures.mockResolvedValue(V6_FEATURES);
    mocks.getTaskOnChain.mockResolvedValue(currentTaskOnChain());
    mocks.query.mockResolvedValue(subgraphWithTask());
    mocks.pinJson.mockResolvedValue(NEW_CID);
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xhash',
      explorerUrl: 'https://explorer/tx/0xhash',
      logs: [],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('--payout only: merges current bounty/deadlines/metadataHash, does NOT re-pin', async () => {
    await updateHandler.handler(baseArgv({ payout: 10 }));

    expect(mocks.pinJson).not.toHaveBeenCalled();
    expect(mocks.getTaskOnChain).toHaveBeenCalledWith({}, TM_ADDR, '12');

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args, opts] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('updateTask');
    expect(args).toHaveLength(8);

    expect(args[0]).toBe('12');
    expect(args[1].toString()).toBe(ethers.utils.parseUnits('10', 18).toString()); // changed
    expect(ethers.utils.toUtf8String(args[2])).toBe('Current title'); // preserved title
    expect(args[3]).toBe(CURRENT_META_HASH); // preserved metadata pointer — no re-pin
    expect(args[4]).toBe(BOUNTY_TOKEN); // preserved bounty token
    expect(args[5].toString()).toBe('777000000'); // preserved raw bounty payout
    expect(args[6]).toBe(DEADLINE_TS); // preserved absolute deadline
    expect(args[7]).toBe(3600); // preserved completion window
    expect(opts).toEqual({ dryRun: false });

    // Args must encode against the real v6 ABI signature
    expect(contract.interface.functions[SIG_V6]).toBeDefined();
    expect(() => contract.interface.encodeFunctionData('updateTask', args)).not.toThrow();

    expect(output.success).toHaveBeenCalledWith('Task 12 updated', expect.objectContaining({
      taskId: '12',
      txHash: '0xhash',
    }));
  });

  it('--name only: re-pins merged metadata (frontend key order) and sends the new hash', async () => {
    await updateHandler.handler(baseArgv({ name: 'New title' }));

    // Merged metadata: new name + preserved description/difficulty/estHours
    expect(mocks.pinJson).toHaveBeenCalledTimes(1);
    expect(mocks.pinJson).toHaveBeenCalledWith(JSON.stringify({
      name: 'New title',
      description: 'Current desc',
      location: '',
      difficulty: 'hard',
      estHours: 6,
      submission: '',
    }));

    const [, , args] = mocks.executeTx.mock.calls[0];
    expect(ethers.utils.toUtf8String(args[2])).toBe('New title');
    expect(args[3]).toBe(ipfsCidToBytes32(NEW_CID)); // new pin in calldata
    // Everything not passed stays current
    expect(args[1].toString()).toBe(ethers.utils.parseUnits('5', 18).toString());
    expect(args[4]).toBe(BOUNTY_TOKEN);
    expect(args[5].toString()).toBe('777000000');
    expect(args[6]).toBe(DEADLINE_TS);
    expect(args[7]).toBe(3600);

    expect(output.success).toHaveBeenCalledWith('Task 12 updated', expect.objectContaining({
      ipfsCid: NEW_CID,
    }));
  });

  it('--name equal to the current name: no content change ⇒ no re-pin, current hash kept', async () => {
    await updateHandler.handler(baseArgv({ name: 'Current title', payout: 6 }));

    expect(mocks.pinJson).not.toHaveBeenCalled();
    const [, , args] = mocks.executeTx.mock.calls[0];
    expect(args[3]).toBe(CURRENT_META_HASH);
  });

  it('legacy org: exits PRECONDITION with featureUnavailable text, never attempts the removed 6-arg variant', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(LEGACY_FEATURES);

    await expect(updateHandler.handler(baseArgv({ payout: 10 }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('full task editing (updateTask) is unavailable'));
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('predates TaskManager v6'));
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(mocks.pinJson).not.toHaveBeenCalled();
    expect(mocks.getTaskOnChain).not.toHaveBeenCalled();
  });

  it('no change flags: usage error before any org/network resolution', async () => {
    await expect(updateHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('Nothing to update'),
      expect.anything()
    );
    expect(mocks.resolveOrgModules).not.toHaveBeenCalled();
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('terminal status (COMPLETED): refuses with PRECONDITION before pin/tx', async () => {
    mocks.getTaskOnChain.mockResolvedValue(currentTaskOnChain({ status: 3 }));

    await expect(updateHandler.handler(baseArgv({ payout: 10 }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('COMPLETED'),
      expect.anything()
    );
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('PAST --deadline is accepted (verified contract admin lever) with a takeover warning', async () => {
    await updateHandler.handler(baseArgv({ deadline: '2020-01-01' }));

    const [, , args] = mocks.executeTx.mock.calls[0];
    expect(args[6]).toBe(PAST_TS);
    expect(args[7]).toBe(3600); // window untouched
    expect(output.warn).toHaveBeenCalledWith(expect.stringContaining('opens the task to claim takeover'));
  });

  it('subgraph lag with a non-metadata edit: INFRA error explains it cannot preserve metadata', async () => {
    mocks.query.mockResolvedValue({ organization: { taskManager: { projects: [] } } });

    await expect(updateHandler.handler(baseArgv({ payout: 10 }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.INFRA);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('not indexed yet'),
      expect.anything()
    );
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('--dry-run prints the merged final field block and passes dryRun through', async () => {
    mocks.executeTx.mockResolvedValue({
      success: true,
      dryRun: true,
      gasEstimate: '90000',
      method: 'updateTask',
      to: TM_ADDR,
    });

    await updateHandler.handler(baseArgv({ payout: 10, dryRun: true }));

    expect(output.keyValueBlock).toHaveBeenCalledWith(
      'Final task fields (merged)',
      expect.objectContaining({
        task: '12',
        payout: expect.stringContaining('→ 10 PT'),
        deadline: expect.any(String),
      })
    );
    expect(mocks.executeTx.mock.calls[0][3]).toEqual({ dryRun: true });
    expect(output.success).toHaveBeenCalledWith('DRY RUN — transaction not sent', expect.objectContaining({
      method: 'updateTask',
    }));
  });
});

describe('parseUpdateDeadline', () => {
  it('passes future deadlines through unchanged', () => {
    const { value, isPast } = parseUpdateDeadline(String(DEADLINE_TS));
    expect(value).toBe(DEADLINE_TS);
    expect(isPast).toBe(false);
  });

  it('accepts past absolute deadlines and flags them', () => {
    const { value, isPast } = parseUpdateDeadline('2020-01-01');
    expect(value).toBe(PAST_TS);
    expect(isPast).toBe(true);
  });

  it('still rejects garbage', () => {
    expect(() => parseUpdateDeadline('soonish')).toThrow(/Unparseable deadline/);
  });

  it('"0" clears the deadline', () => {
    expect(parseUpdateDeadline('0')).toEqual({ value: 0, isPast: false });
  });
});
