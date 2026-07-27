/**
 * pop user join — two-step register+join flow.
 *
 * VERIFIED contracts origin/main src/QuickJoin.sol: quickJoinWithUser()
 * reads accountRegistry.getUsername(msg.sender) and reverts NoUsername when
 * empty, so a fresh account must registerAccount on the SAME registry first.
 * The command:
 *   - username already registered → 1 tx (quickJoinWithUser)
 *   - no username + --username    → 2 txs (registerAccount → quickJoinWithUser)
 *                                    with a checkUsernameFree pre-flight
 *   - no username, no flag, non-TTY → actionable CliError, exit EXIT.USAGE (1)
 *   - username taken               → pre-flight PreconditionError, exit 4,
 *                                    BEFORE any transaction
 *
 * command.ts (getWriteContext/confirmWrite/finishWrite/withIdempotency) runs
 * REAL; the module seams (tx, signer, resolve, preflight, contracts reads,
 * prompt, idempotency, output) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  createReadContract: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
  checkUsernameFree: vi.fn(),
  checkIdempotencyCache: vi.fn(),
  recordIdempotentResult: vi.fn(),
  isInteractive: vi.fn(),
  input: vi.fn(),
  confirm: vi.fn(),
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
vi.mock('../../src/lib/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/contracts')>();
  return { ...actual, createReadContract: mocks.createReadContract };
});
vi.mock('../../src/lib/preflight', () => ({
  runPreflight: mocks.runPreflight,
  checkGasBalance: mocks.checkGasBalance,
  checkUsernameFree: mocks.checkUsernameFree,
}));
vi.mock('../../src/lib/idempotency', () => ({
  argvToIdempotencyString: vi.fn(() => 'idem-key'),
  checkIdempotencyCache: mocks.checkIdempotencyCache,
  recordIdempotentResult: mocks.recordIdempotentResult,
  resolveTtlSeconds: vi.fn(() => 900),
}));
vi.mock('../../src/lib/prompt', () => ({
  isInteractive: mocks.isInteractive,
  input: mocks.input,
  confirm: mocks.confirm,
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
import { joinHandler } from '../../src/commands/user/join';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { PreconditionError } from '../../src/lib/errors';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const QJ_ADDR = '0x1111111111111111111111111111111111111111';
const REGISTRY_ADDR = '0x4444444444444444444444444444444444444444';
const WALLET = '0x2222222222222222222222222222222222222222';
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
    yes: false,
    preflight: true,
    noIdempotency: false,
    dryRun: false,
    ...overrides,
  };
}

/** Set what the org's account registry reports for the signer. */
function setRegistryUsername(username: string) {
  mocks.createReadContract.mockImplementation((_addr: string, abiName: string) => {
    if (abiName === 'QuickJoinNew') {
      return { accountRegistry: async () => REGISTRY_ADDR };
    }
    if (abiName === 'UniversalAccountRegistry') {
      return { getUsername: async (_who: string) => username };
    }
    throw new Error(`unexpected read contract: ${abiName}`);
  });
}

