/**
 * Vouch domain read sourcing.
 *
 * Two things are under test:
 *
 * 1. SUBGRAPH-FIRST display reads. VouchConfig.{quorum,membershipHatId,
 *    enabled,combinesWithHierarchy} and a count of active Vouch rows are
 *    verified-populated on the live Gnosis + Arbitrum deployments, and the
 *    active-Vouch count was checked against on-chain currentVouchCount() on
 *    five real (hat, wearer) pairs. Anything ambiguous — missing row, null
 *    field, a full 1000-row page, a query error — must degrade to RPC rather
 *    than answer wrongly.
 *
 * 2. MULTICALL3 batching for the RPC reads that deliberately survive (every
 *    write pre-flight in this domain predicts a revert, so it stays on chain).
 *    A sub-call that reverts must NOT decode as a falsy answer: it is
 *    re-issued so the original error propagates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));

import { ethers } from 'ethers';
import {
  batchEligibilityReads,
  requireSuperAdminWithRead,
  fetchVouchConfigFromSubgraph,
  fetchWearerVouchStateFromSubgraph,
  readVoucherGate,
} from '../../src/commands/vouch/helpers';
import { MULTICALL3 } from '../../src/lib/multicall';
import { loadAbi } from '../../src/lib/contracts';
import { PreconditionError } from '../../src/lib/errors';

const EM_ADDR = '0x27114cb757bedf77e30eeb0ca635e3368d8c2914';
const WEARER = '0x1302e867e61bd17e31158d0cb39725f2c4173c97';
const SUPER_ADMIN = '0x23f90B3859818A843C3a848627A304Bc53947342';
const HAT = ethers.BigNumber.from('29089782865237956866263577802518366573012001940915670447121420467044352');

const EM_IFACE = new ethers.utils.Interface(loadAbi('EligibilityModuleNew'));
const MC_IFACE = new ethers.utils.Interface([
  'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) returns (tuple(bool success, bytes returnData)[] returnData)',
]);

/**
 * Provider that speaks Multicall3. `answer(fnName)` returns either encoded
 * return data or null to mark that sub-call as reverted. `direct` records
 * per-call re-issues (the un-batched fallback path).
 */
function multicallProvider(answer: (fn: string) => string | null) {
  const direct: string[] = [];
  const provider: any = {
    _isProvider: true,
    getNetwork: vi.fn(async () => ({ chainId: 100, name: 'gnosis' })),
    resolveName: vi.fn(async (name: string) => name),
    getCode: vi.fn(async () => '0x60806040'),
    call: vi.fn(async (tx: { to: string; data: string }) => {
      if (tx.to.toLowerCase() === MULTICALL3.toLowerCase()) {
        const [, calls] = MC_IFACE.decodeFunctionData('tryAggregate', tx.data);
        const results = calls.map((c: any) => {
          const fn = EM_IFACE.getFunction(c.callData.slice(0, 10)).name;
          const data = answer(fn);
          return data === null ? [false, '0x'] : [true, data];
        });
        return MC_IFACE.encodeFunctionResult('tryAggregate', [results]);
      }
      const fn = EM_IFACE.getFunction(tx.data.slice(0, 10)).name;
      direct.push(fn);
      const data = answer(fn);
      if (data === null) throw new Error(`call revert exception: ${fn}`);
      return data;
    }),
  };
  return { provider, direct };
}

const GATE_ANSWERS: Record<string, string> = {
  canUserVouch: EM_IFACE.encodeFunctionResult('canUserVouch', [true]),
  getCurrentDailyVouchCount: EM_IFACE.encodeFunctionResult('getCurrentDailyVouchCount', [2]),
  getMaxDailyVouches: EM_IFACE.encodeFunctionResult('getMaxDailyVouches', [20]),
  getUserJoinTime: EM_IFACE.encodeFunctionResult('getUserJoinTime', [1700000000]),
  superAdmin: EM_IFACE.encodeFunctionResult('superAdmin', [SUPER_ADMIN]),
  getVouchConfig: EM_IFACE.encodeFunctionResult('getVouchConfig', [
    { quorum: 3, membershipHatId: ethers.BigNumber.from(45), flags: 3 },
  ]),
  getDefaultRules: EM_IFACE.encodeFunctionResult('getDefaultRules', [true, true]),
  currentVouchCount: EM_IFACE.encodeFunctionResult('currentVouchCount', [2]),
};

