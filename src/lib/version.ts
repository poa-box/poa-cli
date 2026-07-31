/**
 * Implementation Version Detection
 * Resolves a proxy's implementation (EIP-1967 beacon / implementation slots,
 * SwitchableBeacon.implementation()) and probes the implementation bytecode
 * for feature selectors so commands can degrade gracefully on orgs whose
 * TaskManager is pinned to an older version.
 *
 * Verified against contracts repo origin/main:
 * - src/SwitchableBeacon.sol — `implementation()` (IBeacon accessor)
 * - src/TaskManager.sol — createTask (9-arg v6), createTasksBatch(bytes32,
 *   CreateTaskInput[]), updateTaskMetadata, setFolders signatures and the
 *   CreateTaskInput struct field order.
 *
 * RPC COST (2026-07): this module is on the hot path of task
 * list/create/create-batch/update/edit-meta/folders, and each call used to cost
 * eth_getStorageAt + eth_call(implementation) + eth_getCode — the last of which
 * ships ~20 KB of hex. Both halves now have a cheaper first choice:
 *
 *   1. Beacon address — the subgraph knows it (RegisteredContract.beacon).
 *      Requires the caller to pass `orgId`; without it the EIP-1967 slot walk
 *      runs exactly as before. The implementation is still fetched FROM the
 *      beacon over RPC, because this function gates writes (see
 *      beaconImplementationViaSubgraph).
 *   2. Feature set — memoized per implementation ADDRESS (see
 *      KNOWN_TM_IMPLEMENTATION_FEATURES). Deployed bytecode at an address is
 *      immutable, so this is a cache of a fact, not a guess about a version
 *      string. An unrecognised address falls back to the bytecode scan, so the
 *      table can only ever remove work — never invent a feature.
 */

import { ethers } from 'ethers';
import { fetchOrgBeaconSnapshot, beaconAddressFromSnapshot } from '../queries/beacons';

/** EIP-1967 beacon slot: keccak256('eip1967.proxy.beacon') - 1 */
export const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

/** EIP-1967 implementation slot: keccak256('eip1967.proxy.implementation') - 1 */
export const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const BEACON_IFACE = new ethers.utils.Interface([
  'function implementation() view returns (address)',
]);

export interface TaskManagerFeatures {
  /** v6 createTask with absoluteDeadline + completionWindow params */
  deadlines: boolean;
  /** createTasksBatch(bytes32, CreateTaskInput[]) */
  batchCreate: boolean;
  /** updateTaskMetadata(uint256, bytes, bytes32) */
  editMeta: boolean;
  /** setFolders(bytes32, bytes32) */
  folders: boolean;
  /** pre-v6 7-arg createTask (no deadline params) */
  legacyCreate7: boolean;
}

/**
 * Human-readable fragments whose runtime-computed selectors identify each
 * feature in implementation bytecode. Signatures verified against contracts
 * repo origin/main src/TaskManager.sol (CreateTaskInput field order:
 * payout, title, metadataHash, bountyToken, bountyPayout,
 * requiresApplication, absoluteDeadline, completionWindow).
 */
export const TM_FEATURE_FRAGMENTS: Record<keyof TaskManagerFeatures, string> = {
  deadlines: 'function createTask(uint256 payout, bytes title, bytes32 metadataHash, bytes32 pid, address bountyToken, uint256 bountyPayout, bool requiresApplication, uint48 absoluteDeadline, uint32 completionWindow)',
  batchCreate: 'function createTasksBatch(bytes32 pid, tuple(uint256 payout, bytes title, bytes32 metadataHash, address bountyToken, uint256 bountyPayout, bool requiresApplication, uint48 absoluteDeadline, uint32 completionWindow)[] tasks) returns (uint256[] taskIds)',
  editMeta: 'function updateTaskMetadata(uint256 id, bytes newTitle, bytes32 newMetadataHash)',
  folders: 'function setFolders(bytes32 expectedCurrentRoot, bytes32 newRoot)',
  legacyCreate7: 'function createTask(uint256 payout, bytes title, bytes32 metadataHash, bytes32 pid, address bountyToken, uint256 bountyPayout, bool requiresApplication)',
};

/**
 * Legacy (pre-v6) TaskManager write fragments, for building a fallback
 * Interface when the org's implementation predates the deadline fields.
 */
export const LEGACY_TM_FRAGMENTS: string[] = [
  TM_FEATURE_FRAGMENTS.legacyCreate7,
  'function updateTask(uint256 id, uint256 newPayout, bytes newTitle, bytes32 newMetadataHash, address newBountyToken, uint256 newBountyPayout)',
  // TaskCreated event (identical shape pre-v6 and v6 — verified against the
  // pre-sync ABI at f3b7216~1) so executeTx's receipt log parsing can still
  // extract the created task id on the legacy path.
  'event TaskCreated(uint256 indexed id, bytes32 indexed project, uint256 payout, address bountyToken, uint256 bountyPayout, bool requiresApplication, bytes title, bytes32 metadataHash)',
];

