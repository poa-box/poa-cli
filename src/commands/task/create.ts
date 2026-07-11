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
import { detectTaskManagerFeatures, featureUnavailable, LEGACY_TM_FRAGMENTS } from '../../lib/version';
import { EXIT } from '../../lib/exit-codes';
import { requireArg } from '../../lib/validation';
import { getTokenDecimals } from '../../config/tokens';
import {
  argvToIdempotencyString,
  checkIdempotencyCache,
  recordIdempotentResult,
} from '../../lib/idempotency';
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
  payout: number;
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
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const createHandler = {
  builder: (yargs: Argv) => yargs
    .option('project', { type: 'string', demandOption: true, describe: 'Project ID' })
    .option('name', { type: 'string', demandOption: true, describe: 'Task name' })
    .option('description', { type: 'string', demandOption: true, describe: 'Task description' })
    .option('payout', { type: 'number', demandOption: true, describe: 'PT payout amount' })
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
    }),

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
      if (!features.deadlines && deadlineFlagsSet) {
        spin.stop();
        output.error(featureUnavailable(
          'task deadlines',
          'TaskManager v6',
          'Re-run without --deadline/--completion-window, or upgrade the org TaskManager beacon.'
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
      const cid = await pinJson(JSON.stringify(metadata));
      const metadataHash = ipfsCidToBytes32(cid);

      const titleBytes = stringToBytes(argv.name);

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

      const payoutWei = ethers.utils.parseUnits(argv.payout.toString(), 18);

      const bountyToken = argv.bountyToken || ethers.constants.AddressZero;
      let bountyPayoutWei: ethers.BigNumber | number = 0;
      if (argv.bountyAmount && argv.bountyAmount > 0 && bountyToken !== ethers.constants.AddressZero) {
        const decimals = getTokenDecimals(bountyToken);
        bountyPayoutWei = ethers.utils.parseUnits(argv.bountyAmount.toString(), decimals);
      }

      const requiresApp = argv.requiresApplication || false;

      spin.text = 'Sending transaction...';
      // v6 orgs get the 9-arg createTask (deadline params); legacy orgs fall
      // back to the 7-arg signature via LEGACY_TM_FRAGMENTS (the current ABI
      // no longer contains it).
      const contract = features.deadlines
        ? createWriteContract(taskManagerAddress, 'TaskManagerNew', signer)
        : new ethers.Contract(taskManagerAddress, LEGACY_TM_FRAGMENTS, signer);
      const txArgs = features.deadlines
        ? [payoutWei, titleBytes, metadataHash, pid, bountyToken, bountyPayoutWei, requiresApp, absoluteDeadline, completionWindow]
        : [payoutWei, titleBytes, metadataHash, pid, bountyToken, bountyPayoutWei, requiresApp];
      const result = await executeTx(contract, 'createTask', txArgs, { dryRun: argv.dryRun });

      spin.stop();

      if (result.success) {
        // Extract taskId from TaskCreated event
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

        // Task #369: record idempotent result so retries hit the cache
        if (!argv.noIdempotency) {
          recordIdempotentResult(orgId, 'task.create', idempKey, {
            taskId,
            txHash: result.txHash,
            ipfsCid: cid,
          });
        }

        output.success('Task created', {
          taskId,
          txHash: result.txHash,
          explorerUrl: result.explorerUrl,
          ipfsCid: cid,
          ...deadlineFields,
        });
        output.subgraphLagWarning();
      } else {
        output.error('Task creation failed', { error: result.error, errorCode: result.errorCode });
        process.exit(2);
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
