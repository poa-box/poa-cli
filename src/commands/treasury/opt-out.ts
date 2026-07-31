/**
 * pop treasury opt-out / opt-in — toggle this wallet's distribution eligibility.
 *
 * PaymentManager.optOut(bool) is permissionless and idempotent (verified
 * against contracts origin/main src/PaymentManager.sol). While opted out,
 * claimDistribution reverts OptedOut for this wallet; opting back in
 * restores claims for still-active distributions. The pre-flight
 * short-circuits when the wallet is already in the requested state.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createReadContract, createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface OptArgs {
  org?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

async function runOptToggle(argv: ArgumentsCamelCase<OptArgs>, optOut: boolean): Promise<void> {
  const verb = optOut ? 'out of' : 'into';
  const spin = output.spinner(`Opting ${verb} distributions...`);
  spin.start();

  try {
    const ctx = await getWriteContext(argv);
    const paymentManagerAddress = requireModule(ctx.modules, 'paymentManagerAddress');

    // ── Pre-flight (skippable with --no-preflight) ──────────────────────
    // optOut(bool) is idempotent on-chain; skip the tx when it would no-op.
    //
    // Deliberately NOT served from the subgraph's OptOutToggle entity, for two reasons:
    //   1. That table is empty on every live deployment (zero OptOutToggled events have ever
    //      been emitted on Gnosis, verified across all nine PaymentManagers), so the mapping is
    //      unexercised and no live row proves it indexes correctly.
    //   2. This read GATES a write. Reading a stale "already opted out" right after an opt-in
    //      would short-circuit and silently leave the wallet in the wrong state — the one
    //      outcome this pre-flight exists to prevent. It is also the command's only read, so
    //      converting it would trade an eth_call for a GraphQL round-trip, not remove one.
    if (argv.preflight !== false) {
      const pmRead = createReadContract(paymentManagerAddress, 'PaymentManager', ctx.provider);
      const currentlyOptedOut: boolean = await pmRead.isOptedOut(ctx.address);
      if (currentlyOptedOut === optOut) {
        spin.stop();
        output.success(
          optOut ? 'Already opted out of distributions' : 'Already opted into distributions',
          { optedOut: currentlyOptedOut, noChange: true }
        );
        return;
      }
    }
    await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
    spin.stop();

    await confirmWrite(argv, {
      action: optOut
        ? 'opt OUT of distributions (claims revert while opted out)'
        : 'opt back INTO distributions',
      wallet: ctx.address,
      org: argv.org,
      chain: ctx.networkName,
    }, { actionLabel: 'About to update distribution opt-out state' });

    const txSpin = output.spinner(`Opting ${verb} distributions...`);
    txSpin.start();
    const pm = createWriteContract(paymentManagerAddress, 'PaymentManager', ctx.signer);
    const result = await executeTx(pm, 'optOut', [optOut], { dryRun: argv.dryRun });
    txSpin.stop();

    finishWrite(result, {
      successMsg: optOut ? 'Opted out of distributions' : 'Opted into distributions',
      fields: { optedOut: optOut },
    });
  } catch (err: any) {
    spin.stop();
    if (err instanceof CliError) {
      output.error(err.message, { suggestion: err.suggestion });
      process.exit(err.code);
    }
    output.error(err?.message || String(err));
    process.exit(EXIT.USAGE);
  }
}

export const optOutHandler = {
  builder: (yargs: Argv) => yargs
    .example('pop treasury opt-out', 'Exclude this wallet from distribution claims')
    .epilogue('Reversible any time with: pop treasury opt-in'),
  builderIn: (yargs: Argv) => yargs
    .example('pop treasury opt-in', 'Restore this wallet\'s ability to claim distributions'),

  handler: async (argv: ArgumentsCamelCase<OptArgs>) => runOptToggle(argv, true),
  handlerIn: async (argv: ArgumentsCamelCase<OptArgs>) => runOptToggle(argv, false),
};
