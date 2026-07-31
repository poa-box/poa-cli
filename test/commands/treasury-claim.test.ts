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
 * The distribution itself is read SUBGRAPH-FIRST (the indexed Distribution
 * entity, same source as the sibling claim-mine) with getDistribution as the
 * fallback for a row the subgraph has not caught up with. Both arms are
 * exercised below, including the one that matters most: an unindexed
 * distribution must fall through to the chain, never render as "does not exist".
 *
 * command.ts runs REAL; the module seams (tx, signer, resolve, preflight,
 * createReadContract, subgraph, output) are mocked. createWriteContract stays
 * real so claimDistribution is verified against the synced PaymentManager ABI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  createReadContract: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
  query: vi.fn(),
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
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
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

/** The indexed Distribution entity, shaped exactly as the live Gnosis subgraph serves it. */
function indexedDistFixture(overrides: Record<string, any> = {}) {
  return {
    id: `${PM_ADDR.toLowerCase()}-3`,
    distributionId: '3',
    payoutToken: ethers.constants.AddressZero,
    totalAmount: ethers.utils.parseEther('100').toString(),
    totalClaimed: '0',
    checkpointBlock: '41000000',
    createdAtBlock: '41000500',
    merkleRoot: '0x' + '11'.repeat(32),
    status: 'Active',
    ...overrides,
  };
}

/** Serve this row for the by-id distribution query; `null` = not indexed yet. */
function installIndexedDistribution(distribution: any) {
  mocks.query.mockResolvedValue({ distribution });
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
    // Default: the distribution is NOT indexed, so this whole block exercises the
    // getDistribution FALLBACK arm. The subgraph-first arm has its own block below.
    installIndexedDistribution(null);
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

describe('pop treasury claim — the distribution comes from the subgraph first', () => {
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
    _setStreamsForTest(undefined, undefined, false);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);

    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      provider: {},
      address: WALLET,
      chainId: 100,
    });
    mocks.resolveOrgModules.mockResolvedValue({ orgId: ORG_ID, paymentManagerAddress: PM_ADDR });

    pmRead = {
      // Made to throw so any accidental use of the RPC arm fails loudly rather than
      // silently agreeing with the indexed row.
      getDistribution: vi.fn().mockRejectedValue(new Error('getDistribution must not be called')),
      hasClaimed: vi.fn().mockResolvedValue(false),
      isOptedOut: vi.fn().mockResolvedValue(false),
    };
    erc20Read = { decimals: vi.fn().mockResolvedValue(6), symbol: vi.fn().mockResolvedValue('USDC') };
    mocks.createReadContract.mockImplementation((_addr: string, abiName: string) =>
      abiName === 'PaymentManager' ? pmRead : erc20Read
    );
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.checkGasBalance.mockReturnValue({ label: 'gas balance' });
    installIndexedDistribution(indexedDistFixture());
    mocks.executeTx.mockResolvedValue({
      success: true, txHash: '0xabc', explorerUrl: 'https://explorer/tx/0xabc', logs: [],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    _setStreamsForTest();
  });

  it('reads the indexed Distribution by "<paymentManager>-<id>" and skips getDistribution', async () => {
    await claimHandler.handler(baseArgv());

    expect(pmRead.getDistribution).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('distribution(id: $id)'),
      { id: `${PM_ADDR.toLowerCase()}-3` },
      undefined
    );
    // The indexed payoutToken still drives amount encoding: native → 18 decimals.
    const [, , args] = mocks.executeTx.mock.calls[0];
    expect((args[1] as ethers.BigNumber).eq(ethers.utils.parseEther('12.5'))).toBe(true);
  });

  it('the indexed payoutToken drives the ERC20 decimals scaling (12.5 USDC → 12500000)', async () => {
    installIndexedDistribution(indexedDistFixture({ payoutToken: USDC }));

    await claimHandler.handler(baseArgv());

    const [, , args] = mocks.executeTx.mock.calls[0];
    expect((args[1] as ethers.BigNumber).toString()).toBe('12500000');
    expect(output.success).toHaveBeenCalledWith(
      'Claimed from distribution #3',
      expect.objectContaining({ symbol: 'USDC', token: USDC, amountWei: '12500000' })
    );
  });

  it('status "Finalized" is the finalized gate — fails fast before executeTx', async () => {
    installIndexedDistribution(indexedDistFixture({ status: 'Finalized' }));

    await expect(claimHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('finalized'), expect.anything());
  });

  it('a subgraph outage falls back to getDistribution instead of failing the claim', async () => {
    mocks.query.mockRejectedValue(new Error('502 bad gateway'));
    pmRead.getDistribution.mockResolvedValue(distFixture());

    await claimHandler.handler(baseArgv());

    expect(pmRead.getDistribution).toHaveBeenCalledWith(3);
    const [, , args] = mocks.executeTx.mock.calls[0];
    expect((args[1] as ethers.BigNumber).eq(ethers.utils.parseEther('12.5'))).toBe(true);
  });

  it('an unindexed distribution is NOT reported as missing — it resolves on-chain', async () => {
    // The regression this guards: `distribution(id:)` answers null for an id it has not seen,
    // and a just-created distribution is exactly when someone claims early.
    installIndexedDistribution(null);
    pmRead.getDistribution.mockResolvedValue(distFixture({ payoutToken: USDC }));

    await claimHandler.handler(baseArgv());

    expect(output.error).not.toHaveBeenCalled();
    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [, , args] = mocks.executeTx.mock.calls[0];
    expect((args[1] as ethers.BigNumber).toString()).toBe('12500000');
  });

  it('an opted-out wallet is BLOCKED before any transaction, not merely warned', async () => {
    // The deployed Gnosis PaymentManager still anchors finalizeDistribution at
    // checkpointBlock (proved by eth_call — see treasury-propose-finalize.test.ts),
    // which makes it a pre-L-19 build, and every source of that vintage reverts
    // OptedOut in claimDistribution. Warning instead would be doubly bad:
    // output.warn is a NO-OP under --json, so an agent gets no signal at all, and
    // the clean exit-4 precondition degrades into a gas-estimation failure.
    pmRead.isOptedOut.mockResolvedValue(true);

    await expect(claimHandler.handler(baseArgv())).rejects.toThrow();

    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('opted out'),
      expect.objectContaining({ suggestion: expect.stringContaining('pop treasury opt-in') })
    );
  });

  it('the indexed payoutToken is CHECKSUMMED in --json, matching the on-chain path byte for byte', async () => {
    // The subgraph stores addresses lowercased; ABI-decoded getDistribution()
    // yields EIP-55. Without normalising at the boundary the --json `token` value
    // silently changes case depending on whether the distribution happens to be
    // indexed, breaking any consumer doing an exact string compare.
    installIndexedDistribution(indexedDistFixture({ payoutToken: USDC.toLowerCase() }));

    await claimHandler.handler(baseArgv());

    expect(output.success).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ token: ethers.utils.getAddress(USDC) })
    );
  });

  it('hasClaimed and isOptedOut stay on-chain (revert predictor / unindexed entity)', async () => {
    await claimHandler.handler(baseArgv());

    expect(pmRead.hasClaimed).toHaveBeenCalledWith(3, WALLET);
    expect(pmRead.isOptedOut).toHaveBeenCalledWith(WALLET);
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
