import { refreshAuthorityUsers } from '../../lib/authority';
import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { queryAllChains } from '../../lib/subgraph';
import * as output from '../../lib/output';

interface ExploreArgs {
  chain?: number;
  detail?: string;
}

const EXPLORE_QUERY = `
  query ExploreOrgs($first: Int!) {
    organizations(where: { membershipAuthority_: { isRouterBound: true, cutoverAt_gt: "0" } }, first: $first, orderBy: deployedAt, orderDirection: desc) {
      id
      name
      deployedAt
      users(first: 100) {
        address membershipStatus
      }
      taskManager {
        projects(where: { deleted: false }, first: 10) {
          tasks(first: 100) {
            status
            payout
          }
        }
      }
      hybridVoting {
        proposals(where: { status: "Active" }, first: 10) {
          proposalId
          title
          endTimestamp
        }
      }
      participationToken {
        totalSupply
      }
    }
  }
`;

export const exploreHandler = {
  builder: (yargs: Argv) => yargs
    .option('chain', { type: 'number', describe: 'Filter to specific chain' })
    .option('opportunities', { type: 'boolean', default: false, describe: 'Show actionable opportunities for Argus' })
    .option('detail', { type: 'string', describe: 'Deep-scan a specific org by name' }),

  handler: async (argv: ArgumentsCamelCase<ExploreArgs>) => {
    // --detail mode: deep-scan a single org
    if (argv.detail) {
      const spin = output.spinner(`Deep-scanning ${argv.detail}...`);
      spin.start();
      try {
        const detailQuery = `
          query DetailOrg($name: String!) {
            organizations(where: { name: $name, membershipAuthority_: { isRouterBound: true, cutoverAt_gt: "0" } }, first: 1) {
              id name deployedAt
              participationToken { totalSupply }
              users(orderBy: participationTokenBalance, orderDirection: desc, first: 100) {
                address participationTokenBalance membershipStatus
                totalTasksCompleted totalVotes
                account { username }
              }
              taskManager {
                projects(where: { deleted: false }, first: 20) {
                  title
                  tasks(first: 200) { taskId title status payout assigneeUsername }
                }
              }
              hybridVoting {
                proposals(first: 50) { proposalId title status numOptions
                  votes { voterUsername }
                }
              }
              paymentManager { distributions { distributionId totalAmount status } }
            }
          }
        `;
        const results = await queryAllChains<any>(detailQuery, { name: argv.detail });
        spin.stop();

        let found = false;
        for (const chainResult of results) {
          const org = chainResult.data?.organizations?.[0];
          if (!org) continue;
          found = true;
          await refreshAuthorityUsers(org, org.id, chainResult.chainId);
          const activeMembers = (org.users || []).filter((u: any) => u.membershipStatus === 'Active');
          const allTasks = (org.taskManager?.projects || []).flatMap((p: any) => (p.tasks || []).map((t: any) => ({ ...t, project: p.title })));
          const supply = parseFloat(ethers.utils.formatEther(org.participationToken?.totalSupply || '0'));

          if (output.isJsonMode()) {
            output.json({ chain: chainResult.name, org: org.name, members: activeMembers.length, supply, tasks: allTasks.length, proposals: org.hybridVoting?.proposals?.length || 0 });
          } else {
            console.log('');
            console.log(`  ${org.name} (${chainResult.name})`);
            console.log('  ' + '═'.repeat(50));
            console.log(`  PT Supply: ${supply.toFixed(0)} | Members: ${activeMembers.length}`);
            console.log('');
            console.log('  Members:');
            for (const m of activeMembers) {
              const pt = parseFloat(ethers.utils.formatEther(m.participationTokenBalance || '0'));
              console.log(`    ${(m.account?.username || m.address.slice(0, 10)).padEnd(18)} ${pt.toFixed(0).padStart(6)} PT  ${m.totalTasksCompleted || 0} tasks  ${m.totalVotes || 0} votes`);
            }
            const open = allTasks.filter((t: any) => t.status === 'Open');
            if (open.length > 0) {
              console.log('');
              console.log('  Open Tasks:');
              for (const t of open) {
                console.log(`    #${t.taskId} ${t.title} [${t.project}] ${ethers.utils.formatEther(t.payout || '0')} PT`);
              }
            }
            const proposals = org.hybridVoting?.proposals || [];
            const active = proposals.filter((p: any) => p.status === 'Active');
            if (active.length > 0) {
              console.log('');
              console.log('  Active Proposals:');
              for (const p of active) { console.log(`    #${p.proposalId} ${p.title} (${(p.votes || []).length} votes)`); }
            }
            console.log('');
          }
        }
        if (!found) output.info(`No org named "${argv.detail}" found on any chain`);
        return;
      } catch (err: any) {
        spin.stop();
        output.error(err.message);
        process.exit(1);
      }
    }

    const spin = output.spinner('Scanning POP orgs across chains...');
    spin.start();

    try {
      const results = await queryAllChains<any>(EXPLORE_QUERY, { first: 20 });
      spin.stop();

      const rows: any[] = [];

      for (const chainResult of results) {
        if (!chainResult.data?.organizations) continue;
        for (const org of chainResult.data.organizations) {
          await refreshAuthorityUsers(org, org.id, chainResult.chainId);
          const activeMembers = (org.users || []).filter((u: any) => u.membershipStatus === 'Active').length;

          // Count tasks
          let openTasks = 0;
          let completedTasks = 0;
          let totalPT = 0;
          for (const proj of org.taskManager?.projects || []) {
            for (const task of proj.tasks || []) {
              if (task.status === 'Open') openTasks++;
              if (task.status === 'Completed') completedTasks++;
              if (task.status === 'Completed') totalPT += parseFloat(ethers.utils.formatUnits(task.payout || '0', 18));
            }
          }

          const activeProposals = org.hybridVoting?.proposals?.length || 0;
          const supply = org.participationToken?.totalSupply
            ? parseFloat(ethers.utils.formatUnits(org.participationToken.totalSupply, 18))
            : 0;

          rows.push({
            name: org.name || 'Unnamed',
            chain: chainResult.name,
            members: activeMembers,
            openTasks,
            completedTasks,
            activeProposals,
            ptSupply: Math.round(supply),
          });
        }
      }

      if (rows.length === 0) {
        output.info('No active organizations found');
        return;
      }

      // Sort by activity (members + completed tasks)
      rows.sort((a, b) => (b.members + b.completedTasks) - (a.members + a.completedTasks));

      if (output.isJsonMode()) {
        output.json(rows);
      } else {
        console.log('');
        console.log('  POP Ecosystem Explorer');
        console.log('  ' + '═'.repeat(70));
        output.table(
          ['Org', 'Chain', 'Members', 'Open Tasks', 'Done', 'Proposals', 'PT Supply'],
          rows.map(r => [
            r.name,
            r.chain,
            r.members.toString(),
            r.openTasks > 0 ? `${r.openTasks} ←` : '0',
            r.completedTasks.toString(),
            r.activeProposals > 0 ? `${r.activeProposals} active` : '0',
            r.ptSupply.toString(),
          ])
        );
        console.log('');
        const withOpen = rows.filter(r => r.openTasks > 0);
        if (withOpen.length > 0) {
          console.log('  Orgs with open tasks (← potential collaboration):');
          for (const r of withOpen) {
            console.log(`    ${r.name} (${r.chain}): ${r.openTasks} open task(s)`);
          }
          console.log('');
        }

        // Opportunities analysis
        if (argv.opportunities) {
          console.log('  Actionable Opportunities');
          console.log('  ' + '─'.repeat(50));
          let oppCount = 0;

          for (const r of rows) {
            if (r.name === 'Argus') continue; // skip self
            // Filter test orgs: short gibberish names, "Test" prefix, single-member with no activity
            const isTestOrg = /^test/i.test(r.name) ||
              (r.members <= 1 && r.completedTasks === 0 && r.name.length < 6);
            if (isTestOrg) continue;
            const opps: string[] = [];

            if (r.openTasks > 0) {
              opps.push(`${r.openTasks} open task(s) — Argus agents could claim and complete`);
            }
            if (r.members >= 3 && r.completedTasks === 0) {
              opps.push(`${r.members} members but 0 completed tasks — needs governance activation`);
            }
            if (r.members >= 3 && r.activeProposals === 0 && r.completedTasks < 3) {
              opps.push(`Low activity despite ${r.members} members — governance consulting opportunity`);
            }
            if (r.completedTasks > 0 && r.openTasks / Math.max(r.completedTasks, 1) > 2) {
              opps.push(`${r.openTasks} open vs ${r.completedTasks} done — task completion bottleneck`);
            }

            if (opps.length > 0) {
              oppCount += opps.length;
              console.log(`\n  ${r.name} (${r.chain}):`);
              for (const o of opps) {
                console.log(`    → ${o}`);
              }
            }
          }

          if (oppCount === 0) {
            console.log('  No actionable opportunities found');
          }
          console.log('');
        }
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
