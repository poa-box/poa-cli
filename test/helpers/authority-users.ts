/** Indexed history fixture with the real query limits; no RPC or publication. */
export function authorityUsersFixture(count = 101) {
  const orgId = `0x${'ab'.repeat(32)}`;
  const executor = `0x${'ee'.repeat(20)}`;
  const eligibility = `0x${'dd'.repeat(20)}`;
  const wallet = (i: number) => `0x${(i + 1000).toString(16).padStart(40, '0')}`;
  const users = Array.from({ length: count }, (_, i) => ({
    id: `${orgId}-${wallet(i)}`, address: wallet(i), account: { username: `member${i}` },
    participationTokenBalance: `${count - i}000000000000000000`,
    totalTasksCompleted: '9', totalVotes: '4', totalModulesCompleted: '2',
    firstSeenAt: '100', lastActiveAt: '300', joinMethod: 'QuickJoin', membershipStatus: 'Active', currentHatIds: ['7'],
  }));
  const membership = (address: string, subjectId = '7') => ({
    id: `${subjectId}-${address.toLowerCase()}`, user: address, userUsername: null,
    accepted: true, eligible: true, isMember: true, acceptedAt: '200',
    subject: { id: `subject${subjectId}`, subjectId, kind: 'Role', name: 'Member' },
  });
  const memberships = [...users.map(user => membership(user.address)), membership(executor.toUpperCase().replace('0X', '0x'), '8'), membership(eligibility, '9')]
    .sort((a, b) => a.id.localeCompare(b.id));
  const organization = {
    id: orgId, name: 'Fixture org', executorContract: { id: executor }, eligibilityModule: { id: eligibility },
    membershipAuthority: { id: `0x${'11'.repeat(20)}`, isRouterBound: true, cutoverAt: '123' },
    participationToken: { totalSupply: `${count * (count + 1) / 2}000000000000000000` },
    users: users.slice(0, 100), roles: [{ hatId: '7', name: 'Member', canVote: true, isUserRole: true }],
  };
  const calls: Array<{ document: string; variables: any }> = [];
  const query = async (document: string, variables: any = {}) => {
    calls.push({ document, variables });
    if (document.includes('AuthorityUserHistory')) return {
      organization,
      users: users.filter(user => user.id > (variables.lastId || '')).slice(0, 1000),
    };
    if (document.includes('AuthorityMemberships')) return {
      subjectMemberships: memberships.filter(row => row.id > (variables.lastId || '')).slice(0, 1000),
    };
    if (document.includes('AuthoritySubjects')) return { subjects: ['7', '8', '9'].map(subjectId => ({
      id: `subject${subjectId}`, subjectId, name: 'Member', kind: 'Role', memberRoles: [], imageURI: '',
    })) };
    return { organization };
  };
  return { orgId, executor, eligibility, users, memberships, organization, query, calls, membership, wallet };
}
