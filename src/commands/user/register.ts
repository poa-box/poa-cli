/**
 * pop user register — register a username on the UniversalAccountRegistry.
 *
 * Usernames live on the home chain (Arbitrum) unless --chain overrides, so
 * this command deliberately does NOT inherit POP_DEFAULT_CHAIN (preserved
 * legacy behavior). Validation is the shared requireValidUsername (same
 * 3-32 alphanumeric+underscore rule the contract's ValidationLib enforces),
 * and pre-flight fails fast (exit 4) when the name is already registered —
 * UAR.registerAccount reverts UsernameTaken on-chain otherwise.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createSigner } from '../../lib/signer';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { query } from '../../lib/subgraph';
import { FETCH_INFRASTRUCTURE_ADDRESSES } from '../../queries/infrastructure';
import type { InfrastructureAddresses } from '../../queries/infrastructure';
import { HOME_CHAIN_ID, getNetworkByChainId } from '../../config/networks';
import { requireValidUsername } from '../../lib/validation';
import { runPreflight, checkGasBalance, checkUsernameFree } from '../../lib/preflight';
import { confirmWrite, finishWrite } from '../../lib/command';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface RegisterArgs {
  username: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

export const registerHandler = {
  builder: (yargs: Argv) => yargs
    .option('username', { type: 'string', demandOption: true, describe: 'Username (3-32 chars, alphanumeric + underscores)' })
    .example('pop user register --username alice', 'Register "alice" on the home chain (Arbitrum)')
    .example('pop user register --username alice --chain 11155111', 'Register on Sepolia instead'),

  handler: async (argv: ArgumentsCamelCase<RegisterArgs>) => {
    const spin = output.spinner('Registering username...');
    spin.start();

    try {
      let username: string;
      try {
        username = requireValidUsername(argv.username);
      } catch (err: any) {
        throw new CliError(err.message, EXIT.USAGE);
      }

      // Usernames live on the home chain (Arbitrum) unless overridden.
      const chainId = argv.chain || HOME_CHAIN_ID;
      const { signer, provider, address } = createSigner({
        privateKey: argv['private-key'] as string | undefined,
        chainId,
        rpcUrl: argv.rpc,
      });

      // Resolve UniversalAccountRegistry address
      const infra = await query<InfrastructureAddresses>(FETCH_INFRASTRUCTURE_ADDRESSES, {}, chainId);
      const registryAddr = infra.universalAccountRegistries?.[0]?.id
        || infra.poaManagerContracts?.[0]?.globalAccountRegistryProxy;
      if (!registryAddr) {
        throw new CliError(
          'Could not resolve the UniversalAccountRegistry address from the subgraph.',
          EXIT.INFRA,
          'The subgraph may be syncing — retry shortly, or pass --chain for a chain with a deployed registry.'
        );
      }

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      await runPreflight(provider, [
        checkGasBalance(address),
        checkUsernameFree(registryAddr, username),
      ], { skip: argv.preflight === false });
      spin.stop();

      await confirmWrite(argv, {
        username,
        address,
        registry: registryAddr,
        chain: getNetworkByChainId(chainId)?.name ?? `chain ${chainId}`,
      }, { actionLabel: 'About to register username' });

      const txSpin = output.spinner('Sending registration transaction...');
      txSpin.start();
      const contract = createWriteContract(registryAddr, 'UniversalAccountRegistry', signer);
      const result = await executeTx(contract, 'registerAccount', [username], { dryRun: argv.dryRun });
      txSpin.stop();

      finishWrite(result, {
        successMsg: `Username "${username}" registered`,
        fields: {
          username,
          address,
          chain: chainId,
        },
      });
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
