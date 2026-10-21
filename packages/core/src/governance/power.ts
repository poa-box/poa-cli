import { ethers } from 'ethers';
import { requireRawUint } from '../amounts';
import { assertPlanScope, assertSourceBlock, assertSourceRef, Fact, knownFact, PlanScope, requireCompleteSnapshot, SourceRef, SourceSnapshot, unknownFact } from '../data/facts';
import { electorateActivationFacts, ActivationMembership } from '../authority/activation';
import { AuthorityPermissionData } from '../authority/permissions';
import { normalizeSubjectId } from '../authority/ids';

export interface PowerClass {
  strategy: 'DIRECT' | 'ERC20_BAL'; slicePct: number; quadratic: boolean; minBalance: string; asset: string;
  hatIds: readonly string[];
  /** IMMUTABLE proposal binding, never the current live classSubject. Zero selects hatIds. */
  subjectId: Fact<string>;
}
export interface ProposalPowerSnapshot {
  createdAt: Fact<string>; restrictedSubjectIds: Fact<readonly string[]>; classes: readonly PowerClass[];
}
export interface ProposalPowerClassInput {
  /** Accept normalized contract enum numbers/strings and indexed enum names. */
  strategy: number | string; slicePct: number; quadratic: boolean; minBalance: string; asset: string; hatIds: readonly string[];
}
/** Concrete normalization boundary for frozen getProposalClasses/indexed rows plus
 * per-proposal immutable bindings. Unknown bindings never become zero/open. */
