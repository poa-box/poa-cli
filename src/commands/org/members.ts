import { ethers } from 'ethers';
import { FETCH_MEMBERS } from '@poa-box/core/reads/org';
import { query } from '../../lib/subgraph';
import type { Argv } from 'yargs';
import { readAuthorityRows, FETCH_AUTHORITY_MEMBERSHIPS } from '@poa-box/core/reads/authority';
import { resolveOrgId } from '../../lib/resolve';
import { subgraphModuleClient } from '../../lib/subgraph-module-client';
import * as output from '../../lib/output';
export const membersHandler = {
  builder: (y: Argv) => y.option('all', { type: 'boolean', default: false, describe: 'Include lapsed or unaccepted membership records' }),
  handler: async (argv: any) => {
    const orgId = await resolveOrgId(argv.org, argv.chain);
    const rows = await readAuthorityRows(subgraphModuleClient(), orgId, FETCH_AUTHORITY_MEMBERSHIPS, 'subjectMemberships', argv.chain);
    const byUser = new Map<string, any>();
    for (const row of rows.filter(m => argv.all || m.isMember)) {
      const member = byUser.get(row.user) ?? { address: row.user, username: row.userUsername, currentHatIds: [], subjects: [], membershipStatus: 'Inactive' };
      if (row.isMember) { member.currentHatIds.push(row.subject.subjectId); member.membershipStatus = 'Active'; }
      member.subjects.push(row); byUser.set(row.user, member);
    }
    const history = await query<any>(FETCH_MEMBERS, { orgId }, argv.chain);
    const totalSupply = ethers.BigNumber.from(history.organization?.participationToken?.totalSupply ?? 0);
    const members = [...byUser.values()].map(member => {
      const row = history.organization?.users?.find((u: any) => u.address.toLowerCase() === member.address.toLowerCase());
      const pt = ethers.BigNumber.from(row?.participationTokenBalance ?? 0);
      return { ...member, username: row?.account?.username ?? member.username,
        pt: ethers.utils.formatEther(pt), share: `${(totalSupply.gt(0) ? pt.mul(10000).div(totalSupply).toNumber() / 100 : 0).toFixed(1)}%`,
        tasksCompleted: Number(row?.totalTasksCompleted ?? 0), votesCast: Number(row?.totalVotes ?? 0),
        joined: row?.firstSeenAt ? new Date(Number(row.firstSeenAt) * 1000).toISOString().split('T')[0] : 'unknown' };
    });
    if (output.isJsonMode()) output.json({ totalSupply: ethers.utils.formatEther(totalSupply), orgId, members, source: 'membership-authority' });
    else output.table(['Address', 'Username', 'Status', 'Roles'], members.map(m => [m.address, m.username ?? '', m.membershipStatus, m.currentHatIds.join(', ')]));
  },
};
