import { ethers } from 'ethers';
import type { Fact, SourceSnapshot } from '@poa-box/core/data/facts';
import { knownFact } from '@poa-box/core/data/facts';
import { requireRawUint } from '@poa-box/core/amounts';
import { projectUserPermissions, AuthorityPermissionData } from '@poa-box/core/authority/permissions';
import type { ActivationMembership } from '@poa-box/core/authority/activation';
import { AUTHORITY_KEYS } from '@poa-box/core/tx/authority';
import { buildGovernanceProposal } from '@poa-box/core/tx/governance';
import { buildVote } from '@poa-box/core/tx/vote';
import { requireValidVoteWeights } from '@poa-box/core/governance/validation';
import { deriveDirectDemocracyAuthorization, DirectDemocracyAuthorizationData } from '@poa-box/core/governance/dd-authorization';
import { calculateClassRawPower, calculateOptionContribution, deriveClassEligibility, ProposalPowerSnapshot } from '@poa-box/core/governance/power';
import { buildProposalMetadata, serializeProposalMetadata, validateProposalMetadata } from '@poa-box/core/metadata/proposal';
import { cidV0ToBytes32 } from '@poa-box/core/encoding/cid';
import { getAbi } from '@poa-box/core/contracts';
import { createOperationWorkflow } from './operation';
import { allowed, copy, freeze, known, moduleScope, nonzero, refuse, semantic, snapshot } from './shared';
import type { EvidenceReader, WorkflowHost, WorkflowResult } from './types';

