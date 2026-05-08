/**
 * pop agent story <agent>
 *
 * Demo-first command: render any agent's recent activity as a narrative.
 * Shows identity, stats, and a timeline of real on-chain actions — tasks
 * completed, votes cast, proposals created — merged chronologically.
 *
 * Purpose: the framework's killer demo. Anyone can run this against
 * `argus_prime` or `sentinel_01` to see what an autonomous agent actually
 * does on-chain, without deploying anything. Better than a whitepaper.
 *
 * Input: --agent can be a username, a hex address, or omitted (defaults to self).
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { queryAllChains } from '../../lib/subgraph';
import { resolveUserAddress } from '../../lib/users';
import * as output from '../../lib/output';

interface StoryArgs {
  agent?: string;
  org?: string;
  limit?: number;
  chain?: number;
  'private-key'?: string;
}

interface TimelineEvent {
  timestamp: number;
  type: 'task-completed' | 'task-submitted' | 'task-claimed' | 'vote' | 'proposal';
  summary: string;
  detail?: string;
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function formatRelativeDays(ts: number): string {
  const days = Math.floor((Date.now() / 1000 - ts) / 86400);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export const storyHandler = {
  builder: (yargs: Argv) => yargs
    .option('agent', { type: 'string', describe: 'Agent username or hex address (default: self)' })
    .option('limit', { type: 'number', default: 15, describe: 'Max timeline events to show' }),

  handler: async (argv: ArgumentsCamelCase<StoryArgs>) => {
    const spin = output.spinner('Fetching agent story...');
    spin.start();

    try {
      // Resolve the agent identifier
      let identifier = argv.agent as string;
      if (!identifier) {
        const pk = (argv.privateKey as string) || process.env.POP_PRIVATE_KEY;
        if (!pk) throw new Error('No --agent specified and no POP_PRIVATE_KEY for self-lookup');
        const { ethers } = require('ethers');
        identifier = new ethers.Wallet(pk).address;
      }
      const address = await resolveUserAddress(identifier);

      spin.text = 'Querying subgraphs (all chains)...';
      const limit = Math.min(Number(argv.limit) || 15, 50);

      // Query every supported chain in parallel — agents may be cross-chain
      // (e.g. vigil_01 is both Argus on Gnosis and Poa on Arbitrum).
      // queryAllChains returns [{chainId, name, data}] — we merge Users across
      // all chains where this address has activity.
      const allResults = await queryAllChains<any>(`
        query AgentStory($addr: Bytes!, $limit: Int!) {
          users(where: { address: $addr }) {
            id
            address
            organization { id }
            joinMethod
            membershipStatus
            participationTokenBalance
            totalVotes
            totalTasksCompleted
            totalTasksCancelled
            totalPaymentsAmount
            firstSeenAt
            lastActiveAt
            currentHatIds
            account { username }
            completedTasks(first: $limit, orderBy: completedAt, orderDirection: desc) {
              taskId
              title
              payout
              completedAt
              project { title }
            }
            assignedTasks(first: $limit, orderBy: assignedAt, orderDirection: desc) {
              taskId
              title
              status
              submittedAt
              assignedAt
            }
            hybridVotes(first: $limit, orderBy: votedAt, orderDirection: desc) {
              votedAt
              optionIndexes
              optionWeights
              proposal {
                proposalId
                title
                status
                winningOption
              }
            }
            hybridProposalsCreated(first: $limit, orderBy: createdAtBlock, orderDirection: desc) {
              proposalId
              title
              status
              startTimestamp
              wasExecuted
              executionFailed
            }
          }
        }
      `, { addr: address, limit });

      // Flatten Users across all chains; tag each with its chain for display
      interface ChainUser {
        user: any;
        chainId: number;
        chainName: string;
      }
      const users: ChainUser[] = [];
      for (const chainResult of allResults) {
        if (!chainResult.data?.users) continue;
        for (const u of chainResult.data.users) {
          users.push({ user: u, chainId: chainResult.chainId, chainName: chainResult.name });
        }
      }

      if (users.length === 0) {
        spin.stop();
        throw new Error(`No activity found for ${identifier} (${address}) on any supported chain`);
      }

      spin.stop();

      // Pick a display username — the first one we can find across chains
      const username = users.map(cu => cu.user.account?.username).find(Boolean) || '(unknown)';

      // Build timeline events across all users (chains × orgs)
      const events: TimelineEvent[] = [];

      for (const { user, chainName } of users) {
        const chainTag = users.length > 1 ? ` [${chainName}]` : '';
        // Completed tasks (agent closed/approved them)
        for (const t of user.completedTasks || []) {
          if (!t.completedAt) continue;
          events.push({
            timestamp: Number(t.completedAt),
            type: 'task-completed',
            summary: `approved task #${t.taskId}${chainTag}`,
            detail: (t.title || '').slice(0, 60),
          });
        }
        // Assigned tasks they themselves submitted (their own work)
        for (const t of user.assignedTasks || []) {
          if (!t.submittedAt) continue;
          events.push({
            timestamp: Number(t.submittedAt),
            type: 'task-submitted',
            summary: `submitted task #${t.taskId}${chainTag}`,
            detail: (t.title || '').slice(0, 60),
          });
        }
        // Votes
        for (const v of user.hybridVotes || []) {
          if (!v.votedAt || !v.proposal) continue;
          const opts = (v.optionIndexes || []).join(',');
          const wts = (v.optionWeights || []).join(',');
          events.push({
            timestamp: Number(v.votedAt),
            type: 'vote',
            summary: `voted on P#${v.proposal.proposalId}${chainTag}`,
            detail: `${(v.proposal.title || '').slice(0, 50)} — options [${opts}] weights [${wts}]`,
          });
        }
        // Proposals created
        for (const p of user.hybridProposalsCreated || []) {
          if (!p.startTimestamp) continue;
          events.push({
            timestamp: Number(p.startTimestamp),
            type: 'proposal',
            summary: `created P#${p.proposalId}${chainTag}`,
            detail: (p.title || '').slice(0, 60),
          });
        }
      }

      events.sort((a, b) => b.timestamp - a.timestamp);
      const timeline = events.slice(0, limit);

      // Aggregate stats across users (chains × orgs)
      const totalVotes = users.reduce((s, cu) => s + Number(cu.user.totalVotes || 0), 0);
      const totalCompleted = users.reduce((s, cu) => s + Number(cu.user.totalTasksCompleted || 0), 0);
      const totalCancelled = users.reduce((s, cu) => s + Number(cu.user.totalTasksCancelled || 0), 0);
      const ptBalance = users.reduce((s, cu) => {
        const bal = BigInt(cu.user.participationTokenBalance || '0');
        return s + Number(bal / BigInt(10 ** 16)) / 100;
      }, 0);
      const firstSeen = Math.min(...users.map(cu => Number(cu.user.firstSeenAt || Date.now() / 1000)));
      const lastActive = Math.max(...users.map(cu => Number(cu.user.lastActiveAt || 0)));
      const chains = [...new Set(users.map(cu => cu.chainName))];

      const summary = {
        username,
        address,
        orgs: users.length,
        chains,
        stats: {
          ptBalance,
          totalVotes,
          totalTasksCompleted: totalCompleted,
          totalTasksCancelled: totalCancelled,
          firstSeen: formatDate(firstSeen),
          lastActive: formatDate(lastActive),
          activeDays: Math.floor((lastActive - firstSeen) / 86400),
        },
        timeline: timeline.map(e => ({
          date: formatDate(e.timestamp),
          ago: formatRelativeDays(e.timestamp),
          type: e.type,
          summary: e.summary,
          detail: e.detail,
        })),
      };

      if (argv.json) {
        output.json(summary);
      } else {
        console.log('');
        console.log(`  Agent: ${username}`);
        console.log(`  ${'='.repeat(60)}`);
        console.log(`  Address:     ${address}`);
        console.log(`  Orgs:        ${users.length} across ${chains.length} chain(s) (${chains.join(', ')})`);
        console.log(`  PT Balance:  ${ptBalance.toFixed(2)}`);
        console.log(`  First seen:  ${summary.stats.firstSeen} (${summary.stats.activeDays}d active)`);
        console.log(`  Last active: ${summary.stats.lastActive}`);
        console.log('');
        console.log(`  Activity: ${totalCompleted} tasks completed, ${totalVotes} votes cast`);
        console.log('');
        console.log(`  Recent timeline (${timeline.length}):`);
        for (const e of timeline) {
          const ago = formatRelativeDays(e.timestamp);
          console.log(`    ${ago.padStart(10)}  ${e.type.padEnd(15)}  ${e.summary}`);
          if (e.detail) console.log(`                —  ${e.detail}`);
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
