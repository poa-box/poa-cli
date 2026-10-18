import { normalizeSubjectId } from '../authority/ids';
import { AuthorityMemberFact, AuthorityPermissionData, projectSubjectMembership } from '../authority/permissions';
import { assertPlanScope, assertSourceBlock, assertSourceRef, Fact, knownFact, PlanScope, requireCompleteSnapshot, SourceBlock, SourceRef, SourceSnapshot, unknownFact } from '../data/facts';

export interface ProjectCreatorData {
  /** TaskManager.creatorHatIds: CURRENT authority subjects, never Hats wearer IDs. */
  creatorSubjectIds: Fact<readonly string[]>;
  /** Binding observed on this TaskManager, not inferred from the org's pointer. */
  membershipAuthority: Fact<string>;
  /** Executor observed on this TaskManager. */
  executor: Fact<string>;
}
export interface ProjectCreatorInput {
  taskManager: SourceSnapshot<ProjectCreatorData>;
  authority: SourceSnapshot<AuthorityPermissionData>;
  memberships: SourceSnapshot<readonly AuthorityMemberFact[]>;
  /** Explicit TaskManager/org/account; optional expected endpoint and authority binding. */
  scope: PlanScope;
  /** Opt-in composition: explicit host-selected endpoints/kinds and canonical block.
   * Each observation retains its own provenance. Omit to keep the same-source gate. */
  sources?: ProjectCreatorSources;
}
export interface ProjectCreatorSources {
  taskManager: Pick<SourceRef, 'endpoint' | 'method' | 'indexed'>;
  authority: Pick<SourceRef, 'endpoint' | 'method' | 'indexed'>;
  memberships: Pick<SourceRef, 'endpoint' | 'method' | 'indexed'>;
  block: SourceBlock & { hash: string };
}
export interface ProjectCreatorFacts {
  /** Current selected membership. Mixed-source callers use TaskPolicyInput.projectCreator. */
  creator: Fact<boolean>;
  executor: Fact<boolean>;
  /** _requireCreator for createProject/deleteProject; no existence or other action guards. */
  authorized: Fact<boolean>;
}
const ZERO = `0x${'0'.repeat(40)}`;
function address(value: string): string {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{40}$/.test(value)) throw new Error('Invalid creator address');
  return value.toLowerCase();
}
function factSource(fact: Fact<unknown>, expected: PlanScope, observation: SourceRef, canonicalBlock?: SourceBlock): void {
  if (!fact || !['known', 'unknown'].includes(fact.state)) throw new Error('Invalid creator fact');
  if (fact.source) {
    assertSourceRef(fact.source);
    assertPlanScope(fact.source, expected);
    if (fact.source.snapshot !== 'pinned' || fact.source.indexed !== observation.indexed) throw new Error('Mixed creator sources');
    assertSourceBlock(fact.source.block, canonicalBlock ?? observation.block!);
    if (!canonicalBlock) assertSourceBlock(observation.block, fact.source.block!);
    if (fact.source.block?.timestamp !== undefined && observation.block?.timestamp !== undefined
      && BigInt(fact.source.block.timestamp) !== BigInt(observation.block.timestamp)) throw new Error('Creator block time mismatch');
  }
}
/** Inspected V2 TaskManager _requireCreator: Executor OR current membership in
 * any configured authority subject. Empty selectors deny membership; project
 * manager and CREATE permission are irrelevant. Complete pinned observations
 * must share endpoint/kind/block unless sources explicitly selects each origin
 * and a common canonical number+hash; always binds a nonzero authority/account.
 * Unscoped field Facts are trusted caller inputs, as in other core projectors.
 * This pure function neither observes contracts nor establishes RPC freshness. */
