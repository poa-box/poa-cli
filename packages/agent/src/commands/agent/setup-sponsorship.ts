import type { Argv, ArgumentsCamelCase } from 'yargs';
import {
  createPublicClient,
  createWalletClient,
  http,
  pad,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { gnosis } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { isDelegated, delegateEOA, EOA_DELEGATION, PAYMASTER_HUB } from '@poa/cli/lib/sponsored';
import * as output from '@poa/cli/lib/output';

interface SetupSponsorshipArgs {
  org: string;
  'hat-id': string;
  'org-id': string;
  'budget-per-day'?: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
}

export const setupSponsorshipHandler = {
  builder: (yargs: Argv) => yargs
    .option('org-id', { type: 'string', demandOption: true, describe: 'Org ID (bytes32 hex)' })
    .option('hat-id', { type: 'string', demandOption: true, describe: 'Agent hat ID (decimal or hex)' })
    .option('budget-per-day', { type: 'number', default: 0.1, describe: 'Gas budget per day in xDAI' }),

  handler: async (argv: ArgumentsCamelCase<SetupSponsorshipArgs>) => {
    const spin = output.spinner('Setting up gas sponsorship...');
    spin.start();

    try {
      const privateKey = (argv.privateKey as string) || process.env.POP_PRIVATE_KEY;
      if (!privateKey) throw new Error('No private key. Set POP_PRIVATE_KEY or pass --private-key.');

      const pk = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
      const account = privateKeyToAccount(pk);
      const rpcUrl = (argv.rpc as string) || 'https://rpc.gnosischain.com';

      const publicClient = createPublicClient({ chain: gnosis, transport: http(rpcUrl) });
      const walletClient = createWalletClient({ account, chain: gnosis, transport: http(rpcUrl) });

      const orgId = argv.orgId as Hex;
      const hatId = BigInt(argv.hatId as string);
      const subjectKey = pad(toHex(hatId), { size: 32 });
      const budgetWei = BigInt(Math.floor((argv.budgetPerDay as number) * 1e18));
      const pmAbi = require('../../abi/PaymasterHub.json');

      const results: Record<string, string> = {};

      // Step 1: Check and set up EIP-7702 delegation
      spin.text = 'Step 1/3: Checking EIP-7702 delegation...';
      const delegated = await isDelegated(account.address);
      if (delegated) {
        results.delegation = 'already delegated';
      } else {
        if (argv.dryRun) {
          results.delegation = 'would delegate (dry-run)';
        } else {
          const hash = await delegateEOA(pk, rpcUrl);
          await publicClient.waitForTransactionReceipt({ hash });
          results.delegation = `delegated (tx: ${hash})`;
        }
      }

      // Step 2: Check and set hat budget
      spin.text = 'Step 2/3: Checking hat budget...';
      const budget = await publicClient.readContract({
        address: PAYMASTER_HUB,
        abi: pmAbi,
        functionName: 'getBudget',
        args: [orgId, subjectKey],
      }) as any;

      if (budget.capPerEpoch > 0n) {
        results.budget = `already set (${(Number(budget.capPerEpoch) / 1e18).toFixed(4)} xDAI/epoch, ${budget.epochLen}s epoch)`;
      } else {
        if (argv.dryRun) {
          results.budget = `would set ${(Number(budgetWei) / 1e18).toFixed(4)} xDAI/day (dry-run)`;
        } else {
          const hash = await walletClient.writeContract({
            address: PAYMASTER_HUB,
            abi: pmAbi,
            functionName: 'setBudget',
            args: [orgId, subjectKey, budgetWei, 86400],
          });
          await publicClient.waitForTransactionReceipt({ hash });
          results.budget = `set to ${(Number(budgetWei) / 1e18).toFixed(4)} xDAI/day (tx: ${hash})`;
        }
      }

      // Step 3: Check and raise fee caps if needed
      spin.text = 'Step 3/3: Checking fee caps...';
      const caps = await publicClient.readContract({
        address: PAYMASTER_HUB,
        abi: pmAbi,
        functionName: 'getFeeCaps',
        args: [orgId],
      }) as any;

      const needsRaise = caps.maxCallGas < 1000000 || caps.maxVerificationGas < 1000000 || caps.maxPreVerificationGas < 200000;
      if (!needsRaise) {
        results.feeCaps = `OK (callGas: ${caps.maxCallGas}, verGas: ${caps.maxVerificationGas}, preVerGas: ${caps.maxPreVerificationGas})`;
      } else {
        const newCaps = {
          maxFeePerGas: caps.maxFeePerGas > 50000000000n ? caps.maxFeePerGas : 50000000000n,
          maxPriorityFeePerGas: caps.maxPriorityFeePerGas > 10000000000n ? caps.maxPriorityFeePerGas : 10000000000n,
          maxCallGas: Math.max(caps.maxCallGas, 2000000),
          maxVerificationGas: Math.max(caps.maxVerificationGas, 1500000),
          maxPreVerificationGas: Math.max(caps.maxPreVerificationGas, 500000),
        };
        if (argv.dryRun) {
          results.feeCaps = `would raise caps (dry-run)`;
        } else {
          const hash = await walletClient.writeContract({
            address: PAYMASTER_HUB,
            abi: pmAbi,
            functionName: 'setFeeCaps',
            args: [orgId, newCaps.maxFeePerGas, newCaps.maxPriorityFeePerGas, newCaps.maxCallGas, newCaps.maxVerificationGas, newCaps.maxPreVerificationGas],
          });
          await publicClient.waitForTransactionReceipt({ hash });
          results.feeCaps = `raised (tx: ${hash})`;
        }
      }

      spin.stop();
      output.success('Gas sponsorship setup complete', {
        agent: account.address,
        ...results,
        nextStep: 'Add POP_ORG_ID, POP_HAT_ID, and PIMLICO_API_KEY to .env',
      });
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
