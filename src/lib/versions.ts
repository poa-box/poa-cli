/**
 * Which implementation VERSION is actually behind a module proxy.
 *
 * Every proxy resolves to an implementation address, and ImplementationRegistry emits
 * `ImplementationRegistered(typeId, typeName, versionId, version, implementation, latest)` when
 * that address is registered — carrying the human version string ("v4", "v11", …). Matching the
 * two gives the deployed version per module, which nothing else exposes: the contracts have no
 * `version()` getter, and the registry's own `getImplementation(type, version)` needs the
 * version string you are trying to discover.
 *
 * This exists because guessing is genuinely dangerous. Two tempting shortcuts both give wrong
 * answers, and cost real time when the deployment is heterogeneous:
 *
 *   - Probing for a function that "should" be new: many upgrades change only internal behaviour
 *     or add custom errors, leaving the external surface byte-identical. A probe also proves
 *     nothing unless you first confirm the symbol exists in the reference build — probing a name
 *     that never existed in ANY version reports "absent" for every version.
 *   - Comparing deployed bytecode against a local `forge build`: this repo's default profile has
 *     the optimizer OFF (so vm.roll tests stay honest) while broadcasts use
 *     FOUNDRY_PROFILE=production. Optimizer-off code is ~2.2x larger, so the naive comparison
 *     mismatches on every contract and looks like universal drift.
 *
 * SUBGRAPH FIRST (2026-07): the eth_getLogs(fromBlock 0 → latest) scan below is a genuine
 * liability — many RPC providers reject a range that wide, and the catch returns an empty map,
 * which silently renders EVERY module version "unknown". The subgraph indexes the same facts
 * (Beacon.currentImplementation/version + BeaconUpgradeEvent.newImplementation/version, both
 * verified fully populated on live Gnosis and Arbitrum), so `loadImplementationVersions` reads
 * those first and only touches the log scan when the subgraph cannot name an implementation.
 * The log scan is NOT removed: an implementation that was registered but never promoted onto a
 * global beacon (reachable only by pinning) exists in the registry log and nowhere else.
 */

import { ethers } from 'ethers';
import { fetchImplementationVersionIndex } from '../queries/beacons';

const IMPLEMENTATION_REGISTERED =
  'event ImplementationRegistered(bytes32 indexed typeId, string typeName, bytes32 indexed versionId, string version, address implementation, bool latest)';

/** ERC-1967 beacon slot, and the plain implementation slot for non-beacon proxies. */
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ZERO_WORD = '0x' + '0'.repeat(64);

export interface RegisteredImplementation {
  typeName: string;
  version: string;
  implementation: string;
  /** True when this was the registry's `latest` for its type at registration time. */
  latest: boolean;
}

/** Resolve the implementation a proxy currently delegates to (beacon or direct). */
export async function resolveImplementation(
  provider: ethers.providers.Provider,
  proxy: string
): Promise<string | null> {
  try {
    const beaconWord = await provider.getStorageAt(proxy, BEACON_SLOT);
    if (beaconWord !== ZERO_WORD) {
      const beacon = ethers.utils.getAddress('0x' + beaconWord.slice(26));
      const c = new ethers.Contract(beacon, ['function implementation() view returns (address)'], provider);
      return await c.implementation();
    }
    const implWord = await provider.getStorageAt(proxy, IMPL_SLOT);
    if (implWord !== ZERO_WORD) return ethers.utils.getAddress('0x' + implWord.slice(26));
  } catch {
    // Unreadable proxy — caller degrades to "unknown version".
  }
  return null;
}

/**
 * Every implementation the registry has ever registered, keyed by lowercased address.
 *
 * One `eth_getLogs` over a single global contract. Callers should fetch once and reuse across
 * modules rather than per-module.
 */
export async function fetchRegisteredImplementations(
  provider: ethers.providers.Provider,
  registryAddress: string
): Promise<Map<string, RegisteredImplementation>> {
  const out = new Map<string, RegisteredImplementation>();
  const iface = new ethers.utils.Interface([IMPLEMENTATION_REGISTERED]);
  let logs: ethers.providers.Log[];
  try {
    logs = await provider.getLogs({
      address: registryAddress,
      topics: [iface.getEventTopic('ImplementationRegistered')],
      fromBlock: 0,
      toBlock: 'latest',
    });
  } catch {
    return out; // Some RPCs reject wide ranges — callers treat an empty map as "unknown".
  }
  for (const log of logs) {
    try {
      const d = iface.parseLog(log);
      // Later registrations of the same address win, so `latest` reflects the newest record.
      out.set(String(d.args.implementation).toLowerCase(), {
        typeName: d.args.typeName,
        version: d.args.version,
        implementation: d.args.implementation,
        latest: Boolean(d.args.latest),
      });
    } catch { /* malformed log — skip */ }
  }
  return out;
}

