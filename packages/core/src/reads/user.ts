/** Account/token history is retained; current organization membership comes from MembershipAuthority. */

import { ethers } from 'ethers';
import type { GraphClient } from '../graph/client';
import {
  FETCH_USERNAME,
  GET_ACCOUNT_BY_USERNAME,
  FETCH_ACCOUNT_USERNAME,
  FETCH_QUICKJOIN_ACCOUNT,
  FETCH_QUICKJOIN_MODULES,
  FETCH_REGISTRY_AND_ACCOUNT,
  FETCH_WHOAMI_ORG_DATA,
  userDataTiers,
  IndexedAccount,
  IndexedQuickJoin,
} from '../graph/documents/user';
import { HOME_CHAIN_ID } from '../chains';
import { resolveOrgId } from './resolve';
import { readAuthorityUsers, readAuthorityRows, FETCH_AUTHORITY_SUBJECTS, FETCH_AUTHORITY_MEMBERSHIPS } from './authority';

// Pure selection helpers live in the documents module — re-exported here so
// read-layer consumers get the guard next to the reads it guards.
export { isAccountAuthoritative } from '../graph/documents/user';
export type { IndexedAccount, IndexedQuickJoin } from '../graph/documents/user';

/** Row shape of GET_ACCOUNT_BY_USERNAME. `id` is the lowercased address. */
export interface AccountByUsername {
  id: string;
  user: string;
  username: string;
}

/**
 * Username → address resolution (GET_ACCOUNT_BY_USERNAME). Returns null when
 * no account is indexed under that exact username (usernames are unique on
 * the registry, so first-of-one is the whole answer).
 */
export async function getAccountByUsername(
  client: GraphClient,
  username: string,
  chainId: number = HOME_CHAIN_ID
): Promise<AccountByUsername | null> {
  const result = await client.query<{ accounts: AccountByUsername[] | null }>(
    GET_ACCOUNT_BY_USERNAME,
    { username },
    chainId
  );
  return result.accounts?.[0] ?? null;
}

/** Account + profile metadata served by FETCH_USERNAME. */
export interface AccountProfile {
  id: string;
  username: string;
  profileMetadataHash: string | null;
  metadata: {
    id: string;
    bio: string | null;
    avatar: string | null;
    github: string | null;
    twitter: string | null;
    website: string | null;
  } | null;
}

/**
 * One address's username + profile metadata — the home-chain read behind
 * `pop user profile` (src/commands/user/profile.ts). Null means no indexed
 * account (never registered, or indexer lag after a fresh registration).
 */
export async function getAccountProfile(
  client: GraphClient,
  address: string,
  chainId: number = HOME_CHAIN_ID
): Promise<AccountProfile | null> {
  const result = await client.query<{ account: AccountProfile | null }>(
    FETCH_USERNAME,
    { id: address.toLowerCase() },
    chainId
  );
  return result.account ?? null;
}

/**
 * Standalone username lookup (username + isDeleted + registry) — the no-org
 * path of `pop user whoami` (src/commands/user/whoami.ts). Gate any use of
 * the returned username with isAccountAuthoritative before trusting it in
 * place of a live registry.getUsername read.
 */
export async function getAccountUsername(
  client: GraphClient,
  address: string,
  chainId: number = HOME_CHAIN_ID
): Promise<IndexedAccount | null> {
  const result = await client.query<{ account: IndexedAccount | null }>(
    FETCH_ACCOUNT_USERNAME,
    { accountID: address.toLowerCase() },
    chainId
  );
  return result.account ?? null;
}

/**
 * The org QuickJoin's module pointers plus one caller's account, in one
 * round-trip — the pre-write read of `pop user join`
 * (src/commands/user/join.ts). The account may only stand in for a live
 * getUsername read when
 * `isAccountAuthoritative(account, quickJoinContract.accountRegistry)`; and
 * the CLI ALWAYS re-reads the registry pointer live before writing, because
 * QuickJoin.updateAddresses can re-point it (see the join command header for
 * why trusting the indexed pointer is unrecoverable in both directions).
 */
