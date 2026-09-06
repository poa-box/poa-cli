import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { buildDeploymentParams, validateOrgDeployConfig } from '../../packages/core/src/tx/org';
import type { OrgDeployConfig } from '../../packages/core/src/tx/org';
import { getAbi } from '../../packages/core/src/contracts';

function config(): OrgDeployConfig {
  return {
    orgName: 'Native', hybridVoting: { thresholdPct: 51, quorum: 3, classes: [{ strategy: 'DIRECT', slicePct: 100 }] },
    directDemocracy: { thresholdPct: 60, quorum: 2 },
    roles: [{ name: 'Member', canVote: true, open: true, maxMembers: 20, distribution: { mintToDeployer: true } }],
    groups: [{ name: 'Everyone', memberRoleIndices: [0] }], token: { name: 'Native Shares', symbol: 'NS' },
    roleAssignments: { quickJoinRoles: [0], tokenMemberRoles: [0], tokenApproverRoles: [0], taskCreatorRoles: [0], hybridProposalCreatorRoles: [0], ddVotingRoles: [0], ddCreatorRoles: [0] },
    taskManagerPerms: { roleIndices: [0], masks: [255] },
  };
}

it('encodes current 27-field deployment with role subjects, groups, token metadata and voter quorums', () => {
  const params = buildDeploymentParams(config(), {
    orgId: ethers.constants.HashZero, metadataHash: ethers.constants.HashZero, registryAddr: ethers.constants.AddressZero,
    deployerAddress: '0x1111111111111111111111111111111111111111', deployerUsername: '', regDeadline: 0, regNonce: 0, regSignature: '0x',
  });
  const iface = new ethers.utils.Interface(getAbi('OrgDeployerNew'));
  const [decoded] = iface.decodeFunctionData('deployFullOrg', iface.encodeFunctionData('deployFullOrg', [params]));
  expect(decoded).toHaveLength(27);
  expect(decoded.roles[0].open).toBe(true);
  expect(decoded.roles[0].maxMembers).toBe(20);
  expect(decoded.roles[0].vouching).toHaveLength(3);
  expect(decoded.groups[0].memberRoleIndices[0].toString()).toBe('0');
  expect(decoded.roleAssignments.quickJoinRolesBitmap.toString()).toBe('1');
  expect(decoded.hybridQuorum).toBe(3);
  expect(decoded.ddQuorum).toBe(2);
  expect(decoded.tokenName).toBe('Native Shares');
  expect(decoded.tokenSymbol).toBe('NS');
});

describe('authority genesis validation', () => {
  it.each(['hatConfig', 'defaults', 'hierarchy'])('rejects legacy %s rather than ignoring its permission meaning', field => {
    const c = config(); (c.roles[0] as any)[field] = {};
    expect(() => validateOrgDeployConfig(c)).toThrow('legacy Hats');
  });
  it('requires explicit openness and refuses closed QuickJoin roles', () => {
    const c = config(); delete (c.roles[0] as any).open;
    expect(() => validateOrgDeployConfig(c)).toThrow('open');
    c.roles[0].open = false;
    expect(() => validateOrgDeployConfig(c)).toThrow('QuickJoin');
  });
  it('checks group members are unique valid roles', () => {
    const c = config(); c.groups![0].memberRoleIndices = [0, 0];
    expect(() => validateOrgDeployConfig(c)).toThrow('duplicate');
    c.groups![0].memberRoleIndices = [1];
    expect(() => validateOrgDeployConfig(c)).toThrow('role index 1');
  });
  it('checks vouch attestor, cap, assignment and task permission indices', () => {
    const c = config(); c.roles[0].vouching = { enabled: true, quorum: 0, voucherRoleIndex: 0 };
    expect(() => validateOrgDeployConfig(c)).toThrow('positive quorum');
    delete c.roles[0].vouching;
    c.roles[0].maxMembers = 1; c.roles[0].distribution!.additionalWearers = ['0x2222222222222222222222222222222222222222'];
    expect(() => validateOrgDeployConfig(c)).toThrow('genesis');
    c.roles[0].maxMembers = 0; c.taskManagerPerms!.roleIndices = [4];
    expect(() => validateOrgDeployConfig(c)).toThrow('role index 4');
  });
  it('rejects zero voting thresholds before preparing deployment', () => {
    const c = config(); c.hybridVoting.thresholdPct = 0;
    expect(() => validateOrgDeployConfig(c)).toThrow('between 1 and 100');
  });
  it('checks group/role caps and exact uint32 quorum range', () => {
    const c = config(); c.hybridVoting.quorum = 4294967296;
    expect(() => validateOrgDeployConfig(c)).toThrow('quorum');
    c.hybridVoting.quorum = 4294967295;
    expect(() => validateOrgDeployConfig(c)).not.toThrow();
    c.roles = Array.from({ length: 17 }, () => ({ ...c.roles[0] }));
    expect(() => validateOrgDeployConfig(c)).toThrow('1–16');
  });
});

it('seeds native task CREATE for configured task creators and preserves other mask bits', () => {
  const c = config(); delete c.taskManagerPerms;
  const resolved = { orgId: ethers.constants.HashZero, metadataHash: ethers.constants.HashZero, registryAddr: ethers.constants.AddressZero,
    deployerAddress: '0x1111111111111111111111111111111111111111', deployerUsername: '', regDeadline: 0, regNonce: 0, regSignature: '0x' };
  expect(buildDeploymentParams(c, resolved)[22]).toEqual([[0], [1]]);
  c.taskManagerPerms = { roleIndices: [0], masks: [2] };
  expect(buildDeploymentParams(c, resolved)[22]).toEqual([[0], [3]]);
  c.taskManagerPerms = { roleIndices: [0, 0], masks: [255, 0] };
  expect(buildDeploymentParams(c, resolved)[22]).toEqual([[0], [1]]);
});
