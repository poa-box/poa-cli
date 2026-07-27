/**
 * pop role admin — destructive gate + superAdmin operations.
 *
 *  - transfer is DESTRUCTIVE: non-TTY without --yes → EXIT.ABORTED (5)
 *    before any tx; with --yes it proceeds with the module-handover warning
 *  - non-destructive admin writes (mint) keep the silent-pass contract:
 *    non-TTY without --yes still proceeds
 *  - every subcommand pre-checks superAdmin() and names the actual
 *    superAdmin on mismatch (EXIT.PRECONDITION, no tx)
 *  - mint routes 1 wearer → mintHatToAddress, N wearers → batchMintHats
 *  - pause/unpause pre-check paused() to avoid pointless txs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  createReadContract: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/signer', () => ({ createSigner: mocks.createSigner }));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => modules[key],
}));
vi.mock('../../src/lib/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/contracts')>();
  return { ...actual, createReadContract: mocks.createReadContract };
});
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
    json: vi.fn(),
    keyValueBlock: vi.fn(),
    isJsonMode: vi.fn(() => false),
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import {
  adminTransferHandler,
  adminMintHandler,
  adminPauseHandler,
} from '../../src/commands/role/admin';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const EM_ADDR = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const NEW_ADMIN = '0x3333333333333333333333333333333333333333';
const WEARER_A = ethers.utils.getAddress('0x' + 'aa'.repeat(20));
const WEARER_B = ethers.utils.getAddress('0x' + 'bb'.repeat(20));
const ORG_ID = '0x' + 'ab'.repeat(32);

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

function fakeReader(overrides: Record<string, any> = {}) {
  return {
    superAdmin: vi.fn(async () => WALLET),
    paused: vi.fn(async () => false),
    ...overrides,
  };
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    yes: false,
    preflight: true,
    dryRun: false,
    ...overrides,
  };
}

describe('pop role admin — destructive gate + superAdmin ops', () => {
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
    mocks.resolveOrgModules.mockResolvedValue({ orgId: ORG_ID, eligibilityModuleAddress: EM_ADDR });
    mocks.createReadContract.mockReturnValue(fakeReader());
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

  it('transfer non-TTY WITHOUT --yes: aborts (EXIT.ABORTED) before any tx', async () => {
    await expect(adminTransferHandler.handler(baseArgv({ to: NEW_ADMIN })))
      .rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.ABORTED);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect((output.error as any).mock.calls[0][0]).toContain('--yes');
  });

  it('transfer with --yes: proceeds with the module-handover warning', async () => {
    await adminTransferHandler.handler(baseArgv({ to: NEW_ADMIN, yes: true }));

    expect(output.warn).toHaveBeenCalledWith(expect.stringContaining('ENTIRE eligibility module'));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('transferSuperAdmin');
    expect(args).toEqual([NEW_ADMIN]);
    expect(() => contract.interface.getFunction('transferSuperAdmin')).not.toThrow();

    expect(output.success).toHaveBeenCalledWith(
      `SuperAdmin transferred to ${NEW_ADMIN}`,
      expect.objectContaining({ newSuperAdmin: NEW_ADMIN, previousSuperAdmin: WALLET }),
    );
  });

  it('transfer superAdmin mismatch: exits EXIT.PRECONDITION naming the actual superAdmin', async () => {
    mocks.createReadContract.mockReturnValue(fakeReader({
      superAdmin: vi.fn(async () => NEW_ADMIN),
    }));

    await expect(adminTransferHandler.handler(baseArgv({ to: WEARER_A, yes: true })))
      .rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    const [message] = (output.error as any).mock.calls[0];
    expect(message).toContain(NEW_ADMIN); // the actual superAdmin is named
    expect(message).toContain(WALLET);
  });

  it('transfer to yourself: EXIT.PRECONDITION, no tx', async () => {
    await expect(adminTransferHandler.handler(baseArgv({ to: WALLET, yes: true })))
      .rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect((output.error as any).mock.calls[0][0]).toContain('already the superAdmin');
  });

  it('mint (non-destructive) non-TTY without --yes: silent-pass, single wearer → mintHatToAddress', async () => {
    await adminMintHandler.handler(baseArgv({ hat: '123', wearer: WEARER_A }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('mintHatToAddress');
    expect(args[0].toString()).toBe('123');
    expect(args[1]).toBe(WEARER_A);
  });

  it('mint with several wearers routes to batchMintHats with aligned arrays', async () => {
    await adminMintHandler.handler(baseArgv({ hat: '123', wearer: `${WEARER_A},${WEARER_B}` }));

    const [, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('batchMintHats');
    expect(args[0].map((h: any) => h.toString())).toEqual(['123', '123']);
    expect(args[1]).toEqual([WEARER_A, WEARER_B]);
  });

  it('pause when already paused: EXIT.PRECONDITION, no tx', async () => {
    mocks.createReadContract.mockReturnValue(fakeReader({
      paused: vi.fn(async () => true),
    }));

    await expect(adminPauseHandler.handler(baseArgv({ yes: true })))
      .rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect((output.error as any).mock.calls[0][0]).toContain('already paused');
  });

  it('pause proceeds when unpaused: sends pause()', async () => {
    await adminPauseHandler.handler(baseArgv({ yes: true }));

    const [, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('pause');
    expect(args).toEqual([]);
  });
});
