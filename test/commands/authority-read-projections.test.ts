import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { fetchTaskPerms } from '../../packages/core/src/reads/task';
import { listRoles, listMembers } from '../../packages/core/src/reads/org';
import { AUTHORITY_KEYS, projectContext } from '../../packages/core/src/tx/authority';
const ORG = ethers.constants.HashZero;
const TM = '0x1111111111111111111111111111111111111111';
const AUTH = '0x2222222222222222222222222222222222222222';
const USER = '0x3333333333333333333333333333333333333333';
const READY = { id: AUTH, isRouterBound: true, cutoverAt: '123' };

it('task permissions fold each subject project override and inheritance without legacy grants', async () => {
  const pid = ethers.utils.hexZeroPad('0x00', 32);
  const row = (subjectId: string, value: string, ctx: string, inheritGlobal = false) => ({ id: subjectId + ctx, subject: { subjectId, kind: subjectId === '3' ? 'Group' : 'Role' }, permKey: AUTHORITY_KEYS.TM_PERMS, value, ctx, exists: true, inheritGlobal });
  const client = { query: vi.fn(async (document: string) => document.includes('TaskPermsFull') ? {
    organization: { id: ORG, membershipAuthority: READY, taskManager: { id: TM, projects: [{ id: TM + '-' + pid, title: 'Zero' }] } },
  } : { permRows: [
    row('1', '255', ethers.constants.HashZero), row('1', '0', projectContext(pid)),
    row('2', '1', ethers.constants.HashZero), row('2', '2', projectContext(pid), true),
    row('3', '4', ethers.constants.HashZero),
  ] }) } as any;
  const { data, tierIndex } = await fetchTaskPerms(client, ORG);
  expect(tierIndex).toBe(0);
  expect(data.organization!.taskManager!.projects[0].rolePermissions).toEqual([
    { hatId: '1', subjectId: '1', mask: 0 },
    { hatId: '2', subjectId: '2', mask: 3 },
    { hatId: '3', subjectId: '3', mask: 4 },
  ]);
  expect(client.query.mock.calls.map((c: any[]) => c[0]).join(' ')).not.toContain('globalRolePermissions');
});

it('retired org permission reads do not fall back to legacy masks', async () => {
  const client = { query: vi.fn().mockResolvedValue({ organization: { id: ORG, membershipAuthority: null } }) } as any;
  expect((await fetchTaskPerms(client, ORG)).data.organization).toBeNull();
  expect(client.query).toHaveBeenCalledTimes(1);
});

it('roles derive active subject memberships while retaining user history rows', async () => {
  const client = { query: vi.fn(async (document: string) => {
    if (document.includes('AuthorityRoleContext')) return { organization: { membershipAuthority: READY,
      roles: [{ hatId: '1', canVote: true, isUserRole: true }],
      users: [{ address: USER, participationTokenBalance: '12', account: null }],
    } };
    if (document.includes('AuthoritySubjects')) return { subjects: [{ id: '1', subjectId: '1', name: 'Renamed', imageURI: '', kind: 'Role' }] };
    return { subjectMemberships: [{ id: '1-' + USER, user: USER, isMember: false, subject: { subjectId: '1', kind: 'Role' } }] };
  }) } as any;
  const { data } = await listRoles(client, ORG);
  expect(data.organization!.roles[0].name).toBe('Renamed');
  expect(data.organization!.users[0].membershipStatus).toBe('Inactive');
  expect(data.organization!.users[0].currentHatIds).toEqual([]);
  expect(data.organization!.users[0].participationTokenBalance).toBe('12');
  expect(data.organization!.membershipAuthority).toEqual(READY);
});

it('member lists exclude a historical Active User without current authority membership', async () => {
  const client = { query: vi.fn(async (document: string) => {
    if (document.includes('OrgAuthority')) return { organization: { membershipAuthority: READY } };
    if (document.includes('FetchMembers')) return { organization: { participationToken: { totalSupply: '12' }, users: [{ address: USER, membershipStatus: 'Active' }] } };
    return { subjectMemberships: [{ id: '1-' + USER, user: USER, isMember: false, subject: { kind: 'Role' } }] };
  }) } as any;
  expect((await listMembers(client, ORG))!.users).toEqual([]);
});
