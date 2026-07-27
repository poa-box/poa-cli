/**
 * pop user update-profile — profile metadata edits + username changes.
 *
 * Two independent writes on the UniversalAccountRegistry (verified against
 * contracts origin/main src/UniversalAccountRegistry.sol):
 *
 *   changeUsername(newUsername)      — DESTRUCTIVE tier: the old username is
 *     released for anyone to claim the moment the tx lands. Reverts
 *     AccountUnknown without an existing registration and UsernameTaken when
 *     the new name is held — both pre-flighted here (exit 4 before gas).
 *
 *   setProfileMetadata(metadataHash) — standard tier: bio/avatar/links are
 *     read-then-merged from the subgraph so single-flag edits preserve the
 *     other fields, then re-pinned to IPFS.
 *
 * When both are requested, the username tx runs first; finishWrite exits on
 * failure so the metadata tx never runs after a failed rename.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createSigner } from '../../lib/signer';
import { createReadContract, createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { ipfsCidToBytes32 } from '../../lib/encoding';
import { query } from '../../lib/subgraph';
import { requireValidUsername } from '../../lib/validation';
import { HOME_CHAIN_ID } from '../../config/networks';
import { runPreflight, checkGasBalance, checkUsernameFree, PreflightCheck } from '../../lib/preflight';
import { confirmWrite, finishWrite } from '../../lib/command';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface UpdateProfileArgs {
  org?: string;
  username?: string;
  bio?: string;
  avatar?: string;
  github?: string;
  twitter?: string;
  website?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

const METADATA_FLAGS = ['bio', 'avatar', 'github', 'twitter', 'website'] as const;

export const updateProfileHandler = {
  builder: (yargs: Argv) => yargs
    .option('username', { type: 'string', describe: 'New username (DESTRUCTIVE: releases the old name for anyone to claim)' })
    .option('bio', { type: 'string', describe: 'Profile bio (max 280 chars)' })
    .option('avatar', { type: 'string', describe: 'Avatar IPFS CID (Qm...)' })
    .option('github', { type: 'string', describe: 'GitHub username' })
    .option('twitter', { type: 'string', describe: 'Twitter/X handle' })
    .option('website', { type: 'string', describe: 'Website URL' })
    .example('pop user update-profile --bio "Protocol engineer"', 'Update the bio; other fields are preserved')
    .example('pop user update-profile --username alice_v2 --yes', 'Change username (destructive — old name is released)'),

  handler: async (argv: ArgumentsCamelCase<UpdateProfileArgs>) => {
    const spin = output.spinner('Updating profile...');
    spin.start();

    try {
      const metadataChanging = METADATA_FLAGS.some(flag => argv[flag] !== undefined);
      const usernameChanging = argv.username !== undefined;
      if (!metadataChanging && !usernameChanging) {
        throw new CliError(
          'Provide at least one field: --username, --bio, --avatar, --github, --twitter, --website',
          EXIT.USAGE
        );
      }

      let newUsername: string | undefined;
      if (usernameChanging) {
        try {
          newUsername = requireValidUsername(argv.username!);
        } catch (err: any) {
          throw new CliError(err.message, EXIT.USAGE);
        }
      }

      // Username + profile metadata are home-chain account-registry state
      // (that's where `pop user register` writes and `pop user profile`
      // reads). Default to the home chain, not POP_DEFAULT_CHAIN — otherwise a
      // typical org config (e.g. POP_DEFAULT_CHAIN=100) would read/write the
      // wrong registry. An explicit --chain still wins.
      const registryChainId = argv.chain ?? HOME_CHAIN_ID;

      // Get UAR address
      const uarResult = await query<any>(`{ universalAccountRegistries(first: 1) { id } }`, {}, registryChainId);
      const uarAddr = uarResult.universalAccountRegistries?.[0]?.id;
      if (!uarAddr) {
        throw new CliError(
          'UniversalAccountRegistry not found on this chain.',
          EXIT.INFRA,
          'The subgraph may be syncing — retry shortly.'
        );
      }

      const { signer, provider, address } = createSigner({
        privateKey: argv['private-key'] as string | undefined,
        chainId: registryChainId,
        rpcUrl: argv.rpc,
      });

      // changeUsername reverts AccountUnknown without a registration — read
      // the current name up front (also powers the confirm summary). A failed
      // READ (null) is not "no username": continue and let the contract be
      // the authority.
      let currentUsername: string | null = null;
      if (usernameChanging) {
        try {
          const registry = createReadContract(uarAddr, 'UniversalAccountRegistry', provider);
          currentUsername = await registry.getUsername(address);
        } catch {
          output.debug('could not read the current username — continuing (the contract enforces AccountUnknown)');
        }
        if (currentUsername === '') {
          throw new PreconditionError(
            `${address} has no registered username — changeUsername would revert AccountUnknown.`,
            'Register first: pop user register --username <name>'
          );
        }
        if (currentUsername === newUsername) {
          throw new CliError(`Username is already "${currentUsername}" — nothing to change.`, EXIT.USAGE);
        }
      }

      // Merge with existing metadata
      let metadata: Record<string, string> = {};
      if (metadataChanging) {
        spin.text = 'Fetching current profile...';
        const existingResult = await query<any>(
          `{ account(id: "${address.toLowerCase()}") { metadata { bio avatar github twitter website } } }`,
          {},
          registryChainId
        );
        const existing = existingResult.account?.metadata || {};

        if (argv.bio !== undefined || existing.bio) metadata.bio = (argv.bio as string) ?? existing.bio ?? '';
        if (argv.avatar !== undefined || existing.avatar) metadata.avatar = (argv.avatar as string) ?? existing.avatar ?? '';
        if (argv.github !== undefined || existing.github) metadata.github = (argv.github as string) ?? existing.github ?? '';
        if (argv.twitter !== undefined || existing.twitter) metadata.twitter = (argv.twitter as string) ?? existing.twitter ?? '';
        if (argv.website !== undefined || existing.website) metadata.website = (argv.website as string) ?? existing.website ?? '';

        if (metadata.bio && metadata.bio.length > 280) {
          throw new CliError(`Bio too long: ${metadata.bio.length}/280 chars`, EXIT.USAGE);
        }
      }

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      const checks: PreflightCheck[] = [checkGasBalance(address)];
      if (usernameChanging) {
        checks.push(checkUsernameFree(uarAddr, newUsername!));
      }
      await runPreflight(provider, checks, { skip: argv.preflight === false });
      spin.stop();

      // Username changes are destructive (the old name is released on-chain
      // for anyone to claim); metadata-only edits use the standard tier.
      await confirmWrite(argv, {
        username: usernameChanging ? `${currentUsername ?? '(current)'} → ${newUsername}` : undefined,
        note: usernameChanging
          ? `${currentUsername ? `"${currentUsername}"` : 'your current username'} is released for anyone to claim`
          : undefined,
        ...(metadataChanging ? metadata : {}),
        transactions: usernameChanging && metadataChanging ? '2 (changeUsername, then setProfileMetadata)' : undefined,
      }, {
        destructive: usernameChanging,
        actionLabel: usernameChanging ? 'About to change username' : 'About to update profile',
      });

      const contract = createWriteContract(uarAddr, 'UniversalAccountRegistry', signer);

      // Tx 1 (optional): changeUsername. finishWrite exits on failure, so
      // the metadata tx never runs after a failed rename.
      if (usernameChanging) {
        const txSpin = output.spinner('Sending changeUsername...');
        txSpin.start();
        const renameResult = await executeTx(contract, 'changeUsername', [newUsername], { dryRun: argv.dryRun });
        txSpin.stop();
        finishWrite(renameResult, {
          successMsg: `Username changed to "${newUsername}"`,
          fields: {
            oldUsername: currentUsername ?? undefined,
            username: newUsername,
            sponsored: renameResult.sponsored || false,
          },
        });
      }

      // Tx 2 (optional): re-pin + setProfileMetadata.
      if (metadataChanging) {
        spin.start();
        spin.text = 'Pinning metadata...';
        const cid = await pinJson(JSON.stringify(metadata));
        const metadataHash = ipfsCidToBytes32(cid);

        spin.text = 'Sending transaction...';
        const result = await executeTx(contract, 'setProfileMetadata', [metadataHash], { dryRun: argv.dryRun });
        spin.stop();

        finishWrite(result, {
          successMsg: 'Profile updated',
          fields: {
            ipfsCid: cid,
            ...metadata,
            sponsored: result.sponsored || false,
          },
        });
      }
    } catch (err: any) {
      spin.stop();
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err?.message || String(err));
      process.exit(EXIT.USAGE);
    }
  },
};
