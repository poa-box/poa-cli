/**
 * lib/versions — subgraph-first version index with the registry log scan kept
 * as an explicit fallback.
 *
 * The eth_getLogs(fromBlock 0 → latest) scan it replaces is the failure this
 * exists to fix: many RPCs reject a range that wide, the catch returns an empty
 * map, and EVERY module then reports "version unknown". These tests pin the two
 * things that must stay true:
 *   1. the log scan is NOT run when the subgraph answered, and
 *   2. it IS run when the subgraph is empty, or when a specific implementation
 *      the subgraph never saw (a beacon pinned to a never-promoted build) is
 *      asked for via ensure().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchImplementationVersionIndex: vi.fn() }));
vi.mock('../../src/queries/beacons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/queries/beacons')>();
  return { ...actual, fetchImplementationVersionIndex: mocks.fetchImplementationVersionIndex };
});

import { ethers } from 'ethers';
import { loadImplementationVersions } from '../../src/lib/versions';

const REGISTRY = '0x1db2a05a5e019300cd0dcba91185c488e3c01b4d';
const INDEXED_IMPL = '0x7833c4670C42dbCe1a7aB1BAB7e7Baf0A982ff57';
const PINNED_ONLY_IMPL = '0xaaAaaa00000000000000000000000000000000aA';

const IMPL_REGISTERED_IFACE = new ethers.utils.Interface([
  'event ImplementationRegistered(bytes32 indexed typeId, string typeName, bytes32 indexed versionId, string version, address implementation, bool latest)',
]);

/** A provider whose getLogs returns one ImplementationRegistered record. */
function providerWithLogs(records: Array<{ typeName: string; version: string; implementation: string; latest: boolean }>) {
  const getLogs = vi.fn(async () => records.map((r) => {
    const encoded = IMPL_REGISTERED_IFACE.encodeEventLog(
      IMPL_REGISTERED_IFACE.getEvent('ImplementationRegistered'),
      [ethers.utils.id(r.typeName), r.typeName, ethers.utils.id(r.version), r.version, r.implementation, r.latest]
    );
    return { ...encoded, blockNumber: 1, address: REGISTRY } as any;
  }));
  return { getLogs } as unknown as ethers.providers.Provider & { getLogs: ReturnType<typeof vi.fn> };
}

function subgraphIndex(rows: Array<{ implementation: string; version: string; typeName?: string; latest?: boolean }>) {
  const index = new Map();
  for (const r of rows) {
    index.set(r.implementation.toLowerCase(), {
      typeName: r.typeName ?? 'TaskManager',
      version: r.version,
      implementation: ethers.utils.getAddress(r.implementation),
      latest: r.latest ?? true,
    });
  }
  return { index, tierIndex: 0 };
}

