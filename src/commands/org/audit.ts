import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { query } from '../../lib/subgraph';
import { resolveOrgModules } from '../../lib/resolve';
import { computeGini } from '../../lib/stats';
import * as output from '../../lib/output';

interface AuditArgs {
  org?: string;
  chain?: number;
}

const FETCH_AUDIT_DATA = `
  query FetchAuditData($orgId: Bytes!) {
    organization(id: $orgId) {
      name
      deployedAt
      participationToken { totalSupply symbol }
      users(orderBy: participationTokenBalance, orderDirection: desc, first: 100) {
        address
        participationTokenBalance
        membershipStatus
        totalTasksCompleted
        totalVotes
        account { username }
      }
      hybridVoting {
        proposals(first: 100) {
          proposalId
          title
          status
          numOptions
          votes {
            voter
            voterUsername
            optionIndexes
            optionWeights
          }
        }
      }
      taskManager {
        projects(where: { deleted: false }, first: 100) {
          title
          tasks(first: 1000) {
            taskId
            title
            status
            payout
            assignee
            assigneeUsername
            completer
            completerUsername
            createdAt
          }
        }
      }
      paymentManager {
        distributions(first: 50) {
          distributionId
          totalAmount
          totalClaimed
          status
          payoutToken
        }
      }
    }
  }
`;

