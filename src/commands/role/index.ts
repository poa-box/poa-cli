import type { Argv } from 'yargs';
import { applyHandler } from './apply';
import { applicationsHandler } from './applications';
import { withdrawApplicationHandler } from './withdraw-application';
import { createHandler } from './create';
import { registerEligibilityCommands } from './eligibility';
import { registerRoleAdminCommands } from './admin';

export function registerRoleCommands(yargs: Argv) {
  return yargs
    .command('apply', 'Apply for a role', applyHandler.builder, applyHandler.handler)
    .command('applications', 'List role applications', applicationsHandler.builder, applicationsHandler.handler)
    .command('withdraw-application', 'Withdraw your pending role application', withdrawApplicationHandler.builder, withdrawApplicationHandler.handler)
    .command('create', 'Create a new role hat (superAdmin-only)', createHandler.builder, createHandler.handler)
    .command('eligibility <sub>', 'Manage wearer/default eligibility (set / clear / set-default; superAdmin-only)', registerEligibilityCommands)
    .command('admin <sub>', 'Module superAdmin operations (transfer / mint / pause / unpause / set-join-time)', registerRoleAdminCommands)
    .demandCommand(1, 'Please specify a role action')
    .example('pop role apply --hat 123 --notes "Active since March"', 'Apply for a vouching-gated role')
    .example('pop role create --parent-hat 123 --name "Reviewer"', 'Create a new role hat (superAdmin)')
    .epilogue('Guide: see docs/guides/membership-roles-vouching.md');
}
