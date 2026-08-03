/**
 * Shared org/contract resolution helpers.
 * Single source of truth for resolving org names to IDs and fetching contract
 * addresses. Port of src/lib/resolve.ts: functions take the GraphClient
 * explicitly instead of importing a process-global one.
 */

import type { GraphClient } from '../graph/client';
import { FETCH_ORG_BY_ID, GET_ORG_BY_NAME } from '../graph/documents/org';

/**
 * Resolve an org identifier (name or hex ID) to its bytes32 ID.
 * Throws a helpful error if org is not provided.
 */
export async function resolveOrgId(
  client: GraphClient,
  orgIdOrName: string | undefined,
  chainId?: number
): Promise<string> {
  if (!orgIdOrName) {
    throw new Error('Missing --org flag. Provide --org or set POP_DEFAULT_ORG in .env');
  }
  if (orgIdOrName.startsWith('0x')) {
    return orgIdOrName;
  }

  const result = await client.query<{ organizations: Array<{ id: string; name: string }> }>(
    GET_ORG_BY_NAME,
    { name: orgIdOrName },
    chainId
  );

  if (!result.organizations?.length) {
    throw new Error(`Organization "${orgIdOrName}" not found. Use the hex ID or check the org name.`);
  }

  return result.organizations[0].id;
}

export interface OrgModules {
  orgId: string;
  taskManagerAddress: string | null;
  hybridVotingAddress: string | null;
  ddVotingAddress: string | null;
  participationTokenAddress: string | null;
  educationHubAddress: string | null;
  executorAddress: string | null;
  quickJoinAddress: string | null;
  eligibilityModuleAddress: string | null;
  paymentManagerAddress: string | null;
  /** ZkEmailInvites proxy — null for orgs deployed without the optional ZK Email module. */
  zkEmailInvitesAddress: string | null;
}

/**
 * Resolve an org's deployed module addresses via subgraph.
 */
export async function resolveOrgModules(
  client: GraphClient,
  orgIdOrName: string | undefined,
  chainId?: number
): Promise<OrgModules> {
  const orgId = await resolveOrgId(client, orgIdOrName, chainId);

  const result = await client.query<{
    organization: {
      id: string;
      taskManager: { id: string } | null;
      hybridVoting: { id: string } | null;
      directDemocracyVoting: { id: string } | null;
      participationToken: { id: string } | null;
      educationHub: { id: string } | null;
      executorContract: { id: string } | null;
      quickJoin: { id: string } | null;
      eligibilityModule: { id: string } | null;
      paymentManager: { id: string } | null;
      zkEmailInvites: { id: string } | null;
    } | null;
  }>(FETCH_ORG_BY_ID, { id: orgId }, chainId);

  if (!result.organization) {
    throw new Error(`Organization ${orgId} not found on this chain`);
  }

  const org = result.organization;
  return {
    orgId: org.id,
    taskManagerAddress: org.taskManager?.id || null,
    hybridVotingAddress: org.hybridVoting?.id || null,
    ddVotingAddress: org.directDemocracyVoting?.id || null,
    participationTokenAddress: org.participationToken?.id || null,
    educationHubAddress: org.educationHub?.id || null,
    executorAddress: org.executorContract?.id || null,
    quickJoinAddress: org.quickJoin?.id || null,
    eligibilityModuleAddress: org.eligibilityModule?.id || null,
    paymentManagerAddress: org.paymentManager?.id || null,
    zkEmailInvitesAddress: org.zkEmailInvites?.id || null,
  };
}

/**
 * Require a specific module address, throwing a helpful error if not deployed.
 */
export function requireModule(modules: OrgModules, moduleName: keyof OrgModules): string {
  const addr = modules[moduleName];
  if (!addr || typeof addr !== 'string') {
    const friendlyName = moduleName.replace('Address', '').replace(/([A-Z])/g, ' $1').trim();
    throw new Error(`Organization has no ${friendlyName} deployed`);
  }
  return addr;
}
