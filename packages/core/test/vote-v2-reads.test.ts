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
