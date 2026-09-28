import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
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
import { requireArg } from '../../lib/validation';
import { getTokenDecimals } from '../../config/tokens';
import {
  argvToIdempotencyString,
  checkIdempotencyCache,
  recordIdempotentResult,
} from '../../lib/idempotency';
import {
  calculatePayout,
  payoutConfigFromMetadata,
  resolveTokenLabel,
  normalizeHourlyRate,
  formatEstTime,
  type PayoutConfig,
} from '../../lib/payout';
import { FETCH_ORG_PAYOUT_CONFIG } from '../../queries/org';
import * as output from '../../lib/output';
import { tokenize, jaccard } from '../../lib/similarity';
import { resolveOrgContracts } from './helpers';
import { query } from '../../lib/subgraph';
import { FETCH_PROJECTS_DATA } from '../../queries/task';

interface CreateArgs {
  org: string;
  project: string;
  name: string;
  description: string;
  payout?: number;
  difficulty?: string;
  'est-hours'?: number;
  location?: string;
  'bounty-token'?: string;
  'bounty-amount'?: number;
  'requires-application'?: boolean;
  deadline?: string;
  'completion-window'?: string;
  force?: boolean;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const createHandler = {
  builder: (yargs: Argv) => yargs
    .option('project', { type: 'string', demandOption: true, describe: 'Project ID' })
    .option('name', { type: 'string', demandOption: true, describe: 'Task name' })
    .option('description', { type: 'string', demandOption: true, describe: 'Task description' })
    .option('payout', {
      type: 'number',
      describe: 'Payout amount. Omit to price the task the way the web app would, from the org\'s '
        + 'payout convention plus --difficulty/--est-hours',
    })
    .option('difficulty', { type: 'string', default: 'medium', describe: 'Difficulty (easy/medium/hard)' })
    .option('est-hours', { type: 'number', default: 0, describe: 'Estimated hours' })
    .option('location', { type: 'string', default: '', describe: 'Location' })
    .option('bounty-token', { type: 'string', describe: 'Bounty ERC20 token address' })
    .option('bounty-amount', { type: 'number', describe: 'Bounty payout amount' })
    .option('requires-application', { type: 'boolean', default: false, describe: 'Require applications' })
    .option('deadline', { type: 'string', describe: 'Absolute claim deadline — no claims after this time (v6 orgs only)' })
    .option('completion-window', { type: 'string', describe: 'Time a claimer has to submit after claiming (v6 orgs only)' })
    .option('force', { type: 'boolean', default: false, describe: 'Skip duplicate check' })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Task #369 (HB#213): explicit idempotency key. Two calls with the same orgId + this key within 15 minutes return the same taskId without re-submitting. Default: auto-derived from a hash of the full argv.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit a new task.',
    })
    .example('pop task create --project "Ops" --name "Write docs" --description "Draft the treasury guide" --payout 25', 'Create a 25 PT task under the Ops project')
    .example('pop task create --project 0x… --name "Fix bug" --description "…" --payout 10 --deadline 7d --requires-application', 'Application-gated task with a one-week claim deadline (v6)'),

  handler: async (argv: ArgumentsCamelCase<CreateArgs>) => {
    const spin = output.spinner('Creating task...');
    spin.start();

    try {
      // v6 deadline flags: parse up-front so bad input fails before any
      // network work (and long before any transaction is sent).
      const deadlineFlagsSet = argv.deadline !== undefined || argv.completionWindow !== undefined;
      const absoluteDeadline = argv.deadline !== undefined ? parseDeadline(argv.deadline) : 0;
      const completionWindow = argv.completionWindow !== undefined ? parseDurationSeconds(argv.completionWindow) : 0;

      const { taskManagerAddress, orgId } = await resolveOrgContracts(argv.org, argv.chain);

      // Task #369: idempotency check. Same pattern as pop vote create —
      // see src/lib/idempotency.ts for the TTL + key derivation details.
      const idempKey = argv.idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!argv.noIdempotency) {
        const cached = checkIdempotencyCache(orgId, 'task.create', idempKey);
        if (cached) {
          spin.stop();
          output.success('Task already created (idempotency cache hit)', {
            ...cached,
            cached: true,
            note: 'A prior call within the 15-minute idempotency window produced this result. Pass --no-idempotency to force a new submission.',
          });
          return;
        }
      }
      const { signer, provider, chainId } = createSigner({ privateKey: argv.privateKey as string, chainId: argv.chain, rpcUrl: argv.rpc as string });

      // Feature-gate: pre-v6 TaskManagers only expose the 7-arg createTask.
      // Detection is a read call, so it runs on --dry-run too (the dry run
      // still needs the right signature to estimate gas against).
      const features = await detectTaskManagerFeatures(provider, taskManagerAddress, chainId);
      if (!features.deadlines) {
        spin.stop();
        output.error(featureUnavailable(
          'task deadlines',
          'TaskManager v6',
          'Upgrade the organization TaskManager beacon before creating tasks.'
        ));
        process.exit(EXIT.PRECONDITION);
        return;
      }

      // Duplicate check: warn if similar task exists
      // Heuristic: strip stopwords + common CLI scaffolding words, then compare by
      // Jaccard similarity (overlap / union). Require at least 3 shared meaningful
      // words to flag — prevents short titles from tripping on a single shared word.
      if (!argv.force) {
        try {
          const result = await query<any>(FETCH_PROJECTS_DATA, { orgId }, argv.chain);
          const projects = result.organization?.taskManager?.projects || [];
          const allTasks = projects.flatMap((p: any) => p.tasks || []);
          const newWords = tokenize(argv.name as string);
          if (newWords.size >= 3) {
            for (const task of allTasks) {
              if (task.status === 'Cancelled') continue;
              const existingWords = tokenize(task.title || '');
              if (existingWords.size === 0) continue;
              const shared = [...newWords].filter(w => existingWords.has(w));
              if (shared.length < 3) continue; // absolute floor
              const score = jaccard(newWords, existingWords);
              if (score >= 0.5) {
                spin.stop();
                output.warn(
                  `Similar task exists: #${task.taskId} "${task.title}" (${task.status}). ` +
                  `Jaccard=${score.toFixed(2)}, shared=[${shared.join(',')}]. ` +
                  `Use --force to create anyway.`
                );
                process.exit(1);
              }
            }
          }
        } catch {
          // If duplicate check fails, proceed anyway
        }
      }

      // Resolve project name to on-chain bytes32 ID
      let pid: string;
      const projectInput = argv.project as string;
      if (projectInput.startsWith('0x') && projectInput.length === 66) {
        pid = projectInput;
      } else {
        // Try to match by name via subgraph
        const projResult = await query<any>(FETCH_PROJECTS_DATA, { orgId }, argv.chain);
        const projects = projResult.organization?.taskManager?.projects || [];
        const match = projects.find((p: any) =>
          (p.title || '').toLowerCase() === projectInput.toLowerCase()
        );
        if (match) {
          // Extract bytes32 project ID from subgraph composite ID: "{contractAddress}-{projectIdHex}"
          pid = parseProjectId(match.id);
        } else {
          // Try parsing as a numeric index
          const num = parseInt(projectInput, 10);
          if (!isNaN(num)) {
            pid = ethers.utils.hexZeroPad(ethers.utils.hexlify(num), 32);
          } else {
            const available = projects.map((p: any) => p.title).filter(Boolean).join(', ');
            throw new Error(`Project "${projectInput}" not found. Available: ${available || 'none'}`);
          }
        }
      }

      // Price the task. TaskManager stores whatever payout it is handed, so pricing is a
      // convention shared with the web app rather than an on-chain rule — when --payout is
      // omitted, derive it exactly as the UI does so a CLI-created task is not visibly
      // mispriced next to an identical one created in the browser.
      let payoutConfig: PayoutConfig & { useTokenSymbol: boolean } = {
        hoursOnly: false, hourlyRate: null, useTokenSymbol: false,
      };
      let tokenSymbol: string | null = null;
      let payoutConfigError: unknown = null;
      try {
        const cfg = await query<any>(FETCH_ORG_PAYOUT_CONFIG, { orgId }, argv.chain);
        if (!cfg.organization) {
          // A successful query with NO org row (indexer lag on a fresh org) is
          // indistinguishable from "no pricing configured" only by accident —
          // treat it like a failed fetch so derivation refuses to guess.
          // An org row with null metadata is DIFFERENT: that is a real org that
          // never configured pricing, and default pricing is correct for it.
          throw new Error('organization not indexed');
        }
        payoutConfig = payoutConfigFromMetadata(cfg.organization?.metadata);
        tokenSymbol = cfg.organization?.participationToken?.symbol ?? null;
      } catch (err) {
        // Only fatal when a payout must be DERIVED. An explicit --payout does not
        // depend on org pricing, so the subgraph being down must not block it.
        payoutConfigError = err;
      }
      const tokenLabel = resolveTokenLabel({ useTokenSymbol: payoutConfig.useTokenSymbol, symbol: tokenSymbol });

      let derivedPayout: number | null = null;
      if (argv.payout === undefined) {
        if (payoutConfigError) {
          // Deriving from the hard-coded default config would silently misprice the
          // task for any org with hours-only or custom hourly pricing — and the
          // payout goes on-chain. Refuse rather than guess.
          throw new CliError(
            'Could not read the org payout config (subgraph unreachable), so a payout cannot be derived safely.',
            EXIT.PRECONDITION,
            'Pass --payout explicitly, or retry when the subgraph is reachable.'
          );
        }
        derivedPayout = calculatePayout(argv.difficulty || 'medium', argv.estHours || 0, payoutConfig);
        if (derivedPayout <= 0) {
          throw new CliError(
            'Could not derive a payout: the org pays by hours only and --est-hours is 0.',
            EXIT.USAGE,
            'Pass --est-hours, or set --payout explicitly.'
          );
        }
      }
      const payoutAmount = argv.payout ?? derivedPayout!;
      const payoutWei = ethers.utils.parseUnits(payoutAmount.toString(), 18);

      const bountyToken = argv.bountyToken || ethers.constants.AddressZero;
      let bountyPayoutWei: ethers.BigNumber | number = 0;
      if (argv.bountyAmount && argv.bountyAmount > 0 && bountyToken !== ethers.constants.AddressZero) {
        const decimals = getTokenDecimals(bountyToken);
        bountyPayoutWei = ethers.utils.parseUnits(argv.bountyAmount.toString(), decimals);
      }

      const requiresApp = argv.requiresApplication || false;

      // ── Confirm BEFORE the IPFS pin or any transaction ─────────────────
      // (interactive TTY prompts; --yes / --json / non-TTY proceed)
      spin.stop();
      await confirmWrite(argv, {
        project: String(argv.project),
        name: argv.name,
        payout: formatToken(payoutWei, 18, tokenLabel)
          + (derivedPayout !== null
            ? payoutConfig.hoursOnly
              ? ` (derived: ${normalizeHourlyRate(payoutConfig.hourlyRate)}/h x ${formatEstTime(argv.estHours || 0)})`
              : ` (derived: ${argv.difficulty || 'medium'} x ${formatEstTime(argv.estHours || 0)})`
            : ''),
        bounty: typeof bountyPayoutWei !== 'number'
          ? `${formatToken(bountyPayoutWei, getTokenDecimals(bountyToken))} of ${bountyToken}`
          : undefined,
        requiresApplication: requiresApp ? 'yes' : undefined,
        deadline: absoluteDeadline > 0 ? formatDeadline(absoluteDeadline) : undefined,
        completionWindow: completionWindow > 0 ? `${completionWindow}s` : undefined,
      }, { actionLabel: 'About to create task' });
      spin.start();

      // Build metadata JSON (key order must match frontend exactly)
      const metadata = {
        name: argv.name,
        description: argv.description,
        location: argv.location || '',
        difficulty: argv.difficulty || 'medium',
        estHours: argv.estHours || 0,
        submission: '',
      };

      spin.text = 'Pinning metadata to IPFS...';
      const cid = argv.dryRun ? undefined : await pinJson(JSON.stringify(metadata));
      const metadataHash = cid ? ipfsCidToBytes32(cid) : ethers.constants.HashZero;

      const titleBytes = stringToBytes(argv.name);

      spin.text = 'Sending transaction...';
      const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', signer);
      const txArgs = [payoutWei, titleBytes, metadataHash, pid, bountyToken, bountyPayoutWei, requiresApp, absoluteDeadline, completionWindow];
      const result = await executeTx(contract, 'createTask', txArgs, { dryRun: argv.dryRun });

      spin.stop();

      // Extract taskId from TaskCreated event (absent on dry runs/failures)
      const taskCreatedEvent = result.logs?.find(l => l.name === 'TaskCreated');
      const taskId = taskCreatedEvent?.args?.id?.toString();

      // v6 with deadlines set: surface what the contract actually recorded
      // (TaskDeadlinesSet log), falling back to the parsed flag values on
      // dry runs where no logs exist.
      let deadlineFields: Record<string, string | number> = {};
      if (features.deadlines && (absoluteDeadline > 0 || completionWindow > 0)) {
        const deadlinesSetEvent = result.logs?.find(l => l.name === 'TaskDeadlinesSet');
        const dl = deadlinesSetEvent ? Number(deadlinesSetEvent.args.absoluteDeadline.toString()) : absoluteDeadline;
        const cw = deadlinesSetEvent ? Number(deadlinesSetEvent.args.completionWindow.toString()) : completionWindow;
        deadlineFields = { deadline: formatDeadline(dl), completionWindowSeconds: cw };
      }

      finishWrite(result, {
        successMsg: 'Task created',
        fields: {
          taskId,
          ipfsCid: cid,
          ...deadlineFields,
        },
        onSuccess: () => {
          // Task #369: record idempotent result so retries hit the cache
          // (finishWrite skips this on dry runs — nothing landed on-chain).
          if (!argv.noIdempotency) {
            recordIdempotentResult(orgId, 'task.create', idempKey, {
              taskId,
              txHash: result.txHash,
              ipfsCid: cid,
            });
          }
        },
      });
    } catch (err: any) {
      spin.stop();
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err?.message || String(err));
      process.exit(1);
    }
  },
};
