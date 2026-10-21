import { prepareHandler } from './prepare';
import { lookupHandler, credentialsHandler } from './lookup';
import type { Argv } from 'yargs';
import { registerHandler } from './register';
import { joinHandler } from './join';
import { profileHandler } from './profile';
import { updateProfileHandler } from './update-profile';
import { whoamiHandler } from './whoami';

export function registerUserCommands(yargs: Argv) {
  return yargs
    .command('prepare <action>', 'Prepare an enrollment challenge, atomic enrollment calldata, or profile document locally', prepareHandler.builder, prepareHandler.handler)
    .command('lookup', 'Read source-qualified identities from explicit registries', lookupHandler.builder, lookupHandler.handler)
    .command('credentials', 'Read indexed active and revoked credentials with explicit unknown key facts', credentialsHandler.builder, credentialsHandler.handler)
    .command('register', 'Register a username on the account registry', registerHandler.builder, registerHandler.handler)
    .command('join', 'Join an organization (registers your username first if needed)', joinHandler.builder, joinHandler.handler)
    .command('whoami', 'Show signer identity: address, username, gas balance, and org standing', whoamiHandler.builder, whoamiHandler.handler)
    .command('profile', 'View user profile', profileHandler.builder, profileHandler.handler)
    .command('update-profile', 'Update profile (bio, avatar, links) or change your username', updateProfileHandler.builder, updateProfileHandler.handler)
    .demandCommand(1, 'Please specify a user action')
    .example('pop user whoami', 'Who is the configured signer and where do they stand?')
    .epilogue('Guide: see docs/guides/membership-roles-vouching.md');
}
