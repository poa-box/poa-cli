/**
 * pop init — interactive human onboarding.
 *
 * Walks a first-time user through the four things every write command needs:
 *   1. a chain (from the POP-deployed set),
 *   2. a signing key (generate a fresh wallet, import an existing one, or skip
 *      and set POP_PRIVATE_KEY out-of-band),
 *   3. an optional default org, and
 *   4. a persisted .env (./.env by default, or ~/.pop/.env with --global).
 *
 * TTY vs non-TTY:
 *   - Interactive (isInteractive()): prompts for each of the above, prints a
 *     summary, asks to confirm, then writes the file.
 *   - Non-interactive: NEVER prompts. Requires --chain plus a key source
 *     (--generate-key or POP_PRIVATE_KEY in the environment); anything less is
 *     a USAGE error telling the caller exactly what to pass.
 *
 * Safety: the key lands in a plaintext file. We chmod it 0600 automatically,
 * say so, and remind the user not to commit it. An existing target file is
 * never clobbered without --force.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { NETWORKS, getNetworkByChainId, getNetworkNameByChainId } from '../config/networks';
import { writeEnvFile } from '../lib/envfile';
import { isInteractive, select, input, confirm } from '../lib/prompt';
import { CliError, AbortedError } from '../lib/errors';
import { EXIT } from '../lib/exit-codes';
import * as output from '../lib/output';

interface InitArgs {
  chain?: number;
  org?: string;
  'generate-key'?: boolean;
  global?: boolean;
  force?: boolean;
  /** Hidden test override: write to this exact path instead of ./.env | ~/.pop/.env. */
  file?: string;
  json?: boolean;
}

/** The POP-deployed chains, in a stable menu order (mainnets first). */
const POP_CHAIN_IDS = [100, 42161, 11155111, 84532] as const;

type KeyChoice = 'generate' | 'import' | 'skip';

/** Resolve the env file we will write, honoring --file (test) then --global. */
export function resolveTargetFile(argv: { file?: string; global?: boolean }): string {
  if (argv.file) return resolve(argv.file);
  if (argv.global) return join(homedir(), '.pop', '.env');
  return resolve(process.cwd(), '.env');
}

/** Human label for a chain id, e.g. "Gnosis (100)". */
function chainLabel(chainId: number): string {
  const net = getNetworkByChainId(chainId);
  return net ? `${net.name} (${chainId})` : `chain ${chainId}`;
}

/**
 * Validate an imported private key by constructing a Wallet; returns the
 * normalized 0x key. Throws (from ethers) on anything that isn't a valid
 * 32-byte key. Exported for tests + reuse.
 */
export function validatePrivateKey(raw: string): string {
  const key = raw.trim();
  // new ethers.Wallet(key) throws on anything that isn't a valid 32-byte key.
  const wallet = new ethers.Wallet(key);
  return wallet.privateKey;
}

