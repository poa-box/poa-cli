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
import { queryWithFieldFallback } from '../../lib/subgraph';
import { resolveOrgModules } from '../../lib/resolve';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import { resolveProposalId } from './helpers';
import { fetchProposalResultsByOrgId } from '@poa-box/core/reads/vote';

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

      const report = await fetchProposalResultsByOrgId({ queryWithFieldFallback }, orgId, proposalId, argv.chain);
      const { proposedBy, classConfigDrifted, classVersionAtCreation, liveClassVersion,
        supportThresholdPct, quorumVoterCount, ranking: ranked, voters: voterBreakdown } = report;

      spin.stop();

      if (argv.json) {
        output.json(report);
      } else {
        console.log(`\n  Proposal #${report.proposalId}: ${report.title}`);
        console.log(`  Status: ${report.status} | Voters: ${report.totalVoters}${proposedBy ? ` | Proposed by: ${proposedBy}` : ''}`);
        if (report.promotedFrom) console.log(`  Promoted from: ${report.promotedFrom}`);
        if (report.actionSummaries.length) {
          console.log('  Enacts:');
          for (const a of report.actionSummaries) console.log(`    - ${a}`);
        }
        if (report.executedAt) {
          console.log(`  Executed: ${new Date(report.executedAt * 1000).toISOString()}`
            + (report.executedCallsCount != null ? ` (${report.executedCallsCount} call(s))` : ''));
        }
        if (classConfigDrifted) {
          console.log(
            `  ⚠️  Created under voting-class config v${classVersionAtCreation}, live is v${liveClassVersion} —`
          );
          // classVersion versions the voting-CLASS array (weights/strategies) only. thresholdPct
          // and quorum are written by separate events and are NOT snapshotted per proposal, so
          // the values printed below remain the applicable ones — do not impugn them here.
          console.log('     its class weights/strategies are those in force at creation.');
        }
        if (supportThresholdPct !== undefined || quorumVoterCount !== undefined) {
          const parts: string[] = [];
          if (supportThresholdPct !== undefined) parts.push(`Support threshold: ${supportThresholdPct}% of weighted power`);
          if (quorumVoterCount !== undefined) parts.push(`Global quorum: ${quorumVoterCount} voters (0 = disabled)`);
          console.log(`  ${parts.join(' | ')}`);
        }
        if (report.effectiveQuorumVoterCount === null) console.log('  Effective quorum unavailable: restricted polls can override the global quorum.');
        console.log('  Ranking sums ballot allocations; use vote analyze for class-weighted voting power.');
        console.log(report.winnerSource === 'announced' ? `  Announced winner: option ${report.announcedWinningOption}`
          : report.winnerSource === 'invalid' ? '  Announced result: invalid; no winning option passed.'
            : '  Winner has not been announced.');
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
