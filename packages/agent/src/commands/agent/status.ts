import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { query } from '@poa-box/cli/lib/subgraph';
import { resolveOrgModules } from '@poa-box/cli/lib/resolve';
import { resolveNetworkConfig } from '@poa-box/cli/config/networks';
import * as output from '@poa-box/cli/lib/output';

interface StatusArgs {
  org?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
}

const FETCH_AGENT_DATA = `
  query FetchAgentData($orgId: Bytes!) {
    organization(id: $orgId) {
      name
      participationToken { totalSupply }
      users(first: 100) {
        address
        participationTokenBalance
        membershipStatus
        totalTasksCompleted
        totalVotes
        account { username }
      }
      hybridVoting {
        proposals(where: { status: "Active" }, first: 50) {
          proposalId
          title
          status
          votes { voter }
        }
      }
      taskManager {
        projects(where: { deleted: false }, first: 100) {
          tasks(first: 1000) {
            id
            status
            assignee
          }
        }
      }
    }
  }
`;

export const agentStatusHandler = {
  builder: (yargs: Argv) => yargs,

  handler: async (argv: ArgumentsCamelCase<StatusArgs>) => {
    const spin = output.spinner('Fetching agent status...');
    spin.start();

    try {
      // Get wallet address
      const key = argv.privateKey as string || process.env.POP_PRIVATE_KEY;
      if (!key) throw new Error('No private key configured');
      const wallet = new ethers.Wallet(key);
      const myAddr = wallet.address.toLowerCase();

      // Get gas balance
      const networkConfig = resolveNetworkConfig(argv.chain);
      const provider = new ethers.providers.JsonRpcProvider(networkConfig.resolvedRpc);
      const gasBalance = await provider.getBalance(wallet.address);

      // Get org data
      const modules = await resolveOrgModules(argv.org, argv.chain);
      const result = await query<any>(FETCH_AGENT_DATA, { orgId: modules.orgId }, argv.chain);
      const org = result.organization;
      if (!org) throw new Error('Organization not found');

      // Find my user
      const me = org.users.find((u: any) => u.address?.toLowerCase() === myAddr);
      const totalSupply = ethers.BigNumber.from(org.participationToken?.totalSupply || '0');
      const myPT = ethers.BigNumber.from(me?.participationTokenBalance || '0');
      const sharePercent = totalSupply.gt(0) ? myPT.mul(10000).div(totalSupply).toNumber() / 100 : 0;

      // Count active proposals I haven't voted on
      const activeProposals = org.hybridVoting?.proposals || [];
      const unvoted = activeProposals.filter((p: any) =>
        !(p.votes || []).some((v: any) => v.voter?.toLowerCase() === myAddr)
      );

      // Count my tasks
      const allTasks = (org.taskManager?.projects || []).flatMap((p: any) => p.tasks || []);
      const myAssigned = allTasks.filter((t: any) => t.assignee?.toLowerCase() === myAddr && t.status === 'Assigned');
      const mySubmitted = allTasks.filter((t: any) => t.assignee?.toLowerCase() === myAddr && t.status === 'Submitted');
      const awaitingMyReview = allTasks.filter((t: any) =>
        t.status === 'Submitted' && t.assignee?.toLowerCase() !== myAddr
      );

      const data = {
        wallet: wallet.address,
        username: me?.account?.username || 'unregistered',
        org: org.name,
        gas: ethers.utils.formatEther(gasBalance),
        gasCurrency: networkConfig.nativeCurrency.symbol,
        pt: ethers.utils.formatEther(myPT),
        ptShare: `${sharePercent.toFixed(1)}%`,
        tasksCompleted: parseInt(me?.totalTasksCompleted || '0'),
        votesCast: parseInt(me?.totalVotes || '0'),
        memberStatus: me?.membershipStatus || 'Not a member',
        unvotedProposals: unvoted.length,
        myAssigned: myAssigned.length,
        mySubmitted: mySubmitted.length,
        awaitingMyReview: awaitingMyReview.length,
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
        if (data.unvotedProposals > 0) actions.push(`${data.unvotedProposals} proposal(s) need your vote`);
        if (data.awaitingMyReview > 0) actions.push(`${data.awaitingMyReview} task(s) await your review`);
        if (data.myAssigned > 0) actions.push(`${data.myAssigned} task(s) assigned to you`);
        if (data.mySubmitted > 0) actions.push(`${data.mySubmitted} task(s) submitted, awaiting review`);
        if (parseFloat(data.gas) < 0.01) actions.push('LOW GAS — fund wallet');

        if (actions.length > 0) {
          console.log('  Action items:');
          actions.forEach(a => console.log(`    - ${a}`));
        } else {
          console.log('  No pending actions.');
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
