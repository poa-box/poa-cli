import type { Argv, ArgumentsCamelCase } from 'yargs';
import { listEducationModulesComplete, listCompletionsComplete, readEducationCompletionTotals } from '@poa-box/core/reads/education';
import { requireAddress } from '@poa-box/core/validation';
import { createIndexedSource } from '../../lib/indexed-source';
import { resolveOrgModules, requireModule } from '../../lib/resolve';
import { resolveNetworkConfig } from '../../config/networks';
import * as output from '../../lib/output';
import { EXIT } from '../../lib/exit-codes';

export const snapshotHandler = {
  builder: (yargs: Argv) => yargs
    .option('learner', { type: 'string', describe: 'Include this account’s independently paged completion history' })
    .option('page-size', { type: 'number', default: 100, describe: 'Rows per page (1–1000)' })
    .option('max-pages', { type: 'number', default: 100, describe: 'Maximum pages per collection' }),
  handler: async (argv: ArgumentsCamelCase<{ org: string; chain?: number; learner?: string; pageSize: number; maxPages: number }>) => {
    try {
      const learner = argv.learner ? requireAddress(argv.learner, 'learner') : undefined;
      const chainId = resolveNetworkConfig(argv.chain).chainId;
      const modules = await resolveOrgModules(argv.org, chainId);
      const host = await createIndexedSource({ chainId, orgId: modules.orgId, contract: requireModule(modules, 'educationHubAddress') });
      const options = { source: host.source, query: host.protocolQuery, pageSize: argv.pageSize, maxPages: argv.maxPages };
      const [library, totals, completions] = await Promise.all([
        listEducationModulesComplete(options), readEducationCompletionTotals(options),
        learner ? listCompletionsComplete({ ...options, source: { ...options.source, account: learner } }) : undefined,
      ]);
      output.json({ library, totals, ...(learner ? { completions } : {}) });
    } catch (err: any) { output.error(err?.message || String(err)); process.exit(EXIT.INFRA); }
  },
};
