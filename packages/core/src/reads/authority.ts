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

/** Preserve historical user metrics while replacing current membership with authority state. */
export function projectAuthorityUsers(users: any[], memberships: any[]): any[] {
  const rows = new Map(users.map(u => [u.address.toLowerCase(), { ...u, currentHatIds: [] as string[], membershipStatus: 'Inactive' }]));
  for (const membership of memberships) {
    if (membership.subject.kind !== 'Role') continue;
    const address = membership.user.toLowerCase();
    if (!rows.has(address)) rows.set(address, {
      address, account: membership.userUsername ? { username: membership.userUsername } : null,
      participationTokenBalance: '0', totalTasksCompleted: '0', totalVotes: '0',
      firstSeenAt: membership.acceptedAt, currentHatIds: [], membershipStatus: 'Inactive',
    });
    if (membership.isMember) {
      const row = rows.get(address)!;
      if (!row.currentHatIds.includes(membership.subject.subjectId)) row.currentHatIds.push(membership.subject.subjectId);
      row.membershipStatus = 'Active';
    }
  }
  return [...rows.values()];
}

export async function readAuthorityUsers(client: GraphClient, orgId: string, users: any[], chainId?: number): Promise<any[]> {
  return projectAuthorityUsers(users, await readAuthorityRows(client, orgId, FETCH_AUTHORITY_MEMBERSHIPS, 'subjectMemberships', chainId));
}
