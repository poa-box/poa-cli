/**
 * pop org status — the version panel served from the subgraph.
 *
 * The panel used to cost, for a fully-deployed org, up to 18 EIP-1967 slot
 * reads + 9 PoaManager.getCurrentImplementationById + 9
 * OrgRegistry.isAutoUpgrade calls, for a read-only summary. With an indexed
 * snapshot all of that must go to zero, and the row shape must not move.
 *
 * The degraded shapes matter as much as the happy one, because the live data
 * has real holes: no Pinned beacon has ever existed, so a Pinned row cannot be
 * resolved from the index and MUST fall back to RPC rather than report the
 * mirror implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getImplementation: vi.fn(),
  createReadContract: vi.fn(),
  tryAggregate: vi.fn(),
}));

vi.mock('../../src/lib/version', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/version')>();
  return { ...actual, getImplementation: mocks.getImplementation };
});
vi.mock('../../src/lib/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/contracts')>();
  return { ...actual, createReadContract: mocks.createReadContract };
});
vi.mock('../../src/lib/multicall', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/multicall')>();
  return { ...actual, tryAggregate: mocks.tryAggregate };
});

import { ethers } from 'ethers';
import { buildVersionPanel, versionStatusLabel } from '../../src/commands/org/status';
import { buildOrgBeaconSnapshot } from '../../src/queries/beacons';
import type { OrgModules } from '../../src/lib/resolve';

const ORG_ID = '0x263b2b29f392647f0fb8ddbb26f099e812ab4ba2777e5e07b906277164181f6b';
const TM_TYPE_ID = ethers.utils.id('TaskManager');
const HV_TYPE_ID = ethers.utils.id('HybridVoting');
const TM_PROXY = '0x3d93f0d090356d25e7a1614f0f8764b103ca99bc';
const HV_PROXY = '0xf642dde77848dc195c8089f4042a311ed650d7a6';
const TM_BEACON = '0x4af43d512c5f3cae665b42e07d9295461d4da7c5';
const HV_BEACON = '0xf29ff1ff24e21dc1ddf1aa7fed8a5b1eaea2bbd7';
const TM_IMPL = '0x7833c4670c42dbce1a7ab1bab7e7baf0a982ff57';
const HV_IMPL = '0x51a786160118961bdcef033baa7246fb3512a780';
const OLD_IMPL = '0xd388953eee145247e1f8a51c5a0ddefc2c3db915';

const POA_MANAGER = '0x9999999999999999999999999999999999999999';
const ORG_REGISTRY = '0x5555555555555555555555555555555555555555';

const BEACON_IFACE = new ethers.utils.Interface(['function implementation() view returns (address)']);

function modulesFixture(overrides: Partial<OrgModules> = {}): OrgModules {
  return {
    orgId: ORG_ID,
    taskManagerAddress: TM_PROXY,
    hybridVotingAddress: HV_PROXY,
    ddVotingAddress: null,
    participationTokenAddress: null,
    educationHubAddress: null,
    executorAddress: null,
    quickJoinAddress: null,
    eligibilityModuleAddress: null,
    paymentManagerAddress: null,
    zkEmailInvitesAddress: null,
    ...overrides,
  };
}

function snapshotFixture(opts: { tmMode?: string | null; tmPinned?: string | null; tmAutoUpgrade?: boolean | null } = {}) {
  return buildOrgBeaconSnapshot({
    registeredContracts: [
      { id: '0xd3ab', typeId: TM_TYPE_ID, proxy: TM_PROXY, beacon: TM_BEACON, autoUpgrade: opts.tmAutoUpgrade ?? true },
      { id: '0x8f43', typeId: HV_TYPE_ID, proxy: HV_PROXY, beacon: HV_BEACON, autoUpgrade: false },
    ],
    switchableBeaconContracts: [
      { id: TM_BEACON, typeId: TM_TYPE_ID, mode: opts.tmMode !== undefined ? opts.tmMode : 'Mirror', mirrorBeacon: null, pinnedImplementation: opts.tmPinned ?? null },
      { id: HV_BEACON, typeId: HV_TYPE_ID, mode: 'Mirror', mirrorBeacon: null, pinnedImplementation: null },
    ],
    beacons: [
      { typeId: TM_TYPE_ID, typeName: 'TaskManager', currentImplementation: TM_IMPL, version: 'v6' },
      { typeId: HV_TYPE_ID, typeName: 'HybridVoting', currentImplementation: HV_IMPL, version: 'v11' },
    ],
  });
}

/** contractId = keccak256(abi.encodePacked(orgId, typeId)) — how OrgRegistry keys autoUpgrade. */
function contractId(typeId: string): string {
  return ethers.utils.solidityKeccak256(['bytes32', 'bytes32'], [ORG_ID, typeId]);
}