export type WorkflowVotingLane = 'hybrid' | 'dd';
export interface GovernanceModuleFacts { paused: Fact<boolean>; executor: Fact<string>; membershipAuthority: Fact<string> }
export interface GovernanceAuthorityEvidence {
  authority?: SourceSnapshot<AuthorityPermissionData>;
  memberships?: SourceSnapshot<readonly ActivationMembership[]>;
}
export interface PollRequest {
  lane: WorkflowVotingLane; title: string; description: string; durationMinutes: string;
  optionNames: readonly string[]; subjectIds?: readonly string[]; quorumOverride?: number; equalWeight?: boolean;
  /** Stable metadata time is an unsigned review input (milliseconds). */
  createdAt: number;
}
export interface PollEvidence extends GovernanceAuthorityEvidence { module: SourceSnapshot<GovernanceModuleFacts> }
export interface PollSummary { lane: WorkflowVotingLane; title: string; options: readonly string[]; durationMinutes: string; informational: true }
const laneAddress = (host: WorkflowHost, lane: WorkflowVotingLane): string => {
  if (lane !== 'hybrid' && lane !== 'dd') refuse('INVALID_VOTING_LANE');
  return nonzero(host.scope.contracts[lane === 'hybrid' ? 'hybridVoting' : 'directDemocracyVoting']);
};
function moduleFacts(host: WorkflowHost, lane: WorkflowVotingLane, evidence: SourceSnapshot<GovernanceModuleFacts>, account = false) {
  const scope = moduleScope(host.scope, laneAddress(host, lane), account), data = snapshot(evidence, scope, host.sources, false);
  const paused = known(data.paused, evidence, scope), executor = nonzero(known(data.executor, evidence, scope)), authority = nonzero(known(data.membershipAuthority, evidence, scope));
  if (typeof paused !== 'boolean') refuse('INVALID_PAUSE_FACT', 'unknown');
  if (paused) refuse('MODULE_PAUSED');
  if (authority.toLowerCase() !== nonzero(host.scope.contracts.membershipAuthority).toLowerCase()
    || executor.toLowerCase() !== nonzero(host.scope.contracts.executor).toLowerCase()) refuse('MODULE_BINDINGS_CHANGED', 'unknown');
  return { scope, data, executor, authority };
}
function authorityFacts(host: WorkflowHost, authority: string, evidence: GovernanceAuthorityEvidence, block: SourceSnapshot<unknown>) {
  if (!evidence.authority || !evidence.memberships) refuse('CURRENT_AUTHORITY_EVIDENCE_REQUIRED', 'unknown');
  const scope = moduleScope(host.scope, authority, true);
  snapshot(evidence.authority, { ...scope, account: undefined }, host.sources, true, block);
  snapshot(evidence.memberships, scope, host.sources, true, block);
  return { scope, authority: evidence.authority, memberships: evidence.memberships };
}
const abiName = (lane: WorkflowVotingLane) => lane === 'hybrid' ? 'HybridVotingNew' as const : 'DirectDemocracyVotingNew' as const;
export function createPollWorkflow(inputHost: WorkflowHost, reader: EvidenceReader<PollRequest, PollEvidence>) {
  const host = { ...inputHost, scope: freeze(copy(inputHost.scope)), sources: { ...inputHost.sources } };
  const params = (request: Readonly<PollRequest>, descriptionHash: string) => ({ votingAddress: laneAddress(host, request.lane), votingAbiName: abiName(request.lane),
    title: request.title, descriptionHash, durationMinutes: requireRawUint(request.durationMinutes), numOptions: request.optionNames.length,
    batches: [], subjectIds: request.subjectIds ? [...request.subjectIds] : [], quorumOverride: request.quorumOverride, equalWeight: request.equalWeight, orgId: host.scope.orgId });
  return createOperationWorkflow(host, reader, {
    name: 'poll',
    evaluate(request, evidence) {
      if (typeof request.title !== 'string' || !request.title.trim() || request.optionNames.length < 2) refuse('POLL_DETAILS_REQUIRED');
      buildGovernanceProposal(params(request, ethers.constants.HashZero));
      const json = serializeProposalMetadata(buildProposalMetadata({ description: request.description, optionNames: [...request.optionNames], createdAt: request.createdAt }));
      validateProposalMetadata(JSON.parse(json));
      const module = moduleFacts(host, request.lane, evidence.module);
      const facts = authorityFacts(host, module.authority, evidence, evidence.module);
      const permission = projectUserPermissions({ snapshot: facts.authority, memberships: facts.memberships, scope: facts.scope,
        permKey: request.lane === 'hybrid' ? AUTHORITY_KEYS.HV_CREATE : AUTHORITY_KEYS.DD_CREATE, ctx: ethers.constants.HashZero });
      if (module.executor.toLowerCase() !== host.scope.account.toLowerCase()) allowed(permission.enabled);
      // Supplied authority observations must remain valid even on Executor bypass.
      else if (permission.enabled.state === 'unknown') refuse(permission.enabled.code, 'unknown');
      return { binding: { executor: module.executor, authority: module.authority, permission: permission.enabled.state === 'known' ? permission.enabled.value : null },
        summary: { lane: request.lane, title: request.title, options: [...request.optionNames], durationMinutes: request.durationMinutes, informational: true as const },
        documents: [{ key: 'proposal-metadata', json, digest: ethers.utils.id(json) }] };
    },
    build(request, _evidence, documents) {
      const document = documents.find(row => row.key === 'proposal-metadata'); if (!document) refuse('PUBLISHED_METADATA_REQUIRED');
      return buildGovernanceProposal(params(request, cidV0ToBytes32(document.cid)));
    },
    outcome(request, receipt): WorkflowResult {
      const iface = new ethers.utils.Interface(getAbi(abiName(request.lane)));
      const events = (receipt.logs ?? []).filter(log => log.address.toLowerCase() === laneAddress(host, request.lane).toLowerCase()).flatMap(log => {
        try { const event = iface.parseLog({ topics: [...log.topics], data: log.data }); return ['NewProposal', 'NewHatProposal'].includes(event.name) ? [event] : []; } catch { return []; }
      });
      if (events.length !== 1) return { status: 'unknown', codes: ['PROPOSAL_CREATION_EVIDENCE_REQUIRED'] };
      return { status: 'confirmed', data: { proposalId: events[0].args.id.toString(), transactionHash: receipt.transactionHash } };
    },
  });
}

