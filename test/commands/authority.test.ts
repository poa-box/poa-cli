import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { AUTHORITY_KEYS, permissionKey, permissionWord, projectContext, buildAuthorityAction, EXISTS_BIT, INHERIT_GLOBAL_BIT } from '../../packages/core/src/tx/authority';
import { isAuthorityReady, projectAuthorityUsers, readAuthorityRows, FETCH_AUTHORITY_MEMBERSHIPS } from '../../packages/core/src/reads/authority';
import { resolveOrgId, resolveOrgModules } from '../../packages/core/src/reads/resolve';
import { buildCliTree } from '../../scripts/lib/cli-tree';
import { safetyFor } from '../../scripts/lib/safety-map';

const authority = '0x1111111111111111111111111111111111111111';
const user = '0x2222222222222222222222222222222222222222';
const id = `0x${'ab'.repeat(32)}`;
const ready = { id, name: 'Future native organization', membershipAuthority: { id: authority, isRouterBound: true, cutoverAt: '100' } };

describe('authority readiness and history continuity', () => {
  it('accepts migrated and future native orgs without a name allowlist or router event requirement', () => {
    expect(isAuthorityReady(ready)).toBe(true);
    expect(isAuthorityReady({ ...ready, membershipAuthority: { ...ready.membershipAuthority, paused: true } } as any)).toBe(true);
  });
  it('rejects legacy, seeded-but-unbound, rolled-back, zero-address and missing cutover states', () => {
    for (const row of [null, {}, { membershipAuthority: null },
      { membershipAuthority: { ...ready.membershipAuthority, isRouterBound: false } },
      { membershipAuthority: { ...ready.membershipAuthority, cutoverAt: null } },
      { membershipAuthority: { ...ready.membershipAuthority, cutoverAt: '0' } },
      { membershipAuthority: { ...ready.membershipAuthority, id: ethers.constants.AddressZero } },
      { membershipAuthority: { ...ready.membershipAuthority, id: 'garbage' } },
    ]) expect(isAuthorityReady(row)).toBe(false);
  });
  it('hex IDs cannot bypass the retirement check', async () => {
    const query = vi.fn().mockResolvedValue({ organization: { id, membershipAuthority: null } });
    await expect(resolveOrgId({ query } as any, id)).rejects.toThrow('retired');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('membershipAuthority'), { id }, undefined);
  });
  it('names cannot bypass the check and supported org IDs stay byte-identical', async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ organizations: [{ id, membershipAuthority: null }] }).mockResolvedValueOnce({ organizations: [ready] }) } as any;
    await expect(resolveOrgId(client, 'Argus')).rejects.toThrow('retired');
    await expect(resolveOrgId(client, 'Future native organization')).resolves.toBe(id);
  });
  it('resolves authority and keeps the original task/token/proposal addresses', async () => {
    const org = { ...ready, taskManager: { id: user }, participationToken: { id: user }, hybridVoting: { id: user } };
    const client = { query: vi.fn().mockResolvedValue({ organization: org }) } as any;
    const modules = await resolveOrgModules(client, id);
    expect(modules).toMatchObject({ orgId: id, membershipAuthorityAddress: authority, taskManagerAddress: user, participationTokenAddress: user, hybridVotingAddress: user });
    expect(modules).not.toHaveProperty('eligibilityModuleAddress');
  });
  it('paginates all memberships without rewriting adopted IDs or timestamps', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `member-${String(i).padStart(4, '0')}`, acceptedAt: '1' }));
    const historic = { id: 'member-1000', acceptedAt: '123', subject: { subjectId: ethers.BigNumber.from(1).shl(224).toString() } };
    const client = { query: vi.fn().mockResolvedValueOnce({ subjectMemberships: page }).mockResolvedValueOnce({ subjectMemberships: [historic] }) } as any;
    const rows = await readAuthorityRows(client, id, FETCH_AUTHORITY_MEMBERSHIPS, 'subjectMemberships');
    expect(rows).toHaveLength(1001); expect(rows[1000]).toEqual(historic);
    expect(client.query.mock.calls[1][1].lastId).toBe('member-0999');
  });
});

