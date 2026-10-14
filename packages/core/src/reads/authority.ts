/** Current membership and permissions come exclusively from MembershipAuthority.
 * Historical Role/User/task/proposal entities retain their original IDs. */
import type { GraphClient } from '../graph/client';
import { requireRawUint } from '../amounts';

export interface AuthorityReadiness {
  membershipAuthority?: { id?: string; isRouterBound?: boolean; cutoverAt?: string | null } | null;
}

export function isAuthorityReady(org: AuthorityReadiness | null | undefined): boolean {
  const authority = org?.membershipAuthority;
  return !!authority?.id && /^0x[0-9a-f]{40}$/i.test(authority.id) && !/^0x0{40}$/i.test(authority.id)
    && authority.isRouterBound === true && authority.cutoverAt != null && /^\d+$/.test(String(authority.cutoverAt)) && BigInt(authority.cutoverAt) > 0n;
}

export { FETCH_ORG_AUTHORITY, FETCH_AUTHORITY_SUBJECTS, FETCH_AUTHORITY_MEMBERSHIPS, FETCH_AUTHORITY_PENDING, FETCH_AUTHORITY_PERMS, FETCH_AUTHORITY_VOUCHES } from '../graph/documents/authority';
import { FETCH_AUTHORITY_MEMBERSHIPS } from '../graph/documents/authority';

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

/** The index deliberately re-folds only ACCEPTED rows after subject-level configuration changes.
 * Recompute the eligibility projection from current inputs so unaccepted offers/renounced seats do
 * not retain a stale default or vouch quorum. `claimable` means eligible and unaccepted only: the
 * pause, capacity and pending-offer checks still apply when the user actually calls claim(). */
export function projectAuthorityMembership(row: any): any {
  const subject = row.subject;
  if (subject?.kind !== 'Role' || typeof subject.defaultAllow !== 'boolean'
    || typeof row.accepted !== 'boolean' || typeof row.emailVerified !== 'boolean'
    || !['None', 'Grant', 'Ban'].includes(row.ruleKind)
    || !Object.prototype.hasOwnProperty.call(subject, 'vouchConfig')) {
    // Partial caller-supplied rows cannot be re-folded. Preserve them as explicitly cached data;
    // the complete FETCH_AUTHORITY_MEMBERSHIPS document always supplies these non-null inputs.
    return { ...row, membershipProjection: 'indexed-cache' };
  }
  const config = subject.vouchConfig;
  let count: bigint, quorum: bigint;
  try {
    quorum = BigInt(requireRawUint(config?.quorum ?? '0', 32));
    const epoch = config ? requireRawUint(config.epoch, 64) : null;
    const wearerEpoch = config ? requireRawUint(row.vouchEpoch, 64) : null;
    count = config && epoch === wearerEpoch ? BigInt(requireRawUint(row.vouchCount, 32)) : 0n;
  } catch { return { ...row, membershipProjection: 'indexed-cache' }; }
  // The uint32 count is exactly representable. Preserve the existing CLI projection type.
  const effectiveVouchCount = Number(count);
  const vouchMet = quorum > 0n && count >= quorum;
  const eligibilitySource = row.ruleKind === 'Ban' ? 'ExplicitBan'
    : row.ruleKind === 'Grant' ? 'ExplicitGrant'
    : row.emailVerified ? 'EmailVerified'
    : vouchMet ? 'VouchQuorum'
    : subject.defaultAllow ? 'SubjectDefault' : 'None';
  const eligible = eligibilitySource !== 'ExplicitBan' && eligibilitySource !== 'None';
  return { ...row,
    indexedEligibility: { eligible: row.eligible, isMember: row.isMember, claimable: row.claimable,
      eligibilitySource: row.eligibilitySource, vouchMet: row.vouchMet },
    eligible, isMember: row.accepted && eligible, claimable: !row.accepted && eligible,
    eligibilitySource, vouchMet, effectiveVouchCount, membershipProjection: 'current-authority-inputs',
  };
}

