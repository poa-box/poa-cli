/**
 * pop treasury distributions — list distributions with claim + finalize state.
 *
 * State model (verified against contracts origin/main src/PaymentManager.sol):
 * a distribution is open for claims until finalizeDistribution runs (an
 * executor-only call, i.e. a governance vote — pop treasury propose-finalize).
 * Every non-finalized distribution is therefore "finalizable"; finalizing
 * blocks further claims and returns the unclaimed remainder to the treasury.
 *
 * JSON mode emits the same keys as the classic table rows (script-compatible)
 * plus additive raw fields (wei amounts, merkle root, checkpoint block, ...).
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { query } from '../../lib/subgraph';
import { resolveOrgId } from '../../lib/resolve';
import { FETCH_TREASURY_DATA } from '../../queries/treasury';
import { formatAddress } from '../../lib/encoding';
import { getTokenByAddress } from '../../config/tokens';
import * as output from '../../lib/output';

interface DistributionsArgs {
  org?: string;
  status?: string;
  chain?: number;
}

/** Known-token decimals without an RPC round-trip; 18 as the default. */
function displayDecimals(tokenAddress?: string): number {
  if (!tokenAddress || tokenAddress === ethers.constants.AddressZero) return 18;
  return getTokenByAddress(tokenAddress)?.decimals ?? 18;
}

export const distributionsHandler = {
  builder: (yargs: Argv) => yargs
    .option('status', { type: 'string', choices: ['Active', 'Finalized'], describe: 'Filter by status' })
    .example('pop treasury distributions', 'All distributions with claim totals and finalize state')
    .example('pop treasury distributions --status Active --json', 'Machine-readable list of still-claimable distributions')
    .epilogue(
      'Active distributions stay claimable until governance finalizes them '
      + '(pop treasury propose-finalize); claim yours with pop treasury claim-mine.'
    ),

  handler: async (argv: ArgumentsCamelCase<DistributionsArgs>) => {
    const spin = output.spinner('Fetching distributions...');
    spin.start();

    try {
      const orgId = await resolveOrgId(argv.org, argv.chain);
      const result = await query<any>(FETCH_TREASURY_DATA, { orgId }, argv.chain);
      let distributions = result.organization?.paymentManager?.distributions || [];

      if (argv.status) {
        distributions = distributions.filter((d: any) => d.status === argv.status);
      }

      spin.stop();

      const enriched = distributions.map((d: any) => {
        const decimals = displayDecimals(d.payoutToken);
        const totalWei = ethers.BigNumber.from(d.totalAmount || '0');
        const claimedWei = ethers.BigNumber.from(d.totalClaimed || '0');
        const unclaimedWei = totalWei.gt(claimedWei) ? totalWei.sub(claimedWei) : ethers.BigNumber.from(0);
        const finalized = d.status === 'Finalized';
        return {
          d,
          decimals,
          finalized,
          total: ethers.utils.formatUnits(totalWei, decimals),
          claimed: ethers.utils.formatUnits(claimedWei, decimals),
          unclaimed: ethers.utils.formatUnits(unclaimedWei, decimals),
          unclaimedWei,
          claimCount: (d.claims || []).length,
        };
      });

      if (output.isJsonMode()) {
        // Same keys as the classic table rows, plus additive raw fields.
        output.json(enriched.map(({ d, decimals, finalized, total, claimed, unclaimed, claimCount }: any) => ({
          ID: d.distributionId,
          Status: d.status,
          Token: formatAddress(d.payoutToken || ''),
          Total: total,
          Claimed: `${claimed} (${claimCount} claims)`,
          Created: d.createdAt ? new Date(parseInt(d.createdAt) * 1000).toLocaleDateString() : '',
          distributionId: d.distributionId,
          status: d.status,
          finalized,
          finalizable: !finalized,
          payoutToken: d.payoutToken || null,
          decimals,
          totalAmountWei: d.totalAmount || '0',
          totalClaimedWei: d.totalClaimed || '0',
          unclaimed,
          unclaimedWei: ethers.BigNumber.from(d.totalAmount || '0').gt(d.totalClaimed || '0')
            ? ethers.BigNumber.from(d.totalAmount || '0').sub(d.totalClaimed || '0').toString()
            : '0',
          claimCount,
          checkpointBlock: d.checkpointBlock ? Number(d.checkpointBlock) : null,
          merkleRoot: d.merkleRoot || null,
          createdAt: d.createdAt ? Number(d.createdAt) : null,
          finalizedAt: d.finalizedAt ? Number(d.finalizedAt) : null,
        })));
        return;
      }

      if (distributions.length === 0) {
        output.info('No distributions found');
        return;
      }

      const rows = enriched.map(({ d, finalized, total, claimed, unclaimed, unclaimedWei, claimCount }: any) => [
        d.distributionId,
        finalized ? 'Finalized' : 'Active',
        formatAddress(d.payoutToken || ''),
        total,
        `${claimed} (${claimCount} claims)`,
        finalized ? (unclaimedWei.gt(0) ? `${unclaimed} returned` : '—') : unclaimed,
        d.createdAt ? new Date(parseInt(d.createdAt) * 1000).toLocaleDateString() : '',
      ]);

      output.table(['ID', 'Status', 'Token', 'Total', 'Claimed', 'Unclaimed', 'Created'], rows);

      const activeCount = enriched.filter((e: any) => !e.finalized).length;
      if (activeCount > 0) {
        output.info('Active distributions are claimable (pop treasury claim-mine) until governance finalizes them (pop treasury propose-finalize).');
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
