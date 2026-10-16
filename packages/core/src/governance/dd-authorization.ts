import { requireRawUint } from '../amounts';
import { ActivationMembership, electorateActivationFacts } from '../authority/activation';
import { normalizeSubjectId } from '../authority/ids';
import { AuthorityPermissionData, projectUserPermissions } from '../authority/permissions';
import { assertPlanScope, assertSourceBlock, Fact, knownFact, PlanScope, requireCompleteSnapshot, SourceSnapshot, unknownFact } from '../data/facts';
import { AUTHORITY_KEYS } from '../tx/authority';

export interface DirectDemocracyAuthorizationData {
  proposalId: string;
  /** proposalCreatedAt(id), NOT startTimestamp. Zero is the pre-authority sentinel. */
  createdAt: Fact<string>;
  /** Read from this DD module, including an observed zero address. */
  membershipAuthority: Fact<string>;
  /** This DD module's executor, not an inferred role or Hybrid executor. */
  executor: Fact<string>;
  restricted: Fact<boolean>;
  /** Opaque uint256 subject IDs from this proposal's pollHatIds. */
  restrictedSubjectIds: Fact<readonly string[]>;
}
export interface DirectDemocracyAuthorizationInput {
  proposal: SourceSnapshot<DirectDemocracyAuthorizationData>;
  scope: PlanScope;
  proposalId: string;
  authority?: SourceSnapshot<AuthorityPermissionData>;
  memberships?: SourceSnapshot<readonly ActivationMembership[]>;
}
const ZERO = `0x${'0'.repeat(40)}`;
function address(value: string): string {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{40}$/.test(value)) throw new Error('Invalid DD address');
  return value.toLowerCase();
}
/** DD vote() authorization/activation ONLY (inspected DirectDemocracyVoting.sol
 * 423..467). Nonzero authority precedes the Executor bypass, which skips only
 * DD_VOTE, never restricted-poll activation. All supplied observations must be
 * complete at the same block. This does not check existence, time, pause,
 * alreadyVoted, option/weight validity, or execution readiness. */
export function deriveDirectDemocracyAuthorization(input: DirectDemocracyAuthorizationInput): Fact<boolean> {
  const source = input.proposal.source;
  try {
    if (!input.scope.orgId || !input.scope.contract || !input.scope.account
      || address(input.scope.contract) === ZERO || address(input.scope.account) === ZERO
      || typeof input.proposalId !== 'string') throw new Error('DD_SCOPE_REQUIRED');
    const data = requireCompleteSnapshot(input.proposal, { scope: { ...input.scope, account: undefined }, snapshot: 'pinned' });
    if (typeof data.proposalId !== 'string' || requireRawUint(data.proposalId) !== requireRawUint(input.proposalId)) throw new Error('DD_PROPOSAL_MISMATCH');
    const moduleScope = { ...input.scope, account: undefined };
    for (const fact of [data.createdAt, data.membershipAuthority, data.executor, data.restricted, data.restrictedSubjectIds]) if (fact.source) {
      assertPlanScope(fact.source, moduleScope);
      assertSourceBlock(fact.source.block, source.block!);
    }
    if (data.membershipAuthority.state !== 'known') return unknownFact('DD_AUTHORITY_UNAVAILABLE', source);
    const authorityAddress = address(data.membershipAuthority.value);
    if (authorityAddress === ZERO) return knownFact(false, source);
    if (input.scope.contracts?.membershipAuthority && address(input.scope.contracts.membershipAuthority) !== authorityAddress) throw new Error('DD_AUTHORITY_MISMATCH');
    if (data.createdAt.state !== 'known' || data.executor.state !== 'known' || data.restricted.state !== 'known'
      || typeof data.restricted.value !== 'boolean') throw new Error('DD_POLICY_UNAVAILABLE');
    requireRawUint(data.createdAt.value, 64);
    const isExecutor = address(data.executor.value) === address(input.scope.account);
    const authorityScope: PlanScope = { chainId: input.scope.chainId, orgId: input.scope.orgId,
      account: input.scope.account, contract: authorityAddress, contracts: input.scope.contracts };
    // Validate even bypassed supplied facts: foreign/stale observations cannot
    // acquire a positive result merely by travelling alongside an Executor.
    for (const observation of [input.authority, input.memberships]) if (observation) {
      requireCompleteSnapshot<unknown>(observation, { scope: { ...authorityScope, ...(observation === input.authority ? { account: undefined } : {}) },
        snapshot: 'pinned', block: source.block! });
    }
    const activation = (ids: readonly string[]): Fact<boolean> => {
      if (!input.authority || !input.memberships) return unknownFact('DD_ACTIVATION_UNAVAILABLE', source);
      return electorateActivationFacts({ authority: input.authority, memberships: input.memberships, scope: authorityScope,
        restrictions: knownFact(ids), proposalCreatedAt: data.createdAt }).canVote;
    };
    if (!isExecutor) {
      if (!input.authority || !input.memberships) return unknownFact('DD_PERMISSION_UNAVAILABLE', source);
      const permission = projectUserPermissions({ snapshot: input.authority, memberships: input.memberships,
        scope: authorityScope, permKey: AUTHORITY_KEYS.DD_VOTE, ctx: `0x${'0'.repeat(64)}` });
      if (permission.enabled.state !== 'known' || !permission.enabled.value) return permission.enabled;
      // activeMemberSince(account, DD_VOTE, ctx0) takes the earliest active
      // role across holders with nonzero resolved permission, including groups.
      const holders = permission.contributions.filter(c => c.context.state === 'known' && c.context.value.value !== '0').map(c => c.subjectId);
      if (!holders.length) throw new Error('DD_PERMISSION_HOLDERS_UNAVAILABLE');
      const general = activation(holders);
      if (general.state !== 'known' || !general.value) return general;
    }
    if (!data.restricted.value) return knownFact(true, source);
    if (data.restrictedSubjectIds.state !== 'known' || !Array.isArray(data.restrictedSubjectIds.value)) throw new Error('DD_RESTRICTIONS_UNAVAILABLE');
    const ids = data.restrictedSubjectIds.value.map(normalizeSubjectId);
    // A restricted empty list never becomes an unrestricted electorate.
    if (!ids.length) return knownFact(false, source);
    return activation(ids);
  } catch { return unknownFact('DD_AUTHORIZATION_UNAVAILABLE', source); }
}
