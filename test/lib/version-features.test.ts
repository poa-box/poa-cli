/**
 * lib/version — the two RPC reductions on the TaskManager feature probe.
 *
 *   1. `opts.orgId` lets the probe take the proxy's beacon from the subgraph
 *      (RegisteredContract.beacon, verified equal to eth_getStorageAt on live
 *      Gnosis) instead of walking the EIP-1967 slot. The IMPLEMENTATION is
 *      still read from the beacon over RPC on purpose: this probe gates writes
 *      (createTask arity, setFolders, updateTaskMetadata), so a stale indexed
 *      implementation would mean broadcasting a doomed transaction.
 *   2. KNOWN_TM_IMPLEMENTATION_FEATURES memoizes the selector scan per
 *      implementation ADDRESS, removing a ~20 KB eth_getCode. It must fail
 *      CLOSED: an unlisted address is scanned, never assumed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchOrgBeaconSnapshot: vi.fn() }));
vi.mock('../../src/queries/beacons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/queries/beacons')>();
  return { ...actual, fetchOrgBeaconSnapshot: mocks.fetchOrgBeaconSnapshot };
});

import { ethers } from 'ethers';
import {
  detectTaskManagerFeatures,
  featuresFromBytecode,
  computeSelector,
  KNOWN_TM_IMPLEMENTATION_FEATURES,
  TM_FEATURE_FRAGMENTS,
  TASK_MANAGER_TYPE_ID,
  EIP1967_BEACON_SLOT,
  _clearVersionCacheForTest,
} from '../../src/lib/version';
import { buildOrgBeaconSnapshot } from '../../src/queries/beacons';

const ZERO_WORD = '0x' + '00'.repeat(32);
const ORG_ID = '0x263b2b29f392647f0fb8ddbb26f099e812ab4ba2777e5e07b906277164181f6b';
const PROXY = '0x3d93f0d090356d25e7a1614f0f8764b103ca99bc';
const BEACON = '0x4af43d512c5f3cae665b42e07d9295461d4da7c5';
/** Live Gnosis TaskManager v6 implementation — a row in the memo table. */
const V6_IMPL = '0x7833c4670c42dbce1a7ab1bab7e7baf0a982ff57';
/** v7 (contracts PR #187) — same implementation address on Gnosis and Arbitrum. */
const V7_IMPL = '0xcfae1dadf1a48b363aad3bbb8f94f67bb3785988';
const UNKNOWN_IMPL = '0x' + 'cd'.repeat(20);

const BEACON_IFACE = new ethers.utils.Interface(['function implementation() view returns (address)']);

function counterProvider(opts: { implementation: string; code?: string }) {
  const counts = { getStorageAt: 0, call: 0, getCode: 0 };
  const provider = {
    async getStorageAt(_addr: string, slot: string) {
      counts.getStorageAt++;
      return slot === EIP1967_BEACON_SLOT ? ethers.utils.hexZeroPad(BEACON, 32) : ZERO_WORD;
    },
    async call(_tx: { to: string; data: string }) {
      counts.call++;
      return BEACON_IFACE.encodeFunctionResult('implementation', [opts.implementation]);
    },
    async getCode() {
      counts.getCode++;
      return opts.code ?? '0x';
    },
    async getNetwork() { return { chainId: 100, name: 'gnosis' }; },
  } as unknown as ethers.providers.Provider;
  return { provider, counts };
}

const MIRROR_SNAPSHOT = buildOrgBeaconSnapshot({
  registeredContracts: [{ id: '0xd3ab', typeId: TASK_MANAGER_TYPE_ID, proxy: PROXY, beacon: BEACON, autoUpgrade: true }],
  switchableBeaconContracts: [{ id: BEACON, typeId: TASK_MANAGER_TYPE_ID, mode: 'Mirror', mirrorBeacon: null, pinnedImplementation: null }],
  beacons: [{ typeId: TASK_MANAGER_TYPE_ID, typeName: 'TaskManager', currentImplementation: V6_IMPL, version: 'v6' }],
});

beforeEach(() => {
  _clearVersionCacheForTest();
  vi.clearAllMocks();
});

describe('KNOWN_TM_IMPLEMENTATION_FEATURES — memo table integrity', () => {
  it('every key is a lowercased address and every row is a complete feature set', () => {
    for (const [address, features] of Object.entries(KNOWN_TM_IMPLEMENTATION_FEATURES)) {
      expect(address).toBe(address.toLowerCase());
      expect(() => ethers.utils.getAddress(address)).not.toThrow();
      expect(Object.keys(features).sort()).toEqual(Object.keys(TM_FEATURE_FRAGMENTS).sort());
      for (const value of Object.values(features)) expect(typeof value).toBe('boolean');
    }
  });

  it('the v6 row matches the shipped v6 capability set (deadlines in, 7-arg create out)', () => {
    expect(KNOWN_TM_IMPLEMENTATION_FEATURES[V6_IMPL]).toEqual({
      deadlines: true, batchCreate: true, editMeta: true, folders: true, legacyCreate7: false, unclaim: false,
    });
  });

  it('the v7 row is v6 plus unclaimTask', () => {
    expect(KNOWN_TM_IMPLEMENTATION_FEATURES[V7_IMPL]).toEqual({
      deadlines: true, batchCreate: true, editMeta: true, folders: true, legacyCreate7: false, unclaim: true,
    });
  });

  it('a table row is exactly what featuresFromBytecode would produce (memo, not a guess)', () => {
    // Synthesise bytecode carrying precisely the v6 row's selectors and confirm
    // the scanner agrees with the recorded row.
    const row = KNOWN_TM_IMPLEMENTATION_FEATURES[V6_IMPL];
    const code = '0x' + Object.entries(row)
      .filter(([, on]) => on)
      .map(([key]) => computeSelector(TM_FEATURE_FRAGMENTS[key as keyof typeof row]).slice(2))
      .join('00');
    expect(featuresFromBytecode(code)).toEqual(row);
  });
});

