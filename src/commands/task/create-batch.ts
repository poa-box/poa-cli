import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import fs from 'fs';
import { createSigner } from '../../lib/signer';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import {
  stringToBytes,
  ipfsCidToBytes32,
  parseProjectId,
  parseDeadline,
  parseDurationSeconds,
  formatDeadline,
} from '../../lib/encoding';
import { detectTaskManagerFeatures, featureUnavailable } from '../../lib/version';
import { confirmWrite, finishWrite } from '../../lib/command';
import { formatToken } from '../../lib/format';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import { getTokenDecimals } from '../../config/tokens';
import * as output from '../../lib/output';
import { resolveOrgContracts } from './helpers';
import { calculatePayout, payoutConfigFromMetadata, type PayoutConfig } from '../../lib/payout';
import { FETCH_ORG_PAYOUT_CONFIG } from '../../queries/org';
import { query } from '../../lib/subgraph';

interface BatchArgs {
  org?: string;
  project: string;
  file: string;
  deadline?: string;
  'completion-window'?: string;
  'continue-on-error'?: boolean;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

interface TaskLine {
  name: string;
  description: string;
  payout?: number;
  difficulty?: string;
  estHours?: number;
  location?: string;
  bountyToken?: string;
  bountyAmount?: number;
  requiresApplication?: boolean;
  /** v6 orgs only: per-row absolute claim deadline (overrides --deadline) */
  deadline?: string | number;
  /** v6 orgs only: per-row completion window (overrides --completion-window) */
  completionWindow?: string | number;
}

interface ParsedTask extends TaskLine {
  /** Resolved payout — the row's own value, or one derived from the org's payout convention. */
  payout: number;
  /** True when the JSONL row supplied `payout` explicitly (so 0 stays 0). */
  payoutProvided: boolean;
  /** Resolved absolute deadline (unix seconds; 0 = none) */
  absoluteDeadline: number;
  /** Resolved completion window (seconds; 0 = none) */
  completionWindowSecs: number;
  /** True when the row or a batch-wide flag set a deadline field */
  deadlineSet: boolean;
}

/** Build the frontend-key-order metadata object for a task row. */
function buildMetadata(task: TaskLine): Record<string, any> {
  return {
    name: task.name,
    description: task.description,
    location: task.location || '',
    difficulty: task.difficulty || 'medium',
    estHours: task.estHours || 0,
    submission: '',
  };
}

export const createBatchHandler = {
  builder: (yargs: Argv) => yargs
    .option('project', { type: 'string', demandOption: true, describe: 'Project ID (shared for all tasks)' })
    .option('file', { type: 'string', demandOption: true, describe: 'JSONL file (one task JSON per line)' })
    .option('deadline', { type: 'string', describe: 'Absolute claim deadline — no claims after this time (v6 orgs only; batch-wide default, rows may override)' })
    .option('completion-window', { type: 'string', describe: 'Time a claimer has to submit after claiming (v6 orgs only; batch-wide default, rows may override)' }),

  handler: async (argv: ArgumentsCamelCase<BatchArgs>) => {
    // Validate file
    if (!fs.existsSync(argv.file)) {
      output.error(`File not found: ${argv.file}`);
      process.exit(1);
      return;
    }

    const lines = fs.readFileSync(argv.file, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      output.error('File is empty');
      process.exit(1);
      return;
    }

    // Batch-wide deadline defaults (v6 orgs only); rows may override.
    // Parsed up-front so bad input fails before any network work.
    let defaultDeadline = 0;
    let defaultWindow = 0;
    try {
      if (argv.deadline !== undefined) defaultDeadline = parseDeadline(argv.deadline);
      if (argv.completionWindow !== undefined) defaultWindow = parseDurationSeconds(argv.completionWindow);
    } catch (err: any) {
      output.error(err.message);
      process.exit(1);
      return;
    }
    const batchDeadlineSet = argv.deadline !== undefined || argv.completionWindow !== undefined;

    // Parse all lines upfront to catch errors before sending any transactions
    const tasks: ParsedTask[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        const task = JSON.parse(lines[i]) as TaskLine;
        if (!task.name || !task.description) {
          throw new Error('Missing required fields: name, description');
        }
        const absoluteDeadline = task.deadline !== undefined
          ? parseDeadline(String(task.deadline))
          : defaultDeadline;
        const completionWindowSecs = task.completionWindow !== undefined
          ? parseDurationSeconds(String(task.completionWindow))
          : defaultWindow;
        tasks.push({
          ...task,
          payout: task.payout ?? 0,
          payoutProvided: task.payout !== undefined,
          absoluteDeadline,
          completionWindowSecs,
          deadlineSet: batchDeadlineSet || task.deadline !== undefined || task.completionWindow !== undefined,
        });
      } catch (err: any) {
        output.error(`Line ${i + 1}: ${err.message}`);
        if (!argv.continueOnError) process.exit(1);
      }
    }

    // Client-side EmptyBatch guard (the v6 contract reverts on empty input)
    if (tasks.length === 0) {
      output.error('EmptyBatch: file parsed to 0 valid tasks — nothing to create.');
      process.exit(1);
      return;
    }

    output.info(`Creating ${tasks.length} tasks...`);

    try {
      const { taskManagerAddress, orgId } = await resolveOrgContracts(argv.org as string, argv.chain);

      // Same pricing convention as `pop task create`: a row may omit `payout` and be priced
      // from the org's payout config + its difficulty/estHours.
      let payoutConfig: PayoutConfig & { useTokenSymbol: boolean } = {
        hoursOnly: false, hourlyRate: null, useTokenSymbol: false,
      };
      let payoutConfigError: unknown = null;
      try {
        const cfg = await query<any>(FETCH_ORG_PAYOUT_CONFIG, { orgId }, argv.chain);
        // No org row (indexer lag) must not silently price from defaults —
        // only an org row with null metadata legitimately means default pricing.
        if (!cfg.organization) throw new Error('organization not indexed');
        payoutConfig = payoutConfigFromMetadata(cfg.organization?.metadata);
      } catch (err) {
        // Only fatal when a row needs its payout DERIVED — rows with explicit
        // payouts do not depend on org pricing.
        payoutConfigError = err;
      }
      const needsDerivation = tasks.filter((t) => !t.payoutProvided);
      if (needsDerivation.length > 0 && payoutConfigError) {
        // Pricing from the hard-coded default would silently misprice every derived
        // row for an org with hours-only or custom hourly pricing — and the payouts
        // go on-chain. Refuse rather than guess.
        throw new Error(
          `Could not read the org payout config (subgraph unreachable), and ${needsDerivation.length} `
          + `row(s) omit "payout": ${needsDerivation.map((t) => t.name).join(', ')}. `
          + 'Add explicit payouts to those rows, or retry when the subgraph is reachable.'
        );
      }
      for (const t of tasks) {
        if (!t.payoutProvided) {
          t.payout = calculatePayout(t.difficulty || 'medium', t.estHours || 0, payoutConfig);
        }
      }
      const unpriced = tasks.filter((t) => !t.payoutProvided && t.payout <= 0);
      if (unpriced.length > 0) {
        throw new Error(
          `${unpriced.length} row(s) could not be priced (no "payout", and difficulty/estHours `
          + `derive to 0): ${unpriced.map((t) => t.name).join(', ')}`
        );
      }
      const { signer, provider, chainId } = createSigner({ privateKey: argv.privateKey as string, chainId: argv.chain, rpcUrl: argv.rpc as string });
      const pid = parseProjectId(argv.project);

      const features = await detectTaskManagerFeatures(provider, taskManagerAddress, chainId);
      if (!features.deadlines || !features.batchCreate) {
        output.error(featureUnavailable(
          'task deadlines',
          'TaskManager v6',
          'Re-run without --deadline/--completion-window, or upgrade the org TaskManager beacon.'
        ));
        process.exit(EXIT.PRECONDITION);
        return;
      }

      // ── Confirm BEFORE any IPFS pin or transaction ─────────────────────
      // (interactive TTY prompts; --yes / --json / non-TTY proceed)
      const totalPayoutWei = tasks.reduce(
        (sum, t) => sum.add(ethers.utils.parseUnits(t.payout.toString(), 18)),
        ethers.BigNumber.from(0)
      );
      await confirmWrite(argv, {
        project: String(argv.project),
        tasks: tasks.length,
        totalPayout: formatToken(totalPayoutWei, 18, 'PT'),
        deadline: defaultDeadline > 0 ? formatDeadline(defaultDeadline) : undefined,
        completionWindow: defaultWindow > 0 ? `${defaultWindow}s` : undefined,
        mode: 'one all-or-nothing transaction',
      }, { actionLabel: 'About to create task batch' });

      {
        // v6: one all-or-nothing createTasksBatch transaction — the contract
        // reverts the whole batch if any task fails.
        if (argv.continueOnError) {
          output.warn('--continue-on-error has no effect on v6 orgs: createTasksBatch is all-or-nothing.');
        }

        const spin = output.spinner(`Pinning metadata for ${tasks.length} tasks...`);
        spin.start();

        // CreateTaskInput tuple field order must match the createTasksBatch
        // components in src/abi/TaskManagerNew.json (NOTE: no pid inside):
        // payout, title, metadataHash, bountyToken, bountyPayout,
        // requiresApplication, absoluteDeadline, completionWindow
        const inputs: any[][] = [];
        for (const task of tasks) {
          const cid = argv.dryRun ? undefined : await pinJson(JSON.stringify(buildMetadata(task)));
          const metadataHash = cid ? ipfsCidToBytes32(cid) : ethers.constants.HashZero;
          const titleBytes = stringToBytes(task.name);
          const payoutWei = ethers.utils.parseUnits(task.payout.toString(), 18);

          const bountyToken = task.bountyToken || ethers.constants.AddressZero;
          let bountyPayoutWei: ethers.BigNumber | number = 0;
          if (task.bountyAmount && task.bountyAmount > 0 && bountyToken !== ethers.constants.AddressZero) {
            const decimals = getTokenDecimals(bountyToken);
            bountyPayoutWei = ethers.utils.parseUnits(task.bountyAmount.toString(), decimals);
          }

          inputs.push([
            payoutWei,
            titleBytes,
            metadataHash,
            bountyToken,
            bountyPayoutWei,
            task.requiresApplication || false,
            task.absoluteDeadline,
            task.completionWindowSecs,
          ]);
        }

        spin.text = `Creating ${tasks.length} tasks in one transaction...`;
        const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', signer);
        const result = await executeTx(contract, 'createTasksBatch', [pid, inputs], { dryRun: argv.dryRun });

        spin.stop();

        if (!result.success) {
          output.error(`Batch creation failed: ${result.error}`, { error: result.error, errorCode: result.errorCode });
          process.exit(2);
          return;
        }

        // Dry run: standardized rendering (method/to/gasEstimate) via
        // finishWrite — nothing landed, so there are no task ids to report.
        if (result.dryRun) {
          finishWrite(result, { successMsg: `Batch created: ${tasks.length} tasks in one transaction` });
          return;
        }

        // One TaskCreated log per task, emitted in input order
        const taskIds = (result.logs ?? [])
          .filter(l => l.name === 'TaskCreated')
          .map(l => l.args?.id?.toString());
        const results = tasks.map((t, i) => ({ name: t.name, taskId: taskIds[i], txHash: result.txHash, status: 'ok' }));

        if (output.isJsonMode()) {
          output.json({
            results,
            total: tasks.length,
            succeeded: tasks.length,
            failed: 0,
            txHash: result.txHash,
            explorerUrl: result.explorerUrl,
          });
        } else {
          output.success(`Batch created: ${tasks.length} tasks in one transaction`, {
            taskIds: taskIds.length > 0 ? taskIds.join(', ') : undefined,
            txHash: result.txHash,
            explorerUrl: result.explorerUrl,
          });
          output.subgraphLagWarning();
        }
        return;
      }

    } catch (err: any) {
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err?.message || String(err));
      process.exit(1);
    }
  },
};