/** Where a version index's records came from, for diagnostics. */
export type VersionIndexSource = 'subgraph' | 'rpc-logs' | 'subgraph+rpc-logs' | 'none';

/**
 * Implementation → version lookup that prefers the subgraph and keeps the
 * registry log scan as an explicitly-triggered fallback.
 */
export interface VersionIndex {
  /** Version record for an implementation address, or undefined. */
  get(implementation: string | null | undefined): RegisteredImplementation | undefined;
  /** Records currently held. */
  readonly size: number;
  readonly source: VersionIndexSource;
  /**
   * Guarantee an answer was attempted for every listed implementation: if the
   * subgraph did not know one of them, run the registry eth_getLogs scan ONCE
   * and merge whatever it adds. Never throws.
   */
  ensure(implementations: Array<string | null | undefined>): Promise<void>;
}

/**
 * Build a VersionIndex: subgraph first, registry logs on demand.
 *
 * `skipSubgraph` exists for offline/unit paths; omitting `provider` or
 * `registryAddress` simply means the log fallback is unavailable and unknown
 * implementations stay unknown (which is the honest answer, not "old").
 */
export async function loadImplementationVersions(opts: {
  provider?: ethers.providers.Provider | null;
  registryAddress?: string | null;
  chainId?: number;
  skipSubgraph?: boolean;
}): Promise<VersionIndex> {
  const map = new Map<string, RegisteredImplementation>();
  let source: VersionIndexSource = 'none';
  let logsAttempted = false;

  if (!opts.skipSubgraph) {
    try {
      const { index } = await fetchImplementationVersionIndex(opts.chainId);
      for (const [key, row] of index) {
        map.set(key, {
          typeName: row.typeName,
          version: row.version,
          implementation: row.implementation,
          latest: row.latest,
        });
      }
      if (map.size > 0) source = 'subgraph';
    } catch {
      // Subgraph unreachable / schema too old — the log scan below covers it.
    }
  }

  const loadLogs = async (): Promise<void> => {
    if (logsAttempted) return;
    logsAttempted = true;
    if (!opts.provider || !opts.registryAddress) return;
    let logged: Map<string, RegisteredImplementation>;
    try {
      logged = await fetchRegisteredImplementations(opts.provider, opts.registryAddress);
    } catch {
      return;
    }
    if (logged.size === 0) return;
    for (const [key, value] of logged) {
      // Subgraph records win: they are the indexed, canonical version string.
      if (!map.has(key)) map.set(key, value);
    }
    source = source === 'subgraph' ? 'subgraph+rpc-logs' : 'rpc-logs';
  };

  // Nothing from the subgraph at all → the log scan is the only source left.
  if (map.size === 0) await loadLogs();

  return {
    get(implementation) {
      if (!implementation) return undefined;
      return map.get(implementation.toLowerCase());
    },
    get size() { return map.size; },
    get source() { return source; },
    async ensure(implementations) {
      const missing = implementations.some(
        (impl) => typeof impl === 'string' && impl.length > 0 && !map.has(impl.toLowerCase())
      );
      if (missing) await loadLogs();
    },
  };
}

/**
 * Deployed version string for a proxy, or null when it cannot be determined.
 *
 * Null is meaningful and must not be rendered as "old" or "current": it means the registry log
 * was unreadable, or the implementation predates registry tracking.
 */
export async function resolveModuleVersion(
  provider: ethers.providers.Provider,
  proxy: string,
  registered: Map<string, RegisteredImplementation>
): Promise<{ implementation: string | null; version: string | null; latest: boolean | null }> {
  const implementation = await resolveImplementation(provider, proxy);
  if (!implementation) return { implementation: null, version: null, latest: null };
  const hit = registered.get(implementation.toLowerCase());
  return {
    implementation,
    version: hit?.version ?? null,
    latest: hit ? hit.latest : null,
  };
}
