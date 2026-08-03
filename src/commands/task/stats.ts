import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { queryWithFieldFallback } from '../../lib/subgraph';
import { resolveOrgModules } from '../../lib/resolve';
import * as output from '../../lib/output';

interface StatsArgs {
  org?: string;
  chain?: number;
}

const FETCH_TASK_STATS = `
  query FetchTaskStats($orgId: Bytes!) {
    organization(id: $orgId) {
      users(first: 100) {
        address
        participationTokenBalance
        membershipStatus
        totalTasksCompleted
        totalTasksReleased
        totalTasksLostToExpiry
        account { username }
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
    }
  }
`;

/**
 * FETCH_TASK_STATS without the claim-churn counters (subgraph #201, TaskManager v7).
 *
 * The two counters are asymmetric: `totalTasksLostToExpiry` is live on Arbitrum too, but
 * `totalTasksReleased` is Gnosis-only as of 2026-08-02 (verified: poa-arb-v-1 answers
 * ``Type `User` has no field `totalTasksReleased```, which `isUnknownFieldError` matches).
 * A document validates as a whole, so they have to share tier 0 — asking for the portable
 * one alongside the Gnosis-only one costs nothing, since the whole query would fail anyway.
 * Derived by deletion so the two tiers cannot drift apart.
 */
const FETCH_TASK_STATS_LEGACY = FETCH_TASK_STATS
  .split('\n')
  .filter((line) => !/^\s*(totalTasksReleased|totalTasksLostToExpiry)\s*$/.test(line))
  .join('\n');

