import type { Argv } from 'yargs';
import { authorityHandler, metadataOptions } from '../role/authority';
export function registerGroupCommands(y: Argv) {
  const create = authorityHandler({ method: 'createGroup', governance: true,
    options: { ...metadataOptions, roles: { type: 'string', array: true, demandOption: true, describe: 'Member role subject IDs' } },
    args: a => [a.name, a.metadataHash, a.image, a.roles] });
  y = y.command('create', 'Propose a group derived from role memberships', create.builder, create.handler);
  for (const [action, method] of [['add-role', 'addRoleToGroup'], ['remove-role', 'removeRoleFromGroup']] as const) {
    const handler = authorityHandler({ method, governance: true,
      options: { group: { type: 'string', demandOption: true }, role: { type: 'string', demandOption: true } }, args: a => [a.role, a.group] });
    y = y.command(action, `Propose ${action} in a group`, handler.builder, handler.handler);
  }
  return y.demandCommand(1);
}
