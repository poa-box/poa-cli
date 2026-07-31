/**
 * pop role eligibility — per-wearer and default eligibility management.
 *
 * All writes are onlySuperAdmin (VERIFIED against contracts origin/main
 * src/EligibilityModule.sol):
 *   set          → setWearerEligibility(wearer, hatId, eligible, standing)
 *   set --file   → batchSetWearerEligibility(hatId, wearers[], eligibles[], standings[])
 *   clear        → clearWearerEligibility(wearer, hatId) — removes the
 *                  wearer-specific rule so the hat DEFAULTS apply again
 *   set-default  → setDefaultEligibility(hatId, eligible, standing)
 *
 * Batch file format (JSON array): [{ "wearer": "0x…", "eligible": true,
 * "standing": true }, …] — eligible/standing default to true when omitted.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import fs from 'fs';
import { createReadContract, createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { requireAddress } from '../../lib/validation';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import { vouchConflictsWithDefaultEligibility } from '../../lib/perms';
import * as output from '../../lib/output';
import { parseHatId, requireSuperAdmin, requireSuperAdminWithRead } from '../vouch/helpers';

/** One decoded batch entry. */
export interface EligibilityBatchEntry {
  wearer: string;
  eligible: boolean;
  standing: boolean;
}

/** Parse + validate the --file batch JSON (array of {wearer, eligible?, standing?}). */
export function parseEligibilityBatchFile(filePath: string): EligibilityBatchEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    throw new CliError(`Could not read batch file: ${filePath}`, EXIT.USAGE);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`Batch file is not valid JSON: ${filePath}`, EXIT.USAGE, 'Expected: [{"wearer": "0x…", "eligible": true, "standing": true}, …]');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new CliError('Batch file must be a non-empty JSON array.', EXIT.USAGE, 'Expected: [{"wearer": "0x…", "eligible": true, "standing": true}, …]');
  }
  return parsed.map((entry: any, i: number) => {
    if (!entry || typeof entry !== 'object' || !entry.wearer) {
      throw new CliError(`Batch entry ${i} is missing "wearer".`, EXIT.USAGE);
    }
    return {
      wearer: requireAddress(String(entry.wearer), `file entry ${i} wearer`),
      eligible: entry.eligible === undefined ? true : Boolean(entry.eligible),
      standing: entry.standing === undefined ? true : Boolean(entry.standing),
    };
  });
}

/** Shared catch tail for every eligibility handler. */
function handleError(spin: { stop: () => any }, err: any): never {
  spin.stop();
  if (err instanceof CliError) {
    output.error(err.message, { suggestion: err.suggestion });
    process.exit(err.code);
  }
  output.error(err?.message || String(err));
  process.exit(EXIT.USAGE);
}

// ────────────────────────────── set ──────────────────────────────

