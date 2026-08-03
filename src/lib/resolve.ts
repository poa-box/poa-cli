/**
 * Shared org/contract resolution helpers — CLI wrapper over @poa-box/core/reads/resolve.
 *
 * Core's functions take a GraphClient explicitly; the CLI binds its
 * process-global client (src/lib/subgraph.ts) so the ~78 command files and the
 * agent's `@poa-box/cli/lib/resolve` deep import keep the pre-extraction
 * signatures.
 */

import {
  resolveOrgId as coreResolveOrgId,
  resolveOrgModules as coreResolveOrgModules,
  requireModule,
} from '@poa-box/core/reads/resolve';
import type { OrgModules } from '@poa-box/core/reads/resolve';
import { subgraphModuleClient } from './subgraph-module-client';

export { requireModule };
export type { OrgModules };

/**
 * Resolve an org identifier (name or hex ID) to its bytes32 ID.
 * Throws a helpful error if org is not provided.
 */
export async function resolveOrgId(orgIdOrName: string | undefined, chainId?: number): Promise<string> {
  return coreResolveOrgId(subgraphModuleClient(), orgIdOrName, chainId);
}

/**
 * Resolve an org's deployed module addresses via subgraph.
 */
export async function resolveOrgModules(orgIdOrName: string | undefined, chainId?: number): Promise<OrgModules> {
  return coreResolveOrgModules(subgraphModuleClient(), orgIdOrName, chainId);
}
