import { refreshAuthorityUsers } from '../../lib/authority';
import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { queryAllChains } from '../../lib/subgraph';
import { pinJson } from '../../lib/ipfs';
import * as output from '../../lib/output';

interface AuditAllArgs {
  pin?: boolean;
}

const AUDIT_ALL_QUERY = `
  query AuditAll($first: Int!) {
    organizations(where: { membershipAuthority_: { isRouterBound: true, cutoverAt_gt: "0" } }, first: $first, orderBy: deployedAt, orderDirection: desc) {
      id name
      participationToken { totalSupply }
      users(first: 100) {
        address participationTokenBalance membershipStatus
        totalTasksCompleted totalVotes
      }
      hybridVoting {
        proposals(first: 100) { status votes { voter } }
      }
      taskManager {
        projects(where: { deleted: false }, first: 20) {
          tasks(first: 500) { status payout }
        }
      }
    }
  }
`;

export const auditAllHandler = {
  builder: (yargs: Argv) => yargs
    .option('pin', { type: 'boolean', default: false, describe: 'Pin ecosystem report to IPFS' }),

  handler: async (argv: ArgumentsCamelCase<AuditAllArgs>) => {
    const spin = output.spinner('Auditing all POP orgs...');
    spin.start();

    try {
      const results = await queryAllChains<any>(AUDIT_ALL_QUERY, { first: 20 });
      spin.stop();

      const audits: any[] = [];

      for (const chainResult of results) {
        if (!chainResult.data?.organizations) continue;
        for (const org of chainResult.data.organizations) {
          await refreshAuthorityUsers(org, org.id, chainResult.chainId);
          const members = (org.users || []).filter((u: any) => u.membershipStatus === 'Active');

          const supply = parseFloat(ethers.utils.formatEther(org.participationToken?.totalSupply || '0'));
          const proposals = org.hybridVoting?.proposals || [];
          const allTasks = (org.taskManager?.projects || []).flatMap((p: any) => p.tasks || []);
          const completed = allTasks.filter((t: any) => t.status === 'Completed').length;

          // Gini
          const bals = members.map((m: any) => parseFloat(ethers.utils.formatEther(m.participationTokenBalance || '0'))).sort((a: number, b: number) => a - b);
          let gini = 0;
          if (bals.length > 1 && supply > 0) {
            let s = 0;
            for (let i = 0; i < bals.length; i++)
              for (let j = 0; j < bals.length; j++)
                s += Math.abs(bals[i] - bals[j]);
            gini = s / (2 * bals.length * bals.length * (supply / bals.length));
          }

          // Score
          let score = 50;
          score += Math.min(20, members.length * 4);
          score += Math.min(15, proposals.length * 3);
          score += Math.min(15, (completed / Math.max(allTasks.length, 1)) * 15);
          if (gini > 0.5) score -= 10;
          if (proposals.length === 0 && members.length >= 3) score -= 10;
          score = Math.max(0, Math.min(100, Math.round(score)));

          audits.push({
            name: org.name || 'Unnamed',
            chain: chainResult.name,
            score,
            members: members.length,
            gini: parseFloat(gini.toFixed(3)),
            proposals: proposals.length,
            tasks: `${completed}/${allTasks.length}`,
          });
        }
      }

      audits.sort((a, b) => b.score - a.score);

      if (output.isJsonMode()) {
        output.json(audits);
      } else {
        console.log('');
        console.log('  POP Ecosystem Health Report');
        console.log('  Auditor: Argus | Date: ' + new Date().toISOString().split('T')[0]);
        console.log('  ' + '═'.repeat(60));
        output.table(
          ['Org', 'Chain', 'Score', 'Members', 'Gini', 'Proposals', 'Tasks'],
          audits.map(a => [
            a.name, a.chain, `${a.score}/100`,
            a.members.toString(), a.gini.toFixed(2),
            a.proposals.toString(), a.tasks,
          ])
        );
        console.log('');
      }

      if (argv.pin) {
        const report = { title: 'POP Ecosystem Health Report', auditor: 'Argus', date: new Date().toISOString().split('T')[0], orgs: audits };
        const cid = await pinJson(JSON.stringify(report));
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