export interface BallotRequest { lane: WorkflowVotingLane; proposalId: string; optionIndices: readonly number[]; weights: readonly number[] }
export interface BallotProposalFacts extends GovernanceModuleFacts {
  proposalId: string;
  /** Prefer indexedProposal where this deployment exposes no public getter. */
  exists?: Fact<boolean>; alreadyVoted?: Fact<boolean>; numOptions?: Fact<number>;
  startTimestamp?: Fact<string>; endTimestamp: Fact<string>;
}
export interface BallotIndexedProposalFacts { proposalId: string; exists: Fact<boolean>; alreadyVoted: Fact<boolean>; numOptions: Fact<number>; startTimestamp?: Fact<string> }
export interface BallotHybridTallies { proposalId: string; optionClassRaw: readonly (readonly Fact<string>[])[] }
export interface BallotEvidence extends GovernanceAuthorityEvidence {
  proposal: SourceSnapshot<BallotProposalFacts>;
  indexedProposal?: SourceSnapshot<BallotIndexedProposalFacts>;
  ddAuthorization?: SourceSnapshot<DirectDemocracyAuthorizationData>;
  hybridPower?: SourceSnapshot<ProposalPowerSnapshot & { proposalId: string }>;
  /** One current, same-block token balance per class. DIRECT classes use known zero. */
  balances?: readonly Fact<string>[];
  /** Complete option-major, class-minor uint128 accumulators from this proposal. */
  optionClassRaw?: readonly (readonly Fact<string>[])[];
  hybridTallies?: SourceSnapshot<BallotHybridTallies>;
}
export interface BallotSummary { lane: WorkflowVotingLane; proposalId: string; optionIndices: readonly number[]; weights: readonly number[]; rawPower?: readonly string[] }
export function createBallotWorkflow(inputHost: WorkflowHost, reader: EvidenceReader<BallotRequest, BallotEvidence>) {
  const host = { ...inputHost, scope: freeze(copy(inputHost.scope)), sources: { ...inputHost.sources } };
  return createOperationWorkflow<BallotRequest, BallotEvidence, BallotSummary>(host, reader, {
    name: 'vote',
    evaluate(request, evidence) {
      const proposalId = requireRawUint(request.proposalId), vote = requireValidVoteWeights(request.weights, request.optionIndices);
      const module = moduleFacts(host, request.lane, evidence.proposal, true), p = evidence.proposal.data;
      if (requireRawUint(p.proposalId) !== proposalId) refuse('PROPOSAL_SCOPE_MISMATCH', 'unknown');
      const stateSnapshot = evidence.indexedProposal ?? evidence.proposal;
      const state = evidence.indexedProposal ? snapshot(evidence.indexedProposal, module.scope, host.sources, true, evidence.proposal) : p;
      if (requireRawUint(state.proposalId) !== proposalId) refuse('PROPOSAL_SCOPE_MISMATCH', 'unknown');
      const exists = known(state.exists!, stateSnapshot, module.scope), voted = known(state.alreadyVoted!, stateSnapshot, module.scope), options = known(state.numOptions!, stateSnapshot, module.scope);
      if (exists !== true || voted !== false) refuse(exists !== true ? 'PROPOSAL_NOT_FOUND' : 'ALREADY_VOTED');
      if (!Number.isSafeInteger(options) || options < 1 || options > 50 || request.optionIndices.some(index => index >= options)) refuse('OPTION_OUT_OF_BOUNDS');
      const indexedStart = evidence.indexedProposal?.data.startTimestamp;
      const start = requireRawUint(indexedStart ? known(indexedStart, evidence.indexedProposal!, module.scope) : known(p.startTimestamp!, evidence.proposal, module.scope));
      const end = requireRawUint(known(p.endTimestamp, evidence.proposal, module.scope));
      const chainTime = BigInt(evidence.proposal.source.block!.timestamp!);
      if (chainTime < BigInt(start) || chainTime >= BigInt(end)) refuse('VOTING_CLOSED');
      const facts = authorityFacts(host, module.authority, evidence, evidence.proposal);
      let rawPower: string[] | undefined;
      if (request.lane === 'dd') {
        if (!evidence.ddAuthorization) refuse('DD_AUTHORIZATION_EVIDENCE_REQUIRED', 'unknown');
        snapshot(evidence.ddAuthorization, { ...module.scope, account: undefined }, host.sources, false, evidence.proposal);
        const dd = evidence.ddAuthorization.data;
        if (known(dd.executor, evidence.ddAuthorization, { ...module.scope, account: undefined }).toLowerCase() !== module.executor.toLowerCase()
          || known(dd.membershipAuthority, evidence.ddAuthorization, { ...module.scope, account: undefined }).toLowerCase() !== module.authority.toLowerCase()) refuse('DD_MODULE_BINDINGS_CHANGED', 'unknown');
        allowed(deriveDirectDemocracyAuthorization({ proposal: evidence.ddAuthorization, scope: module.scope, proposalId,
          authority: facts.authority, memberships: facts.memberships }));
      } else {
        if (!evidence.hybridPower || !evidence.balances || (!evidence.optionClassRaw && !evidence.hybridTallies)) refuse('HYBRID_POWER_EVIDENCE_REQUIRED', 'unknown');
        const power = snapshot(evidence.hybridPower, { ...module.scope, account: undefined }, host.sources, false, evidence.proposal);
        if (requireRawUint(power.proposalId) !== proposalId) refuse('POWER_PROPOSAL_SCOPE_MISMATCH', 'unknown');
        const tallyScope = evidence.hybridTallies ? { ...module.scope, account: undefined } : module.scope;
        const tallies = evidence.hybridTallies ? snapshot(evidence.hybridTallies, tallyScope, host.sources, true, evidence.proposal) : undefined;
        if (tallies && requireRawUint(tallies.proposalId) !== proposalId) refuse('TALLY_PROPOSAL_SCOPE_MISMATCH', 'unknown');
        const optionClassRaw = tallies?.optionClassRaw ?? evidence.optionClassRaw!;
        if (!power.classes.length || power.classes.length > 8 || evidence.balances.length !== power.classes.length
          || power.classes.reduce((sum, row) => sum + row.slicePct, 0) !== 100
          || optionClassRaw.length !== options || optionClassRaw.some(row => row.length !== power.classes.length)) refuse('INCOMPLETE_POWER_EVIDENCE', 'unknown');
        rawPower = power.classes.map((config, classIndex) => {
          const eligible = deriveClassEligibility({ proposal: evidence.hybridPower!, scope: module.scope, classIndex,
            viewerIsExecutor: knownFact(module.executor.toLowerCase() === host.scope.account.toLowerCase(), evidence.proposal.source), authority: facts.authority, memberships: facts.memberships });
          const balance = evidence.balances![classIndex];
          if (config.strategy === 'ERC20_BAL') {
            if (!balance.source) refuse('BALANCE_SOURCE_REQUIRED', 'unknown');
            snapshot({ source: balance.source, coverage: evidence.proposal.coverage, data: balance },
              { ...module.scope, contract: config.asset }, host.sources, false, evidence.proposal);
          }
          const raw = calculateClassRawPower({ classConfig: knownFact(config), eligible, balance, balanceScope: module.scope });
          if (raw.state === 'unknown') refuse(raw.code, 'unknown');
          request.optionIndices.forEach((option, i) => {
            const accumulator = optionClassRaw[option][classIndex]; known(accumulator, evidence.hybridTallies ?? evidence.proposal, tallyScope);
            const contribution = calculateOptionContribution(raw, vote.weights[i], accumulator);
            if (contribution.state === 'unknown') refuse(contribution.code, 'unknown');
          });
          return raw.value;
        });
        if (rawPower.every(value => value === '0')) refuse('NO_VOTING_POWER');
      }
      return { binding: { proposalId, executor: module.executor, authority: module.authority, start, end, options,
        ...(rawPower ? { rawPower, power: semantic(evidence.hybridPower!.data) } : { dd: semantic(evidence.ddAuthorization!.data) }), authorityData: facts.authority.data, memberships: facts.memberships.data.map(member => ({ ...member, isMember: member.isMember.state === 'known' ? member.isMember.value : null,
          acceptedAt: member.acceptedAt.state === 'known' ? member.acceptedAt.value : null, seededWhilePaused: member.seededWhilePaused.state === 'known' ? member.seededWhilePaused.value : null })) },
        summary: { lane: request.lane, proposalId, optionIndices: [...request.optionIndices], weights: [...request.weights], ...(rawPower ? { rawPower } : {}) } };
    },
    build(request) { return buildVote({ votingAddress: laneAddress(host, request.lane), votingAbiName: abiName(request.lane), proposalId: request.proposalId,
      optionIndices: [...request.optionIndices], weights: [...request.weights], orgId: host.scope.orgId }); },
    outcome(request, receipt) { return { status: 'confirmed', data: { proposalId: request.proposalId, transactionHash: receipt.transactionHash } }; },
  });
}
