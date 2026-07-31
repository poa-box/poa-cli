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
 *
 * Read shape (post subgraph pass): the QuickJoin module ADDRESSES come from
 * the subgraph, but all three pre-flight probes stay on-chain — each one
 * predicts a specific revert — and they are now a SINGLE Multicall3 batch
 * instead of N+2 sequential round-trips. These tests pin both halves.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
  checkIdempotencyCache: vi.fn(),
  recordIdempotentResult: vi.fn(),
  tryAggregate: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
vi.mock('../../src/lib/multicall', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/multicall')>();
  return { ...actual, tryAggregate: mocks.tryAggregate };
});
vi.mock('../../src/lib/signer', () => ({ createSigner: mocks.createSigner }));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => {
    if (!modules?.[key]) throw new Error(`missing module ${key}`);
    return modules[key];
  },
}));
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
import { Call } from '../../src/lib/multicall';
import * as output from '../../src/lib/output';

const QJ_ADDR = '0x1111111111111111111111111111111111111111';
const REGISTRY_ADDR = '0x4444444444444444444444444444444444444444';
const HATS_ADDR = '0x6666666666666666666666666666666666666666';
const EXECUTOR_ADDR = '0x7777777777777777777777777777777777777777';
const WALLET = '0x2222222222222222222222222222222222222222';
const ORG_ID = '0x' + 'ab'.repeat(32);

const QJ_IFACE = new ethers.utils.Interface([
  'function accountRegistry() view returns (address)',
  'function hats() view returns (address)',
]);
const UAR_IFACE = new ethers.utils.Interface([
  'function getUsername(address user) view returns (string)',
]);
const EXECUTOR_IFACE = new ethers.utils.Interface([
  'function MAX_HATS_PER_MINT() view returns (uint8)',
]);
const HATS_IFACE = new ethers.utils.Interface([
  'function isEligible(address wearer, uint256 hatId) view returns (bool)',
]);

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

interface ChainState {
  username?: string;
  /** Every read fails (the multicall answers, each call reverts). */
  readsFail?: boolean;
  /** tryAggregate itself blows up (node unreachable). */
  aggregateThrows?: boolean;
  cap?: number | null;
  probeEligible?: boolean;
}

/**
 * Answer the batched eth_calls with REAL ABI-encoded payloads so the
 * command's own decoding runs.
 */
function installChain(state: ChainState = {}) {
  mocks.tryAggregate.mockImplementation(async (_provider: any, calls: Call[]) => {
    if (state.aggregateThrows) throw new Error('rpc timeout');
    return calls.map((call) => {
      if (state.readsFail) return { success: false, returnData: '0x' };
      const sig = call.data.slice(0, 10).toLowerCase();
      if (sig === QJ_IFACE.getSighash('accountRegistry')) {
        return { success: true, returnData: QJ_IFACE.encodeFunctionResult('accountRegistry', [REGISTRY_ADDR]) };
      }
      if (sig === QJ_IFACE.getSighash('hats')) {
        return { success: true, returnData: QJ_IFACE.encodeFunctionResult('hats', [HATS_ADDR]) };
      }
      if (sig === UAR_IFACE.getSighash('getUsername')) {
        return { success: true, returnData: UAR_IFACE.encodeFunctionResult('getUsername', [state.username ?? 'argus']) };
      }
      if (sig === EXECUTOR_IFACE.getSighash('MAX_HATS_PER_MINT')) {
        if (state.cap === null || state.cap === undefined) return { success: false, returnData: '0x' };
        return { success: true, returnData: EXECUTOR_IFACE.encodeFunctionResult('MAX_HATS_PER_MINT', [state.cap]) };
      }
      if (sig === HATS_IFACE.getSighash('isEligible')) {
        return {
          success: true,
          returnData: HATS_IFACE.encodeFunctionResult('isEligible', [state.probeEligible ?? false]),
        };
      }
      return { success: false, returnData: '0x' };
    });
  });
}

/** What the subgraph reports for the org's QuickJoin. */
function setIndexedQuickJoin(quickJoin: any = {
  id: QJ_ADDR.toLowerCase(),
  accountRegistry: REGISTRY_ADDR,
  hatsContract: HATS_ADDR,
  memberHatIds: [],
}) {
  mocks.query.mockResolvedValue({ quickJoinContract: quickJoin });
}