export async function getQuickJoinAccount(
  client: GraphClient,
  quickJoinAddress: string,
  accountAddress: string,
  chainId?: number
): Promise<{ quickJoinContract: IndexedQuickJoin | null; account: IndexedAccount | null }> {
  const result = await client.query<{
    quickJoinContract: IndexedQuickJoin | null;
    account: IndexedAccount | null;
  }>(
    FETCH_QUICKJOIN_ACCOUNT,
    { quickJoinAddress: quickJoinAddress.toLowerCase(), accountID: accountAddress.toLowerCase() },
    chainId
  );
  return {
    quickJoinContract: result?.quickJoinContract ?? null,
    account: result?.account ?? null,
  };
}

/** Read the indexed account registry pointer for QuickJoin. */
export async function getQuickJoinModules(
  client: GraphClient,
  quickJoinAddress: string,
  chainId?: number
): Promise<IndexedQuickJoin | null> {
  const result = await client.query<{ quickJoinContract: IndexedQuickJoin | null }>(
    FETCH_QUICKJOIN_MODULES,
    { quickJoinAddress: quickJoinAddress.toLowerCase() },
    chainId
  );
  return result?.quickJoinContract ?? null;
}

/** Account row served by FETCH_REGISTRY_AND_ACCOUNT (profile-merge shape). */
export interface RegistryAccount {
  id: string;
  username: string;
  isDeleted: boolean;
  metadata: {
    bio: string | null;
    avatar: string | null;
    github: string | null;
    twitter: string | null;
    website: string | null;
  } | null;
}

/**
 * The indexed account registry plus one account's username and profile
 * metadata, in one round-trip — everything `pop user update-profile`
 * (src/commands/user/update-profile.ts) reads before it writes.
 * `registryAddress === null` means the registry is not indexed on this chain
 * (subgraph syncing) — the CLI treats that as EXIT.INFRA.
 */
export async function getRegistryAndAccount(
  client: GraphClient,
  address: string,
  chainId: number = HOME_CHAIN_ID
): Promise<{ registryAddress: string | null; account: RegistryAccount | null }> {
  const result = await client.query<{
    universalAccountRegistries: Array<{ id: string }> | null;
    account: RegistryAccount | null;
  }>(
    FETCH_REGISTRY_AND_ACCOUNT,
    { accountID: address.toLowerCase() },
    chainId
  );
  return {
    registryAddress: result?.universalAccountRegistries?.[0]?.id ?? null,
    account: result?.account ?? null,
  };
}

/** Org-scoped user entity served by the FETCH_USER_DATA tier family. */
export interface OrgUser {
  id: string;
  address: string;
  participationTokenBalance: string | null;
  membershipStatus: string | null;
  currentHatIds: string[] | null;
  joinMethod: string | null;
  totalTasksCompleted: string | null;
  totalVotes: string | null;
  totalModulesCompleted: string | null;
  firstSeenAt: string | null;
  lastActiveAt: string | null;
  assignedTasks: Array<{ id: string; taskId: string; title: string | null; payout: string | null; status: string }>;
  completedTasks: Array<{ id: string; taskId: string; title: string | null; payout: string | null }>;
  hybridProposalsCreated: Array<{ id: string; proposalId: string; title: string | null; status: string | null; startTimestamp: string | null; endTimestamp: string | null }>;
  modulesCompleted: Array<{ moduleId: string; completedAt: string | null }>;
  /** v7 claim-churn counters — ONLY when hasChurnCounters (tier 0, Gnosis today). */
  totalTasksReleased?: string;
  totalTasksLostToExpiry?: string;
}

export interface OrgUserProfile {
  /** Org-scoped User entity, or null when the address never touched the org. */
  user: OrgUser | null;
  /** Same-chain account row (username), or null. */
  account: { id: string; username: string } | null;
  /**
   * True when tier 0 (FETCH_USER_DATA_WITH_CHURN) served the answer. Callers
   * must gate any use of totalTasksReleased/totalTasksLostToExpiry on this —
   * `0` ("indexed, never churned") must stay distinguishable from absent
   * ("not indexed on this chain").
   */
  hasChurnCounters: boolean;
}

