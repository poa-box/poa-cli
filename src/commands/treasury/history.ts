import type { Argv, ArgumentsCamelCase } from 'yargs';
import { resolveOrgModules, requireModule } from '../../lib/resolve';
import { resolveNetworkConfig } from '../../config/networks';
import { createIndexedSource } from '../../lib/indexed-source';
import { readDistributionHistoryFacts, readPaymentHistoryFacts, readDistributionClaimFacts,
  readDistributionReferences, readTreasuryWorkFacts } from '@poa-box/core/reads/treasury';
import * as output from '../../lib/output';

type Kind = 'distributions' | 'payments' | 'claims' | 'references' | 'completed' | 'promised';
interface Args { org?: string; chain?: number; kind: Kind; distribution?: string; pageSize: number; maxPages: number }
export const historyHandler = {
  builder: (y: Argv) => y.option('kind', { type: 'string', choices: ['distributions', 'payments', 'claims', 'references', 'completed', 'promised'], default: 'distributions', describe: 'Financial history stream' })
    .option('distribution', { type: 'string', describe: 'Exact distribution ID for claims' })
    .option('page-size', { type: 'number', default: 100, describe: 'Indexed page size (1–1000)' })
    .option('max-pages', { type: 'number', default: 20, describe: 'Finite page cap; a capped result remains incomplete' }),
  handler: async (argv: ArgumentsCamelCase<Args>) => {
    try {
      const modules = await resolveOrgModules(argv.org, argv.chain), config = resolveNetworkConfig(argv.chain);
      if (!Number.isSafeInteger(argv.pageSize) || argv.pageSize < 1 || argv.pageSize > 1000 || !Number.isSafeInteger(argv.maxPages) || argv.maxPages < 1 || argv.maxPages > 1000) throw new Error('Invalid history page bounds');
      const key = argv.kind === 'references' ? 'hybridVotingAddress'
        : ['completed', 'promised'].includes(argv.kind) ? 'taskManagerAddress' : 'paymentManagerAddress';
      const indexed = await createIndexedSource({ chainId: config.chainId, orgId: modules.orgId, contract: requireModule(modules, key) });
      const options = { source: indexed.source, query: indexed.protocolQuery, pageSize: argv.pageSize, maxPages: argv.maxPages };
      if (argv.kind === 'claims' && argv.distribution === undefined) throw new Error('--distribution is required for claim history');
      const snapshot = argv.kind === 'distributions' ? await readDistributionHistoryFacts(options)
        : argv.kind === 'payments' ? await readPaymentHistoryFacts(options)
        : argv.kind === 'claims' ? await readDistributionClaimFacts({ ...options, distributionId: argv.distribution! })
        : argv.kind === 'references' ? await readDistributionReferences(options)
        : await readTreasuryWorkFacts({ ...options, kind: argv.kind });
      if (output.isJsonMode()) output.json(snapshot); else output.info(JSON.stringify(snapshot, null, 2));
    } catch (error: any) { output.error(error.message); process.exitCode = 1; }
  },
};
