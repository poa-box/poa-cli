import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createProvider } from '@poa-box/cli/lib/signer';
import { createReadContract } from '@poa-box/cli/lib/contracts';
import { resolveNetworkConfig } from '@poa-box/cli/config/networks';
import { tryAggregate } from '@poa-box/cli/lib/multicall';
import { resolvePaymasterInfra, fetchPaymasterSubgraphState, subgraphMatchesHub, hatSubjectKey } from '@poa-box/cli/commands/paymaster/helpers';
import { remainingBudget } from '@poa-box/cli/lib/protocol-reads';
import * as output from '@poa-box/cli/lib/output';
import { resolveOrgModules } from '@poa-box/cli/lib/resolve';

interface PaymasterStatusArgs { org: string; subject?: string; 'hat-id'?: string; chain?: number; rpc?: string }

export const paymasterStatusHandler = {
  builder: (yargs: Argv) => yargs.option('subject', { type: 'string', alias: 'hat-id', describe: 'Authority subject ID to check sponsorship budget for' }),
  handler: async (argv: ArgumentsCamelCase<PaymasterStatusArgs>) => {
    const spin = output.spinner('Checking paymaster status...'); spin.start();
    try {
      const network = resolveNetworkConfig(argv.chain);
      const provider = createProvider({ chainId: network.chainId, rpcUrl: argv.rpc });
      if ((await provider.getNetwork()).chainId !== network.chainId) throw new Error('RPC_CHAIN_MISMATCH');
      const [modules, infra, block] = await Promise.all([
        resolveOrgModules(argv.org, network.chainId), resolvePaymasterInfra(network.chainId), provider.getBlock('latest'),
      ]);
      if (!block?.hash) throw new Error('Canonical chain time unavailable');
      const state = await fetchPaymasterSubgraphState(modules.orgId, network.chainId);
      const indexed = subgraphMatchesHub(state, infra.paymasterHubAddress);
      const hub = createReadContract(infra.paymasterHubAddress, 'PaymasterHub', provider);
      const subject = argv.subject || argv.hatId || process.env.POP_SUBJECT_ID || process.env.POP_HAT_ID;
      const subjectKey = subject ? hatSubjectKey(subject) : null;
      const indexedBudget = indexed && subjectKey ? state.budgets?.find(b => b.subjectKey.toLowerCase() === subjectKey.toLowerCase()) : null;
      const requests = [
        { method: 'getOrgFinancials', args: [modules.orgId] },
        ...(!indexed || !state.entryPoint ? [{ method: 'ENTRY_POINT', args: [] }] : []),
        ...(!indexed || !state.orgConfig ? [{ method: 'getOrgConfig', args: [modules.orgId] }] : []),
        ...(!indexed || !state.feeCaps ? [{ method: 'getFeeCaps', args: [modules.orgId] }] : []),
        // Consumable current availability cannot combine a lagging indexed
        // epoch with a newer RPC timestamp. Observe state and time together.
        ...(subjectKey ? [{ method: 'getBudget', args: [modules.orgId, subjectKey] }] : []),
      ];
      const results = await tryAggregate(provider, requests.map(r => ({ to: hub.address, data: hub.interface.encodeFunctionData(r.method, r.args) })), { blockTag: block.number });
      const values: Record<string, any> = {};
      results.forEach((result, i) => {
        if (!result.success) throw new Error(`Paymaster read unavailable: ${requests[i].method}`);
        const decoded = hub.interface.decodeFunctionResult(requests[i].method, result.returnData);
        values[requests[i].method] = decoded.length === 1 ? decoded[0] : decoded;
      });
      const config = indexed && state.orgConfig ? state.orgConfig : values.getOrgConfig;
      const caps = indexed && state.feeCaps ? state.feeCaps : values.getFeeCaps;
      const financials = values.getOrgFinancials;
      const entryPoint = indexed && state.entryPoint ? state.entryPoint : values.ENTRY_POINT;
      const ep = new ethers.Contract(entryPoint, ['function balanceOf(address) view returns(uint256)'], provider);
      const deposit = await ep.balanceOf(hub.address, { blockTag: block.number });
      const currency = network.nativeCurrency.symbol;
      const result: any = { org: argv.org, paused: config.paused,
        deposited: `${ethers.utils.formatEther(financials.deposited)} ${currency}`,
        spent: `${ethers.utils.formatEther(financials.spent)} ${currency}`,
        entryPointDeposit: `${ethers.utils.formatEther(deposit)} ${currency}`,
        feeCaps: { maxFeePerGas: `${ethers.utils.formatUnits(caps.maxFeePerGas, 9)} gwei`,
          maxPriorityFeePerGas: `${ethers.utils.formatUnits(caps.maxPriorityFeePerGas, 9)} gwei`,
          maxCallGas: caps.maxCallGas.toString(), maxVerificationGas: caps.maxVerificationGas.toString(), maxPreVerificationGas: caps.maxPreVerificationGas.toString() },
        chainId: network.chainId, paymasterHub: hub.address, entryPoint, blockNumber: block.number,
        budgetKey: subjectKey, configSource: indexed && state.orgConfig ? 'subgraph' : 'rpc',
        rpcObservation: { blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp },
        indexedObservation: indexed ? { snapshot: 'latest', block: null, currentAvailabilityVerified: false } : null };
      const budget = values.getBudget;
      if (budget) {
        const cap = ethers.BigNumber.from(budget.capPerEpoch), used = ethers.BigNumber.from(budget.usedInEpoch);
        const raw = { capPerEpoch: cap.toString(), usedInEpoch: used.toString(), epochLen: budget.epochLen.toString(), epochStart: budget.epochStart.toString() };
        const remaining = remainingBudget(raw, String(block.timestamp));
        const effectiveUsed = cap.sub(remaining);
        result.hatBudget = { capPerEpoch: ethers.utils.formatEther(cap), usedInEpoch: ethers.utils.formatEther(used),
          remaining: ethers.utils.formatEther(remaining), remainingWei: remaining,
          epochLength: `${raw.epochLen}s (${(Number(raw.epochLen) / 3600).toFixed(1)}h)`,
          utilizationPct: cap.gt(0) ? `${(effectiveUsed.mul(1000).div(cap).toNumber() / 10).toFixed(1)}%` : 'N/A',
          usedInEpochEffective: ethers.utils.formatEther(effectiveUsed), raw, source: 'rpc',
          blockNumber: block.number, blockHash: block.hash,
          ...(indexedBudget ? { indexedRaw: { capPerEpoch: indexedBudget.capPerEpoch.toString(),
            usedInEpoch: indexedBudget.usedInEpoch.toString(), epochLen: indexedBudget.epochLen.toString(),
            epochStart: indexedBudget.epochStart.toString() } } : {}) };
      }
      if ((await provider.getBlock(block.number))?.hash !== block.hash
        || (await provider.getNetwork()).chainId !== network.chainId) throw new Error('PAYMASTER_OBSERVATION_CHANGED');
      spin.stop();
      if (output.isJsonMode()) output.json(result); else output.success('Paymaster Status', result);
    } catch (error: any) { spin.stop(); output.error(error.message); process.exit(1); }
  },
};