export const statsHandler = {
  builder: (yargs: Argv) => yargs,

  handler: async (argv: ArgumentsCamelCase<StatsArgs>) => {
    const spin = output.spinner('Computing task statistics...');
    spin.start();

    try {
      const modules = await resolveOrgModules(argv.org, argv.chain);
      const { data: result, tierIndex } = await queryWithFieldFallback<any>(
        [
          { query: FETCH_TASK_STATS, variables: { orgId: modules.orgId } },
          { query: FETCH_TASK_STATS_LEGACY, variables: { orgId: modules.orgId } },
        ],
        { chainId: argv.chain }
      );
      const hasChurn = tierIndex === 0;
      const org = result.organization;
      if (!org) throw new Error('Organization not found');

      const allTasks = (org.taskManager?.projects || []).flatMap((p: any) =>
        (p.tasks || []).map((t: any) => ({ ...t, project: p.title }))
      );
      const completed = allTasks.filter((t: any) => t.status === 'Completed');
      const activeMembers = org.users.filter((u: any) => u.membershipStatus === 'Active');

      // Per-member stats
      const memberStats = activeMembers.map((u: any) => {
        const addr = u.address?.toLowerCase();
        const username = u.account?.username || u.address?.slice(0, 10);

        const tasksAssigned = allTasks.filter((t: any) => t.assignee?.toLowerCase() === addr);
        const tasksCompleted = completed.filter((t: any) => t.assignee?.toLowerCase() === addr);
        const reviewsGiven = completed.filter((t: any) =>
          t.completer?.toLowerCase() === addr && t.assignee?.toLowerCase() !== addr
        );
        const reviewsReceived = completed.filter((t: any) =>
          t.assignee?.toLowerCase() === addr && t.completer?.toLowerCase() !== addr
        );
        const selfReviews = completed.filter((t: any) =>
          t.assignee?.toLowerCase() === addr && t.completer?.toLowerCase() === addr
        );

        const ptEarned = tasksCompleted.reduce((s: number, t: any) =>
          s + parseFloat(ethers.utils.formatEther(t.payout || '0')), 0
        );
        const avgPT = tasksCompleted.length > 0 ? ptEarned / tasksCompleted.length : 0;

        // Most active project
        const projectCounts: Record<string, number> = {};
        for (const t of tasksCompleted) {
          projectCounts[t.project] = (projectCounts[t.project] || 0) + 1;
        }
        const topProject = Object.entries(projectCounts).sort((a, b) => b[1] - a[1])[0];

        return {
          username,
          tasksCompleted: tasksCompleted.length,
          ptEarned: ptEarned.toFixed(1),
          avgPTPerTask: avgPT.toFixed(1),
          reviewsGiven: reviewsGiven.length,
          reviewsReceived: reviewsReceived.length,
          selfReviews: selfReviews.length,
          topProject: topProject ? `${topProject[0]} (${topProject[1]})` : '-',
          // Every other metric here is derived from the task array, but a released task is
          // unattributable there: handleTaskUnclaimed nulls assignee/assigneeUsername/assigneeUser,
          // so filtering `allTasks` by address can never find one. These counters are the only
          // surviving record. null rather than 0 off tier 0, so "not indexed on this chain" stays
          // distinguishable from "indexed, never released".
          tasksReleased: hasChurn ? Number(u.totalTasksReleased ?? 0) : null,
          tasksLostToExpiry: hasChurn ? Number(u.totalTasksLostToExpiry ?? 0) : null,
        };
      });

      // Project breakdown
      const projectStats = (org.taskManager?.projects || []).map((p: any) => {
        const tasks = p.tasks || [];
        const done = tasks.filter((t: any) => t.status === 'Completed');
        const ptTotal = done.reduce((s: number, t: any) =>
          s + parseFloat(ethers.utils.formatEther(t.payout || '0')), 0
        );
        return { project: p.title, total: tasks.length, completed: done.length, pt: ptTotal.toFixed(1) };
      });

      spin.stop();

      if (output.isJsonMode()) {
        output.json({ members: memberStats, projects: projectStats });
      } else {
        console.log('');
        console.log('  Task Statistics');
        console.log('  ═══════════════');
        console.log('');
        console.log('  Per Member:');
        console.log('  ' + 'Member'.padEnd(18) + 'Done'.padStart(5) + 'PT'.padStart(8) + 'Avg'.padStart(6) + 'Reviews+'.padStart(10) + 'Reviews-'.padStart(10) + '  Top Project');
        console.log('  ' + '─'.repeat(75));
        for (const m of memberStats) {
          console.log(
            '  ' + m.username.padEnd(18) +
            String(m.tasksCompleted).padStart(5) +
            m.ptEarned.padStart(8) +
            m.avgPTPerTask.padStart(6) +
            String(m.reviewsGiven).padStart(10) +
            String(m.reviewsReceived).padStart(10) +
            '  ' + m.topProject
          );
        }
        if (memberStats.some((m: any) => m.selfReviews > 0)) {
          console.log('');
          console.log('  Self-reviews:');
          for (const m of memberStats.filter((m: any) => m.selfReviews > 0)) {
            console.log(`    ${m.username}: ${m.selfReviews}`);
          }
        }
        // Its own block rather than two more table columns: the header above and its
        // '─'.repeat(75) rule are hand-aligned, and widening them for a signal that is
        // zero on every member of every org today is a bad trade.
        if (memberStats.some((m: any) => m.tasksReleased || m.tasksLostToExpiry)) {
          console.log('');
          console.log('  Claim churn (released / lost to expiry):');
          for (const m of memberStats.filter((m: any) => m.tasksReleased || m.tasksLostToExpiry)) {
            console.log(`    ${m.username}: ${m.tasksReleased} / ${m.tasksLostToExpiry}`);
          }
        }
        console.log('');
        console.log('  Per Project:');
        console.log('  ' + 'Project'.padEnd(20) + 'Tasks'.padStart(6) + 'Done'.padStart(6) + 'PT'.padStart(8));
        console.log('  ' + '─'.repeat(40));
        for (const p of projectStats) {
          console.log(
            '  ' + p.project.padEnd(20) +
            String(p.total).padStart(6) +
            String(p.completed).padStart(6) +
            p.pt.padStart(8)
          );
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
