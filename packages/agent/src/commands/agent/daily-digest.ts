/**
 * pop agent daily-digest — auto-summarize cross-agent activity for operator
 * status checks. Task #405.
 *
 * Answers "what have the agents done today?" without manual git-log / subgraph
 * digging. Pulls from git log (local) + subgraph (remote) and produces a
 * structured summary per agent.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { execSync } from 'child_process';
import { ethers } from 'ethers';
import { queryWithFieldFallback } from '@poa-box/cli/lib/subgraph';
import { resolveOrgModules } from '@poa-box/cli/lib/resolve';
import * as output from '@poa-box/cli/lib/output';

interface DailyDigestArgs {
  org?: string;
  chain?: number;
  since?: string;
  'per-agent'?: boolean;
}

function parseSinceDuration(since: string): number {
  const match = since.match(/^(\d+)\s*(h|d|m)$/i);
  if (!match) return 24 * 3600;
  const [, numStr, unit] = match;
  const num = parseInt(numStr, 10);
  if (unit === 'h') return num * 3600;
  if (unit === 'd') return num * 86400;
  if (unit === 'm') return num * 60;
  return 24 * 3600;
}

const FETCH_DIGEST_DATA = `
  query FetchDigestData($orgId: Bytes!) {
    organization(id: $orgId) {
      name
      participationToken { totalSupply symbol }
      users(first: 100) {
        address
        membershipStatus
        participationTokenBalance
        totalTasksCompleted
        totalVotes
        account { username }
      }
      hybridVoting {
        proposals(first: 100, orderBy: proposalId, orderDirection: desc) {
          proposalId
          title
          status
          votes {
            voter
            voterUsername
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
            assignedAt
            submittedAt
            completedAt
          }
        }
      }
    }
  }
`;

/**
 * FETCH_DIGEST_DATA plus the TaskManager v7 claim-release fields (subgraph #201).
 *
 * Gnosis-only today — poa-arb-v-1 answers ``Type `Task` has no field `releaseCount```,
 * which `isUnknownFieldError` matches, so this has to be a tier: agents run against both
 * chains and a bare query would take the whole digest down on Arbitrum. Built by insertion
 * next to the field it repairs so the two documents cannot drift apart.
 */
const FETCH_DIGEST_DATA_WITH_RELEASES = FETCH_DIGEST_DATA.replace(
  /^(\s*)assignedAt$/m,
  '$1assignedAt\n$1releaseCount\n$1lastReleasedAt',
);

const DIGEST_DATA_TIERS = [
  FETCH_DIGEST_DATA_WITH_RELEASES, // 0: Gnosis — releases indexed
  FETCH_DIGEST_DATA,               // 1: Arbitrum today — no release indexing
];

function getGitCommits(sinceSec: number): Array<{ hash: string; author: string; date: string; message: string }> {
  try {
    const sinceDate = new Date(Date.now() - sinceSec * 1000).toISOString();
    const raw = execSync(
      `git log --since="${sinceDate}" --format="%H|%an|%aI|%s" --no-merges 2>/dev/null`,
      { encoding: 'utf-8', timeout: 10000 },
    ).trim();
    if (!raw) return [];
    return raw.split('\n').map((line) => {
      const [hash, author, date, ...msg] = line.split('|');
      return { hash: hash.slice(0, 8), author, date, message: msg.join('|') };
    });
  } catch {
    return [];
  }
}

