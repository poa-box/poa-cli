import { ethers } from 'ethers';
import { getAbi } from '@poa-box/core/contracts';
import { knownFact, requireCompleteSnapshot, SourceBlock, SourceSnapshot } from '@poa-box/core/data/facts';
import { readProposalDetailFacts, readProposalBallotFacts } from '@poa-box/core/reads/vote';
import { calculateOptionContribution, projectProposalPowerSnapshot, ProposalPowerClassInput } from '@poa-box/core/governance/power';
import type { BallotEvidence, BallotRequest, GovernanceModuleFacts, PollEvidence, PollRequest, WorkflowVotingLane } from '../workflows/governance';
import type { EvidenceReader } from '../workflows/types';
import { address, bool, fail, ObservationRuntime, uint } from './common';

const laneName = (lane: WorkflowVotingLane) => { if (lane !== 'hybrid' && lane !== 'dd') fail('UNSUPPORTED_VOTING_LANE'); return lane === 'hybrid' ? 'hybridVoting' : 'directDemocracyVoting'; };
const abiFor = (lane: WorkflowVotingLane) => getAbi(lane === 'hybrid' ? 'HybridVotingNew' : 'DirectDemocracyVotingNew');
async function moduleFacts(runtime: ObservationRuntime, lane: WorkflowVotingLane, block: SourceBlock, signal: AbortSignal, account = false): Promise<SourceSnapshot<GovernanceModuleFacts>> {
  const contract = runtime.scope.contracts[laneName(lane)], abi = abiFor(lane);
  const [paused, executor, authority] = await Promise.all(['paused', 'executor', 'membershipAuthority'].map(method => runtime.rpc(contract, abi, method, [], block, signal)));
  if (address(executor) !== runtime.scope.contracts.executor || address(authority) !== runtime.scope.contracts.membershipAuthority) fail('VOTING_MODULE_BINDING_MISMATCH');
  const source = runtime.source(contract, false, block, 'workflow-voting-module', account ? runtime.scope.account : undefined);
  return runtime.snapshot({ paused: knownFact(bool(paused), source), executor: knownFact(address(executor), source), membershipAuthority: knownFact(address(authority), source) }, source);
}
export function pollReader(runtime: ObservationRuntime): EvidenceReader<PollRequest, PollEvidence> {
  return { read: (request, options) => runtime.run(options.scope, options.signal, async signal => {
    const block = await runtime.open(laneName(request.lane), signal);
    const [module, authority] = await Promise.all([moduleFacts(runtime, request.lane, block, signal), runtime.authority(block, signal)]);
    await runtime.canonical(block, signal);
    return { module, ...authority };
  }) };
}
export function ballotReader(runtime: ObservationRuntime): EvidenceReader<BallotRequest, BallotEvidence> {
  return { read: (request, options) => runtime.run(options.scope, options.signal, async signal => {
    const module = laneName(request.lane), contract = runtime.scope.contracts[module], proposalId = uint(request.proposalId);
    const block = await runtime.open(module, signal), abi = abiFor(request.lane);
    const indexedSource = runtime.source(contract, true, block, 'workflow-ballot-state', runtime.scope.account);
    const query = (document: string, variables: Record<string, unknown>, source: typeof indexedSource) => runtime.query(document, variables, source, signal);
    const [bindings, authority, detail, ballots, created, ended, restricted] = await Promise.all([
      moduleFacts(runtime, request.lane, block, signal, true), runtime.authority(block, signal),
      readProposalDetailFacts({ source: { ...indexedSource, account: undefined }, query, lane: request.lane, compositeId: `${contract}-${proposalId}` }),
      readProposalBallotFacts({ source: indexedSource, query, lane: request.lane, proposalId, pageSize: runtime.pageSize, maxPages: runtime.maxPages }),
      runtime.rpc(contract, abi, 'proposalCreatedAt', [proposalId], block, signal),
      runtime.rpc(contract, abi, 'proposalEndTimestamp', [proposalId], block, signal),
      runtime.rpc(contract, abi, 'pollRestricted', [proposalId], block, signal),
    ]);
    requireCompleteSnapshot(detail, { scope: { ...indexedSource, account: undefined }, block });
    requireCompleteSnapshot(ballots, { scope: indexedSource, block });
    if (ballots.data.length > runtime.maxRows) fail('BALLOT_ROW_LIMIT');
    if (detail.data.proposal.state !== 'known') fail('PROPOSAL_STATE_UNAVAILABLE');
    const row = detail.data.proposal.value;
    if (!row) fail('PROPOSAL_NOT_INDEXED');
    const start = uint(row.startTimestamp, 64), end = uint(row.endTimestamp, 64), numOptions = Number(uint(row.numOptions, 8));
    if (numOptions < 1 || numOptions > 50 || uint(ended, 64) !== end
      || bool(restricted) !== bool(row.isHatRestricted) || !Array.isArray(row.restrictedHatIds)
      || row.restrictedHatIds.length > 1000 || (restricted && !row.restrictedHatIds.length)) fail('PROPOSAL_RPC_INDEX_MISMATCH');
    const restrictions = (row.restrictedHatIds as unknown[]).map(id => uint(id));
    const indexedProposal = runtime.snapshot({ proposalId, exists: knownFact(true, indexedSource),
      alreadyVoted: knownFact(ballots.data.some(ballot => String(ballot.voter).toLowerCase() === runtime.scope.account), indexedSource),
      numOptions: knownFact(numOptions, indexedSource), startTimestamp: knownFact(start, indexedSource) }, indexedSource);
    const source = bindings.source;
    const proposal = runtime.snapshot({ ...bindings.data, proposalId, exists: indexedProposal.data.exists, alreadyVoted: indexedProposal.data.alreadyVoted,
      numOptions: indexedProposal.data.numOptions, startTimestamp: knownFact(start, indexedSource), endTimestamp: knownFact(end, source) }, source);
    const base = { proposal, indexedProposal, ...authority };
    if (request.lane === 'dd') {
      await runtime.canonical(block, signal);
      const authSource = { ...source, account: undefined, method: 'workflow-dd-authorization' };
      return { ...base, ddAuthorization: runtime.snapshot({ proposalId, createdAt: knownFact(uint(created, 64), authSource),
        executor: knownFact(runtime.scope.contracts.executor, authSource), membershipAuthority: knownFact(runtime.scope.contracts.membershipAuthority, authSource),
        restricted: knownFact(bool(restricted), authSource), restrictedSubjectIds: knownFact(restricted ? restrictions : [], { ...indexedSource, account: undefined }) }, authSource) };
    }
    // The index's immutable emission is preferred. Restricted/synthetic classes
    // require the exact supported RPC fallback, never the current live classes.
    let classes: ProposalPowerClassInput[];
    if (detail.data.classSnapshot.classes.state === 'known') {
      classes = detail.data.classSnapshot.classes.value.map(cls => ({ strategy: cls.strategy, slicePct: cls.slicePct,
        quadratic: cls.quadratic, minBalance: cls.minBalance, asset: cls.asset, hatIds: cls.hatIds }));
    } else {
      if (detail.data.classSnapshot.fallback?.method !== 'getProposalClasses') fail('FROZEN_CLASSES_UNAVAILABLE');
      const rows = await runtime.rpc(contract, abi, 'getProposalClasses', [proposalId], block, signal) as Record<string, unknown>[];
      if (!Array.isArray(rows)) fail('FROZEN_CLASSES_UNAVAILABLE');
      classes = rows.map(cls => ({ strategy: Number(uint(cls.strategy, 8)), slicePct: Number(uint(cls.slicePct, 8)),
        quadratic: bool(cls.quadratic), minBalance: uint(cls.minBalance), asset: String(cls.asset), hatIds: Array.isArray(cls.hatIds) ? cls.hatIds.map(id => uint(id)) : fail('CLASS_SUBJECTS_UNAVAILABLE') }));
    }
    if (!classes.length || classes.length > 8) fail('CLASS_COUNT_UNAVAILABLE');
    const subjects = await Promise.all(classes.map((_cls, index) => runtime.rpc(contract, abi, 'proposalClassSubject', [proposalId, index], block, signal).then(value => uint(value))));
    const powerSource = { ...source, account: undefined, method: 'workflow-frozen-power' };
    // Provenance for indexed classes is retained on the class fact itself.
    const classSource = detail.data.classSnapshot.classes.state === 'known' ? detail.source : powerSource;
    const power = projectProposalPowerSnapshot({ scope: { ...runtime.scope, account: undefined, contract }, snapshot: runtime.snapshot({ classes: knownFact(classes, classSource),
      proposalClassSubjects: knownFact(subjects, powerSource), createdAt: knownFact(uint(created, 64), powerSource),
      restrictedSubjectIds: knownFact(restricted ? restrictions : [], { ...indexedSource, account: undefined }) }, powerSource) });
    if (power.state !== 'known') fail('FROZEN_POWER_UNAVAILABLE');
    const assets = [...new Set(power.value.data.classes.filter(cls => cls.strategy === 'ERC20_BAL').map(cls => address(cls.asset)))];
    const assetBalances = new Map(await Promise.all(assets.map(async asset => [asset,
      knownFact(uint(await runtime.rpc(asset, getAbi('ERC20'), 'balanceOf', [runtime.scope.account], block, signal)), runtime.source(asset, false, block, 'balanceOf', runtime.scope.account))] as const)));
    const balances = power.value.data.classes.map(cls => cls.strategy === 'DIRECT' ? knownFact('0', source) : assetBalances.get(address(cls.asset))!);
    const accumulators = Array.from({ length: numOptions }, () => Array.from({ length: classes.length }, () => 0n));
    for (const ballot of ballots.data) {
      const raw = ballot.classRawPowers as string[], indices = ballot.optionIndexes as number[], weights = ballot.optionWeights as number[];
      if (raw.length !== classes.length) fail('BALLOT_CLASS_COUNT_MISMATCH');
      indices.forEach((option, allocation) => raw.forEach((value, index) => {
        const delta = calculateOptionContribution(knownFact(value), weights[allocation], knownFact(accumulators[option][index].toString()));
        if (delta.state !== 'known') fail('INDEXED_ACCUMULATOR_UNAVAILABLE');
        accumulators[option][index] += BigInt(delta.value);
      }));
    }
    // Indexed accumulators have their own indexed observation, never an RPC label.
    const optionClassRaw = accumulators.map(row => row.map(value => knownFact(value.toString(), indexedSource)));
    await runtime.canonical(block, signal);
    return { ...base, hybridPower: { ...power.value, data: { ...power.value.data, proposalId } }, balances, optionClassRaw, hybridTallies: runtime.snapshot({ proposalId, optionClassRaw }, indexedSource) };
  }) };
}