export function projectProposalPowerSnapshot(input: {
  snapshot: SourceSnapshot<{ classes: Fact<readonly ProposalPowerClassInput[]>; proposalClassSubjects: Fact<readonly string[]>;
    createdAt: Fact<string>; restrictedSubjectIds: Fact<readonly string[]> }>;
  scope: PlanScope;
}): Fact<SourceSnapshot<ProposalPowerSnapshot>> {
  try {
    if (!input.scope.orgId || !input.scope.contract) throw new Error('PROPOSAL_POWER_SCOPE_REQUIRED');
    const data = requireCompleteSnapshot(input.snapshot, { scope: input.scope });
    for (const fact of [data.classes, data.proposalClassSubjects, data.createdAt, data.restrictedSubjectIds]) if (fact.source) {
      assertPlanScope(fact.source, input.scope);
      if (input.snapshot.source.block) assertSourceBlock(fact.source.block, input.snapshot.source.block);
    }
    if (data.classes.state !== 'known') return unknownFact(data.classes.code, input.snapshot.source);
    const rows = data.classes.value;
    if (!rows.length || rows.length > 8 || rows.reduce((sum, row) => sum + row.slicePct, 0) !== 100) throw new Error('INVALID_CLASS_SNAPSHOT');
    if (data.proposalClassSubjects.state === 'known' && data.proposalClassSubjects.value.length !== rows.length) throw new Error('INCOMPLETE_IMMUTABLE_BINDINGS');
    const bindings = data.proposalClassSubjects;
    const classes: PowerClass[] = rows.map((row, i) => {
      const strategy = row.strategy === 0 || row.strategy === '0' || row.strategy === 'DIRECT' ? 'DIRECT'
        : row.strategy === 1 || row.strategy === '1' || row.strategy === 'ERC20_BAL' ? 'ERC20_BAL' : undefined;
      if (!strategy || !Number.isInteger(row.slicePct) || row.slicePct < 1 || row.slicePct > 100 || typeof row.quadratic !== 'boolean'
        || !ethers.utils.isAddress(row.asset) || (strategy === 'ERC20_BAL' && row.asset.toLowerCase() === ethers.constants.AddressZero)
        || !Array.isArray(row.hatIds)) throw new Error('INVALID_CLASS_SNAPSHOT');
      return { strategy, slicePct: row.slicePct, quadratic: row.quadratic, minBalance: requireRawUint(row.minBalance), asset: row.asset,
        hatIds: row.hatIds.map(normalizeSubjectId), subjectId: bindings.state === 'known' ? knownFact(normalizeSubjectId(bindings.value[i]), bindings.source)
          : unknownFact(bindings.code, bindings.source) };
    });
    return knownFact({ ...input.snapshot, data: { classes, createdAt: data.createdAt, restrictedSubjectIds: data.restrictedSubjectIds } }, input.snapshot.source);
  } catch { return unknownFact('PROPOSAL_POWER_SNAPSHOT_UNAVAILABLE', input.snapshot.source); }
}
export interface ClassEligibilityInput {
  proposal: SourceSnapshot<ProposalPowerSnapshot>; scope: PlanScope; classIndex: number;
  viewerIsExecutor: Fact<boolean>;
  authority?: SourceSnapshot<AuthorityPermissionData>;
  memberships?: SourceSnapshot<readonly ActivationMembership[]>;
}
/** Poll restriction precedes executor bypass; activation helper handles earliest active group role. */
export function deriveClassEligibility(input: ClassEligibilityInput): Fact<boolean> {
  try {
    if (!input.scope.account || !input.scope.orgId || !input.scope.contract) throw new Error('POWER_SCOPE_REQUIRED');
    const p = requireCompleteSnapshot(input.proposal, { scope: { ...input.scope, account: undefined } });
    // Voting observations can be historical; authority/member observations are
    // current. Bind the latter to the expected authority, never to a foreign
    // observed contract merely because it carried the expected metadata map.
    const authorityContract = input.scope.contracts?.membershipAuthority ?? input.proposal.source.contracts?.membershipAuthority ?? input.authority?.source.contract;
    const bindings = { ...input.proposal.source.contracts, ...input.scope.contracts };
    const checkBindings = (source: typeof input.proposal.source): void => {
      assertSourceRef(source);
      for (const [key, contract] of Object.entries(bindings)) if (source.contracts?.[key] !== undefined) {
        assertPlanScope(source, { chainId: input.scope.chainId, contracts: { [key]: contract } });
      }
    };
    for (const observation of [input.authority, input.memberships]) if (observation) {
      checkBindings(observation.source);
      requireCompleteSnapshot<unknown>(observation, { scope: { chainId: input.scope.chainId, orgId: input.scope.orgId,
        contract: authorityContract, ...(observation === input.memberships ? { account: input.scope.account } : {}) } });
    }
    for (const member of input.memberships?.data ?? []) for (const fact of [member.isMember, member.acceptedAt, member.seededWhilePaused]) if (fact.source) {
      checkBindings(fact.source);
      assertPlanScope(fact.source, { chainId: input.scope.chainId, orgId: input.scope.orgId, contract: authorityContract, account: input.scope.account });
      if (input.memberships?.source.block) assertSourceBlock(fact.source.block, input.memberships.source.block);
    }
    if (!Number.isSafeInteger(input.classIndex) || input.classIndex < 0 || !p.classes[input.classIndex]) throw new Error('CLASS_SNAPSHOT_UNAVAILABLE');
    if (p.createdAt.state !== 'known' || p.restrictedSubjectIds.state !== 'known') throw new Error('PROPOSAL_SNAPSHOT_UNAVAILABLE');
    for (const fact of [p.createdAt, p.restrictedSubjectIds, p.classes[input.classIndex].subjectId]) if (fact.source) {
      checkBindings(fact.source);
      assertPlanScope(fact.source, { chainId: input.scope.chainId, orgId: input.scope.orgId, contract: input.scope.contract });
      if (input.proposal.source.block) assertSourceBlock(fact.source.block, input.proposal.source.block);
    }
    requireRawUint(p.createdAt.value, 64);
    const activation = (ids: readonly string[]): Fact<boolean> => {
      if (!ids.length) return knownFact(true, input.proposal.source);
      if (!input.authority || !input.memberships) return unknownFact('ACTIVATION_UNAVAILABLE');
      return electorateActivationFacts({ authority: input.authority, memberships: input.memberships,
        scope: { chainId: input.scope.chainId, orgId: input.scope.orgId, account: input.scope.account, contract: authorityContract },
        restrictions: knownFact(ids), proposalCreatedAt: p.createdAt }).canVote;
    };
    const poll = activation(p.restrictedSubjectIds.value.map(normalizeSubjectId));
    if (poll.state === 'unknown' || poll.value === false) return poll;
    if (input.viewerIsExecutor.source) {
      checkBindings(input.viewerIsExecutor.source);
      assertPlanScope(input.viewerIsExecutor.source, { ...input.scope, contracts: undefined });
    }
    if (input.viewerIsExecutor.state !== 'known' || typeof input.viewerIsExecutor.value !== 'boolean') throw new Error('EXECUTOR_IDENTITY_UNAVAILABLE');
    if (input.viewerIsExecutor.value) return knownFact(true, input.proposal.source);
    const cls = p.classes[input.classIndex];
    if (cls.subjectId.state !== 'known') throw new Error('IMMUTABLE_CLASS_SUBJECT_UNAVAILABLE');
    const id = normalizeSubjectId(cls.subjectId.value);
    return activation(id === '0' ? cls.hatIds.map(normalizeSubjectId) : [id]);
  } catch (error) { return unknownFact(error instanceof Error ? error.message : 'ELIGIBILITY_UNAVAILABLE', input.proposal.source); }
}