function getGitPRsMerged(sinceSec: number): number {
  try {
    const sinceDate = new Date(Date.now() - sinceSec * 1000).toISOString();
    const raw = execSync(
      `git log --since="${sinceDate}" --merges --format="%s" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 10000 },
    ).trim();
    return raw ? raw.split('\n').filter((l) => /merge pull request|merge.*pr/i.test(l)).length : 0;
  } catch {
    return 0;
  }
}

export const dailyDigestHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('since', {
        type: 'string',
        default: '24h',
        describe: 'Time window: 6h, 12h, 24h, 48h, 7d',
      })
      .option('per-agent', {
        type: 'boolean',
        default: false,
        describe: 'Group activity by agent',
      }),

  handler: async (argv: ArgumentsCamelCase<DailyDigestArgs>) => {
    const spin = output.spinner('Generating daily digest...');
    spin.start();

    try {
      const sinceSec = parseSinceDuration(argv.since || '24h');
      const sinceTs = Math.floor(Date.now() / 1000) - sinceSec;

      const modules = await resolveOrgModules(argv.org, argv.chain);
      const { data: result, tierIndex } = await queryWithFieldFallback<any>(
        DIGEST_DATA_TIERS.map((q) => ({ query: q, variables: { orgId: modules.orgId } })),
        { chainId: argv.chain },
      );
      // Gate on the served tier, never on truthiness: releaseCount is 0 on every
      // live row today, which must stay distinguishable from "not indexed here".
      const hasReleaseData = tierIndex === 0;
      const org = result.organization;
      if (!org) throw new Error('Organization not found');

      const activeMembers = org.users.filter((u: any) => u.membershipStatus === 'Active');
      const ptSupply = parseFloat(ethers.utils.formatEther(org.participationToken?.totalSupply || '0'));

      // All tasks flat
      const allTasks = (org.taskManager?.projects || []).flatMap((p: any) => p.tasks || []);

      // Filter tasks by window
      const tasksCreated = allTasks.filter((t: any) => parseInt(t.createdAt || '0') >= sinceTs);
      const tasksClaimed = allTasks.filter((t: any) => parseInt(t.assignedAt || '0') >= sinceTs && t.assignee);
      const tasksSubmitted = allTasks.filter((t: any) => parseInt(t.submittedAt || '0') >= sinceTs);
      const tasksCompleted = allTasks.filter((t: any) => parseInt(t.completedAt || '0') >= sinceTs);
      // unclaimTask nulls assignee/assignedAt, so a claim-then-release inside the window
      // leaves no trace in tasksClaimed above — the work would read as if it never happened.
      // lastReleasedAt is the only surviving timestamp.
      const tasksReleased = hasReleaseData
        ? allTasks.filter((t: any) => parseInt(t.lastReleasedAt || '0') >= sinceTs)
        : [];

      // PT earned in window
      const ptEarnedInWindow = tasksCompleted.reduce(
        (s: number, t: any) => s + parseFloat(ethers.utils.formatEther(t.payout || '0')),
        0,
      );

      // Proposals — subgraph lacks createdAt on Proposal/Vote, so we show
      // current state (active proposals, total votes) rather than windowed.
      const proposals = org.hybridVoting?.proposals || [];
      const activeProposals = proposals.filter((p: any) => p.status === 'Active');
      const totalVotesCast = proposals.reduce(
        (s: number, p: any) => s + (p.votes || []).length, 0,
      );

      // Pending reviews
      const pendingReviews = allTasks.filter((t: any) => t.status === 'Submitted');

      // Git activity
      const commits = getGitCommits(sinceSec);
      const prsMerged = getGitPRsMerged(sinceSec);

      // Per-agent breakdown
      const agentMap: Record<string, {
        username: string;
        commits: number;
        tasksCreated: string[];
        tasksClaimed: string[];
        tasksSubmitted: string[];
        tasksCompleted: string[];
        votescast: number;
        ptEarned: number;
      }> = {};

      const ensureAgent = (addr: string, username: string) => {
        const key = addr.toLowerCase();
        if (!agentMap[key]) {
          agentMap[key] = { username: username || addr.slice(0, 10), commits: 0, tasksCreated: [], tasksClaimed: [], tasksSubmitted: [], tasksCompleted: [], votescast: 0, ptEarned: 0 };
        }
        return agentMap[key];
      };

      // Map git authors to agents (best-effort)
      for (const c of commits) {
        // Try to match git author to an agent. ClawDAOBot is the shared bot.
        const authorLower = c.author.toLowerCase();
        if (authorLower === 'clawdaobot') {
          // Task IDs in commit messages: "Task #NNN"
          const taskMatch = c.message.match(/task\s+#?(\d+)/i);
          if (taskMatch) {
            const tid = taskMatch[1];
            const task = allTasks.find((t: any) => String(t.taskId) === tid);
            if (task?.assignee) {
              ensureAgent(task.assignee, task.assigneeUsername || '').commits++;
              continue;
            }
          }
        }
        // Fallback: attribute to first member matching author name
        const member = activeMembers.find((m: any) =>
          (m.account?.username || '').toLowerCase() === authorLower,
        );
        if (member) {
          ensureAgent(member.address, member.account?.username || '').commits++;
        }
      }

      for (const t of tasksClaimed) {
        const a = ensureAgent(t.assignee, t.assigneeUsername || '');
        a.tasksClaimed.push(`#${t.taskId} ${t.title}`);
      }
      for (const t of tasksSubmitted) {
        if (t.assignee) {
          const a = ensureAgent(t.assignee, t.assigneeUsername || '');
          a.tasksSubmitted.push(`#${t.taskId} ${t.title}`);
        }
      }
      for (const t of tasksCompleted) {
        if (t.completer) {
          const a = ensureAgent(t.completer, t.completerUsername || '');
          a.tasksCompleted.push(`#${t.taskId} ${t.title}`);
          a.ptEarned += parseFloat(ethers.utils.formatEther(t.payout || '0'));
        }
      }
      // Attribute votes from active + recent proposals to agents
      for (const p of proposals) {
        for (const v of (p.votes || [])) {
          ensureAgent(v.voter, v.voterUsername || '').votescast++;
        }
      }

      spin.stop();

      const digest = {
        org: org.name,
        window: argv.since || '24h',
        windowStart: new Date(sinceTs * 1000).toISOString(),
        summary: {
          commits: commits.length,
          prsMerged,
          tasksCreated: tasksCreated.length,
          tasksClaimed: tasksClaimed.length,
          tasksSubmitted: tasksSubmitted.length,
          tasksCompleted: tasksCompleted.length,
          ptEarned: Math.round(ptEarnedInWindow * 10) / 10,
          ptSupply: Math.round(ptSupply * 10) / 10,
          totalVotesCast,
          activeProposals: activeProposals.length,
          // Appended at the end, gated on the served tier so a chain that does not
          // index releases omits the key rather than reporting a false 0.
          ...(hasReleaseData ? { tasksReleased: tasksReleased.length } : {}),
        },
        activeProposals: activeProposals.map((p: any) => ({
          id: p.proposalId,
          title: p.title,
          status: p.status,
          votes: (p.votes || []).length,
        })),
        pendingReviews: pendingReviews.map((t: any) => ({
          taskId: t.taskId,
          title: t.title,
          assignee: t.assigneeUsername || t.assignee?.slice(0, 10),
        })),
        perAgent: argv['per-agent'] ? Object.values(agentMap) : undefined,
        blocked: [
          'Content distribution credentials (Twitter/Mirror) — Hudson-gated',
          'Branch protection on main — requires repo admin (task #402)',
          'Cross-org vouching (tasks #230, #277) — Hudson-gated',
        ],
        ...(hasReleaseData ? {
          releasedTasks: tasksReleased.map((t: any) => ({
            taskId: t.taskId,
            title: t.title,
            lastReleasedAt: t.lastReleasedAt ?? null,
            releaseCount: Number(t.releaseCount ?? 0),
          })),
        } : {}),
      };

      if (output.isJsonMode()) {
        output.json(digest);
        return;
      }

      console.log('');
      console.log(`  Daily Digest — ${org.name} (last ${argv.since || '24h'})`);
      console.log('  ══════════════════════════════════════════');
      console.log('');
      console.log('  Activity Summary');
      console.log('  ────────────────');
      console.log(`  Commits:            ${commits.length}`);
      if (prsMerged > 0) console.log(`  PRs merged:         ${prsMerged}`);
      console.log(`  Tasks created:      ${tasksCreated.length}`);
      console.log(`  Tasks claimed:      ${tasksClaimed.length}`);
      if (hasReleaseData) console.log(`  Tasks released:     ${tasksReleased.length}`);
      console.log(`  Tasks submitted:    ${tasksSubmitted.length}`);
      console.log(`  Tasks completed:    ${tasksCompleted.length} (${ptEarnedInWindow.toFixed(1)} PT earned)`);
      console.log(`  Total votes (all):  ${totalVotesCast}`);
      console.log(`  PT supply:          ${ptSupply.toFixed(1)}`);

      if (activeProposals.length > 0) {
        console.log('');
        console.log('  Active Proposals');
        console.log('  ────────────────');
        for (const p of activeProposals) {
          console.log(`  #${p.proposalId} ${p.title} (${(p.votes || []).length} votes)`);
        }
      }

      if (pendingReviews.length > 0) {
        console.log('');
        console.log('  Pending Reviews');
        console.log('  ───────────────');
        for (const t of pendingReviews) {
          console.log(`  #${t.taskId} "${t.title}" by ${t.assigneeUsername || t.assignee?.slice(0, 10)}`);
        }
      }

      // Named explicitly rather than folded into the counters: the row itself no
      // longer says who let the task go, so the operator needs the task ids to
      // chase it down (pop task view --task N shows the release history).
      if (tasksReleased.length > 0) {
        console.log('');
        console.log('  Released Back to the Pool');
        console.log('  ─────────────────────────');
        for (const t of tasksReleased) {
          console.log(`  #${t.taskId} "${t.title}" (${t.releaseCount}x released, now ${t.status})`);
        }
      }

      if (argv['per-agent']) {
        console.log('');
        console.log('  Per-Agent Breakdown');
        console.log('  ──────────────────');
        for (const a of Object.values(agentMap)) {
          console.log(`\n  ${a.username}`);
          console.log(`    Commits: ${a.commits} | Votes: ${a.votescast} | PT earned: ${a.ptEarned.toFixed(1)}`);
          if (a.tasksSubmitted.length > 0) {
            console.log('    Submitted:');
            for (const t of a.tasksSubmitted) console.log(`      ${t}`);
          }
          if (a.tasksCompleted.length > 0) {
            console.log('    Completed (reviewed):');
            for (const t of a.tasksCompleted) console.log(`      ${t}`);
          }
        }
      }

      console.log('');
      console.log('  Still Blocked');
      console.log('  ─────────────');
      for (const b of digest.blocked) {
        console.log(`  • ${b}`);
      }
      console.log('');
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