describe('batchEligibilityReads — Multicall3 batching for surviving RPC reads', () => {
  it('collapses the four-call voucher gate into ONE round-trip', async () => {
    const { provider, direct } = multicallProvider(fn => GATE_ANSWERS[fn] ?? null);

    const gate = await readVoucherGate(provider, EM_ADDR, WEARER);

    expect(gate).toEqual({ canVouch: true, dailyUsed: 2, maxDaily: 20, joinTime: 1700000000 });
    // getCode (availability probe) + exactly one aggregate call, no direct calls.
    expect(provider.call).toHaveBeenCalledTimes(1);
    expect(provider.call.mock.calls[0][0].to.toLowerCase()).toBe(MULTICALL3.toLowerCase());
    expect(direct).toEqual([]);
  });

  it('decodes multi-output getters positionally AND by name', async () => {
    const { provider } = multicallProvider(fn => GATE_ANSWERS[fn] ?? null);

    const [rules] = await batchEligibilityReads(provider, EM_ADDR, [
      { fn: 'getDefaultRules', args: [HAT] },
    ]);

    expect(rules.eligible).toBe(true);
    expect(rules[0]).toBe(true);
    expect(rules[1]).toBe(true);
  });

  it('a reverted sub-call is re-issued, never decoded as a falsy answer', async () => {
    // getMaxDailyVouches reverts inside the aggregate (older module).
    const { provider, direct } = multicallProvider(fn =>
      fn === 'getMaxDailyVouches' ? null : GATE_ANSWERS[fn] ?? null
    );

    await expect(readVoucherGate(provider, EM_ADDR, WEARER)).rejects.toThrow(/getMaxDailyVouches/);
    expect(direct).toEqual(['getMaxDailyVouches']);
  });

  it('falls back to direct calls when Multicall3 is not deployed', async () => {
    const { provider, direct } = multicallProvider(fn => GATE_ANSWERS[fn] ?? null);
    provider.getCode = vi.fn(async () => '0x');

    const gate = await readVoucherGate(provider, EM_ADDR, WEARER);

    expect(gate.maxDaily).toBe(20);
    expect(direct).toEqual([
      'canUserVouch',
      'getCurrentDailyVouchCount',
      'getMaxDailyVouches',
      'getUserJoinTime',
    ]);
  });
});

describe('requireSuperAdminWithRead — superAdmin + one pre-flight read in one trip', () => {
  it('returns the extra read when the signer IS the superAdmin', async () => {
    const { provider } = multicallProvider(fn => GATE_ANSWERS[fn] ?? null);

    const { admin, extra, extraError } = await requireSuperAdminWithRead(
      provider, EM_ADDR, SUPER_ADMIN, 'Setting default eligibility',
      { fn: 'getVouchConfig', args: [HAT] }
    );

    expect(admin.toLowerCase()).toBe(SUPER_ADMIN.toLowerCase());
    expect(Number(extra.quorum)).toBe(3);
    expect(extraError).toBeNull();
    expect(provider.call).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-superAdmin signer with the same PreconditionError as before', async () => {
    const { provider } = multicallProvider(fn => GATE_ANSWERS[fn] ?? null);

    await expect(requireSuperAdminWithRead(
      provider, EM_ADDR, '0x0000000000000000000000000000000000000009', 'configureVouching',
      { fn: 'getDefaultRules', args: [HAT] }
    )).rejects.toBeInstanceOf(PreconditionError);
  });

  it('a failed EXTRA read is surfaced as null, not as a blocked write', async () => {
    const { provider } = multicallProvider(fn =>
      fn === 'getVouchConfig' ? null : GATE_ANSWERS[fn] ?? null
    );

    const { admin, extra, extraError } = await requireSuperAdminWithRead(
      provider, EM_ADDR, SUPER_ADMIN, 'Setting default eligibility',
      { fn: 'getVouchConfig', args: [HAT] }
    );

    expect(admin.toLowerCase()).toBe(SUPER_ADMIN.toLowerCase());
    expect(extra).toBeNull();
    expect(extraError).toBeTruthy();
  });

  it('an unreadable superAdmin() still raises the unreadable-module error', async () => {
    const { provider } = multicallProvider(fn => (fn === 'superAdmin' ? null : GATE_ANSWERS[fn] ?? null));

    await expect(requireSuperAdminWithRead(
      provider, EM_ADDR, SUPER_ADMIN, 'configureVouching',
      { fn: 'getDefaultRules', args: [HAT] }
    )).rejects.toThrow(/Could not read superAdmin/);
  });
});

