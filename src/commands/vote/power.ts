import type { Argv } from 'yargs';
import { ethers } from 'ethers';
import { requireRawUint } from '@poa-box/core/amounts';
import { Fact, knownFact, unknownFact, PlanScope, requireCompleteSnapshot, SourceRef, SourceSnapshot } from '@poa-box/core/data/facts';
import { projectProposalPowerSnapshot, deriveClassEligibility, calculateClassRawPower, calculateOptionContribution,
  derivePersonalVotingShare, deriveWeightedTally, rankAllocationWeights, deriveProposalQuorum } from '@poa-box/core/governance/power';
import { requireValidVoteWeights } from '@poa-box/core/governance/validation';
import { validateGovernanceBatches } from '@poa-box/core/governance/capabilities';
import { readProposalDetailFacts, readProposalBallotFacts } from '@poa-box/core/reads/vote';
import { authorityAccountActivationMemberships } from '@poa-box/core/reads/authority';
import { readTokenHolderTotals } from '@poa-box/core/reads/token';
import { decodeCanonicalCall, exactTransactionCall, readCanonicalTransaction } from '@poa-box/core/reads/provenance';
import type { IndexedRow } from '@poa-box/core/reads/protocol';
import { getAbi } from '../../lib/contracts';
import { tryAggregate } from '../../lib/multicall';
import { readRoleEvidence, completeCoverage, type RoleEvidence } from '../role/evidence';
import * as output from '../../lib/output';

export interface IndexedPowerMatrix { perOptionClassRaw: string[][]; totalsRaw: string[]; allocationTotals: string[]; ballotCount: string }
/** Assemble complete indexed emitted powers through the shared integer contribution
 * checks. Incomplete/missing class arrays and overflowing accumulators stay unknown. */
export function buildIndexedPowerMatrix(snapshot: SourceSnapshot<readonly IndexedRow[]>, scope: PlanScope, numOptions: number, numClasses: number): Fact<IndexedPowerMatrix> {
  try {
    const ballots = requireCompleteSnapshot(snapshot, { scope, indexed: true, snapshot: 'pinned' });
    if (!Number.isSafeInteger(numOptions) || numOptions < 1 || numOptions > 256 || !Number.isSafeInteger(numClasses) || numClasses < 1 || numClasses > 8) throw new Error('INVALID_POWER_MATRIX_DIMENSIONS');
    const matrix = Array.from({ length: numOptions }, () => Array<string>(numClasses).fill('0'));
    const totals = Array<string>(numClasses).fill('0'), allocations = Array<string>(numOptions).fill('0');
    const voters = new Set<string>();
    for (const row of ballots) {
      if (typeof row.voter !== 'string' || voters.has(row.voter.toLowerCase()) || !Array.isArray(row.classRawPowers) || row.classRawPowers.length !== numClasses) throw new Error('INCOMPLETE_OR_DUPLICATE_POWER_BALLOTS');
      voters.add(row.voter.toLowerCase());
      const indices = row.optionIndexes as number[], weights = row.optionWeights as number[];
      requireValidVoteWeights(weights, indices);
      if (indices.some(index => index >= numOptions)) throw new Error('POWER_OPTION_OUT_OF_RANGE');
      row.classRawPowers.forEach((raw, cls) => {
        const power = requireRawUint(raw as string); totals[cls] = requireRawUint(BigInt(totals[cls]) + BigInt(power));
        indices.forEach((option, i) => {
          const delta = calculateOptionContribution(knownFact(power), weights[i], knownFact(matrix[option][cls]));
          if (delta.state !== 'known') throw new Error(delta.code);
          matrix[option][cls] = (BigInt(matrix[option][cls]) + BigInt(delta.value)).toString();
        });
      });
      indices.forEach((option, i) => { allocations[option] = (BigInt(allocations[option]) + BigInt(weights[i])).toString(); });
    }
    return knownFact({ perOptionClassRaw: matrix, totalsRaw: totals, allocationTotals: allocations, ballotCount: String(ballots.length) }, snapshot.source);
  } catch { return unknownFact('INDEXED_POWER_MATRIX_UNAVAILABLE', snapshot.source); }
}

