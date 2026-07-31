import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createPublicClient, http, pad, toHex, formatEther, type Address } from 'viem';
import { gnosis } from 'viem/chains';
import { entryPoint07Address } from 'viem/account-abstraction';
import { PAYMASTER_HUB } from '@poa/cli/lib/sponsored';
import * as output from '@poa/cli/lib/output';
import { resolveOrgModules } from '@poa/cli/lib/resolve';

interface PaymasterStatusArgs {
  org: string;
  'hat-id'?: string;
  chain?: number;
  rpc?: string;
}

export const paymasterStatusHandler = {
  builder: (yargs: Argv) => yargs
    .option('hat-id', { type: 'string', describe: 'Hat ID to check budget for (decimal or hex)' }),

  handler: async (argv: ArgumentsCamelCase<PaymasterStatusArgs>) => {
    const spin = output.spinner('Checking paymaster status...');
    spin.start();

    try {
      const modules = await resolveOrgModules(argv.org, argv.chain);
      const orgId = modules.orgId as `0x${string}`;
      const rpcUrl = (argv.rpc as string) || 'https://rpc.gnosischain.com';
      const client = createPublicClient({ chain: gnosis, transport: http(rpcUrl) });
      const pmAbi = require('../../abi/PaymasterHub.json');

      // Org config
      const config = await client.readContract({
        address: PAYMASTER_HUB, abi: pmAbi,
        functionName: 'getOrgConfig', args: [orgId],
      }) as any;

      // Org financials
      const financials = await client.readContract({
        address: PAYMASTER_HUB, abi: pmAbi,
        functionName: 'getOrgFinancials', args: [orgId],
      }) as any;

      // Fee caps
      const caps = await client.readContract({
        address: PAYMASTER_HUB, abi: pmAbi,
        functionName: 'getFeeCaps', args: [orgId],
      }) as any;

      // EntryPoint deposit
      const entryPointDeposit = await client.readContract({
        address: entryPoint07Address,
        abi: [{ name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
        functionName: 'balanceOf',
        args: [PAYMASTER_HUB],
      }) as bigint;

      // Hat budget (if specified or from env)
      const hatIdStr = (argv.hatId as string) || process.env.POP_HAT_ID;
      let budgetInfo: any = null;
      if (hatIdStr) {
        const hatId = BigInt(hatIdStr);
        const subjectKey = pad(toHex(hatId), { size: 32 });
        const budget = await client.readContract({
          address: PAYMASTER_HUB, abi: pmAbi,
          functionName: 'getBudget', args: [orgId, subjectKey],
        }) as any;
        const cap = BigInt(budget.capPerEpoch);
        const used = BigInt(budget.usedInEpoch);
        budgetInfo = {
          capPerEpoch: formatEther(cap),
          usedInEpoch: formatEther(used),
          remaining: formatEther(cap - used),
          epochLength: `${budget.epochLen}s (${(Number(budget.epochLen) / 3600).toFixed(1)}h)`,
          utilizationPct: cap > 0n
            ? ((Number(used) * 100 / Number(cap))).toFixed(1) + '%'
            : 'N/A',
        };
      }

      spin.stop();

      const result: any = {
        org: argv.org,
        paused: config.paused,
        deposited: formatEther(financials.deposited) + ' xDAI',
        spent: formatEther(financials.spent) + ' xDAI',
        entryPointDeposit: formatEther(entryPointDeposit) + ' xDAI',
        feeCaps: {
          maxFeePerGas: `${(Number(caps.maxFeePerGas) / 1e9).toFixed(1)} gwei`,
          maxPriorityFeePerGas: `${(Number(caps.maxPriorityFeePerGas) / 1e9).toFixed(1)} gwei`,
          maxCallGas: caps.maxCallGas.toLocaleString(),
          maxVerificationGas: caps.maxVerificationGas.toLocaleString(),
          maxPreVerificationGas: caps.maxPreVerificationGas.toLocaleString(),
        },
      };

      if (budgetInfo) {
        result.hatBudget = budgetInfo;
      }

      if (argv.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        output.success('Paymaster Status', result);
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
