import { describe, expect, it, vi } from 'vitest';
import { getOrganization, listUserOrganizations } from '../src/reads/org';
import { getWhoamiOrgData } from '../src/reads/user';
import { authorityUsersFixture } from '../../../test/helpers/authority-users';

describe('authority identity reads', () => {
  it('returns current org members and renamed subjects instead of historical membership snapshots', async () => {
    const f = authorityUsersFixture(1);
    f.memberships[0].isMember = false;
    const org = await getOrganization({ query: f.query } as any, f.orgId);
    expect(org!.users[0]).toMatchObject({ membershipStatus: 'Inactive', currentHatIds: [], participationTokenBalance: f.users[0].participationTokenBalance });
    expect(org!.roles[0]).toMatchObject({ hatId: '7', subjectId: '7', canVoteSource: 'historical role metadata' });
  });

  it('shows authoritative whoami membership when historical User has not been indexed', async () => {
    const f = authorityUsersFixture(1);
    const query = async (document: string, variables: any) => document.includes('WhoamiOrgData')
      ? { organization: { id: f.orgId }, user: null, account: null, tokenRequests: [] }
      : f.query(document, variables);
    const result = await getWhoamiOrgData({ query } as any, { orgId: f.orgId, address: f.users[0].address });
    expect(result!.user).toMatchObject({ id: `${f.orgId}-${f.users[0].address}`, membershipStatus: 'Active',
      currentHatIds: ['7'], historyIndexed: false, participationTokenBalance: null });
  });

  it('joins paginated memberships to the exact historical user without a capped independent history query', async () => {
    const f = authorityUsersFixture(1);
    const memberships = Array.from({ length: 1001 }, (_, i) => ({
      id: String(i).padStart(4, '0'), organization: { ...f.organization, id: String(i) },
      userEntity: i === 1000 ? null : { id: `user${i}`, participationTokenBalance: String(i + 10), totalTasksCompleted: '3', totalVotes: '5' },
    }));
    const query = vi.fn(async (_doc: string, variables: any) => ({
      subjectMemberships: memberships.filter(row => row.id > variables.lastId).slice(0, 1000),
    }));
    const result = await listUserOrganizations({ query } as any, f.users[0].address);
    expect(query).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1001);
    expect(result[999]).toMatchObject({ participationTokenBalance: '1009', totalTasksCompleted: '3', totalVotes: '5', historyIndexed: true });
    expect(result[1000]).toMatchObject({ participationTokenBalance: null, totalTasksCompleted: null, totalVotes: null, historyIndexed: false });
  });
});
