import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { requireRawUint } from '@poa-box/core/amounts';
import { readHistoricalPotFacts } from '@poa-box/core/treasury/inflows';
import { readHistoricalPaymasterHubPotFacts, readIndexedNativeInflowFacts, projectIndexedNativeInflow,
  deduplicateIndexedNativeInflows } from '@poa-box/core/treasury/indexed-inflows';
import { knownFact, unknownFact, requireCompleteSnapshot } from '@poa-box/core/data/facts';
import { resolveNetworkConfig } from '../../config/networks';
import { createIndexedSource } from '../../lib/indexed-source';
import * as output from '../../lib/output';

export const inflowsHandler = {
  builder: (y: Argv) => y.option('from-block', { type: 'string', demandOption: true, describe: 'Inclusive first block for recorded native events' })
    .option('page-size', { type: 'number', default: 100, describe: 'Indexed page size (1–1000)' })
    .option('max-pages', { type: 'number', default: 20, describe: 'Finite page cap for each independent stream' }),
  handler: async (argv: ArgumentsCamelCase<{ chain?: number; fromBlock: string; pageSize: number; maxPages: number }>) => {
    try {
      const config = resolveNetworkConfig(argv.chain), fromBlock = requireRawUint(argv.fromBlock);
      if (!Number.isSafeInteger(argv.maxPages) || argv.maxPages < 1 || argv.maxPages > 1000) throw new Error('Invalid inflow page bounds');
      const indexed = await createIndexedSource({ chainId: config.chainId });
      if (BigInt(fromBlock) > BigInt(indexed.source.block!.number)) throw new Error('Inflow start exceeds the indexed snapshot');
      const options = { source: indexed.source, query: indexed.protocolQuery, pageSize: argv.pageSize, maxPages: argv.maxPages };
      const collections = ['payments', 'paymasterDepositEvents', 'solidarityEvents'] as const;
      const [histories, hubs, streams] = await Promise.all([readHistoricalPotFacts(options), readHistoricalPaymasterHubPotFacts(options),
        Promise.all(collections.map(collection => readIndexedNativeInflowFacts({ ...options, collection, fromBlock }))) ]);
      const nativeAsset = { chainId: config.chainId, address: ethers.constants.AddressZero, decimals: 18 };
      const projections = streams.flatMap(stream => stream.data.rows.map(row => projectIndexedNativeInflow(row, stream.data.collection, stream.source, nativeAsset)));
      const events = deduplicateIndexedNativeInflows(projections.flatMap(fact => fact.state === 'known' ? [fact.value] : []));
      let externalRecordedNativeRaw = unknownFact<string>('INFLOW_EVIDENCE_INCOMPLETE', indexed.source);
      let internalMovements: unknown[] = [];
      try {
        const pots = [...Object.values(histories).flatMap(s => requireCompleteSnapshot(s)), ...requireCompleteSnapshot(hubs)];
        streams.forEach(stream => requireCompleteSnapshot(stream));
        if (projections.some(f => f.state !== 'known') || events.state !== 'known') throw new Error('Invalid events');
        const internal: typeof events.value = [], external: typeof events.value = [];
        for (const event of events.value) {
          const target = pots.find(p => p.address.toLowerCase() === event.to && BigInt(p.createdAtBlock) <= BigInt(event.blockNumber));
          if (!target || target.kind !== (event.collection === 'payments' ? 'payment-manager' : 'paymaster-hub')
            || (target.kind === 'payment-manager' && target.orgId.toLowerCase() !== event.orgId)) throw new Error('Event pot binding unknown');
          const from = pots.find(p => p.address.toLowerCase() === event.from && BigInt(p.createdAtBlock) <= BigInt(event.blockNumber));
          (from ? internal : external).push(event);
        }
        internalMovements = internal;
        externalRecordedNativeRaw = knownFact(external.reduce((sum, e) => sum + BigInt(e.amountRaw), 0n).toString(), indexed.source);
      } catch { /* diagnostic evidence retained, totals remain unknown */ }
      const result = { scope: 'indexed-recorded-native-events', source: indexed.source, fromBlock, pots: { ...histories, 'paymaster-hub': hubs }, streams,
        events, internalMovements, externalRecordedNativeRaw, completeRevenue: unknownFact('NATIVE_AND_CAUSAL_COVERAGE_UNPROVEN', indexed.source) };
      if (output.isJsonMode()) output.json(result); else output.info(JSON.stringify(result, null, 2));
    } catch (error: any) { output.error(error.message); process.exitCode = 1; }
  },
};
