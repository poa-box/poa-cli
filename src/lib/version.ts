/**
 * Implementation feature detection — CLI wrapper over @poa/core/version.
 *
 * Everything (selector math, EIP-1967 slot walk, bytecode scan, the
 * known-implementation feature table, legacy fragments) lives in core. The one
 * CLI binding: detectTaskManagerFeatures injects this process's GraphClient so
 * the subgraph beacon shortcut keeps working without every call site having to
 * pass one. The local export shadows the star re-export per ES module rules.
 */

import { ethers } from 'ethers';
import { detectTaskManagerFeatures as coreDetect } from '@poa/core/version';
import type { DetectFeaturesOptions, TaskManagerFeatures } from '@poa/core/version';
import { fetchOrgBeaconSnapshot } from '../queries/beacons';

export * from '@poa/core/version';

/**
 * Probe a TaskManager proxy's implementation for feature selectors.
 * See @poa/core/version for resolution order and caching. The CLI injects the
 * beacon-snapshot fetcher from its own queries/beacons module (the seam tests
 * mock) unless the caller supplied a client/fetcher or asked to skip the
 * subgraph.
 */
export async function detectTaskManagerFeatures(
  provider: ethers.providers.Provider,
  proxy: string,
  chainId?: number,
  opts?: DetectFeaturesOptions
): Promise<TaskManagerFeatures> {
  return coreDetect(provider, proxy, chainId, {
    ...opts,
    fetchBeaconSnapshot:
      opts?.fetchBeaconSnapshot
      ?? (opts?.client ? undefined : (orgId, cid) => fetchOrgBeaconSnapshot(orgId, cid)),
  });
}