/** Integer sqrt with exact uint256 input; neighboring squares need no floating point. */
export function integerSquareRoot(raw: string): string {
  const n = BigInt(requireRawUint(raw));
  if (n < 2n) return n.toString();
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x.toString();
}
/** Post-gate strategy math. A known zero is distinct from an unread balance.
 * Checked uint256 multiplication matches _classPower; this is NOT full vote
 * authorization. Every allocated option also needs calculateOptionContribution
 * with its current uint128 accumulator, and the complete ballot needs host validation. */
export function calculateClassRawPower(input: {
  classConfig: Fact<PowerClass>; eligible: Fact<boolean>; balance: Fact<string>;
  balanceScope?: PlanScope;
}): Fact<string> {
  try {
    if (input.classConfig.state !== 'known') return unknownFact(input.classConfig.code);
    if (input.eligible.state !== 'known') return unknownFact(input.eligible.code);
    if (typeof input.eligible.value !== 'boolean') throw new Error('INVALID_ELIGIBILITY');
    if (!input.eligible.value) return knownFact('0', input.eligible.source);
    const cls = input.classConfig.value;
    if (cls.strategy === 'DIRECT') return knownFact('100', input.classConfig.source);
    if (cls.strategy !== 'ERC20_BAL' || typeof cls.quadratic !== 'boolean'
      || !ethers.utils.isAddress(cls.asset) || cls.asset.toLowerCase() === ethers.constants.AddressZero) throw new Error('INVALID_CLASS');
    const min = BigInt(requireRawUint(cls.minBalance));
    if (input.balance.state !== 'known') return unknownFact(input.balance.code);
    if (input.balanceScope) {
      if (!input.balance.source) throw new Error('BALANCE_SOURCE_REQUIRED');
      assertPlanScope(input.balance.source, { ...input.balanceScope, contract: cls.asset });
    }
    const balance = BigInt(requireRawUint(input.balance.value));
    if (balance < min) return knownFact('0', input.balance.source);
    // Inspected VotingMath.sqrt uses unchecked (x + 1) / 2. At uint256.max
    // this wraps to zero and the loop divides by zero. Mathematical sqrt is
    // still exact; this contract-qualified preview must refuse that panic.
    if (cls.quadratic && balance === (1n << 256n) - 1n) return unknownFact('POWER_CONTRACT_SQRT_DIVISION_BY_ZERO', input.balance.source);
    const power = cls.quadratic ? BigInt(integerSquareRoot(balance.toString())) : balance;
    const raw = requireRawUint(power * 100n);
    return knownFact(raw, input.balance.source);
  } catch { return unknownFact('POWER_INVALID_OR_OVERFLOW'); }
}
/** Contract vote() checks both intermediate uint256 arithmetic and uint128 option storage. */
export function calculateOptionContribution(rawPower: Fact<string>, weight: number, currentRaw: Fact<string>): Fact<string> {
  try {
    if (rawPower.state !== 'known' || currentRaw.state !== 'known') return unknownFact('OPTION_CONTRIBUTION_UNAVAILABLE');
    if (!Number.isInteger(weight) || weight < 0 || weight > 100) throw new Error('Invalid weight');
    const product = BigInt(requireRawUint(BigInt(requireRawUint(rawPower.value)) * BigInt(weight)));
    const delta = product / 100n;
    const current = BigInt(requireRawUint(currentRaw.value, 128));
    requireRawUint(current + delta, 128);
    return knownFact(delta.toString(), rawPower.source);
  } catch { return unknownFact('OPTION_CONTRIBUTION_OVERFLOW_OR_INVALID'); }
}
export interface PersonalVotingShare {
  numerator: string; denominator: string; slicePct: number;
  /** Exact rational percentage, no display rounding. */
  percentNumerator: string; percentDenominator: string; approximate: boolean;
}
export function derivePersonalVotingShare(input: {
  rawPower: Fact<string>; totalRawPower: Fact<string>; slicePct: number;
  /** Prospective/restricted electorate totals are estimates unless explicitly established. */
  denominatorKind: 'snapshot-total' | 'estimate';
}): Fact<PersonalVotingShare> {
  try {
    if (input.rawPower.state !== 'known' || input.totalRawPower.state !== 'known') return unknownFact('DENOMINATOR_OR_POWER_UNAVAILABLE');
    const raw = requireRawUint(input.rawPower.value), total = requireRawUint(input.totalRawPower.value);
    if (total === '0') return unknownFact('ZERO_CLASS_TOTAL');
    if (BigInt(raw) > BigInt(total) || !Number.isInteger(input.slicePct) || input.slicePct < 1 || input.slicePct > 100
      || !['snapshot-total', 'estimate'].includes(input.denominatorKind)) throw new Error('Invalid share');
    return knownFact({ numerator: raw, denominator: total, slicePct: input.slicePct,
      percentNumerator: (BigInt(raw) * BigInt(input.slicePct)).toString(), percentDenominator: total,
      approximate: input.denominatorKind === 'estimate' }, input.totalRawPower.source);
  } catch { return unknownFact('INVALID_PERSONAL_SHARE'); }
}
/** Contract tally fixed point precision=10^4. Allocation rankings are a separate projection. */
export function deriveWeightedTally(input: { perOptionClassRaw: readonly (readonly string[])[]; totalsRaw: readonly string[]; slices: readonly number[] }): Fact<readonly string[]> {
  try {
    if (!input.slices.length || input.slices.length > 8 || input.slices.some(s => !Number.isInteger(s) || s < 1 || s > 100)
      || input.slices.reduce((a, b) => a + b, 0) !== 100 || input.totalsRaw.length !== input.slices.length) throw new Error('Invalid classes');
    const totals = input.totalsRaw.map(t => BigInt(requireRawUint(t)));
    return knownFact(input.perOptionClassRaw.map(row => {
      if (row.length !== totals.length) throw new Error('Invalid tally');
      return row.reduce((score, value, i) => {
        const raw = BigInt(requireRawUint(value, 128));
        if (raw > totals[i]) throw new Error('Contradictory total');
        return score + (totals[i] === 0n ? 0n : raw * BigInt(input.slices[i]) * 10000n / totals[i]);
      }, 0n).toString();
    }));
  } catch { return unknownFact('TALLY_UNAVAILABLE_OR_INVALID'); }
}
/** Ballot allocation totals for display only: never an announced winner or weighted tally. */
export function rankAllocationWeights(totals: readonly string[]): readonly { optionIndex: number; allocationWeight: string; tied: boolean }[] {
  const values = totals.map(v => requireRawUint(v));
  return values.map((allocationWeight, optionIndex) => ({ optionIndex, allocationWeight,
    tied: values.filter(v => v === allocationWeight).length > 1 }))
    .sort((a, b) => BigInt(a.allocationWeight) > BigInt(b.allocationWeight) ? -1 : BigInt(a.allocationWeight) < BigInt(b.allocationWeight) ? 1 : a.optionIndex - b.optionIndex);
}

