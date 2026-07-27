/**
 * pop education complete — fail-fast pre-flight for the two knowable
 * reverts (VERIFIED contracts origin/main src/EducationHub.sol):
 *   - getModule(id) reverts ModuleUnknown for unknown ids → "module exists"
 *     check treats an unsuccessful call as not-found,
 *   - completeModule reverts AlreadyCompleted on a second attempt →
 *     hasCompleted(learner, id) pre-check says "already completed" BEFORE gas.
 *
 * The interpret functions are exercised directly with real ABI-encoded
 * payloads (they are what Multicall3 hands back), plus a handler wiring test
 * confirming the checks ride into runPreflight and completeModule(id, answer)
 * goes out with uint8 semantics.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  runPreflight: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/signer', () => ({ createSigner: mocks.createSigner }));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => {
    if (!modules?.[key]) throw new Error(`missing module ${key}`);
    return modules[key];
  },
}));
vi.mock('../../src/lib/preflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/preflight')>();
  return { ...actual, runPreflight: mocks.runPreflight };
});
vi.mock('../../src/lib/idempotency', () => ({
  argvToIdempotencyString: vi.fn(() => 'idem-key'),
  checkIdempotencyCache: vi.fn(() => null),
  recordIdempotentResult: vi.fn(),
  resolveTtlSeconds: vi.fn(() => 900),
}));
vi.mock('../../src/lib/prompt', () => ({
  isInteractive: () => false,
  confirm: vi.fn(),
  input: vi.fn(),
  select: vi.fn(),
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
    debug: vi.fn(),
    json: vi.fn(),
    keyValueBlock: vi.fn(),
    isJsonMode: vi.fn(() => false),
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import { completeHandler } from '../../src/commands/education/complete';
import { checkModuleExists, checkNotCompleted, EDU_READ_IFACE } from '../../src/commands/education/helpers';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { PreconditionError } from '../../src/lib/errors';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const HUB_ADDR = '0x7777777777777777777777777777777777777777';
const WALLET = '0x2222222222222222222222222222222222222222';
const ORG_ID = '0x' + 'ab'.repeat(32);

const abi = ethers.utils.defaultAbiCoder;

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

describe('education pre-flight checks (helpers)', () => {
  it('checkModuleExists: encodes getModule(id) against the hub', () => {
    const check = checkModuleExists(HUB_ADDR, '2');
    expect(check.label).toBe('module 2');
    expect(check.call!.to).toBe(HUB_ADDR);
    expect(check.call!.data).toBe(EDU_READ_IFACE.encodeFunctionData('getModule', [ethers.BigNumber.from(2)]));
  });

  it('checkModuleExists: a reverted call IS the not-found signal (getModule reverts ModuleUnknown)', () => {
    const check = checkModuleExists(HUB_ADDR, 2);
    const result = check.interpret!('0x', false);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('does not exist');
    expect(result.suggestion).toContain('pop education list');
  });

  it('checkModuleExists: exists=true passes, exists=false fails', () => {
    const check = checkModuleExists(HUB_ADDR, 2);
    const existing = abi.encode(['uint256', 'bool'], [ethers.utils.parseUnits('5', 18), true]);
    expect(check.interpret!(existing, true).ok).toBe(true);
    const missing = abi.encode(['uint256', 'bool'], [0, false]);
    expect(check.interpret!(missing, true).ok).toBe(false);
  });

  it('checkNotCompleted: hasCompleted=true fails fast with "already completed" naming the learner', () => {
    const check = checkNotCompleted(HUB_ADDR, WALLET, 2);
    expect(check.call!.data).toBe(
      EDU_READ_IFACE.encodeFunctionData('hasCompleted', [WALLET, ethers.BigNumber.from(2)])
    );

    const done = check.interpret!(abi.encode(['bool'], [true]), true);
    expect(done.ok).toBe(false);
    expect(done.detail).toContain('already completed');
    expect(done.detail).toContain(WALLET);
    expect(done.suggestion).toContain('once per account');

    const fresh = check.interpret!(abi.encode(['bool'], [false]), true);
    expect(fresh.ok).toBe(true);
  });

  it('checkNotCompleted: unreadable state fails safe (never assumes not-completed)', () => {
    const check = checkNotCompleted(HUB_ADDR, WALLET, 2);
    expect(check.interpret!('0x', false).ok).toBe(false);
  });
});

describe('pop education complete — handler wiring', () => {
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
    mocks.resolveOrgModules.mockResolvedValue({ orgId: ORG_ID, educationHubAddress: HUB_ADDR });
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xabc',
      explorerUrl: 'https://explorer/tx/0xabc',
      logs: [],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  function argv(overrides: Record<string, any> = {}): any {
    return {
      _: [], $0: 'pop', org: 'testorg', module: '2', answer: 1,
      yes: false, preflight: true, noIdempotency: false, dryRun: false,
      ...overrides,
    };
  }

  it('wires gas + module-exists + not-completed checks into one pre-flight, then sends completeModule(id, answer)', async () => {
    await completeHandler.handler(argv());

    expect(mocks.runPreflight).toHaveBeenCalledTimes(1);
    const checks = mocks.runPreflight.mock.calls[0][1];
    expect(checks.map((c: any) => c.label)).toEqual(['gas balance', 'module 2', 'module 2 completion']);
    expect(mocks.runPreflight.mock.calls[0][2]).toEqual({ skip: false });

    const [contract, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('completeModule');
    expect(args).toEqual(['2', 1]);
    expect(() => contract.interface.getFunction('completeModule')).not.toThrow();
  });

  it('already completed: pre-flight failure exits EXIT.PRECONDITION (4) before any transaction', async () => {
    mocks.runPreflight.mockRejectedValue(new PreconditionError(
      'Pre-flight checks failed:\n  ✗ module 2 completion: already completed by ' + WALLET
    ));

    await expect(completeHandler.handler(argv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('already completed'),
      expect.anything(),
    );
  });

  it('--answer outside uint8: exit EXIT.USAGE before any network work', async () => {
    await expect(completeHandler.handler(argv({ answer: 300 }))).rejects.toBeInstanceOf(ExitError);
    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(mocks.resolveOrgModules).not.toHaveBeenCalled();
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('--no-preflight: checks are skipped, tx still goes out', async () => {
    await completeHandler.handler(argv({ preflight: false }));

    expect(mocks.runPreflight).toHaveBeenCalledWith(expect.anything(), expect.any(Array), { skip: true });
    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
  });
});
