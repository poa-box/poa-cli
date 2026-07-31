/**
 * pop vouch revoke — epoch-aware pre-flight.
 *
 * revokeVouch reverts HasNotVouched unless BOTH the raw `vouchers` record exists AND
 * the wearer's vouch epoch is current. hasVouched() only answers the first half — it is
 * a bare read of the mapping with no epoch filter — so after a configureVouching /
 * resetVouches / clearWearerVouches it still returns true while the transaction is
 * doomed. currentVouchCount() returns 0 for exactly that case (and a zero count also
 * makes the contract's `newCount = count - 1` underflow), so the pair predicts the
 * revert with no false blocks.
 *
 * These are WRITE paths: every gate here must exit EXIT.PRECONDITION *before* executeTx,
 * because a miss costs real gas on Gnosis mainnet.
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
import { revokeHandler } from '../../src/commands/vouch/revoke';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const EM_ADDR = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const WEARER = '0x4444444444444444444444444444444444444444';
const ORG_ID = '0x' + 'ab'.repeat(32);

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

/** The two reads behind readRevokeGate. */
function fakeReader(overrides: Record<string, any> = {}) {
  return {
    hasVouched: vi.fn(async () => true),
    currentVouchCount: vi.fn(async () => ethers.BigNumber.from(2)),
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

describe('pop vouch revoke — epoch-aware pre-flight', () => {
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
      logs: [{ name: 'VouchRevoked', args: { newCount: ethers.BigNumber.from(1) } }],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    _setStreamsForTest();
  });

  it('no vouch record at all: exits EXIT.PRECONDITION BEFORE executeTx', async () => {
    mocks.createReadContract.mockReturnValue(fakeReader({
      hasVouched: vi.fn(async () => false),
      currentVouchCount: vi.fn(async () => ethers.BigNumber.from(0)),
    }));

    await expect(revokeHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect((output.error as any).mock.calls[0][0]).toContain('have not vouched');
  });

  it('THE EPOCH CASE: hasVouched true but the tally is voided → blocked before tx', async () => {
    // configureVouching bumped the hat's epoch after this vouch was cast. The raw
    // `vouchers` mapping still holds the record, so hasVouched says true — but
    // revokeVouch would revert HasNotVouched on the epoch check.
    mocks.createReadContract.mockReturnValue(fakeReader({
      hasVouched: vi.fn(async () => true),
      currentVouchCount: vi.fn(async () => ethers.BigNumber.from(0)),
    }));

    await expect(revokeHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    const [message, details] = (output.error as any).mock.calls[0];
    expect(message).toContain('no longer counted');
    expect(details.suggestion).toContain('pop vouch status');
  });

  it('a live current-epoch vouch is NOT blocked — it broadcasts and reports newCount', async () => {
    await revokeHandler.handler(baseArgv());

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(mocks.executeTx.mock.calls[0][1]).toBe('revokeVouch');
    expect(mocks.executeTx.mock.calls[0][2]).toEqual([WEARER, '123']);
  });

  it('--no-preflight skips both gates so a doomed revoke can still be forced', async () => {
    mocks.createReadContract.mockReturnValue(fakeReader({
      hasVouched: vi.fn(async () => false),
      currentVouchCount: vi.fn(async () => ethers.BigNumber.from(0)),
    }));

    await revokeHandler.handler(baseArgv({ preflight: false }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
  });
});