/** HybridVotingCore._effectiveQuorum: zero override uses the current global
 * voter count; executable batches can only raise it; signal polls replace it.
 * Existence, ballot coverage, voting time and announcement validity are separate.
 */
export function deriveProposalQuorum(input: {
  globalQuorum: Fact<string>; override: Fact<string>; executable: Fact<boolean>;
}): Fact<string> {
  const source = input.override.source ?? input.globalQuorum.source;
  try {
    const sources = [input.globalQuorum.source, input.override.source, input.executable.source].filter((s): s is SourceRef => !!s);
    for (const candidate of sources) {
      assertSourceRef(candidate);
      if (source) {
        assertPlanScope(candidate, { chainId: source.chainId, orgId: source.orgId, contract: source.contract });
        if (source.block) assertSourceBlock(candidate.block, source.block);
      }
    }
    const global = input.globalQuorum.state === 'known' ? requireRawUint(input.globalQuorum.value, 32) : undefined;
    if (input.override.state === 'unknown') return unknownFact(input.override.code, source);
    const override = requireRawUint(input.override.value, 32);
    if (input.executable.state === 'known' && typeof input.executable.value !== 'boolean') throw new Error('INVALID_EXECUTABLE_POLICY');
    if (override === '0') return global === undefined ? unknownFact('GLOBAL_QUORUM_UNAVAILABLE', source) : knownFact(global, source);
    if (input.executable.state === 'unknown') return unknownFact(input.executable.code, source);
    if (!input.executable.value) return knownFact(override, source);
    return global === undefined ? unknownFact('GLOBAL_QUORUM_UNAVAILABLE', source)
      : knownFact(BigInt(global) > BigInt(override) ? global : override, source);
  } catch { return unknownFact('QUORUM_POLICY_UNAVAILABLE', source); }
}