export async function readAuthorityMemberships(client: GraphClient, orgId: string, chainId?: number): Promise<any[]> {
  return (await readAuthorityRows(client, orgId, FETCH_AUTHORITY_MEMBERSHIPS, 'subjectMemberships', chainId))
    .map(projectAuthorityMembership);
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
      totalModulesCompleted: null, firstSeenAt: null, lastActiveAt: null, joinMethod: null,
      historyIndexed: false, currentHatIds: [], subjects: [], membershipStatus: 'Inactive',
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
    readAuthorityMemberships(client, orgId, chainId),
  ]);
  // Keep richer caller-specific fields (profile tasks, churn counters, etc.), while full history
  // supplies canonical metrics even when the caller fetched only its first 20/100/1000 users.
  return projectAuthorityUsers([...users, ...history.users], memberships, history.systemAddresses)
    .map(user => ({ ...user, id: user.id ?? `${orgId.toLowerCase()}-${user.address.toLowerCase()}` }))
    .sort((a, b) => {
      // Member reports use the first rows as top holders; a cursor's ID order is not balance order.
      if (a.participationTokenBalance == null) return b.participationTokenBalance == null ? 0 : 1;
      if (b.participationTokenBalance == null) return -1;
      const left = BigInt(a.participationTokenBalance);
      const right = BigInt(b.participationTokenBalance);
      return left > right ? -1 : left < right ? 1 : 0;
    });
}

import { assertSourceBlock, assertSourceRef, Coverage, Fact, knownFact, requireCompleteSnapshot, SourceRef, SourceSnapshot, unknownFact } from '../data/facts';
import { collectCursorPages } from '../graph/pagination';
import { DocumentQueryResult, reduceSourceResults } from '../graph/sources';
import * as authorityDocs from '../graph/documents/authority';
import { AuthorityGroupEdge, AuthorityMemberFact, AuthorityPermissionData, AuthorityPermissionRow, AuthoritySubject, decodePermissionWord } from '../authority/permissions';
import { normalizeSubjectId, classifySubjectId } from '../authority/ids';
import type { ActivationMembership } from '../authority/activation';
import type { AuthorityMembershipInput, AuthorityPendingInput, AuthorityVouchConfig, AuthorityVouchRecord } from '../authority/lifecycle';

export interface AuthoritySnapshotSubject extends AuthoritySubject {
  defaultAllow: boolean; maxMembers: string; memberCount: string; activeMemberCount: string;
  vouchConfig: AuthorityVouchConfig | null;
  managerConfig: { managerSubjectId: string; caps: number; delaySecs: string; setAt: string; [key: string]: unknown } | null;
  createdAt: string;
  /** Original selected fields retained, including nullable metadata/name and migration flags. */
  raw: Readonly<Record<string, unknown>>;
}
export interface AuthoritySnapshotData extends AuthorityPermissionData {
  subjects: readonly AuthoritySnapshotSubject[];
  groupEdges: readonly (AuthorityGroupEdge & { groupName: Fact<string | null>; roleName: Fact<string | null>; raw: Readonly<Record<string, unknown>> })[];
  permissions: readonly (AuthorityPermissionRow & { subjectName: Fact<string | null>; raw: Readonly<Record<string, unknown>> })[];
  memberships: readonly AuthorityMembershipInput[];
  pendingActions: readonly (AuthorityPendingInput & { subjectId: string; subjectName: Fact<string | null>; actorName: Fact<string | null>; raw: Readonly<Record<string, unknown>> })[];
  vouches: readonly (AuthorityVouchRecord & { subjectName: Fact<string | null>; voucherName: Fact<string | null> })[];
  activeVouches: AuthoritySnapshotData['vouches'];
  rules: readonly Readonly<Record<string, unknown>>[];
  ready: Fact<boolean>;
  paused: Fact<boolean>;
  authority: Readonly<Record<string, unknown>> | null;
  /** Each independently paged collection keeps its own coverage and original raw rows. */
  collections: Readonly<Record<string, SourceSnapshot<readonly Readonly<Record<string, unknown>>[]>>>;
}
export interface AuthoritySnapshotQuery {
  <T>(source: SourceRef, document: string, variables: Record<string, unknown>): Promise<DocumentQueryResult<T>>;
}
const AUTHORITY_COLLECTIONS = [
  ['subjects', authorityDocs.FETCH_AUTHORITY_SUBJECTS_PAGE],
  ['subjectMemberships', authorityDocs.FETCH_AUTHORITY_MEMBERSHIPS_PAGE],
  ['groupCompositions', authorityDocs.FETCH_AUTHORITY_GROUP_EDGES_PAGE],
  ['permRows', authorityDocs.FETCH_AUTHORITY_PERMS_PAGE],
  ['accessRules', authorityDocs.FETCH_AUTHORITY_RULES_PAGE],
  ['subjectVouchRecords', authorityDocs.FETCH_AUTHORITY_VOUCHES_PAGE],
  ['pendingActions', authorityDocs.FETCH_AUTHORITY_PENDING_PAGE],
] as const;

