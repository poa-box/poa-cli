/**
 * pop role create — CreateHatParams tuple order + superAdmin pre-check.
 *
 * The load-bearing assertion: the params array the handler builds is
 * encoded THEN decoded through the REAL EligibilityModuleNew ABI, and each
 * named component (parentHatId, details, maxSupply, _mutable, imageURI,
 * defaultEligible, defaultStanding, mintToAddresses, wearerEligibleFlags,
 * wearerStandingFlags) is asserted — a shuffled tuple cannot pass.
 *
 * superAdmin pre-check: when the signer is not superAdmin(), the command
 * exits EXIT.PRECONDITION BEFORE executeTx and the error NAMES the actual
 * superAdmin address.
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
import { createHandler, parseMintTo } from '../../src/commands/role/create';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const EM_ADDR = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const SUPER = '0x3333333333333333333333333333333333333333';
const MINT_A = ethers.utils.getAddress('0x' + 'aa'.repeat(20));
const MINT_B = ethers.utils.getAddress('0x' + 'bb'.repeat(20));
const ORG_ID = '0x' + 'ab'.repeat(32);

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
    'parent-hat': '77',
    parentHat: '77',
    name: 'Reviewer',
    'max-supply': 500,
    maxSupply: 500,
    mutable: true,
    'default-eligible': false,
    defaultEligible: false,
    'default-standing': true,
    defaultStanding: true,
    image: 'ipfs://img',
    'mint-to': `${MINT_A},${MINT_B}`,
    mintTo: `${MINT_A},${MINT_B}`,
    yes: true,
    preflight: true,
    noIdempotency: false,
    dryRun: false,
    ...overrides,
  };
}

describe('pop role create — ABI tuple order + superAdmin gate', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

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
      chainId: 11155111,
    });
    mocks.resolveOrgModules.mockResolvedValue({ orgId: ORG_ID, eligibilityModuleAddress: EM_ADDR });
    mocks.createReadContract.mockReturnValue({ superAdmin: vi.fn(async () => WALLET) });
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.checkGasBalance.mockReturnValue({ label: 'gas balance' });
    mocks.checkIdempotencyCache.mockReturnValue(null);
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xabc',
      explorerUrl: 'https://explorer/tx/0xabc',
      logs: [{
        name: 'HatCreatedWithEligibility',
        args: {
          creator: WALLET,
          parentHatId: ethers.BigNumber.from(77),
          newHatId: ethers.BigNumber.from('999'),
          defaultEligible: false,
          defaultStanding: true,
          mintedCount: ethers.BigNumber.from(2),
        },
      }],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    _setStreamsForTest();
  });

  it('encodes CreateHatParams in exact ABI order (encode → decode round-trip on the real ABI)', async () => {
    await createHandler.handler(baseArgv());

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('createHatWithEligibility');
    expect(args).toHaveLength(1); // single tuple param

    // Round-trip through the REAL ABI: a wrong component order would either
    // throw at encode time or land values in the wrong named fields here.
    const calldata = contract.interface.encodeFunctionData(method, args);
    const [decoded] = contract.interface.decodeFunctionData(method, calldata);

    expect(decoded.parentHatId.toString()).toBe('77');
    expect(decoded.details).toBe('Reviewer');
    expect(decoded.maxSupply).toBe(500);
    expect(decoded._mutable).toBe(true);
    expect(decoded.imageURI).toBe('ipfs://img');
    expect(decoded.defaultEligible).toBe(false);
    expect(decoded.defaultStanding).toBe(true);
    expect(decoded.mintToAddresses).toEqual([MINT_A, MINT_B]);
    expect(decoded.wearerEligibleFlags).toEqual([true, true]);
    expect(decoded.wearerStandingFlags).toEqual([true, true]);
  });

  it('parses HatCreatedWithEligibility for the new hat ID and records idempotency', async () => {
    await createHandler.handler(baseArgv());

    expect(output.success).toHaveBeenCalledWith('Role "Reviewer" created — hat 999', expect.objectContaining({
      hatId: '999',
      parentHat: '77',
      mintedCount: 2,
      txHash: '0xabc',
    }));
    expect(mocks.recordIdempotentResult).toHaveBeenCalledWith(
      ORG_ID, 'role.create', 'idem-key',
      expect.objectContaining({ hatId: '999', name: 'Reviewer' }),
      900,
    );
  });

  it('superAdmin mismatch: exits EXIT.PRECONDITION BEFORE tx, naming the actual superAdmin', async () => {
    mocks.createReadContract.mockReturnValue({ superAdmin: vi.fn(async () => SUPER) });

    await expect(createHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    const [message, details] = (output.error as any).mock.calls[0];
    expect(message).toContain(SUPER);   // the actual superAdmin is named
    expect(message).toContain(WALLET);  // and who you are signing as
    expect(details.suggestion).toContain('superAdmin');
  });

  it('omitted optional flags: defaults land as empty image, no mints, empty flag arrays', async () => {
    await createHandler.handler(baseArgv({
      image: undefined,
      'mint-to': undefined,
      mintTo: undefined,
      mutable: false,
      'default-standing': false,
      defaultStanding: false,
    }));

    const [contract, method, args] = mocks.executeTx.mock.calls[0];
    const calldata = contract.interface.encodeFunctionData(method, args);
    const [decoded] = contract.interface.decodeFunctionData(method, calldata);

    expect(decoded.imageURI).toBe('');
    expect(decoded._mutable).toBe(false);
    expect(decoded.defaultStanding).toBe(false);
    expect(decoded.mintToAddresses).toEqual([]);
    expect(decoded.wearerEligibleFlags).toEqual([]);
    expect(decoded.wearerStandingFlags).toEqual([]);
  });

  it('invalid --max-supply: usage error before any signer work', async () => {
    await expect(createHandler.handler(baseArgv({ 'max-supply': -5, maxSupply: -5 })))
      .rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('parseMintTo: splits, trims, and checksums comma-separated addresses', () => {
    expect(parseMintTo(undefined)).toEqual([]);
    expect(parseMintTo(` ${MINT_A.toLowerCase()} , ${MINT_B.toLowerCase()} `)).toEqual([MINT_A, MINT_B]);
    expect(() => parseMintTo('0xnotanaddress')).toThrow(/Invalid address/);
  });
});
