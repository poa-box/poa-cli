import { ethers } from 'ethers';
import { FETCH_ORG_FULL_DATA } from '../../queries/org';
import { query } from '../../lib/subgraph';
import type { Argv } from 'yargs';
import { readAuthorityRows, FETCH_AUTHORITY_SUBJECTS, readAuthorityUsers } from '@poa-box/core/reads/authority';
import { resolveOrgId } from '../../lib/resolve';
import { subgraphModuleClient } from '../../lib/subgraph-module-client';
import * as output from '../../lib/output';
export const rolesHandler = {
  builder: (y: Argv) => y,
  handler: async (argv: any) => {
    const orgId = await resolveOrgId(argv.org, argv.chain);
    const subjects = await readAuthorityRows(subgraphModuleClient(), orgId, FETCH_AUTHORITY_SUBJECTS, 'subjects', argv.chain);
    const [users, historical] = await Promise.all([
      readAuthorityUsers(subgraphModuleClient(), orgId, [], argv.chain),
      query<any>(FETCH_ORG_FULL_DATA, { orgId }, argv.chain),
    ]);
    const roles = subjects.map(s => {
      const memberIds = new Set((s.kind === 'Group' ? s.memberRoles.map((r: any) => r.role.id) : [s.id]));
      const wearerList = users.filter(user => user.subjects.some((membership: any) => membership.isMember && memberIds.has(membership.subject.id)))
        .map(user => ({ address: user.address, username: user.account?.username ?? null,
          pt: user.participationTokenBalance == null ? null : ethers.utils.formatEther(user.participationTokenBalance), historyIndexed: user.historyIndexed }));
      return { hatId: s.subjectId, name: s.name ?? 'Unnamed',
        canVote: historical.organization?.roles?.find((r: any) => r.hatId === s.subjectId)?.canVote ?? false,
        canVoteSource: 'historical role metadata', vouchRequired: Number(s.vouchConfig?.quorum ?? 0) > 0, vouchQuorum: String(s.vouchConfig?.quorum ?? 0),
        wearers: wearerList.length, wearerList, subjectId: s.subjectId, kind: s.kind,
        maxMembers: s.maxMembers, defaultAllow: s.defaultAllow, managerConfig: s.managerConfig };
    });
    if (output.isJsonMode()) output.json(roles);
    else output.table(['Subject ID', 'Name', 'Kind', 'Members'], roles.map(role => [role.subjectId, role.name, role.kind, String(role.wearers)]));
  },
};
