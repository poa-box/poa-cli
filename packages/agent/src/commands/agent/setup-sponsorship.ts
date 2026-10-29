import type { Argv, ArgumentsCamelCase } from 'yargs';
import {
  createPublicClient,
  http,
  type Address,
  type Hex,
} from 'viem';
import { gnosis } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { isDelegated, delegateEOA, EOA_DELEGATION } from '@poa-box/cli/lib/sponsored';
import { ethers } from 'ethers';
import { hatSubjectKey, resolvePaymasterInfra } from '@poa-box/cli/commands/paymaster/helpers';
import { resolveNetworkConfig } from '@poa-box/cli/config/networks';
import { createSigner } from '@poa-box/cli/lib/signer';
import { createWriteContract } from '@poa-box/cli/lib/contracts';
import { executeTx } from '@poa-box/cli/lib/tx';
import { confirmWrite } from '@poa-box/cli/lib/command';
import * as output from '@poa-box/cli/lib/output';

interface SetupSponsorshipArgs {
  org: string;
  subject?: string;
  'hat-id': string;
  'org-id': string;
  'budget-per-day'?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
}

export const setupSponsorshipHandler = {
  builder: (yargs: Argv) => yargs
    .option('org-id', { type: 'string', demandOption: true, describe: 'Org ID (bytes32 hex)' })
    .option('subject', { type: 'string', alias: 'hat-id', demandOption: true, describe: 'Authority role or group subject ID (decimal or hex)' })
    .option('budget-per-day', { type: 'string', default: '0.1', describe: 'Exact decimal gas budget per day in xDAI' }),

  handler: async (argv: ArgumentsCamelCase<SetupSponsorshipArgs>) => {
    const spin = output.spinner('Setting up gas sponsorship...');
    spin.start();

    try {
      if (process.env.POP_READONLY === '1') throw new Error('POP_READONLY=1 — sponsorship setup cannot sign or broadcast.');
      const network = resolveNetworkConfig(argv.chain);
      if (network.chainId !== 100) throw new Error('Agent EIP-7702 setup currently supports Gnosis only.');
      const { paymasterHubAddress } = await resolvePaymasterInfra(network.chainId);
      const hubAddress = paymasterHubAddress as Address;
      const privateKey = (argv.privateKey as string) || process.env.POP_PRIVATE_KEY;
      if (!privateKey) throw new Error('No private key. Set POP_PRIVATE_KEY or pass --private-key.');

      const pk = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
      const account = privateKeyToAccount(pk);
      const rpcUrl = (argv.rpc as string) || network.resolvedRpc;

      const publicClient = createPublicClient({ chain: gnosis, transport: http(rpcUrl) });
      if (await publicClient.getChainId() !== network.chainId) throw new Error('RPC_CHAIN_MISMATCH');
      const { signer } = createSigner({ privateKey, chainId: network.chainId, rpcUrl });
      const hub = createWriteContract(hubAddress, 'PaymasterHub', signer);
      const send = async (method: string, args: any[]) => {
        const result = await executeTx(hub, method, args, {});
        if (!result.success) {
          const failure: any = new Error(result.error || 'Sponsorship setup submission failed');
          failure.result = result;
          throw failure;
        }
        return result.txHash!;
      };

      const orgId = argv.orgId as Hex;
      const hatId = BigInt((argv.subject || argv.hatId) as string);
      const subjectKey = hatSubjectKey(hatId.toString()) as Hex;
      const budgetWei = BigInt(ethers.utils.parseEther(String(argv.budgetPerDay ?? '0.1')).toString());
      if (budgetWei <= 0n || budgetWei >= (1n << 128n)) throw new Error('Budget must be positive and fit uint128');
      if (!argv.dryRun) await confirmWrite(argv, { account: account.address, chain: network.chainId,
        paymasterHub: hubAddress, delegate: EOA_DELEGATION, org: argv.orgId,
        subject: argv.subject || argv.hatId, subjectKey, budgetPerDay: String(argv.budgetPerDay ?? '0.1') }, { destructive: true });
      const pmAbi = require('@poa-box/cli/abi/PaymasterHub.json');

      const results: Record<string, string> = {};

      // Step 1: Check and set up EIP-7702 delegation
      spin.text = 'Step 1/3: Checking EIP-7702 delegation...';
      const delegated = await isDelegated(account.address, rpcUrl);
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
        address: hubAddress,
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
          const hash = await send('setBudget', [orgId, subjectKey, budgetWei.toString(), 86400]);
          results.budget = `set to ${(Number(budgetWei) / 1e18).toFixed(4)} xDAI/day (tx: ${hash})`;
        }
      }

      // Step 3: Check and raise fee caps if needed
      spin.text = 'Step 3/3: Checking fee caps...';
      const caps = await publicClient.readContract({
        address: hubAddress,
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
          const hash = await send('setFeeCaps', [orgId, newCaps.maxFeePerGas.toString(), newCaps.maxPriorityFeePerGas.toString(), newCaps.maxCallGas, newCaps.maxVerificationGas, newCaps.maxPreVerificationGas]);
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
      output.error(err.message, err.result ? { code: err.result.errorCode, txHash: err.result.txHash, userOpHash: err.result.userOpHash, outcome: err.result.outcome, recovery: err.result.recovery } : undefined);
      process.exit(1);
    }
  },
};
