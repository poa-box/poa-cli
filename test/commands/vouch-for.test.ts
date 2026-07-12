/**
 * pop vouch for — fail-fast pre-flight + Vouched-event progress.
 *
 *  - canUserVouch=false (daily limit) → EXIT.PRECONDITION (4) BEFORE any
 *    executeTx, with the friendly "3/3 used today" reason
 *  - vouching disabled for the hat  → EXIT.PRECONDITION before tx
 *  - self-vouch                     → EXIT.PRECONDITION before tx
 *  - success parses the Vouched event's newCount → "N/quorum vouches"
 *    progress line, claim pointer at quorum (claim-based pattern — the
 *    contract never auto-mints; verified against EligibilityModule.sol)
 *
 * command.ts composition (getWriteContext/confirmWrite/withIdempotency) and
 * the vouch helpers run REAL; the seams are tx, signer, resolve, contracts
 * reads, preflight, idempotency, output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  createReadContract: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
  checkIdempotencyCache: vi.fn(),
  recordIdempotentResult: vi.fn(),
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
import { forHandler } from '../../src/commands/vouch/for';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const EM_ADDR = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const WEARER = '0x4444444444444444444444444444444444444444';
const ORG_ID = '0x' + 'ab'.repeat(32);
const NOW = Math.floor(Date.now() / 1000);

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

/** Reads behind readVouchPreflight: signer gate + hat config + wearer count. */
function fakeReader(overrides: Record<string, any> = {}) {
  return {
    canUserVouch: vi.fn(async () => true),
    getCurrentDailyVouchCount: vi.fn(async () => ethers.BigNumber.from(1)),
    getMaxDailyVouches: vi.fn(async () => ethers.BigNumber.from(3)),
    getUserJoinTime: vi.fn(async () => ethers.BigNumber.from(0)),
    getVouchConfig: vi.fn(async () => ({
      quorum: 3,
      membershipHatId: ethers.BigNumber.from(45),
      flags: 1, // enabled
    })),
    currentVouchCount: vi.fn(async () => ethers.BigNumber.from(1)),
    ...overrides,
  };
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    address: WEARER,
    hat: '123',
    yes: true,
    preflight: true,
    noIdempotency: false,
    dryRun: false,
    ...overrides,
  };
}

