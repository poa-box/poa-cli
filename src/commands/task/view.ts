import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { query } from '../../lib/subgraph';
import { resolveOrgId, resolveOrgModules } from '../../lib/resolve';
import { resolveNetworkConfig } from '../../config/networks';
import { fetchJson } from '../../lib/ipfs';
import { FETCH_PROJECTS_DATA } from '../../queries/task';
import { formatAddress, formatDeadline } from '../../lib/encoding';
import { formatCountdown } from '../../lib/format';
import {
  getTaskOnChain,
  getTaskApplicants,
  deriveClaimState,
  TASK_STATUS,
} from '../../lib/task-lens';
import type { TaskOnChain, ClaimState } from '../../lib/task-lens';
import * as output from '../../lib/output';
import { probeTaskOnChain } from './probe';

/** '48h' | '2d 12h' | 'none' for a seconds duration. */
function humanizeDuration(seconds: number | undefined): string {
  if (!seconds) return 'none';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

/**
 * One-sentence summary of what the deadlines mean for this task right now.
 * null when there is nothing actionable to say (no deadlines, terminal state).
 */
function deadlineSentence(onChain: TaskOnChain, claimState: ClaimState): string | null {
  if (onChain.status === TASK_STATUS.CLAIMED) {
    const governing = onChain.claimDeadline || onChain.absoluteDeadline;
    if (claimState === 'expired-claimable') {
      return 'claim expired — anyone with CLAIM permission can take over';
    }
    if (governing) {
      return `submission due ${formatDeadline(governing)} (${formatCountdown(governing)})`;
    }
    return null;
  }
  if (onChain.status === TASK_STATUS.UNCLAIMED && onChain.absoluteDeadline) {
    const now = Math.floor(Date.now() / 1000);
    return onChain.absoluteDeadline <= now
      ? 'claim deadline passed — this task can no longer be claimed'
      : `open for claims — closes ${formatDeadline(onChain.absoluteDeadline)} (${formatCountdown(onChain.absoluteDeadline)})`;
  }
  if (
    onChain.status === TASK_STATUS.SUBMITTED &&
    (onChain.claimDeadline || onChain.absoluteDeadline || onChain.completionWindow)
  ) {
    return 'submitted — awaiting review (deadlines no longer apply)';
  }
  return null;
}

interface ViewArgs {
  org: string;
  task: string;
  chain?: number;
}

export const viewHandler = {
  builder: (yargs: Argv) => yargs
    .option('task', { type: 'string', demandOption: true, describe: 'Task ID' }),

  handler: async (argv: ArgumentsCamelCase<ViewArgs>) => {
    const spin = output.spinner('Fetching task...');
    spin.start();

    try {
      const orgId = await resolveOrgId(argv.org, argv.chain);
      const result = await query<any>(FETCH_PROJECTS_DATA, { orgId }, argv.chain);
      const projects = result.organization?.taskManager?.projects || [];

      let found: any = null;
      let projectTitle = '';
      for (const project of projects) {
        for (const task of project.tasks || []) {
          if (task.taskId === argv.task || task.id.endsWith(`-${argv.task}`)) {
            found = task;
            projectTitle = project.title;
            break;
          }
        }
        if (found) break;
      }

      // Task #385 (HB#236): on-chain fallback probe when subgraph says
      // "not found". The POP subgraph periodically falls 30+ task IDs
      // behind chain state (HB#223 brain lesson: task-list-stuck-at-367
      // class of bug). Before giving up, probe the TaskManager contract
      // directly via event-log scanning. This is the symmetric companion
      // to Task #378's vote/list.ts probe.
      if (!found) {
        try {
          const modules = await resolveOrgModules(argv.org, argv.chain);
          if (modules.taskManagerAddress) {
            const netConfig = resolveNetworkConfig(argv.chain);
            const provider = new ethers.providers.JsonRpcProvider(
              netConfig.resolvedRpc,
              netConfig.chainId,
            );
            const probed = await probeTaskOnChain(
              modules.taskManagerAddress,
              argv.task,
              provider,
            );
            if (probed) {
              spin.stop();
              // Try to pull IPFS metadata — usually works even when the
              // subgraph is lagging, since IPFS is pinned independently.
              let probedMeta: any = null;
              if (probed.metadataHash) {
                try {
                  probedMeta = await fetchJson(probed.metadataHash);
                } catch { /* ignore */ }
              }
              const probedPayout = probed.payout
                ? ethers.utils.formatUnits(probed.payout, 18)
                : '0';
              if (output.isJsonMode()) {
                output.json({
                  taskId: probed.taskId,
                  title: probed.title || probedMeta?.name,
                  description: probedMeta?.description,
                  status: probed.status,
                  project: probed.projectId,
                  payout: probedPayout + ' PT',
                  bountyToken: probed.bountyToken,
                  bountyPayout: probed.bountyPayout,
                  assignee: probed.assignee,
                  claimer: probed.claimer,
                  completer: probed.completer,
                  difficulty: probedMeta?.difficulty,
                  estHours: probedMeta?.estimatedHours || probedMeta?.estHours,
                  createdBlock: probed.createdBlock,
                  lastEventBlock: probed.lastEventBlock,
                  _source: 'on-chain probe (subgraph lag fallback, Task #385)',
                });
              } else {
                console.log('');
                console.log(`  Task #${probed.taskId}: ${probed.title || probedMeta?.name || 'Untitled'}`);
                console.log(`  Source:      on-chain probe (subgraph lag fallback)`);
                console.log(`  Status:      ${probed.status}`);
                console.log(`  Payout:      ${probedPayout} PT`);
                if (probed.assignee) console.log(`  Assignee:    ${probed.assignee}`);
                if (probed.claimer && probed.claimer !== probed.assignee) {
                  console.log(`  Claimer:     ${probed.claimer}`);
                }
                if (probed.completer) console.log(`  Completer:   ${probed.completer}`);
                if (probedMeta?.description) console.log(`  Description: ${probedMeta.description}`);
                console.log(`  Created at:  block ${probed.createdBlock}`);
                console.log(`  Last event:  block ${probed.lastEventBlock}`);
                console.log('');
                console.log(`  \x1b[33mNote: subgraph does not know about this task yet.\x1b[0m`);
                console.log(`  \x1b[33mShowing on-chain state only; applications/rejections/IPFS-metadata-derived fields may be incomplete.\x1b[0m`);
                console.log('');
              }
              return;
            }
          }
        } catch {
          // Fall through to the normal "not found" error if the probe
          // itself errors out — don't mask the underlying subgraph-miss
          // with an unrelated RPC error.
        }
        spin.stop();
        output.error(`Task ${argv.task} not found (subgraph + on-chain probe both failed)`);
        process.exit(1);
        return;
      }

      // Try to fetch IPFS metadata for richer details
      let metadata = found.metadata || null;
      if (!metadata && found.metadataHash) {
        try {
          metadata = await fetchJson(found.metadataHash);
        } catch { /* ignore */ }
      }

      // v6 deadline data is chain-only (the deployed subgraph doesn't index
      // it) — read it via the task lens. Works on any org: pre-v6
      // implementations return no deadline words, leaving the fields
      // undefined, and we omit the Deadlines section entirely. RPC failures
      // degrade the same way rather than breaking the view.
      let onChain: TaskOnChain | null = null;
      let lensApplicants: string[] | null = null;
      const taskManagerAddress: string | undefined = result.organization?.taskManager?.id;
      if (taskManagerAddress) {
        try {
          spin.text = 'Fetching on-chain deadlines...';
          const netConfig = resolveNetworkConfig(argv.chain);
          const provider = new ethers.providers.JsonRpcProvider(netConfig.resolvedRpc, netConfig.chainId);
          onChain = await getTaskOnChain(provider, taskManagerAddress, found.taskId);
          // Applicant list: the subgraph indexes applications, but can lag —
          // fall back to the lens when it has none for an application-gated task.
          if (found.requiresApplication && !found.applications?.length) {
            try {
              lensApplicants = await getTaskApplicants(provider, taskManagerAddress, found.taskId);
            } catch { /* lens applicants are best-effort */ }
          }
        } catch { /* on-chain read is best-effort; omit deadline data */ }
      }
      const hasDeadlineData = onChain !== null && onChain.absoluteDeadline !== undefined;
      const claimState: ClaimState = onChain ? deriveClaimState(onChain) : 'none';

      spin.stop();

      const payout = ethers.utils.formatUnits(found.payout || '0', 18);
      const bountyPayout = found.bountyPayout && found.bountyToken !== ethers.constants.AddressZero
        ? found.bountyPayout
        : null;

      // HB#392 fix: when the subgraph hasn't resolved rejection IPFS metadata
      // yet, fall back to fetching the task-level rejectionHash directly.
      // The subgraph stores rejectionHash on the task (latest rejection's CID)
      // but the per-rejection metadata resolver can lag. This closes the
      // communication gap where an agent rejects with a reason but the reviewer
      // sees "null" because of IPFS resolution lag.
      let ipfsFallbackReason: string | null = null;
      const rawRejections = found.rejections || [];
      const anyMissingReason = rawRejections.some((r: any) => !r.metadata?.rejection);
      if (anyMissingReason && found.rejectionHash) {
        try {
          const raw = await fetchJson<any>(found.rejectionHash);
          ipfsFallbackReason = raw?.rejection || null;
        } catch { /* IPFS fetch failed — leave as null */ }
      }
      const rejections = rawRejections.map((r: any, i: number) => ({
        rejector: r.rejectorUsername,
        rejectedAt: r.rejectedAt,
        // Use subgraph metadata if available; fall back to IPFS-fetched reason
        // for the most recent rejection (index 0, since ordered desc).
        reason: r.metadata?.rejection || (i === 0 ? ipfsFallbackReason : null),
      }));

      if (output.isJsonMode()) {
        output.json({
          taskId: found.taskId,
          title: found.title || metadata?.name,
          description: metadata?.description,
          status: found.status,
          project: projectTitle,
          payout: payout + ' PT',
          bountyToken: found.bountyToken,
          bountyPayout: bountyPayout,
          assignee: found.assignee,
          assigneeUsername: found.assigneeUsername,
          completer: found.completer,
          difficulty: metadata?.difficulty,
          estHours: metadata?.estimatedHours || metadata?.estHours,
          location: metadata?.location,
          submission: metadata?.submission,
          rejectionCount: found.rejectionCount || '0',
          rejections,
          requiresApplication: found.requiresApplication,
          applications: found.applications,
          createdAt: found.createdAt,
          assignedAt: found.assignedAt,
          submittedAt: found.submittedAt,
          completedAt: found.completedAt,
          // Additive v6 fields — only present when the org's TaskManager
          // supports deadlines and the on-chain read succeeded.
          ...(hasDeadlineData && onChain ? {
            absoluteDeadline: onChain.absoluteDeadline,
            completionWindow: onChain.completionWindow,
            claimDeadline: onChain.claimDeadline,
            claimState,
          } : {}),
          // Additive lens fallback when the subgraph has no applications yet.
          ...(lensApplicants ? {
            applicants: lensApplicants,
            applicantCount: lensApplicants.length,
          } : {}),
        });
      } else {
        console.log('');
        console.log(`  Task #${found.taskId}: ${found.title || metadata?.name || 'Untitled'}`);
        console.log(`  Project:     ${projectTitle}`);
        console.log(`  Status:      ${found.status}`);
        console.log(`  Payout:      ${payout} PT`);
        if (bountyPayout) console.log(`  Bounty:      ${bountyPayout} (${formatAddress(found.bountyToken)})`);
        if (found.assignee) console.log(`  Assignee:    ${found.assigneeUsername || found.assignee}`);
        if (found.completer) console.log(`  Completer:   ${found.completerUsername || found.completer}`);
        if (metadata?.description) console.log(`  Description: ${metadata.description}`);
        if (metadata?.difficulty) console.log(`  Difficulty:  ${metadata.difficulty}`);
        if (metadata?.estimatedHours || metadata?.estHours) console.log(`  Est Hours:   ${metadata.estimatedHours || metadata.estHours}`);
        if (metadata?.location) console.log(`  Location:    ${metadata.location}`);
        if (hasDeadlineData && onChain) {
          console.log('');
          console.log('  Deadlines');
          console.log(`    Absolute deadline:  ${onChain.absoluteDeadline
            ? `${formatDeadline(onChain.absoluteDeadline)} (${formatCountdown(onChain.absoluteDeadline)})`
            : 'none'}`);
          console.log(`    Completion window:  ${humanizeDuration(onChain.completionWindow)}`);
          if (onChain.claimDeadline) {
            console.log(`    Claim deadline:     ${formatDeadline(onChain.claimDeadline)} (${formatCountdown(onChain.claimDeadline)})`);
          }
          const sentence = deadlineSentence(onChain, claimState);
          if (sentence) console.log(`    → ${sentence}`);
        }
        if (found.requiresApplication) console.log(`  Requires Application: yes`);
        if (found.rejectionCount && parseInt(found.rejectionCount) > 0) {
          console.log(`  Rejections:  ${found.rejectionCount}`);
          for (const r of rejections) {
            const reason = r.reason || 'no reason given';
            console.log(`    - by ${r.rejector} — ${reason}`);
          }
        }
        if (found.applications?.length) {
          console.log(`  Applications: ${found.applications.length}`);
          for (const app of found.applications) {
            console.log(`    - ${app.applicantUsername || formatAddress(app.applicant)} (approved: ${app.approved})`);
          }
        } else if (lensApplicants?.length) {
          console.log(`  Applicants:  ${lensApplicants.length} (on-chain; subgraph not yet indexed)`);
          for (const applicant of lensApplicants) {
            console.log(`    - ${applicant}`);
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
