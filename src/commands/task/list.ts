import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { queryWithFieldFallback } from '../../lib/subgraph';
import { resolveOrgId } from '../../lib/resolve';
import { resolveNetworkConfig } from '../../config/networks';
import { FETCH_PROJECTS_DATA, FETCH_PROJECTS_DATA_LEGACY } from '../../queries/task';
import { formatAddress, parseDurationSeconds } from '../../lib/encoding';
import { formatCountdown, formatRelativeTime, statusColor } from '../../lib/format';
import { detectTaskManagerFeatures } from '../../lib/version';
import { enrichTasksWithDeadlines, deriveClaimState, TASK_STATUS } from '../../lib/task-lens';
import type { ClaimState } from '../../lib/task-lens';
import * as output from '../../lib/output';

interface ListArgs {
  org: string;
  project?: string;
  status?: string;
  assignee?: string;
  mine?: boolean;
  open?: boolean;
  'for-review'?: boolean;
  claimable?: boolean;
  expiring?: string;
  fast?: boolean;
  'sort-by'?: string;
  limit?: number;
  chain?: number;
  'private-key'?: string;
}

interface TaskRow {
  id: string;
  name: string;
  status: string;
  /** Raw subgraph status (undecorated), used for filtering + JSON output. */
  statusRaw: string;
  assignee: string;
  payout: number;
  payoutDisplay: string;
  project: string;
  createdAt: string;
  rejections: string;
  /** v6 on-chain enrichment (undefined when not enriched / pre-v6 org). */
  absoluteDeadline?: number;
  completionWindow?: number;
  claimDeadline?: number;
  claimState?: ClaimState;
  /**
   * True once deadline data has actually been resolved for THIS row. The
   * subgraph normalises the contract's 0 sentinel to null, so the deadline
   * values alone cannot distinguish "no deadline set" from "never looked" —
   * only this flag can, and the --json deadline block keys off it.
   */
  deadlinesResolved?: boolean;
}

/** Subgraph statuses that map to non-terminal on-chain states. */
const NON_TERMINAL_STATUSES = new Set(['open', 'unclaimed', 'assigned', 'claimed', 'submitted']);
const CLAIMED_STATUSES = new Set(['assigned', 'claimed']);
const UNCLAIMED_STATUSES = new Set(['open', 'unclaimed']);

/**
 * The deadline that currently governs a task: the per-claim deadline while
 * CLAIMED, otherwise the absolute claim cutoff. undefined = no deadline known.
 */
function governingDeadline(row: TaskRow): number | undefined {
  const dl = CLAIMED_STATUSES.has(row.statusRaw.toLowerCase())
    ? (row.claimDeadline || row.absoluteDeadline)
    : row.absoluteDeadline;
  return dl || undefined;
}

/** Human-mode status cell: colorized + deadline-state decorations. */
function statusCell(row: TaskRow): string {
  if (row.claimState === 'expired-claimable') {
    return `${statusColor('Claimed')} (expired — claimable)`;
  }
  if (row.claimState === 'expiring-soon') {
    return `${statusColor(row.status)} ⚠`;
  }
  return statusColor(row.status);
}

