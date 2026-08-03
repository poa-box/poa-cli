/**
 * Beacon/version queries — CLI wrapper over @poa-box/core/graph/documents/beacons.
 *
 * Documents, types, and the pure snapshot helpers are re-exported verbatim.
 * The two network fetchers take a GraphClient in core; the CLI binds its
 * process-global client so pre-extraction call sites keep their signatures.
 * The local exports shadow the star re-export per ES module rules.
 */

import {
  fetchOrgBeaconSnapshot as coreFetchOrgBeaconSnapshot,
  fetchImplementationVersionIndex as coreFetchImplementationVersionIndex,
} from '@poa-box/core/graph/documents/beacons';
import type { OrgBeaconSnapshot, ImplementationVersionRow } from '@poa-box/core/graph/documents/beacons';
import { subgraphModuleClient } from '../lib/subgraph-module-client';

export * from '@poa-box/core/graph/documents/beacons';

/** Fetch an org's module→beacon snapshot (field-fallback tiered). */
export async function fetchOrgBeaconSnapshot(orgId: string, chainId?: number): Promise<OrgBeaconSnapshot> {
  return coreFetchOrgBeaconSnapshot(subgraphModuleClient(), orgId, chainId);
}

/** Fetch the implementation→version index (paged, field-fallback tiered). */
export async function fetchImplementationVersionIndex(
  chainId?: number
): Promise<{ index: Map<string, ImplementationVersionRow>; tierIndex: number }> {
  return coreFetchImplementationVersionIndex(subgraphModuleClient(), chainId);
}
