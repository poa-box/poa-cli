import { refreshAuthorityUsers } from '../../lib/authority';
import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { query } from '../../lib/subgraph';
import { resolveOrgModules } from '../../lib/resolve';
import { FETCH_ORG_ACTIVITY, normalizeAuthorityVouches } from '../../queries/activity';
import { formatAddress } from '../../lib/encoding';
import * as output from '../../lib/output';

interface ActivityArgs {
  org?: string;
  since?: number;
  chain?: number;
}

export const activityHandler = {
  builder: (yargs: Argv) => yargs
    .option('since', {
      type: 'number',
      describe: 'Unix timestamp — show changes since this time (default: 30 minutes ago)',
    }),

  handler: async (argv: ArgumentsCamelCase<ActivityArgs>) => {
    const spin = output.spinner('Fetching org activity...');
    spin.start();

    try {
      const modules = await resolveOrgModules(argv.org, argv.chain);
      const since = argv.since || Math.floor(Date.now() / 1000) - 1800;

      const result = await query<any>(FETCH_ORG_ACTIVITY, {
        orgId: modules.orgId,
        hybridVotingId: modules.hybridVotingAddress || '',
        authorityId: modules.membershipAuthorityAddress || '',
        tokenAddress: modules.participationTokenAddress || '',
      }, argv.chain);

      spin.stop();

      result.activeVouches = normalizeAuthorityVouches(result.activeVouches ?? []);
      const org = result.organization;
      if (!org) {
        output.error('Organization not found');
        process.exit(1);
        return;
      }

      await refreshAuthorityUsers(org, modules.orgId, argv.chain);

      // Extract tasks from nested org query, then filter by --since client-side
      const allTasks: any[] = [];
      for (const project of org.taskManager?.projects || []) {
        for (const task of project.tasks || []) {
          allTasks.push({ ...task, projectTitle: project.title });
        }
      }

      const recentTasks = allTasks.filter(t => parseInt(t.createdAt || '0') >= since);
      const submittedTasks = allTasks.filter(t => t.status === 'Submitted');

      // Filter recent members by --since
      const allUsers = org.users || [];
      const recentJoins = allUsers.filter((u: any) => parseInt(u.firstSeenAt || '0') >= since);

      // Proposal data from top-level queries
      const activeHybrid = result.activeHybridProposals || [];
      const endedHybrid = result.endedHybridProposals || [];
      const activeDD = org.directDemocracyVoting?.ddvProposals || [];
      const activeVouches = result.activeVouches || [];
      const pendingRequests = result.pendingTokenRequests || [];

      if (output.isJsonMode()) {
        output.json({
          org: {
            id: modules.orgId,
            name: org.name,
            tokenSupply: org.participationToken?.totalSupply,
            tokenSymbol: org.participationToken?.symbol,
            distributionCount: org.paymentManager?.distributionCounter,
          },
          since,
          sinceISO: new Date(since * 1000).toISOString(),
          proposals: {
            activeHybrid,
            endedHybrid,
            activeDD,
          },
          tasks: {
            recent: recentTasks,
            awaitingReview: submittedTasks,
            totalByStatus: {
              open: allTasks.filter(t => t.status === 'Open').length,
              assigned: allTasks.filter(t => t.status === 'Assigned').length,
              submitted: submittedTasks.length,
              completed: allTasks.filter(t => t.status === 'Completed').length,
            },
          },
          members: {
            recentJoins: recentJoins.map((u: any) => ({
              address: u.address,
              username: u.account?.username,
              joinMethod: u.joinMethod,
              firstSeenAt: u.firstSeenAt,
            })),
            totalActive: allUsers.filter((u: any) => u.membershipStatus === 'Active').length,
          },
          vouches: { active: activeVouches },
          tokenRequests: { pending: pendingRequests },
        });
      } else {
        const sinceDate = new Date(since * 1000).toLocaleString();
        console.log('');
        console.log(`  Org Activity since ${sinceDate}`);
        console.log(`  Org: ${org.name || modules.orgId}`);
        if (org.participationToken) {
          const supply = ethers.utils.formatUnits(org.participationToken.totalSupply || '0', 18);
          console.log(`  Token: ${supply} ${org.participationToken.symbol}`);
        }
        console.log('  ' + '─'.repeat(50));

        // Proposals
        const totalActive = activeHybrid.length + activeDD.length;
        console.log(`\n  Proposals: ${totalActive} active, ${endedHybrid.length} recently ended`);
        for (const p of activeHybrid) {
          const remaining = p.endTimestamp
            ? Math.max(0, Math.round((parseInt(p.endTimestamp) * 1000 - Date.now()) / 60000))
            : 0;
          console.log(`    [hybrid #${p.proposalId}] ${p.title || 'Untitled'} — ${(p.votes || []).length} votes, ${remaining}m left`);
        }
        for (const p of activeDD) {
          const remaining = p.endTimestamp
            ? Math.max(0, Math.round((parseInt(p.endTimestamp) * 1000 - Date.now()) / 60000))
            : 0;
          console.log(`    [dd #${p.proposalId}] ${p.title || 'Untitled'} — ${(p.votes || []).length} votes, ${remaining}m left`);
        }
        for (const p of endedHybrid) {
          const winText = p.winningOption != null ? `winner: #${p.winningOption}` : 'no winner';
          console.log(`    [hybrid #${p.proposalId}] ${p.title || 'Untitled'} — Ended (${winText}${p.wasExecuted ? ', executed' : ''})`);
        }

        // Tasks
        const openCount = allTasks.filter(t => t.status === 'Open').length;
        console.log(`\n  Tasks: ${recentTasks.length} new, ${submittedTasks.length} awaiting review, ${openCount} open`);
        for (const t of submittedTasks.slice(0, 5)) {
          const payout = ethers.utils.formatUnits(t.payout || '0', 18);
          console.log(`    [#${t.taskId}] ${t.title || 'Untitled'} — ${payout} PT, by ${t.assigneeUsername || formatAddress(t.assignee || '')}`);
        }

        // Members
        if (recentJoins.length > 0) {
          console.log(`\n  New Members: ${recentJoins.length}`);
          for (const u of recentJoins) {
            console.log(`    ${u.account?.username || formatAddress(u.address)} (${u.joinMethod || 'unknown'})`);
          }
        }

        // Vouches
        if (activeVouches.length > 0) {
          console.log(`\n  Active Vouches: ${activeVouches.length}`);
          for (const v of activeVouches.slice(0, 5)) {
            console.log(`    ${v.wearerUsername || formatAddress(v.wearer)} — ${v.vouchCount} vouches for hat ${v.hatId}`);
          }
        }

        // Token requests
        if (pendingRequests.length > 0) {
          console.log(`\n  Pending Token Requests: ${pendingRequests.length}`);
          for (const r of pendingRequests.slice(0, 3)) {
            const amt = ethers.utils.formatUnits(r.amount || '0', 18);
            console.log(`    #${r.requestId} — ${amt} PT (${r.metadata?.reason || 'no reason'})`);
          }
        }

        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
