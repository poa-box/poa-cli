import { ethers } from 'ethers';
import { FETCH_MEMBERS } from '@poa-box/core/reads/org';
import { query } from '../../lib/subgraph';
import type { Argv } from 'yargs';
import { readAuthorityUsers } from '@poa-box/core/reads/authority';
import { resolveOrgId } from '../../lib/resolve';
import { subgraphModuleClient } from '../../lib/subgraph-module-client';
import * as output from '../../lib/output';
export const membersHandler = {
  builder: (y: Argv) => y.option('all', { type: 'boolean', default: false, describe: 'Include lapsed or unaccepted membership records' }),
  handler: async (argv: any) => {
    const orgId = await resolveOrgId(argv.org, argv.chain);
    const [users, history] = await Promise.all([
      readAuthorityUsers(subgraphModuleClient(), orgId, [], argv.chain),
      query<any>(FETCH_MEMBERS, { orgId }, argv.chain),
    ]);
    const totalSupply = ethers.BigNumber.from(history.organization?.participationToken?.totalSupply ?? 0);
    const members = users.filter(user => argv.all ? user.subjects.length > 0 : user.membershipStatus === 'Active').map(member => {
      const pt = member.participationTokenBalance == null ? null : ethers.BigNumber.from(member.participationTokenBalance);
      return { ...member, username: member.account?.username ?? null,
        subjects: member.subjects.filter((row: any) => argv.all || row.isMember),
        pt: pt === null ? null : ethers.utils.formatEther(pt), share: pt === null ? null : `${(totalSupply.gt(0) ? pt.mul(10000).div(totalSupply).toNumber() / 100 : 0).toFixed(1)}%`,
        tasksCompleted: member.totalTasksCompleted == null ? null : Number(member.totalTasksCompleted), votesCast: member.totalVotes == null ? null : Number(member.totalVotes),
        joined: member.firstSeenAt ? new Date(Number(member.firstSeenAt) * 1000).toISOString().split('T')[0] : 'unknown' };
    });
    if (output.isJsonMode()) output.json({ totalSupply: ethers.utils.formatEther(totalSupply), orgId, members, source: 'membership-authority' });
    else output.table(['Address', 'Username', 'Status', 'Roles'], members.map(m => [m.address, m.username ?? '', m.membershipStatus, m.currentHatIds.join(', ')]));
  },
};