export const listHandler = {
  builder: (yargs: Argv) => yargs
    .option('project', { type: 'string', describe: 'Filter by project ID' })
    .option('status', { type: 'string', describe: 'Filter by status (Open/Assigned/Submitted/Completed/Cancelled)' })
    .option('assignee', { type: 'string', describe: 'Filter by assignee address' })
    .option('mine', { type: 'boolean', describe: 'Show only tasks assigned to me' })
    .option('open', { type: 'boolean', describe: 'Shortcut for --status Open' })
    .option('for-review', { type: 'boolean', describe: 'Shortcut for --status Submitted' })
    .option('claimable', { type: 'boolean', describe: 'Only tasks you could claim right now: unclaimed tasks plus claimed tasks whose deadline expired (v6 takeover)' })
    .option('expiring', { type: 'string', describe: 'Only tasks whose governing deadline falls within this window (e.g. "24h", "7d"; default 24h)' })
    .option('fast', { type: 'boolean', default: false, describe: 'Skip on-chain deadline enrichment (subgraph data only)' })
    .option('sort-by', { type: 'string', choices: ['id', 'payout', 'status', 'created'], default: 'id', describe: 'Sort field' })
    .option('limit', { type: 'number', describe: 'Max results to show' })
    .example('pop task list --claimable --sort-by payout', 'Tasks you could claim right now, richest first')
    .example('pop task list --mine --status Submitted', 'Your tasks that are awaiting review'),

  handler: async (argv: ArgumentsCamelCase<ListArgs>) => {
    const spin = output.spinner('Fetching tasks...');
    spin.start();

    try {
      // Parse --expiring up front so bad input fails before network work.
      const expiringWindow = argv.expiring !== undefined
        ? parseDurationSeconds(String(argv.expiring) || '24h')
        : undefined;

      const orgId = await resolveOrgId(argv.org, argv.chain);
      // Prefer the subgraph: it indexes the v6 deadline fields (subgraph #192), so the
      // per-task on-chain lens below is only needed when this falls through to the legacy tier.
      const { data: result, tierIndex } = await queryWithFieldFallback<any>([
        { query: FETCH_PROJECTS_DATA, variables: { orgId } },
        { query: FETCH_PROJECTS_DATA_LEGACY, variables: { orgId } },
      ], { chainId: argv.chain });
      const subgraphHasDeadlines = tierIndex === 0;

      if (!result.organization?.taskManager?.projects) {
        spin.stop();
        output.info('No projects found for this organization');
        return;
      }

      // Resolve --mine to the signer's address
      let myAddress: string | undefined;
      if (argv.mine) {
        const key = argv.privateKey as string || process.env.POP_PRIVATE_KEY;
        if (!key) {
          spin.stop();
          output.error('--mine requires a private key (set POP_PRIVATE_KEY or pass --private-key)');
          process.exit(1);
          return;
        }
        myAddress = new ethers.Wallet(key).address.toLowerCase();
      }

      // Resolve shortcut flags
      const statusFilter = argv.open ? 'open'
        : argv.forReview ? 'submitted'
        : argv.status?.toLowerCase();

      const taskManagerAddress: string = result.organization.taskManager.id;
      const projects = result.organization.taskManager.projects;
      let rows: TaskRow[] = [];

      for (const project of projects) {
        if (argv.project && !project.id.includes(argv.project)) continue;

        for (const task of project.tasks || []) {
          if (statusFilter && task.status.toLowerCase() !== statusFilter) continue;
          if (argv.assignee && task.assignee?.toLowerCase() !== argv.assignee.toLowerCase()) continue;
          if (myAddress && task.assignee?.toLowerCase() !== myAddress) continue;

          const payout = parseFloat(ethers.utils.formatUnits(task.payout || '0', 18));
          const rejCount = parseInt(task.rejectionCount || '0');
          rows.push({
            id: task.taskId,
            name: task.title || task.metadata?.name || 'Untitled',
            status: rejCount > 0 && task.status === 'Assigned' ? `Rejected(${rejCount})` : task.status,
            statusRaw: task.status,
            assignee: task.assigneeUsername || formatAddress(task.assignee || ''),
            payout,
            payoutDisplay: `${payout} PT`,
            project: project.title || 'Unknown',
            createdAt: task.createdAt || '0',
            rejections: rejCount.toString(),
            // Indexed deadlines (subgraph #192). null = unset on-chain, so map to undefined
            // rather than 0 — deriveClaimState treats both as "no deadline", but undefined
            // also distinguishes "not indexed" for the fallback below.
            absoluteDeadline: task.absoluteDeadline != null ? Number(task.absoluteDeadline) : undefined,
            completionWindow: task.completionWindow != null ? Number(task.completionWindow) : undefined,
            claimDeadline: task.claimDeadline != null ? Number(task.claimDeadline) : undefined,
          });
        }
      }

      // Sort
      const sortKey = argv.sortBy || 'id';
      rows.sort((a, b) => {
        if (sortKey === 'payout') return b.payout - a.payout;
        if (sortKey === 'status') return a.status.localeCompare(b.status);
        if (sortKey === 'created') return parseInt(b.createdAt) - parseInt(a.createdAt);
        return parseInt(a.id) - parseInt(b.id);
      });

      // Deadlines come from the SUBGRAPH (indexed since #192). The on-chain task lens is only
      // a fallback for deployments that predate it — reading them per-task over RPC costs one
      // multicall per non-terminal task on the CLI's hottest command.
      let enriched = false;
      let enrichmentNote: string | null = null;
      if (subgraphHasDeadlines) {
        // Scoped to non-terminal rows to match the RPC lens path exactly — that
        // path only ever queried these, so widening it here would silently add
        // deadline keys to terminal rows that never carried them.
        for (const row of rows.filter(r => NON_TERMINAL_STATUSES.has(r.statusRaw.toLowerCase()))) {
          // deriveClaimState only classifies CLAIMED tasks and takes the on-chain numeric
          // status; the subgraph serves the enum name ("Assigned"), so map it across.
          row.claimState = deriveClaimState({
            status: CLAIMED_STATUSES.has(row.statusRaw.toLowerCase())
              ? TASK_STATUS.CLAIMED
              : TASK_STATUS.UNCLAIMED,
            claimDeadline: row.claimDeadline,
            absoluteDeadline: row.absoluteDeadline,
          });
          row.deadlinesResolved = true;
        }
        enriched = true;
      } else if (argv.fast) {
        enrichmentNote = 'deadline data skipped (--fast)';
      } else if (rows.length > 0) {
        try {
          spin.text = 'Fetching on-chain deadlines...';
          const netConfig = resolveNetworkConfig(argv.chain);
          const provider = new ethers.providers.JsonRpcProvider(netConfig.resolvedRpc, netConfig.chainId);
          // orgId lets the feature probe read the proxy's beacon from the
          // subgraph instead of walking the EIP-1967 slot (the implementation
          // itself is still read from the beacon over RPC).
          const features = await detectTaskManagerFeatures(
            provider,
            taskManagerAddress,
            netConfig.chainId,
            { orgId }
          );
          if (features.deadlines) {
            const targets = rows.filter(r => NON_TERMINAL_STATUSES.has(r.statusRaw.toLowerCase()));
            const { tasks } = await enrichTasksWithDeadlines(
              provider,
              taskManagerAddress,
              targets.map(r => r.id),
            );
            for (const row of targets) {
              const onChain = tasks.get(row.id);
              if (!onChain || onChain.absoluteDeadline === undefined) continue;
              row.absoluteDeadline = onChain.absoluteDeadline;
              row.completionWindow = onChain.completionWindow;
              row.claimDeadline = onChain.claimDeadline;
              row.claimState = deriveClaimState(onChain);
              row.deadlinesResolved = true;
            }
            enriched = true;
          }
        } catch (err: any) {
          enrichmentNote = `deadline data unavailable (${err?.message || err})`;
        }
      }

      // --claimable: unclaimed tasks + claimed tasks whose deadline expired
      // (v6 allows claimTask/assignTask to take over an expired claim).
      if (argv.claimable) {
        rows = rows.filter(r =>
          UNCLAIMED_STATUSES.has(r.statusRaw.toLowerCase()) || r.claimState === 'expired-claimable'
        );
        if (!enriched) {
          enrichmentNote = (enrichmentNote ? enrichmentNote + '; ' : '')
            + '--claimable could not check for expired claims (no deadline data) — showing unclaimed tasks only';
        }
      }

      // --expiring: governing deadline falls within the window (future only —
      // already-expired claims are --claimable territory).
      if (expiringWindow !== undefined) {
        const now = Math.floor(Date.now() / 1000);
        rows = rows.filter(r => {
          const dl = governingDeadline(r);
          return dl !== undefined && dl > now && dl <= now + expiringWindow;
        });
        if (!enriched) {
          enrichmentNote = (enrichmentNote ? enrichmentNote + '; ' : '')
            + '--expiring requires on-chain deadline data (skipped or unavailable) — no tasks matched';
        }
      }

      // Limit
      if (argv.limit && argv.limit > 0) {
        rows = rows.slice(0, argv.limit);
      }

      spin.stop();

      if (enrichmentNote) output.info(enrichmentNote);

      if (rows.length === 0) {
        output.info('No tasks found matching filters');
        return;
      }

      if (output.isJsonMode()) {
        // Script-compatible: same keys as the pre-v6 table output, with
        // additive deadline fields on enriched rows only.
        output.json(rows.map(r => ({
          ID: r.id,
          Name: r.name,
          Status: r.status,
          Assignee: r.assignee,
          Payout: r.payoutDisplay,
          Project: r.project,
          ...(r.createdAt !== '0' ? { createdAt: r.createdAt } : {}),
          // Gate on whether deadline data was actually resolved for THIS row,
          // NOT on `absoluteDeadline !== undefined`.
          //
          // The subgraph normalises the contract's 0 sentinel to null (-> undefined
          // here), so the old gate silently DROPPED all four keys for every task
          // with no deadline set — which is every task on live Test6. The RPC lens
          // returns a literal 0 for that same state, so the pre-conversion output
          // always carried them. Re-normalising null -> 0 keeps --json byte-identical
          // and preserves the contract's own "0 means unset" convention.
          ...(r.deadlinesResolved ? {
            absoluteDeadline: r.absoluteDeadline ?? 0,
            completionWindow: r.completionWindow ?? 0,
            claimDeadline: r.claimDeadline ?? 0,
            claimState: r.claimState ?? 'none',
          } : {}),
        })));
        return;
      }

      const headers = enriched
        ? ['ID', 'Name', 'Status', 'Deadline', 'Assignee', 'Payout', 'Project', 'Age']
        : ['ID', 'Name', 'Status', 'Assignee', 'Payout', 'Project', 'Age'];
      output.table(
        headers,
        rows.map(r => {
          const age = r.createdAt !== '0' ? formatRelativeTime(r.createdAt) : '—';
          const base = [r.id, r.name, statusCell(r)];
          if (enriched) {
            const dl = governingDeadline(r);
            base.push(dl !== undefined ? formatCountdown(dl) : '—');
          }
          return [...base, r.assignee, r.payoutDisplay, r.project, age];
        })
      );
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
