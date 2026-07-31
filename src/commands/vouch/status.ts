/**
 * pop vouch status — vouch progress for a wearer + the signer's own
 * rate-limit/grace state.
 *
 * Wearer side (existing fields, preserved): currentVouchCount vs quorum,
 * isVouchingEnabled, canClaim.
 *
 * Signer side (additive, only when a key is available): canUserVouch,
 * getCurrentDailyVouchCount vs getMaxDailyVouches, getUserJoinTime →
 * "You can vouch (2/3 used today)" or the friendly restriction reason
 * ("Account too new — vouching unlocks in 1d"). Reads verified against
 * contracts origin/main src/EligibilityModule.sol (canUserVouch mirrors
 * _checkVouchingRateLimit: join-grace then daily limit, UTC-day buckets).
 *
 * READ SOURCING: this command never writes, so the wearer side is served
 * SUBGRAPH-FIRST (VouchConfig + a count of active Vouch rows) with the
 * on-chain getters kept as fallback — three eth_calls become zero on the happy
 * path. The signer-side gate has no subgraph equivalent at all
 * (canUserVouch / getCurrentDailyVouchCount / getMaxDailyVouches have no
 * field, UserJoinTime has zero live rows) so it stays on RPC, now batched
 * through Multicall3 into a single round-trip.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createProvider , resolveIdentityAddress } from '../../lib/signer';
import { requireAddress } from '../../lib/validation';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import {
  resolveEligibilityModule,
  parseHatId,
  readWearerVouchState,
  readVoucherGate,
  vouchRestriction,
  vouchQuotaLabel,
  VoucherGate,
} from './helpers';

interface StatusArgs {
  org?: string;
  hat: string;
  address: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
}

/**
 * Resolve the VOUCHER identity (POP_ADDRESS/key) without requiring one.
 *
 * Deliberately excludes argv.address: this command's own --address means
 * "the WEARER to check" (pre-existing, demanded option), not "observe as".
 * Passing it through resolveIdentityAddress would silently evaluate the
 * voucher gate as the wearer.
 */
function optionalSignerAddress(argv: { 'private-key'?: string }): string | null {
  try {
    return resolveIdentityAddress({
      privateKey: (argv as any)['private-key'] ?? (argv as any).privateKey,
    });
  } catch {
    return null;
  }
}

export const statusHandler = {
  builder: (yargs: Argv) => yargs
    .option('hat', { type: 'string', demandOption: true, describe: 'Hat ID to check' })
    .option('address', { type: 'string', demandOption: true, describe: 'Wearer address to check' })
    .example('pop vouch status --hat 123 --address 0xabc...', 'Vouch progress for a member, plus your own daily quota'),

  handler: async (argv: ArgumentsCamelCase<StatusArgs>) => {
    const wearer = requireAddress(argv.address, 'address');
    const spin = output.spinner('Checking vouch status...');
    spin.start();

    try {
      const hatId = parseHatId(argv.hat);
      const { eligibilityModuleAddress } = await resolveEligibilityModule(argv.org, argv.chain);
      const provider = createProvider({ chainId: argv.chain, rpcUrl: argv.rpc as string });
      const signerAddress = optionalSignerAddress(argv);

      const [wearerState, gate] = await Promise.all([
        // Subgraph-first; an explicit --rpc means "read from that node", so it
        // pins this back to the on-chain getters.
        readWearerVouchState(provider, eligibilityModuleAddress, hatId, wearer, {
          chainId: argv.chain,
          preferSubgraph: !argv.rpc,
        }),
        signerAddress
          ? readVoucherGate(provider, eligibilityModuleAddress, signerAddress)
          : Promise.resolve(null as VoucherGate | null),
      ]);

      spin.stop();
      output.debug(`vouch progress read from ${wearerState.source}`);

      const config = wearerState.state.config;
      const isEnabled = config.enabled;
      const count = ethers.BigNumber.from(wearerState.state.currentCount);
      const quorum = ethers.BigNumber.from(config.quorum);
      const restriction = gate ? vouchRestriction(gate) : null;

      const data = {
        hat: argv.hat,
        wearer,
        vouchingEnabled: Boolean(isEnabled),
        currentVouches: count.toString(),
        requiredVouches: quorum.toString(),
        canClaim: Boolean(isEnabled) && count.gte(quorum),
        // Additive fields (v6 migration)
        membershipHat: config.membershipHatId,
        combineWithHierarchy: config.combineWithHierarchy,
        voucher: gate && signerAddress ? {
          address: signerAddress,
          canVouch: gate.canVouch,
          dailyVouchesUsed: gate.dailyUsed,
          maxDailyVouches: gate.maxDaily,
          joinTime: gate.joinTime,
          restriction: restriction?.message,
        } : undefined,
      };

      if (output.isJsonMode()) {
        output.json(data);
        return;
      }

      console.log('');
      console.log(`  Hat:              ${argv.hat}`);
      console.log(`  Wearer:           ${wearer}`);
      console.log(`  Vouching enabled: ${isEnabled ? 'yes' : 'no'}`);
      console.log(`  Vouches:          ${count.toString()} / ${quorum.toString()}`);
      console.log(`  Can claim:        ${data.canClaim ? 'yes (run: pop vouch claim --hat ' + argv.hat + ')' : 'no'}`);
      if (config.membershipHatId !== '0') {
        console.log(`  Vouchers wear:    hat ${config.membershipHatId}${config.combineWithHierarchy ? ' (hierarchy admins can also vouch)' : ''}`);
      }
      console.log('');

      if (gate) {
        if (restriction) {
          output.warn(`${restriction.message} ${restriction.suggestion}`);
        } else {
          output.info(`You can vouch (${vouchQuotaLabel(gate)})`);
        }
      } else {
        output.info('No signer key available — set POP_PRIVATE_KEY or pass --private-key to see your own vouch quota.');
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