describe('detectTaskManagerFeatures — implementation resolution', () => {
  it('without orgId: unchanged EIP-1967 slot walk', async () => {
    const { provider, counts } = counterProvider({ implementation: UNKNOWN_IMPL, code: '0x00' });
    await detectTaskManagerFeatures(provider, PROXY, 100);
    expect(counts.getStorageAt).toBe(1);
    expect(counts.call).toBe(1);
    expect(counts.getCode).toBe(1);
    expect(mocks.fetchOrgBeaconSnapshot).not.toHaveBeenCalled();
  });

  it('with orgId: beacon comes from the subgraph, implementation still from the beacon', async () => {
    mocks.fetchOrgBeaconSnapshot.mockResolvedValue(MIRROR_SNAPSHOT);
    const { provider, counts } = counterProvider({ implementation: UNKNOWN_IMPL, code: '0x00' });

    await detectTaskManagerFeatures(provider, PROXY, 100, { orgId: ORG_ID });

    expect(counts.getStorageAt).toBe(0);           // slot walk eliminated
    expect(counts.call).toBe(1);                   // beacon.implementation() KEPT (write gate)
    expect(mocks.fetchOrgBeaconSnapshot).toHaveBeenCalledWith(ORG_ID, 100);
  });

  it('the write gate never trusts the indexed implementation over the beacon', async () => {
    // Snapshot says v6; the beacon has already moved to something else. The
    // probe must follow the BEACON, or it would encode the wrong createTask.
    mocks.fetchOrgBeaconSnapshot.mockResolvedValue(MIRROR_SNAPSHOT);
    const { provider } = counterProvider({
      implementation: UNKNOWN_IMPL,
      code: '0x' + computeSelector(TM_FEATURE_FRAGMENTS.legacyCreate7).slice(2),
    });

    const features = await detectTaskManagerFeatures(provider, PROXY, 100, { orgId: ORG_ID });
    expect(features.legacyCreate7).toBe(true);   // from the beacon's real impl
    expect(features.deadlines).toBe(false);      // NOT the snapshot's v6 answer
  });

  it('subgraph failure degrades to the slot walk', async () => {
    mocks.fetchOrgBeaconSnapshot.mockRejectedValue(new Error('subgraph down'));
    const { provider, counts } = counterProvider({ implementation: UNKNOWN_IMPL, code: '0x00' });

    await detectTaskManagerFeatures(provider, PROXY, 100, { orgId: ORG_ID });
    expect(counts.getStorageAt).toBe(1);
    expect(counts.call).toBe(1);
  });

  it('skipSubgraph forces the pure-RPC path', async () => {
    mocks.fetchOrgBeaconSnapshot.mockResolvedValue(MIRROR_SNAPSHOT);
    const { provider, counts } = counterProvider({ implementation: UNKNOWN_IMPL, code: '0x00' });

    await detectTaskManagerFeatures(provider, PROXY, 100, { orgId: ORG_ID, skipSubgraph: true });
    expect(mocks.fetchOrgBeaconSnapshot).not.toHaveBeenCalled();
    expect(counts.getStorageAt).toBe(1);
  });

  it('an un-indexed beacon falls back to the slot walk', async () => {
    mocks.fetchOrgBeaconSnapshot.mockResolvedValue(buildOrgBeaconSnapshot({ beacons: [] }));
    const { provider, counts } = counterProvider({ implementation: UNKNOWN_IMPL, code: '0x00' });

    await detectTaskManagerFeatures(provider, PROXY, 100, { orgId: ORG_ID });
    expect(counts.getStorageAt).toBe(1);
  });
});

describe('detectTaskManagerFeatures — feature memo', () => {
  it('a known implementation skips eth_getCode entirely', async () => {
    const { provider, counts } = counterProvider({ implementation: V6_IMPL });
    const features = await detectTaskManagerFeatures(provider, PROXY, 100);
    expect(counts.getCode).toBe(0);
    expect(features).toEqual(KNOWN_TM_IMPLEMENTATION_FEATURES[V6_IMPL]);
  });

  it('checksummed implementations hit the (lowercased) table too', async () => {
    const { provider, counts } = counterProvider({ implementation: ethers.utils.getAddress(V6_IMPL) });
    await detectTaskManagerFeatures(provider, PROXY, 100);
    expect(counts.getCode).toBe(0);
  });

  it('FAILS CLOSED: an unknown implementation is scanned, and empty code means no features', async () => {
    const { provider, counts } = counterProvider({ implementation: UNKNOWN_IMPL, code: '0x' });
    const features = await detectTaskManagerFeatures(provider, PROXY, 100);
    expect(counts.getCode).toBe(1);
    expect(features).toEqual({
      deadlines: false, batchCreate: false, editMeta: false, folders: false, legacyCreate7: false, unclaim: false,
    });
  });

  it('the returned table row is a copy — mutating it cannot poison the table', async () => {
    const { provider } = counterProvider({ implementation: V6_IMPL });
    const features = await detectTaskManagerFeatures(provider, PROXY, 100);
    features.folders = false;
    expect(KNOWN_TM_IMPLEMENTATION_FEATURES[V6_IMPL].folders).toBe(true);
  });
});
