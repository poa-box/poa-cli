import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { query } from '../../lib/subgraph';
import { FETCH_USERNAME, FETCH_USER_DATA } from '../../queries/user';
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
      const address = argv.address || (() => {
        const key = argv.privateKey as string || process.env.POP_PRIVATE_KEY;
        if (!key) throw new Error('Provide --address or --private-key to identify user');
        return new ethers.Wallet(key).address;
      })();

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

        const userResult = await query<any>(
          FETCH_USER_DATA,
          { orgUserID, userAddress: address.toLowerCase() },
          chainId
        );

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

            if (user.currentHatIds?.length) {
              console.log(`  Hats: ${user.currentHatIds.join(', ')}`);
            }

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
