/** Current membership and permissions come exclusively from MembershipAuthority.
 * Historical Role/User/task/proposal entities retain their original IDs. */
import type { GraphClient } from '../graph/client';

export interface AuthorityReadiness {
  membershipAuthority?: { id?: string; isRouterBound?: boolean; cutoverAt?: string | null } | null;
}

export function isAuthorityReady(org: AuthorityReadiness | null | undefined): boolean {
  const authority = org?.membershipAuthority;
  return !!authority?.id && /^0x[0-9a-f]{40}$/i.test(authority.id) && !/^0x0{40}$/i.test(authority.id)
    && authority.isRouterBound === true && authority.cutoverAt != null && /^\d+$/.test(String(authority.cutoverAt)) && BigInt(authority.cutoverAt) > 0n;
}

export const FETCH_ORG_AUTHORITY = `query OrgAuthority($id: Bytes!) {
  organization(id: $id) { id name membershipAuthority { id isRouterBound cutoverAt paused } }
}`;

export const FETCH_AUTHORITY_SUBJECTS = `query AuthoritySubjects($orgId: Bytes!, $lastId: String!) {
  subjects(first: 1000, orderBy: id, where: { organization: $orgId, id_gt: $lastId }) {
    id subjectId kind name metadataCID imageURI maxMembers memberCount activeMemberCount defaultAllow
    vouchConfig { quorum voucherSubjectId epoch }
    managerConfig { managerSubjectId caps delaySecs }
    memberRoles(where: { isActive: true }) { role { id subjectId name } }
  }
}`;

export const FETCH_AUTHORITY_MEMBERSHIPS = `query AuthorityMemberships($orgId: Bytes!, $lastId: String!) {
  subjectMemberships(first: 1000, orderBy: id, where: { organization: $orgId, id_gt: $lastId }) {
    id user userUsername accepted eligible isMember claimable acceptedAt seededWhilePaused
    ruleKind eligibilitySource vouchCount vouchEpoch vouchMet
    subject { id subjectId kind name }
    pendingAction { id pendingId action activatesAt status }
  }
}`;

export const FETCH_AUTHORITY_PERMS = `query AuthorityPerms($orgId: Bytes!, $lastId: String!) {
  permRows(first: 1000, orderBy: id, where: { organization: $orgId, id_gt: $lastId }) {
    id subject { id subjectId name kind } permKey ctx word value exists inheritGlobal
  }
}`;

export const FETCH_AUTHORITY_VOUCHES = `query AuthorityVouches($orgId: Bytes!, $lastId: String!) {
  subjectVouchRecords(first: 1000, orderBy: id, where: { organization: $orgId, id_gt: $lastId }) {
    id subject { id subjectId } user voucher voucherUsername active epoch seeded vouchedAt
    config { epoch quorum voucherSubjectId }
  }
}`;

/** Cursor pagination avoids presenting a capped first page as a complete permission/member list. */
export async function readAuthorityRows(
  client: GraphClient, orgId: string, document: string, field: string, chainId?: number,
): Promise<any[]> {
  const rows: any[] = [];
  let lastId = '';
  for (;;) {
    const result = await client.query<any>(document, { orgId, lastId }, chainId);
    const page = result[field];
    if (!Array.isArray(page)) throw new Error(`MembershipAuthority index unavailable: missing ${field}. Update the subgraph; legacy fallback is unsupported.`);
    rows.push(...page);
    if (page.length < 1000) return rows;
    const next = String(page[page.length - 1].id);
    if (next <= lastId) throw new Error('MembershipAuthority pagination did not advance');
    lastId = next;
  }
}

/** Historical users are paginated separately from memberships: either collection can exceed a page.
 * The retired eligibility address is identity metadata only, matching the subgraph's system-user
 * exclusions. It never supplies a current membership or permission decision. */
