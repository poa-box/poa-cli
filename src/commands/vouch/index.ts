import type { Argv } from 'yargs';
import { forHandler } from './for';
import { revokeHandler } from './revoke';
import { claimHandler } from './claim';
import { listHandler } from './list';
import { statusHandler } from './status';
import { resetHandler } from './reset';
import { registerVouchConfigCommands } from './config';

export function registerVouchCommands(yargs: Argv) {
  return yargs
    .command('for', 'Vouch for a user to claim a role', forHandler.builder, forHandler.handler)
    .command('revoke', 'Revoke a vouch', revokeHandler.builder, revokeHandler.handler)
    .command('claim', 'Claim a role after receiving enough vouches', claimHandler.builder, claimHandler.handler)
    .command('list', 'List active vouches for an org', listHandler.builder, listHandler.handler)
    .command('status', 'Check vouch status for a user and role (plus your own daily quota)', statusHandler.builder, statusHandler.handler)
    .command('config <sub>', 'Show or set a hat\'s vouching config (show / set; set is superAdmin-only)', registerVouchConfigCommands)
    .command('reset', 'Reset vouches for a hat or one wearer (superAdmin-only, destructive)', resetHandler.builder, resetHandler.handler)
    .demandCommand(1, 'Please specify a vouch action')
    .example('pop vouch for --address 0xabc... --hat 123', 'Vouch for a member')
    .example('pop vouch config show --hat 123', 'Inspect a hat\'s vouching setup')
    .epilogue('Guide: see docs/guides/membership-roles-vouching.md');
}
