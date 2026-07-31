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

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  // Mirrors src/lib/subgraph.ts queryWithFieldFallback: walk the tiers, falling through
  // ONLY on the unknown-field validation error a deployment raises for a field it lacks.
  const queryWithFieldFallback = vi.fn(async (tiers: any[], opts?: any) => {
    let lastValidationError: any;
    for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
      try {
        const data = await query(tiers[tierIndex].query, tiers[tierIndex].variables, opts?.chainId);
        return { data, tierIndex };
      } catch (error: any) {
        const message = String(error?.message ?? error);
        const isValidation = /cannot query field|has no field|unknown field/i.test(message);
        if (!isValidation) throw error;
        lastValidationError = error;
      }
    }
    throw lastValidationError;
  });
  return { query, queryWithFieldFallback };
});
vi.mock('../../src/lib/subgraph', () => ({
  query: mocks.query,
  queryWithFieldFallback: mocks.queryWithFieldFallback,
}));

import { ethers } from 'ethers';
import {
  batchEligibilityReads,
  requireSuperAdminWithRead,
  fetchVouchConfigFromSubgraph,
  fetchWearerVouchStateFromSubgraph,
  readVoucherGate,
  readRevokeGate,
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

describe('readRevokeGate — epoch-aware revoke pre-flight', () => {
  function gateProvider(hasVouched: boolean, currentCount: number) {
    return multicallProvider(fn => {
      if (fn === 'hasVouched') return EM_IFACE.encodeFunctionResult('hasVouched', [hasVouched]);
      if (fn === 'currentVouchCount') {
        return EM_IFACE.encodeFunctionResult('currentVouchCount', [currentCount]);
      }
      return null;
    });
  }

  it('reads hasVouched + currentVouchCount in ONE round-trip', async () => {
    const { provider, direct } = gateProvider(true, 2);

    const gate = await readRevokeGate(provider, EM_ADDR, HAT, WEARER, SUPER_ADMIN);

    expect(gate).toEqual({ hasVouched: true, currentCount: 2 });
    expect(provider.call).toHaveBeenCalledTimes(1);
    expect(direct).toEqual([]);
  });

  it('surfaces the stale-epoch case hasVouched alone cannot see', async () => {
    // hasVouched reads the raw `vouchers` mapping with no epoch filter, so it still says
    // true after a configureVouching voided the vouch. currentVouchCount is epoch-aware
    // and returns 0 — which is what proves revokeVouch would revert HasNotVouched.
    const { provider } = gateProvider(true, 0);

    expect(await readRevokeGate(provider, EM_ADDR, HAT, WEARER, SUPER_ADMIN)).toEqual({
      hasVouched: true,
      currentCount: 0,
    });
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

  /** Deployment predating the epoch mirror: the tier-0 fields fail GraphQL validation. */
  function legacyDeployment(payload: any) {
    mocks.query.mockImplementation(async (gqlQuery: string) => {
      if (gqlQuery.includes('wearerVouchStates')) {
        throw new Error('Type Query has no field "wearerVouchStates"');
      }
      return payload;
    });
  }

  /** Deployment that indexes the epoch mirror: tier 0 answers and tier 1 is never used. */
  function epochAwareDeployment(payload: any) {
    mocks.query.mockImplementation(async (gqlQuery: string) => {
      if (gqlQuery.includes('wearerVouchStates')) return payload;
      throw new Error('legacy tier must not be reached on an epoch-aware deployment');
    });
  }

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

  it('legacy tier: counts ACTIVE vouch rows as the current vouch count', async () => {
    legacyDeployment({ vouchConfigs: [ROW], vouches: [{ id: 'a' }, { id: 'b' }] });

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

  it('legacy tier: a full 1000-row page cannot be trusted as a count → null', async () => {
    legacyDeployment({
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

  /*───────────────────────── epoch mirror (tier 0) ─────────────────────────*/

  const EPOCH_ROW = { ...ROW, epoch: '4' };

  function stateRow(over: Record<string, any> = {}) {
    return { id: 's', count: 2, effectiveCount: 2, epoch: '4', cleared: false, ...over };
  }

  it('epoch tier: reproduces currentVouchCount when the wearer is on the current epoch', async () => {
    epochAwareDeployment({ vouchConfigs: [EPOCH_ROW], wearerVouchStates: [stateRow()] });

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

  it('epoch tier: THE REGRESSION — a stale-epoch tally reads 0, not quorum met', async () => {
    // configureVouching bumped the hat to epoch 4 after these two vouches were cast under
    // epoch 3. On chain currentVouchCount() returns 0; counting rows would have said 2.
    epochAwareDeployment({
      vouchConfigs: [EPOCH_ROW],
      wearerVouchStates: [stateRow({ epoch: '3', effectiveCount: 0 })],
    });

    const state = await fetchWearerVouchStateFromSubgraph(EM_ADDR, HAT, WEARER, 100);
    expect(state?.currentCount).toBe(0);
  });

  it('epoch tier: a cleared wearer sits on the uint256 sentinel and reads 0', async () => {
    epochAwareDeployment({
      vouchConfigs: [EPOCH_ROW],
      wearerVouchStates: [stateRow({
        count: 0,
        effectiveCount: 0,
        epoch: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
        cleared: true,
      })],
    });

    expect((await fetchWearerVouchStateFromSubgraph(EM_ADDR, HAT, WEARER, 100))?.currentCount).toBe(0);
  });

  it('epoch tier: epochs are compared as strings, so uint256 values beyond 2^53 still work', async () => {
    const huge = '18446744073709551617'; // > Number.MAX_SAFE_INTEGER, and huge+1 is not
    epochAwareDeployment({
      vouchConfigs: [{ ...ROW, epoch: huge }],
      wearerVouchStates: [stateRow({ epoch: '18446744073709551618', effectiveCount: 0 })],
    });

    // Number() would round both to the same float and wrongly call this a match.
    expect((await fetchWearerVouchStateFromSubgraph(EM_ADDR, HAT, WEARER, 100))?.currentCount).toBe(0);
  });

  it('epoch tier: no wearer row means never vouched → 0, since the config proves indexing', async () => {
    epochAwareDeployment({ vouchConfigs: [EPOCH_ROW], wearerVouchStates: [] });

    expect((await fetchWearerVouchStateFromSubgraph(EM_ADDR, HAT, WEARER, 100))?.currentCount).toBe(0);
  });

  it('epoch tier: effectiveCount disagreeing with count+epoch means a buggy deployment → null', async () => {
    epochAwareDeployment({
      vouchConfigs: [EPOCH_ROW],
      wearerVouchStates: [stateRow({ epoch: '3', effectiveCount: 2 })], // sweep never ran
    });

    expect(await fetchWearerVouchStateFromSubgraph(EM_ADDR, HAT, WEARER, 100)).toBeNull();
  });

  it('epoch tier: a null epoch on either side is not derivable → null', async () => {
    epochAwareDeployment({ vouchConfigs: [{ ...ROW, epoch: null }], wearerVouchStates: [stateRow()] });
    expect(await fetchWearerVouchStateFromSubgraph(EM_ADDR, HAT, WEARER, 100)).toBeNull();

    epochAwareDeployment({ vouchConfigs: [EPOCH_ROW], wearerVouchStates: [stateRow({ epoch: null })] });
    expect(await fetchWearerVouchStateFromSubgraph(EM_ADDR, HAT, WEARER, 100)).toBeNull();
  });

  it('falls through to the legacy tier when the deployment rejects the epoch fields', async () => {
    legacyDeployment({ vouchConfigs: [ROW], vouches: [{ id: 'a' }] });

    expect((await fetchWearerVouchStateFromSubgraph(EM_ADDR, HAT, WEARER, 100))?.currentCount).toBe(1);
    // Tier 0 was attempted first, then tier 1 served it.
    expect(mocks.query.mock.calls[0][0]).toContain('wearerVouchStates');
    expect(mocks.query.mock.calls[1][0]).not.toContain('wearerVouchStates');
  });

  it('legacy tier: a vouch older than the config update is the epoch ambiguity → null', async () => {
    legacyDeployment({
      vouchConfigs: [{ ...ROW, updatedAtBlock: '500' }],
      vouches: [{ id: 'a', createdAtBlock: '400' }, { id: 'b', createdAtBlock: '600' }],
    });

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
