import { refreshAuthorityUsers } from '../../lib/authority';
import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { queryAllChains } from '../../lib/subgraph';
import { pinJson } from '../../lib/ipfs';
import * as output from '../../lib/output';

interface AuditExternalArgs {
  target: string;
  chain?: number;
  pin?: boolean;
}

const AUDIT_QUERY = `
  query AuditOrg($name: String!) {
    organizations(where: { name: $name, membershipAuthority_: { isRouterBound: true, cutoverAt_gt: "0" } }, first: 1) {
      id name deployedAt
      participationToken { totalSupply symbol }
      users(orderBy: participationTokenBalance, orderDirection: desc, first: 100) {
        address participationTokenBalance membershipStatus
        totalTasksCompleted totalVotes
        account { username }
      }
      hybridVoting {
        proposals(first: 100) {
          proposalId title status winningOption wasExecuted
          votes { voter voterUsername }
        }
      }
      taskManager {
        projects(where: { deleted: false }, first: 20) {
          title
          tasks(first: 500) { taskId title status payout assigneeUsername completerUsername }
        }
      }
      paymentManager { distributionCounter distributions(first: 10) { totalAmount status } }
    }
  }
`;

export const auditExternalHandler = {
  builder: (yargs: Argv) => yargs
    .option('target', { type: 'string', demandOption: true, describe: 'Org name to audit' })
    .option('chain', { type: 'number', describe: 'Chain ID (omit to search all)' })
    .option('pin', { type: 'boolean', default: false, describe: 'Pin report to IPFS' }),

  handler: async (argv: ArgumentsCamelCase<AuditExternalArgs>) => {
    const spin = output.spinner(`Auditing ${argv.target}...`);
    spin.start();

    try {
      const results = await queryAllChains<any>(AUDIT_QUERY, { name: argv.target });

      let org: any = null;
      let chainName = '';
      let chainId: number | undefined;
      for (const r of results) {
        if (r.data?.organizations?.[0]) {
          org = r.data.organizations[0];
          chainName = r.name;
          chainId = r.chainId;
          break;
        }
      }

      if (!org) {
        spin.stop();
        output.error(`Org "${argv.target}" not found on any chain`);
        process.exit(1);
        return;
      }

      await refreshAuthorityUsers(org, org.id, chainId);

      // Analyze
      const members = (org.users || []).filter((u: any) => u.membershipStatus === 'Active');
      const supply = parseFloat(ethers.utils.formatEther(org.participationToken?.totalSupply || '0'));
      const proposals = org.hybridVoting?.proposals || [];
      const allTasks = (org.taskManager?.projects || []).flatMap((p: any) =>
        (p.tasks || []).map((t: any) => ({ ...t, project: p.title }))
      );

      // PT Distribution & Gini
      const balances = members.map((m: any) => parseFloat(ethers.utils.formatEther(m.participationTokenBalance || '0'))).sort((a: number, b: number) => a - b);
      let gini = 0;
      if (balances.length > 1 && supply > 0) {
        let sumDiffs = 0;
        for (let i = 0; i < balances.length; i++)
          for (let j = 0; j < balances.length; j++)
            sumDiffs += Math.abs(balances[i] - balances[j]);
        gini = sumDiffs / (2 * balances.length * balances.length * (supply / balances.length));
      }

      // Voting participation
      const voterCounts: Record<string, number> = {};
      for (const p of proposals) {
        for (const v of p.votes || []) {
          voterCounts[v.voterUsername || v.voter] = (voterCounts[v.voterUsername || v.voter] || 0) + 1;
        }
      }

      // Task stats
      const completed = allTasks.filter((t: any) => t.status === 'Completed').length;
      const open = allTasks.filter((t: any) => t.status === 'Open').length;
      const totalPT = allTasks.filter((t: any) => t.status === 'Completed')
        .reduce((sum: number, t: any) => sum + parseFloat(ethers.utils.formatEther(t.payout || '0')), 0);

      // Risks
      const risks: string[] = [];
      if (gini > 0.5) risks.push(`High PT concentration (Gini: ${gini.toFixed(3)})`);
      if (members.length > 0 && balances[balances.length - 1] / supply > 0.5) {
        risks.push(`Top holder controls ${((balances[balances.length - 1] / supply) * 100).toFixed(1)}% of PT`);
      }
      if (proposals.length > 3 && Object.keys(voterCounts).length < members.length * 0.5) {
        risks.push('Low voter participation — less than half of members have voted');
      }
      if (completed > 0 && open / completed > 2) {
        risks.push(`Task completion bottleneck: ${open} open vs ${completed} done`);
      }
      if (members.length >= 5 && proposals.length === 0) {
        risks.push('No governance activity despite active membership');
      }

      // Health score (simplified)
      let score = 50;
      score += Math.min(20, members.length * 4);
      score += Math.min(15, proposals.length * 3);
      score += Math.min(15, (completed / Math.max(allTasks.length, 1)) * 15);
      score -= risks.length * 5;
      score = Math.max(0, Math.min(100, Math.round(score)));

      const report = {
        org: org.name,
        chain: chainName,
        auditor: 'Argus',
        date: new Date().toISOString().split('T')[0],
        healthScore: score,
        summary: {
          members: members.length,
          ptSupply: Math.round(supply),
          ptGini: parseFloat(gini.toFixed(3)),
          proposals: proposals.length,
          proposalsExecuted: proposals.filter((p: any) => p.wasExecuted).length,
          tasksTotal: allTasks.length,
          tasksCompleted: completed,
          tasksOpen: open,
          ptEarned: Math.round(totalPT),
        },
        topHolders: members.slice(0, 5).map((m: any) => ({
          name: m.account?.username || m.address.slice(0, 10),
          pt: parseFloat(ethers.utils.formatEther(m.participationTokenBalance || '0')).toFixed(0),
          tasks: m.totalTasksCompleted || 0,
          votes: m.totalVotes || 0,
        })),
        voterParticipation: voterCounts,
        risks,
        recommendations: risks.map(r => {
          if (r.includes('concentration')) return 'Distribute tasks more broadly to reduce PT concentration';
          if (r.includes('participation')) return 'Consider reducing quorum or implementing vote reminders';
          if (r.includes('bottleneck')) return 'Review task assignment and completion workflows';
          if (r.includes('No governance')) return 'Create initial proposals to activate governance';
          return 'Review governance practices';
        }),
      };

      spin.stop();

      if (output.isJsonMode()) {
        output.json(report);
      } else {
        console.log('');
        console.log(`  Governance Audit: ${org.name} (${chainName})`);
        console.log(`  Auditor: Argus | Date: ${report.date}`);
        console.log('  ' + '═'.repeat(50));
        console.log(`  Health Score: ${score}/100`);
        console.log(`  Members: ${members.length} | PT Supply: ${Math.round(supply)} | Gini: ${gini.toFixed(3)}`);
        console.log(`  Proposals: ${proposals.length} (${proposals.filter((p: any) => p.wasExecuted).length} executed)`);
        console.log(`  Tasks: ${completed}/${allTasks.length} completed | ${open} open`);
        if (risks.length > 0) {
          console.log('');
          console.log('  Risks:');
          for (const r of risks) console.log(`    ⚠ ${r}`);
        }
        if (report.recommendations.length > 0) {
          console.log('');
          console.log('  Recommendations:');
          for (const r of report.recommendations) console.log(`    → ${r}`);
        }
        console.log('');
      }

      if (argv.pin) {
        spin.start();
        spin.text = 'Pinning report to IPFS...';
        const cid = await pinJson(JSON.stringify(report));
        spin.stop();
        console.log(`  📌 Pinned: https://ipfs.io/ipfs/${cid}`);
        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
