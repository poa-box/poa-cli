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
 */

import { ethers } from 'ethers';

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

const featureCache: Map<string, TaskManagerFeatures> = new Map();
const chainIdCache: WeakMap<ethers.providers.Provider, number> = new WeakMap();

async function resolveChainId(provider: ethers.providers.Provider): Promise<number> {
  const cached = chainIdCache.get(provider);
  if (cached !== undefined) return cached;
  const network = await provider.getNetwork();
  chainIdCache.set(provider, network.chainId);
  return network.chainId;
}

/**
 * Probe a TaskManager proxy's implementation bytecode for feature selectors.
 * One getCode per implementation; results cached per `chainId:proxy` for the
 * process lifetime. Pass `chainId` if known to skip the getNetwork round-trip.
 */
export async function detectTaskManagerFeatures(
  provider: ethers.providers.Provider,
  proxy: string,
  chainId?: number
): Promise<TaskManagerFeatures> {
  const resolvedChainId = chainId ?? await resolveChainId(provider);
  const cacheKey = `${resolvedChainId}:${proxy.toLowerCase()}`;
  const cached = featureCache.get(cacheKey);
  if (cached) return cached;

  const impl = await getImplementation(provider, proxy);
  const code = (await provider.getCode(impl)).toLowerCase();
  const has = (fragment: string): boolean =>
    code.includes(computeSelector(fragment).slice(2).toLowerCase());

  const features: TaskManagerFeatures = {
    deadlines: has(TM_FEATURE_FRAGMENTS.deadlines),
    batchCreate: has(TM_FEATURE_FRAGMENTS.batchCreate),
    editMeta: has(TM_FEATURE_FRAGMENTS.editMeta),
    folders: has(TM_FEATURE_FRAGMENTS.folders),
    legacyCreate7: has(TM_FEATURE_FRAGMENTS.legacyCreate7),
  };
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
