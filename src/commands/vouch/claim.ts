/**
 * pop vouch claim — claim a hat once you have enough vouches.
 *
 * The contract uses the CLAIM-BASED pattern (verified against contracts
 * origin/main src/EligibilityModule.sol claimVouchedHat): reaching quorum
 * makes getWearerStatus() eligible, and the wearer explicitly claims — the
 * hat is never auto-minted. Pre-flight reads getWearerStatus(signer, hat)
 * and fails fast with the vouch progress when not yet eligible.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { readClaimGate } from './helpers';

interface ClaimArgs {
  org?: string;
  hat: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const claimHandler = {
  builder: (yargs: Argv) => yargs
    .option('hat', { type: 'string', demandOption: true, describe: 'Hat ID to claim' })
    .option('idempotency-key', { type: 'string', describe: 'Explicit idempotency key (repeat claims within the TTL return the prior result).' })
    .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache and always submit.' })
    .example('pop vouch claim --hat 123', 'Claim hat 123 after reaching the vouch quorum'),

  handler: async (argv: ArgumentsCamelCase<ClaimArgs>) => {
    const spin = output.spinner('Checking claim eligibility...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);
      const eligibilityModuleAddress = requireModule(ctx.modules, 'eligibilityModuleAddress');

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      if (argv.preflight !== false) {
        const gate = await readClaimGate(ctx.provider, eligibilityModuleAddress, ctx.address, argv.hat);
        if (!gate.eligible || !gate.standing) {
          const progress = gate.config.enabled
            ? `You have ${gate.currentCount}/${gate.config.quorum} vouches.`
            : 'Vouching is not enabled for this hat.';
          throw new PreconditionError(
            `You are not eligible to claim hat ${argv.hat} yet. ${progress}`,
            gate.config.enabled
              ? `Ask wearers of membership hat ${gate.config.membershipHatId} to vouch: pop vouch for --address ${ctx.address} --hat ${argv.hat}`
              : 'Check the hat\'s config with: pop vouch config show --hat ' + argv.hat
          );
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        hat: argv.hat,
        claimer: ctx.address,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to claim hat' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Claiming hat...');
        txSpin.start();
        const contract = createWriteContract(eligibilityModuleAddress, 'EligibilityModuleNew', ctx.signer);
        const result = await executeTx(contract, 'claimVouchedHat', [argv.hat], { dryRun: argv.dryRun });
        txSpin.stop();

        // HatClaimed(wearer, hatId) — verified in ABI.
        const claimedEvent = result.logs?.find(l => l.name === 'HatClaimed');
        finishWrite(result, {
          successMsg: `Hat ${argv.hat} claimed`,
          fields: {
            hat: argv.hat,
            wearer: claimedEvent?.args?.wearer ?? ctx.address,
          },
        });
        return { hat: argv.hat, txHash: result.txHash };
      };

      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'vouch.claim', run);
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
