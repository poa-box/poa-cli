/**
 * pop user claim-hats — QuickJoin.claimHatsWithUser(uint256[]).
 *
 * Hats Protocol IDs are uint256 values far beyond Number.MAX_SAFE_INTEGER
 * (the top-hat domain lives in the high-order bytes), so --hats parsing MUST
 * go through BigNumber — parseInt/Number silently corrupts the low bits.
 * These tests pin that precision end-to-end: parse → executeTx args.
 *
 * Also covered: the NoUsername fail-fast pre-flight (VERIFIED contracts
 * origin/main src/QuickJoin.sol — claimHatsWithUser reverts NoUsername when
 * the caller has no registered username) and its graceful degradation when
 * the registry read itself fails.
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
}));
vi.mock('../../src/lib/idempotency', () => ({
  argvToIdempotencyString: vi.fn(() => 'idem-key'),
  checkIdempotencyCache: mocks.checkIdempotencyCache,
  recordIdempotentResult: mocks.recordIdempotentResult,
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
import { claimHatsHandler, parseHatIds } from '../../src/commands/user/claim-hats';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { CliError } from '../../src/lib/errors';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const QJ_ADDR = '0x1111111111111111111111111111111111111111';
const REGISTRY_ADDR = '0x4444444444444444444444444444444444444444';
const WALLET = '0x2222222222222222222222222222222222222222';
const ORG_ID = '0x' + 'ab'.repeat(32);

// Real Hats-Protocol-shaped ID: top-hat 1, child 2, child 1 — 2^240 scale.
const HEX_HAT = '0x0000000100020001000000000000000000000000000000000000000000000000';
const DEC_HAT = ethers.BigNumber.from(HEX_HAT).toString();

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
    hats: '123',
    yes: false,
    preflight: true,
    noIdempotency: false,
    dryRun: false,
    ...overrides,
  };
}

function setRegistryUsername(username: string | Error) {
  mocks.createReadContract.mockImplementation((_addr: string, abiName: string) => {
    if (abiName === 'QuickJoinNew') {
      return {
        accountRegistry: async () => {
          if (username instanceof Error) throw username;
          return REGISTRY_ADDR;
        },
      };
    }
    if (abiName === 'UniversalAccountRegistry') {
      return { getUsername: async () => username as string };
    }
    throw new Error(`unexpected read contract: ${abiName}`);
  });
}

describe('parseHatIds — uint256 precision', () => {
  it('parses a decimal ID beyond 2^53 without losing a single digit', () => {
    // Prove the fixture actually exceeds float precision
    expect(String(Number(DEC_HAT))).not.toBe(DEC_HAT);

    const [id] = parseHatIds(DEC_HAT);
    expect(id.toString()).toBe(DEC_HAT);
    expect(id.eq(ethers.BigNumber.from(HEX_HAT))).toBe(true);
  });

  it('parses 0x-hex IDs and mixed lists with whitespace', () => {
    const ids = parseHatIds(` ${HEX_HAT} , 456 `);
    expect(ids).toHaveLength(2);
    expect(ids[0].eq(ethers.BigNumber.from(HEX_HAT))).toBe(true);
    expect(ids[1].toNumber()).toBe(456);
  });

  it('rejects non-numeric entries with a usage error naming the bad ID', () => {
    try {
      parseHatIds('123,abc');
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(CliError);
      expect(err.code).toBe(EXIT.USAGE);
      expect(err.message).toContain('"abc"');
    }
  });

  it('rejects an empty list', () => {
    for (const bad of ['', ' , ,']) {
      try {
        parseHatIds(bad);
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(CliError);
        expect(err.code).toBe(EXIT.USAGE);
      }
    }
  });
});

describe('pop user claim-hats — claimHatsWithUser wiring', () => {
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
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      quickJoinAddress: QJ_ADDR,
    });
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.checkGasBalance.mockReturnValue({ label: 'gas balance' });
    mocks.checkIdempotencyCache.mockReturnValue(null);
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xabc',
      explorerUrl: 'https://explorer/tx/0xabc',
      logs: [],
    });
    setRegistryUsername('argus');
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('sends claimHatsWithUser(uint256[]) with exact BigNumber values (hex + oversized decimal)', async () => {
    await claimHatsHandler.handler(baseArgv({ hats: `${HEX_HAT},${DEC_HAT},7` }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('claimHatsWithUser');
    expect(contract.address).toBe(QJ_ADDR);
    // Real QuickJoinNew ABI carries the method
    expect(() => contract.interface.getFunction('claimHatsWithUser')).not.toThrow();

    const [hatIds] = args as [ethers.BigNumber[]];
    expect(hatIds).toHaveLength(3);
    expect(hatIds[0].eq(ethers.BigNumber.from(HEX_HAT))).toBe(true);
    expect(hatIds[1].toString()).toBe(DEC_HAT); // no float round-trip
    expect(hatIds[2].toNumber()).toBe(7);

    expect(output.success).toHaveBeenCalledWith('3 hats claimed', expect.objectContaining({
      hatIds: `${DEC_HAT},${DEC_HAT},7`,
      orgId: ORG_ID,
      txHash: '0xabc',
    }));
    expect(mocks.recordIdempotentResult).toHaveBeenCalledWith(
      ORG_ID, 'user.claim-hats', 'idem-key',
      expect.objectContaining({ txHash: '0xabc' }),
      900,
    );
  });

  it('no registered username: fails fast with exit EXIT.PRECONDITION (4) before any transaction', async () => {
    setRegistryUsername('');

    await expect(claimHatsHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('NoUsername'),
      expect.objectContaining({ suggestion: expect.stringContaining('pop user join') }),
    );
  });

  it('registry read failure degrades gracefully: the claim still goes out (the contract stays the authority)', async () => {
    setRegistryUsername(new Error('rpc timeout'));

    await claimHatsHandler.handler(baseArgv());

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(mocks.executeTx.mock.calls[0][1]).toBe('claimHatsWithUser');
  });

  it('--no-preflight skips the username pre-check entirely', async () => {
    await claimHatsHandler.handler(baseArgv({ preflight: false }));

    expect(mocks.createReadContract).not.toHaveBeenCalled();
    expect(mocks.runPreflight).toHaveBeenCalledWith(expect.anything(), expect.any(Array), { skip: true });
    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
  });

  it('invalid --hats: exit EXIT.USAGE before any network work', async () => {
    await expect(claimHatsHandler.handler(baseArgv({ hats: 'nope' }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(mocks.resolveOrgModules).not.toHaveBeenCalled();
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('single hat: success message names the hat, in decimal', async () => {
    await claimHatsHandler.handler(baseArgv({ hats: HEX_HAT }));

    expect(output.success).toHaveBeenCalledWith(
      `Hat ${DEC_HAT} claimed`,
      expect.objectContaining({ hatIds: DEC_HAT }),
    );
  });
});