describe('subgraph vouch readers', () => {
  const ROW = {
    id: `${EM_ADDR}-${HAT.toString()}`,
    hatId: HAT.toString(),
    quorum: 1,
    membershipHatId: '29089782865237956770482606498400312925615312744021346470950225330569216',
    enabled: true,
    combinesWithHierarchy: true,
  };

  beforeEach(() => vi.clearAllMocks());

  it('maps a live-shaped VouchConfig row onto the RPC-decoded view', async () => {
    mocks.query.mockResolvedValue({ vouchConfigs: [ROW] });

    const config = await fetchVouchConfigFromSubgraph(EM_ADDR, HAT, 100);

    expect(config).toEqual({
      quorum: 1,
      membershipHatId: ROW.membershipHatId,
      enabled: true,
      combineWithHierarchy: true,
    });
  });

  it('counts ACTIVE vouch rows as the current vouch count', async () => {
    mocks.query.mockResolvedValue({ vouchConfigs: [ROW], vouches: [{ id: 'a' }, { id: 'b' }] });

    const state = await fetchWearerVouchStateFromSubgraph(EM_ADDR, HAT, WEARER, 100);

    expect(state).toEqual({
      config: {
        quorum: 1,
        membershipHatId: ROW.membershipHatId,
        enabled: true,
        combineWithHierarchy: true,
      },
      currentCount: 2,
    });
  });

  it('a missing row is ambiguous (never-configured vs not-indexed) → null', async () => {
    mocks.query.mockResolvedValue({ vouchConfigs: [], vouches: [] });
    expect(await fetchVouchConfigFromSubgraph(EM_ADDR, HAT, 100)).toBeNull();
    expect(await fetchWearerVouchStateFromSubgraph(EM_ADDR, HAT, WEARER, 100)).toBeNull();
  });

  it('a null field on an older deployment → null, never a half-filled config', async () => {
    mocks.query.mockResolvedValue({
      vouchConfigs: [{ ...ROW, combinesWithHierarchy: null }],
      vouches: [],
    });
    expect(await fetchVouchConfigFromSubgraph(EM_ADDR, HAT, 100)).toBeNull();
  });

  it('a full 1000-row page cannot be trusted as a count → null', async () => {
    mocks.query.mockResolvedValue({
      vouchConfigs: [ROW],
      vouches: Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })),
    });
    expect(await fetchWearerVouchStateFromSubgraph(EM_ADDR, HAT, WEARER, 100)).toBeNull();
  });

  it('a query error degrades to null instead of throwing', async () => {
    mocks.query.mockRejectedValue(new Error('502 bad gateway'));
    expect(await fetchVouchConfigFromSubgraph(EM_ADDR, HAT, 100)).toBeNull();
    expect(await fetchWearerVouchStateFromSubgraph(EM_ADDR, HAT, WEARER, 100)).toBeNull();
  });

  it('sends the hat id as a decimal BigInt string', async () => {
    mocks.query.mockResolvedValue({ vouchConfigs: [ROW] });
    await fetchVouchConfigFromSubgraph(EM_ADDR, HAT, 100);

    const [, variables, chainId] = mocks.query.mock.calls[0];
    expect(variables.hatId).toBe(HAT.toString());
    expect(variables.hatId).not.toMatch(/^0x/);
    expect(variables.eligibilityModuleId).toBe(EM_ADDR);
    expect(chainId).toBe(100);
  });
});