/**
 * Org membership stats for one address — the org-scoped read of
 * `pop user profile` (src/commands/user/profile.ts). The subgraph User id is
 * `<orgHexId>-<address>`, so an org NAME resolves to the hex id first
 * (a name used directly would silently match nothing). Tier 0 carries the v7
 * claim-churn counters (Gnosis only today); tier 1 is the same document
 * without them.
 */
export async function getOrgUserProfile(
  client: GraphClient,
  orgIdOrName: string,
  address: string,
  chainId?: number
): Promise<OrgUserProfile> {
  const orgId = await resolveOrgId(client, orgIdOrName, chainId);
  const orgUserID = `${orgId.toLowerCase()}-${address.toLowerCase()}`;

  const { data, tierIndex } = await client.queryWithFieldFallback<{
    user: OrgUser | null;
    account: { id: string; username: string } | null;
  }>(userDataTiers(orgUserID, address.toLowerCase()), { chainId });

  const users = await readAuthorityUsers(client, orgId, data.user ? [data.user] : [], chainId);
  const currentUser = users.find(user => user.address.toLowerCase() === address.toLowerCase());
  return {
    user: currentUser ?? null,
    account: data.account ?? null,
    hasChurnCounters: tierIndex === 0,
  };
}

/** Full whoami snapshot — the one-round-trip payload of FETCH_WHOAMI_ORG_DATA. */
export interface WhoamiOrgData {
  organization: {
    id: string;
    name: string | null;
    roles: Array<{ hatId: string; subjectId: string; name: string | null }>;
  } | null;
  quickJoinContract: IndexedQuickJoin | null;
  account: IndexedAccount | null;
  tokenBalance: { id: string; balance: string } | null;
  user: {
    id: string;
    membershipStatus: string | null;
    participationTokenBalance: string | null;
    currentHatIds: string[] | null;
  } | null;
  /** Pending requests by this user — the CLI reports `tokenRequests.length`. */
  tokenRequests: Array<{ id: string }>;
}

/** Account/token history merged with current authority roles and membership. */
export async function getWhoamiOrgData(
  client: GraphClient,
  params: {
    /** Org hex ID (as returned by resolveOrgId / OrgModules.orgId). */
    orgId: string;
    /** ParticipationToken address, or null/undefined when the org has none. */
    participationTokenAddress?: string | null;
    /** QuickJoin address, or null/undefined when the org has none. */
    quickJoinAddress?: string | null;
    /** The identity being inspected. */
    address: string;
  },
  chainId?: number
): Promise<WhoamiOrgData | null> {
  const orgId = await resolveOrgId(client, params.orgId, chainId);
  const address = params.address.toLowerCase();
  const tokenAddress = params.participationTokenAddress || ethers.constants.AddressZero;
  const quickJoinAddress = (params.quickJoinAddress || ethers.constants.AddressZero).toLowerCase();

  const result = await client.query<WhoamiOrgData>(
    FETCH_WHOAMI_ORG_DATA,
    {
      orgId,
      orgUserID: `${orgId}-${address}`,
      tokenAddress,
      userAddress: address,
      quickJoinAddress,
      accountID: address,
      tokenBalanceID: `${tokenAddress.toLowerCase()}-${address}`,
    },
    chainId
  );
  if (!result) return null;
  const [subjects, memberships] = await Promise.all([
    readAuthorityRows(client, orgId, FETCH_AUTHORITY_SUBJECTS, 'subjects', chainId),
    readAuthorityRows(client, orgId, FETCH_AUTHORITY_MEMBERSHIPS, 'subjectMemberships', chainId),
  ]);
  const current = memberships.filter(row => row.user.toLowerCase() === address && row.isMember && row.subject.kind === 'Role');
  if (result.organization) result.organization.roles = subjects.filter(subject => subject.kind === 'Role').map(subject => ({ hatId: subject.subjectId, subjectId: subject.subjectId, name: subject.name }));
  if (result.user) result.user = { ...result.user, membershipStatus: current.length ? 'Active' : 'Inactive', currentHatIds: current.map(row => row.subject.subjectId) };
  return result;
}
