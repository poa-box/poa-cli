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
import { FETCH_ORG_AUTHORITY, FETCH_AUTHORITY_SUBJECTS, readAuthorityRows, isAuthorityReady, readAuthorityUsers, projectAuthorityMembership } from './authority';
import { FETCH_ORG_DIRECTORY_PAGE, FETCH_ORG_TASK_COUNT_PAGE, FETCH_AUTHORITY_MEMBERSHIP_CARDS_PAGE, FETCH_USER_MEMBERSHIP_HISTORY_PAGE } from '../graph/documents/org';
import { assertPlanScope, assertSourceBlock, assertSourceRef, Fact, knownFact, requireCompleteSnapshot, SourceRef, SourceSnapshot, unknownFact } from '../data/facts';
import { reduceSourceResults } from '../graph/sources';
import { IndexedRow, ProtocolPageOptions, readIndexedPageFacts } from './protocol';
import { resolveTokenLabel } from '../payout';
import { classifySubjectId } from '../authority/ids';
import { requireRawUint } from '../amounts';

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
    participationTokenBalance: string | null;
    historyIndexed?: boolean;
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
  const org = result.organization;
  if (!org || !isAuthorityReady(org)) return null;
  const [subjects, users] = await Promise.all([
    readAuthorityRows(client, orgId, FETCH_AUTHORITY_SUBJECTS, 'subjects', chainId),
    readAuthorityUsers(client, orgId, org.users ?? [], chainId),
  ]);
  org.users = users;
  org.roles = subjects.filter(subject => subject.kind === 'Role').map(subject => {
    const historical = org.roles?.find(role => role.hatId === subject.subjectId);
    return { ...subject, id: historical?.id ?? `${orgId}-${subject.subjectId}`, hatId: subject.subjectId,
      image: subject.imageURI, canVote: historical?.canVote ?? false,
      canVoteSource: 'historical role metadata', isUserRole: historical?.isUserRole ?? false, hat: null };
  });
  return org;
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
  participationTokenBalance: string | null;
  historyIndexed?: boolean;
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
    userEntity { id participationTokenBalance totalTasksCompleted totalVotes }
  }
}`;

export async function listUserOrganizations(
  client: GraphClient, userAddress: string, chainId?: number
): Promise<UserOrganizationRow[]> {
  const rows = new Map<string, UserOrganizationRow>();
  let lastId = '';
  for (;;) {
    const page = await client.query<any>(USER_AUTHORITY_ORGS_QUERY, { userAddress: userAddress.toLowerCase(), lastId }, chainId);
    if (!Array.isArray(page.subjectMemberships)) throw new Error('MembershipAuthority index unavailable: missing subjectMemberships');
    for (const membership of page.subjectMemberships) {
      const org = membership.organization;
      if (!isAuthorityReady(org)) continue;
      const historical = membership.userEntity;
      rows.set(org.id, { id: historical?.id ?? `${org.id}-${userAddress.toLowerCase()}`,
        membershipStatus: 'Active', historyIndexed: historical != null,
        participationTokenBalance: historical?.participationTokenBalance ?? null,
        totalTasksCompleted: historical?.totalTasksCompleted ?? null, totalVotes: historical?.totalVotes ?? null, organization: org });
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
    participationTokenBalance: string | null;
    /** False for a real authority wallet whose historical User entity is not indexed. */
    historyIndexed?: boolean;
    membershipStatus: string;
    totalTasksCompleted: string | null;
    totalVotes: string | null;
    firstSeenAt: string | null;
    account: { username: string | null } | null;
  }>;
}

/**
 * Port of the `pop org members` read — src/commands/org/members.ts.
 * Complete current member rows, plus totalSupply for
 * share math. Null when the org is not indexed.
 */
export async function listMembers(
  client: GraphClient, orgId: string, chainId?: number
): Promise<OrgMembersResult | null> {
  const ready = await client.query<any>(FETCH_ORG_AUTHORITY, { id: orgId }, chainId);
  if (!isAuthorityReady(ready.organization)) return null;
  const [result, users] = await Promise.all([
    client.query<{ organization: OrgMembersResult | null }>(FETCH_MEMBERS, { orgId }, chainId),
    readAuthorityUsers(client, orgId, [], chainId),
  ]);
  if (!result.organization) return null;
  return { ...result.organization, users: users.filter(user => user.membershipStatus === 'Active') };
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
      participationTokenBalance: string | null;
      historyIndexed?: boolean;
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
  const [subjects, users] = await Promise.all([
    readAuthorityRows(client, orgId, FETCH_AUTHORITY_SUBJECTS, 'subjects', chainId),
    readAuthorityUsers(client, orgId, org.users, chainId),
  ]);
  const roles = subjects.filter(s => s.kind === 'Role').map(subject => {
    const continuity = org.roles.find((r: any) => r.hatId === subject.subjectId);
    return { ...subject, id: orgId + '-' + subject.subjectId, hatId: subject.subjectId,
      image: subject.imageURI, canVote: continuity?.canVote ?? false, isUserRole: continuity?.isUserRole ?? false,
      hat: null,
    };
  });
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

export interface OrganizationDirectoryRow extends IndexedRow {
  id: string;
  name: string | null;
  deployedAt: string | null;
  metadataHash: string | null;
  metadata: { id: string; description: string | null; logo: string | null; backgroundColor: string | null; useTokenSymbol: boolean | null } | null;
  membershipAuthority: { id: string; isRouterBound: boolean; cutoverAt: string | null };
  participationToken: { id: string; name: string; symbol: string; totalSupply: string } | null;
  taskManager: (OrgModuleRef & { organization: { id: string } }) | null;
  source: SourceRef;
}

function identityPageBounds(options: ProtocolPageOptions): void {
  assertSourceRef(options.source);
  if (!options.source.indexed) throw new Error('Indexed identity source required');
  if (options.source.block && options.source.snapshot !== 'pinned') throw new Error('Explicit indexed block requires pinned source');
  if (options.pageSize !== undefined && (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 1000)) throw new Error('Page size must be between 1 and 1000');
}
function cardOrganization(row: IndexedRow): any {
  return row.organization;
}
function validateOrganizationIdentity(org: any): void {
  if (!org || typeof org.id !== 'string' || !/^0x[\da-f]{64}$/i.test(org.id) || !Object.prototype.hasOwnProperty.call(org, 'membershipAuthority')) throw new Error('Organization identity unavailable');
  if (org.membershipAuthority !== null && (!org.membershipAuthority || typeof org.membershipAuthority.isRouterBound !== 'boolean'
    || typeof org.membershipAuthority.id !== 'string' || !Object.prototype.hasOwnProperty.call(org.membershipAuthority, 'cutoverAt'))) throw new Error('Authority readiness unavailable');
  if (org.membershipAuthority?.cutoverAt != null) requireRawUint(org.membershipAuthority.cutoverAt);
}

/** Rich supported-org directory. Coverage/cursor enumerate unfiltered IDs even when an entire
 * page is retired. No full-org fan-out, membership/name/date fallback, or implicit count of users. */
export async function readOrganizationDirectoryFacts(options: ProtocolPageOptions): Promise<SourceSnapshot<readonly OrganizationDirectoryRow[]>> {
  identityPageBounds(options);
  if (options.source.orgId || options.source.account || options.source.contract) throw new Error('Directory source must be unscoped');
  const valid = new Set<IndexedRow>();
  const page = await readIndexedPageFacts({ ...options, document: FETCH_ORG_DIRECTORY_PAGE, collection: 'organizations', variables: {}, initialCursor: '0x', validateRow: row => {
    validateOrganizationIdentity(row);
    for (const field of ['name', 'deployedAt', 'metadataHash']) if (row[field] !== null && typeof row[field] !== 'string') throw new Error('Directory field unavailable');
    if (row.metadata !== null) {
      const metadata = row.metadata as Record<string, unknown> | undefined;
      if (!metadata || typeof metadata.id !== 'string') throw new Error('Directory metadata unavailable');
      for (const field of ['description', 'logo', 'backgroundColor']) if (metadata[field] !== null && typeof metadata[field] !== 'string') throw new Error('Directory metadata field unavailable');
      if (metadata.useTokenSymbol !== null && typeof metadata.useTokenSymbol !== 'boolean') throw new Error('Token label mode unavailable');
    }
    if (row.participationToken !== null) {
      const token = row.participationToken as Record<string, unknown> | undefined;
      if (!token || ['id', 'name', 'symbol', 'totalSupply'].some(field => typeof token[field] !== 'string')) throw new Error('Directory token unavailable');
      requireRawUint(token.totalSupply as string);
    }
    if (row.taskManager !== null) {
      const manager = row.taskManager as OrganizationDirectoryRow['taskManager'];
      if (!manager || !ethers.utils.isAddress(manager.id) || manager.id.toLowerCase() === ethers.constants.AddressZero
        || manager.organization?.id?.toLowerCase() !== String(row.id).toLowerCase()) throw new Error('Directory task manager binding unavailable');
    }
    valid.add(row);
  } });
  const data = page.data.filter(row => valid.has(row) && isAuthorityReady(row)).map(row => ({ ...row, source: { ...page.source, orgId: String(row.id) } } as OrganizationDirectoryRow));
  return { ...page, data };
}

export interface OrganizationTaskCount {
  orgId: string;
  source: SourceRef;
  /** All statuses in nondeleted projects; raw exact count, not a token amount. */
  total: Fact<string>;
  byStatus: Fact<Readonly<Record<string, string>>>;
  /** Observed partial count is diagnostic and never a complete total. */
  observedTotal: string;
}
export interface OrganizationTaskCounts {
  rows: readonly IndexedRow[];
  counts: readonly OrganizationTaskCount[];
  deletedProjectPolicy: 'exclude';
}

/** Complete task counts for a complete supported directory. A later-page failure/cap leaves
 * counts unknown and retains rows. One global task stream handles >100 projects/>1000 tasks. */
export async function readOrganizationTaskCounts(options: ProtocolPageOptions & {
  directory: SourceSnapshot<readonly OrganizationDirectoryRow[]>;
}): Promise<SourceSnapshot<OrganizationTaskCounts>> {
  identityPageBounds(options);
  if (options.source.orgId || options.source.account || options.source.contract) throw new Error('Task count source must be unscoped');
  assertPlanScope(options.directory.source, { chainId: options.source.chainId, endpoint: options.source.endpoint });
  const orgIds = [...new Set(options.directory.data.map(org => typeof org?.id === 'string' ? org.id.toLowerCase() : ''))];
  const moduleOrgs = new Map<string, string>();
  const countData = (rows: readonly IndexedRow[], complete: boolean): OrganizationTaskCounts => ({ rows, deletedProjectPolicy: 'exclude', counts: orgIds.map(orgId => {
    const source = { ...options.source, orgId };
    const statuses: Record<string, string> = {};
    let total = 0n;
    for (const row of rows) {
      if ((row.project as any)?.taskManager?.organization?.id?.toLowerCase() !== orgId) continue;
      total++;
      const status = String(row.status);
      statuses[status] = (BigInt(statuses[status] ?? '0') + 1n).toString();
    }
    return { orgId, source, observedTotal: total.toString(), total: complete ? knownFact(total.toString(), source) : unknownFact<string>('TASK_COUNTS_INCOMPLETE', source),
      byStatus: complete ? knownFact(statuses, source) : unknownFact<Readonly<Record<string, string>>>('TASK_COUNTS_INCOMPLETE', source) };
  }) });
  try {
    const orgs = requireCompleteSnapshot(options.directory, { indexed: true, ...(options.source.snapshot === 'pinned' ? { snapshot: 'pinned' as const, block: options.source.block } : {}) });
    if (options.directory.source.snapshot !== options.source.snapshot) throw new Error('Directory snapshot mismatch');
    if (orgIds.includes('') || orgIds.length !== orgs.length) throw new Error('Missing/duplicate directory organization');
    for (const org of orgs) {
      validateOrganizationIdentity(org);
      if (!isAuthorityReady(org)) throw new Error('Unsupported directory row');
      assertSourceRef(org.source);
      assertPlanScope(org.source, { chainId: options.source.chainId, endpoint: options.source.endpoint, orgId: org.id });
      if (!org.source.indexed || org.source.snapshot !== options.directory.source.snapshot) throw new Error('Directory row provenance mismatch');
      if (options.source.snapshot === 'pinned') {
        assertSourceBlock(org.source.block, options.directory.source.block!);
        assertSourceBlock(options.directory.source.block, org.source.block!);
      }
      if (org.taskManager !== null) {
        const manager = org.taskManager;
        if (!manager || typeof manager.id !== 'string' || !ethers.utils.isAddress(manager.id) || manager.id.toLowerCase() === ethers.constants.AddressZero
          || manager.organization?.id?.toLowerCase() !== org.id.toLowerCase()) throw new Error('Directory module binding unavailable');
        const id = manager.id.toLowerCase();
        if (moduleOrgs.has(id)) throw new Error('Duplicate module-to-org mapping');
        moduleOrgs.set(id, org.id.toLowerCase());
      }
    }
  } catch {
    return { source: options.source, data: countData([], false), coverage: { status: 'unavailable', receivedKeys: [], missingIds: [], failedIds: ['directory'], issues: [{ code: 'COMPLETE_SUPPORTED_DIRECTORY_REQUIRED' }] } };
  }
  const page = await readIndexedPageFacts({ ...options, document: FETCH_ORG_TASK_COUNT_PAGE, collection: 'tasks', initialCursor: '', variables: { taskManagers: [...moduleOrgs.keys()] },
    validateRow: row => {
      const project = row.project as any;
      const manager = typeof row.taskManager === 'string' ? row.taskManager.toLowerCase() : '';
      if (!moduleOrgs.has(manager) || project?.taskManager?.id?.toLowerCase() !== manager
        || moduleOrgs.get(manager) !== project?.taskManager?.organization?.id?.toLowerCase() || typeof project?.id !== 'string' || !project.id || project?.deleted !== false
        || !['Open', 'Assigned', 'Submitted', 'Completed', 'Cancelled'].includes(String(row.status))) throw new Error('Task count scope/status mismatch');
    } });
  if (page.coverage.status === 'complete' && options.source.snapshot === 'pinned') {
    try {
      assertSourceBlock(page.source.block, options.directory.source.block!);
      assertSourceBlock(options.directory.source.block, page.source.block!);
    } catch { page.coverage = { ...page.coverage, status: 'incomplete', issues: [...page.coverage.issues, { code: 'DIRECTORY_PAGE_SOURCE_MISMATCH' }] }; }
  }
  const data = countData(page.data, page.coverage.status === 'complete');
  // Count facts carry the reader's observed source, including verified pinned block evidence.
  data.counts = data.counts.map(count => ({ ...count, source: { ...page.source, orgId: count.orgId },
    total: count.total.state === 'known' ? knownFact(count.total.value, { ...page.source, orgId: count.orgId }) : unknownFact('TASK_COUNTS_INCOMPLETE', { ...page.source, orgId: count.orgId }),
    byStatus: count.byStatus.state === 'known' ? knownFact(count.byStatus.value, { ...page.source, orgId: count.orgId }) : unknownFact('TASK_COUNTS_INCOMPLETE', { ...page.source, orgId: count.orgId }) }));
  return { ...page, data };
}

export interface MembershipCard {
  orgId: string;
  account: string;
  source: SourceRef;
  organization: IndexedRow;
  currentMembership: Fact<boolean>;
  /** Missing history remains null; acceptedAt (including seeded 1) is never a join timestamp. */
  historyIndexed: boolean;
  /** Provenance of retained historical metrics, even when membership enumeration failed. */
  historySource: SourceRef | null;
  firstSeenAt: string | null;
  lastActiveAt: string | null;
  participationTokenBalance: string | null;
  totalTasksCompleted: string | null;
  totalVotes: string | null;
  totalModulesCompleted: string | null;
  tokenLabel: string;
  memberships: readonly IndexedRow[];
}

/** Enriched current/historical cards for one explicit source account. Active roles are folded
 * from authority inputs; historical-only contributors survive. No synthesized join month/metrics. */
export async function readMembershipCardFacts(options: ProtocolPageOptions): Promise<SourceSnapshot<readonly MembershipCard[]>> {
  identityPageBounds(options);
  if (!options.source.account || options.source.orgId || options.source.contract) throw new Error('Explicit unscoped card account required');
  const userAddress = options.source.account.toLowerCase();
  const sources = [ { ...options.source, method: `${options.source.method}:memberships` }, { ...options.source, method: `${options.source.method}:history` } ];
  const validRows = [new Set<IndexedRow>(), new Set<IndexedRow>()];
  const pages = await Promise.all(sources.map((source, i) => readIndexedPageFacts({ ...options, source,
    document: i === 0 ? FETCH_AUTHORITY_MEMBERSHIP_CARDS_PAGE : FETCH_USER_MEMBERSHIP_HISTORY_PAGE,
    collection: i === 0 ? 'subjectMemberships' : 'users', variables: { userAddress }, initialCursor: '',
    validateRow: row => {
      validateOrganizationIdentity(cardOrganization(row));
      if (String(row[i === 0 ? 'user' : 'address']).toLowerCase() !== userAddress) throw new Error('Card account mismatch');
      if (i === 0 && ((row.subject as any)?.kind !== 'Role' || projectAuthorityMembership(row).membershipProjection !== 'current-authority-inputs')) throw new Error('Authority membership inputs unavailable');
      if (i === 0) classifySubjectId((row.subject as any).subjectId);
      if (i === 0 && !Object.prototype.hasOwnProperty.call(row, 'userEntity')) throw new Error('Historical User selection unavailable');
      const history = i === 0 ? row.userEntity as IndexedRow | null : row;
      if (history != null) {
        if (String(history.address).toLowerCase() !== userAddress) throw new Error('Historical account mismatch');
        if (String(history.id).toLowerCase() !== `${cardOrganization(row).id.toLowerCase()}-${userAddress}`) throw new Error('Historical organization mismatch');
        for (const field of ['firstSeenAt', 'lastActiveAt', 'participationTokenBalance', 'totalTasksCompleted', 'totalVotes', 'totalModulesCompleted']) requireRawUint(history[field] as string);
      }
      validRows[i].add(row);
    } })));
  const reduction = reduceSourceResults(sources, pages.map(snapshot => ({ status: 'fulfilled' as const, snapshot })), { blockAlignment: options.source.snapshot === 'pinned' ? 'same-chain-block' : 'independent' });
  const rows = new Map<string, { org: IndexedRow; history: IndexedRow | null; historySource: SourceRef | null; memberships: IndexedRow[] }>();
  for (const row of pages[1].data) {
    if (!validRows[1].has(row)) continue;
    const org = cardOrganization(row);
    if (isAuthorityReady(org)) rows.set(org.id.toLowerCase(), { org, history: row, historySource: pages[1].source, memberships: [] });
  }
  for (const row of pages[0].data) {
    if (!validRows[0].has(row)) continue;
    const org = cardOrganization(row);
    if (!isAuthorityReady(org)) continue;
    const previous: { org: IndexedRow; history: IndexedRow | null; historySource: SourceRef | null; memberships: IndexedRow[] } = rows.get(org.id.toLowerCase())
      ?? { org, history: row.userEntity as IndexedRow | null, historySource: row.userEntity == null ? null : pages[0].source, memberships: [] };
    previous.memberships.push(row);
    rows.set(org.id.toLowerCase(), previous);
  }
  const completeMemberships = pages[0].coverage.status === 'complete';
  const data: MembershipCard[] = [...rows].map(([orgId, row]) => {
    const source = { ...pages[0].source, method: options.source.method, orgId, contract: String((row.org.membershipAuthority as any).id) };
    const active = row.memberships.some(membership => classifySubjectId((membership.subject as any).subjectId, (row.org.membershipAuthority as any).id).userFacing && projectAuthorityMembership(membership).isMember === true);
    const metric = (field: string): string | null => typeof row.history?.[field] === 'string' && /^\d+$/.test(row.history[field] as string) ? row.history[field] as string : null;
    return { orgId, account: userAddress, source, organization: row.org, currentMembership: completeMemberships ? knownFact(active, source) : unknownFact('MEMBERSHIP_CARDS_INCOMPLETE', source),
      historyIndexed: row.history != null, historySource: row.historySource ? { ...row.historySource, orgId, contract: source.contract } : null,
      firstSeenAt: metric('firstSeenAt'), lastActiveAt: metric('lastActiveAt'), participationTokenBalance: metric('participationTokenBalance'),
      totalTasksCompleted: metric('totalTasksCompleted'), totalVotes: metric('totalVotes'), totalModulesCompleted: metric('totalModulesCompleted'), memberships: row.memberships,
      tokenLabel: resolveTokenLabel({ useTokenSymbol: (row.org.metadata as any)?.useTokenSymbol, symbol: (row.org.participationToken as any)?.symbol }) };
  });
  return { source: { ...pages[0].source, method: options.source.method }, data, coverage: reduction.coverage };
}