describe('pop user join — register+join matrix', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _clearWriteContextCacheForTest();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);

    mocks.isInteractive.mockReturnValue(false); // deterministic non-TTY default
    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      provider: {},
      address: WALLET,
      chainId: 11155111,
    });
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      quickJoinAddress: QJ_ADDR,
    });
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.checkGasBalance.mockReturnValue({ label: 'gas balance' });
    mocks.checkUsernameFree.mockImplementation((_reg: string, name: string) => ({ label: `username "${name}"` }));
    mocks.checkIdempotencyCache.mockReturnValue(null);
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xabc',
      explorerUrl: 'https://explorer/tx/0xabc',
      logs: [],
    });
    setRegistryUsername('');
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('username already registered: ONE tx (quickJoinWithUser), no username pre-flight', async () => {
    setRegistryUsername('argus');

    await joinHandler.handler(baseArgv());

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args, opts] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('quickJoinWithUser');
    expect(args).toEqual([]);
    expect(opts).toEqual({ dryRun: false });
    // Real QuickJoinNew ABI wired through createWriteContract
    expect(() => contract.interface.getFunction('quickJoinWithUser')).not.toThrow();
    expect(contract.address).toBe(QJ_ADDR);

    // No registration → no checkUsernameFree; gas check still runs
    expect(mocks.checkUsernameFree).not.toHaveBeenCalled();
    expect(mocks.runPreflight).toHaveBeenCalledWith(expect.anything(), expect.any(Array), { skip: false });

    expect(output.success).toHaveBeenCalledWith('Joined organization', expect.objectContaining({
      orgId: ORG_ID,
      username: 'argus',
      txHash: '0xabc',
      explorerUrl: 'https://explorer/tx/0xabc',
    }));
    expect(mocks.recordIdempotentResult).toHaveBeenCalledWith(
      ORG_ID, 'user.join', 'idem-key',
      expect.objectContaining({ username: 'argus', txHash: '0xabc' }),
      900,
    );
  });

  it('no username + --username: TWO txs in order (registerAccount on the QuickJoin registry, then quickJoinWithUser) with checkUsernameFree pre-flight', async () => {
    setRegistryUsername('');

    await joinHandler.handler(baseArgv({ username: 'newbie' }));

    // Pre-flight covers the NEW registration on the registry QuickJoin consults
    expect(mocks.checkUsernameFree).toHaveBeenCalledWith(REGISTRY_ADDR, 'newbie');
    expect(mocks.runPreflight).toHaveBeenCalledTimes(1);

    expect(mocks.executeTx).toHaveBeenCalledTimes(2);

    const [regContract, regMethod, regArgs] = mocks.executeTx.mock.calls[0];
    expect(regMethod).toBe('registerAccount');
    expect(regArgs).toEqual(['newbie']);
    expect(regContract.address).toBe(REGISTRY_ADDR);
    expect(() => regContract.interface.getFunction('registerAccount')).not.toThrow();

    const [joinContract, joinMethod, joinArgs] = mocks.executeTx.mock.calls[1];
    expect(joinMethod).toBe('quickJoinWithUser');
    expect(joinArgs).toEqual([]);
    expect(joinContract.address).toBe(QJ_ADDR);

    // Both receipts surface, in order
    expect(output.success).toHaveBeenNthCalledWith(1,
      'Username "newbie" registered (tx 1/2)',
      expect.objectContaining({ username: 'newbie', registry: REGISTRY_ADDR }),
    );
    expect(output.success).toHaveBeenNthCalledWith(2,
      'Joined organization',
      expect.objectContaining({ orgId: ORG_ID, username: 'newbie' }),
    );

    expect(mocks.recordIdempotentResult).toHaveBeenCalledWith(
      ORG_ID, 'user.join', 'idem-key',
      expect.objectContaining({ username: 'newbie' }),
      900,
    );
  });

  it('no username, no --username, non-TTY: actionable error, exit EXIT.USAGE (1), nothing sent', async () => {
    setRegistryUsername('');
    mocks.isInteractive.mockReturnValue(false);

    await expect(joinHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('--username'),
      expect.objectContaining({ suggestion: expect.stringContaining('pop user join') }),
    );
  });

  it('no username, no --username, TTY: prompts for a name, shows the 2-transaction summary, then registers + joins', async () => {
    setRegistryUsername('');
    mocks.isInteractive.mockReturnValue(true);
    mocks.input.mockResolvedValue('prompted_name');
    mocks.confirm.mockResolvedValue(true); // confirmWrite 'Proceed?'

    await joinHandler.handler(baseArgv());

    expect(mocks.input).toHaveBeenCalledTimes(1);
    // The interactive confirm names both transactions
    expect(output.keyValueBlock).toHaveBeenCalledWith(
      'About to join organization',
      expect.objectContaining({
        username: 'prompted_name (new registration)',
        transactions: '2 transactions (registerAccount, then quickJoinWithUser)',
      }),
    );

    expect(mocks.executeTx).toHaveBeenCalledTimes(2);
    expect(mocks.executeTx.mock.calls[0][1]).toBe('registerAccount');
    expect(mocks.executeTx.mock.calls[0][2]).toEqual(['prompted_name']);
    expect(mocks.executeTx.mock.calls[1][1]).toBe('quickJoinWithUser');
  });

  it('username taken: pre-flight fails with exit EXIT.PRECONDITION (4) BEFORE any transaction', async () => {
    setRegistryUsername('');
    mocks.runPreflight.mockRejectedValue(new PreconditionError(
      'Pre-flight checks failed:\n  ✗ username "newbie": already registered to 0x9999999999999999999999999999999999999999 (pick a different username)'
    ));

    await expect(joinHandler.handler(baseArgv({ username: 'newbie' }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(mocks.recordIdempotentResult).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('already registered'),
      expect.anything(),
    );
  });

  it('invalid --username fails fast with exit EXIT.USAGE before any transaction', async () => {
    setRegistryUsername('');

    await expect(joinHandler.handler(baseArgv({ username: 'x' }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('3-32'), expect.anything());
  });

  it('already registered + a different --username: warns and ignores the flag (1 tx, existing name)', async () => {
    setRegistryUsername('argus');

    await joinHandler.handler(baseArgv({ username: 'other_name' }));

    expect(output.warn).toHaveBeenCalledWith(expect.stringContaining('Already registered as "argus"'));
    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(mocks.executeTx.mock.calls[0][1]).toBe('quickJoinWithUser');
    expect(mocks.checkUsernameFree).not.toHaveBeenCalled();
  });

  it('registration failure stops the flow: quickJoinWithUser is never sent after a failed registerAccount', async () => {
    setRegistryUsername('');
    mocks.executeTx.mockResolvedValueOnce({
      success: false,
      error: 'execution reverted: UsernameTaken',
      errorCode: 'TX_REVERTED',
    });

    await expect(joinHandler.handler(baseArgv({ username: 'newbie' }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.TX_FAILED);
    expect(mocks.executeTx).toHaveBeenCalledTimes(1); // registerAccount only
  });

  it('idempotency cache hit: returns the prior join without re-sending', async () => {
    setRegistryUsername('argus');
    mocks.checkIdempotencyCache.mockReturnValue({ orgId: ORG_ID, username: 'argus', txHash: '0xold' });

    await joinHandler.handler(baseArgv());

    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.success).toHaveBeenCalledWith(
      expect.stringContaining('idempotency cache hit'),
      expect.objectContaining({ username: 'argus', txHash: '0xold', cached: true }),
    );
  });
});