const selectorCache: Map<string, string> = new Map();

/**
 * Compute the 4-byte selector for a human-readable function fragment at
 * runtime (never hardcode selector hex — signatures drift, keccak does not).
 */
export function computeSelector(fragment: string): string {
  let selector = selectorCache.get(fragment);
  if (selector) return selector;
  const iface = new ethers.utils.Interface([fragment]);
  const signature = Object.keys(iface.functions)[0];
  selector = iface.getSighash(iface.functions[signature]);
  selectorCache.set(fragment, selector);
  return selector;
}

/** Extract a right-aligned address from a 32-byte storage word (null if zero). */
function slotToAddress(word: string | null | undefined): string | null {
  if (!word) return null;
  const padded = ethers.utils.hexZeroPad(word, 32);
  if (ethers.BigNumber.from(padded).isZero()) return null;
  return ethers.utils.getAddress(ethers.utils.hexDataSlice(padded, 12));
}

/**
 * Resolve the implementation behind `proxy`:
 * 1. EIP-1967 beacon slot set → call implementation() on the beacon
 *    (works for SwitchableBeacon and any IBeacon).
 * 2. EIP-1967 implementation slot set → that address.
 * 3. Neither → `proxy` is not a proxy; return it (checksummed) as-is.
 */
export async function getImplementation(
  provider: ethers.providers.Provider,
  proxy: string
): Promise<string> {
  const beacon = slotToAddress(await provider.getStorageAt(proxy, EIP1967_BEACON_SLOT));
  if (beacon) {
    const raw = await provider.call({
      to: beacon,
      data: BEACON_IFACE.encodeFunctionData('implementation'),
    });
    return BEACON_IFACE.decodeFunctionResult('implementation', raw)[0];
  }

  const impl = slotToAddress(await provider.getStorageAt(proxy, EIP1967_IMPLEMENTATION_SLOT));
  if (impl) return impl;

  return ethers.utils.getAddress(proxy);
}

/** keccak256("TaskManager") — the PoaManager/OrgRegistry module type id. */
export const TASK_MANAGER_TYPE_ID = ethers.utils.id('TaskManager');

/** Run the selector scan over already-fetched implementation bytecode. */
export function featuresFromBytecode(code: string): TaskManagerFeatures {
  const lowered = (code || '').toLowerCase();
  const has = (fragment: string): boolean =>
    lowered.includes(computeSelector(fragment).slice(2).toLowerCase());
  return {
    deadlines: has(TM_FEATURE_FRAGMENTS.deadlines),
    batchCreate: has(TM_FEATURE_FRAGMENTS.batchCreate),
    editMeta: has(TM_FEATURE_FRAGMENTS.editMeta),
    folders: has(TM_FEATURE_FRAGMENTS.folders),
    legacyCreate7: has(TM_FEATURE_FRAGMENTS.legacyCreate7),
  };
}

/**
 * Memoized feature scan per TaskManager IMPLEMENTATION ADDRESS (lowercased).
 *
 * Deliberately keyed by address, not by version string. A version→feature table
 * is a guess that fails silently when a release changes shape; deployed
 * bytecode at an address is immutable, so each row below is a recorded fact.
 * Every row was produced by running `featuresFromBytecode` against live
 * eth_getCode on 2026-07-30 — on BOTH Gnosis and Arbitrum, which return
 * byte-identical code at these addresses (deterministic deploys), so a row is
 * not chain-specific. The version comment is documentation only; nothing keys
 * off it.
 *
 * FAIL CLOSED: an address that is not listed here is scanned over RPC. Adding a
 * new TaskManager release is optional — omitting it costs one eth_getCode, it
 * never mis-reports a feature.
 */
export const KNOWN_TM_IMPLEMENTATION_FEATURES: Record<string, TaskManagerFeatures> = {
  // TaskManager v2
  '0xe5ce83cc15360d1948b70e699cd0fa779af320b7':
    { deadlines: false, batchCreate: false, editMeta: false, folders: false, legacyCreate7: true },
  // TaskManager v4 — setFolders introduced
  '0xd1721e7bb458c21485cbc7175a557c23bb4be358':
    { deadlines: false, batchCreate: false, editMeta: false, folders: true, legacyCreate7: true },
  // TaskManager v5 — updateTaskMetadata introduced
  '0xd388953eee145247e1f8a51c5a0ddefc2c3db915':
    { deadlines: false, batchCreate: false, editMeta: true, folders: true, legacyCreate7: true },
  // TaskManager v6 — deadlines + createTasksBatch; 7-arg createTask removed
  '0x7833c4670c42dbce1a7ab1bab7e7baf0a982ff57':
    { deadlines: true, batchCreate: true, editMeta: true, folders: true, legacyCreate7: false },
};

