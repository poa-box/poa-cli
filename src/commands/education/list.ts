import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { listEducationModulesComplete, readEducationCompletionTotals } from '@poa-box/core/reads/education';
import { createIndexedSource } from '../../lib/indexed-source';
import { resolveNetworkConfig } from '../../config/networks';
import { resolveOrgModules, requireModule } from '../../lib/resolve';
import * as output from '../../lib/output';

interface ListArgs {
  org: string;
  chain?: number;
}


export const listHandler = {
  builder: (yargs: Argv) => yargs,

  handler: async (argv: ArgumentsCamelCase<ListArgs>) => {
    const spin = output.spinner('Fetching education modules...');
    spin.start();

    try {
      const chainId = resolveNetworkConfig(argv.chain).chainId;
      const modules_ = await resolveOrgModules(argv.org, chainId);
      const host = await createIndexedSource({ chainId, orgId: modules_.orgId, contract: requireModule(modules_, 'educationHubAddress') });
      const options = { source: host.source, query: host.protocolQuery, pageSize: 100, maxPages: 100 };
      const [library, totals] = await Promise.all([listEducationModulesComplete(options), readEducationCompletionTotals(options)]);
      const modules = library.data;
      if (library.coverage.status === 'unavailable' || (!modules.length && library.coverage.status !== 'complete')) {
        throw new Error('Education library is unavailable; absence cannot be established');
      }
      const completionRows = totals.data.evidence.completions;
      const countsKnown = completionRows.coverage.status === 'complete' && totals.coverage.status === 'complete';
      const counts = new Map<string, number>();
      if (countsKnown) for (const row of completionRows.data) counts.set(String(row.moduleId), (counts.get(String(row.moduleId)) ?? 0) + 1);

      spin.stop();

      if (modules.length === 0) {
        if (output.isJsonMode()) output.json([]);
        else output.info('No education modules found');
        return;
      }

      const rows = modules.map((m: any) => {
        const payout = m.payout == null ? '(unknown)' : `${ethers.utils.formatUnits(String(m.payout), 18)} PT`;
        const completions = countsKnown ? String(counts.get(String(m.moduleId)) ?? 0) : '(unknown)';
        const metadata = m.metadata as Record<string, unknown> | null;
        return [
          String(m.moduleId),
          String(m.title || 'Untitled'),
          String(m.status ?? '(unknown)'),
          payout,
          `${completions}`,
          String(metadata?.link || ''),
        ];
      });

      if (!output.isJsonMode() && library.coverage.status !== 'complete') output.warn('Education library is incomplete; showing observed modules. See pop education snapshot --json for coverage.');
      output.table(
        ['ID', 'Title', 'Status', 'Reward', 'Completions', 'Link'],
        rows
      );
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
