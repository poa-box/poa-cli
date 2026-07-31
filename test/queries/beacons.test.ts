/**
 * queries/beacons — the joins that replace the beacon RPC reads.
 *
 * The rules encoded here were derived from LIVE data (Gnosis poa-gnosis-v-1 +
 * Arbitrum poa-arb-v-1, 2026-07-30) and each one exists because the naive join
 * would be wrong:
 *
 *   - SwitchableBeaconContract.mirrorBeacon is NULL on every live row, so the
 *     switchable row must be joined through RegisteredContract.beacon.
 *   - pinnedImplementation has never been observed populated (zero Pinned rows
 *     on either chain), so Pinned must fall back to RPC, not guess Mirror.
 *   - Subgraph addresses are lowercased; the JSON output has always carried
 *     checksummed ones.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ queryWithFieldFallback: vi.fn() }));
vi.mock('../../src/lib/subgraph', () => ({
  queryWithFieldFallback: mocks.queryWithFieldFallback,
  query: vi.fn(),
}));

import { ethers } from 'ethers';
import {
  buildOrgBeaconSnapshot,
  resolveImplementationFromSnapshot,
  latestImplementationFromSnapshot,
  autoUpgradeFromSnapshot,
  beaconAddressFromSnapshot,
  checksumAddress,
  fetchOrgBeaconSnapshot,
  fetchImplementationVersionIndex,
} from '../../src/queries/beacons';

const TM_TYPE_ID = ethers.utils.id('TaskManager');
const HV_TYPE_ID = ethers.utils.id('HybridVoting');
const ORG_ID = '0x263b2b29f392647f0fb8ddbb26f099e812ab4ba2777e5e07b906277164181f6b';

// Shapes copied from live Gnosis rows (org Test6).
const BEACON_ADDR = '0x4af43d512c5f3cae665b42e07d9295461d4da7c5';
/** The GLOBAL (protocol) beacon for this typeId — Beacon.beaconAddress. */
const GLOBAL_BEACON_ADDR = '0x1db2a05a5e019300cd0dcba91185c488e3c01b4d';
const TM_IMPL = '0x7833c4670c42dbce1a7ab1bab7e7baf0a982ff57';
const PROXY = '0x3d93f0d090356d25e7a1614f0f8764b103ca99bc';

function liveShapedData(overrides: {
  mode?: string | null;
  pinnedImplementation?: string | null;
  beacon?: string | null;
  autoUpgrade?: boolean | null;
  mirrorBeacon?: string | null;
  globalBeaconAddress?: string | null;
} = {}) {
  return {
    registeredContracts: [{
      id: '0xd3abcc76e4b876df3bf4d4e1198612e0b0c5f3d3ea6586ac1a98b0fccbfae773',
      typeId: TM_TYPE_ID,
      proxy: PROXY,
      beacon: overrides.beacon !== undefined ? overrides.beacon : BEACON_ADDR,
      autoUpgrade: overrides.autoUpgrade !== undefined ? overrides.autoUpgrade : true,
    }],
    switchableBeaconContracts: [{
      id: BEACON_ADDR,
      typeId: TM_TYPE_ID,
      mode: overrides.mode !== undefined ? overrides.mode : 'Mirror',
      mirrorBeacon: overrides.mirrorBeacon ?? null, // null on EVERY live row today
      pinnedImplementation: overrides.pinnedImplementation ?? null,
    }],
    beacons: [
      { typeId: TM_TYPE_ID, typeName: 'TaskManager', currentImplementation: TM_IMPL, version: 'v6', beaconAddress: overrides.globalBeaconAddress !== undefined ? overrides.globalBeaconAddress : GLOBAL_BEACON_ADDR },
      { typeId: HV_TYPE_ID, typeName: 'HybridVoting', currentImplementation: '0x51a786160118961bdcef033baa7246fb3512a780', version: 'v11' },
    ],
  };
}

describe('buildOrgBeaconSnapshot — joins', () => {
  it('joins the switchable beacon through RegisteredContract.beacon, not mirrorBeacon', () => {
    const snap = buildOrgBeaconSnapshot(liveShapedData());
    const entry = snap.byTypeId.get(TM_TYPE_ID.toLowerCase());
    expect(entry?.switchable?.id).toBe(BEACON_ADDR);
    expect(entry?.switchable?.mirrorBeacon).toBeNull(); // never used
    expect(entry?.registered?.proxy).toBe(PROXY);
    expect(entry?.globalBeacon?.version).toBe('v6');
  });

  it('address casing in the RegisteredContract.beacon link does not break the join', () => {
    const data = liveShapedData({ beacon: ethers.utils.getAddress(BEACON_ADDR) });
    const snap = buildOrgBeaconSnapshot(data);
    expect(snap.byTypeId.get(TM_TYPE_ID.toLowerCase())?.switchable?.mode).toBe('Mirror');
  });

  it('leaves switchable undefined when the beacon address is not indexed', () => {
    const snap = buildOrgBeaconSnapshot(liveShapedData({ beacon: null }));
    expect(snap.byTypeId.get(TM_TYPE_ID.toLowerCase())?.switchable).toBeUndefined();
  });
});