const AUTHORITY_USER_HISTORY = `query AuthorityUserHistory($orgId: Bytes!, $lastId: String!) {
  organization(id: $orgId) { executorContract { id } eligibilityModule { id } }
  users(first: 1000, orderBy: id, where: { organization: $orgId, id_gt: $lastId }) {
    id address participationTokenBalance totalTasksCompleted totalTasksCancelled totalVotes totalModulesCompleted
    totalClaimsAmount totalPaymentsAmount totalTokenRequestsAmount
    firstSeenAt firstSeenAtBlock lastActiveAt lastActiveAtBlock joinMethod account { username }
  }
}`;

async function readUserHistory(client: GraphClient, orgId: string, chainId?: number) {
  const users: any[] = [];
  let lastId = '';
  let systemAddresses: string[] = [];
  for (;;) {
    const result = await client.query<any>(AUTHORITY_USER_HISTORY, { orgId, lastId }, chainId);
    if (!result.organization || !Array.isArray(result.users)) throw new Error('Organization user history is unavailable');
    systemAddresses = [result.organization.executorContract?.id, result.organization.eligibilityModule?.id].filter(Boolean);
    users.push(...result.users);
    if (result.users.length < 1000) return { users, systemAddresses };
    const next = String(result.users[result.users.length - 1].id);
    if (next <= lastId) throw new Error('Organization user history pagination did not advance');
    lastId = next;
  }
}

/** Low-level projection over already complete history. Callers supplying authority memberships must
 * pass the org executor and retired eligibility addresses in systemAddresses. Prefer readAuthorityUsers
 * to resolve that identity context and all history pages automatically. The optional argument keeps
 * the existing pure-helper API compatible; it cannot infer system identities from a subject's name.
 * An absent User entity is unknown history, not evidence of a zero balance or a new join. */
export function projectAuthorityUsers(users: any[], memberships: any[], systemAddresses: readonly string[] = []): any[] {
  const excluded = new Set(systemAddresses.map(address => address.toLowerCase()));
  const rows = new Map<string, any>();
  for (const user of users) {
    const address = user.address.toLowerCase();
    if (excluded.has(address)) continue;
    const previous = rows.get(address);
    const account = previous?.account && user.account
      ? { ...previous.account, ...user.account }
      : user.account === undefined ? previous?.account : user.account;
    rows.set(address, { ...previous, ...user, account, historyIndexed: user.historyIndexed ?? true,
      currentHatIds: [] as string[], subjects: [] as any[], membershipStatus: 'Inactive' });
  }
  for (const membership of memberships) {
    if (membership.subject.kind !== 'Role') continue;
    const address = membership.user.toLowerCase();
    if (excluded.has(address)) continue;
    if (!rows.has(address)) rows.set(address, {
      address, account: membership.userUsername ? { username: membership.userUsername } : null,
      participationTokenBalance: null, totalTasksCompleted: null, totalVotes: null,
      firstSeenAt: null, historyIndexed: false, currentHatIds: [], subjects: [], membershipStatus: 'Inactive',
    });
    const row = rows.get(address)!;
    row.subjects.push(membership);
    if (membership.isMember) {
      if (!row.currentHatIds.includes(membership.subject.subjectId)) row.currentHatIds.push(membership.subject.subjectId);
      row.membershipStatus = 'Active';
    }
  }
  return [...rows.values()];
}

export async function readAuthorityUsers(client: GraphClient, orgId: string, users: any[], chainId?: number): Promise<any[]> {
  const [history, memberships] = await Promise.all([
    readUserHistory(client, orgId, chainId),
    readAuthorityRows(client, orgId, FETCH_AUTHORITY_MEMBERSHIPS, 'subjectMemberships', chainId),
  ]);
  // Keep richer caller-specific fields (profile tasks, churn counters, etc.), while full history
  // supplies canonical metrics even when the caller fetched only its first 20/100/1000 users.
  return projectAuthorityUsers([...users, ...history.users], memberships, history.systemAddresses)
    .sort((a, b) => {
      // Member reports use the first rows as top holders; a cursor's ID order is not balance order.
      if (a.participationTokenBalance == null) return b.participationTokenBalance == null ? 0 : 1;
      if (b.participationTokenBalance == null) return -1;
      const left = BigInt(a.participationTokenBalance);
      const right = BigInt(b.participationTokenBalance);
      return left > right ? -1 : left < right ? 1 : 0;
    });
}
