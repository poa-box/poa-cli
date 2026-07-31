import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { query } from '@poa/cli/lib/subgraph';
import { resolveOrgModules } from '@poa/cli/lib/resolve';
import { resolveNetworkConfig } from '@poa/cli/config/networks';
import { createReadContract } from '@poa/cli/lib/contracts';
import { resolveVotingContracts } from '@poa/cli/commands/vote/helpers';
import { getNoAllocationSet } from '@poa/cli/lib/no-alloc-cache';
import * as output from '@poa/cli/lib/output';

interface TriageArgs {
  org?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
}

interface Action {
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  type: string;
  detail: string;
  data?: any;
}

const FETCH_TRIAGE_DATA = `
  query FetchTriageData($orgId: Bytes!) {
    organization(id: $orgId) {
      name
      participationToken { totalSupply }
      users(first: 100) {
        address
        participationTokenBalance
        membershipStatus
        totalTasksCompleted
        account { username }
      }
      hybridVoting {
        proposals(first: 100) {
          proposalId
          title
          status
          endTimestamp
          winningOption
          votes { voter }
        }
      }
      taskManager {
        projects(where: { deleted: false }, first: 100) {
          tasks(first: 1000) {
            taskId
            title
            status
            assignee
            assigneeUsername
            rejectionCount
          }
        }
      }
      paymentManager {
        distributions(where: { status: "Active" }, first: 20) {
          distributionId
          claims { claimer }
        }
      }
    }
  }
`;