const featureCache: Map<string, TaskManagerFeatures> = new Map();
const chainIdCache: WeakMap<ethers.providers.Provider, number> = new WeakMap();

async function resolveChainId(provider: ethers.providers.Provider): Promise<number> {
  const cached = chainIdCache.get(provider);
  if (cached !== undefined) return cached;
  const network = await provider.getNetwork();
  chainIdCache.set(provider, network.chainId);
  return network.chainId;
}

export interface DetectFeaturesOptions {
  /**
   * Org id. When supplied, the proxy's BEACON address comes from the subgraph
   * (RegisteredContract.beacon) instead of an EIP-1967 slot read; the
   * implementation is still fetched from that beacon over RPC. Omit it and
   * behaviour is exactly as before.
   */
  orgId?: string;
  /** Force the pure-RPC path (offline use / tests). */
  skipSubgraph?: boolean;
}

/**
 * Resolve the implementation behind a TaskManager proxy using the subgraph for
 * the part that is safe to index, and RPC for the part that is not.
 *
 * The subgraph supplies RegisteredContract.beacon — the proxy's EIP-1967 beacon
 * address, verified byte-identical to eth_getStorageAt on live Gnosis (org
 * Test6: 0x4af43d51…d4da7c5 from both). That value is written once at org
 * deployment and effectively never moves, so indexing it carries no staleness
 * risk and removes the eth_getStorageAt.
 *
 * The implementation ITSELF is still read from the beacon over RPC, on purpose.
 * detectTaskManagerFeatures gates writes (createTask arity, setFolders,
 * updateTaskMetadata): if a beacon upgrade landed inside the indexing window,
 * a subgraph-served implementation would pick the wrong calldata shape and
 * broadcast a doomed transaction. Beacon.currentImplementation is used for the
 * read-only version panel, never here.
 *
 * Returns null when the beacon is not indexed — the caller then walks the
 * EIP-1967 slots exactly as before.
 */
async function beaconImplementationViaSubgraph(
  provider: ethers.providers.Provider,
  chainId: number,
  opts?: DetectFeaturesOptions
): Promise<string | null> {
  if (!opts?.orgId || opts.skipSubgraph) return null;
  try {
    const snapshot = await fetchOrgBeaconSnapshot(opts.orgId, chainId);
    const beacon = beaconAddressFromSnapshot(snapshot, TASK_MANAGER_TYPE_ID);
    if (!beacon) return null;
    const raw = await provider.call({
      to: beacon,
      data: BEACON_IFACE.encodeFunctionData('implementation'),
    });
    return BEACON_IFACE.decodeFunctionResult('implementation', raw)[0];
  } catch {
    return null;
  }
}

/**
 * Probe a TaskManager proxy's implementation for feature selectors.
 *
 * Resolution order (each step falls back to the next, never guesses):
 *   implementation: subgraph (needs `opts.orgId`) → EIP-1967 slot walk
 *   features:       KNOWN_TM_IMPLEMENTATION_FEATURES → eth_getCode scan
 *
 * Results are cached per `chainId:proxy` for the process lifetime. Pass
 * `chainId` if known to skip the getNetwork round-trip.
 */
export async function detectTaskManagerFeatures(
  provider: ethers.providers.Provider,
  proxy: string,
  chainId?: number,
  opts?: DetectFeaturesOptions
): Promise<TaskManagerFeatures> {
  const resolvedChainId = chainId ?? await resolveChainId(provider);
  const cacheKey = `${resolvedChainId}:${proxy.toLowerCase()}`;
  const cached = featureCache.get(cacheKey);
  if (cached) return cached;

  const impl = await beaconImplementationViaSubgraph(provider, resolvedChainId, opts)
    ?? await getImplementation(provider, proxy);

  const known = KNOWN_TM_IMPLEMENTATION_FEATURES[impl.toLowerCase()];
  const features: TaskManagerFeatures = known
    ? { ...known }
    : featuresFromBytecode(await provider.getCode(impl));

  featureCache.set(cacheKey, features);
  return features;
}

/**
 * Standard degradation message for commands that hit an org whose
 * implementation predates a feature.
 */
export function featureUnavailable(feature: string, needsVersion: string, remedy: string): string {
  return `${feature} is unavailable: this org's TaskManager implementation predates ${needsVersion}. ${remedy}`;
}

/** Test-only: reset the module-level feature cache. */
export function _clearVersionCacheForTest(): void {
  featureCache.clear();
}
