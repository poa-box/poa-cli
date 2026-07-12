/**
 * pop role admin — EligibilityModule superAdmin operations.
 *
 * All gates VERIFIED against contracts origin/main src/EligibilityModule.sol
 * (every subcommand is onlySuperAdmin):
 *   transfer      → transferSuperAdmin(address) — DESTRUCTIVE: hands over the
 *                   ENTIRE module (roles, eligibility, vouching, pause).
 *   mint          → mintHatToAddress(uint256 hatId, address wearer) for one
 *                   wearer; batchMintHats(uint256[] hatIds, address[] wearers)
 *                   for several (names/signatures verified in the ABI).
 *   pause/unpause → emergency-stop for eligibility writes + vouching flows.
 *   set-join-time → setUserJoinTime(address, uint256) with --timestamp, else
 *                   setUserJoinTimeNow(address) (both verified) — governs the
 *                   new-account vouching grace.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { requireAddress } from '../../lib/validation';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { parseHatId, requireSuperAdmin, isPaused } from '../vouch/helpers';

/** Shared catch tail for every admin handler. */
function handleError(spin: { stop: () => any }, err: any): never {
  spin.stop();
  if (err instanceof CliError) {
    output.error(err.message, { suggestion: err.suggestion });
    process.exit(err.code);
  }
  output.error(err?.message || String(err));
  process.exit(EXIT.USAGE);
}

