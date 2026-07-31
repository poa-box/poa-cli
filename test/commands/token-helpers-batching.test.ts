/**
 * Token hat-gate reads — batched, and deliberately still on-chain.
 *
 * The subgraph audit found no usable replacement for these:
 *   - ParticipationTokenContract.executor / .hatsContract are in the schema but
 *     ZERO on all 9 live Gnosis rows;
 *   - memberHatIds / approverHatIds are not indexed on the token at all
 *     (QuickJoinContract.memberHatIds is, the participation token's is not);
 *   - the Hats balance reads are revert predictors run immediately before
 *     requestTokens / approveRequest.
 * So the win here is batching, not elimination: 4 gate reads and N hat reads
 * each collapse to one Multicall3 round-trip.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';

const { tryAggregateMock } = vi.hoisted(() => ({ tryAggregateMock: vi.fn() }));

vi.mock('../../src/lib/multicall', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, tryAggregate: tryAggregateMock };
});

import { readTokenGates, checkWearsAnyHat } from '../../src/commands/token/helpers';

const TOKEN = ethers.utils.getAddress('0x' + '2b'.repeat(20));
const HATS = ethers.utils.getAddress('0x' + '3c'.repeat(20));
const EXECUTOR = ethers.utils.getAddress('0x' + '4d'.repeat(20));
const WEARER = ethers.utils.getAddress('0x' + 'aa'.repeat(20));

const BIG_HAT_A = ethers.BigNumber.from('26959946667150639794667015087019630673637144422540572481103610249216');
const BIG_HAT_B = ethers.BigNumber.from('26959946667150639794667015087019630673637144422540572481103610249217');

const coder = ethers.utils.defaultAbiCoder;
const ok = (returnData: string) => ({ success: true, returnData });
const uint = (n: ethers.BigNumberish) => coder.encode(['uint256'], [n]);
const provider = {} as any;

describe('readTokenGates', () => {
  beforeEach(() => tryAggregateMock.mockReset());

  it('reads all four gate values in ONE batch and decodes >2^53 hat IDs losslessly', async () => {
    tryAggregateMock.mockResolvedValue([
      ok(coder.encode(['address'], [HATS])),
      ok(coder.encode(['address'], [EXECUTOR])),
      ok(coder.encode(['uint256[]'], [[BIG_HAT_A]])),
      ok(coder.encode(['uint256[]'], [[BIG_HAT_A, BIG_HAT_B]])),
    ]);

    const gates = await readTokenGates(provider, TOKEN);

    expect(tryAggregateMock).toHaveBeenCalledTimes(1);
    const [, calls] = tryAggregateMock.mock.calls[0];
    expect(calls).toHaveLength(4);
    expect(calls.every((c: any) => c.to === TOKEN)).toBe(true);
    // Distinct selectors — hats/executor/memberHatIds/approverHatIds.
    expect(new Set(calls.map((c: any) => c.data))).toHaveProperty('size', 4);

    expect(gates.hatsAddress).toBe(HATS);
    expect(gates.executor).toBe(EXECUTOR);
    expect(gates.memberHatIds.map(h => h.toString())).toEqual([BIG_HAT_A.toString()]);
    expect(gates.approverHatIds.map(h => h.toString())).toEqual([BIG_HAT_A.toString(), BIG_HAT_B.toString()]);
  });

  it('throws when a gate read reverts — callers skip the pre-flight rather than trust a zero executor', async () => {
    tryAggregateMock.mockResolvedValue([
      ok(coder.encode(['address'], [HATS])),
      { success: false, returnData: '0x' },
      ok(coder.encode(['uint256[]'], [[]])),
      ok(coder.encode(['uint256[]'], [[]])),
    ]);

    await expect(readTokenGates(provider, TOKEN)).rejects.toThrow(/executor/);
  });
});

describe('checkWearsAnyHat', () => {
  beforeEach(() => tryAggregateMock.mockReset());

  it('single-hat sets delegate to the shared batched checkHasHat (a `call`, not a `local`)', () => {
    const check = checkWearsAnyHat(provider, HATS, WEARER, [BIG_HAT_A], {
      label: 'member hat', detail: 'nope',
    });
    expect(check.call).toBeDefined();
    expect(check.local).toBeUndefined();
    expect(check.call!.to).toBe(HATS);
  });

  it('multi-hat ANY-OF passes on the first non-zero balance, in one batch', async () => {
    tryAggregateMock.mockResolvedValue([ok(uint(0)), ok(uint(1))]);

    const check = checkWearsAnyHat(provider, HATS, WEARER, [BIG_HAT_A, BIG_HAT_B], {
      label: 'member hat', detail: 'wears none',
    });
    const result = await check.local!();

    expect(tryAggregateMock).toHaveBeenCalledTimes(1);
    expect(tryAggregateMock.mock.calls[0][1]).toHaveLength(2);
    expect(result).toEqual({ ok: true });
  });

  it('fails with the checked hat list when no hat is worn, and treats a reverted read as not-worn', async () => {
    tryAggregateMock.mockResolvedValue([ok(uint(0)), { success: false, returnData: '0x' }]);

    const check = checkWearsAnyHat(provider, HATS, WEARER, [BIG_HAT_A, BIG_HAT_B], {
      label: 'member hat', detail: 'wears none', suggestion: 'pop user join',
    });
    const result = await check.local!();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('wears none');
    expect(result.detail).toContain(BIG_HAT_A.toString());
    expect(result.detail).toContain(BIG_HAT_B.toString());
    expect(result.suggestion).toBe('pop user join');
  });
});
