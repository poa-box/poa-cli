import type { Argv, ArgumentsCamelCase } from 'yargs';
import { readTokenHolderTotals } from '@poa-box/core/reads/token';
import { createIndexedSource } from '../../lib/indexed-source';
import { resolveNetworkConfig } from '../../config/networks';
import { resolveOrgModules, requireModule } from '../../lib/resolve';
import * as output from '../../lib/output';
export const holdersHandler = {
  builder: (y: Argv) => y.option('page-size', { type: 'number', default: 100, describe: 'Holder page size (1–1000)' })
    .option('max-pages', { type: 'number', default: 20, describe: 'Finite enumeration cap; totals remain unknown until supply reconciles' }),
  handler: async (argv: ArgumentsCamelCase<{ org?: string; chain?: number; pageSize: number; maxPages: number }>) => {
    try {
      const modules = await resolveOrgModules(argv.org, argv.chain), config = resolveNetworkConfig(argv.chain);
      if (!Number.isSafeInteger(argv.maxPages) || argv.maxPages < 1 || argv.maxPages > 1000) throw new Error('Invalid holder page bounds');
      const indexed = await createIndexedSource({ chainId: config.chainId, orgId: modules.orgId, contract: requireModule(modules, 'participationTokenAddress') });
      const result = await readTokenHolderTotals({ source: indexed.source, query: indexed.protocolQuery, pageSize: argv.pageSize, maxPages: argv.maxPages });
      if (output.isJsonMode()) output.json(result); else output.info(JSON.stringify(result, null, 2));
    } catch (error: any) { output.error(error.message); process.exitCode = 1; }
  },
};
