import { recoverHandler } from './recover';
import { prepareHandler } from './prepare';
import type { Argv } from 'yargs';
import { statusHandler } from './status';
import { allowlistHandler } from './allowlist';
import { buildAllowlistHandler } from './build-allowlist';
import { proposeAllowlistHandler } from './propose-allowlist';
import { checkHandler } from './check';
import { claimsHandler } from './claims';

export function registerZkEmailCommands(yargs: Argv) {
  return yargs
    .command('recover', 'Verify an original email enrollment and prepare recovery-only pointers without activation', recoverHandler.builder, recoverHandler.handler)
    .command('prepare <action>', 'Prepare a bound proof claim, atomic enrollment, or verified whole-list edit locally', prepareHandler.builder, prepareHandler.handler)
    .command('status', 'Module wiring, active allowlist root/CID, and dormancy', statusHandler.builder, statusHandler.handler)
    .command('allowlist', 'List who is invited and which role hats they get', allowlistHandler.builder, allowlistHandler.handler)
    .command('check <identifier>', 'Check whether a domain/address is invited and can still claim', checkHandler.builder, checkHandler.handler)
    .command('claims', 'Who has claimed a role via a ZK Email invite', claimsHandler.builder, claimsHandler.handler)
    .command('build-allowlist', 'Compute an allowlist doc + merkle root, optionally pin to IPFS', buildAllowlistHandler.builder, buildAllowlistHandler.handler)
    .command('propose-allowlist', 'Propose committing an allowlist root + CID (executor-gated)', proposeAllowlistHandler.builder, proposeAllowlistHandler.handler)
    .demandCommand(1, 'Please specify a zkemail action: status, allowlist, check, claims, build-allowlist, or propose-allowlist')
    .epilogue(
      'ZK Email invites let anyone holding a DKIM-signed email from an allowlisted domain or address '
      + 'claim role hats without an invite link. The CLI publishes and inspects '
      + 'allowlists and prepares supplied proofs locally; generating a claim\'s Groth16 proof needs an external circuit prover.'
    );
}
