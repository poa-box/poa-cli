import { OrgUser, AuthorityOnlyOrgUser, IndexedOrgUser, isIndexedOrgUser } from '../../../../src/reads/user';

export function nullableActivity(user: OrgUser): number | undefined {
  // The old declaration incorrectly allowed this without a presence check.
  // @ts-expect-error an authority-only row has no assigned-task relation
  const unsafe: number = user.assignedTasks.length;
  void unsafe;
  return user.assignedTasks?.length;
}
export function indexedActivity(user: OrgUser): number | undefined {
  if (isIndexedOrgUser(user)) {
    const indexed: IndexedOrgUser = user;
    return indexed.assignedTasks.length + indexed.completedTasks.length
      + indexed.hybridProposalsCreated.length + indexed.modulesCompleted.length;
  }
  return undefined;
}
export const missing: AuthorityOnlyOrgUser = {
  id: 'org-account', address: '0x0000000000000000000000000000000000000001',
  historyIndexed: false, membershipStatus: 'Active', currentHatIds: ['7'],
  participationTokenBalance: null, totalTasksCompleted: null, totalVotes: null,
  totalModulesCompleted: null, firstSeenAt: null, lastActiveAt: null, joinMethod: null,
};
// A historical row may have fetched metrics without fetching its capped profile relations.
export const sparse: OrgUser = { ...missing, historyIndexed: true, participationTokenBalance: '0', totalVotes: '0' };