export const auditHandler = {
  builder: (yargs: Argv) => yargs,

  handler: async (argv: ArgumentsCamelCase<AuditArgs>) => {
    const spin = output.spinner('Generating governance audit...');
    spin.start();

    try {
      const modules = await resolveOrgModules(argv.org, argv.chain);
      const result = await query<any>(FETCH_AUDIT_DATA, { orgId: modules.orgId }, argv.chain);
      const org = result.organization;
      if (!org) throw new Error('Organization not found');

      const activeMembers = org.users.filter((u: any) => u.membershipStatus === 'Active');
      const totalSupply = parseFloat(ethers.utils.formatEther(org.participationToken?.totalSupply || '0'));

      // PT distribution metrics
      const ptValues = activeMembers.map((u: any) =>
        parseFloat(ethers.utils.formatEther(u.participationTokenBalance || '0'))
      );
      const gini = computeGini(ptValues);
      const topHolder = activeMembers[0];
      const topShare = totalSupply > 0
        ? (parseFloat(ethers.utils.formatEther(topHolder?.participationTokenBalance || '0')) / totalSupply * 100).toFixed(1)
        : '0';

      // Proposal stats
      const proposals = org.hybridVoting?.proposals || [];
      const totalProposals = proposals.length;
      const executed = proposals.filter((p: any) => p.status === 'Executed').length;
      const unanimousVotes = proposals.filter((p: any) => {
        const votes = p.votes || [];
        if (votes.length < 2) return false;
        const firstOption = votes[0]?.optionIndexes?.[0];
        return votes.every((v: any) => v.optionIndexes?.[0] === firstOption);
      }).length;

      // Voter participation
      const voterCounts: Record<string, number> = {};
      for (const p of proposals) {
        for (const v of (p.votes || [])) {
          const name = v.voterUsername || v.voter;
          voterCounts[name] = (voterCounts[name] || 0) + 1;
        }
      }

      // Task stats
      const allTasks = (org.taskManager?.projects || []).flatMap((p: any) => p.tasks || []);
      const completedTasks = allTasks.filter((t: any) => t.status === 'Completed');
      const totalPTDistributed = completedTasks.reduce((s: number, t: any) =>
        s + parseFloat(ethers.utils.formatEther(t.payout || '0')), 0
      );

      // Review chain: who reviewed whose tasks
      const reviewPairs: Record<string, number> = {};
      for (const t of completedTasks) {
        const assignee = t.assigneeUsername || t.assignee?.slice(0, 10);
        const reviewer = t.completerUsername || t.completer?.slice(0, 10);
        if (assignee && reviewer && assignee !== reviewer) {
          const key = `${reviewer} → ${assignee}`;
          reviewPairs[key] = (reviewPairs[key] || 0) + 1;
        }
      }

      // Self-reviews — split into bootstrap-phase vs ongoing.
      // HB#473/#474 task #403: a solo-bootstrap agent necessarily self-completes
      // seed work because no other reviewers exist yet. Those self-reviews are
      // a historical scaffold, not an anti-pattern. We detect the bootstrap
      // boundary as the earliest cross-review (a completed task where assignee
      // !== completer). Self-reviews before that boundary are bootstrap; after
      // are ongoing anti-pattern signals.
      const selfReviewTasks = completedTasks.filter((t: any) =>
        t.assignee && t.completer && t.assignee.toLowerCase() === t.completer.toLowerCase()
      );
      const crossReviewTasks = completedTasks.filter((t: any) =>
        t.assignee && t.completer && t.assignee.toLowerCase() !== t.completer.toLowerCase()
      );
      const bootstrapEndTs = crossReviewTasks.length > 0
        ? Math.min(...crossReviewTasks.map((t: any) => parseInt(t.createdAt || '0')))
        : Infinity;
      const bootstrapSelfReviews = selfReviewTasks.filter((t: any) =>
        parseInt(t.createdAt || '0') < bootstrapEndTs
      ).length;
      const selfReviews = {
        total: selfReviewTasks.length,
        bootstrapPhase: bootstrapSelfReviews,
        ongoing: selfReviewTasks.length - bootstrapSelfReviews,
      };

      // Treasury
      const distributions = org.paymentManager?.distributions || [];
      const totalDistributed = distributions.reduce((s: number, d: any) =>
        s + parseFloat(ethers.utils.formatEther(d.totalAmount || '0')), 0
      );

      spin.stop();

      const auditData = {
        org: org.name,
        deployedAt: org.deployedAt ? new Date(parseInt(org.deployedAt) * 1000).toISOString().split('T')[0] : 'unknown',
        members: activeMembers.length,
        totalSupply: totalSupply.toFixed(1),
        ptGini: gini.toFixed(3),
        topHolder: topHolder?.account?.username || 'unknown',
        topHolderShare: `${topShare}%`,
        proposals: totalProposals,
        proposalsExecuted: executed,
        unanimousVotes,
        voterParticipation: voterCounts,
        tasksCompleted: completedTasks.length,
        totalPTEarned: totalPTDistributed.toFixed(1),
        reviewPairs,
        selfReviews,
        distributions: distributions.length,
        totalDistributed: totalDistributed.toFixed(2),
      };

      if (output.isJsonMode()) {
        output.json(auditData);
      } else {
        console.log('');
        console.log(`  Governance Audit — ${org.name}`);
        console.log('  ══════════════════════════════════════');
        console.log('');
        console.log('  Membership & PT Distribution');
        console.log('  ────────────────────────────');
        console.log(`  Active members:     ${activeMembers.length}`);
        console.log(`  Total PT supply:    ${totalSupply.toFixed(1)}`);
        console.log(`  PT Gini coeff:      ${gini.toFixed(3)} ${gini < 0.3 ? '(equitable)' : gini < 0.5 ? '(moderate)' : '(concentrated)'}`);
        console.log(`  Top holder:         ${topHolder?.account?.username || 'unknown'} (${topShare}%)`);
        for (const m of activeMembers) {
          const pt = parseFloat(ethers.utils.formatEther(m.participationTokenBalance || '0'));
          const share = totalSupply > 0 ? (pt / totalSupply * 100).toFixed(1) : '0';
          console.log(`    ${(m.account?.username || m.address.slice(0, 10)).padEnd(18)} ${pt.toFixed(1).padStart(8)} PT  (${share}%)`);
        }
        console.log('');
        console.log('  Governance Activity');
        console.log('  ──────────────────');
        console.log(`  Proposals total:    ${totalProposals}`);
        console.log(`  Executed:           ${executed}`);
        console.log(`  Unanimous votes:    ${unanimousVotes}/${proposals.filter((p: any) => (p.votes || []).length >= 2).length}`);
        console.log('  Voter participation:');
        for (const [voter, count] of Object.entries(voterCounts)) {
          console.log(`    ${String(voter).padEnd(18)} ${count} vote(s) / ${totalProposals} proposals`);
        }
        console.log('');
        console.log('  Task Economy');
        console.log('  ────────────');
        console.log(`  Tasks completed:    ${completedTasks.length}`);
        console.log(`  PT earned (total):  ${totalPTDistributed.toFixed(1)}`);
        console.log(`  Self-reviews:       ${selfReviews.total} total (${selfReviews.bootstrapPhase} bootstrap, ${selfReviews.ongoing} ongoing${selfReviews.ongoing === 0 ? ' — good' : ' — check these'})`);
        console.log('  Review chains:');
        for (const [pair, count] of Object.entries(reviewPairs)) {
          console.log(`    ${pair}: ${count} review(s)`);
        }
        console.log('');
        console.log('  Treasury');
        console.log('  ────────');
        console.log(`  Distributions:      ${distributions.length}`);
        console.log(`  Total distributed:  ${totalDistributed.toFixed(2)} tokens`);
        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
