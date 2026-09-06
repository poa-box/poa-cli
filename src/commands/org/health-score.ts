import { refreshAuthorityUsers } from '../../lib/authority';
import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { query } from '../../lib/subgraph';
import { resolveOrgModules } from '../../lib/resolve';
import { resolveNetworkConfig } from '../../config/networks';
import { computeGini } from '../../lib/stats';
import * as output from '../../lib/output';

interface HealthScoreArgs {
  org?: string;
  chain?: number;
}

const FETCH_HEALTH_DATA = `
  query FetchHealthData($orgId: Bytes!) {
    organization(id: $orgId) {
      name
      participationToken { totalSupply }
      users(first: 100) {
        address participationTokenBalance
        membershipStatus
        totalTasksCompleted
        totalVotes
      }
      hybridVoting {
        proposals(first: 100) {
          status
          votes { voter }
        }
      }
      taskManager {
        projects(where: { deleted: false }, first: 100) {
          tasks(first: 1000) { status }
        }
      }
      paymentManager {
        distributions(first: 50) { totalAmount status }
      }
    }
  }
`;

export const healthScoreHandler = {
  builder: (yargs: Argv) => yargs,

  handler: async (argv: ArgumentsCamelCase<HealthScoreArgs>) => {
    const spin = output.spinner('Computing health score...');
    spin.start();

    try {
      const modules = await resolveOrgModules(argv.org, argv.chain);
      const result = await query<any>(FETCH_HEALTH_DATA, { orgId: modules.orgId }, argv.chain);
      const org = result.organization;
      if (!org) throw new Error('Organization not found');

      await refreshAuthorityUsers(org, modules.orgId, argv.chain);

      const activeMembers = org.users.filter((u: any) => u.membershipStatus === 'Active');
      const memberCount = activeMembers.length;

      // --- Score components (each 0-20, total 0-100) ---

      // 1. Member activity (0-20): do members complete tasks and vote?
      const totalTasks = activeMembers.reduce((s: number, u: any) => s + parseInt(u.totalTasksCompleted || '0'), 0);
      const totalVotes = activeMembers.reduce((s: number, u: any) => s + parseInt(u.totalVotes || '0'), 0);
      const avgTasksPerMember = memberCount > 0 ? totalTasks / memberCount : 0;
      const avgVotesPerMember = memberCount > 0 ? totalVotes / memberCount : 0;
      const activityScore = Math.min(20, Math.round(
        (Math.min(avgTasksPerMember, 10) / 10) * 10 +
        (Math.min(avgVotesPerMember, 5) / 5) * 10
      ));

      // 2. PT equity (0-20): how fairly is PT distributed?
      const ptValues = activeMembers.map((u: any) =>
        parseFloat(ethers.utils.formatEther(u.participationTokenBalance || '0'))
      );
      const gini = computeGini(ptValues);
      const equityScore = Math.round((1 - gini) * 20);

      // 3. Governance participation (0-20): do proposals get votes?
      const proposals = org.hybridVoting?.proposals || [];
      const multiVoterProposals = proposals.filter((p: any) => (p.votes || []).length >= 2);
      const govParticipation = proposals.length > 0
        ? multiVoterProposals.length / proposals.length
        : 0;
      const govScore = Math.round(govParticipation * 20);

      // 4. Task completion rate (0-20): are tasks getting done?
      const allTasks = (org.taskManager?.projects || []).flatMap((p: any) => p.tasks || []);
      const completed = allTasks.filter((t: any) => t.status === 'Completed').length;
      const completionRate = allTasks.length > 0 ? completed / allTasks.length : 0;
      const taskScore = Math.round(completionRate * 20);

      // 5. Org maturity (0-20): size, diversity, treasury
      const sizeScore = Math.min(5, memberCount);
      const hasTreasury = (org.paymentManager?.distributions || []).length > 0 ? 5 : 0;
      const hasProposals = proposals.length >= 3 ? 5 : proposals.length >= 1 ? 3 : 0;
      const hasTasks = totalTasks >= 10 ? 5 : totalTasks >= 3 ? 3 : totalTasks >= 1 ? 1 : 0;
      const maturityScore = sizeScore + hasTreasury + hasProposals + hasTasks;

      const totalScore = activityScore + equityScore + govScore + taskScore + maturityScore;
      const grade = totalScore >= 90 ? 'A' : totalScore >= 75 ? 'B' : totalScore >= 60 ? 'C' : totalScore >= 40 ? 'D' : 'F';

      spin.stop();

      const scoreData = {
        org: org.name,
        score: totalScore,
        grade,
        breakdown: {
          activity: { score: activityScore, max: 20, detail: `${avgTasksPerMember.toFixed(1)} tasks/member, ${avgVotesPerMember.toFixed(1)} votes/member` },
          equity: { score: equityScore, max: 20, detail: `Gini: ${gini.toFixed(3)}` },
          governance: { score: govScore, max: 20, detail: `${multiVoterProposals.length}/${proposals.length} proposals with 2+ voters` },
          tasks: { score: taskScore, max: 20, detail: `${completed}/${allTasks.length} completed (${(completionRate * 100).toFixed(0)}%)` },
          maturity: { score: maturityScore, max: 20, detail: `${memberCount} members, ${proposals.length} proposals, ${hasTreasury ? 'has' : 'no'} distributions` },
        },
      };

      if (output.isJsonMode()) {
        output.json(scoreData);
      } else {
        console.log('');
        console.log(`  ${org.name} Health Score: ${totalScore}/100 (${grade})`);
        console.log('  ' + '═'.repeat(45));
        const bar = (score: number, max: number) => {
          const filled = Math.round((score / max) * 20);
          return '█'.repeat(filled) + '░'.repeat(20 - filled);
        };
        console.log(`  Activity:    ${bar(activityScore, 20)} ${activityScore}/20  ${scoreData.breakdown.activity.detail}`);
        console.log(`  Equity:      ${bar(equityScore, 20)} ${equityScore}/20  ${scoreData.breakdown.equity.detail}`);
        console.log(`  Governance:  ${bar(govScore, 20)} ${govScore}/20  ${scoreData.breakdown.governance.detail}`);
        console.log(`  Tasks:       ${bar(taskScore, 20)} ${taskScore}/20  ${scoreData.breakdown.tasks.detail}`);
        console.log(`  Maturity:    ${bar(maturityScore, 20)} ${maturityScore}/20  ${scoreData.breakdown.maturity.detail}`);
        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
