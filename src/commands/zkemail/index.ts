import type { Argv } from 'yargs';
import { statusHandler } from './status';
import { allowlistHandler } from './allowlist';
import { buildAllowlistHandler } from './build-allowlist';
import { proposeAllowlistHandler } from './propose-allowlist';
import { checkHandler } from './check';
import { claimsHandler } from './claims';

export function registerZkEmailCommands(yargs: Argv) {
  return yargs
    .command('status', 'Module wiring, active allowlist root/CID, and dormancy', statusHandler.builder, statusHandler.handler)
    .command('allowlist', 'List who is invited and which role hats they get', allowlistHandler.builder, allowlistHandler.handler)
    .command('check <identifier>', 'Check whether a domain/address is invited and can still claim', checkHandler.builder, checkHandler.handler)
    .command('claims', 'Who has claimed a role via a ZK Email invite', claimsHandler.builder, claimsHandler.handler)
    .command('build-allowlist', 'Compute an allowlist doc + merkle root, optionally pin to IPFS', buildAllowlistHandler.builder, buildAllowlistHandler.handler)
    .command('propose-allowlist', 'Propose committing an allowlist root + CID (executor-gated)', proposeAllowlistHandler.builder, proposeAllowlistHandler.handler)
    .demandCommand(1, 'Please specify a zkemail action: status, allowlist, check, claims, build-allowlist, or propose-allowlist')
    .epilogue(
      'ZK Email invites let anyone holding a DKIM-signed email from an allowlisted domain or address '
      + 'claim role hats without an invite link. The CLI covers the admin half (publish and inspect '
      + 'allowlists); generating a claim\'s Groth16 proof needs the circuit witness and runs in the browser.'
    );
}