/** Flatten every call the command batched, across all tryAggregate calls. */
function batchedCalls(): Call[] {
  return mocks.tryAggregate.mock.calls.flatMap((c: any[]) => c[1] as Call[]);
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
      executorAddress: EXECUTOR_ADDR,
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
    setIndexedQuickJoin();
    installChain();
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

  it('the whole pre-flight is ONE multicall: module addresses from the subgraph, every probe batched', async () => {
    await claimHatsHandler.handler(baseArgv({ hats: '1,2,3,4,5' }));

    // Addresses came from the subgraph → no accountRegistry()/hats() eth_call
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][0]).toContain('QuickJoinModules');
    expect(mocks.query.mock.calls[0][1]).toEqual({ quickJoinAddress: QJ_ADDR.toLowerCase() });

    // Exactly one batch: getUsername + MAX_HATS_PER_MINT + 5 isEligible.
    // Before this change that was 5 sequential awaits plus 4 more round-trips.
    expect(mocks.tryAggregate).toHaveBeenCalledTimes(1);
    const calls = batchedCalls();
    expect(calls).toHaveLength(7);
    expect(calls.filter(c => c.data.startsWith(QJ_IFACE.getSighash('accountRegistry')))).toHaveLength(0);
    expect(calls.filter(c => c.data.startsWith(QJ_IFACE.getSighash('hats')))).toHaveLength(0);
    expect(calls.filter(c => c.data.startsWith(UAR_IFACE.getSighash('getUsername')))).toHaveLength(1);
    expect(calls.filter(c => c.data.startsWith(EXECUTOR_IFACE.getSighash('MAX_HATS_PER_MINT')))).toHaveLength(1);

    const probes = calls.filter(c => c.data.startsWith(HATS_IFACE.getSighash('isEligible')));
    expect(probes).toHaveLength(5);
    expect(probes.every(p => p.to === HATS_ADDR)).toBe(true);
    // The sentinel is QuickJoin._CLAIM_PROBE, not the signer
    const [probeWearer] = HATS_IFACE.decodeFunctionData('isEligible', probes[0].data);
    expect(probeWearer).toBe(
      ethers.utils.getAddress('0x' + ethers.utils.id('poa.quickjoin.claim.probe').slice(-40))
    );
    expect(probeWearer).not.toBe(WALLET);

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
  });

  it('no registered username: fails fast with exit EXIT.PRECONDITION (4) before any transaction', async () => {
    installChain({ username: '' });

    await expect(claimHatsHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('NoUsername'),
      expect.objectContaining({ suggestion: expect.stringContaining('pop user join') }),
    );
  });

  it('the username gate is answered by the CHAIN, never by the indexer (subgraph never carries a username here)', async () => {
    installChain({ username: '' });

    await expect(claimHatsHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(batchedCalls().filter(c => c.data.startsWith(UAR_IFACE.getSighash('getUsername')))).toHaveLength(1);
  });

  it('openly-claimable hat: the on-chain sentinel probe blocks the claim with exit EXIT.PRECONDITION', async () => {
    installChain({ probeEligible: true });

    await expect(claimHatsHandler.handler(baseArgv({ hats: '123' }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('openly claimable'),
      expect.anything(),
    );
  });

  it('a reverting probe still fails CLOSED, exactly as the contract does', async () => {
    // Addresses come from the subgraph; the batched probes all revert.
    installChain({ readsFail: true });

    await expect(claimHatsHandler.handler(baseArgv({ hats: '123' }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('openly claimable'),
      expect.anything(),
    );
  });

  it('executor batch cap: more hats than MAX_HATS_PER_MINT is rejected before any transaction', async () => {
    installChain({ cap: 2 });

    await expect(claimHatsHandler.handler(baseArgv({ hats: '1,2,3' }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('at most 2 per call'),
      expect.anything(),
    );
  });

  it('an executor without MAX_HATS_PER_MINT (reverts) simply has no cap', async () => {
    installChain({ cap: null });

    await claimHatsHandler.handler(baseArgv({ hats: '1,2,3' }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
  });

  it('subgraph unavailable: module addresses fall back to a single batched accountRegistry()+hats() read', async () => {
    mocks.query.mockRejectedValue(new Error('subgraph 503'));

    await claimHatsHandler.handler(baseArgv({ hats: '123' }));

    expect(mocks.tryAggregate).toHaveBeenCalledTimes(2); // pointers, then probes
    const pointerCalls = mocks.tryAggregate.mock.calls[0][1] as Call[];
    expect(pointerCalls).toHaveLength(2);
    expect(pointerCalls.every(c => c.to === QJ_ADDR)).toBe(true);
    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
  });

  it('all reads unavailable: degrades gracefully — the claim still goes out (the contract stays the authority)', async () => {
    mocks.query.mockRejectedValue(new Error('subgraph 503'));
    installChain({ aggregateThrows: true });

    await claimHatsHandler.handler(baseArgv());

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(mocks.executeTx.mock.calls[0][1]).toBe('claimHatsWithUser');
  });

  it('--no-preflight skips every pre-check: no subgraph query, no eth_call', async () => {
    await claimHatsHandler.handler(baseArgv({ preflight: false }));

    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.tryAggregate).not.toHaveBeenCalled();
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