describe('pop vouch for — pre-flight gates + Vouched progress', () => {
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
    mocks.checkIdempotencyCache.mockReturnValue(null);
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xabc',
      explorerUrl: 'https://explorer/tx/0xabc',
      logs: [{ name: 'Vouched', args: { voucher: WALLET, wearer: WEARER, hatId: ethers.BigNumber.from(123), newCount: ethers.BigNumber.from(2) } }],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    _setStreamsForTest();
  });

  it('canUserVouch=false (daily limit): exits EXIT.PRECONDITION BEFORE executeTx with the quota reason', async () => {
    mocks.createReadContract.mockReturnValue(fakeReader({
      canUserVouch: vi.fn(async () => false),
      getCurrentDailyVouchCount: vi.fn(async () => ethers.BigNumber.from(3)),
    }));

    await expect(forHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    const [message, details] = (output.error as any).mock.calls[0];
    expect(message).toContain('Daily vouch limit reached (3/3 used today)');
    expect(details.suggestion).toContain('UTC midnight');
  });

  it('canUserVouch=false (join grace): exits EXIT.PRECONDITION before tx with the grace reason', async () => {
    mocks.createReadContract.mockReturnValue(fakeReader({
      canUserVouch: vi.fn(async () => false),
      getCurrentDailyVouchCount: vi.fn(async () => ethers.BigNumber.from(0)),
      getUserJoinTime: vi.fn(async () => ethers.BigNumber.from(NOW - 3600)),
    }));

    await expect(forHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect((output.error as any).mock.calls[0][0]).toContain('Account too new');
  });

  it('vouching disabled for the hat: exits EXIT.PRECONDITION pointing at vouch config', async () => {
    mocks.createReadContract.mockReturnValue(fakeReader({
      getVouchConfig: vi.fn(async () => ({ quorum: 0, membershipHatId: ethers.BigNumber.from(0), flags: 0 })),
    }));

    await expect(forHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    const [message, details] = (output.error as any).mock.calls[0];
    expect(message).toContain('not enabled for hat 123');
    expect(details.suggestion).toContain('pop vouch config show --hat 123');
  });

  it('self-vouch: exits EXIT.PRECONDITION before tx', async () => {
    await expect(forHandler.handler(baseArgv({ address: WALLET }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect((output.error as any).mock.calls[0][0]).toContain('cannot vouch for yourself');
  });

  it('success: sends vouchFor(wearer, hat) and renders N/quorum from the Vouched event', async () => {
    await forHandler.handler(baseArgv());

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args, opts] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('vouchFor');
    expect(args).toEqual([WEARER, '123']);
    expect(opts).toEqual({ dryRun: false });
    // Real EligibilityModuleNew ABI wired through createWriteContract
    expect(() => contract.interface.getFunction('vouchFor')).not.toThrow();

    // Pre-tx quota echo
    expect(output.info).toHaveBeenCalledWith('You can vouch (1/3 used today)');

    expect(output.success).toHaveBeenCalledWith(`Vouched for ${WEARER} on hat 123`, expect.objectContaining({
      newCount: 2,
      quorum: 3,
      progress: '2/3',
      txHash: '0xabc',
    }));
    expect(output.info).toHaveBeenCalledWith(expect.stringContaining('2/3 vouches'));
    expect(output.info).toHaveBeenCalledWith(expect.stringContaining('claimable at quorum'));

    expect(mocks.recordIdempotentResult).toHaveBeenCalledWith(
      ORG_ID, 'vouch.for', 'idem-key',
      expect.objectContaining({ wearer: WEARER, hat: '123', newCount: 2 }),
      900,
    );
  });

  it('quorum reached: points the wearer at pop vouch claim (claim-based, no auto-mint)', async () => {
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xdef',
      explorerUrl: 'https://explorer/tx/0xdef',
      logs: [{ name: 'Vouched', args: { newCount: ethers.BigNumber.from(3) } }],
    });

    await forHandler.handler(baseArgv());

    expect(output.info).toHaveBeenCalledWith(expect.stringContaining('Quorum reached (3/3)'));
    expect(output.info).toHaveBeenCalledWith(expect.stringContaining('pop vouch claim --hat 123'));
  });

  it('--no-preflight: skips the gate reads and goes straight to the tx', async () => {
    const reader = fakeReader();
    mocks.createReadContract.mockReturnValue(reader);

    await forHandler.handler(baseArgv({ preflight: false }));

    expect(reader.canUserVouch).not.toHaveBeenCalled();
    expect(reader.getVouchConfig).not.toHaveBeenCalled();
    expect(mocks.runPreflight).toHaveBeenCalledWith(expect.anything(), expect.any(Array), { skip: true });
    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
  });

  it('idempotency cache hit: returns the prior result without re-sending', async () => {
    mocks.checkIdempotencyCache.mockReturnValue({ wearer: WEARER, hat: '123', txHash: '0xold' });

    await forHandler.handler(baseArgv());

    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(mocks.recordIdempotentResult).not.toHaveBeenCalled();
    expect(output.success).toHaveBeenCalledWith(
      expect.stringContaining('idempotency cache hit'),
      expect.objectContaining({ txHash: '0xold', cached: true }),
    );
  });

  it('--dry-run: simulates without touching the idempotency cache', async () => {
    mocks.executeTx.mockResolvedValue({
      success: true,
      dryRun: true,
      gasEstimate: '90000',
      method: 'vouchFor',
      to: EM_ADDR,
    });

    await forHandler.handler(baseArgv({ dryRun: true }));

    expect(mocks.executeTx.mock.calls[0][3]).toEqual({ dryRun: true });
    expect(mocks.checkIdempotencyCache).not.toHaveBeenCalled();
    expect(mocks.recordIdempotentResult).not.toHaveBeenCalled();
    expect(output.success).toHaveBeenCalledWith(
      expect.stringContaining('DRY RUN'),
      expect.objectContaining({ method: 'vouchFor' }),
    );
  });
});
