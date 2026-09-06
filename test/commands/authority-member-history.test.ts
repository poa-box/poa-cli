import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorityUsersFixture } from '../helpers/authority-users';
const mocks = vi.hoisted(() => ({ query: vi.fn(), json: vi.fn(), table: vi.fn() }));
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
vi.mock('../../src/lib/resolve', () => ({ resolveOrgId: async (id: string) => id }));
vi.mock('../../src/lib/output', () => ({ isJsonMode: () => true, json: mocks.json, table: mocks.table }));
import { membersHandler } from '../../src/commands/org/members';
import { rolesHandler } from '../../src/commands/org/roles';
import { refreshAuthorityUsers } from '../../src/lib/authority';

beforeEach(() => vi.clearAllMocks());
describe('CLI authority members and reports', () => {
  it('renders the 101st indexed member correctly even when there are no system memberships', async () => {
    const f = authorityUsersFixture(101);
    f.memberships.splice(101);
    mocks.query.mockImplementation(f.query);
    await membersHandler.handler({ org: f.orgId });
    expect(mocks.json.mock.calls[0][0].members[100]).toMatchObject({ pt: '1.0', tasksCompleted: 9, votesCast: 4 });
  });
  it('renders accurate CLI member metrics beyond 100 and excludes both system contracts', async () => {
    const f = authorityUsersFixture(101);
    mocks.query.mockImplementation(f.query);
    await membersHandler.handler({ org: f.orgId, chain: 100 });
    const result = mocks.json.mock.calls[0][0];
    expect(result.members).toHaveLength(101);
    expect(result.members.find((row: any) => row.address === f.users[100].address)).toMatchObject({
      pt: '1.0', tasksCompleted: 9, votesCast: 4, joined: '1970-01-01',
    });
  });

  it('keeps --all lapsed wallet records without including infrastructure', async () => {
    const f = authorityUsersFixture(1);
    f.memberships[0].isMember = false;
    mocks.query.mockImplementation(f.query);
    await membersHandler.handler({ org: f.orgId, all: true });
    expect(mocks.json.mock.calls[0][0].members).toHaveLength(1);
    expect(mocks.json.mock.calls[0][0].members[0]).toMatchObject({ membershipStatus: 'Inactive', pt: '1.0' });
  });

  it('shows unknown metrics for an authority wallet without an indexed historical User', async () => {
    const f = authorityUsersFixture(1);
    const address = f.wallet(42);
    f.memberships.push(f.membership(address));
    mocks.query.mockImplementation(f.query);
    await membersHandler.handler({ org: f.orgId });
    expect(mocks.json.mock.calls[0][0].members.find((user: any) => user.address === address))
      .toMatchObject({ pt: null, share: null, tasksCompleted: null, votesCast: null, joined: 'unknown', historyIndexed: false });
  });

  it('role wearer lists use complete history and exclude the executor administrative wearer', async () => {
    const f = authorityUsersFixture(1001);
    mocks.query.mockImplementation(f.query);
    await rolesHandler.handler({ org: f.orgId });
    const roles = mocks.json.mock.calls[0][0];
    expect(roles.find((role: any) => role.subjectId === '8').wearerList).toEqual([]);
    expect(roles.find((role: any) => role.subjectId === '7').wearerList.find((user: any) => user.address === f.users[1000].address))
      .toMatchObject({ username: 'member1000', pt: '1.0' });
  });

  it('the shared report refresh preserves full history when its caller fetched only 20 users', async () => {
    const f = authorityUsersFixture(1001);
    mocks.query.mockImplementation(f.query);
    const org = { users: f.users.slice(0, 20) };
    await refreshAuthorityUsers(org, f.orgId, 100);
    expect(org.users).toHaveLength(1001);
    expect(org.users.find(user => user.address === f.users[1000].address)).toMatchObject({
      participationTokenBalance: '1000000000000000000', totalTasksCompleted: '9', totalVotes: '4', firstSeenAt: '100', lastActiveAt: '300', joinMethod: 'QuickJoin',
    });
  });
});
