import type { Argv } from 'yargs';
import { registerHandler } from './register';
import { joinHandler } from './join';
import { profileHandler } from './profile';
import { updateProfileHandler } from './update-profile';
import { whoamiHandler } from './whoami';

export function registerUserCommands(yargs: Argv) {
  return yargs
    .command('register', 'Register a username on the account registry', registerHandler.builder, registerHandler.handler)
    .command('join', 'Join an organization (registers your username first if needed)', joinHandler.builder, joinHandler.handler)
    .command('whoami', 'Show signer identity: address, username, gas balance, and org standing', whoamiHandler.builder, whoamiHandler.handler)
    .command('profile', 'View user profile', profileHandler.builder, profileHandler.handler)
    .command('update-profile', 'Update profile (bio, avatar, links) or change your username', updateProfileHandler.builder, updateProfileHandler.handler)
    .demandCommand(1, 'Please specify a user action')
    .example('pop user whoami', 'Who is the configured signer and where do they stand?')
    .epilogue('Guide: see docs/guides/membership-roles-vouching.md');
}
