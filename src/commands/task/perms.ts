import { PERMS_QUERY_FULL } from '@poa-box/core/reads/task';
import { query } from '../../lib/subgraph';
import type { Argv } from 'yargs';
import { ethers } from 'ethers';
import { AUTHORITY_KEYS, permissionWord, projectContext } from '@poa-box/core/tx/authority';
import { readAuthorityRows, FETCH_AUTHORITY_PERMS } from '@poa-box/core/reads/authority';
import { authorityHandler, subjectOption } from '../role/authority';
import { resolveOrgModules } from '../../lib/resolve';
import { subgraphModuleClient } from '../../lib/subgraph-module-client';
import { parsePermList, formatMask } from '../../lib/perms';
import * as output from '../../lib/output';
export const permsShowHandler = {
  builder: (y: Argv) => y.option('project', { type: 'string', describe: 'Project bytes32 ID' }),
  handler: async (argv: any) => {
    const modules = await resolveOrgModules(argv.org, argv.chain);
    const metadata = await query<any>(PERMS_QUERY_FULL, { orgId: modules.orgId }, argv.chain);
    const rows = (await readAuthorityRows(subgraphModuleClient(), modules.orgId, FETCH_AUTHORITY_PERMS, 'permRows', argv.chain))
      .filter(r => r.permKey.toLowerCase() === AUTHORITY_KEYS.TM_PERMS.toLowerCase() && r.exists);
    const row = (r: any) => ({ hatId: r.subject.subjectId, subjectId: r.subject.subjectId, mask: ethers.BigNumber.from(r.value).and(255).toNumber(), permissions: formatMask(ethers.BigNumber.from(r.value).and(255).toNumber()), inheritGlobal: r.inheritGlobal });
    const global = rows.filter(r => r.ctx === ethers.constants.HashZero).map(row);
    const context = argv.project ? projectContext(argv.project) : null;
    const project = context ? { projectId: argv.project, permissions: rows.filter(r => r.ctx === context).map(row) } : undefined;
    const result = { taskManager: modules.taskManagerAddress, authority: modules.membershipAuthorityAddress, global, project,
      creatorHatIds: metadata.organization?.taskManager?.creatorHatIds ?? [], organizerHatIds: metadata.organization?.taskManager?.organizerHatIds ?? [], permissionHatIds: global.map(r => r.subjectId), _source: 'membership-authority' };
    if (output.isJsonMode()) output.json(result);
    else output.table(['Subject', 'Permissions', 'Context'], rows.map(r => [r.subject.subjectId, formatMask(ethers.BigNumber.from(r.value).and(255).toNumber()), r.ctx]));
  },
};
export const permsSetHandler = authorityHandler({ method: 'setPerm', governance: true,
  options: { ...subjectOption, project: { type: 'string', demandOption: true, describe: 'Project ID (bytes32); encoded as projectId + 1' }, perms: { type: 'string', demandOption: true }, 'inherit-global': { type: 'boolean', default: false } },
  args: a => [a.subject, AUTHORITY_KEYS.TM_PERMS, projectContext(a.project), permissionWord(parsePermList(a.perms), a.inheritGlobal)] });
export const permsProposeGlobalHandler = authorityHandler({ method: 'setPerm', governance: true,
  options: { ...subjectOption, perms: { type: 'string', demandOption: true } },
  args: a => [a.subject, AUTHORITY_KEYS.TM_PERMS, ethers.constants.HashZero, permissionWord(parsePermList(a.perms))] });
export const permsClearHandler = authorityHandler({ method: 'clearPerm', governance: true,
  options: { ...subjectOption, project: { type: 'string', describe: 'Project ID (omit to clear global permissions)' } },
  args: a => [a.subject, AUTHORITY_KEYS.TM_PERMS, a.project ? projectContext(a.project) : ethers.constants.HashZero] });
export function registerPermsCommands(y: Argv) {
  return y.command('show', 'Show authority task permissions', permsShowHandler.builder, permsShowHandler.handler)
    .command('set', 'Propose a project task permission row', permsSetHandler.builder, permsSetHandler.handler)
    .command('clear', 'Propose clearing a permission row (restores inheritance for project rows)', permsClearHandler.builder, permsClearHandler.handler)
    .command('propose-global', 'Propose an org-wide task permission row', permsProposeGlobalHandler.builder, permsProposeGlobalHandler.handler)
    .demandCommand(1);
}
