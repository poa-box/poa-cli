/**
 * Audit M-03 callStatic simulation gate — `pop role eligibility set-default`
 * and `pop vouch config set` (commit e339237).
 *
 * When the on-chain STATE conflicts (vouching + combine-hierarchy on one side,
 * default-eligible on the other), state alone must not block: the deployed v6
 * modules ACCEPT the write (verified live on Gnosis — 17/19 VouchConfig rows
 * sit in the "conflicting" state). The commands therefore simulate the exact
 * write via callStatic and gate on ITS outcome:
 *
 *   - simulation SUCCEEDS      → warn that the quorum becomes a no-op, proceed
 *   - CONTRACT revert          → PreconditionError, no transaction
 *     (CALL_EXCEPTION / UNPREDICTABLE_GAS_LIMIT — the module enforces M-03)
 *   - TRANSPORT failure        → note it via debug and proceed; an RPC blip
 *     must never block a valid write (that false positive is the whole reason
 *     the simulation exists)
 *
 * command.ts composition (getWriteContext/confirmWrite/finishWrite) and the
 * vouchConflictsWithDefaultEligibility predicate run REAL; the seams are tx,
 * signer, resolve, contracts, preflight, the vouch-helper superAdmin reads,
 * and output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  createSigner: vi.fn(),
  createProvider: vi.fn(),
  resolveOrgModules: vi.fn(),
  createReadContract: vi.fn(),
  createWriteContract: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
  requireSuperAdmin: vi.fn(),
  requireSuperAdminWithRead: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/signer', () => ({
  createSigner: mocks.createSigner,
  createProvider: mocks.createProvider,
}));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => modules[key],
}));
vi.mock('../../src/lib/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/contracts')>();
  return {
    ...actual,
    createReadContract: mocks.createReadContract,
    createWriteContract: mocks.createWriteContract,
  };
});
vi.mock('../../src/lib/preflight', () => ({
  runPreflight: mocks.runPreflight,
  checkGasBalance: mocks.checkGasBalance,
}));
vi.mock('../../src/commands/vouch/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/commands/vouch/helpers')>();
  return {
    ...actual,
    requireSuperAdmin: mocks.requireSuperAdmin,
    requireSuperAdminWithRead: mocks.requireSuperAdminWithRead,
  };
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
    keyValueBlock: vi.fn(),
    isJsonMode: vi.fn(() => false),
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import { eligibilitySetDefaultHandler } from '../../src/commands/role/eligibility';
import { configSetHandler } from '../../src/commands/vouch/config';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const EM_ADDR = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const ORG_ID = '0x' + 'ab'.repeat(32);
const HAT = '123';
const MEMBERSHIP_HAT = '45';

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

/** RPC-style rejection with an ethers/JSON-RPC error code attached. */
function rpcError(code: string, message: string): any {
  const err: any = new Error(message);
  err.code = code;
  return err;
}

/** Live Gnosis conflicting state: flags 3 (enabled|combine), quorum 1. */
const CONFLICTING_VOUCH_CONFIG = {
  quorum: 1,
  membershipHatId: ethers.BigNumber.from(MEMBERSHIP_HAT),
  flags: 3,
};

function setDefaultArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    hat: HAT,
    eligible: true,
    standing: true,
    yes: true,
    preflight: true,
    dryRun: false,
    ...overrides,
  };
}

function configSetArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    hat: HAT,
    quorum: 2,
    'membership-hat': MEMBERSHIP_HAT,
    combineHierarchy: true,
    yes: true,
    preflight: true,
    dryRun: false,
    ...overrides,
  };
}

