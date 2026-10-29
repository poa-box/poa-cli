import { assertPlanScope, assertSourceBlock, Fact, knownFact, PlanScope, requireCompleteSnapshot, SourceSnapshot, unknownFact } from '../data/facts';
import { requireRawUint } from '../amounts';
import { normalizeSubjectId } from './ids';
import { AuthorityPermissionData } from './permissions';

export interface ActivationMembership {
  subjectId: string;
  isMember: Fact<boolean>;
  acceptedAt: Fact<string>;
  seededWhilePaused: Fact<boolean>;
}
export interface ElectorateActivation {
  activeSince: Fact<string | null>;
  canVote: Fact<boolean>;
  reason: Fact<'not-member' | 'joined-after-proposal' | null>;
  qualifyingRoleIds: readonly string[];
}
/** Input roster is scoped to ONE account and the relevant voting electorate. An empty
 * restriction list means that supplied electorate, not a substitute for live DD_VOTE/class gates.
 * Proposal facts may be trusted/unscoped; attached chain/org must agree. Their voting
 * contract, account and historical observation block need not match membership evidence. */
export function electorateActivationFacts(input: {
  memberships: SourceSnapshot<readonly ActivationMembership[]>;
  authority: SourceSnapshot<AuthorityPermissionData>;
  scope: PlanScope;
  restrictions: Fact<readonly string[]>;
  proposalCreatedAt: Fact<string>;
}): ElectorateActivation {
  const result: ElectorateActivation = { activeSince: unknownFact('ACTIVATION_UNAVAILABLE'), canVote: unknownFact('ACTIVATION_UNAVAILABLE'), reason: unknownFact('ACTIVATION_UNAVAILABLE'), qualifyingRoleIds: [] };
  try {
    if (!input.scope.account || !input.scope.contract || !input.scope.orgId) return result;
    const memberships = requireCompleteSnapshot(input.memberships, { scope: input.scope });
    const authority = requireCompleteSnapshot(input.authority, { scope: { ...input.scope, account: undefined }, ...(input.memberships.source.block ? { block: input.memberships.source.block } : {}) });
    if (input.restrictions.state === 'unknown' || input.proposalCreatedAt.state === 'unknown') return result;
    for (const fact of [input.restrictions, input.proposalCreatedAt]) if (fact.source) {
      assertPlanScope(fact.source, { chainId: input.scope.chainId, ...(fact.source.orgId !== undefined ? { orgId: input.scope.orgId } : {}) });
    }
    for (const m of memberships) for (const fact of [m.isMember, m.acceptedAt, m.seededWhilePaused]) if (fact.source) {
      assertPlanScope(fact.source, { chainId: input.scope.chainId, orgId: input.scope.orgId, contract: input.scope.contract, account: input.scope.account });
      if (input.memberships.source.block) assertSourceBlock(fact.source.block, input.memberships.source.block);
    }
    const createdAt = BigInt(requireRawUint(input.proposalCreatedAt.value, 64));
    const wanted = input.restrictions.value.map(normalizeSubjectId);
    const subjectMap = new Map(authority.subjects.map(s => [normalizeSubjectId(s.subjectId), s]));
    if (subjectMap.size !== authority.subjects.length || new Set(memberships.map(m => normalizeSubjectId(m.subjectId))).size !== memberships.length) return result;
    const roles = new Set<string>();
    if (!wanted.length) for (const m of memberships) roles.add(normalizeSubjectId(m.subjectId));
    else for (const id of wanted) {
      const subject = subjectMap.get(id);
      if (!subject) return result;
      if (subject.kind === 'Role') roles.add(id);
      else if (subject.kind === 'Group') {
        for (const edge of authority.groupEdges.filter(e => normalizeSubjectId(e.groupSubjectId) === id)) {
          if (typeof edge.isActive !== 'boolean' || subjectMap.get(normalizeSubjectId(edge.roleSubjectId))?.kind !== 'Role') return result;
          if (edge.isActive) roles.add(normalizeSubjectId(edge.roleSubjectId));
        }
      } else return result;
    }
    let earliest: bigint | null = null;
    const qualifying: string[] = [];
    for (const id of roles) {
      if (subjectMap.get(id)?.kind !== 'Role') return result;
      const m = memberships.find(m => normalizeSubjectId(m.subjectId) === id);
      if (!m || m.isMember.state !== 'known' || typeof m.isMember.value !== 'boolean') return result;
      if (!m.isMember.value) continue;
      if (m.seededWhilePaused.state !== 'known' || typeof m.seededWhilePaused.value !== 'boolean') return result;
      let at: bigint;
      if (m.seededWhilePaused.value) at = 1n;
      else if (m.acceptedAt.state === 'known') at = BigInt(requireRawUint(m.acceptedAt.value, 64));
      else return result;
      if (at === 0n || at === (1n << 64n) - 1n) return result;
      qualifying.push(id);
      if (earliest === null || at < earliest) earliest = at;
    }
    result.qualifyingRoleIds = qualifying;
    result.activeSince = knownFact(earliest?.toString() ?? null, input.memberships.source);
    const canVote = earliest !== null && (createdAt === 0n || earliest <= createdAt);
    result.canVote = knownFact(canVote, input.memberships.source);
    result.reason = knownFact(canVote ? null : earliest === null ? 'not-member' : 'joined-after-proposal', input.memberships.source);
  } catch { /* Scope, timestamps and missing fields never become joined-after certainty. */ }
  return result;
}
