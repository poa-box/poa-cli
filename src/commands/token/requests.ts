/**
 * pop token requests — list participation-token requests from the subgraph.
 *
 * JSON mode emits the same keys as the classic table rows (script-compatible)
 * plus additive raw fields (full requester address, wei amount, ipfs hash,
 * unix timestamps). An empty result is an explicit empty array in JSON.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { query } from '../../lib/subgraph';
import { FETCH_PENDING_TOKEN_REQUESTS, FETCH_ALL_TOKEN_REQUESTS } from '../../queries/token';
import { formatAddress } from '../../lib/encoding';
import { formatToken } from '../../lib/format';
import * as output from '../../lib/output';
import { resolveTokenAddress } from './helpers';

interface RequestsArgs {
  org?: string;
  status?: string;
  chain?: number;
}

export const requestsHandler = {
  builder: (yargs: Argv) => yargs
    .option('status', { type: 'string', choices: ['pending', 'all'], default: 'pending', describe: 'Filter by status' })
    .example('pop token requests', 'Pending requests awaiting an approver')
    .example('pop token requests --status all --json', 'Full request history, machine-readable'),

  handler: async (argv: ArgumentsCamelCase<RequestsArgs>) => {
    const spin = output.spinner('Fetching token requests...');
    spin.start();

    try {
      const { tokenAddress } = await resolveTokenAddress(argv.org, argv.chain);

      const gqlQuery = argv.status === 'all' ? FETCH_ALL_TOKEN_REQUESTS : FETCH_PENDING_TOKEN_REQUESTS;
      const result = await query<any>(gqlQuery, { tokenAddress }, argv.chain);
      const requests = result.tokenRequests || [];

      spin.stop();

      if (output.isJsonMode()) {
        // Same keys as the classic table rows, plus additive raw fields.
        output.json(requests.map((r: any) => ({
          ID: r.requestId,
          Requester: formatAddress(r.requester || ''),
          Amount: `${ethers.utils.formatUnits(r.amount || '0', 18)} PT`,
          Reason: r.metadata?.reason || '',
          Status: r.status,
          Date: r.createdAt ? new Date(parseInt(r.createdAt) * 1000).toLocaleDateString() : '',
          requestId: r.requestId,
          requester: r.requester || null,
          amountWei: r.amount || '0',
          ipfsHash: r.ipfsHash || null,
          status: r.status,
          createdAt: r.createdAt ? Number(r.createdAt) : null,
          approvedAt: r.approvedAt ? Number(r.approvedAt) : null,
          cancelledAt: r.cancelledAt ? Number(r.cancelledAt) : null,
          approver: r.approver || null,
          transactionHash: r.transactionHash || null,
        })));
        return;
      }

      if (requests.length === 0) {
        output.info('No token requests found');
        return;
      }

      const rows = requests.map((r: any) => [
        r.requestId,
        formatAddress(r.requester || ''),
        formatToken(r.amount || '0', 18, 'PT'),
        r.metadata?.reason || '',
        r.status,
        r.createdAt ? new Date(parseInt(r.createdAt) * 1000).toLocaleDateString() : '',
      ]);

      output.table(['ID', 'Requester', 'Amount', 'Reason', 'Status', 'Date'], rows);

      if (argv.status !== 'all' && requests.length > 0) {
        output.info('Approve one with: pop token approve --request <id> (mints PT to the requester)');
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
