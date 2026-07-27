/**
 * pop user join — join an org via QuickJoin, registering a username first
 * when needed.
 *
 * P0 fix (verified contracts origin/main src/QuickJoin.sol): quickJoinWithUser()
 * reads `accountRegistry.getUsername(msg.sender)` and reverts NoUsername when
 * it is empty — the old command advertised --username but never registered it,
 * so fresh accounts always reverted. New flow:
 *
 *   1. Read the username from the SAME registry QuickJoin consults
 *      (quickJoin.accountRegistry() — the authoritative source for this org).
 *   2. Username exists            → one tx: quickJoinWithUser().
 *   3. No username + --username   → two txs: UAR.registerAccount(username),
 *                                    then quickJoinWithUser().
 *   4. No username, no flag, TTY  → prompt for a username, then flow 3.
 *   5. No username, no flag, non-TTY → actionable CliError (exit 1).
 *
 * Pre-flight (skippable with --no-preflight): gas balance always; when
 * registering, checkUsernameFree fails fast (exit 4) if the name is taken
 * (UAR.registerAccount would revert UsernameTaken).
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createReadContract, createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { requireModule } from '../../lib/resolve';
import { requireValidUsername } from '../../lib/validation';
import { runPreflight, checkGasBalance, checkUsernameFree } from '../../lib/preflight';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { isInteractive, input } from '../../lib/prompt';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface JoinArgs {
  org: string;
  username?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

/** requireValidUsername as a prompt validator (true | error message). */
function usernameValidator(value: string): string | true {
  try {
    requireValidUsername(value);
    return true;
  } catch (err: any) {
    return err?.message || 'Invalid username';
  }
}

export const joinHandler = {
  builder: (yargs: Argv) => yargs
    .option('username', { type: 'string', describe: 'Username to register (only needed if not already registered)' })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Explicit idempotency key. Two joins for the same org within the TTL return the same result without re-submitting. Default: auto-derived from argv.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit.',
    })
    .example('pop user join --org myorg', 'Join with an already-registered username (1 tx)')
    .example('pop user join --org myorg --username alice', 'Register the username, then join (2 txs)'),

  handler: async (argv: ArgumentsCamelCase<JoinArgs>) => {
    const spin = output.spinner('Checking account state...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);
      const quickJoinAddr = requireModule(ctx.modules, 'quickJoinAddress');

      // The registry QuickJoin actually consults on join — registering on any
      // other registry would leave quickJoinWithUser reverting NoUsername.
      const quickJoin = createReadContract(quickJoinAddr, 'QuickJoinNew', ctx.provider);
      let registryAddr: string;
      let existingUsername: string;
      try {
        registryAddr = await quickJoin.accountRegistry();
        const registry = createReadContract(registryAddr, 'UniversalAccountRegistry', ctx.provider);
        existingUsername = await registry.getUsername(ctx.address);
      } catch (err: any) {
        throw new CliError(
          `Could not read the account registry via QuickJoin at ${quickJoinAddr}: ${err?.message || err}`,
          EXIT.INFRA,
          'Check RPC connectivity and that the org QuickJoin address is correct (pop config validate).'
        );
      }

      const needsRegistration = existingUsername.length === 0;
      let username = argv.username;

      if (needsRegistration && !username) {
        spin.stop();
        if (!isInteractive()) {
          throw new CliError(
            'No username registered. Pass --username <name> to register and join in one go.',
            EXIT.USAGE,
            'Example: pop user join --org <org> --username <name>'
          );
        }
        username = await input('Username to register (3-32 chars, letters/numbers/underscores)?', {
          validate: usernameValidator,
        });
        spin.start();
      }

      if (needsRegistration) {
        try {
          username = requireValidUsername(username!);
        } catch (err: any) {
          throw new CliError(err.message, EXIT.USAGE);
        }
      } else if (username && username !== existingUsername) {
        output.warn(
          `Already registered as "${existingUsername}" — ignoring --username ${username} ` +
          '(use pop user update-profile --username to change it).'
        );
      }

      // ── Pre-flight: gas always; username-free only for the NEW registration ──
      const checks = [checkGasBalance(ctx.address)];
      if (needsRegistration) {
        checks.push(checkUsernameFree(registryAddr, username!));
      }
      await runPreflight(ctx.provider, checks, { skip: argv.preflight === false });
      spin.stop();

      await confirmWrite(argv, {
        org: argv.org,
        username: needsRegistration ? `${username} (new registration)` : existingUsername,
        transactions: needsRegistration
          ? '2 transactions (registerAccount, then quickJoinWithUser)'
          : '1 transaction (quickJoinWithUser)',
        chain: ctx.networkName,
      }, { actionLabel: 'About to join organization' });

      const run = async (): Promise<Record<string, any>> => {
        // Tx 1 (registration path only): register the username on the
        // registry QuickJoin consults. finishWrite exits on failure, so the
        // join tx never runs after a failed registration.
        if (needsRegistration) {
          const txSpin = output.spinner(`Registering username "${username}"...`);
          txSpin.start();
          const registry = createWriteContract(registryAddr, 'UniversalAccountRegistry', ctx.signer);
          const regResult = await executeTx(registry, 'registerAccount', [username], { dryRun: argv.dryRun });
          txSpin.stop();
          finishWrite(regResult, {
            successMsg: `Username "${username}" registered (tx 1/2)`,
            fields: { username, registry: registryAddr },
          });
          if (argv.dryRun) {
            output.info(
              'Dry run stops after simulating registerAccount — quickJoinWithUser can only be ' +
              'simulated once the username registration has landed on-chain.'
            );
            return { orgId: ctx.orgId, username };
          }
        }

        // Tx 2 (or the only tx): join.
        const txSpin = output.spinner('Joining organization...');
        txSpin.start();
        const contract = createWriteContract(quickJoinAddr, 'QuickJoinNew', ctx.signer);
        const result = await executeTx(contract, 'quickJoinWithUser', [], { dryRun: argv.dryRun });
        txSpin.stop();

        finishWrite(result, {
          successMsg: 'Joined organization',
          fields: {
            orgId: ctx.orgId,
            username: needsRegistration ? username : existingUsername,
          },
        });
        return { orgId: ctx.orgId, username: needsRegistration ? username : existingUsername, txHash: result.txHash };
      };

      // Dry runs simulate unconditionally: they neither consult nor record
      // the idempotency cache (nothing lands on-chain).
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'user.join', run);
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