export const triageHandler = {
  builder: (yargs: Argv) => yargs,

  handler: async (argv: ArgumentsCamelCase<TriageArgs>) => {
    const spin = output.spinner('Running triage...');
    spin.start();

    try {
      // --- Gather data ---
      const key = argv.privateKey as string || process.env.POP_PRIVATE_KEY;
      if (!key) throw new Error('No private key configured');
      const wallet = new ethers.Wallet(key);
      const myAddr = wallet.address.toLowerCase();

      const modules = await resolveOrgModules(argv.org, argv.chain);
      const networkConfig = resolveNetworkConfig(argv.chain);
      const provider = new ethers.providers.JsonRpcProvider(networkConfig.resolvedRpc);

      const [gasBalance, orgData] = await Promise.all([
        provider.getBalance(wallet.address),
        query<any>(FETCH_TRIAGE_DATA, { orgId: modules.orgId }, argv.chain),
      ]);

      const org = orgData.organization;
      if (!org) throw new Error('Organization not found');

      const now = Math.floor(Date.now() / 1000);
      const actions: Action[] = [];
      const changes: Action[] = [];

      // --- Load last known state for change detection ---
      const orgStatePath = path.join(homedir(), '.pop-agent', 'brain', 'Memory', 'org-state.md');
      let lastState = '';
      try { lastState = fs.readFileSync(orgStatePath, 'utf8'); } catch {}

      const activeMembers = org.users.filter((u: any) => u.membershipStatus === 'Active');
      const totalSupply = ethers.utils.formatEther(org.participationToken?.totalSupply || '0');
      const allTasks = (org.taskManager?.projects || []).flatMap((p: any) => p.tasks || []);
      const proposals = org.hybridVoting?.proposals || [];

      // --- 1. BLOCKERS (CRITICAL) ---

      // Gas check
      const gasEther = parseFloat(ethers.utils.formatEther(gasBalance));
      if (gasEther < 0.01) {
        actions.push({ priority: 'CRITICAL', type: 'gas', detail: `Gas critically low: ${gasEther.toFixed(4)} ${networkConfig.nativeCurrency.symbol}. Fund wallet immediately.` });
      } else if (gasEther < 0.1) {
        actions.push({ priority: 'HIGH', type: 'gas', detail: `Gas low: ${gasEther.toFixed(3)} ${networkConfig.nativeCurrency.symbol}. Consider refueling.` });
      }

      // Rejected tasks
      const myRejected = allTasks.filter((t: any) =>
        t.assignee?.toLowerCase() === myAddr &&
        t.status === 'Assigned' &&
        parseInt(t.rejectionCount || '0') > 0
      );
      for (const t of myRejected) {
        actions.push({ priority: 'CRITICAL', type: 'rejected', detail: `Task #${t.taskId} "${t.title}" was rejected (${t.rejectionCount}x). Fix and re-submit before new work.`, data: { taskId: t.taskId } });
      }

      // --- 2. QUEUE (HIGH) ---

      // Expired proposals needing announce (with callStatic to filter zombies)
      const expiredCandidates = proposals.filter((p: any) =>
        p.status === 'Active' &&
        p.winningOption == null &&
        p.endTimestamp && parseInt(p.endTimestamp) < now
      );
      if (expiredCandidates.length > 0) {
        try {
          const votingContracts = await resolveVotingContracts(argv.org as string, argv.chain);
          const hybridAddr = votingContracts.hybridVotingAddress;
          if (hybridAddr) {
            const votingContract = createReadContract(hybridAddr, 'HybridVotingNew', provider);
            for (const p of expiredCandidates) {
              try {
                await votingContract.callStatic.announceWinner(p.proposalId);
                // callStatic succeeded — this proposal CAN be announced
                actions.push({ priority: 'HIGH', type: 'announce', detail: `Proposal #${p.proposalId} "${p.title}" expired — run announce-all.`, data: { proposalId: p.proposalId } });
              } catch {
                // callStatic failed — zombie proposal, skip silently
              }
            }
          }
        } catch {
          // Voting contract resolution failed — fall back to listing all expired
          for (const p of expiredCandidates) {
            actions.push({ priority: 'HIGH', type: 'announce', detail: `Proposal #${p.proposalId} "${p.title}" expired — run announce-all.`, data: { proposalId: p.proposalId } });
          }
        }
      }

      // Unvoted proposals
      const activeProposals = proposals.filter((p: any) =>
        p.status === 'Active' && p.winningOption == null && !(parseInt(p.endTimestamp) < now)
      );
      for (const p of activeProposals) {
        const hasVoted = (p.votes || []).some((v: any) => v.voter?.toLowerCase() === myAddr);
        if (!hasVoted) {
          const minutesLeft = p.endTimestamp ? Math.floor((parseInt(p.endTimestamp) - now) / 60) : Infinity;
          const urgency = minutesLeft < 60 ? 'CRITICAL' : minutesLeft < 360 ? 'HIGH' : 'MEDIUM';
          actions.push({ priority: urgency as any, type: 'vote', detail: `Proposal #${p.proposalId} "${p.title}" — unvoted, ${minutesLeft < 60 ? minutesLeft + ' min left!' : Math.floor(minutesLeft / 60) + 'h left'}.`, data: { proposalId: p.proposalId, minutesLeft } });
        }
      }

      // Pending reviews (submitted by others)
      const pendingReviews = allTasks.filter((t: any) =>
        t.status === 'Submitted' && t.assignee?.toLowerCase() !== myAddr
      );
      for (const t of pendingReviews) {
        actions.push({ priority: 'HIGH', type: 'review', detail: `Task #${t.taskId} "${t.title}" by ${t.assigneeUsername || 'unknown'} — needs review.`, data: { taskId: t.taskId } });
      }

      // Batch-review prompt (task #406, HB#485 throughput fix).
      // When review backlog exceeds 5, surface a dedicated batch-review
      // action so the heartbeat skill prioritizes clearing the queue.
      if (pendingReviews.length > 5) {
        actions.unshift({
          priority: 'HIGH',
          type: 'batch-review',
          detail: `Review backlog: ${pendingReviews.length} tasks pending. Dedicate this heartbeat to batch review (up to 5 per HB).`,
          data: { count: pendingReviews.length },
        });
      }

      // Open retros needing response (task #344). Surface a HIGH action
      // when an open retro exists whose author is NOT me AND I have
      // not yet posted a response. The retro must be "fresh" — created
      // within the last ~75 minutes (~5 HBs at 15-min cadence) so we
      // don't pester the on-call agent with stale retros indefinitely.
      //
      // Cost guard: check doc-heads.json directly (cheap filesystem
      // read) before spinning up the helia node for a brain read. The
      // typical case is "no retros doc yet" which should skip the
      // expensive path entirely.
      try {
        const manifestPath = path.join(homedir(), '.pop-agent', 'brain', 'doc-heads.json');
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (manifest['pop.brain.retros']) {
            // Dynamic import so the non-retro-using triage path doesn't
            // pay the brain.ts module-load cost (which pulls in ethers +
            // automerge + a lazy helia reference).
            const { readBrainDoc, stopBrainNode } = require('../../lib/brain');
            try {
              const { doc: retrosDoc } = await readBrainDoc('pop.brain.retros');
              const retros: any[] = Array.isArray(retrosDoc?.retros) ? retrosDoc.retros : [];
              const freshThresholdSecs = 75 * 60; // 5 HBs x 15 min
              const nowSecs = Math.floor(Date.now() / 1000);
              for (const retro of retros) {
                if (!retro || retro.removed) continue;
                if (retro.status !== 'open' && retro.status !== 'discussed') continue;
                const author = (retro.author ?? '').toLowerCase();
                if (!author || author === myAddr) continue;
                const age = retro.createdAt ? nowSecs - retro.createdAt : Infinity;
                if (age > freshThresholdSecs) continue;
                const discussion: any[] = Array.isArray(retro.discussion) ? retro.discussion : [];
                const alreadyResponded = discussion.some((e: any) =>
                  (e?.author ?? '').toLowerCase() === myAddr,
                );
                if (alreadyResponded) continue;
                const changeCount = Array.isArray(retro.proposedChanges)
                  ? retro.proposedChanges.length
                  : 0;
                actions.push({
                  priority: 'HIGH',
                  type: 'retro-respond',
                  detail:
                    `Retro "${retro.id}" by ${author.slice(0, 10)} needs your response ` +
                    `(${changeCount} proposed change${changeCount === 1 ? '' : 's'}, ` +
                    `${Math.floor(age / 60)}min old). ` +
                    `Run: pop brain retro show ${retro.id} && pop brain retro respond --to ${retro.id} --message "..."`,
                  data: {
                    retroId: retro.id,
                    author,
                    changeCount,
                    ageSeconds: age,
                  },
                });
              }
            } finally {
              // Tear down the brain node so the triage process can exit
              // cleanly. readBrainDoc caches the helia instance and it
              // will hold the event loop open otherwise.
              try { await stopBrainNode(); } catch { /* best-effort */ }
            }
          }
        }
      } catch {
        // Brain retro check is best-effort — a missing manifest, a
        // malformed doc, or a transient helia error should never break
        // triage for the rest of the org state.
      }

      // Open brainstorms needing response (task #354 phase c, HB#209).
      // Same shape as the retro hook above but for pop.brain.brainstorms.
      // Surface HIGH action when an open brainstorm exists whose author is
      // NOT me AND I have not yet posted a message, added an idea, or cast
      // a vote. "Fresh" window is the same 75-min (5 HB) threshold.
      try {
        const manifestPath = path.join(homedir(), '.pop-agent', 'brain', 'doc-heads.json');
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (manifest['pop.brain.brainstorms']) {
            const { readBrainDoc, stopBrainNode } = require('../../lib/brain');
            try {
              const { doc: brainstormsDoc } = await readBrainDoc('pop.brain.brainstorms');
              const brainstorms: any[] = Array.isArray(brainstormsDoc?.brainstorms)
                ? brainstormsDoc.brainstorms
                : [];
              const freshThresholdSecs = 75 * 60; // same as retro cadence
              const nowSecs = Math.floor(Date.now() / 1000);
              for (const b of brainstorms) {
                if (!b || b.removed) continue;
                // Only "open" or "voting" brainstorms need responses;
                // "closed" and "promoted" have been resolved already
                if (b.status !== 'open' && b.status !== 'voting') continue;
                const author = (b.author ?? '').toLowerCase();
                if (!author || author === myAddr) continue;
                const age = b.openedAt ? nowSecs - b.openedAt : Infinity;
                if (age > freshThresholdSecs) continue;
                // Have I already engaged with this brainstorm? Check both
                // the discussion array (for --message posts) and any idea's
                // votes map (for --vote casts)
                const discussion: any[] = Array.isArray(b.discussion) ? b.discussion : [];
                const postedMessage = discussion.some((e: any) =>
                  (e?.author ?? '').toLowerCase() === myAddr,
                );
                const ideas: any[] = Array.isArray(b.ideas) ? b.ideas : [];
                const voted = ideas.some((idea: any) => {
                  const votes = idea?.votes;
                  return votes && typeof votes === 'object' && votes[myAddr] != null;
                });
                const addedIdea = ideas.some((idea: any) =>
                  (idea?.author ?? '').toLowerCase() === myAddr,
                );
                if (postedMessage || voted || addedIdea) continue;
                const ideaCount = ideas.length;
                actions.push({
                  priority: 'HIGH',
                  type: 'brainstorm-respond',
                  detail:
                    `Brainstorm "${b.id}" by ${author.slice(0, 10)} needs your response ` +
                    `(${ideaCount} idea${ideaCount === 1 ? '' : 's'}, ` +
                    `status=${b.status}, ${Math.floor(age / 60)}min old). ` +
                    `Run: pop brain read --doc pop.brain.brainstorms --json | less && ` +
                    `pop brain brainstorm-respond --id ${b.id} --message "..." [--add-idea "..."] [--vote idea-id=support]`,
                  data: {
                    brainstormId: b.id,
                    author,
                    ideaCount,
                    status: b.status,
                    ageSeconds: age,
                  },
                });
              }
            } finally {
              try { await stopBrainNode(); } catch { /* best-effort */ }
            }
          }
        }
      } catch {
        // Brainstorm check is best-effort — same isolation as the retro check.
      }

      // Unclaimed distributions — skip ones known to have no allocation for this address
      const noAllocSet = getNoAllocationSet(myAddr);
      const orgIdLower = modules.orgId.toLowerCase();
      const unclaimedDist = (org.paymentManager?.distributions || []).filter((d: any) => {
        // Skip if I've already claimed it
        if ((d.claims || []).some((c: any) => c.claimer?.toLowerCase() === myAddr)) return false;
        // Skip if I've verified I have no allocation in this distribution before
        const cacheKey = `${orgIdLower}-${d.distributionId}`;
        if (noAllocSet.has(cacheKey)) return false;
        return true;
      });
      if (unclaimedDist.length > 0) {
        actions.push({ priority: 'HIGH', type: 'claim', detail: `${unclaimedDist.length} unclaimed distribution(s) — run claim-mine.` });
      }

      // --- 3. WORK (MEDIUM) ---

      // My assigned tasks
      const myAssigned = allTasks.filter((t: any) =>
        t.assignee?.toLowerCase() === myAddr && t.status === 'Assigned' && parseInt(t.rejectionCount || '0') === 0
      );
      for (const t of myAssigned) {
        actions.push({ priority: 'MEDIUM', type: 'work', detail: `Task #${t.taskId} "${t.title}" assigned to you.`, data: { taskId: t.taskId } });
      }

      // Open tasks available to claim
      const openTasks = allTasks.filter((t: any) => t.status === 'Open');
      if (openTasks.length > 0) {
        actions.push({ priority: 'MEDIUM', type: 'claim-task', detail: `${openTasks.length} open task(s) available to claim.`, data: { tasks: openTasks.map((t: any) => ({ id: t.taskId, title: t.title })) } });
      }

      // --- 4. PLAN (LOW) ---

      const hasWork = myAssigned.length > 0 || openTasks.length > 0 || pendingReviews.length > 0;
      if (!hasWork && expiredCandidates.length === 0 && myRejected.length === 0) {
        actions.push({ priority: 'LOW', type: 'plan', detail: 'Board is empty — planning mandatory. Read goals.md, create tasks, explore capabilities.' });
      }

      // --- 4b. AUDIT OPPORTUNITIES (when board is empty) ---
      if (!hasWork) {
        try {
          const { queryAllChains } = require('@poa/cli/lib/subgraph');
          const exploreQuery = `query($first:Int!){organizations(first:$first){name users(first:100){membershipStatus} taskManager{projects(where:{deleted:false},first:10){tasks(first:200){status}}} hybridVoting{proposals(first:50){status}}}}`;
          const exploreResults = await queryAllChains(exploreQuery, { first: 10 });
          for (const cr of exploreResults) {
            if (!cr.data?.organizations) continue;
            for (const org of cr.data.organizations) {
              if (org.name === 'Argus' || /^test/i.test(org.name)) continue;
              const members = (org.users || []).filter((u: any) => u.membershipStatus === 'Active').length;
              if (members < 2) continue;
              const allTasks = (org.taskManager?.projects || []).flatMap((p: any) => p.tasks || []);
              const completed = allTasks.filter((t: any) => t.status === 'Completed').length;
              const proposals = org.hybridVoting?.proposals?.length || 0;
              if (members >= 3 && proposals === 0) {
                actions.push({ priority: 'MEDIUM', type: 'audit-opportunity', detail: `${org.name} (${cr.name}): ${members} members, 0 proposals — audit opportunity.` });
              }
            }
          }
        } catch { /* non-critical */ }
      }

      // --- 5. CHANGE DETECTION ---

      // New members
      const memberNames = activeMembers.map((u: any) => u.account?.username || u.address.slice(0, 10));
      for (const name of memberNames) {
        if (lastState && !lastState.includes(name)) {
          changes.push({ priority: 'INFO', type: 'member_joined', detail: `New member: ${name}` });
        }
      }

      // PT milestones
      const ptNum = parseFloat(totalSupply);
      const milestones = [100, 250, 500, 1000, 2000, 5000];
      for (const m of milestones) {
        if (ptNum >= m && lastState && !lastState.includes(`${m}`)) {
          // Rough check — could false-positive but better than nothing
        }
      }

      // Proposal state changes
      const executedProposals = proposals.filter((p: any) => p.status === 'Executed');
      for (const p of executedProposals) {
        if (lastState && !lastState.includes(`#${p.proposalId}`)) {
          changes.push({ priority: 'INFO', type: 'proposal_executed', detail: `Proposal #${p.proposalId} "${p.title}" was executed.` });
        }
      }

      // Sort actions by priority
      const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
      actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

      spin.stop();

      // --- Output ---
      const context = {
        gas: `${gasEther.toFixed(3)} ${networkConfig.nativeCurrency.symbol}`,
        gasStatus: gasEther < 0.01 ? 'CRITICAL' : gasEther < 0.1 ? 'LOW' : 'HEALTHY',
        members: activeMembers.length,
        ptSupply: Math.round(ptNum),
        pendingVotes: actions.filter(a => a.type === 'vote').length,
        pendingReviews: pendingReviews.length,
        rejectedTasks: myRejected.length,
        openTasks: openTasks.length,
        assignedTasks: myAssigned.length,
        boardState: hasWork ? 'has-work' : 'empty',
      };

      if (output.isJsonMode()) {
        output.json({ actions, changes, context });
      } else {
        console.log('');
        console.log('  Agent Triage');
        console.log('  ════════════');

        if (actions.length === 0) {
          console.log('  No actions needed.');
        } else {
          for (const a of actions) {
            const icon = a.priority === 'CRITICAL' ? '\x1b[31m!!\x1b[0m' :
                         a.priority === 'HIGH' ? '\x1b[33m!\x1b[0m' :
                         a.priority === 'MEDIUM' ? '\x1b[36m·\x1b[0m' :
                         a.priority === 'LOW' ? '\x1b[90m○\x1b[0m' : '\x1b[90mℹ\x1b[0m';
            console.log(`  ${icon} [${a.priority}] ${a.detail}`);
          }
        }

        if (changes.length > 0) {
          console.log('');
          console.log('  Changes since last heartbeat:');
          for (const c of changes) {
            console.log(`    △ ${c.detail}`);
          }
        }

        console.log('');
        console.log(`  Context: ${context.members} members | ${context.ptSupply} PT | Gas: ${context.gas} (${context.gasStatus}) | Board: ${context.boardState}`);
        console.log('');
      }
      // --- Auto-update org-state.md for next triage's change detection ---
      const executedIds = executedProposals.map((p: any) => `#${p.proposalId}`).join(', ');
      const memberList = activeMembers.map((u: any) => u.account?.username || u.address.slice(0, 10)).join(', ');
      const stateSnapshot = [
        `# Org State — ${org.name}`,
        `*Auto-updated by triage: ${new Date().toISOString()}*`,
        '',
        `Members: ${memberList}`,
        `PT Supply: ${Math.round(ptNum)}`,
        `Completed tasks: ${allTasks.filter((t: any) => t.status === 'Completed').length}`,
        `Executed proposals: ${executedIds}`,
        `Gas: ${gasEther.toFixed(3)} ${networkConfig.nativeCurrency.symbol}`,
      ].join('\n');

      try {
        fs.writeFileSync(orgStatePath, stateSnapshot + '\n');
      } catch {
        // Non-critical — org-state.md write failure shouldn't break triage
      }

    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
