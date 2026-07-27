/**
 * pop treasury claim — human-units amount encoding + --wei escape hatch.
 *
 * The claim amount must match the merkle leaf EXACTLY, so the conversion
 * layer is the correctness-critical part:
 *   - default: --amount is decimal TOKEN units, scaled by the payout token's
 *     decimals (native = 18; ERC20 = live decimals() read)
 *   - --wei: --amount is the raw integer, sent verbatim (no distribution
 *     read needed when pre-flight is disabled)
 *
 * Pre-flight mirrors the contract's claim gates (finalized / hasClaimed /
 * isOptedOut) and fails fast (exit 4) BEFORE executeTx.
 *
 * command.ts runs REAL; the module seams (tx, signer, resolve, preflight,
 * createReadContract, output) are mocked. createWriteContract stays real so
 * claimDistribution is verified against the synced PaymentManager ABI.
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
import { claimHandler, parseClaimAmount, parseProof } from '../../src/commands/treasury/claim';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { CliError } from '../../src/lib/errors';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const PM_ADDR = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const USDC = '0x4444444444444444444444444444444444444444';
const ORG_ID = '0x' + 'ab'.repeat(32);
const PROOF = ['0x' + 'cd'.repeat(32), '0x' + 'ef'.repeat(32)];

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

function distFixture(overrides: Record<string, any> = {}) {
  return {
    payoutToken: ethers.constants.AddressZero,
    totalAmount: ethers.utils.parseEther('100'),
    checkpointBlock: ethers.BigNumber.from(41000000),
    merkleRoot: '0x' + '11'.repeat(32),
    totalClaimed: ethers.BigNumber.from(0),
    finalized: false,
    ...overrides,
  };
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    distribution: 3,
    amount: '12.5',
    proof: JSON.stringify(PROOF),
    wei: false,
    yes: false,
    preflight: true,
    dryRun: false,
    ...overrides,
  };
}

describe('pop treasury claim — amount encoding + fail-fast pre-flight', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let pmRead: {
    getDistribution: ReturnType<typeof vi.fn>;
    hasClaimed: ReturnType<typeof vi.fn>;
    isOptedOut: ReturnType<typeof vi.fn>;
  };
  let erc20Read: { decimals: ReturnType<typeof vi.fn>; symbol: ReturnType<typeof vi.fn> };

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
      chainId: 100,
    });
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      paymentManagerAddress: PM_ADDR,
    });

    pmRead = {
      getDistribution: vi.fn().mockResolvedValue(distFixture()),
      hasClaimed: vi.fn().mockResolvedValue(false),
      isOptedOut: vi.fn().mockResolvedValue(false),
    };
    erc20Read = {
      decimals: vi.fn().mockResolvedValue(6),
      symbol: vi.fn().mockResolvedValue('USDC'),
    };
    mocks.createReadContract.mockImplementation((_addr: string, abiName: string) =>
      abiName === 'PaymentManager' ? pmRead : erc20Read
    );

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

  it('native payout: --amount 12.5 encodes as 18-decimal wei matching the merkle leaf', async () => {
    await claimHandler.handler(baseArgv());

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('claimDistribution');
    expect(args[0]).toBe(3);
    expect((args[1] as ethers.BigNumber).eq(ethers.utils.parseEther('12.5'))).toBe(true);
    expect(args[2]).toEqual(PROOF);
    // Real PaymentManager ABI wired through createWriteContract
    expect(() => contract.interface.getFunction('claimDistribution')).not.toThrow();

    expect(output.success).toHaveBeenCalledWith(
      'Claimed from distribution #3',
      expect.objectContaining({
        distributionId: 3,
        amountWei: ethers.utils.parseEther('12.5').toString(),
        token: 'native',
      })
    );
  });

  it('ERC20 payout: the live decimals() read scales --amount (12.5 USDC → 12500000)', async () => {
    pmRead.getDistribution.mockResolvedValue(distFixture({ payoutToken: USDC }));

    await claimHandler.handler(baseArgv());

    const [, , args] = mocks.executeTx.mock.calls[0];
    expect((args[1] as ethers.BigNumber).toString()).toBe('12500000'); // 12.5 * 10^6
    expect(output.success).toHaveBeenCalledWith(
      'Claimed from distribution #3',
      expect.objectContaining({ symbol: 'USDC', token: USDC, amountWei: '12500000' })
    );
  });

  it('--wei bypasses decimals entirely: the raw integer goes on-chain verbatim', async () => {
    await claimHandler.handler(baseArgv({ amount: '12500000000000000001', wei: true }));

    const [, , args] = mocks.executeTx.mock.calls[0];
    expect((args[1] as ethers.BigNumber).toString()).toBe('12500000000000000001');
  });

  it('--wei + --no-preflight never reads the distribution (no decimals needed)', async () => {
    await claimHandler.handler(baseArgv({ amount: '42', wei: true, preflight: false }));

    expect(pmRead.getDistribution).not.toHaveBeenCalled();
    expect(mocks.runPreflight).toHaveBeenCalledWith(expect.anything(), expect.any(Array), { skip: true });
    const [, , args] = mocks.executeTx.mock.calls[0];
    expect((args[1] as ethers.BigNumber).toString()).toBe('42');
  });

  it('pre-flight fail-fast: finalized distribution exits EXIT.PRECONDITION before executeTx', async () => {
    pmRead.getDistribution.mockResolvedValue(distFixture({ finalized: true }));

    await expect(claimHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('finalized'), expect.anything());
  });

  it('pre-flight fail-fast: already-claimed exits EXIT.PRECONDITION before executeTx', async () => {
    pmRead.hasClaimed.mockResolvedValue(true);

    await expect(claimHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('already claimed'), expect.anything());
  });
});

describe('parseClaimAmount / parseProof (pure)', () => {
  it('scales decimal amounts by the token decimals', () => {
    expect(parseClaimAmount('12.5', false, 6).toString()).toBe('12500000');
    expect(parseClaimAmount('12.5', false, 18).eq(ethers.utils.parseEther('12.5'))).toBe(true);
  });

  it('--wei requires a raw integer', () => {
    expect(parseClaimAmount('42', true, 18).toString()).toBe('42');
    expect(() => parseClaimAmount('1.5', true, 18)).toThrow(CliError);
  });

  it('rejects amounts with more precision than the token has', () => {
    expect(() => parseClaimAmount('0.0000001', false, 6)).toThrow(CliError);
  });

  it('parseProof accepts an array file or an allocation object with a proof field', () => {
    expect(parseProof(JSON.stringify(PROOF), undefined)).toEqual(PROOF);
    expect(() => parseProof(undefined, undefined)).toThrow(CliError);
    expect(() => parseProof('["0xnothex"]', undefined)).toThrow(CliError);
  });
});
