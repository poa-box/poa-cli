import { ethers } from 'ethers';
import { FETCH_ORG_FULL_DATA } from '../../queries/org';
import { query } from '../../lib/subgraph';
import type { Argv } from 'yargs';
import { readAuthorityRows, FETCH_AUTHORITY_SUBJECTS, FETCH_AUTHORITY_MEMBERSHIPS } from '@poa-box/core/reads/authority';
import { resolveOrgId } from '../../lib/resolve';
import { subgraphModuleClient } from '../../lib/subgraph-module-client';
import * as output from '../../lib/output';
export const rolesHandler = {
  builder: (y: Argv) => y,
  handler: async (argv: any) => {
    const orgId = await resolveOrgId(argv.org, argv.chain);
    const subjects = await readAuthorityRows(subgraphModuleClient(), orgId, FETCH_AUTHORITY_SUBJECTS, 'subjects', argv.chain);
    const [memberships, historical] = await Promise.all([
      readAuthorityRows(subgraphModuleClient(), orgId, FETCH_AUTHORITY_MEMBERSHIPS, 'subjectMemberships', argv.chain),
      query<any>(FETCH_ORG_FULL_DATA, { orgId }, argv.chain),
    ]);
    const roles = subjects.map(s => {
      const memberIds = new Set((s.kind === 'Group' ? s.memberRoles.map((r: any) => r.role.id) : [s.id]));
      const wearerIds = new Set(memberships.filter(m => m.isMember && memberIds.has(m.subject.id)).map(m => m.user));
      const wearerList = [...wearerIds].map(address => {
        const user = historical.organization?.users?.find((u: any) => u.address.toLowerCase() === address.toLowerCase());
        return { address, username: user?.account?.username ?? null, pt: ethers.utils.formatEther(user?.participationTokenBalance ?? 0) };
      });
      return { hatId: s.subjectId, name: s.name ?? 'Unnamed',
        canVote: historical.organization?.roles?.find((r: any) => r.hatId === s.subjectId)?.canVote ?? false,
        canVoteSource: 'historical role metadata', vouchRequired: Number(s.vouchConfig?.quorum ?? 0) > 0, vouchQuorum: String(s.vouchConfig?.quorum ?? 0),
        wearers: wearerList.length, wearerList, subjectId: s.subjectId, kind: s.kind,
        maxMembers: s.maxMembers, defaultAllow: s.defaultAllow, managerConfig: s.managerConfig };
    });
    if (output.isJsonMode()) output.json(roles);
    else output.table(['Subject ID', 'Name', 'Kind', 'Members'], subjects.map(s => [s.subjectId, s.name ?? '', s.kind, String(s.activeMemberCount)]));
  },
};
