/**
 * pop vouch reset — wipe vouch state for a hat (superAdmin-only, DESTRUCTIVE).
 *
 * Two shapes (VERIFIED against contracts origin/main src/EligibilityModule.sol):
 * - no --wearer  → resetVouches(hatId): DELETES the hat's VouchConfig
 *                  (vouching becomes disabled) and bumps the vouch epoch so
 *                  every existing vouch for the hat is invalidated.
 * - --wearer A   → clearWearerVouches(wearer, hatId): surgical per-wearer
 *                  invalidation (sentinel epoch + count wipe); other wearers'
 *                  vouches and the hat's config are untouched.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { requireAddress } from '../../lib/validation';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { parseHatId, requireSuperAdmin } from './helpers';

interface ResetArgs {
  org?: string;
  hat: string;
  wearer?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

export const resetHandler = {
  builder: (yargs: Argv) => yargs
    .option('hat', { type: 'string', demandOption: true, describe: 'Hat ID whose vouch state to reset' })
    .option('wearer', { type: 'string', describe: 'Only clear this wearer\'s vouches (surgical; hat config kept)' })
    .example('pop vouch reset --hat 123 --wearer 0xabc... --yes', 'Invalidate one wearer\'s vouches for hat 123')
    .example('pop vouch reset --hat 123', 'Wipe ALL vouches for hat 123 and disable its vouching config'),

  handler: async (argv: ArgumentsCamelCase<ResetArgs>) => {
    const spin = output.spinner('Preparing vouch reset...');
    spin.start();

    try {
      const hatId = parseHatId(argv.hat);
      const wearer = argv.wearer ? requireAddress(argv.wearer, 'wearer') : undefined;

      const ctx = await getWriteContext(argv);
      const eligibilityModuleAddress = requireModule(ctx.modules, 'eligibilityModuleAddress');

      // Both resetVouches and clearWearerVouches are onlySuperAdmin (verified).
      if (argv.preflight !== false) {
        await requireSuperAdmin(ctx.provider, eligibilityModuleAddress, ctx.address, 'Resetting vouches');
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      if (wearer) {
        output.warn(`This permanently invalidates ${wearer}'s current vouches for hat ${hatId.toString()} (they can be re-vouched from scratch).`);
      } else {
        output.warn('This wipes ALL vouches for the hat AND deletes its vouching config — vouching becomes disabled until reconfigured with pop vouch config set.');
      }

      await confirmWrite(argv, {
        action: wearer ? 'clear one wearer\'s vouches' : 'reset ALL vouches + delete vouch config',
        hat: hatId.toString(),
        wearer,
        org: argv.org,
        chain: ctx.networkName,
      }, { destructive: true, actionLabel: 'About to reset vouch state' });

      const txSpin = output.spinner(wearer ? 'Sending clearWearerVouches...' : 'Sending resetVouches...');
      txSpin.start();
      const contract = createWriteContract(eligibilityModuleAddress, 'EligibilityModuleNew', ctx.signer);
      const result = wearer
        ? await executeTx(contract, 'clearWearerVouches', [wearer, hatId], { dryRun: argv.dryRun })
        : await executeTx(contract, 'resetVouches', [hatId], { dryRun: argv.dryRun });
      txSpin.stop();

      finishWrite(result, {
        successMsg: wearer
          ? `Vouches cleared for ${wearer} on hat ${hatId.toString()}`
          : `Vouches reset for hat ${hatId.toString()} — vouching is now disabled until reconfigured`,
        fields: {
          hat: hatId.toString(),
          wearer,
          scope: wearer ? 'single-wearer' : 'whole-hat',
          nextStep: wearer ? undefined : 'pop vouch config set --hat <id> --quorum <n> --membership-hat <id>',
        },
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
  },
};