async function executablePolicy(evidence: RoleEvidence, source: SourceRef, proposalId: string, row: IndexedRow): Promise<Fact<boolean>> {
  try {
    if (typeof row.transactionHash !== 'string' || typeof row.descriptionHash !== 'string') throw new Error('CREATION_POLICY_UNAVAILABLE');
    const voting = new ethers.utils.Interface(getAbi('HybridVotingNew'));
    const proof = await readCanonicalTransaction({ source, provider: evidence.provider, transactionHash: row.transactionHash, freshness: evidence.freshness });
    if (proof.data.inclusion.number !== requireRawUint(row.createdAtBlock as string)) throw new Error('CREATION_BLOCK_MISMATCH');
    const call = exactTransactionCall(proof.data, source.chainId, { target: source.contract,
      matchesCall: candidate => {
        try {
          const parsed = decodeCanonicalCall(voting, candidate.data);
          return ['createProposal', 'createProposalV2'].includes(parsed.name) && parsed.args.numOptions === row.numOptions
            && parsed.args.descriptionHash.toLowerCase() === String(row.descriptionHash).toLowerCase()
            && (typeof row.title !== 'string' || ethers.utils.toUtf8String(parsed.args.title) === row.title);
        } catch { return false; }
      } });
    if (call.operationStatus !== 'succeeded') throw new Error('CREATION_OPERATION_UNSETTLED');
    const parsed = decodeCanonicalCall(voting, call.data);
    const events = call.logs.filter(log => log.address.toLowerCase() === source.contract!.toLowerCase()).flatMap(log => {
      let event: ethers.utils.LogDescription;
      try { event = voting.parseLog({ topics: [...log.topics], data: log.data }); } catch { return []; }
      if (!['NewProposal', 'NewHatProposal'].includes(event.name)) return [];
      const encoded = voting.encodeEventLog(event.signature, event.args);
      if (encoded.data.toLowerCase() !== log.data.toLowerCase() || encoded.topics.length !== log.topics.length
        || encoded.topics.some((topic, i) => topic.toLowerCase() !== log.topics[i].toLowerCase())) throw new Error('NONCANONICAL_PROPOSAL_EVENT');
      return [event];
    });
    if (events.length !== 1 || events[0].args.id.toString() !== proposalId || events[0].args.numOptions !== parsed.args.numOptions
      || events[0].args.descriptionHash.toLowerCase() !== parsed.args.descriptionHash.toLowerCase()
      || events[0].args.title.toLowerCase() !== parsed.args.title.toLowerCase()
      || events[0].name !== (parsed.args.hatIds.length ? 'NewHatProposal' : 'NewProposal')
      || (parsed.args.hatIds.length && (events[0].args.hatIds.length !== parsed.args.hatIds.length
        || events[0].args.hatIds.some((id: ethers.BigNumber, i: number) => !id.eq(parsed.args.hatIds[i]))))) throw new Error('EXACT_CREATION_EVENT_REQUIRED');
    if (parsed.args.numOptions !== row.numOptions || parsed.args.descriptionHash.toLowerCase() !== row.descriptionHash.toLowerCase()
      || (typeof row.proposer === 'string' && ethers.utils.isAddress(row.proposer) && call.caller.toLowerCase() !== row.proposer.toLowerCase())) throw new Error('CREATION_PROPOSAL_MISMATCH');
    const batches = parsed.args.batches.map((batch: ethers.utils.Result[]) => batch.map(item => ({ target: item.target, value: item.value, calldata: item.data })));
    validateGovernanceBatches(batches, parsed.args.numOptions);
    return knownFact(batches.some((batch: unknown[]) => batch.length > 0), source);
  } catch { return unknownFact('CANONICAL_EXECUTION_POLICY_UNAVAILABLE', source); }
}

