import type { Argv, ArgumentsCamelCase } from 'yargs';
import { resolveIdentityAddress } from '../../lib/signer';
import { ethers } from 'ethers';
import { query, queryWithFieldFallback } from '../../lib/subgraph';
import { FETCH_USERNAME, userDataTiers } from '../../queries/user';
import { resolveOrgId } from '../../lib/resolve';
import { formatToken } from '../../lib/format';
import { HOME_CHAIN_ID } from '../../config/networks';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface ProfileArgs {
  address?: string;
  org?: string;
  chain?: number;
  'private-key'?: string;
}

export const profileHandler = {
  builder: (yargs: Argv) => yargs
    .option('address', { type: 'string', describe: 'User address (defaults to signer)' })
    .example('pop user profile --org myorg', 'Profile + org membership stats for the signer')
    .example('pop user profile --address 0xabc... --json', 'Machine-readable profile for any address'),

  handler: async (argv: ArgumentsCamelCase<ProfileArgs>) => {
    const spin = output.spinner('Fetching profile...');
    spin.start();

    try {
      const address = resolveIdentityAddress(argv, { required: true, purpose: 'user profile' })!;

      // Fetch account info from home chain (best-effort — Gateway may require domain auth)
      let account: any = null;
      try {
        const accountResult = await query<any>(
          FETCH_USERNAME,
          { id: address.toLowerCase() },
          HOME_CHAIN_ID
        );
        account = accountResult.account;
      } catch {
        // Home chain account fetch failed (e.g. Gateway domain auth) — continue with org data
      }

      if (argv.org) {
        // Fetch org-specific user data. The subgraph User id is
        // "<orgHexId>-<address>", so org NAMES must resolve to the hex id
        // first (previously a name here silently matched nothing).
        const orgId = await resolveOrgId(argv.org, argv.chain);
        const orgUserID = `${orgId.toLowerCase()}-${address.toLowerCase()}`;
        const chainId = argv.chain;

        // Tier 0 carries the v7 claim-churn counters (Gnosis only today), tier 1
        // is the same document without them.
        const { data: userResult, tierIndex } = await queryWithFieldFallback<any>(
          userDataTiers(orgUserID, address.toLowerCase()),
          { chainId }
        );
        const hasChurn = tierIndex === 0;

        const user = userResult.user;

        spin.stop();

        if (output.isJsonMode()) {
          output.json({
            address,
            username: account?.username || userResult.account?.username,
            bio: account?.metadata?.bio,
            avatar: account?.metadata?.avatar,
            github: account?.metadata?.github,
            twitter: account?.metadata?.twitter,
            website: account?.metadata?.website,
            org: argv.org,
            membershipStatus: user?.membershipStatus,
            joinMethod: user?.joinMethod,
            currentHatIds: user?.currentHatIds,
            participationTokenBalance: user?.participationTokenBalance,
            totalTasksCompleted: user?.totalTasksCompleted,
            totalVotes: user?.totalVotes,
            totalModulesCompleted: user?.totalModulesCompleted,
            firstSeenAt: user?.firstSeenAt,
            lastActiveAt: user?.lastActiveAt,
            assignedTasks: user?.assignedTasks,
            completedTasks: user?.completedTasks,
            // Additive v7 churn keys, APPENDED at the end — never inserted
            // mid-object. Gated on the served tier, so a chain that does not
            // index releases omits them rather than reporting a false 0.
            ...(hasChurn ? {
              totalTasksReleased: user?.totalTasksReleased,
              totalTasksLostToExpiry: user?.totalTasksLostToExpiry,
            } : {}),
          });
        } else {
          console.log('');
          console.log(`  Address:  ${address}`);
          if (account?.username) console.log(`  Username: ${account.username}`);
          if (account?.metadata?.bio) console.log(`  Bio:      ${account.metadata.bio}`);
          if (account?.metadata?.github) console.log(`  GitHub:   ${account.metadata.github}`);
          if (account?.metadata?.twitter) console.log(`  Twitter:  ${account.metadata.twitter}`);
          if (account?.metadata?.website) console.log(`  Website:  ${account.metadata.website}`);
          console.log('');

          if (user) {
            console.log(`  Org: ${argv.org}`);
            console.log(`  Status: ${user.membershipStatus || 'Unknown'}`);
            console.log(`  Join Method: ${user.joinMethod || 'Unknown'}`);
            if (user.participationTokenBalance) {
              console.log(`  PT Balance: ${formatToken(user.participationTokenBalance, 18, 'PT')}`);
            }
            console.log(`  Tasks Completed: ${user.totalTasksCompleted || 0}`);
            console.log(`  Votes Cast: ${user.totalVotes || 0}`);
            console.log(`  Modules Completed: ${user.totalModulesCompleted || 0}`);

            // Suppressed at 0/0, which is every member on every chain today —
            // a permanent "Claims Released: 0 self, 0 expired" on every profile
            // would be noise, and the --json keys already carry the tier signal
            // for anything that needs to tell 0 apart from "not indexed".
            const released = Number(user.totalTasksReleased || 0);
            const lostToExpiry = Number(user.totalTasksLostToExpiry || 0);
            if (hasChurn && (released || lostToExpiry)) {
              console.log(`  Claims Released: ${released} self, ${lostToExpiry} expired`);
            }

            if (user.currentHatIds?.length) {
              console.log(`  Hats: ${user.currentHatIds.join(', ')}`);
            }

            // `assignedTasks` is @derivedFrom(assigneeUser), and handleTaskUnclaimed
            // nulls the task's assigneeUser — so a released task silently leaves this
            // list with no completion to match it. That is the release, not an
            // indexing gap; "Claims Released" above is where it shows up.
            if (user.assignedTasks?.length) {
              console.log('  Active Tasks:');
              for (const t of user.assignedTasks) {
                console.log(`    - #${t.taskId} ${t.title || ''} (${t.status})`);
              }
            }
          } else {
            console.log(`  Not a member of org ${argv.org}`);
          }
          console.log('');
        }
      } else {
        // Just show account info
        spin.stop();

        if (output.isJsonMode()) {
          output.json({
            address,
            username: account?.username,
            bio: account?.metadata?.bio,
            avatar: account?.metadata?.avatar,
            github: account?.metadata?.github,
            twitter: account?.metadata?.twitter,
            website: account?.metadata?.website,
          });
        } else {
          console.log('');
          console.log(`  Address:  ${address}`);
          if (account) {
            console.log(`  Username: ${account.username || 'Not set'}`);
            if (account.metadata?.bio) console.log(`  Bio:      ${account.metadata.bio}`);
            if (account.metadata?.github) console.log(`  GitHub:   ${account.metadata.github}`);
            if (account.metadata?.twitter) console.log(`  Twitter:  ${account.metadata.twitter}`);
            if (account.metadata?.website) console.log(`  Website:  ${account.metadata.website}`);
          } else {
            console.log(`  No account registered (use 'pop user register' to create one)`);
          }
          console.log('');
        }
      }
    } catch (err: any) {
      spin.stop();
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err?.message || String(err));
      process.exit(EXIT.USAGE);
    }
  },
};
