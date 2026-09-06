import { describe, expect, it } from 'vitest';
import { readAuthorityUsers } from '../src/reads/authority';
import { listMembers, listRoles } from '../src/reads/org';
import { authorityUsersFixture } from '../../../test/helpers/authority-users';

describe('authority user history and infrastructure identities', () => {
  it('does not zero an indexed member beyond the historical first 100 even without any system memberships', async () => {
    const f = authorityUsersFixture(101);
    f.memberships.splice(101);
    const result = await listMembers({ query: f.query } as any, f.orgId);
    expect(result!.users).toHaveLength(101);
    expect(result!.users[100]).toMatchObject({ participationTokenBalance: '1000000000000000000', totalTasksCompleted: '9', totalVotes: '4', firstSeenAt: '100' });
  });
  it.each([101, 1000, 1001])('preserves every member and original history for %i indexed users', async count => {
    const f = authorityUsersFixture(count);
    const result = await listMembers({ query: f.query } as any, f.orgId, 100);
    expect(result!.users).toHaveLength(count);
    for (const user of f.users) expect(result!.users.find(row => row.address === user.address)).toMatchObject({
      participationTokenBalance: user.participationTokenBalance,
      totalTasksCompleted: '9', totalVotes: '4', firstSeenAt: '100', lastActiveAt: '300', membershipStatus: 'Active',
    });
    expect(f.calls.filter(call => call.document.includes('AuthorityUserHistory'))).toHaveLength(Math.floor(count / 1000) + 1);
  });

  it('filters only configured system addresses, merges mixed-case wallets, and preserves richer caller fields', async () => {
    const f = authorityUsersFixture(1);
    const extra = f.wallet(42);
    f.memberships.push(f.membership(extra, '8')); // A legitimate wallet wearing an admin subject is still a user.
    f.memberships.push(f.membership(f.users[0].address.toUpperCase().replace('0X', '0x'), '9'));
    const result = await readAuthorityUsers({ query: f.query } as any, f.orgId,
      [{ ...f.users[0], account: { username: 'oldname', metadata: { avatar: 'ipfs://avatar' } }, assignedTasks: [{ taskId: '55' }], totalTasksReleased: '3' }, { address: f.executor }], 100);
    expect(result.map(row => row.address.toLowerCase())).toEqual([f.users[0].address, extra]);
    expect(result[0]).toMatchObject({ currentHatIds: ['7', '9'], firstSeenAt: '100', assignedTasks: [{ taskId: '55' }], totalTasksReleased: '3',
      account: { username: 'member0', metadata: { avatar: 'ipfs://avatar' } } });
    expect(result[1]).toMatchObject({ membershipStatus: 'Active', historyIndexed: false, firstSeenAt: null });
  });

  it('respects a canonical null account instead of restoring a stale profile', async () => {
    const f = authorityUsersFixture(1);
    const original = { ...f.users[0], account: { username: 'deleted', metadata: { avatar: 'old' } } };
    f.users[0].account = null as any;
    const result = await readAuthorityUsers({ query: f.query } as any, f.orgId, [original]);
    expect(result[0].account).toBeNull();
  });

  it('role projections retain balances beyond the caller history limit without restoring system users', async () => {
    const f = authorityUsersFixture(1001);
    const result = await listRoles({ query: f.query } as any, f.orgId);
    expect(result.data.organization!.users).toHaveLength(1001);
    expect(result.data.organization!.users.find(user => user.address === f.users[1000].address))
      .toMatchObject({ participationTokenBalance: '1000000000000000000', currentHatIds: ['7'] });
  });

  it('preserves top-holder ordering when the caller passed history in a different order', async () => {
    const f = authorityUsersFixture(101);
    const result = await readAuthorityUsers({ query: f.query } as any, f.orgId, [...f.users].reverse());
    expect(result.map(user => user.address)).toEqual(f.users.map(user => user.address));
  });

  it('rejects an incomplete history response instead of synthesizing zeros', async () => {
    const f = authorityUsersFixture(1);
    const query = async (document: string, variables: any) => document.includes('AuthorityUserHistory')
      ? { organization: {} } : f.query(document, variables);
    await expect(readAuthorityUsers({ query } as any, f.orgId, [])).rejects.toThrow('history is unavailable');
  });

  it('rejects a history cursor that stops advancing', async () => {
    const f = authorityUsersFixture(1000);
    const query = async (document: string, variables: any) => document.includes('AuthorityUserHistory')
      ? { organization: f.organization, users: f.users } : f.query(document, variables);
    await expect(readAuthorityUsers({ query } as any, f.orgId, [])).rejects.toThrow('history pagination did not advance');
  });
});
