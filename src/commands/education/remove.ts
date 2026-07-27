/**
 * pop education remove — permanently delete a learning module.
 *
 * EducationHub.removeModule(id) — verified contracts origin/main
 * src/EducationHub.sol: onlyCreator + whenNotPaused, existence-checked
 * (ModuleUnknown), then `delete l._modules[id]`. There is no undo and no
 * archive; past completions keep their minted PT but the module (and its
 * payout) is gone for everyone else — hence the DESTRUCTIVE confirmation
 * tier (non-TTY runs require an explicit --yes).
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { parseModuleId } from '../../lib/encoding';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { checkModuleExists } from './helpers';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import { query } from '../../lib/subgraph';
import * as output from '../../lib/output';

interface RemoveModuleArgs {
  org: string;
  module: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

/** Best-effort title lookup so the destructive confirm names the module. */
const FETCH_MODULE_TITLE = `
  query FetchModuleTitle($orgId: Bytes!) {
    organization(id: $orgId) {
      educationHub {
        modules(first: 100) {
          moduleId
          title
        }
      }
    }
  }
`;

export const removeModuleHandler = {
  builder: (yargs: Argv) => yargs
    .option('module', { type: 'string', demandOption: true, describe: 'Module ID to remove (permanent — no undo)' })
    .example('pop education remove --module 2', 'Delete module 2 after an interactive confirmation')
    .example('pop education remove --module 2 --yes', 'Non-interactive removal (destructive actions need explicit --yes)'),

  handler: async (argv: ArgumentsCamelCase<RemoveModuleArgs>) => {
    const spin = output.spinner('Checking module state...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);
      const educationHubAddress = requireModule(ctx.modules, 'educationHubAddress');
      const moduleId = parseModuleId(argv.module);

      // Best-effort title for the confirmation summary (subgraph may lag).
      let title: string | undefined;
      try {
        const result = await query<any>(FETCH_MODULE_TITLE, { orgId: ctx.orgId }, argv.chain);
        const modules = result.organization?.educationHub?.modules || [];
        title = modules.find((m: any) => String(m.moduleId) === String(moduleId))?.title;
      } catch { /* confirm falls back to the bare ID */ }

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      await runPreflight(ctx.provider, [
        checkGasBalance(ctx.address),
        checkModuleExists(educationHubAddress, moduleId),
      ], { skip: argv.preflight === false });
      spin.stop();

      await confirmWrite(argv, {
        module: title ? `#${moduleId} — ${title}` : `#${moduleId}`,
        org: argv.org,
        chain: ctx.networkName,
        warning: 'permanent removal — no undo; the module and its payout disappear for everyone',
      }, { destructive: true, actionLabel: 'About to REMOVE education module' });

      const txSpin = output.spinner('Sending removeModule...');
      txSpin.start();
      const contract = createWriteContract(educationHubAddress, 'EducationHubNew', ctx.signer);
      const result = await executeTx(contract, 'removeModule', [moduleId], { dryRun: argv.dryRun });
      txSpin.stop();

      finishWrite(result, {
        successMsg: `Module ${moduleId} removed`,
        fields: { moduleId, title },
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
