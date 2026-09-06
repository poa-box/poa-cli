import type { Argv, ArgumentsCamelCase } from 'yargs';
import { query, queryAllChains } from '../../lib/subgraph';
import { listUserOrganizations } from '@poa-box/core/reads/org';
import { subgraphModuleClient } from '../../lib/subgraph-module-client';
import { formatAddress } from '../../lib/encoding';
import * as output from '../../lib/output';

interface ListArgs {
  chain?: number;
  member?: string;
}

const LIST_ORGS_QUERY = `
  query ListOrgs($first: Int!) {
    organizations(where: { membershipAuthority_: { isRouterBound: true, cutoverAt_gt: "0" } }, first: $first, orderBy: deployedAt, orderDirection: desc) {
      id
      name
      deployedAt
    }
  }
`;

export const listHandler = {
  builder: (yargs: Argv) => yargs
    .option('chain', { type: 'number', describe: 'Chain ID (omit to search all chains)' })
    .option('member', { type: 'string', describe: 'Filter by member address' }),

  handler: async (argv: ArgumentsCamelCase<ListArgs>) => {
    const spin = output.spinner('Fetching organizations...');
    spin.start();

    try {
      if (argv.member) {
        // Search for orgs where this address is a member
        const users = await listUserOrganizations(subgraphModuleClient(), argv.member, argv.chain);
        spin.stop();

        if (users.length === 0) {
          output.info('No organizations found for this member');
          return;
        }

        const rows = users
          .filter((u: any) => u.organization)
          .map((u: any) => [
            u.organization.id,
            u.organization.name || 'Unnamed',
            u.participationTokenBalance || '0',
            u.totalTasksCompleted?.toString() || '0',
            u.membershipStatus,
          ]);

        output.table(['Org ID', 'Name', 'PT Balance', 'Tasks Done', 'Status'], rows);
      } else {
        // List all orgs, optionally on a specific chain
        if (argv.chain) {
          const result = await query<any>(LIST_ORGS_QUERY, { first: 50 }, argv.chain);
          spin.stop();

          const orgs = result.organizations || [];
          if (orgs.length === 0) {
            output.info('No organizations found');
            return;
          }

          const rows = orgs.map((o: any) => [
            formatAddress(o.id, 8),
            o.name || 'Unnamed',
            o.deployedAt ? new Date(parseInt(o.deployedAt) * 1000).toLocaleDateString() : '',
          ]);

          output.table(['Org ID', 'Name', 'Deployed'], rows);
        } else {
          // Query all non-testnet chains in parallel
          const results = await queryAllChains<any>(LIST_ORGS_QUERY, { first: 50 });
          spin.stop();

          const rows: string[][] = [];
          for (const chainResult of results) {
            if (!chainResult.data?.organizations) continue;
            for (const o of chainResult.data.organizations) {
              rows.push([
                formatAddress(o.id, 8),
                o.name || 'Unnamed',
                chainResult.name,
                o.deployedAt ? new Date(parseInt(o.deployedAt) * 1000).toLocaleDateString() : '',
              ]);
            }
          }

          if (rows.length === 0) {
            output.info('No organizations found across any chain');
            return;
          }

          output.table(['Org ID', 'Name', 'Chain', 'Deployed'], rows);
        }
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