export const powerHandler = {
  builder: (y: Argv) => y.option('proposal', { type: 'string', demandOption: true, describe: 'Exact hybrid proposal ID; uses its frozen classes and immutable bindings' })
    .option('account', { type: 'string', demandOption: true, describe: 'Observed wallet address; no signing key required' })
    .option('options', { type: 'string', describe: 'Optional comma-separated option indices for a contribution preview' })
    .option('weights', { type: 'string', describe: 'Optional integer percentage weights, paired with --options and totaling 100' })
    .implies('options', 'weights').implies('weights', 'options')
    .option('page-size', { type: 'number', default: 1000 }).option('max-pages', { type: 'number', default: 100 }),
  handler: async (argv: any) => {
    const proposalId = requireRawUint(argv.proposal), account = ethers.utils.getAddress(argv.account);
    if (account === ethers.constants.AddressZero) throw new Error('Observed account must be nonzero');
    if ((argv.options === undefined) !== (argv.weights === undefined)) throw new Error('--options and --weights must be supplied together');
    const indices = argv.options === undefined ? undefined : String(argv.options).split(',').map(value => value.trim() ? Number(value) : NaN);
    const weights = argv.weights === undefined ? undefined : String(argv.weights).split(',').map(value => value.trim() ? Number(value) : NaN);
    if (weights) requireValidVoteWeights(weights, indices);
    const evidence = await readRoleEvidence(argv), contract = evidence.scope.contracts.hybridVoting;
    const scope = { ...evidence.scope, contract, account };
    const source = { ...evidence.rpcSource, contract, method: 'proposal-power-policy' };
    const indexedSource = { ...evidence.indexed.source, contract, method: 'proposal-power-detail' };
    const detail = await readProposalDetailFacts({ source: indexedSource, query: evidence.indexed.protocolQuery, lane: 'hybrid', compositeId: `${contract.toLowerCase()}-${proposalId}` });
    requireCompleteSnapshot(detail, { scope: { ...scope, account: undefined }, indexed: true, snapshot: 'pinned', block: evidence.freshness.block });
    const row = detail.data.proposal.state === 'known' ? detail.data.proposal.value : undefined;
    if (!row) throw new Error('PROPOSAL_POWER_DETAIL_UNAVAILABLE');
    const numOptions = Number(row.numOptions);
    if (indices?.some(index => index >= numOptions)) throw new Error('Contribution preview option is out of range');
    const iface = new ethers.utils.Interface(getAbi('HybridVotingNew'));
    const read = async (calls: { method: string; args: unknown[] }[]): Promise<Fact<ethers.utils.Result>[]> => {
      const results = await tryAggregate(evidence.provider, calls.map(call => ({ to: contract, data: iface.encodeFunctionData(call.method, call.args) })), { blockTag: Number(source.block!.number) });
      return results.map((result, i) => {
        if (!result.success) return unknownFact(`LIVE_${calls[i].method.toUpperCase()}_UNAVAILABLE`, source);
        try { return knownFact(iface.decodeFunctionResult(calls[i].method, result.returnData), source); }
        catch { return unknownFact('INVALID_PROPOSAL_POWER_RESULT', source); }
      });
    };
    let classes = detail.data.classSnapshot.classes;
    if (classes.state !== 'known') {
      const [frozen] = await read([{ method: 'getProposalClasses', args: [proposalId] }]);
      if (frozen.state === 'known') classes = knownFact(frozen.value[0].map((cls: any) => ({ ...cls, strategy: cls.strategy,
        minBalance: cls.minBalance.toString(), hatIds: cls.hatIds.map(String), slicePct: cls.slicePct, quadratic: cls.quadratic, asset: cls.asset })), source);
    }
    if (classes.state !== 'known') {
      if (output.isJsonMode()) output.json({ orgId: scope.orgId, proposalId, account, powerSnapshot: classes, voteAuthorization: unknownFact('FULL_VOTE_AUTHORIZATION_NOT_EVALUATED') });
      else output.keyValueBlock('Hybrid proposal power', { proposalId, account, power: `unknown: ${classes.code}` });
      return;
    }
    const subjects = evidence.snapshot.data.subjects;
    const methods = ['membershipAuthority', 'executor', 'proposalCreatedAt', 'pollRestricted', 'quorum', 'proposalQuorumOverride', 'thresholdPct', 'proposalEndTimestamp', 'paused'];
    const fixed = await read([...methods.map(method => ({ method, args: ['proposalCreatedAt', 'pollRestricted', 'proposalQuorumOverride', 'proposalEndTimestamp'].includes(method) ? [proposalId] : [] })),
      ...classes.value.map((_, i) => ({ method: 'proposalClassSubject', args: [proposalId, i] })),
      ...subjects.map(subject => ({ method: 'pollHatAllowed', args: [proposalId, subject.subjectId] }))]);
    const field = <T>(index: number, decode: (value: any) => T): Fact<T> => fixed[index].state === 'known'
      ? knownFact(decode((fixed[index] as { state: 'known'; value: ethers.utils.Result }).value[0]), source)
      : unknownFact((fixed[index] as { state: 'unknown'; code: string }).code, source);
    const authority = field(0, String), executor = field(1, String), createdAt = field(2, value => value.toString());
    const restricted = field<boolean>(3, value => value), globalQuorum = field(4, value => value.toString()), override = field(5, value => value.toString());
    const bindingValid = authority.state === 'known' && authority.value.toLowerCase() === evidence.scope.contract.toLowerCase();
    const restrictionOffset = methods.length + classes.value.length;
    const allRestrictionsKnown = subjects.every((_, i) => fixed[restrictionOffset + i].state === 'known');
    const restrictions = restricted.state !== 'known' ? unknownFact<readonly string[]>('POLL_RESTRICTIONS_UNAVAILABLE', source)
      : !restricted.value ? knownFact<readonly string[]>([], source)
        : !allRestrictionsKnown ? unknownFact<readonly string[]>('POLL_RESTRICTIONS_UNAVAILABLE', source)
          : knownFact(subjects.filter((_, i) => (fixed[restrictionOffset + i] as any).value[0]).map(subject => subject.subjectId), source);
    // A restricted empty set must never become the helper's unrestricted [] sentinel.
    const safeRestrictions = restricted.state === 'known' && restricted.value && restrictions.state === 'known' && !restrictions.value.length
      ? unknownFact<readonly string[]>('RESTRICTED_ELECTORATE_EMPTY_OR_UNAVAILABLE', source) : restrictions;
    const bindings = classes.value.map((_, i) => field(methods.length + i, value => value.toString()));
    const powerSnapshot = projectProposalPowerSnapshot({ scope: { ...scope, account: undefined }, snapshot: { source, coverage: completeCoverage, data: {
      classes, proposalClassSubjects: bindings.every(fact => fact.state === 'known') ? knownFact(bindings.map(fact => (fact as any).value), source)
        : unknownFact('IMMUTABLE_CLASS_BINDINGS_UNAVAILABLE', source), createdAt, restrictedSubjectIds: safeRestrictions,
    } } });
    const ballots = await readProposalBallotFacts({ source: indexedSource, query: evidence.indexed.protocolQuery, lane: 'hybrid', proposalId,
      pageSize: argv.pageSize ?? 1000, maxPages: argv.maxPages ?? 100 });
    const matrix = buildIndexedPowerMatrix(ballots, { ...scope, account: undefined }, numOptions, classes.value.length);
    const executable = override.state === 'known' && override.value === '0' ? unknownFact<boolean>('EXECUTION_POLICY_NOT_NEEDED', source)
      : await executablePolicy(evidence, source, proposalId, row);
    const effectiveQuorum = deriveProposalQuorum({ globalQuorum, override, executable });
    const quorumMet = matrix.state === 'known' && effectiveQuorum.state === 'known'
      ? knownFact(BigInt(matrix.value.ballotCount) >= BigInt(effectiveQuorum.value), indexedSource) : unknownFact<boolean>('QUORUM_OR_BALLOTS_UNAVAILABLE', indexedSource);
    const memberships = authorityAccountActivationMemberships(evidence.snapshot, account);
    const viewerIsExecutor = executor.state === 'known' ? knownFact(executor.value.toLowerCase() === account.toLowerCase(), { ...source, account }) : unknownFact<boolean>('EXECUTOR_UNAVAILABLE', source);
    const balances = new Map<string, Fact<string>>();
    if (powerSnapshot.state === 'known') {
      const assets = [...new Set(powerSnapshot.value.data.classes.filter(cls => cls.strategy === 'ERC20_BAL').map(cls => cls.asset.toLowerCase()))];
      const participation = evidence.modules.participationTokenAddress?.toLowerCase();
      if (participation && assets.includes(participation)) {
        const holders = await readTokenHolderTotals({ source: { ...indexedSource, contract: participation }, query: evidence.indexed.protocolQuery,
          pageSize: argv.pageSize ?? 1000, maxPages: argv.maxPages ?? 100 });
        try { requireCompleteSnapshot(holders, { scope: { chainId: scope.chainId, orgId: scope.orgId, contract: participation }, indexed: true, snapshot: 'pinned', block: source.block });
          balances.set(participation, knownFact(holders.data.holders.find(holder => holder.account.toLowerCase() === account.toLowerCase())?.balanceRaw ?? '0', { ...holders.source, account })); }
        catch { balances.set(participation, unknownFact('PARTICIPATION_BALANCE_UNAVAILABLE', { ...holders.source, account })); }
      }
      // Arbitrary ERC20 class assets outside the org's indexed ParticipationToken
      // data source require a bounded balanceOf observation on the org chain.
      const external = assets.filter(asset => asset !== participation), erc20 = new ethers.utils.Interface(['function balanceOf(address) view returns (uint256)']);
      const rows = await tryAggregate(evidence.provider, external.map(to => ({ to, data: erc20.encodeFunctionData('balanceOf', [account]) })), { blockTag: Number(source.block!.number) });
      rows.forEach((result, i) => { const balanceSource = { ...source, contract: external[i], account };
        try { if (!result.success) throw new Error(); balances.set(external[i], knownFact(erc20.decodeFunctionResult('balanceOf', result.returnData)[0].toString(), balanceSource)); }
        catch { balances.set(external[i], unknownFact('EXTERNAL_TOKEN_BALANCE_UNAVAILABLE', balanceSource)); } });
    }
    const forecast = powerSnapshot.state !== 'known' ? powerSnapshot : knownFact(powerSnapshot.value.data.classes.map((cls, classIndex) => {
      const eligibility = bindingValid ? deriveClassEligibility({ proposal: powerSnapshot.value, scope, classIndex, viewerIsExecutor,
        authority: evidence.snapshot, memberships }) : unknownFact<boolean>('POWER_AUTHORITY_BINDING_MISMATCH', source);
      const balance = balances.get(cls.asset.toLowerCase()) ?? unknownFact<string>('BALANCE_NOT_REQUIRED', source);
      const rawPower = calculateClassRawPower({ classConfig: knownFact(cls, source), eligible: eligibility, balance, balanceScope: { chainId: scope.chainId, account } });
      const emitted = ballots.coverage.status === 'complete' ? ballots.data.find(ballot => String(ballot.voter).toLowerCase() === account.toLowerCase()) : undefined;
      const castRaw = emitted && Array.isArray(emitted.classRawPowers) && emitted.classRawPowers.length === classes.value.length
        ? knownFact(String(emitted.classRawPowers[classIndex]), indexedSource) : unknownFact<string>('NO_COMPLETE_EMITTED_BALLOT', indexedSource);
      const castShare = derivePersonalVotingShare({ rawPower: castRaw, totalRawPower: matrix.state === 'known' ? knownFact(matrix.value.totalsRaw[classIndex], indexedSource)
        : unknownFact('CLASS_TOTAL_UNAVAILABLE', indexedSource), slicePct: cls.slicePct, denominatorKind: 'snapshot-total' });
      const prospectiveTotal = matrix.state === 'known' && rawPower.state === 'known' && !emitted
        ? knownFact((BigInt(matrix.value.totalsRaw[classIndex]) + BigInt(rawPower.value)).toString(), indexedSource) : unknownFact<string>('PROSPECTIVE_TOTAL_UNAVAILABLE', indexedSource);
      const prospectiveShare = derivePersonalVotingShare({ rawPower, totalRawPower: prospectiveTotal, slicePct: cls.slicePct, denominatorKind: 'estimate' });
      const contributions = indices?.map((option, i) => ({ option, weight: weights![i], delta: calculateOptionContribution(rawPower, weights![i],
        matrix.state === 'known' ? knownFact(matrix.value.perOptionClassRaw[option][classIndex], indexedSource) : unknownFact('OPTION_TOTAL_UNAVAILABLE', indexedSource)) }));
      return { classIndex, config: cls, eligibility, balance, rawPower, castShare, prospectiveShare, ...(contributions ? { contributions } : {}) };
    }), source);
    const tally = matrix.state === 'known' && powerSnapshot.state === 'known' ? deriveWeightedTally({ perOptionClassRaw: matrix.value.perOptionClassRaw,
      totalsRaw: matrix.value.totalsRaw, slices: powerSnapshot.value.data.classes.map(cls => cls.slicePct) }) : unknownFact<readonly string[]>('TALLY_UNAVAILABLE', indexedSource);
    await evidence.assertCanonical();
    const result = { orgId: scope.orgId, proposalId, account, source, powerSnapshot, forecast, matrix, weightedTally: tally,
      allocationRanking: matrix.state === 'known' ? knownFact(rankAllocationWeights(matrix.value.allocationTotals), indexedSource) : unknownFact('ALLOCATION_TOTALS_UNAVAILABLE', indexedSource),
      quorum: { global: globalQuorum, override, executable, effective: effectiveQuorum, met: quorumMet, units: 'voter-count' },
      thresholdPct: field(6, Number), endTimestamp: field(7, value => value.toString()), paused: field(8, Boolean),
      ballotEvidence: { source: ballots.source, coverage: ballots.coverage }, voteAuthorization: unknownFact('FULL_VOTE_AUTHORIZATION_NOT_EVALUATED'),
      note: 'Read-only power and tally observations. Prospective shares are estimates; this result does not authorize voting or announce a winner.' };
    if (output.isJsonMode()) output.json(result);
    else output.keyValueBlock('Hybrid proposal power', { proposalId, account, classes: classes.value.length,
      ballots: matrix.state === 'known' ? matrix.value.ballotCount : 'unknown', quorum: effectiveQuorum.state === 'known' ? effectiveQuorum.value : 'unknown',
      forecast: forecast.state, tally: tally.state, authorization: 'not evaluated' });
  },
};