describe('loadImplementationVersions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('subgraph answers → no eth_getLogs at all', async () => {
    mocks.fetchImplementationVersionIndex.mockResolvedValue(
      subgraphIndex([{ implementation: INDEXED_IMPL, version: 'v6' }])
    );
    const provider = providerWithLogs([]);

    const versions = await loadImplementationVersions({ provider, registryAddress: REGISTRY, chainId: 100 });

    expect(versions.source).toBe('subgraph');
    expect(versions.get(INDEXED_IMPL)?.version).toBe('v6');
    expect(versions.get(INDEXED_IMPL.toLowerCase())?.version).toBe('v6'); // case-insensitive
    expect(provider.getLogs).not.toHaveBeenCalled();
  });

  it('subgraph empty → falls back to the registry log scan', async () => {
    mocks.fetchImplementationVersionIndex.mockResolvedValue({ index: new Map(), tierIndex: 0 });
    const provider = providerWithLogs([
      { typeName: 'TaskManager', version: 'v6', implementation: INDEXED_IMPL, latest: true },
    ]);

    const versions = await loadImplementationVersions({ provider, registryAddress: REGISTRY, chainId: 100 });

    expect(versions.source).toBe('rpc-logs');
    expect(versions.get(INDEXED_IMPL)?.version).toBe('v6');
    expect(provider.getLogs).toHaveBeenCalledTimes(1);
  });

  it('subgraph throwing does not sink the index — the log scan still runs', async () => {
    mocks.fetchImplementationVersionIndex.mockRejectedValue(new Error('subgraph down'));
    const provider = providerWithLogs([
      { typeName: 'TaskManager', version: 'v4', implementation: INDEXED_IMPL, latest: false },
    ]);

    const versions = await loadImplementationVersions({ provider, registryAddress: REGISTRY, chainId: 100 });
    expect(versions.get(INDEXED_IMPL)?.version).toBe('v4');
  });

  it('ensure() tops up from the logs ONLY for an implementation the subgraph never saw', async () => {
    mocks.fetchImplementationVersionIndex.mockResolvedValue(
      subgraphIndex([{ implementation: INDEXED_IMPL, version: 'v6' }])
    );
    const provider = providerWithLogs([
      { typeName: 'TaskManager', version: 'v3-unpromoted', implementation: PINNED_ONLY_IMPL, latest: false },
    ]);

    const versions = await loadImplementationVersions({ provider, registryAddress: REGISTRY, chainId: 100 });

    // Everything known → no scan.
    await versions.ensure([INDEXED_IMPL, null, undefined]);
    expect(provider.getLogs).not.toHaveBeenCalled();

    // A pinned build the subgraph cannot name → scan once, and only once.
    await versions.ensure([PINNED_ONLY_IMPL]);
    await versions.ensure([PINNED_ONLY_IMPL]);
    expect(provider.getLogs).toHaveBeenCalledTimes(1);
    expect(versions.get(PINNED_ONLY_IMPL)?.version).toBe('v3-unpromoted');
    expect(versions.source).toBe('subgraph+rpc-logs');
  });

  it('subgraph records win over log records for the same address', async () => {
    mocks.fetchImplementationVersionIndex.mockResolvedValue(
      subgraphIndex([{ implementation: INDEXED_IMPL, version: 'v6' }])
    );
    const provider = providerWithLogs([
      { typeName: 'TaskManager', version: 'STALE', implementation: INDEXED_IMPL, latest: false },
    ]);

    const versions = await loadImplementationVersions({ provider, registryAddress: REGISTRY, chainId: 100 });
    await versions.ensure([INDEXED_IMPL, PINNED_ONLY_IMPL]); // forces the scan
    expect(versions.get(INDEXED_IMPL)?.version).toBe('v6');
  });

  it('no provider/registry and no subgraph → "none", and unknown stays unknown (not "old")', async () => {
    mocks.fetchImplementationVersionIndex.mockResolvedValue({ index: new Map(), tierIndex: 0 });
    const versions = await loadImplementationVersions({ provider: null, registryAddress: null });
    expect(versions.source).toBe('none');
    expect(versions.size).toBe(0);
    expect(versions.get(INDEXED_IMPL)).toBeUndefined();
    await expect(versions.ensure([INDEXED_IMPL])).resolves.toBeUndefined();
  });

  it('skipSubgraph forces the RPC path', async () => {
    mocks.fetchImplementationVersionIndex.mockResolvedValue(
      subgraphIndex([{ implementation: INDEXED_IMPL, version: 'v6' }])
    );
    const provider = providerWithLogs([
      { typeName: 'TaskManager', version: 'v6-from-logs', implementation: INDEXED_IMPL, latest: true },
    ]);

    const versions = await loadImplementationVersions({
      provider, registryAddress: REGISTRY, skipSubgraph: true,
    });
    expect(mocks.fetchImplementationVersionIndex).not.toHaveBeenCalled();
    expect(versions.get(INDEXED_IMPL)?.version).toBe('v6-from-logs');
  });

  it('a getLogs rejection (wide-range refusal) degrades quietly instead of throwing', async () => {
    mocks.fetchImplementationVersionIndex.mockResolvedValue({ index: new Map(), tierIndex: 0 });
    const provider = { getLogs: vi.fn().mockRejectedValue(new Error('query returned more than 10000 results')) } as any;

    const versions = await loadImplementationVersions({ provider, registryAddress: REGISTRY });
    expect(versions.source).toBe('none');
    expect(versions.get(INDEXED_IMPL)).toBeUndefined();
  });
});