/**
 * PoaManager/OrgRegistry stubs.
 *
 * autoUpgrade is deliberately NOT served from the snapshot: the deployed subgraph
 * writes RegisteredContract.autoUpgrade once at registration and has no
 * AutoUpgradeSet handler, so it can never observe a later
 * setAutoUpgrade(orgId, typeId, false). 91/91 live Gnosis rows are `true`, so the
 * divergent case has never been exercised on real data. These stubs therefore
 * return the CHAIN's answer, which is what the panel must report.
 */
function stubContracts(autoUpgradeByTypeId: Record<string, boolean> = {}) {
  const poaManager = { getCurrentImplementationById: vi.fn(async () => OLD_IMPL) };
  const orgRegistry = {
    isAutoUpgrade: vi.fn(async (id: string) => {
      for (const [typeId, value] of Object.entries(autoUpgradeByTypeId)) {
        if (contractId(typeId).toLowerCase() === String(id).toLowerCase()) return value;
      }
      return true;
    }),
  };
  mocks.createReadContract.mockImplementation((_addr: string, abiName: string) =>
    abiName === 'PoaManager' ? poaManager : orgRegistry);
  return { poaManager, orgRegistry };
}

const provider = {} as ethers.providers.Provider;
const infra = { poaManagerAddress: POA_MANAGER, orgRegistryAddress: ORG_REGISTRY };
const versionsStub = { get: () => undefined } as any;

beforeEach(() => vi.clearAllMocks());