export const initHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('chain', { type: 'number', describe: 'Chain ID to configure (100 Gnosis, 42161 Arbitrum, 11155111 Sepolia, 84532 Base Sepolia)' })
      .option('org', { type: 'string', describe: 'Default org name or hex ID (POP_DEFAULT_ORG)' })
      .option('generate-key', { type: 'boolean', default: false, describe: 'Generate a fresh wallet non-interactively (prints the mnemonic once)' })
      .option('global', { type: 'boolean', default: false, describe: 'Write ~/.pop/.env (per-user) instead of ./.env (project-local)' })
      .option('force', { type: 'boolean', default: false, describe: 'Overwrite an existing target .env file' })
      // Hidden test seam: write to an explicit path.
      .option('file', { type: 'string', hidden: true, describe: 'Write to this exact path (testing)' })
      .example('pop init', 'Interactive setup: pick a chain, create or import a wallet, write ./.env')
      .example('pop init --generate-key --chain 100 --global', 'Non-interactive: fresh wallet on Gnosis, written to ~/.pop/.env'),

  handler: async (argv: ArgumentsCamelCase<InitArgs>) => {
    try {
      const targetFile = resolveTargetFile(argv);

      // Refuse to clobber unless --force — check up front so we fail before any
      // wallet generation or prompting side-effects.
      if (existsSync(targetFile) && !argv.force) {
        throw new CliError(
          `${targetFile} already exists. Re-run with --force to overwrite it, or edit the file directly.`,
          EXIT.USAGE
        );
      }

      const interactive = isInteractive();

      // ── Resolve chain, key, org via the appropriate path ────────────────
      let chainId: number;
      let privateKey: string | undefined; // undefined ⇒ key intentionally skipped
      let mnemonicToShow: string | undefined;
      let generatedAddress: string | undefined;
      let org = argv.org;

      if (interactive) {
        // (1) Chain
        chainId = argv.chain ?? (await select<number>(
          'Which chain do you want to use?',
          POP_CHAIN_IDS.map((id) => {
            const net = getNetworkByChainId(id)!;
            return {
              label: net.name,
              value: id,
              hint: `${net.nativeCurrency.symbol}${net.isTestnet ? ', testnet' : ''} — id ${id}`,
            };
          })
        ));
        if (!getNetworkByChainId(chainId)) {
          throw new CliError(`Unsupported chain id ${chainId}.`, EXIT.USAGE, supportedChainsHint());
        }

        // (2) Key
        const keyChoice = argv.generateKey
          ? 'generate'
          : await select<KeyChoice>('How do you want to set up a signing wallet?', [
              { label: 'Generate a new wallet', value: 'generate', hint: 'creates a fresh key + mnemonic' },
              { label: 'Import an existing private key', value: 'import', hint: 'paste a 0x… hex key (hidden input)' },
              { label: 'Skip for now', value: 'skip', hint: 'set POP_PRIVATE_KEY yourself later' },
            ]);

        if (keyChoice === 'generate') {
          const wallet = ethers.Wallet.createRandom();
          privateKey = wallet.privateKey;
          generatedAddress = wallet.address;
          mnemonicToShow = wallet.mnemonic?.phrase;
        } else if (keyChoice === 'import') {
          const raw = await input('Paste your private key (0x… hex):', {
            secret: true,
            validate: (value) => {
              try {
                validatePrivateKey(value);
                return true;
              } catch {
                return 'That is not a valid private key (expected 32-byte hex, optionally 0x-prefixed).';
              }
            },
          });
          privateKey = validatePrivateKey(raw);
          generatedAddress = new ethers.Wallet(privateKey).address;
        } else {
          privateKey = undefined; // skip
        }

        // (3) Optional default org. Pre-fill any existing POP_DEFAULT_ORG so a
        // reconfiguration keeps it only when the user visibly confirms — never
        // silently inherited (that path is why --org is excluded from the
        // global env fallback in index.ts).
        if (org === undefined) {
          const entered = await input('Default org name or hex ID (optional — press enter to skip):', {
            default: process.env.POP_DEFAULT_ORG ?? '',
          });
          org = entered.trim() === '' ? undefined : entered.trim();
        }
      } else {
        // ── Non-interactive: never prompt ─────────────────────────────────
        chainId = argv.chain ?? NaN;
        const envKey = process.env.POP_PRIVATE_KEY;
        if (!argv.chain || !(argv.generateKey || envKey)) {
          throw new CliError(
            'pop init needs a TTY, or pass --chain and --generate-key (or set POP_PRIVATE_KEY)',
            EXIT.USAGE
          );
        }
        if (!getNetworkByChainId(chainId)) {
          throw new CliError(`Unsupported chain id ${chainId}.`, EXIT.USAGE, supportedChainsHint());
        }

        if (argv.generateKey) {
          const wallet = ethers.Wallet.createRandom();
          privateKey = wallet.privateKey;
          generatedAddress = wallet.address;
          mnemonicToShow = wallet.mnemonic?.phrase;
        } else {
          // Use POP_PRIVATE_KEY from the environment; validate it so a broken
          // env var fails here rather than on the first transaction.
          try {
            privateKey = validatePrivateKey(envKey!);
            generatedAddress = new ethers.Wallet(privateKey).address;
          } catch {
            throw new CliError(
              'POP_PRIVATE_KEY is set but is not a valid private key.',
              EXIT.USAGE,
              'Fix POP_PRIVATE_KEY, or pass --generate-key to create a fresh wallet.'
            );
          }
        }
      }

      // ── Build the env var map (stable, human-readable order) ────────────
      const vars: Record<string, string> = {};
      if (privateKey) vars.POP_PRIVATE_KEY = privateKey;
      vars.POP_DEFAULT_CHAIN = String(chainId);
      if (org) vars.POP_DEFAULT_ORG = org;

      // ── Confirm (interactive only) ──────────────────────────────────────
      const summary: Record<string, string | number | undefined> = {
        file: targetFile,
        chain: chainLabel(chainId),
        wallet: privateKey
          ? `${generatedAddress}${mnemonicToShow ? ' (new)' : ' (imported)'}`
          : 'skipped (set POP_PRIVATE_KEY later)',
        org: org ?? '(none)',
      };

      if (interactive) {
        // Show the mnemonic BEFORE the confirm so the user has already been
        // warned to save it by the time they approve writing it to disk.
        if (mnemonicToShow) {
          output.warn('SAVE YOUR MNEMONIC — it will not be shown again:');
          console.log('');
          console.log(`    ${mnemonicToShow}`);
          console.log('');
          output.info(`Wallet address: ${generatedAddress}`);
        }
        output.keyValueBlock('pop init will write', summary);
        const ok = await confirm('Write this configuration?', { defaultNo: false });
        if (!ok) throw new AbortedError('aborted by user');
      }

      // ── Write ───────────────────────────────────────────────────────────
      writeEnvFile(targetFile, vars);

      // ── Report ──────────────────────────────────────────────────────────
      const networkName = getNetworkNameByChainId(chainId) ?? `chain ${chainId}`;
      const nextSteps = [
        privateKey ? undefined : 'Set POP_PRIVATE_KEY (export it, or add it to the file above)',
        'pop user register --username <name>',
        org ? `pop user join --org ${org}` : 'pop user join --org <org>',
        'pop task list',
      ].filter(Boolean) as string[];

      if (output.isJsonMode()) {
        // A generated wallet's mnemonic is only recoverable here — return it in
        // the payload so a scripted `--generate-key --json` run can back it up.
        output.json({
          status: 'ok',
          file: targetFile,
          chainId,
          network: networkName,
          wallet: generatedAddress ?? null,
          keyStored: Boolean(privateKey),
          generatedWallet: Boolean(mnemonicToShow),
          mnemonic: mnemonicToShow ?? null,
          org: org ?? null,
          nextSteps,
        });
        return;
      }

      // Non-interactive generate-key path never hit the pre-confirm banner
      // above, so show the mnemonic once here before the success summary.
      if (mnemonicToShow && !interactive) {
        output.warn('SAVE YOUR MNEMONIC — it will not be shown again:');
        console.log('');
        console.log(`    ${mnemonicToShow}`);
        console.log('');
      }

      output.success(`Wrote ${targetFile}`, {
        chain: chainLabel(chainId),
        wallet: generatedAddress ?? '(none — POP_PRIVATE_KEY not set)',
        org: org ?? '(none)',
      });
      output.info(`Permissions set to 600 (owner read/write only). Do NOT commit ${argv.global ? '~/.pop/.env' : '.env'} — it holds your private key in plaintext.`);
      if (privateKey && !mnemonicToShow && !argv.file) {
        output.info('Your key is stored in plaintext in the file above.');
      }
      console.log('');
      console.log('  Next steps:');
      nextSteps.forEach((s, i) => console.log(`    ${i + 1}. ${s}`));
      console.log('');
    } catch (err: any) {
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err?.message || String(err));
      process.exit(EXIT.USAGE);
    }
  },
};

function supportedChainsHint(): string {
  const names = POP_CHAIN_IDS.map((id) => `${NETWORKS[getNetworkNameByChainId(id)!].name} (${id})`).join(', ');
  return `Supported POP chains: ${names}.`;
}
