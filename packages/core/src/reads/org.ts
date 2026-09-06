/**
 * Org reads — typed wrappers over the org subgraph documents.
 *
 * Ports the read layer of:
 *   - `pop org view`    — src/commands/org/view.ts
 *   - `pop org list`    — src/commands/org/list.ts
 *   - `pop org members` — src/commands/org/members.ts
 *   - `pop org roles`   — src/commands/org/roles.ts
 *   - `pop org status`  — src/commands/org/status.ts (activity slice only; the
 *     module-version panel is beacon/RPC machinery owned by the infra layer)
 *
 * Rows come back raw from the subgraph — a null row means "not indexed on
 * this chain", which for a young org can mean "not indexed YET", not
 * "nonexistent".
 */

import { ethers } from 'ethers';
import type { GraphClient, ChainQueryResult } from '../graph/client';
import {
  FETCH_ORG_FULL_DATA,
  GET_ORG_BY_NAME,
  FETCH_USER_ORGANIZATIONS,
} from '../graph/documents/org';
import {
  FETCH_ORG_METADATA_ADMIN_HAT,
} from '../graph/documents/roles';
import type { OrgMetadataAdminHatResult } from '../graph/documents/roles';
import { FETCH_ORG_ACTIVITY, normalizeAuthorityVouches } from '../graph/documents/activity';
import { FETCH_INFRASTRUCTURE_ADDRESSES } from '../graph/documents/infrastructure';
import type { InfrastructureAddresses } from '../graph/documents/infrastructure';
import { createReadContract } from '../contracts';
import { fetchJson } from '../ipfs';
import type { IpfsOptions } from '../ipfs';
import { FETCH_ORG_AUTHORITY, FETCH_AUTHORITY_SUBJECTS, FETCH_AUTHORITY_MEMBERSHIPS, readAuthorityRows, isAuthorityReady, projectAuthorityUsers, readAuthorityUsers } from './authority';

// ---------------------------------------------------------------------------
// Row shapes (raw subgraph entities — minimal, not exhaustive)
// ---------------------------------------------------------------------------

export interface OrgModuleRef {
  id: string;
}

/** Raw Organization row as returned by FETCH_ORG_FULL_DATA. */
export interface OrganizationFullRow {
  membershipAuthority: { id: string; isRouterBound: boolean; cutoverAt: string | null } | null;
  id: string;
  name: string | null;
  metadataHash: string | null;
  metadataAdminHatId: string | null;
  metadata: Record<string, any> | null;
  deployedAt: string | null;
  topHatId: string | null;
  roleHatIds: string[] | null;
  participationToken: { id: string; name: string; symbol: string; totalSupply: string } | null;
  quickJoin: OrgModuleRef | null;
  hybridVoting: { id: string; thresholdPct: string | number; quorum: string | number } | null;
  directDemocracyVoting: { id: string; thresholdPct: string | number; quorum: string | number } | null;
  zkEmailInvites: OrgModuleRef | null;
  taskManager: {
    id: string;
    creatorHatIds: string[] | null;
    projects: Array<{ id: string; tasks: Array<{ id: string; status: string }> }>;
  } | null;
  educationHub: { id: string; modules: any[] } | null;
  executorContract: OrgModuleRef | null;
  paymentManager: OrgModuleRef | null;
  users: Array<{
    id: string;
    address: string;
    account: { username: string | null; metadata: { avatar: string | null } | null } | null;
    participationTokenBalance: string;
    membershipStatus: string;
    currentHatIds: string[] | null;
    totalTasksCompleted: string | null;
    totalVotes: string | null;
    firstSeenAt: string | null;
  }>;
  roles: Array<{
    id: string;
    hatId: string;
    name: string | null;
    image: string | null;
    canVote: boolean;
    isUserRole: boolean;
    hat: { name: string | null } | null;
  }>;
}

// ---------------------------------------------------------------------------
// Inline documents ported from the org command files (not in src/queries)
// ---------------------------------------------------------------------------

/** Verbatim from src/commands/org/list.ts. */
export const LIST_ORGS_QUERY = `
  query ListOrgs($first: Int!) {
    organizations(where: { membershipAuthority_: { isRouterBound: true, cutoverAt_gt: "0" } }, first: $first, orderBy: deployedAt, orderDirection: desc) {
      id
      name
      deployedAt
    }
  }
`;