describe('M-03 callStatic gate', () => {
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
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.checkGasBalance.mockReturnValue({ label: 'gas balance' });
    mocks.createWriteContract.mockReturnValue({});
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

  // ─────────────── role eligibility set-default ───────────────

  describe('pop role eligibility set-default (conflicting vouch state)', () => {
    let sim: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mocks.requireSuperAdminWithRead.mockResolvedValue({
        admin: WALLET,
        extra: CONFLICTING_VOUCH_CONFIG,
        extraError: null,
      });
      sim = vi.fn();
      mocks.createReadContract.mockReturnValue({ callStatic: { setDefaultEligibility: sim } });
    });

    it('simulation resolves: warns the quorum becomes a no-op and STILL sends the tx', async () => {
      sim.mockResolvedValue('0x');

      await eligibilitySetDefaultHandler.handler(setDefaultArgv());

      // The pre-flight batched superAdmin + getVouchConfig into one read
      expect(mocks.requireSuperAdminWithRead).toHaveBeenCalledWith(
        expect.anything(), EM_ADDR, WALLET, expect.any(String),
        expect.objectContaining({ fn: 'getVouchConfig' }),
      );
      // The EXACT write was simulated from the signer's address
      expect(sim).toHaveBeenCalledWith(ethers.BigNumber.from(HAT), true, true, { from: WALLET });

      expect(output.warn).toHaveBeenCalledWith(expect.stringContaining('accepts the write anyway'));
      expect(output.warn).toHaveBeenCalledWith(expect.stringContaining('quorum 1'));
      expect(mocks.executeTx).toHaveBeenCalledTimes(1);
      const [, method, args] = mocks.executeTx.mock.calls[0];
      expect(method).toBe('setDefaultEligibility');
      expect(args[0].toString()).toBe(HAT);
      expect(args[1]).toBe(true);
      expect(args[2]).toBe(true);
    });

    it('simulation reverts (CALL_EXCEPTION): PreconditionError, executeTx NEVER called', async () => {
      sim.mockRejectedValue(rpcError('CALL_EXCEPTION', 'execution reverted'));

      await expect(eligibilitySetDefaultHandler.handler(setDefaultArgv())).rejects.toBeInstanceOf(ExitError);

      expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
      const [message, details] = (output.error as any).mock.calls[0];
      expect(message).toContain('the module rejects it');
      expect(details.suggestion).toContain(`pop vouch config set --hat ${HAT} --quorum 0`);
      expect(mocks.executeTx).not.toHaveBeenCalled();
    });

    it('simulation reverts (UNPREDICTABLE_GAS_LIMIT): also treated as a contract revert', async () => {
      sim.mockRejectedValue(rpcError('UNPREDICTABLE_GAS_LIMIT', 'cannot estimate gas'));

      await expect(eligibilitySetDefaultHandler.handler(setDefaultArgv())).rejects.toBeInstanceOf(ExitError);

      expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
      expect(mocks.executeTx).not.toHaveBeenCalled();
    });

    it('simulation fails at the TRANSPORT layer (SERVER_ERROR): debug note, tx proceeds', async () => {
      sim.mockRejectedValue(rpcError('SERVER_ERROR', 'bad response (502)'));

      await eligibilitySetDefaultHandler.handler(setDefaultArgv());

      expect(output.debug).toHaveBeenCalledWith(expect.stringContaining('M-03 simulation unavailable'));
      expect(output.error).not.toHaveBeenCalled();
      expect(mocks.executeTx).toHaveBeenCalledTimes(1);
      expect(mocks.executeTx.mock.calls[0][1]).toBe('setDefaultEligibility');
    });
  });

  // ─────────────── vouch config set ───────────────

  describe('pop vouch config set --combine-hierarchy (default-eligible hat)', () => {
    let sim: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // getDefaultRules → eligible=true: the conflicting state on this side
      mocks.requireSuperAdminWithRead.mockResolvedValue({
        admin: WALLET,
        extra: { eligible: true, standing: true },
        extraError: null,
      });
      sim = vi.fn();
      mocks.createReadContract.mockReturnValue({ callStatic: { configureVouching: sim } });
    });

    it('simulation resolves: warns the quorum has no effect and STILL sends the tx', async () => {
      sim.mockResolvedValue('0x');

      await configSetHandler.handler(configSetArgv());

      expect(mocks.requireSuperAdminWithRead).toHaveBeenCalledWith(
        expect.anything(), EM_ADDR, WALLET, expect.any(String),
        expect.objectContaining({ fn: 'getDefaultRules' }),
      );
      expect(sim).toHaveBeenCalledWith(
        ethers.BigNumber.from(HAT), 2, ethers.BigNumber.from(MEMBERSHIP_HAT), true, { from: WALLET },
      );

      expect(output.warn).toHaveBeenCalledWith(expect.stringContaining('accepts the write anyway'));
      expect(mocks.executeTx).toHaveBeenCalledTimes(1);
      const [, method, args] = mocks.executeTx.mock.calls[0];
      expect(method).toBe('configureVouching');
      expect(args[0].toString()).toBe(HAT);
      expect(args[1]).toBe(2);
      expect(args[2].toString()).toBe(MEMBERSHIP_HAT);
      expect(args[3]).toBe(true);
    });

    it('simulation reverts (CALL_EXCEPTION): PreconditionError, executeTx NEVER called', async () => {
      sim.mockRejectedValue(rpcError('CALL_EXCEPTION', 'execution reverted'));

      await expect(configSetHandler.handler(configSetArgv())).rejects.toBeInstanceOf(ExitError);

      expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
      const [message, details] = (output.error as any).mock.calls[0];
      expect(message).toContain('the module rejects it');
      expect(details.suggestion).toContain('--no-eligible');
      expect(mocks.executeTx).not.toHaveBeenCalled();
    });

    it('simulation fails at the TRANSPORT layer (SERVER_ERROR): debug note, tx proceeds', async () => {
      sim.mockRejectedValue(rpcError('SERVER_ERROR', 'bad response (502)'));

      await configSetHandler.handler(configSetArgv());

      expect(output.debug).toHaveBeenCalledWith(expect.stringContaining('M-03 simulation unavailable'));
      expect(output.error).not.toHaveBeenCalled();
      expect(mocks.executeTx).toHaveBeenCalledTimes(1);
      expect(mocks.executeTx.mock.calls[0][1]).toBe('configureVouching');
    });
  });
});