interface AdminBaseArgs {
  org?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

// ────────────────────────────── transfer ──────────────────────────────

interface TransferArgs extends AdminBaseArgs {
  to: string;
}

const adminTransferHandler = {
  builder: (yargs: Argv) => yargs
    .option('to', { type: 'string', demandOption: true, describe: 'New superAdmin address' })
    .example('pop role admin transfer --to 0xabc... --yes', 'Hand the module to a new superAdmin (irreversible without their cooperation)'),

  handler: async (argv: ArgumentsCamelCase<TransferArgs>) => {
    const spin = output.spinner('Preparing transferSuperAdmin...');
    spin.start();

    try {
      const to = requireAddress(argv.to, 'to');
      const ctx = await getWriteContext(argv);
      const eligibilityModuleAddress = requireModule(ctx.modules, 'eligibilityModuleAddress');

      if (argv.preflight !== false) {
        await requireSuperAdmin(ctx.provider, eligibilityModuleAddress, ctx.address, 'Transferring the superAdmin');
        if (to.toLowerCase() === ctx.address.toLowerCase()) {
          throw new PreconditionError('The target is already the superAdmin (you).', 'Pass a different --to address.');
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      output.warn(
        'This hands over the ENTIRE eligibility module — role creation, minting, eligibility, vouching config, ' +
        'and pause control all move to the new superAdmin. It is irreversible unless the new superAdmin transfers back.'
      );

      await confirmWrite(argv, {
        module: eligibilityModuleAddress,
        currentSuperAdmin: ctx.address,
        newSuperAdmin: to,
        org: argv.org,
        chain: ctx.networkName,
      }, { destructive: true, actionLabel: 'About to transfer superAdmin' });

      const txSpin = output.spinner('Sending transferSuperAdmin...');
      txSpin.start();
      const contract = createWriteContract(eligibilityModuleAddress, 'EligibilityModuleNew', ctx.signer);
      const result = await executeTx(contract, 'transferSuperAdmin', [to], { dryRun: argv.dryRun });
      txSpin.stop();

      finishWrite(result, {
        successMsg: `SuperAdmin transferred to ${to}`,
        fields: { newSuperAdmin: to, previousSuperAdmin: ctx.address },
      });
    } catch (err: any) {
      handleError(spin, err);
    }
  },
};

// ────────────────────────────── mint ──────────────────────────────

interface MintArgs extends AdminBaseArgs {
  hat: string;
  wearer: string;
}

const adminMintHandler = {
  builder: (yargs: Argv) => yargs
    .option('hat', { type: 'string', demandOption: true, describe: 'Hat ID to mint' })
    .option('wearer', { type: 'string', demandOption: true, describe: 'Recipient address (comma-separate for several)' })
    .example('pop role admin mint --hat 123 --wearer 0xabc...', 'Mint hat 123 to one member')
    .example('pop role admin mint --hat 123 --wearer 0xabc...,0xdef...', 'Batch-mint hat 123 to two members'),

  handler: async (argv: ArgumentsCamelCase<MintArgs>) => {
    const spin = output.spinner('Preparing hat mint...');
    spin.start();

    try {
      const hatId = parseHatId(argv.hat);
      const wearers = String(argv.wearer)
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .map(addr => requireAddress(addr, 'wearer'));
      if (wearers.length === 0) {
        throw new CliError('No valid --wearer addresses provided.', EXIT.USAGE);
      }

      const ctx = await getWriteContext(argv);
      const eligibilityModuleAddress = requireModule(ctx.modules, 'eligibilityModuleAddress');

      if (argv.preflight !== false) {
        await requireSuperAdmin(ctx.provider, eligibilityModuleAddress, ctx.address, 'Minting hats');
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        hat: hatId.toString(),
        wearers: wearers.join(', '),
        method: wearers.length === 1 ? 'mintHatToAddress' : 'batchMintHats',
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to mint hat(s)' });

      const txSpin = output.spinner('Minting...');
      txSpin.start();
      const contract = createWriteContract(eligibilityModuleAddress, 'EligibilityModuleNew', ctx.signer);
      const result = wearers.length === 1
        ? await executeTx(contract, 'mintHatToAddress', [hatId, wearers[0]], { dryRun: argv.dryRun })
        : await executeTx(contract, 'batchMintHats', [wearers.map(() => hatId), wearers], { dryRun: argv.dryRun });
      txSpin.stop();

      finishWrite(result, {
        successMsg: wearers.length === 1
          ? `Hat ${hatId.toString()} minted to ${wearers[0]}`
          : `Hat ${hatId.toString()} minted to ${wearers.length} wearers`,
        fields: { hat: hatId.toString(), wearers: wearers.join(','), count: wearers.length },
      });
    } catch (err: any) {
      handleError(spin, err);
    }
  },
};

// ────────────────────────────── pause / unpause ──────────────────────────────

function makePauseHandler(action: 'pause' | 'unpause') {
  return {
    builder: (yargs: Argv) => yargs
      .example(`pop role admin ${action}`, action === 'pause'
        ? 'Emergency-stop eligibility writes and vouching'
        : 'Resume eligibility writes and vouching'),

    handler: async (argv: ArgumentsCamelCase<AdminBaseArgs>) => {
      const spin = output.spinner(`Preparing ${action}...`);
      spin.start();

      try {
        const ctx = await getWriteContext(argv);
        const eligibilityModuleAddress = requireModule(ctx.modules, 'eligibilityModuleAddress');

        if (argv.preflight !== false) {
          await requireSuperAdmin(ctx.provider, eligibilityModuleAddress, ctx.address, `${action === 'pause' ? 'Pausing' : 'Unpausing'} the module`);
          const paused = await isPaused(ctx.provider, eligibilityModuleAddress);
          if (action === 'pause' && paused) {
            throw new PreconditionError('The module is already paused.', 'Resume it with: pop role admin unpause');
          }
          if (action === 'unpause' && !paused) {
            throw new PreconditionError('The module is not paused.', 'Nothing to do.');
          }
        }
        await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
        spin.stop();

        await confirmWrite(argv, {
          module: eligibilityModuleAddress,
          action,
          effect: action === 'pause'
            ? 'blocks eligibility writes, vouching, applications, and claims until unpaused'
            : 'restores normal module operation',
          org: argv.org,
          chain: ctx.networkName,
        }, { actionLabel: `About to ${action} the eligibility module` });

        const txSpin = output.spinner(`Sending ${action}...`);
        txSpin.start();
        const contract = createWriteContract(eligibilityModuleAddress, 'EligibilityModuleNew', ctx.signer);
        const result = await executeTx(contract, action, [], { dryRun: argv.dryRun });
        txSpin.stop();

        finishWrite(result, {
          successMsg: action === 'pause' ? 'Eligibility module paused' : 'Eligibility module unpaused',
          fields: { module: eligibilityModuleAddress, paused: action === 'pause' },
        });
      } catch (err: any) {
        handleError(spin, err);
      }
    },
  };
}

const adminPauseHandler = makePauseHandler('pause');
const adminUnpauseHandler = makePauseHandler('unpause');

// ────────────────────────────── set-join-time ──────────────────────────────

interface SetJoinTimeArgs extends AdminBaseArgs {
  user: string;
  timestamp?: number;
}

const adminSetJoinTimeHandler = {
  builder: (yargs: Argv) => yargs
    .option('user', { type: 'string', demandOption: true, describe: 'User whose join time to set' })
    .option('timestamp', { type: 'number', describe: 'Unix seconds (omit to use the current block time via setUserJoinTimeNow)' })
    .example('pop role admin set-join-time --user 0xabc...', 'Start the vouching grace clock now for a new member')
    .example('pop role admin set-join-time --user 0xabc... --timestamp 1751328000', 'Backdate a member\'s join time'),

  handler: async (argv: ArgumentsCamelCase<SetJoinTimeArgs>) => {
    const spin = output.spinner('Preparing join-time update...');
    spin.start();

    try {
      const user = requireAddress(argv.user, 'user');
      if (argv.timestamp !== undefined && (!Number.isInteger(argv.timestamp) || argv.timestamp < 0)) {
        throw new CliError(`Invalid --timestamp ${argv.timestamp}.`, EXIT.USAGE, 'Pass unix seconds, or omit to use the current block time.');
      }

      const ctx = await getWriteContext(argv);
      const eligibilityModuleAddress = requireModule(ctx.modules, 'eligibilityModuleAddress');

      if (argv.preflight !== false) {
        await requireSuperAdmin(ctx.provider, eligibilityModuleAddress, ctx.address, 'Setting a user join time');
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        user,
        joinTime: argv.timestamp !== undefined
          ? `${argv.timestamp} (${new Date(argv.timestamp * 1000).toISOString()})`
          : 'now (block timestamp)',
        effect: 'governs the new-account vouching grace period',
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'Set user join time' });

      const txSpin = output.spinner('Sending join-time update...');
      txSpin.start();
      const contract = createWriteContract(eligibilityModuleAddress, 'EligibilityModuleNew', ctx.signer);
      const result = argv.timestamp !== undefined
        ? await executeTx(contract, 'setUserJoinTime', [user, argv.timestamp], { dryRun: argv.dryRun })
        : await executeTx(contract, 'setUserJoinTimeNow', [user], { dryRun: argv.dryRun });
      txSpin.stop();

      finishWrite(result, {
        successMsg: `Join time set for ${user}`,
        fields: { user, timestamp: argv.timestamp ?? 'now' },
      });
    } catch (err: any) {
      handleError(spin, err);
    }
  },
};

// ────────────────────────────── registration ──────────────────────────────

export function registerRoleAdminCommands(yargs: Argv) {
  return yargs
    .command('transfer', 'Transfer the module superAdmin (DESTRUCTIVE — hands over the whole module)', adminTransferHandler.builder, adminTransferHandler.handler)
    .command('mint', 'Mint a hat to one or more wearers (superAdmin-only)', adminMintHandler.builder, adminMintHandler.handler)
    .command('pause', 'Pause the eligibility module (superAdmin-only)', adminPauseHandler.builder, adminPauseHandler.handler)
    .command('unpause', 'Unpause the eligibility module (superAdmin-only)', adminUnpauseHandler.builder, adminUnpauseHandler.handler)
    .command('set-join-time', 'Set a user\'s join time for the vouching grace period (superAdmin-only)', adminSetJoinTimeHandler.builder, adminSetJoinTimeHandler.handler)
    .demandCommand(1, 'Please specify an admin action: transfer, mint, pause, unpause, or set-join-time')
    .example('pop role admin mint --hat 123 --wearer 0xabc...', 'Mint a role hat directly');
}

export {
  adminTransferHandler,
  adminMintHandler,
  adminPauseHandler,
  adminUnpauseHandler,
  adminSetJoinTimeHandler,
};