export function deriveProjectCreatorAuthorization(input: ProjectCreatorInput): ProjectCreatorFacts {
  const source = { ...input.taskManager.source, account: input.scope.account };
  const unknown = (code: string): ProjectCreatorFacts => ({ creator: unknownFact(code, source),
    executor: unknownFact(code, source), authorized: unknownFact(code, source) });
  try {
    const { scope, sources } = input;
    if (sources) {
      if (!sources.block || !/^0x[\da-fA-F]{64}$/.test(sources.block.hash)) throw new Error('Canonical creator block required');
      for (const expected of [sources.taskManager, sources.authority, sources.memberships]) {
        if (!expected || typeof expected.indexed !== 'boolean'
          || typeof expected.endpoint !== 'string' || !expected.endpoint.trim()
          || typeof expected.method !== 'string' || !expected.method.trim()) throw new Error('Explicit creator sources required');
      }
    }
    if (!scope.orgId || !/^0x[\da-fA-F]{64}$/.test(scope.orgId) || !scope.contract || !scope.account
      || address(scope.contract) === ZERO || address(scope.account) === ZERO) throw new Error('Creator scope required');
    const moduleScope: PlanScope = { chainId: scope.chainId, orgId: scope.orgId, contract: scope.contract,
      endpoint: sources ? sources.taskManager.endpoint : scope.endpoint, method: sources ? sources.taskManager.method : scope.method };
    const block = sources ? sources.block : source.block!;
    const data = requireCompleteSnapshot(input.taskManager, { scope: moduleScope, snapshot: 'pinned',
      ...(sources ? { indexed: sources.taskManager.indexed, block } : {}) });
    if (input.taskManager.source.account && address(input.taskManager.source.account) !== address(scope.account)) throw new Error('Creator account mismatch');
    const boundModuleScope = { ...moduleScope, endpoint: source.endpoint };
    for (const fact of [data.creatorSubjectIds, data.membershipAuthority, data.executor]) {
      factSource(fact, { ...boundModuleScope, ...(fact?.source?.account ? { account: scope.account } : {}) }, source, sources ? block : undefined);
    }
    if (data.membershipAuthority.state !== 'known' || address(data.membershipAuthority.value) === ZERO) throw new Error('Creator authority unavailable');
    const authorityAddress = address(data.membershipAuthority.value);
    if (scope.contracts?.membershipAuthority && address(scope.contracts.membershipAuthority) !== authorityAddress) throw new Error('Creator authority mismatch');
    for (const fact of [data.creatorSubjectIds, data.membershipAuthority, data.executor]) {
      if (fact.source?.contracts?.membershipAuthority && address(fact.source.contracts.membershipAuthority) !== authorityAddress) throw new Error('Creator field binding mismatch');
    }
    const authorityScope: PlanScope = { chainId: scope.chainId, orgId: scope.orgId, contract: authorityAddress,
      endpoint: sources ? sources.authority.endpoint : source.endpoint, ...(sources ? { method: sources.authority.method } : {}) };
    const authority = requireCompleteSnapshot(input.authority, { scope: authorityScope, snapshot: 'pinned', indexed: sources ? sources.authority.indexed : source.indexed, block });
    const accountScope = { ...authorityScope, account: scope.account,
      ...(sources ? { endpoint: sources.memberships.endpoint, method: sources.memberships.method } : {}) };
    const memberships = requireCompleteSnapshot(input.memberships, { scope: accountScope, snapshot: 'pinned', indexed: sources ? sources.memberships.indexed : source.indexed, block });
    const timestamps = [input.taskManager, input.authority, input.memberships]
      .flatMap(observation => observation.source.block?.timestamp === undefined ? [] : [BigInt(observation.source.block.timestamp).toString()]);
    if (new Set(timestamps).size > 1) throw new Error('Creator block time mismatch');
    for (const observation of [input.taskManager, input.authority, input.memberships]) {
      assertSourceBlock(observation.source.block, block);
      if (!sources) assertSourceBlock(source.block, observation.source.block!);
      if (observation.source.account && address(observation.source.account) !== address(scope.account)) throw new Error('Creator account mismatch');
      if (observation.source.contracts?.membershipAuthority && address(observation.source.contracts.membershipAuthority) !== authorityAddress) throw new Error('Creator binding mismatch');
    }
    const memberIds = new Set<string>();
    for (const member of memberships) {
      if (typeof member.subjectId !== 'string') throw new Error('Invalid member ID');
      const id = normalizeSubjectId(member.subjectId);
      if (memberIds.has(id)) throw new Error('Duplicate membership');
      memberIds.add(id);
      factSource(member.isMember, accountScope, input.memberships.source, sources ? block : undefined);
      if (member.isMember.source?.contracts?.membershipAuthority && address(member.isMember.source.contracts.membershipAuthority) !== authorityAddress) throw new Error('Member binding mismatch');
      if (member.isMember.state === 'known' && typeof member.isMember.value !== 'boolean') throw new Error('Invalid membership');
    }
    // Reuse the membership projector's structural authority validation even
    // for empty selectors or an Executor; this probe grants no membership.
    const validation = projectSubjectMembership(authority, '0', memberships);
    if (validation.state === 'unknown' && validation.code === 'INVALID_MEMBERSHIP_INPUT') throw new Error('Invalid authority data');
    const executor = data.executor.state === 'known'
      ? knownFact(address(data.executor.value) === address(scope.account), source) : unknownFact<boolean>('CREATOR_EXECUTOR_UNAVAILABLE', source);
    let creator: Fact<boolean> = unknownFact('CREATOR_SELECTORS_UNAVAILABLE', source);
    if (data.creatorSubjectIds.state === 'known') {
      if (!Array.isArray(data.creatorSubjectIds.value)) throw new Error('Invalid creator selectors');
      const ids: string[] = [];
      for (const id of data.creatorSubjectIds.value) {
        if (typeof id !== 'string') throw new Error('Invalid creator selector');
        ids.push(normalizeSubjectId(id));
      }
      const facts = ids.map(id => projectSubjectMembership(authority, id, memberships));
      creator = facts.some(f => f.state === 'known' && f.value) ? knownFact(true, source)
        : facts.some(f => f.state === 'unknown') ? unknownFact('CREATOR_MEMBERSHIP_UNRESOLVED', source) : knownFact(false, source);
    }
    const authorized = [executor, creator].some(f => f.state === 'known' && f.value) ? knownFact(true, source)
      : [executor, creator].some(f => f.state === 'unknown') ? unknownFact<boolean>('CREATOR_AUTHORIZATION_UNRESOLVED', source) : knownFact(false, source);
    return { creator, executor, authorized };
  } catch { return unknown('PROJECT_CREATOR_EVIDENCE_UNAVAILABLE'); }
}