describe('resolveImplementationFromSnapshot — refuses to guess', () => {
  it('Mirror resolves to the global beacon implementation for the same typeId', () => {
    const snap = buildOrgBeaconSnapshot(liveShapedData());
    const resolved = resolveImplementationFromSnapshot(snap, TM_TYPE_ID);
    expect(resolved).toEqual({
      implementation: ethers.utils.getAddress(TM_IMPL),
      version: 'v6',
      mode: 'Mirror',
    });
  });

  it('Pinned with a NULL pinnedImplementation returns null (caller must use RPC)', () => {
    const snap = buildOrgBeaconSnapshot(liveShapedData({ mode: 'Pinned' }));
    expect(resolveImplementationFromSnapshot(snap, TM_TYPE_ID)).toBeNull();
  });

  it('Pinned WITH a value is honoured and never falls through to the mirror impl', () => {
    const pinned = '0xd388953eee145247e1f8a51c5a0ddefc2c3db915';
    const snap = buildOrgBeaconSnapshot(liveShapedData({ mode: 'Pinned', pinnedImplementation: pinned }));
    const resolved = resolveImplementationFromSnapshot(snap, TM_TYPE_ID);
    expect(resolved?.implementation).toBe(ethers.utils.getAddress(pinned));
    expect(resolved?.implementation).not.toBe(ethers.utils.getAddress(TM_IMPL));
  });

  // The deployed mappings write "Static" (handlePinned), never "Pinned".
  it('Static — the value the subgraph ACTUALLY writes — is treated as pinned', () => {
    const snap = buildOrgBeaconSnapshot(liveShapedData({ mode: 'Static' }));
    // Null pinnedImplementation -> RPC, exactly like the Pinned alias.
    expect(resolveImplementationFromSnapshot(snap, TM_TYPE_ID)).toBeNull();

    const pinned = '0xd388953eee145247e1f8a51c5a0ddefc2c3db915';
    const withValue = buildOrgBeaconSnapshot(liveShapedData({ mode: 'Static', pinnedImplementation: pinned }));
    const resolved = resolveImplementationFromSnapshot(withValue, TM_TYPE_ID);
    expect(resolved?.implementation).toBe(ethers.utils.getAddress(pinned));
    // ...and NOT the mirror implementation, which is what an unhandled mode
    // string would have silently produced before.
    expect(resolved?.implementation).not.toBe(ethers.utils.getAddress(TM_IMPL));
  });

  it('a Mirror pointing at a FOREIGN beacon falls back to RPC instead of the global impl', () => {
    // setMirror(addr) accepts any contract with a non-zero implementation — nothing
    // ties it to the POA global beacon for this typeId. Joining by typeId would
    // report the global implementation with upToDate: true for a module that is
    // actually mirroring something else entirely.
    const snap = buildOrgBeaconSnapshot(liveShapedData({
      mode: 'Mirror',
      mirrorBeacon: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    }));
    expect(resolveImplementationFromSnapshot(snap, TM_TYPE_ID)).toBeNull();
  });

  it('a Mirror pointing at THIS global beacon still resolves from the index', () => {
    const snap = buildOrgBeaconSnapshot(liveShapedData({
      mode: 'Mirror',
      mirrorBeacon: GLOBAL_BEACON_ADDR.toUpperCase().replace('0X', '0x'),
    }));
    expect(resolveImplementationFromSnapshot(snap, TM_TYPE_ID)?.implementation)
      .toBe(ethers.utils.getAddress(TM_IMPL));
  });

  it('the live case — mirrorBeacon null — keeps resolving from the index', () => {
    const snap = buildOrgBeaconSnapshot(liveShapedData({ mode: 'Mirror', mirrorBeacon: null }));
    expect(resolveImplementationFromSnapshot(snap, TM_TYPE_ID)?.implementation)
      .toBe(ethers.utils.getAddress(TM_IMPL));
  });

  it('unknown/absent mode returns null rather than assuming Mirror', () => {
    expect(resolveImplementationFromSnapshot(buildOrgBeaconSnapshot(liveShapedData({ mode: null })), TM_TYPE_ID)).toBeNull();
    expect(resolveImplementationFromSnapshot(buildOrgBeaconSnapshot(liveShapedData({ mode: 'Frozen' })), TM_TYPE_ID)).toBeNull();
  });

  it('a zero-address currentImplementation is treated as unknown, not as an answer', () => {
    const data = liveShapedData();
    data.beacons[0].currentImplementation = ethers.constants.AddressZero;
    expect(resolveImplementationFromSnapshot(buildOrgBeaconSnapshot(data), TM_TYPE_ID)).toBeNull();
  });

  it('null snapshot / unknown typeId → null', () => {
    expect(resolveImplementationFromSnapshot(null, TM_TYPE_ID)).toBeNull();
    expect(resolveImplementationFromSnapshot(buildOrgBeaconSnapshot(liveShapedData()), ethers.utils.id('Nope'))).toBeNull();
  });
});

