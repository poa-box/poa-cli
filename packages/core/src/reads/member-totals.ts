import { requireRawUint } from '../amounts';
import { classifySubjectId, normalizeSubjectId } from '../authority/ids';
import { knownFact, requireCompleteSnapshot, unknownFact, type Fact, type SourceSnapshot } from '../data/facts';
import { checkedIndexedTotalQuery, indexedTotalCoverage, indexedTotalIssue, readIndexedTotalState, requireIndexedTotalOptions, type IndexedTotalOptions } from '../data/indexed-completeness';
import { FETCH_CURRENT_MEMBER_TOTAL_PAGE, FETCH_CURRENT_MEMBER_TOTAL_STATE } from '../graph/documents/indexed-completeness';
import { isAuthorityReady, projectAuthorityMembership } from './authority';
import { readIndexedPageFacts, type IndexedRow } from './protocol';

export interface CurrentMemberTotals {
  /** Distinct account addresses, never a claim about distinct human persons. */
  members: readonly { account: string; subjectIds: readonly string[] }[];
  observedCount: string;
  total: Fact<string>;
  semantics: 'distinct-current-member-accounts';
  evidence: { state: SourceSnapshot<IndexedRow | null>; memberships: SourceSnapshot<readonly IndexedRow[]> };
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[\da-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) throw new Error('MEMBER_ADDRESS_UNAVAILABLE');
  return value.toLowerCase();
}

/** Complete indexed current membership at one block. Accepted-flip events
 * enumerate the finite candidate universe; eligibility is recomputed from
 * current fold inputs (including vouch epoch reset and explicit bans).
 * Historical User activity, group rows and structural roots do not add members.
 * This is indexed display evidence, never live authorization. */
export async function readCurrentMemberTotals(input: IndexedTotalOptions): Promise<SourceSnapshot<CurrentMemberTotals>> {
  requireIndexedTotalOptions(input);
  if (!input.source.orgId || !/^0x[\da-f]{64}$/i.test(input.source.orgId)) throw new Error('MEMBER_ORGANIZATION_SCOPE_REQUIRED');
  const options = { ...input, query: checkedIndexedTotalQuery(input.query) };
  const orgId = input.source.orgId.toLowerCase(), authority = input.source.contract!.toLowerCase();
  const state = await readIndexedTotalState(options, FETCH_CURRENT_MEMBER_TOTAL_STATE, { orgId }, 'organization', orgId);
  const valid = new Set<IndexedRow>();
  const memberships = await readIndexedPageFacts({ ...options, document: FETCH_CURRENT_MEMBER_TOTAL_PAGE, collection: 'subjectMemberships', variables: { orgId, authority }, initialCursor: '',
    validateRow: row => {
      const subject = row.subject as IndexedRow;
      const owned = (value: IndexedRow) => {
        if ((value.organization as IndexedRow)?.id?.toString().toLowerCase() !== orgId
          || (value.authority as IndexedRow)?.id?.toString().toLowerCase() !== authority) throw new Error('MEMBERSHIP_SCOPE_MISMATCH');
      };
      owned(row); owned(subject);
      const subjectId = normalizeSubjectId(subject.subjectId as string), account = id(row.user);
      const classification = classifySubjectId(subjectId, authority);
      if (classification.namespace === 'foreign' || classification.namespace === 'unallocated'
        || subject.id !== subjectId || row.id !== `${subjectId}-${account}`
        || projectAuthorityMembership(row).membershipProjection !== 'current-authority-inputs') throw new Error('MEMBERSHIP_INPUTS_UNAVAILABLE');
      valid.add(row);
    } });
  const issues: { code: string; id?: string }[] = [];
  let excluded = new Set<string>();
  try {
    const org = requireCompleteSnapshot(state, { scope: input.source, indexed: true, snapshot: 'pinned', block: input.source.block });
    if (!org || org.id !== orgId || !isAuthorityReady(org)) throw new Error('MEMBER_AUTHORITY_NOT_READY');
    const current = org.membershipAuthority as IndexedRow;
    if (id(current.id) !== authority) throw new Error('MEMBER_AUTHORITY_SCOPE_MISMATCH');
    for (const key of ['executorContract', 'eligibilityModule']) {
      if (!Object.prototype.hasOwnProperty.call(org, key) || (org[key] !== null && typeof org[key] !== 'object')) throw new Error('SYSTEM_IDENTITY_UNAVAILABLE');
    }
    excluded = new Set(['executorContract', 'eligibilityModule'].flatMap(key => org[key] === null ? [] : [id((org[key] as IndexedRow).id)]));
    const accepted = memberships.data.filter(row => row.accepted === true).length;
    if (requireRawUint(current.acceptedMembershipCount as string | number, 32) !== String(accepted)) throw new Error('ACCEPTED_MEMBERSHIP_COUNT_MISMATCH');
  } catch (error) { issues.push(indexedTotalIssue(error)); }
  const accounts = new Map<string, Set<string>>();
  for (const row of memberships.data) if (valid.has(row)) {
    const current = projectAuthorityMembership(row), account = id(row.user);
    const subjectId = (row.subject as IndexedRow).subjectId as string;
    if (!current.isMember || excluded.has(account) || !classifySubjectId(subjectId, authority).userFacing) continue;
    if (!accounts.has(account)) accounts.set(account, new Set());
    accounts.get(account)!.add(subjectId);
  }
  const members = [...accounts].map(([account, subjects]) => ({ account, subjectIds: [...subjects].sort() })).sort((a, b) => a.account.localeCompare(b.account));
  const coverage = indexedTotalCoverage({ state, memberships }, issues);
  const source = memberships.source.snapshot === 'pinned' ? memberships.source : state.source;
  const observedCount = String(members.length);
  return { source, coverage, data: { members, observedCount,
    total: coverage.status === 'complete' ? knownFact(observedCount, source) : unknownFact('CURRENT_MEMBER_TOTAL_INCOMPLETE', source),
    semantics: 'distinct-current-member-accounts', evidence: { state, memberships } } };
}
