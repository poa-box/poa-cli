import { describe, expect, it, vi } from 'vitest';
import { computeProposalResults, fetchClassConfig } from '../src/reads/vote';

const address = `0x${'11'.repeat(20)}`;
describe('V2 proposal read provenance', () => {
  it.each([true, undefined])('does not mistake the ordinary version for a restricted or unknown synthetic snapshot (%s)', async isHatRestricted => {
    const client = { queryWithFieldFallback: vi.fn().mockResolvedValue({ data: {
      hybridVotingContract: { classVersion: '1', quorum: '2', thresholdPct: '50',
        proposals: [{ classesVersion: '1', isHatRestricted }],
        votingClasses: [{ classVersion: '1', classIndex: 0, strategy: '1', slicePct: 100, quadratic: false,
          minBalance: '0', asset: address, hatIds: [], isActive: true }],
      },
    } }) } as any;
    expect(await fetchClassConfig(client, address, 1)).toBeNull();
  });
  it('retains the global compatibility field while marking effective restricted quorum unknown', () => {
    const report = computeProposalResults({ quorum: '15', proposals: [{ proposalId: '1', status: 'Active', isHatRestricted: true }] });
    expect(report).toMatchObject({ quorumVoterCount: 15, quorumSource: 'current-global-config', effectiveQuorumVoterCount: null });
  });
  it('does not turn absent configuration into zero and can identify unrestricted quorum', () => {
    expect(computeProposalResults({ quorum: null, thresholdPct: null, proposals: [{ proposalId: '1', status: 'Active' }] }))
      .toMatchObject({ quorumVoterCount: undefined, supportThresholdPct: undefined, effectiveQuorumVoterCount: null });
    expect(computeProposalResults({ quorum: '15', proposals: [{ proposalId: '1', status: 'Active', isHatRestricted: false }] }))
      .toMatchObject({ effectiveQuorumVoterCount: 15 });
  });
});

import { computeClassWeightedScores, fetchProposalResultsByOrgId, fetchProposalVoteAnalysis } from '../src/reads/vote';
import { selectIndexedClassSnapshot } from '../src/graph/documents/voting-classes';

describe('voting results and snapshot fidelity', () => {
  const proposal = { proposalId: '2', status: 'Ended', numOptions: 2,
    metadata: { optionNames: ['A', 'B'] }, votes: [
      { voter: address, optionIndexes: ['0'], optionWeights: ['100'] },
    ] };
  it('uses the announced valid winner even when allocation counts favor another option', () => {
    const result = computeProposalResults({ proposals: [{ ...proposal, winningOption: '1', isValid: true }] })!;
    expect(result.allocationLeader?.option).toBe(0);
    expect(result.winner?.option).toBe(1);
    expect(result).toMatchObject({ winnerSource: 'announced', rankingBasis: 'sum-of-ballot-allocations' });
  });
  it('does not call an invalid or unannounced allocation leader the winner', () => {
    expect(computeProposalResults({ proposals: [proposal] })).toMatchObject({ winner: null, winnerSource: 'unannounced' });
    expect(computeProposalResults({ proposals: [{ ...proposal, winningOption: '0', isValid: false }] }))
      .toMatchObject({ winner: null, winnerSource: 'invalid', announcedWinningOption: 0 });
  });
  it('keeps options and the announced result readable while IPFS metadata is unavailable', () => {
    const result = computeProposalResults({ proposals: [{ ...proposal, metadata: null, winningOption: '1', isValid: true }] })!;
    expect(result.ranking.map(r => r.name)).toEqual(['Option 0', 'Option 1']);
    expect(result.winner?.option).toBe(1);
  });
  it('collects all result ballots with an ID cursor', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `vote-${String(i).padStart(4, '0')}`, voter: address, optionIndexes: ['0'], optionWeights: ['100'] }));
    const client = { queryWithFieldFallback: vi.fn()
      .mockResolvedValueOnce({ data: { organization: { hybridVoting: { proposals: [{ ...proposal, votes: page }] } } } })
      .mockResolvedValueOnce({ data: { organization: { hybridVoting: { proposals: [{ ...proposal, votes: [{ ...page[0], id: 'vote-1000' }] }] } } } }) };
    const result = await fetchProposalResultsByOrgId(client as any, '0x01', 2);
    expect(result.totalVoters).toBe(1001);
    expect(result.ranking[0].score).toBe(100100);
    expect(client.queryWithFieldFallback.mock.calls[1][0][0].query).toContain('id_gt: "vote-0999"');
  });
  it('collects analysis ballots beyond a full page without falling back to a recent RPC log window', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `vote-${String(i).padStart(4, '0')}` }));
    const client = { queryWithFieldFallback: vi.fn()
      .mockResolvedValueOnce({ data: { hybridVotingContract: { proposals: [{ votes: page }] } } })
      .mockResolvedValueOnce({ data: { hybridVotingContract: { proposals: [{ votes: [{ id: 'vote-1000' }] }] } } }) };
    const data = await fetchProposalVoteAnalysis(client as any, address, 2);
    expect(data.hybridVotingContract.proposals[0].votes).toHaveLength(1001);
    expect(client.queryWithFieldFallback.mock.calls[1][0][0].variables.after).toBe('vote-0999');
  });
  const row = (classIndex: number, slicePct: number) => ({ version: '100', classIndex, slicePct, strategy: 'DIRECT' });
  it('uses an exact old emission even when a later config shares its version', () => {
    const old = [row(0, 80), row(1, 20)];
    expect(selectIndexedClassSnapshot({ proposals: [{ isHatRestricted: false, classesVersion: '100',
      classesChange: { numClasses: 2, votingClasses: old } }], votingClasses: [row(0, 20), row(1, 80)] }, 2)).toEqual(old);
  });
  it('rejects partial exact snapshots and full legacy history pages', () => {
    expect(selectIndexedClassSnapshot({ classesChange: { numClasses: 2, votingClasses: [row(0, 100)] } })).toEqual([]);
    expect(selectIndexedClassSnapshot({ votingClasses: Array(1000).fill(row(0, 100)), classVersion: '100' })).toEqual([]);
  });
  it('normalizes independently per class and applies Solidity per-voter rounding', () => {
    expect(computeClassWeightedScores([
      { weights: [100, 0], classRawPowers: [100n, 0n] },
      { weights: [0, 100], classRawPowers: [0n, 10n ** 30n] },
    ], [80, 20], 2)).toEqual([80, 20]);
    expect(computeClassWeightedScores([{ weights: [50, 50], classRawPowers: [3n] }], [100], 2)).toEqual([33.3333, 33.3333]);
    expect(computeClassWeightedScores([{ weights: [100, 0], classRawPowers: [100n, 0n] }], [50, 50], 2)).toEqual([50, 0]);
  });
});