describe('per-field accessors', () => {
  it('latest / autoUpgrade / beacon come back checksummed and typed', () => {
    const snap = buildOrgBeaconSnapshot(liveShapedData());
    expect(latestImplementationFromSnapshot(snap, TM_TYPE_ID)).toBe(ethers.utils.getAddress(TM_IMPL));
    expect(autoUpgradeFromSnapshot(snap, TM_TYPE_ID)).toBe(true);
    expect(beaconAddressFromSnapshot(snap, TM_TYPE_ID)).toBe(ethers.utils.getAddress(BEACON_ADDR));
  });

  it('autoUpgrade false is preserved (not confused with "not indexed")', () => {
    const snap = buildOrgBeaconSnapshot(liveShapedData({ autoUpgrade: false }));
    expect(autoUpgradeFromSnapshot(snap, TM_TYPE_ID)).toBe(false);
  });

  it('missing autoUpgrade → null so the caller falls back to isAutoUpgrade', () => {
    const snap = buildOrgBeaconSnapshot(liveShapedData({ autoUpgrade: null }));
    expect(autoUpgradeFromSnapshot(snap, TM_TYPE_ID)).toBeNull();
  });

  it('latest is available for a type the org has no RegisteredContract for', () => {
    const snap = buildOrgBeaconSnapshot(liveShapedData());
    expect(latestImplementationFromSnapshot(snap, HV_TYPE_ID)).toBe(
      ethers.utils.getAddress('0x51a786160118961bdcef033baa7246fb3512a780')
    );
  });

  it('checksumAddress rejects junk and the zero address', () => {
    expect(checksumAddress(null)).toBeNull();
    expect(checksumAddress('not-an-address')).toBeNull();
    expect(checksumAddress(ethers.constants.AddressZero)).toBeNull();
  });
});

describe('fetchOrgBeaconSnapshot — tiering', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes orgId as both Bytes and String (the organization filter is String)', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({ data: liveShapedData(), tierIndex: 0 });
    await fetchOrgBeaconSnapshot(ORG_ID, 100);
    const tiers = mocks.queryWithFieldFallback.mock.calls[0][0];
    expect(tiers[0].variables).toEqual({ orgId: ORG_ID, orgIdStr: ORG_ID });
    expect(tiers).toHaveLength(3); // full → no-switchable → beacons only
    expect(mocks.queryWithFieldFallback.mock.calls[0][1]).toEqual({ chainId: 100 });
  });

  it('a tier without switchableBeaconContracts still yields autoUpgrade + latest, and no guessed impl', async () => {
    const data: any = liveShapedData();
    delete data.switchableBeaconContracts;
    mocks.queryWithFieldFallback.mockResolvedValue({ data, tierIndex: 1 });

    const snap = await fetchOrgBeaconSnapshot(ORG_ID, 100);
    expect(snap.tierIndex).toBe(1);
    expect(autoUpgradeFromSnapshot(snap, TM_TYPE_ID)).toBe(true);
    expect(latestImplementationFromSnapshot(snap, TM_TYPE_ID)).toBe(ethers.utils.getAddress(TM_IMPL));
    expect(resolveImplementationFromSnapshot(snap, TM_TYPE_ID)).toBeNull(); // mode unknown → RPC
    expect(beaconAddressFromSnapshot(snap, TM_TYPE_ID)).toBe(ethers.utils.getAddress(BEACON_ADDR));
  });
});

describe('fetchImplementationVersionIndex', () => {
  beforeEach(() => vi.clearAllMocks());

  it('indexes current beacons as latest and upgrade history as not-latest', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({
      data: {
        beacons: [{ typeId: TM_TYPE_ID, typeName: 'TaskManager', currentImplementation: TM_IMPL, version: 'v6' }],
        beaconUpgradeEvents: [
          { typeId: TM_TYPE_ID, newImplementation: '0xd388953eee145247e1f8a51c5a0ddefc2c3db915', version: 'v5' },
          // the current impl also appears in history — must stay latest:true
          { typeId: TM_TYPE_ID, newImplementation: TM_IMPL, version: 'v6' },
        ],
      },
      tierIndex: 0,
    });

    const { index } = await fetchImplementationVersionIndex(100);
    expect(index.get(TM_IMPL)).toMatchObject({ version: 'v6', latest: true, typeName: 'TaskManager' });
    expect(index.get('0xd388953eee145247e1f8a51c5a0ddefc2c3db915')).toMatchObject({ version: 'v5', latest: false });
    expect(mocks.queryWithFieldFallback).toHaveBeenCalledTimes(1); // < PAGE_SIZE → no second page
  });

  it('a beacons-only tier still returns the current implementations', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({
      data: { beacons: [{ typeId: TM_TYPE_ID, typeName: 'TaskManager', currentImplementation: TM_IMPL, version: 'v6' }] },
      tierIndex: 1,
    });
    const { index, tierIndex } = await fetchImplementationVersionIndex(100);
    expect(tierIndex).toBe(1);
    expect(index.get(TM_IMPL)?.version).toBe('v6');
    expect(mocks.queryWithFieldFallback).toHaveBeenCalledTimes(1); // no paging on a degraded tier
  });
});