describe('buildVersionPanel — indexed snapshot', () => {
  it('serves implementation, latest and version with ZERO RPC reads (autoUpgrade stays on chain)', async () => {
    const { poaManager, orgRegistry } = stubContracts({ [TM_TYPE_ID]: true, [HV_TYPE_ID]: false });

    const rows = await buildVersionPanel(provider, modulesFixture(), infra, {
      snapshot: snapshotFixture(),
      versions: versionsStub,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      module: 'TaskManager',
      typeName: 'TaskManager',
      proxy: TM_PROXY,
      implementation: ethers.utils.getAddress(TM_IMPL),
      latestImplementation: ethers.utils.getAddress(TM_IMPL),
      upToDate: true,
      autoUpgrade: true,
      version: 'v6',
    });
    expect(versionStatusLabel(rows[0])).toBe('up to date');
    expect(rows[1].autoUpgrade).toBe(false);
    expect(rows[1].version).toBe('v11');

    expect(mocks.getImplementation).not.toHaveBeenCalled();
    expect(mocks.tryAggregate).not.toHaveBeenCalled();
    expect(poaManager.getCurrentImplementationById).not.toHaveBeenCalled();
    // autoUpgrade IS read live — it is the one field the index cannot keep current,
    // and "autoUpgrade off — beacon pinned" is the annotation this panel exists for.
    expect(orgRegistry.isAutoUpgrade).toHaveBeenCalledTimes(2);
  });

  it('reports the CHAIN autoUpgrade even when the stale index still says true', async () => {
    // The exact divergence the index cannot see: registered with autoUpgrade true,
    // later turned off with setAutoUpgrade. Serving the snapshot value here would
    // report "beacon should catch up" for a permanently pinned module.
    const { orgRegistry } = stubContracts({ [TM_TYPE_ID]: false });

    const rows = await buildVersionPanel(provider, modulesFixture({ hybridVotingAddress: null }), infra, {
      snapshot: snapshotFixture({ tmAutoUpgrade: true }),
      versions: versionsStub,
    });

    expect(orgRegistry.isAutoUpgrade).toHaveBeenCalled();
    expect(rows[0].autoUpgrade).toBe(false);
  });

  it('falls back to the indexed autoUpgrade only when OrgRegistry cannot answer', async () => {
    const { orgRegistry } = stubContracts();
    orgRegistry.isAutoUpgrade.mockRejectedValue(new Error('ContractUnknown'));

    const rows = await buildVersionPanel(provider, modulesFixture({ hybridVotingAddress: null }), infra, {
      snapshot: snapshotFixture({ tmAutoUpgrade: true }),
      versions: versionsStub,
    });

    expect(rows[0].autoUpgrade).toBe(true);
  });

  it('row keys stay exactly the documented set (agents parse --json)', async () => {
    stubContracts();
    const rows = await buildVersionPanel(provider, modulesFixture({ hybridVotingAddress: null }), infra, {
      snapshot: snapshotFixture(), versions: versionsStub,
    });
    expect(Object.keys(rows[0])).toEqual([
      'module', 'typeName', 'proxy', 'implementation', 'latestImplementation',
      'upToDate', 'autoUpgrade', 'version',
    ]);
  });

  it('addresses are checksummed, not the subgraph lowercase form', async () => {
    stubContracts();
    const rows = await buildVersionPanel(provider, modulesFixture({ hybridVotingAddress: null }), infra, {
      snapshot: snapshotFixture(), versions: versionsStub,
    });
    expect(rows[0].implementation).toBe(ethers.utils.getAddress(TM_IMPL));
    expect(rows[0].implementation).not.toBe(TM_IMPL);
  });

  it('a behind-but-autoUpgrade-off module reads as pinned', async () => {
    stubContracts({ [TM_TYPE_ID]: false });
    // Pin the row's own implementation to an older build via a pinned beacon.
    // The deployed mappings write "Static" for this (handlePinned) — "Pinned" is
    // not a value the subgraph ever emits.
    const pinned = buildOrgBeaconSnapshot({
      registeredContracts: [{ id: '0xd3ab', typeId: TM_TYPE_ID, proxy: TM_PROXY, beacon: TM_BEACON, autoUpgrade: false }],
      switchableBeaconContracts: [{ id: TM_BEACON, typeId: TM_TYPE_ID, mode: 'Static', mirrorBeacon: null, pinnedImplementation: OLD_IMPL }],
      beacons: [{ typeId: TM_TYPE_ID, typeName: 'TaskManager', currentImplementation: TM_IMPL, version: 'v6' }],
    });

    const rows = await buildVersionPanel(provider, modulesFixture({ hybridVotingAddress: null }), infra, {
      snapshot: pinned,
      versions: { get: (impl: string) => (impl.toLowerCase() === OLD_IMPL ? { version: 'v5' } : undefined) } as any,
    });

    expect(rows[0].implementation).toBe(ethers.utils.getAddress(OLD_IMPL));
    expect(rows[0].latestImplementation).toBe(ethers.utils.getAddress(TM_IMPL));
    expect(rows[0].upToDate).toBe(false);
    expect(rows[0].version).toBe('v5');
    expect(versionStatusLabel(rows[0])).toContain('autoUpgrade off');
  });
});

