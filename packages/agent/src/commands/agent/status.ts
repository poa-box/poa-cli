import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveIdentityAddress } from '@poa-box/cli/lib/signer';
import { observeAgentProtocol } from '../../lib/protocol-observation';
import { resolveOrgModules } from '@poa-box/cli/lib/resolve';
import { resolveNetworkConfig } from '@poa-box/cli/config/networks';
import * as output from '@poa-box/cli/lib/output';

interface StatusArgs {
  org?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  address?: string;
}

export const agentStatusHandler = {
  builder: (yargs: Argv) => yargs,

  handler: async (argv: ArgumentsCamelCase<StatusArgs>) => {
    const spin = output.spinner('Fetching agent status...');
    spin.start();

    try {
      const address = resolveIdentityAddress(argv, { required: true, purpose: 'Agent status' })!;
      const myAddr = address.toLowerCase();
      const networkConfig = resolveNetworkConfig(argv.chain);
      const provider = new ethers.providers.JsonRpcProvider(argv.rpc || networkConfig.resolvedRpc, networkConfig.chainId);
      const modules = await resolveOrgModules(argv.org, argv.chain);
      const [gasBalance, observation] = await Promise.all([
        provider.getBalance(address), observeAgentProtocol(modules, networkConfig.chainId),
      ]);
      const { org, coverage, sources, memberTotal } = observation;

      // Find my user
      const me = org.users.find((u: any) => u.address?.toLowerCase() === myAddr);
      const totalSupply = org.participationToken?.totalSupply == null ? null : ethers.BigNumber.from(org.participationToken.totalSupply);
      const myPT = me?.participationTokenBalance == null ? null : ethers.BigNumber.from(me.participationTokenBalance);
      const sharePercent = myPT === null || totalSupply === null ? null : totalSupply.gt(0) ? myPT.mul(10000).div(totalSupply).toNumber() / 100 : 0;

      // Count active proposals I haven't voted on
      const activeProposals = [...(org.hybridVoting?.proposals || []), ...(org.directDemocracyVoting?.ddvProposals || [])]
        .filter((p: any) => p.status === 'Active' && p.winningOption == null);
      const unvoted = activeProposals.filter((p: any) =>
        p.ballotCoverage?.status === 'complete' && !(p.votes || []).some((v: any) => v.voter?.toLowerCase() === myAddr)
      );

      // Count my tasks
      const allTasks = (org.taskManager?.projects || []).flatMap((p: any) => p.tasks || []);
      const myAssigned = allTasks.filter((t: any) => t.assignee?.toLowerCase() === myAddr && t.status === 'Assigned');
      const mySubmitted = allTasks.filter((t: any) => t.assignee?.toLowerCase() === myAddr && t.status === 'Submitted');
      const awaitingMyReview = allTasks.filter((t: any) =>
        t.status === 'Submitted' && t.assignee?.toLowerCase() !== myAddr
      );

      const data = {
        wallet: address,
        username: me?.account?.username ?? null,
        org: org.name,
        gas: ethers.utils.formatEther(gasBalance),
        gasCurrency: networkConfig.nativeCurrency.symbol,
        pt: myPT === null ? null : ethers.utils.formatEther(myPT),
        ptShare: sharePercent === null ? null : `${sharePercent.toFixed(1)}%`,
        tasksCompleted: me?.totalTasksCompleted == null ? null : parseInt(me.totalTasksCompleted),
        votesCast: me?.totalVotes == null ? null : parseInt(me.totalVotes),
        memberStatus: coverage.members.status === 'complete' ? me?.membershipStatus || 'Not a member' : 'Unknown',
        historyIndexed: me?.historyIndexed ?? null,
        members: memberTotal, coverage, sources,
        unvotedProposals: coverage.hybrid.status === 'complete' && coverage.dd.status === 'complete' && activeProposals.every((p: any) => p.ballotCoverage?.status === 'complete') ? unvoted.length : null,
        observedUnvotedProposals: unvoted.length,
        myAssigned: coverage.tasks.status === 'complete' ? myAssigned.length : null,
        mySubmitted: coverage.tasks.status === 'complete' ? mySubmitted.length : null,
        awaitingMyReview: coverage.tasks.status === 'complete' ? awaitingMyReview.length : null,
      };

      spin.stop();

      if (output.isJsonMode()) {
        output.json(data);
      } else {
        console.log('');
        console.log(`  Agent Status — ${data.username}`);
        console.log('  ─────────────────────────────');
        console.log(`  Wallet:       ${data.wallet}`);
        console.log(`  Org:          ${data.org}`);
        console.log(`  Status:       ${data.memberStatus}`);
        console.log(`  Gas:          ${data.gas} ${data.gasCurrency}`);
        console.log('');
        console.log(`  PT:           ${data.pt} (${data.ptShare} of supply)`);
        console.log(`  Tasks done:   ${data.tasksCompleted}`);
        console.log(`  Votes cast:   ${data.votesCast}`);
        console.log('');

        // Action items
        const actions: string[] = [];
        if (data.unvotedProposals !== null && data.unvotedProposals > 0) actions.push(`${data.unvotedProposals} proposal(s) need your vote`);
        if (data.awaitingMyReview !== null && data.awaitingMyReview > 0) actions.push(`${data.awaitingMyReview} task(s) await your review`);
        if (data.myAssigned !== null && data.myAssigned > 0) actions.push(`${data.myAssigned} task(s) assigned to you`);
        if (data.mySubmitted !== null && data.mySubmitted > 0) actions.push(`${data.mySubmitted} task(s) submitted, awaiting review`);
        if (parseFloat(data.gas) < 0.01) actions.push('LOW GAS — fund wallet');

        if (actions.length > 0) {
          console.log('  Action items:');
          actions.forEach(a => console.log(`    - ${a}`));
        } else {
          console.log(Object.values(coverage).some(c => c.status !== 'complete') ? '  Some observations are unavailable; inspect coverage before acting.' : '  No pending actions.');
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