interface EligibilitySetArgs {
  org?: string;
  hat: string;
  wearer?: string;
  eligible?: boolean;
  standing?: boolean;
  file?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

const eligibilitySetHandler = {
  builder: (yargs: Argv) => yargs
    .option('hat', { type: 'string', demandOption: true, describe: 'Hat ID whose eligibility to set' })
    .option('wearer', { type: 'string', describe: 'Wearer address (single-wearer mode)' })
    .option('eligible', { type: 'boolean', default: true, describe: 'Wearer is eligible (--no-eligible to unset)' })
    .option('standing', { type: 'boolean', default: true, describe: 'Wearer is in good standing (--no-standing to unset)' })
    .option('file', { type: 'string', describe: 'Batch JSON file: [{"wearer": "0x…", "eligible": true, "standing": true}, …]' })
    .check((argv) => {
      if (!argv.wearer && !argv.file) throw new Error('Either --wearer or --file is required');
      if (argv.wearer && argv.file) throw new Error('Pass --wearer OR --file, not both');
      return true;
    })
    .example('pop role eligibility set --hat 123 --wearer 0xabc...', 'Make one wearer eligible + good standing')
    .example('pop role eligibility set --hat 123 --wearer 0xabc... --no-standing', 'Put a wearer in bad standing')
    .example('pop role eligibility set --hat 123 --file batch.json', 'Batch-set eligibility from a JSON file'),

  handler: async (argv: ArgumentsCamelCase<EligibilitySetArgs>) => {
    const spin = output.spinner('Preparing eligibility update...');
    spin.start();

    try {
      const hatId = parseHatId(argv.hat);
      const batch: EligibilityBatchEntry[] = argv.file
        ? parseEligibilityBatchFile(argv.file)
        : [{
            wearer: requireAddress(argv.wearer, 'wearer'),
            eligible: argv.eligible !== false,
            standing: argv.standing !== false,
          }];

      const ctx = await getWriteContext(argv);
      const eligibilityModuleAddress = requireModule(ctx.modules, 'eligibilityModuleAddress');

      if (argv.preflight !== false) {
        await requireSuperAdmin(ctx.provider, eligibilityModuleAddress, ctx.address, 'Setting wearer eligibility');
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      const isBatch = batch.length > 1 || Boolean(argv.file);
      await confirmWrite(argv, {
        hat: hatId.toString(),
        wearers: isBatch ? `${batch.length} wearers (from ${argv.file})` : batch[0].wearer,
        eligibility: isBatch
          ? batch.map(b => `${b.wearer.slice(0, 8)}…: e=${b.eligible},s=${b.standing}`).slice(0, 5).join('; ') + (batch.length > 5 ? '; …' : '')
          : `eligible=${batch[0].eligible}, standing=${batch[0].standing}`,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'Set wearer eligibility' });

      const txSpin = output.spinner('Sending eligibility update...');
      txSpin.start();
      const contract = createWriteContract(eligibilityModuleAddress, 'EligibilityModuleNew', ctx.signer);
      const result = isBatch
        ? await executeTx(contract, 'batchSetWearerEligibility', [
            hatId,
            batch.map(b => b.wearer),
            batch.map(b => b.eligible),
            batch.map(b => b.standing),
          ], { dryRun: argv.dryRun })
        : await executeTx(contract, 'setWearerEligibility', [
            batch[0].wearer,
            hatId,
            batch[0].eligible,
            batch[0].standing,
          ], { dryRun: argv.dryRun });
      txSpin.stop();

      finishWrite(result, {
        successMsg: isBatch
          ? `Eligibility set for ${batch.length} wearers on hat ${hatId.toString()}`
          : `Eligibility set for ${batch[0].wearer} on hat ${hatId.toString()}`,
        fields: {
          hat: hatId.toString(),
          count: batch.length,
          wearer: isBatch ? undefined : batch[0].wearer,
          eligible: isBatch ? undefined : batch[0].eligible,
          standing: isBatch ? undefined : batch[0].standing,
        },
      });
    } catch (err: any) {
      handleError(spin, err);
    }
  },
};

// ────────────────────────────── clear ──────────────────────────────

interface EligibilityClearArgs {
  org?: string;
  hat: string;
  wearer: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

const eligibilityClearHandler = {
  builder: (yargs: Argv) => yargs
    .option('hat', { type: 'string', demandOption: true, describe: 'Hat ID' })
    .option('wearer', { type: 'string', demandOption: true, describe: 'Wearer whose specific rule to clear (hat defaults apply again)' })
    .example('pop role eligibility clear --hat 123 --wearer 0xabc...', 'Remove a wearer-specific rule so the hat defaults apply'),

  handler: async (argv: ArgumentsCamelCase<EligibilityClearArgs>) => {
    const spin = output.spinner('Preparing clearWearerEligibility...');
    spin.start();

    try {
      const hatId = parseHatId(argv.hat);
      const wearer = requireAddress(argv.wearer, 'wearer');

      const ctx = await getWriteContext(argv);
      const eligibilityModuleAddress = requireModule(ctx.modules, 'eligibilityModuleAddress');

      if (argv.preflight !== false) {
        await requireSuperAdmin(ctx.provider, eligibilityModuleAddress, ctx.address, 'Clearing wearer eligibility');
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        hat: hatId.toString(),
        wearer,
        effect: 'wearer-specific rule removed — hat defaults apply again',
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'Clear wearer eligibility rule' });

      const txSpin = output.spinner('Sending clearWearerEligibility...');
      txSpin.start();
      const contract = createWriteContract(eligibilityModuleAddress, 'EligibilityModuleNew', ctx.signer);
      const result = await executeTx(contract, 'clearWearerEligibility', [wearer, hatId], { dryRun: argv.dryRun });
      txSpin.stop();

      finishWrite(result, {
        successMsg: `Eligibility rule cleared for ${wearer} on hat ${hatId.toString()}`,
        fields: { hat: hatId.toString(), wearer },
      });
    } catch (err: any) {
      handleError(spin, err);
    }
  },
};

// ────────────────────────────── set-default ──────────────────────────────

interface EligibilityDefaultArgs {
  org?: string;
  hat: string;
  eligible?: boolean;
  standing?: boolean;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

const eligibilitySetDefaultHandler = {
  builder: (yargs: Argv) => yargs
    .option('hat', { type: 'string', demandOption: true, describe: 'Hat ID whose defaults to set' })
    .option('eligible', { type: 'boolean', default: true, describe: 'Wearers eligible by default (--no-eligible to unset)' })
    .option('standing', { type: 'boolean', default: true, describe: 'Wearers in good standing by default (--no-standing to unset)' })
    .example('pop role eligibility set-default --hat 123 --eligible --standing', 'Open the hat: everyone eligible by default'),

  handler: async (argv: ArgumentsCamelCase<EligibilityDefaultArgs>) => {
    const spin = output.spinner('Preparing setDefaultEligibility...');
    spin.start();

    try {
      const hatId = parseHatId(argv.hat);
      const eligible = argv.eligible !== false;
      const standing = argv.standing !== false;

      const ctx = await getWriteContext(argv);
      const eligibilityModuleAddress = requireModule(ctx.modules, 'eligibilityModuleAddress');

      if (argv.preflight !== false) {
        // Audit M-03: making a hat default-eligible while it uses vouching WITH
        // combineWithHierarchy reverts DefaultEligibilityConflictsWithVouch — an open hat makes
        // the vouch quorum meaningless. --eligible defaults to TRUE, so a bare
        // `set-default --hat X` hits this. Detect the state, not the contract version: on an
        // older module the write simply succeeds and this check never fires.
        //
        // Both reads are revert predictors and stay on chain (VouchConfig IS populated in the
        // subgraph, but indexing lag here would BLOCK a valid set-default). They used to be two
        // sequential eth_calls to the SAME contract — Multicall3 makes it one round-trip.
        if (!eligible) {
          await requireSuperAdmin(ctx.provider, eligibilityModuleAddress, ctx.address, 'Setting default eligibility');
        } else {
          const { extra: vc, extraError } = await requireSuperAdminWithRead(
            ctx.provider,
            eligibilityModuleAddress,
            ctx.address,
            'Setting default eligibility',
            { fn: 'getVouchConfig', args: [hatId] }
          );
          if (vc === null) {
            output.debug(`vouch-conflict pre-check skipped (${extraError?.message || extraError})`);
          } else if (vouchConflictsWithDefaultEligibility(Number(vc.flags), Number(vc.quorum), true)) {
            // The STATE conflicts, but only a module that implements the M-03 revert actually
            // rejects the write — and the deployed v6 modules do NOT: an eth_call of the exact
            // setDefaultEligibility from the real superAdmin on live Gnosis (module 0x27114c…,
            // flags=3, quorum=1) SUCCEEDS. 17/19 live VouchConfig rows are in this state, so
            // blocking on state alone would refuse a valid write on nearly every hat.
            // Simulate the exact call instead — the only version-proof revert predictor.
            const sim = createReadContract(eligibilityModuleAddress, 'EligibilityModuleNew', ctx.provider);
            try {
              await sim.callStatic.setDefaultEligibility(hatId, eligible, standing, { from: ctx.address });
              output.warn(
                `Hat ${hatId} uses vouching with combine-hierarchy (quorum ${vc.quorum}); making it `
                  + 'default-eligible makes that quorum a no-op. This module accepts the write anyway.'
              );
            } catch (simErr: any) {
              // Only a CONTRACT revert proves the module enforces M-03. A transport
              // failure (server error, timeout) proves nothing — blocking a valid
              // write on an RPC blip is the same false positive this simulation
              // exists to prevent. Degrade like every other pre-flight read: note
              // it and let estimateGas be the real gate.
              if (simErr?.code !== 'CALL_EXCEPTION' && simErr?.code !== 'UNPREDICTABLE_GAS_LIMIT') {
                output.debug(`M-03 simulation unavailable (${simErr?.code || simErr?.message}) — proceeding`);
              } else
              throw new PreconditionError(
                `Hat ${hatId} uses vouching with combine-hierarchy (quorum ${vc.quorum}). Making it `
                  + 'default-eligible would make that quorum a no-op, so the module rejects it.',
                'Drop combine-hierarchy or disable vouching first: '
                  + `pop vouch config set --hat ${hatId} --quorum 0`,
              );
            }
          }
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        hat: hatId.toString(),
        defaults: `eligible=${eligible}, standing=${standing}`,
        scope: 'applies to every wearer WITHOUT a specific rule',
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'Set default eligibility' });

      const txSpin = output.spinner('Sending setDefaultEligibility...');
      txSpin.start();
      const contract = createWriteContract(eligibilityModuleAddress, 'EligibilityModuleNew', ctx.signer);
      const result = await executeTx(contract, 'setDefaultEligibility', [hatId, eligible, standing], { dryRun: argv.dryRun });
      txSpin.stop();

      finishWrite(result, {
        successMsg: `Default eligibility set for hat ${hatId.toString()} — eligible=${eligible}, standing=${standing}`,
        fields: { hat: hatId.toString(), eligible, standing },
      });
    } catch (err: any) {
      handleError(spin, err);
    }
  },
};

// ────────────────────────────── registration ──────────────────────────────

export function registerEligibilityCommands(yargs: Argv) {
  return yargs
    .command('set', 'Set a wearer\'s eligibility/standing (or batch via --file); superAdmin-only', eligibilitySetHandler.builder, eligibilitySetHandler.handler)
    .command('clear', 'Clear a wearer-specific rule so hat defaults apply; superAdmin-only', eligibilityClearHandler.builder, eligibilityClearHandler.handler)
    .command('set-default', 'Set the hat-wide default eligibility/standing; superAdmin-only', eligibilitySetDefaultHandler.builder, eligibilitySetDefaultHandler.handler)
    .demandCommand(1, 'Please specify an eligibility action: set, clear, or set-default')
    .example('pop role eligibility set --hat 123 --wearer 0xabc...', 'Make a wearer eligible');
}

export { eligibilitySetHandler, eligibilityClearHandler, eligibilitySetDefaultHandler };