describe('buildVersionPanel — partial snapshot falls back, never guesses', () => {
  it('an unresolvable beacon mode resolves the implementation via ONE Multicall3 batch', async () => {
    const { poaManager, orgRegistry } = stubContracts();
    mocks.tryAggregate.mockResolvedValue([
      { success: true, returnData: BEACON_IFACE.encodeFunctionResult('implementation', [OLD_IMPL]) },
    ]);

    // TaskManager beacon is Static with a NULL pinnedImplementation — exactly
    // the live-data hole. HybridVoting stays Mirror and must not be batched.
    const rows = await buildVersionPanel(provider, modulesFixture(), infra, {
      snapshot: snapshotFixture({ tmMode: 'Static', tmPinned: null }),
      versions: versionsStub,
    });

    expect(mocks.tryAggregate).toHaveBeenCalledTimes(1);
    const calls = mocks.tryAggregate.mock.calls[0][1];
    expect(calls).toHaveLength(1);                       // only the unresolved one
    expect(calls[0].to).toBe(ethers.utils.getAddress(TM_BEACON));
    expect(rows[0].implementation).toBe(ethers.utils.getAddress(OLD_IMPL));
    expect(rows[0].upToDate).toBe(false);                // vs the v6 latest
    expect(rows[1].implementation).toBe(ethers.utils.getAddress(HV_IMPL));

    // latest was still indexed, so PoaManager is untouched; autoUpgrade is
    // always read live.
    expect(poaManager.getCurrentImplementationById).not.toHaveBeenCalled();
    expect(orgRegistry.isAutoUpgrade).toHaveBeenCalled();
    expect(mocks.getImplementation).not.toHaveBeenCalled();
  });

  it('a failed multicall entry falls through to the EIP-1967 slot walk', async () => {
    stubContracts();
    mocks.tryAggregate.mockResolvedValue([{ success: false, returnData: '0x' }]);
    mocks.getImplementation.mockResolvedValue(ethers.utils.getAddress(OLD_IMPL));

    const rows = await buildVersionPanel(provider, modulesFixture({ hybridVotingAddress: null }), infra, {
      snapshot: snapshotFixture({ tmMode: 'Static', tmPinned: null }),
      versions: versionsStub,
    });

    expect(mocks.getImplementation).toHaveBeenCalledWith(provider, TM_PROXY);
    expect(rows[0].implementation).toBe(ethers.utils.getAddress(OLD_IMPL));
  });

  it('a snapshot missing autoUpgrade/latest falls back to the contract reads', async () => {
    const { poaManager, orgRegistry } = stubContracts();
    mocks.getImplementation.mockResolvedValue(ethers.utils.getAddress(TM_IMPL));

    const rows = await buildVersionPanel(provider, modulesFixture({ hybridVotingAddress: null }), infra, {
      snapshot: buildOrgBeaconSnapshot({}), // nothing indexed at all
      versions: versionsStub,
    });

    expect(poaManager.getCurrentImplementationById).toHaveBeenCalledWith(TM_TYPE_ID);
    expect(orgRegistry.isAutoUpgrade).toHaveBeenCalledWith(
      ethers.utils.solidityKeccak256(['bytes32', 'bytes32'], [ORG_ID, TM_TYPE_ID])
    );
    expect(mocks.tryAggregate).not.toHaveBeenCalled(); // no beacon address to batch with
    expect(rows[0].implementation).toBe(ethers.utils.getAddress(TM_IMPL));
    expect(rows[0].latestImplementation).toBe(OLD_IMPL);
  });

  it('null snapshot reproduces the original pure-RPC behaviour', async () => {
    const { poaManager, orgRegistry } = stubContracts();
    mocks.getImplementation.mockResolvedValue(ethers.utils.getAddress(TM_IMPL));

    const rows = await buildVersionPanel(provider, modulesFixture({ hybridVotingAddress: null }), infra, {
      snapshot: null, versions: versionsStub,
    });

    expect(mocks.getImplementation).toHaveBeenCalledTimes(1);
    expect(poaManager.getCurrentImplementationById).toHaveBeenCalledTimes(1);
    expect(orgRegistry.isAutoUpgrade).toHaveBeenCalledTimes(1);
    expect(rows[0].upToDate).toBe(false);
  });
});
