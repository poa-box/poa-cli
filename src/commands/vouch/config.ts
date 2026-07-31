/**
 * pop vouch config — inspect and set a hat's vouching configuration.
 *
 * show: getVouchConfig(hatId) → (quorum, membershipHatId, flags) with
 *       flags bit 0 = enabled, bit 1 = combineWithHierarchy (VERIFIED against
 *       contracts origin/main src/EligibilityModule.sol ENABLED_FLAG=0x01,
 *       COMBINE_HIERARCHY_FLAG=0x02), plus the org-wide getMaxDailyVouches().
 * set:  configureVouching(hatId, quorum, membershipHatId, combineWithHierarchy)
 *       — onlySuperAdmin (verified). `enabled` is DERIVED on-chain as
 *       quorum > 0, so --quorum 0 disables vouching for the hat. Configuring
 *       bumps the hat's vouch epoch, invalidating all existing vouches.
 *
 * READ SOURCING: `show` is display-only, so the config comes SUBGRAPH-FIRST
 * from VouchConfig (verified populated on Gnosis + Arbitrum) with
 * getVouchConfig() kept as fallback. getMaxDailyVouches() has NO subgraph
 * field — EligibilityModuleContract exposes neither maxDailyVouches nor the
 * MaxDailyVouchesSet event it emits — so that one read stays on chain.
 * `set`'s pre-flight reads (superAdmin + getDefaultRules) both predict reverts
 * and stay on chain, but now share a single Multicall3 round-trip.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createProvider } from '../../lib/signer';
import { createReadContract, createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import {
  resolveEligibilityModule,
  parseHatId,
  decodeVouchConfig,
  requireSuperAdmin,
  requireSuperAdminWithRead,
  fetchVouchConfigFromSubgraph,
  VouchConfigView,
} from './helpers';

// ────────────────────────────── show ──────────────────────────────

interface ConfigShowArgs {
  org?: string;
  hat: string;
  chain?: number;
  rpc?: string;
}

const configShowHandler = {
  builder: (yargs: Argv) => yargs
    .option('hat', { type: 'string', demandOption: true, describe: 'Hat ID whose vouching config to show' })
    .example('pop vouch config show --hat 123', 'Quorum, membership hat, and rate limit for hat 123')
    .example('pop vouch config show --hat 123 --json', 'Machine-readable vouching config'),

  handler: async (argv: ArgumentsCamelCase<ConfigShowArgs>) => {
    const spin = output.spinner('Reading vouching config...');
    spin.start();

    try {
      const hatId = parseHatId(argv.hat);
      const { eligibilityModuleAddress } = await resolveEligibilityModule(argv.org, argv.chain);
      const provider = createProvider({ chainId: argv.chain, rpcUrl: argv.rpc as string });
      const contract = createReadContract(eligibilityModuleAddress, 'EligibilityModuleNew', provider);

      // Subgraph-first for the config (display only); an explicit --rpc pins
      // the read back to that node. getMaxDailyVouches has no subgraph field.
      const [subgraphConfig, maxDailyVouches] = await Promise.all([
        argv.rpc
          ? Promise.resolve(null as VouchConfigView | null)
          : fetchVouchConfigFromSubgraph(eligibilityModuleAddress, hatId, argv.chain),
        contract.getMaxDailyVouches(),
      ]);
      const config = subgraphConfig ?? decodeVouchConfig(await contract.getVouchConfig(hatId));
      output.debug(`vouch config read from ${subgraphConfig ? 'subgraph' : 'rpc'}`);

      spin.stop();

      const data = {
        hat: hatId.toString(),
        enabled: config.enabled,
        quorum: config.quorum,
        membershipHat: config.membershipHatId,
        combineWithHierarchy: config.combineWithHierarchy,
        maxDailyVouches: Number(maxDailyVouches),
        eligibilityModule: eligibilityModuleAddress,
      };

      if (output.isJsonMode()) {
        output.json(data);
        return;
      }

      console.log('');
      output.keyValueBlock(`Vouching config — hat ${data.hat}`, {
        enabled: config.enabled ? 'yes' : 'no',
        quorum: config.quorum || 'not set',
        'membership hat (who can vouch)': config.membershipHatId === '0' ? 'not set' : config.membershipHatId,
        'combine with hierarchy': config.combineWithHierarchy ? 'yes (hierarchy admins can also vouch/grant)' : 'no (vouching only)',
        'max daily vouches (org-wide)': data.maxDailyVouches,
      });
      if (!config.enabled) {
        output.info('Vouching is disabled for this hat — enable it with: pop vouch config set --hat <id> --quorum <n> --membership-hat <id>');
      }
      console.log('');
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

// ────────────────────────────── set ──────────────────────────────

interface ConfigSetArgs {
  org?: string;
  hat: string;
  quorum: number;
  'membership-hat': string;
  'combine-hierarchy'?: boolean;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

const configSetHandler = {
  builder: (yargs: Argv) => yargs
    .option('hat', { type: 'string', demandOption: true, describe: 'Hat ID to configure vouching for' })
    .option('quorum', { type: 'number', demandOption: true, describe: 'Vouches required to become claimable (0 disables vouching)' })
    .option('membership-hat', { type: 'string', demandOption: true, describe: 'Hat whose wearers are allowed to vouch' })
    .option('combine-hierarchy', { type: 'boolean', default: false, describe: 'Also honor hierarchy eligibility and let hat admins vouch' })
    .example('pop vouch config set --hat 123 --quorum 3 --membership-hat 45', 'Require 3 vouches from hat-45 wearers')
    .example('pop vouch config set --hat 123 --quorum 0 --membership-hat 0', 'Disable vouching for hat 123'),

  handler: async (argv: ArgumentsCamelCase<ConfigSetArgs>) => {
    const spin = output.spinner('Preparing configureVouching...');
    spin.start();

    try {
      const hatId = parseHatId(argv.hat);
      const membershipHatId = parseHatId(argv['membership-hat'] ?? (argv as any).membershipHat);
      const quorum = argv.quorum;
      if (!Number.isInteger(quorum) || quorum < 0 || quorum > 0xffffffff) {
        throw new CliError(`Invalid --quorum ${quorum}.`, EXIT.USAGE, 'Pass a non-negative integer (uint32).');
      }
      const combine = Boolean((argv as any).combineHierarchy ?? argv['combine-hierarchy']);

      const ctx = await getWriteContext(argv);
      const eligibilityModuleAddress = requireModule(ctx.modules, 'eligibilityModuleAddress');

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      // configureVouching is onlySuperAdmin (verified): fail fast naming the
      // actual superAdmin BEFORE any gas is spent.
      if (argv.preflight !== false) {
        // Audit M-03 (reverse direction): enabling vouching WITH combine-hierarchy on a hat that
        // is already default-eligible reverts DefaultEligibilityConflictsWithVouch — everyone is
        // eligible anyway, so the quorum would be a no-op. Detect the state, not the contract
        // version: on an older module this never fires and the write proceeds as before.
        //
        // Both reads predict a revert, so both stay on chain — but they hit the SAME contract and
        // used to be two sequential eth_calls; Multicall3 makes it one round-trip.
        const needsDefaultRules = combine && quorum > 0;
        if (!needsDefaultRules) {
          await requireSuperAdmin(ctx.provider, eligibilityModuleAddress, ctx.address, 'configureVouching');
        } else {
          const { extra, extraError } = await requireSuperAdminWithRead(
            ctx.provider,
            eligibilityModuleAddress,
            ctx.address,
            'configureVouching',
            { fn: 'getDefaultRules', args: [hatId] }
          );
          if (extra === null) {
            output.debug(`default-eligibility pre-check skipped (${extraError?.message || extraError})`);
          } else if (Boolean(extra.eligible ?? extra[0])) {
            // The STATE conflicts, but only a module implementing the M-03 revert rejects the
            // write — the deployed v6 modules do NOT: eth_call of the exact configureVouching
            // from the real superAdmin on live Gnosis SUCCEEDS on two default-eligible hats.
            // Simulate the exact call instead — the only version-proof revert predictor.
            const sim = createReadContract(eligibilityModuleAddress, 'EligibilityModuleNew', ctx.provider);
            try {
              await sim.callStatic.configureVouching(hatId, quorum, membershipHatId, combine, { from: ctx.address });
              output.warn(
                `Hat ${hatId} is default-eligible — everyone already qualifies — so this vouch `
                  + 'quorum will have no practical effect. This module accepts the write anyway.'
              );
            } catch {
              throw new PreconditionError(
                `Hat ${hatId} is default-eligible — everyone already qualifies — so a vouch quorum `
                  + 'combined with the hat hierarchy would have no effect, and the module rejects it.',
                `Close the hat first: pop role eligibility set-default --hat ${hatId} --no-eligible, `
                  + 'or re-run without --combine-hierarchy.',
              );
            }
          }
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      if (quorum === 0) {
        output.warn('Quorum 0 DISABLES vouching for this hat (enabled is derived on-chain as quorum > 0).');
      }
      output.warn('Reconfiguring bumps the vouch epoch — all existing vouches for this hat are invalidated.');

      await confirmWrite(argv, {
        hat: hatId.toString(),
        quorum,
        enabled: quorum > 0 ? 'yes (derived from quorum > 0)' : 'no (quorum 0)',
        membershipHat: membershipHatId.toString(),
        combineWithHierarchy: combine ? 'yes' : 'no',
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'Configure vouching' });

      const txSpin = output.spinner('Sending configureVouching...');
      txSpin.start();
      const contract = createWriteContract(eligibilityModuleAddress, 'EligibilityModuleNew', ctx.signer);
      const result = await executeTx(
        contract,
        'configureVouching',
        [hatId, quorum, membershipHatId, combine],
        { dryRun: argv.dryRun }
      );
      txSpin.stop();

      const configEvent = result.logs?.find(l => l.name === 'VouchConfigSet');
      finishWrite(result, {
        successMsg: quorum > 0
          ? `Vouching configured for hat ${hatId.toString()} — ${quorum} vouches from membership hat ${membershipHatId.toString()}`
          : `Vouching disabled for hat ${hatId.toString()}`,
        fields: {
          hat: hatId.toString(),
          quorum,
          membershipHat: membershipHatId.toString(),
          enabled: configEvent?.args?.enabled ?? quorum > 0,
          combineWithHierarchy: combine,
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

// ────────────────────────────── registration ──────────────────────────────

export function registerVouchConfigCommands(yargs: Argv) {
  return yargs
    .command('show', 'Show a hat\'s vouching config (quorum, membership hat, rate limit)', configShowHandler.builder, configShowHandler.handler)
    .command('set', 'Configure vouching for a hat (superAdmin-only)', configSetHandler.builder, configSetHandler.handler)
    .demandCommand(1, 'Please specify a config action: show or set')
    .example('pop vouch config show --hat 123', 'Inspect vouching for hat 123');
}

export { configShowHandler, configSetHandler };