/** Verbatim from src/commands/org/members.ts. */
export const FETCH_MEMBERS = `
  query FetchMembers($orgId: Bytes!) {
    organization(id: $orgId) {
      participationToken {
        totalSupply
      }
      users(orderBy: participationTokenBalance, orderDirection: desc, first: 100) {
        address
        participationTokenBalance
        membershipStatus
        totalTasksCompleted
        totalVotes
        firstSeenAt
        account {
          username
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Resolve an org name to its 0x id (passthrough for 0x input) — the name
 * lookup `pop org view` performs. Returns null when the name matches nothing
 * (unlike reads/resolve.resolveOrgId, which throws — view-style callers want
 * "not found" as data).
 */
export async function findOrgId(
  client: GraphClient,
  orgIdOrName: string,
  chainId?: number
): Promise<string | null> {
  if (orgIdOrName.startsWith('0x')) {
    const result = await client.query<any>(FETCH_ORG_AUTHORITY, { id: orgIdOrName }, chainId);
    return isAuthorityReady(result.organization) ? result.organization.id : null;
  }
  const result = await client.query<{ organizations: Array<{ id: string; membershipAuthority?: any }> }>(
    GET_ORG_BY_NAME,
    { name: orgIdOrName },
    chainId
  );
  return result.organizations?.find(isAuthorityReady)?.id ?? null;
}

/**
 * Port of the `pop org view` read — src/commands/org/view.ts.
 * Full org snapshot (modules, roles, token, voting config, members) via
 * FETCH_ORG_FULL_DATA. Accepts a name or 0x id; null when not indexed.
 */
export async function getOrganization(
  client: GraphClient,
  orgIdOrName: string,
  chainId?: number
): Promise<OrganizationFullRow | null> {
  const orgId = await findOrgId(client, orgIdOrName, chainId);
  if (!orgId) return null;
  const result = await client.query<{ organization: OrganizationFullRow | null }>(
    FETCH_ORG_FULL_DATA,
    { orgId },
    chainId
  );
  return isAuthorityReady(result.organization) ? result.organization : null;
}

/**
 * The org's metadata document: the indexed projection when present, else the
 * raw IPFS doc behind metadataHash (`pop org view` fallback). Never throws —
 * null when neither source answers. NOTE: for the update-metadata merge base
 * use the RAW IPFS doc, not this convenience read (see tx/org.ts).
 */
export async function getOrgMetadataDoc(
  org: Pick<OrganizationFullRow, 'metadata' | 'metadataHash'>,
  ipfs?: IpfsOptions
): Promise<Record<string, any> | null> {
  if (org.metadata) return org.metadata;
  if (!org.metadataHash) return null;
  try {
    return await fetchJson<Record<string, any>>(org.metadataHash, ipfs);
  } catch {
    return null;
  }
}

/**
 * Current metadata-admin hat (0 = unset → topHat fallback) — port of
 * readMetadataAdminHat in src/commands/org/view.ts.
 *
 * Subgraph-first: Organization.metadataAdminHatId is rewritten by
 * handleOrgMetadataAdminHatSet on every OrgMetadataAdminHatSet event and is
 * non-null on every live org. Only when the subgraph has no value AND a
 * provider is supplied do we resolve the OrgRegistry and read the on-chain
 * getter. Returns null when neither source is reachable; never throws.
 * Display-only by convention — never gate a write on it.
 */
export async function getMetadataAdminHat(
  client: GraphClient,
  orgId: string,
  chainId?: number,
  provider?: ethers.providers.Provider
): Promise<string | null> {
  try {
    const result = await client.query<OrgMetadataAdminHatResult>(
      FETCH_ORG_METADATA_ADMIN_HAT,
      { orgId },
      chainId
    );
    const fromSubgraph = result.organization?.metadataAdminHatId;
    if (fromSubgraph !== undefined && fromSubgraph !== null) {
      return String(fromSubgraph);
    }
  } catch { /* fall through to RPC */ }

  if (!provider) return null;
  try {
    const infra = await client.query<InfrastructureAddresses>(FETCH_INFRASTRUCTURE_ADDRESSES, {}, chainId);
    const orgRegistryAddr = infra.poaManagerContracts?.[0]?.orgRegistryProxy;
    if (!orgRegistryAddr) return null;
    const registry = createReadContract(orgRegistryAddr, 'OrgRegistry', provider);
    const hat = await registry.getOrgMetadataAdminHat(orgId);
    return hat.toString();
  } catch {
    return null;
  }
}

export interface OrgListRow {
  id: string;
  name: string | null;
  deployedAt: string | null;
}

/**
 * Port of the single-chain `pop org list` read — src/commands/org/list.ts.
 */
export async function listOrgs(
  client: GraphClient,
  chainId?: number,
  first = 50
): Promise<OrgListRow[]> {
  const result = await client.query<{ organizations: OrgListRow[] }>(
    LIST_ORGS_QUERY,
    { first },
    chainId
  );
  return result.organizations || [];
}

/**
 * Port of the all-chain `pop org list` sweep — src/commands/org/list.ts.
 * Per-chain failures are reported in ChainQueryResult.error, not thrown.
 */
export async function listOrgsAllChains(
  client: GraphClient,
  first = 50
): Promise<Array<ChainQueryResult<{ organizations: OrgListRow[] }>>> {
  return client.queryAllChains<{ organizations: OrgListRow[] }>(LIST_ORGS_QUERY, { first });
}

export interface UserOrganizationRow {
  id: string;
  membershipStatus: string;
  participationTokenBalance: string;
  totalTasksCompleted: string | null;
  totalVotes: string | null;
  organization: {
    id: string;
    name: string | null;
    metadataHash: string | null;
    participationToken: { symbol: string } | null;
  } | null;
}

/**
 * Port of the `pop org list --member` read — src/commands/org/list.ts
 * (FETCH_USER_ORGANIZATIONS): active memberships for an address.
 */
export const USER_AUTHORITY_ORGS_QUERY = `query UserAuthorityOrganizations($userAddress: Bytes!, $lastId: String!) {
  subjectMemberships(first: 1000, orderBy: id, where: {
    user: $userAddress, isMember: true, id_gt: $lastId, subject_: { kind: Role }
  }) {
    id organization { id name metadataHash membershipAuthority { id isRouterBound cutoverAt } participationToken { symbol } }
  }
}`;

export async function listUserOrganizations(
  client: GraphClient, userAddress: string, chainId?: number
): Promise<UserOrganizationRow[]> {
  const result = await client.query<{ users: UserOrganizationRow[] }>(FETCH_USER_ORGANIZATIONS, { userAddress: userAddress.toLowerCase() }, chainId);
  const rows = new Map<string, UserOrganizationRow>();
  let lastId = '';
  for (;;) {
    const page = await client.query<any>(USER_AUTHORITY_ORGS_QUERY, { userAddress: userAddress.toLowerCase(), lastId }, chainId);
    if (!Array.isArray(page.subjectMemberships)) throw new Error('MembershipAuthority index unavailable: missing subjectMemberships');
    for (const membership of page.subjectMemberships) {
      const org = membership.organization;
      if (!isAuthorityReady(org)) continue;
      const historical = result.users?.find(row => row.organization?.id === org.id);
      rows.set(org.id, { id: historical?.id ?? `${org.id}-${userAddress.toLowerCase()}`,
        membershipStatus: 'Active', participationTokenBalance: historical?.participationTokenBalance ?? '0',
        totalTasksCompleted: historical?.totalTasksCompleted ?? '0', totalVotes: historical?.totalVotes ?? '0', organization: org });
    }
    if (page.subjectMemberships.length < 1000) return [...rows.values()];
    const next = page.subjectMemberships[page.subjectMemberships.length - 1].id;
    if (next <= lastId) throw new Error('MembershipAuthority pagination did not advance');
    lastId = next;
  }
}

export interface OrgMembersResult {
  participationToken: { totalSupply: string } | null;
  users: Array<{
    address: string;
    participationTokenBalance: string;
    membershipStatus: string;
    totalTasksCompleted: string | null;
    totalVotes: string | null;
    firstSeenAt: string | null;
    account: { username: string | null } | null;
  }>;
}

/**
 * Port of the `pop org members` read — src/commands/org/members.ts.
 * Raw member rows ordered by PT balance desc (top 100), plus totalSupply for
 * share math. Null when the org is not indexed.
 */
export async function listMembers(
  client: GraphClient, orgId: string, chainId?: number
): Promise<OrgMembersResult | null> {
  const ready = await client.query<any>(FETCH_ORG_AUTHORITY, { id: orgId }, chainId);
  if (!isAuthorityReady(ready.organization)) return null;
  const [result, memberships] = await Promise.all([
    client.query<{ organization: OrgMembersResult | null }>(FETCH_MEMBERS, { orgId }, chainId),
    readAuthorityRows(client, orgId, FETCH_AUTHORITY_MEMBERSHIPS, 'subjectMemberships', chainId),
  ]);
  if (!result.organization) return null;
  return { ...result.organization, users: projectAuthorityUsers(result.organization.users, memberships).filter(user => user.membershipStatus === 'Active') };
}

export interface OrgRolesResult {
  organization: {
    roles: Array<{
      id: string;
      hatId: string;
      name: string | null;
      image: string | null;
      canVote: boolean;
      isUserRole: boolean;
      /** Present only when tier 0 served (Hat.vouchConfig schema). */
      hat?: {
        id: string;
        vouchConfig: {
          enabled: boolean;
          quorum: string;
          membershipHatId: string;
          combinesWithHierarchy: boolean;
        } | null;
      } | null;
    }>;
    users: Array<{
      address: string;
      participationTokenBalance: string;
      membershipStatus: string;
      currentHatIds: string[] | null;
      account: { username: string | null } | null;
    }>;
    membershipAuthority: { id: string } | null;
  } | null;
}

/** Current roles and membership are authority-owned; continuity fields retain their public names. */
export async function listRoles(
  client: GraphClient, orgId: string, chainId?: number
): Promise<{ data: OrgRolesResult; tierIndex: number }> {
  const result = await client.query<any>(`query AuthorityRoleContext($orgId: Bytes!) {
    organization(id: $orgId) {
      membershipAuthority { id isRouterBound cutoverAt }
      roles { hatId canVote isUserRole }
      users(first: 1000) { address participationTokenBalance account { username } }
    }
  }`, { orgId }, chainId);
  const org = result.organization;
  if (!isAuthorityReady(org)) return { data: { organization: null }, tierIndex: 0 };
  const [subjects, memberships] = await Promise.all([
    readAuthorityRows(client, orgId, FETCH_AUTHORITY_SUBJECTS, 'subjects', chainId),
    readAuthorityRows(client, orgId, FETCH_AUTHORITY_MEMBERSHIPS, 'subjectMemberships', chainId),
  ]);
  const current = memberships.filter(m => m.isMember && m.subject.kind === 'Role');
  const roles = subjects.filter(s => s.kind === 'Role').map(subject => {
    const continuity = org.roles.find((r: any) => r.hatId === subject.subjectId);
    return { ...subject, id: orgId + '-' + subject.subjectId, hatId: subject.subjectId,
      image: subject.imageURI, canVote: continuity?.canVote ?? false, isUserRole: continuity?.isUserRole ?? false,
      hat: null,
    };
  });
  const users = projectAuthorityUsers(org.users, current);
  return { data: { organization: { roles, users, membershipAuthority: org.membershipAuthority } }, tierIndex: 0 };
}

/**
 * Port of the `pop org status` activity read — src/commands/org/status.ts
 * (FETCH_ORG_ACTIVITY). The extra module addresses scope the top-level
 * proposal/vouch/token-request slices; the CLI passes '' for missing modules.
 * Raw result; the status command's module-version panel (beacons/multicall)
 * is separate infrastructure.
 */
export async function getOrgActivity(
  client: GraphClient,
  modules: {
    orgId: string;
    hybridVotingAddress?: string | null;
    membershipAuthorityAddress?: string | null;
    participationTokenAddress?: string | null;
  },
  chainId?: number
): Promise<any> {
  const result = await client.query<any>(FETCH_ORG_ACTIVITY, {
    orgId: modules.orgId,
    hybridVotingId: modules.hybridVotingAddress || '',
    authorityId: modules.membershipAuthorityAddress || '',
    tokenAddress: modules.participationTokenAddress || '',
  }, chainId);
  result.activeVouches = normalizeAuthorityVouches(result.activeVouches ?? []);
  if (result.organization) result.organization.users = await readAuthorityUsers(client, modules.orgId, result.organization.users ?? [], chainId);
  return result;
}

/**
 * Global infrastructure addresses (`FETCH_INFRASTRUCTURE_ADDRESSES`) — the
 * OrgDeployer/OrgRegistry/PaymasterHub/UniversalAccountRegistry proxies and
 * the beacon table.
 */
export async function getInfrastructureAddresses(
  client: GraphClient,
  chainId?: number
): Promise<InfrastructureAddresses> {
  return client.query<InfrastructureAddresses>(FETCH_INFRASTRUCTURE_ADDRESSES, {}, chainId);
}
