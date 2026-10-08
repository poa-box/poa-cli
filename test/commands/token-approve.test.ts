/**
 * pop token approve — the DESTRUCTIVE confirmation gate.
 *
 * approveRequest MINTS tokens irreversibly, so confirmWrite runs with
 * destructive: true:
 *   - non-TTY without --yes → refuse (AbortedError, exit EXIT.ABORTED),
 *     executeTx never called (unlike non-destructive writes, which pass
 *     silently in non-TTY)
 *   - --yes (or JSON mode) → proceed
 * Pre-flight mirrors the contract's RequestUnknown / AlreadyApproved /
 * NotRequester (self-approval) gates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
  readTokenGates: vi.fn(),
  readTokenRequest: vi.fn(),
  checkTokenPermission: vi.fn(),
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
vi.mock('../../src/commands/token/helpers', () => ({
  readTokenGates: mocks.readTokenGates,
  readTokenRequest: mocks.readTokenRequest,
  checkTokenPermission: mocks.checkTokenPermission,
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
import { AUTHORITY_KEYS } from '../../packages/core/src/tx/authority';
import { approveHandler } from '../../src/commands/token/approve';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const TOKEN_ADDR = '0x8888888888888888888888888888888888888888';
const HATS_ADDR = '0x9999999999999999999999999999999999999999';
const EXECUTOR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WALLET = '0x2222222222222222222222222222222222222222';
const REQUESTER = '0x3333333333333333333333333333333333333333';
const ORG_ID = '0x' + 'ab'.repeat(32);

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

function requestFixture(overrides: Record<string, any> = {}) {
  return {
    requester: REQUESTER,
    amount: ethers.utils.parseEther('10'),
    approved: false,
    ipfsHash: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    exists: true,
    ...overrides,
  };
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    request: 3,
    yes: false,
    preflight: true,
    dryRun: false,
    ...overrides,
  };
}

describe('pop token approve — destructive gate + mint pre-flight', () => {
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
      chainId: 100,
    });
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      participationTokenAddress: TOKEN_ADDR,
    });
    mocks.readTokenRequest.mockResolvedValue(requestFixture());
    mocks.readTokenGates.mockResolvedValue({
      authorityAddress: HATS_ADDR,
      executor: EXECUTOR,
      memberHatIds: [ethers.BigNumber.from(1)],
      approverHatIds: [ethers.BigNumber.from(2)],
    });
    mocks.checkTokenPermission.mockReturnValue({ label: 'approver role (approver hat)' });
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

  it('non-TTY without --yes: REFUSES (exit EXIT.ABORTED) because approval mints — executeTx never runs', async () => {
    await expect(approveHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.ABORTED);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('destructive'),
      expect.anything()
    );
  });

  it('--yes: proceeds through the destructive gate and sends approveRequest(id)', async () => {
    await approveHandler.handler(baseArgv({ yes: true }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('approveRequest');
    expect(args).toEqual([3]);
    // Real ParticipationToken ABI wired through createWriteContract
    expect(() => contract.interface.getFunction('approveRequest')).not.toThrow();

    expect(output.success).toHaveBeenCalledWith(
      'Request #3 approved',
      expect.objectContaining({
        requestId: 3,
        requester: REQUESTER,
        mintedWei: ethers.utils.parseEther('10').toString(),
      })
    );
  });

  it('pre-flight fail-fast: self-approval exits EXIT.PRECONDITION before the destructive gate', async () => {
    mocks.readTokenRequest.mockResolvedValue(requestFixture({ requester: WALLET }));

    await expect(approveHandler.handler(baseArgv({ yes: true }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('your own request'), expect.anything());
  });

  it('pre-flight fail-fast: already-approved and unknown requests exit EXIT.PRECONDITION', async () => {
    mocks.readTokenRequest.mockResolvedValue(requestFixture({ approved: true }));
    await expect(approveHandler.handler(baseArgv({ yes: true }))).rejects.toBeInstanceOf(ExitError);
    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);

    mocks.readTokenRequest.mockResolvedValue(requestFixture({ requester: ethers.constants.AddressZero, exists: false }));
    await expect(approveHandler.handler(baseArgv({ yes: true }))).rejects.toBeInstanceOf(ExitError);
    expect(exitSpy.mock.calls[1][0]).toBe(EXIT.PRECONDITION);

    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('approver-hat check is wired into the pre-flight for non-executor signers', async () => {
    await approveHandler.handler(baseArgv({ yes: true }));

    expect(mocks.checkTokenPermission).toHaveBeenCalledWith(HATS_ADDR, WALLET, AUTHORITY_KEYS.PT_APPROVE);
    const checks = mocks.runPreflight.mock.calls[0][1];
    expect(checks).toHaveLength(2); // gas + approver hat
  });
});