describe('authority calldata and permission semantics', () => {
  it('encodes native role/vouch lifecycle with subject first, user second', () => {
    const intent = buildAuthorityAction({ authorityAddress: authority, method: 'vouch', args: ['123', user] });
    const data = new ethers.utils.Interface(intent.abi).encodeFunctionData(intent.method, intent.args);
    const native = new ethers.utils.Interface(['function vouch(uint256,address)']);
    expect(data).toBe(native.encodeFunctionData('vouch', ['123', user]));
    expect(intent.to).toBe(authority);
  });
  it('excludes legacy mint and migration seed writes', () => {
    for (const method of ['mintHat', 'seedSubjects', 'createHatWithEligibility']) {
      expect(() => buildAuthorityAction({ authorityAddress: authority, method: method as any, args: [] })).toThrow('Unsupported');
    }
  });
  it('matches the Solidity fold-tag derivation and project zero offset', () => {
    expect(AUTHORITY_KEYS.TM_PERMS).toBe(`0x01${ethers.utils.id('poa.perm.tm.perms').slice(2, 64)}`);
    expect(permissionKey('poa.perm.dd.vote')).toBe(`0x00${ethers.utils.id('poa.perm.dd.vote').slice(2, 64)}`);
    expect(projectContext(0)).toBe(ethers.utils.hexZeroPad('0x01', 32));
    expect(permissionWord(0).eq(EXISTS_BIT)).toBe(true);
    expect(permissionWord(3, true).eq(EXISTS_BIT.or(INHERIT_GLOBAL_BIT).or(3))).toBe(true);
    expect(() => permissionWord(ethers.BigNumber.from(1).shl(254))).toThrow();
  });
  it('removes old commands and marks every new authority mutation as a write', () => {
    const tree = buildCliTree();
    const names = tree.flatMap(d => d.commands.map(c => c.fullName));
    expect(names).not.toContain('pop user claim-hats');
    expect(names).not.toContain('pop role apply');
    expect(names).not.toContain('pop role admin');
    for (const name of ['role create', 'role grant', 'role delegate-remove', 'group create', 'vouch for']) expect(safetyFor(name).broadcasts).toBe(true);
  });
});

it('current membership projection preserves V1 balances and history and includes newly indexed members', () => {
  const historic = { address: authority, participationTokenBalance: '42', firstSeenAt: '1', membershipStatus: 'Active', totalTasksCompleted: '8' };
  const rows = projectAuthorityUsers([historic], [
    { user: authority, subject: { kind: 'Role', subjectId: '100' }, isMember: false },
    { user, userUsername: 'new', acceptedAt: '999', subject: { kind: 'Role', subjectId: '101' }, isMember: true },
  ]);
  expect(rows[0]).toMatchObject({ ...historic, membershipStatus: 'Inactive', currentHatIds: [] });
  expect(rows[1]).toMatchObject({ address: user, membershipStatus: 'Active', currentHatIds: ['101'], account: { username: 'new' } });
});

it('project address managers survive while the four retired permission arrays reject configuration', async () => {
  const { encodeProjectStruct } = await import('../../packages/core/src/tx/project');
  expect(encodeProjectStruct({ taskManagerAddress: authority, name: 'Project', managers: [user] })[3]).toEqual([user]);
  for (const key of ['createHats', 'claimHats', 'reviewHats', 'assignHats']) {
    expect(() => encodeProjectStruct({ taskManagerAddress: authority, name: 'Project', [key]: ['123'] })).toThrow('permission arrays');
  }
});
it('resolved SDK project permission intent routes through the org executor proposal', async () => {
  const { setProjectRolePermIntent } = await import('../../packages/core/src/tx/task');
  const org = { ...ready, hybridVoting: { id: user }, taskManager: { id: user } };
  const client = { query: vi.fn().mockResolvedValue({ organization: org }) };
  const intent = await setProjectRolePermIntent({ client } as any, { org: id, project: ethers.constants.HashZero, hat: '123', perms: 'claim', inheritGlobal: true });
  expect(intent.to).toBe(user); expect(intent.method).toBe('createProposal');
  const call = (intent.args[4] as any)[0][0];
  expect(call[0]).toBe(authority);
  const native = new ethers.utils.Interface(['function setPerm(uint256,bytes32,bytes32,uint256)']);
  const decoded = native.decodeFunctionData('setPerm', call[2]);
  expect(decoded[2]).toBe(projectContext(0)); expect(decoded[3].eq(permissionWord(2, true))).toBe(true);
});