/** New explicit API: injected endpoint query, pinned block, bounded cursor paging for EVERY
 * relation. Existing array-returning CLI reads keep their signatures/documents. */
export async function readAuthoritySnapshot(input: {
  source: SourceRef; query: AuthoritySnapshotQuery; pageSize?: number; maxPages?: number; maxRows?: number;
}): Promise<SourceSnapshot<AuthoritySnapshotData>> {
  assertSourceRef(input.source);
  if (!input.source.orgId || !input.source.contract || !input.source.indexed) throw new Error('Indexed organization/authority source required');
  if (input.pageSize !== undefined && (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 1000)) throw new Error('Authority page size must be between 1 and 1000');
  const pageSize = input.pageSize ?? 1000, maxPages = input.maxPages ?? 100;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1
    || (input.maxRows !== undefined && (!Number.isSafeInteger(input.maxRows) || input.maxRows < 1))
    || (input.maxRows === undefined && !Number.isSafeInteger(maxPages * pageSize))) throw new Error('Invalid authority pagination bounds');
  const requested = input.source;
  function unprovenSource(ref: SourceRef): SourceRef {
    if (ref.snapshot !== 'pinned') return ref;
    const { block: _requestedBlock, ...scope } = ref;
    return { ...scope, snapshot: 'unknown' };
  }
  // The document adapter returns request identity. Only same-response metadata
  // can turn a requested block into observed evidence, even on failure paths.
  let source = unprovenSource(requested);
  const orgId = requested.orgId!, contract = requested.contract!;
  const data: AuthoritySnapshotData = { subjects: [], groupEdges: [], permissions: [], memberships: [], pendingActions: [], vouches: [], activeVouches: [], rules: [],
    ready: unknownFact('AUTHORITY_UNAVAILABLE', source), paused: unknownFact('PAUSE_UNAVAILABLE', source), authority: null, collections: {} };
  const emptyCoverage = (code: string): Coverage => ({ status: 'unavailable', receivedKeys: [], missingIds: [], failedIds: ['authority'], issues: [{ code }] });
  // Latest multi-query reads cannot form an atomic decision snapshot.
  if (requested.snapshot !== 'pinned' || !requested.block) return { source, data, coverage: emptyCoverage('PINNED_AUTHORITY_SNAPSHOT_REQUIRED') };
  const number = Number(requireRawUint(requested.block.number, 31));
  // Graph Block_height chooses one selector. A hash-qualified request must
  // select by hash; GraphNode legitimately returns null hash for number pins.
  const block = requested.block.hash ? { hash: requested.block.hash } : { number };
  const variables = { orgId, block };
  function pageSource(result: DocumentQueryResult<any>, expected: SourceRef): SourceRef {
    const meta = result.data?._meta?.block;
    if (!meta || meta.number == null || meta.hash === undefined
      || (requested.block!.hash !== undefined && meta.hash === null)) throw new Error('INDEX_BLOCK_UNAVAILABLE');
    const observed: SourceRef = { ...result.source, block: {
      number: requireRawUint(meta.number),
      ...(meta.hash !== null ? { hash: meta.hash } : {}),
      ...(meta.timestamp != null ? { timestamp: requireRawUint(meta.timestamp) } : {}),
    } };
    requireCompleteSnapshot({ source: observed, data: result.data, coverage: { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] } },
      { scope: expected, indexed: true, snapshot: 'pinned', block: requested.block });
    return observed;
  }
  try {
    const state = await input.query<any>(requested, authorityDocs.FETCH_AUTHORITY_STATE, variables);
    const observed = pageSource(state, requested);
    requireCompleteSnapshot({ source: observed, data: state.data, coverage: { status: state.issues.length ? 'incomplete' : 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: state.issues } });
    source = observed;
    const org = state.data?.organization;
    if (!org || org.id?.toLowerCase() !== orgId.toLowerCase()) throw new Error('ORGANIZATION_UNAVAILABLE');
    const authority = org.membershipAuthority;
    if (!authority || authority.id?.toLowerCase() !== contract.toLowerCase()) throw new Error('AUTHORITY_SCOPE_MISMATCH');
    data.authority = authority;
    for (const field of ['subjectCount', 'roleSubjectCount', 'groupSubjectCount', 'acceptedMembershipCount']) requireRawUint(authority[field], 32);
    if (typeof authority.isRouterBound !== 'boolean' || authority.cutoverAt === undefined || (authority.cutoverAt !== null && requireRawUint(authority.cutoverAt, 64) !== String(authority.cutoverAt))) throw new Error('AUTHORITY_READINESS_UNAVAILABLE');
    data.ready = knownFact(isAuthorityReady(org), source);
    data.paused = typeof authority.paused === 'boolean' ? knownFact(authority.paused, source) : unknownFact('PAUSE_UNAVAILABLE', source);
    if (!isAuthorityReady(org)) return { source, data, coverage: emptyCoverage('AUTHORITY_NOT_READY') };
  } catch (error) {
    const candidate = (error as { code?: string }).code ?? (error instanceof Error ? error.message : '');
    return { source, data, coverage: emptyCoverage(/^[A-Z][A-Z_0-9]+$/.test(candidate) ? candidate : 'AUTHORITY_STATE_UNAVAILABLE') };
  }
  const collections: Record<string, SourceSnapshot<readonly any[]>> = {};
  for (const [field, document] of AUTHORITY_COLLECTIONS) {
    const collectionSource = { ...source, method: field };
    const requestSource = { ...requested, method: field };
    let proofReceived = false;
    collections[field] = await collectCursorPages<any>({
      source: collectionSource, pageSize, maxPages, maxRows: input.maxRows,
      cursor: { initial: '', fromRow: row => row.id, compare: (a, b) => a < b ? -1 : a > b ? 1 : 0 }, shortPageMeansComplete: true,
      fetchPage: async ({ cursor, first }) => {
        const result = await input.query<any>(requestSource, document, { ...variables, lastId: cursor, first });
        const observed = pageSource(result, requestSource);
        // Compare both directions: later optional hashes/timestamps cannot
        // attest earlier state/pages which did not observe those dimensions.
        assertSourceBlock(observed.block, source.block!);
        assertSourceBlock(source.block, observed.block!);
        proofReceived = true;
        return { rows: result.data?.[field], source: observed, issues: result.issues };
      },
    });
    if (!proofReceived) collections[field] = { ...collections[field], source: unprovenSource(requestSource) };
  }
  data.collections = collections;
  const reduced = reduceSourceResults(AUTHORITY_COLLECTIONS.map(([field]) => ({ ...source, method: field })), Object.values(collections).map(snapshot => ({ status: 'fulfilled' as const, snapshot })), { blockAlignment: 'same-chain-block' });
  const issues = [...reduced.coverage.issues];
  const missingIds: string[] = [...reduced.coverage.missingIds];
  function decodeRows<T>(field: string, decode: (row: any) => T): T[] {
    const out: T[] = [];
    for (const row of collections[field].data) try { out.push(decode(row)); }
    catch { issues.push({ code: 'INVALID_AUTHORITY_ROW', id: `${field}:${row?.id ?? 'unknown'}` }); missingIds.push(`${field}:${row?.id ?? 'unknown'}`); }
    return out;
  }
  data.subjects = decodeRows('subjects', row => {
    const subjectId = normalizeSubjectId(row.subjectId);
    if (row.id !== subjectId || !['Role', 'Group'].includes(row.kind) || (row.name !== null && typeof row.name !== 'string') || typeof row.defaultAllow !== 'boolean'
      || !Object.prototype.hasOwnProperty.call(row, 'vouchConfig') || !Object.prototype.hasOwnProperty.call(row, 'managerConfig')) throw new Error('SUBJECT_SHAPE');
    const vouch = row.vouchConfig;
    const manager = row.managerConfig;
    return { subjectId, name: row.name, kind: row.kind, defaultAllow: row.defaultAllow,
      maxMembers: requireRawUint(row.maxMembers, 32), memberCount: requireRawUint(row.memberCount), activeMemberCount: requireRawUint(row.activeMemberCount),
      createdAt: requireRawUint(row.createdAt, 64),
      vouchConfig: vouch === null ? null : { ...vouch, quorum: requireRawUint(vouch.quorum, 32), epoch: requireRawUint(vouch.epoch, 64), voucherSubjectId: normalizeSubjectId(vouch.voucherSubjectId) },
      managerConfig: manager === null ? null : { ...manager, managerSubjectId: normalizeSubjectId(manager.managerSubjectId), caps: Number(requireRawUint(manager.caps, 8)), delaySecs: requireRawUint(manager.delaySecs, 32), setAt: requireRawUint(manager.setAt, 64) }, raw: row };
  });
  const byId = new Map(data.subjects.map(s => [s.subjectId, s]));
  function subject(row: any): AuthoritySnapshotSubject {
    const id = normalizeSubjectId(row?.subjectId);
    const current = byId.get(id);
    if (!current) throw new Error('MISSING_REFERENCED_SUBJECT');
    return current;
  }
  data.groupEdges = decodeRows('groupCompositions', row => {
    const groupSubjectId = normalizeSubjectId(row.groupSubjectId), roleSubjectId = normalizeSubjectId(row.roleSubjectId);
    if (byId.get(groupSubjectId)?.kind !== 'Group' || byId.get(roleSubjectId)?.kind !== 'Role' || typeof row.isActive !== 'boolean') throw new Error('EDGE_SHAPE');
    return { ...row, groupSubjectId, roleSubjectId, groupName: knownFact(byId.get(groupSubjectId)!.name, source), roleName: knownFact(byId.get(roleSubjectId)!.name, source), raw: row };
  });
  data.permissions = decodeRows('permRows', row => {
    const current = subject(row.subject);
    if (!/^0x[\da-f]{64}$/i.test(row.permKey) || !/^0x[\da-f]{64}$/i.test(row.ctx)) throw new Error('PERM_SHAPE');
    const word = decodePermissionWord(row.word);
    if (word.exists !== row.exists || word.inheritGlobal !== row.inheritGlobal || word.value !== requireRawUint(row.value, 254)) throw new Error('PERM_DECODE_MISMATCH');
    return { ...row, subjectId: current.subjectId, subjectName: knownFact(current.name, source), word: word.raw, raw: row };
  });
  data.memberships = decodeRows('subjectMemberships', row => {
    const current = subject(row.subject);
    if (current.kind !== 'Role' || !/^0x[\da-f]{40}$/i.test(row.user) || typeof row.accepted !== 'boolean' || typeof row.emailVerified !== 'boolean'
      || typeof row.seededWhilePaused !== 'boolean' || !['None', 'Grant', 'Ban'].includes(row.ruleKind)
      || !Object.prototype.hasOwnProperty.call(row, 'rule') || !Object.prototype.hasOwnProperty.call(row, 'pendingAction')) throw new Error('MEMBERSHIP_SHAPE');
    if ((row.rule === null && row.ruleKind !== 'None') || (row.rule !== null && (row.rule?.kind !== row.ruleKind
      || !['Governance', 'Delegated'].includes(row.rule.author) || typeof row.rule.delegable !== 'boolean'))) throw new Error('RULE_JOIN_UNAVAILABLE');
    return { ...row, vouchCount: requireRawUint(row.vouchCount, 32), vouchEpoch: requireRawUint(row.vouchEpoch, 64),
      acceptedAt: row.acceptedAt === null ? null : requireRawUint(row.acceptedAt, 64),
      subject: { ...row.subject, ...current } };
  });
  data.pendingActions = decodeRows('pendingActions', row => {
    const current = subject(row.subject);
    if (!['Grant', 'Offer', 'Remove'].includes(row.action) || !['Pending', 'Finalized', 'Cancelled', 'Voided'].includes(row.status)
      || !/^0x[\da-f]{40}$/i.test(row.actor) || !/^0x[\da-f]{40}$/i.test(row.user) || !Object.prototype.hasOwnProperty.call(row, 'cancelledBy')) throw new Error('PENDING_SHAPE');
    return { ...row, pendingId: requireRawUint(row.pendingId), activatesAt: requireRawUint(row.activatesAt, 64), subjectId: current.subjectId, subjectName: knownFact(current.name, source), actorName: typeof row.actorUsername === 'string' || row.actorUsername === null ? knownFact<string | null>(row.actorUsername, source) : unknownFact<string | null>('ACTOR_NAME_UNAVAILABLE', source), raw: row };
  });
  data.vouches = decodeRows('subjectVouchRecords', row => {
    const current = subject(row.subject);
    if (typeof row.active !== 'boolean' || !/^0x[\da-f]{40}$/i.test(row.user) || !/^0x[\da-f]{40}$/i.test(row.voucher)) throw new Error('VOUCH_SHAPE');
    return { ...row, subjectId: current.subjectId, epoch: requireRawUint(row.epoch, 64), subjectName: knownFact(current.name, source),
      voucherName: typeof row.voucherUsername === 'string' || row.voucherUsername === null ? knownFact<string | null>(row.voucherUsername, source) : unknownFact<string | null>('VOUCHER_NAME_UNAVAILABLE', source) };
  });
  data.activeVouches = data.vouches.filter(row => row.active && byId.get(row.subjectId)?.vouchConfig?.epoch === row.epoch);
  data.rules = decodeRows('accessRules', row => {
    const current = subject(row.subject);
    if (!['None', 'Grant', 'Ban'].includes(row.kind) || !['Governance', 'Delegated'].includes(row.author) || typeof row.delegable !== 'boolean') throw new Error('RULE_SHAPE');
    return { ...row, subjectId: current.subjectId, subjectName: knownFact(current.name, source) };
  });
  const counts = { subjectCount: data.subjects.length, roleSubjectCount: data.subjects.filter(s => s.kind === 'Role').length,
    groupSubjectCount: data.subjects.filter(s => s.kind === 'Group').length, acceptedMembershipCount: data.memberships.filter(m => m.accepted).length };
  for (const [field, count] of Object.entries(counts)) if (requireRawUint(data.authority![field] as string, 32) !== String(count)) {
    issues.push({ code: 'AUTHORITY_COUNT_MISMATCH', id: field });
    missingIds.push(field);
  }
  return { source, data, coverage: { ...reduced.coverage, status: issues.length ? reduced.coverage.status === 'unavailable' ? 'unavailable' : 'incomplete' : 'complete', issues, missingIds } };
}
/** A view only: structural roots remain in snapshot/history but are omitted from member roles. */
export function authorityMemberRoleSubjects(snapshot: SourceSnapshot<AuthoritySnapshotData>): readonly AuthoritySnapshotSubject[] {
  return requireCompleteSnapshot(snapshot).subjects.filter(s => s.kind === 'Role' && classifySubjectId(s.subjectId).userFacing);
}

