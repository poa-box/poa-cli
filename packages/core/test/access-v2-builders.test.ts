import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { buildGovernanceProposal } from '../src/tx/governance';
import { parseClassConfigs } from '../src/tx/vote';
import { buildDeploymentParams, validateOrgDeployConfig, type OrgDeployConfig } from '../src/tx/org';
import { encodeProjectStruct } from '../src/tx/project';
import { encodeIntent } from '../src/tx/intent';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const SUBJECT = '26959946667150639794667015087019630673637144422540572481103610249216';
const proposal = { votingAddress: ADDRESS, votingAbiName: 'HybridVotingNew' as const, title: 'Restricted vote', descriptionHash: ethers.constants.HashZero, durationMinutes: 60, numOptions: 2, batches: [] };
const config = (): OrgDeployConfig => ({ orgName: 'Access v2', hybridVoting: { thresholdPct: 51, quorum: 7, classes: [{ strategy: 'DIRECT', slicePct: 100 }] }, directDemocracy: { thresholdPct: 51, quorum: 4 }, roles: [{ name: 'Member', canVote: true, open: true }], roleAssignments: { quickJoinRoles: [0], tokenMemberRoles: [0], tokenApproverRoles: [0], taskCreatorRoles: [0], hybridProposalCreatorRoles: [0], ddVotingRoles: [0], ddCreatorRoles: [0] }, token: { name: 'Participation', symbol: 'PART' } });

describe('Access v2 transaction encoding', () => {
  it.each(['HybridVotingNew', 'DirectDemocracyVotingNew'] as const)('encodes the actual %s createProposalV2 selector and subject ids', votingAbiName => {
    const intent = buildGovernanceProposal({ ...proposal, votingAbiName, subjectIds: [SUBJECT], quorumOverride: 3, equalWeight: votingAbiName === 'HybridVotingNew' });
    const signature = votingAbiName === 'HybridVotingNew'
      ? 'function createProposalV2(bytes,bytes32,uint32,uint8,(address,uint256,bytes)[][],uint256[],uint32,bool)'
      : 'function createProposalV2(bytes,bytes32,uint32,uint8,(address,uint256,bytes)[][],uint256[],uint32)';
    const iface = new ethers.utils.Interface([signature]);
    const decoded = iface.decodeFunctionData('createProposalV2', encodeIntent(intent).data);
    expect(decoded[5][0].toString()).toBe(SUBJECT);
    expect(decoded[6]).toBe(3);
    if (votingAbiName === 'HybridVotingNew') expect(decoded[7]).toBe(true);
  });
  it('retains the original selector when no per-proposal overrides are requested', () => {
    expect(buildGovernanceProposal(proposal).method).toBe('createProposal');
  });
  it('rejects unrestricted overrides, DD equal-weight, invalid counts and conflicting ID names', () => {
    expect(() => buildGovernanceProposal({ ...proposal, quorumOverride: 1 })).toThrow('restricted');
    expect(() => buildGovernanceProposal({ ...proposal, subjectIds: [SUBJECT], equalWeight: true, votingAbiName: 'DirectDemocracyVotingNew' })).toThrow('HybridVoting');
    expect(() => buildGovernanceProposal({ ...proposal, subjectIds: [SUBJECT], quorumOverride: 1.5 })).toThrow('uint32');
    expect(() => buildGovernanceProposal({ ...proposal, subjectIds: [SUBJECT], hatIds: [1] })).toThrow('not both');
  });
  it('preserves subject arrays and stable class bindings without unsafe-number coercion', () => {
    const [parsed] = parseClassConfigs([{ strategy: 'DIRECT', slicePct: 100, subjectIds: [SUBJECT], subjectId: SUBJECT }]);
    expect(parsed.hatIds[0].toString()).toBe(SUBJECT);
    expect(parsed.subjectId?.toString()).toBe(SUBJECT);
    for (const id of [-1, Number.MAX_SAFE_INTEGER + 1, ethers.constants.MaxUint256.add(1).toString()]) {
      expect(() => parseClassConfigs([{ strategy: 'DIRECT', slicePct: 100, subjectIds: [id] }])).toThrow();
    }
  });
  it('encodes the Wave G deployment tail and authority role layout', () => {
    const params = buildDeploymentParams(config(), { orgId: ethers.constants.HashZero, metadataHash: ethers.constants.HashZero, registryAddr: ADDRESS, deployerAddress: ADDRESS, deployerUsername: 'founder', regDeadline: 0, regNonce: 0, regSignature: '0x' });
    expect(params).toHaveLength(27);
    expect(params.slice(23)).toEqual([7, 4, 'Participation', 'PART']);
    expect(params[14]).toEqual([['Member', '', ethers.constants.HashZero, true, true, 0, [false, 0, 0], [true, []]]]);
    expect(params[22]).toEqual([[0], [1]]);
  });
  it.each([
    (c: OrgDeployConfig) => { c.hybridVoting.classes = Array.from({ length: 10 }, () => ({ strategy: 'DIRECT' as const, slicePct: 10 })); },
    (c: OrgDeployConfig) => { c.hybridVoting.classes.push({ strategy: 'DIRECT', slicePct: 0 }); },
    (c: OrgDeployConfig) => { c.roles[0].metadataCID = 'not-a-digest'; },
    (c: OrgDeployConfig) => { c.hybridVoting.classes[0].minBalance = '-1'; },
    (c: OrgDeployConfig) => { c.roles[0].vouching = { enabled: false, quorum: -1, voucherRoleIndex: 0 }; },
  ])('rejects malformed deployment fields before side effects', mutate => {
    const c = config(); mutate(c); expect(() => validateOrgDeployConfig(c)).toThrow('Config invalid');
  });
  it('rejects retired project masks and invalid manager/budget data, preserving explicit managers', () => {
    const base = { taskManagerAddress: ADDRESS, name: 'Project' };
    expect(() => encodeProjectStruct({ ...base, createHats: [SUBJECT] })).toThrow('removed');
    expect(() => encodeProjectStruct({ ...base, managers: [ethers.constants.AddressZero] })).toThrow('non-zero');
    expect(() => encodeProjectStruct({ ...base, bountyTokens: [ADDRESS] })).toThrow('equal lengths');
    expect(() => encodeProjectStruct({ ...base, cap: -1 })).toThrow('caps');
    expect(encodeProjectStruct({ ...base, managers: [ADDRESS] })[3]).toEqual([ADDRESS]);
  });
});
