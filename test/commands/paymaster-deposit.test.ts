/**
 * pop paymaster deposit — ether-parse of --amount into the tx VALUE, and the
 * registered-org pre-flight.
 *
 * depositForOrg(bytes32) is payable + permissionless (verified against
 * contracts origin/main src/PaymasterHub.sol) — the amount travels as
 * msg.value, NOT as a function argument. It reverts OrgNotRegistered when
 * the org has no paymaster config, which the pre-flight fails fast on
 * (exit 4) before any gas is spent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
  resolvePaymasterInfra: vi.fn(),
  readPaymasterOrgConfig: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/signer', () => ({ createSigner: mocks.createSigner }));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => modules[key],
}));
vi.mock('../../src/lib/preflight', () => ({
  runPreflight: mocks.runPreflight,
  checkGasBalance: mocks.checkGasBalance,
}));
vi.mock('../../src/commands/paymaster/helpers', () => ({
  resolvePaymasterInfra: mocks.resolvePaymasterInfra,
  readPaymasterOrgConfig: mocks.readPaymasterOrgConfig,
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
import { depositHandler, parseDepositAmount } from '../../src/commands/paymaster/deposit';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { CliError } from '../../src/lib/errors';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const HUB_ADDR = '0x6666666666666666666666666666666666666666';
const WALLET = '0x2222222222222222222222222222222222222222';
const ORG_ID = '0x' + 'ab'.repeat(32);

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

function orgConfigFixture(overrides: Record<string, any> = {}) {
  return {
    adminHatId: ethers.BigNumber.from('123'),
    operatorHatId: ethers.BigNumber.from(0),
    paused: false,
    registeredAt: 1700000000,
    bannedFromSolidarity: false,
    registered: true,
    ...overrides,
  };
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    amount: '0.05',
    yes: false,
    preflight: true,
    dryRun: false,
    ...overrides,
  };
}

describe('pop paymaster deposit — value encoding + registration pre-flight', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _clearWriteContextCacheForTest();
    _setStreamsForTest(undefined, undefined, false); // non-TTY
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);

    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      provider: {},
      address: WALLET,
      chainId: 100,
    });
    mocks.resolveOrgModules.mockResolvedValue({ orgId: ORG_ID });
    mocks.resolvePaymasterInfra.mockResolvedValue({
      paymasterHubAddress: HUB_ADDR,
      poaManagerAddress: '0x7777777777777777777777777777777777777777',
    });
    mocks.readPaymasterOrgConfig.mockResolvedValue(orgConfigFixture());
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

  it('--amount 0.05 travels as the tx VALUE (parseEther), with orgId as the only argument', async () => {
    await depositHandler.handler(baseArgv());

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args, opts] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('depositForOrg');
    expect(args).toEqual([ORG_ID]); // amount is NOT an argument — payable value only
    expect(opts.value.eq(ethers.utils.parseEther('0.05'))).toBe(true);
    expect(opts.dryRun).toBe(false);
    // Real PaymasterHub ABI wired through createWriteContract
    expect(() => contract.interface.getFunction('depositForOrg')).not.toThrow();

    // Gas check covers the deposit value + headroom
    const gasMin = mocks.checkGasBalance.mock.calls[0][1] as ethers.BigNumber;
    expect(gasMin.eq(ethers.utils.parseEther('0.0501'))).toBe(true);

    // Non-TTY + non-destructive: silent pass-through (no --yes needed)
    expect(output.success).toHaveBeenCalledWith(
      expect.stringContaining('Deposited'),
      expect.objectContaining({ orgId: ORG_ID, amountWei: ethers.utils.parseEther('0.05').toString() })
    );
  });

  it('pre-flight fail-fast: unregistered org exits EXIT.PRECONDITION before executeTx', async () => {
    mocks.readPaymasterOrgConfig.mockResolvedValue(orgConfigFixture({
      adminHatId: ethers.BigNumber.from(0),
      registered: false,
    }));

    await expect(depositHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('not registered'),
      expect.objectContaining({ suggestion: expect.stringContaining('pop paymaster register') })
    );
  });

  it('--no-preflight skips the registration read and goes straight to the tx', async () => {
    await depositHandler.handler(baseArgv({ preflight: false }));

    expect(mocks.readPaymasterOrgConfig).not.toHaveBeenCalled();
    expect(mocks.runPreflight).toHaveBeenCalledWith(expect.anything(), expect.any(Array), { skip: true });
    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
  });
});

describe('parseDepositAmount (pure)', () => {
  it('parses ether units', () => {
    expect(parseDepositAmount('0.05').eq(ethers.utils.parseEther('0.05'))).toBe(true);
    expect(parseDepositAmount(1).eq(ethers.utils.parseEther('1'))).toBe(true);
  });

  it('rejects zero (contract reverts ZeroAmount) and garbage', () => {
    expect(() => parseDepositAmount('0')).toThrow(CliError);
    expect(() => parseDepositAmount('not-a-number')).toThrow(CliError);
  });
});