/** Scope already paged current role inputs to an account, retaining unknown lazy/missing rows.
 * This adapter is shared by permissions, education gates, and activation projections. */
export function authorityAccountMembershipFacts(snapshot: SourceSnapshot<AuthoritySnapshotData>, account: string): SourceSnapshot<readonly AuthorityMemberFact[]> {
  if (!/^0x[\da-f]{40}$/i.test(account) || /^0x0{40}$/i.test(account)) throw new Error('Nonzero account required');
  if (snapshot.source.account && snapshot.source.account.toLowerCase() !== account.toLowerCase()) throw new Error('ACCOUNT_SCOPE_MISMATCH');
  const accountSource = { ...snapshot.source, account };
  const memberships = snapshot.data.memberships.filter(m => m.user.toLowerCase() === account.toLowerCase());
  let complete = false;
  try { requireCompleteSnapshot(snapshot); complete = true; } catch { /* Preserve the original coverage and unknown membership facts. */ }
  const data = snapshot.data.subjects.filter(s => s.kind === 'Role').map(s => {
    const rows = memberships.filter(m => m.subject.subjectId === s.subjectId);
    const current = rows.length === 1 ? projectAuthorityMembership(rows[0]) : null;
    return { subjectId: s.subjectId, isMember: complete && current?.membershipProjection === 'current-authority-inputs'
      ? knownFact<boolean>(current.isMember, accountSource) : unknownFact<boolean>('MEMBERSHIP_INPUT_UNRESOLVED', accountSource) };
  });
  return { source: { ...snapshot.source, account }, data, coverage: snapshot.coverage };
}
export function authorityAccountActivationMemberships(snapshot: SourceSnapshot<AuthoritySnapshotData>, account: string): SourceSnapshot<readonly ActivationMembership[]> {
  const facts = authorityAccountMembershipFacts(snapshot, account);
  const data = facts.data.map(fact => {
    const row = snapshot.data.memberships.find(m => m.user.toLowerCase() === account.toLowerCase() && m.subject.subjectId === fact.subjectId);
    return { ...fact, acceptedAt: typeof row?.acceptedAt === 'string' ? knownFact(row.acceptedAt, facts.source) : unknownFact<string>('ACCEPTED_AT_UNAVAILABLE', facts.source),
      seededWhilePaused: typeof row?.seededWhilePaused === 'boolean' ? knownFact(row.seededWhilePaused, facts.source) : unknownFact<boolean>('SEED_PROVENANCE_UNAVAILABLE', facts.source) };
  });
  return { ...facts, data };
}
