import type { Argv, ArgumentsCamelCase } from 'yargs';
import { type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { isDelegated, delegateEOA, EOA_DELEGATION } from '@poa-box/cli/lib/sponsored';
import * as output from '@poa-box/cli/lib/output';

interface DelegateArgs {
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
}

export const delegateHandler = {
  builder: (yargs: Argv) => yargs,

  handler: async (argv: ArgumentsCamelCase<DelegateArgs>) => {
    const spin = output.spinner('Setting up EIP-7702 delegation...');
    spin.start();

    try {
      const key = (argv.privateKey as string) || process.env.POP_PRIVATE_KEY;
      if (!key) throw new Error('No private key configured');

      const account = privateKeyToAccount(key as Hex);
      const rpcUrl = argv.rpc as string || 'https://rpc.gnosischain.com';

      // Check if already delegated
      spin.text = 'Checking delegation status...';
      const alreadyDelegated = await isDelegated(account.address, rpcUrl);

      if (alreadyDelegated) {
        spin.stop();
        if (output.isJsonMode()) {
          output.json({ status: 'already_delegated', address: account.address, delegate: EOA_DELEGATION });
        } else {
          output.info(`Already delegated to EOADelegation (${EOA_DELEGATION})`);
        }
        return;
      }

      if (argv.dryRun) {
        spin.stop();
        output.success('Delegation ready (dry-run)', {
          address: account.address,
          delegate: EOA_DELEGATION,
          action: 'Would sign EIP-7702 authorization and send delegation transaction',
        });
        return;
      }

      // Delegate
      spin.text = 'Signing EIP-7702 authorization...';
      const txHash = await delegateEOA(key as Hex, rpcUrl);

      spin.stop();
      output.success('EOA delegated to EOADelegation', {
        address: account.address,
        delegate: EOA_DELEGATION,
        txHash,
        explorerUrl: `https://gnosisscan.io/tx/${txHash}`,
        note: 'Your EOA can now receive sponsored UserOperations via PaymasterHub.',
      });
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
