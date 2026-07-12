/**
 * pop vote results — option rankings + per-voter breakdown for one proposal.
 *
 * --proposal accepts a numeric ID or a fuzzy title query.
 *
 * The two validity parameters are DISTINCT and labeled as such:
 *   - support threshold — a PERCENTAGE of weighted voting power the winning
 *     option must reach (HybridVoting.thresholdPct)
 *   - quorum — a raw VOTER COUNT that must participate (HybridVoting.quorum,
 *     0 = disabled; a voter-count since PR #119, NOT a percentage)
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import * as output from '../../lib/output';
import { query } from '../../lib/subgraph';
import { resolveOrgModules } from '../../lib/resolve';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import { resolveProposalId } from './helpers';

interface ResultsArgs {
  org: string;
  proposal: string;
  chain?: number;
}

export const resultsHandler = {
  builder: (yargs: Argv) => yargs
    .option('proposal', { type: 'string', demandOption: true, describe: 'Proposal ID (number) or fuzzy title query' })
    .example('pop vote results --proposal 12', 'Rankings + voter breakdown for proposal #12')
    .example('pop vote results --proposal "bridge retry" --json', 'Fuzzy title query, machine-readable'),

  handler: async (argv: ArgumentsCamelCase<ResultsArgs>) => {
    const spin = output.spinner(`Fetching results for proposal ${argv.proposal}...`);
    spin.start();

    try {
      const modules = await resolveOrgModules(argv.org, argv.chain);
      const orgId = modules.orgId;
      if (!modules.hybridVotingAddress) {
        throw new CliError('No HybridVoting contract found for this org', EXIT.PRECONDITION);
      }

      const proposalId = await resolveProposalId(String(argv.proposal), modules.hybridVotingAddress, argv.chain);

      const q = `{
        organization(id: "${orgId}") {
          hybridVoting {
            thresholdPct
            quorum
            proposals(where: {proposalId: ${proposalId}}) {
              proposalId title status
              metadata { description optionNames }
              votes { voterUsername optionIndexes optionWeights }
            }
          }
        }
      }`;

      const result = await query<any>(q, {}, argv.chain);
      const hybridVoting = result.organization?.hybridVoting;
      const proposal = hybridVoting?.proposals?.[0];
      if (!proposal) throw new Error(`Proposal #${proposalId} not found`);

      // Two DISTINCT validity parameters — threshold is a % of weighted
      // power, quorum is a raw voter count. Never conflate them.
      const supportThresholdPct = hybridVoting.thresholdPct !== undefined ? Number(hybridVoting.thresholdPct) : undefined;
      const quorumVoterCount = hybridVoting.quorum !== undefined ? Number(hybridVoting.quorum) : undefined;

      const optionNames = proposal.metadata?.optionNames || [];
      const votes = proposal.votes || [];

      // Tally weighted votes per option
      const tallies: number[] = new Array(Math.max(optionNames.length, 1)).fill(0);
      for (const v of votes) {
        for (let i = 0; i < (v.optionIndexes || []).length; i++) {
          const idx = parseInt(v.optionIndexes[i]);
          const weight = parseInt(v.optionWeights[i]);
          if (idx < tallies.length) tallies[idx] += weight;
        }
      }

      // Rank options
      const ranked = optionNames.map((name: string, i: number) => ({
        rank: 0,
        option: i,
        name,
        score: tallies[i] || 0,
      })).sort((a: any, b: any) => b.score - a.score);

      ranked.forEach((r: any, i: number) => { r.rank = i + 1; });

      // Per-voter breakdown
      const voterBreakdown = votes.map((v: any) => {
        const allocations: Record<string, number> = {};
        for (let i = 0; i < (v.optionIndexes || []).length; i++) {
          const idx = parseInt(v.optionIndexes[i]);
          const name = optionNames[idx] || `Option ${idx}`;
          allocations[name] = parseInt(v.optionWeights[i]);
        }
        return { voter: v.voterUsername || 'unknown', allocations };
      });

      const report: any = {
        proposalId: proposal.proposalId,
        title: proposal.title,
        status: proposal.status,
        totalVoters: votes.length,
        supportThresholdPct,
        quorumVoterCount,
        ranking: ranked,
        voters: voterBreakdown,
        winner: ranked[0],
      };

      spin.stop();

      if (argv.json) {
        output.json(report);
      } else {
        console.log(`\n  Proposal #${proposal.proposalId}: ${proposal.title}`);
        console.log(`  Status: ${proposal.status} | Voters: ${votes.length}`);
        if (supportThresholdPct !== undefined || quorumVoterCount !== undefined) {
          const parts: string[] = [];
          if (supportThresholdPct !== undefined) parts.push(`Support threshold: ${supportThresholdPct}% of weighted power`);
          if (quorumVoterCount !== undefined) parts.push(`Quorum: ${quorumVoterCount} voters (0 = disabled)`);
          console.log(`  ${parts.join(' | ')}`);
        }
        console.log('  ' + '─'.repeat(50));
        for (const r of ranked) {
          const bar = '█'.repeat(Math.round(r.score / 5));
          console.log(`  #${r.rank} ${r.name}: ${r.score} ${bar}`);
        }
        console.log('');
        for (const v of voterBreakdown) {
          const alloc = Object.entries(v.allocations).map(([k, val]) => `${k}:${val}%`).join(', ');
          console.log(`  ${v.voter}: ${alloc}`);
        }
        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err.message);
      process.exit(1);
    }
  },
};
