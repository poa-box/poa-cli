import type { Argv, ArgumentsCamelCase } from 'yargs';
import { execFileSync } from 'child_process';
import { createSigner } from '../../lib/signer';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { parseTaskId, ipfsCidToBytes32 } from '../../lib/encoding';
import { query } from '../../lib/subgraph';
import { resolveOrgId } from '../../lib/resolve';
import { FETCH_PROJECTS_DATA } from '../../queries/task';
import {
  argvToIdempotencyString,
  checkIdempotencyCache,
  recordIdempotentResult,
} from '../../lib/idempotency';
import * as output from '../../lib/output';
import { resolveOrgContracts } from './helpers';
import { extractReferencedPaths, checkDeliverables, formatBlockMessage } from '../../lib/deliverable-check';

interface SubmitArgs {
  org: string;
  task: string;
  submission: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  commit?: boolean;
  commitFiles?: string;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
  'allow-uncommitted'?: boolean;
  'skip-build-check'?: boolean;
}

export const submitHandler = {
  builder: (yargs: Argv) => yargs
    .option('task', { type: 'string', demandOption: true, describe: 'Task ID' })
    .option('submission', { type: 'string', demandOption: true, describe: 'Submission text' })
    .option('commit', {
      type: 'boolean',
      default: false,
      describe:
        'Task #355 (HB#185): after a successful submission, run git add + git commit on the files passed via --commit-files. The commit message references the task id and tx hash. Pre-commit hook failures are surfaced as warnings — the on-chain submission is the source of truth and is never rolled back.',
    })
    .option('commit-files', {
      type: 'string',
      describe:
        'Comma-separated list of files to git add + commit when --commit is set. Required if --commit is true; ignored otherwise. Use specific paths only — never . or -A — to avoid sweeping in cross-agent in-flight work.',
    })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Task #370 (HB#214): explicit idempotency key. Two submits of the same task within 15 minutes return the same result without re-submitting or re-pinning.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit.',
    })
    .option('allow-uncommitted', {
      type: 'boolean',
      default: false,
      describe:
        'Task #465 (retro-542 change-3): bypass the deliverable-committed pre-check. By default, pop task submit scans the --submission text for file paths and blocks if any referenced file is untracked or has unstaged changes (HB#520 loss-audit prevention). Use this only when the submission references in-progress files intentionally.',
    })
    .option('skip-build-check', {
      type: 'boolean',
      default: false,
      describe:
        'retro-839 change-1 (HB#841): bypass the build-freshness pre-check. By default, if the submission references any .ts file under src/, pop task submit verifies dist/index.js is newer than all src/**/*.ts — preventing resubmission of unbuilt code (HB#830→#831 lost-cycle prevention). Pass this flag for submissions that reference .ts files but intentionally skip rebuild.',
    }),

  handler: async (argv: ArgumentsCamelCase<SubmitArgs>) => {
    // Task #465 (retro-542 change-3): pre-submit deliverable check.
    // Run BEFORE the spinner + IPFS pin so the operator gets fast, clean
    // feedback before any irreversible work happens.
    if (!argv['allow-uncommitted']) {
      const refs = extractReferencedPaths(argv.submission);
      if (refs.length > 0) {
        const check = checkDeliverables(refs);
        const block = formatBlockMessage(check);
        if (block) {
          if (output.isJsonMode()) {
            output.json({
              error: 'deliverables_uncommitted',
              uncommitted: check.uncommitted,
              untracked: check.untracked,
              committed: check.committed,
              hint: 'Commit referenced files first OR pass --allow-uncommitted',
            });
          } else {
            console.error('');
            console.error(block);
            console.error('');
          }
          process.exit(3);
        }
      }
    }

    // retro-839 change-1 (HB#841): build-freshness pre-check.
    // If the submission references any .ts file under src/, verify dist/index.js
    // is newer than all src/**/*.ts. Prevents HB#830→#831-style lost cycles
    // from resubmitting unbuilt TypeScript code.
    if (!argv['skip-build-check']) {
      const refs = extractReferencedPaths(argv.submission);
      const hasSrcTs = refs.some((p) => /src\/.*\.ts$/.test(p));
      if (hasSrcTs) {
        try {
          const stale = execFileSync('sh', ['-c', 'find src -name "*.ts" -newer dist/index.js 2>/dev/null | head -5'], { encoding: 'utf-8' }).trim();
          if (stale) {
            const staleList = stale.split('\n').filter(Boolean);
            if (output.isJsonMode()) {
              output.json({
                error: 'build_stale',
                staleFiles: staleList,
                hint: 'Run `yarn build` first OR pass --skip-build-check',
              });
            } else {
              console.error('');
              console.error('BUILD STALE: the following .ts files are newer than dist/index.js:');
              for (const f of staleList) console.error(`  ${f}`);
              console.error('');
              console.error('Run `yarn build` first, or pass --skip-build-check to bypass.');
              console.error('');
            }
            process.exit(4);
          }
        } catch (e: any) {
          // If dist/index.js doesn't exist, `find -newer` errors out. Treat as stale.
          if (e?.status) {
            if (output.isJsonMode()) {
              output.json({ error: 'build_stale', hint: 'dist/index.js not found; run `yarn build` first' });
            } else {
              console.error('BUILD STALE: dist/index.js not found. Run `yarn build` first.');
            }
            process.exit(4);
          }
        }
      }
    }

    const spin = output.spinner('Submitting task...');
    spin.start();

    try {
      const { taskManagerAddress } = await resolveOrgContracts(argv.org, argv.chain);
      const { signer } = createSigner({ privateKey: argv.privateKey as string, chainId: argv.chain, rpcUrl: argv.rpc as string });

      // Fetch existing task metadata so we preserve it in the submission
      spin.text = 'Fetching task metadata...';
      const orgId = await resolveOrgId(argv.org, argv.chain);

      // Task #370: idempotency check BEFORE IPFS pin (expensive, don't repeat)
      const idempKey = argv.idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!argv.noIdempotency) {
        const cached = checkIdempotencyCache(orgId, 'task.submit', idempKey);
        if (cached) {
          spin.stop();
          output.success(`Task ${argv.task} already submitted (idempotency cache hit)`, {
            ...cached,
            cached: true,
            note: 'Prior call within the 15-minute window produced this result. Use --no-idempotency to force re-submit.',
          });
          return;
        }
      }
      const taskData = await query<any>(FETCH_PROJECTS_DATA, { orgId }, argv.chain);
      const projects = taskData.organization?.taskManager?.projects || [];
      let existingMeta: any = null;
      for (const project of projects) {
        for (const task of project.tasks || []) {
          if (task.taskId === argv.task || task.id.endsWith(`-${argv.task}`)) {
            existingMeta = task.metadata;
            break;
          }
        }
        if (existingMeta) break;
      }

      // Merge submission into existing metadata (preserves name, description, difficulty, etc.)
      const submissionMetadata = {
        name: existingMeta?.name || '',
        description: existingMeta?.description || '',
        location: existingMeta?.location || '',
        difficulty: existingMeta?.difficulty || '',
        estHours: existingMeta?.estimatedHours ? parseFloat(existingMeta.estimatedHours) : 0,
        submission: argv.submission,
      };

      spin.text = 'Pinning submission to IPFS...';
      const cid = await pinJson(JSON.stringify(submissionMetadata));
      const submissionHash = ipfsCidToBytes32(cid);

      spin.text = 'Sending transaction...';
      const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', signer);
      const parsedTaskId = parseTaskId(argv.task);
      const result = await executeTx(contract, 'submitTask', [parsedTaskId, submissionHash], { dryRun: argv.dryRun });
      spin.stop();

      if (result.success) {
        // Task #370: record idempotent result
        if (!argv.noIdempotency) {
          recordIdempotentResult(orgId, 'task.submit', idempKey, {
            taskId: argv.task,
            txHash: result.txHash,
            ipfsCid: cid,
          });
        }
        output.success(`Task ${argv.task} submitted`, { txHash: result.txHash, explorerUrl: result.explorerUrl, ipfsCid: cid });

        // Task #355 (HB#185): optional auto-commit. Runs git add + git
        // commit on the explicit files list AFTER the on-chain
        // submission lands. Failure here is a warning, not an error —
        // the submission is the source of truth and we never roll it
        // back over a git issue.
        if (argv.commit) {
          const filesArg = (argv.commitFiles ?? '').trim();
          if (!filesArg) {
            output.error(
              '--commit was set but --commit-files is empty. Pass a comma-separated list of paths to commit. Skipping git commit.',
            );
          } else {
            const files = filesArg
              .split(',')
              .map((f) => f.trim())
              .filter((f) => f.length > 0);
            // Belt-and-suspenders: refuse the dangerous "all-files" patterns.
            const dangerous = files.find((f) => f === '.' || f === '-A' || f === '--all');
            if (dangerous) {
              output.error(
                `--commit-files contains "${dangerous}" which would sweep in cross-agent in-flight work. Pass explicit paths only. Skipping git commit.`,
              );
            } else {
              try {
                execFileSync('git', ['add', '--', ...files], { stdio: ['ignore', 'pipe', 'pipe'] });
                const taskTitle = (existingMeta?.name as string | undefined) ?? `Task ${argv.task}`;
                const commitMsg =
                  `Task #${argv.task}: ${taskTitle} — submitted via pop task submit\n\n` +
                  `txHash: ${result.txHash}\n` +
                  `ipfsCid: ${cid}\n\n` +
                  `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>\n`;
                execFileSync('git', ['commit', '-m', commitMsg], { stdio: ['ignore', 'pipe', 'pipe'] });
                const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
                  stdio: ['ignore', 'pipe', 'pipe'],
                })
                  .toString()
                  .trim();
                console.log(`  git commit: ${sha} (${files.length} file${files.length === 1 ? '' : 's'})`);
              } catch (gitErr: any) {
                // Common: pre-commit hook failure, no changes to commit, etc.
                // Surface the stderr if available so the operator can fix it.
                const stderr = gitErr?.stderr ? gitErr.stderr.toString().trim() : '';
                output.error(
                  `git commit failed (submission already on-chain — fix manually): ${gitErr.message}` +
                    (stderr ? `\n${stderr}` : ''),
                );
              }
            }
          }
        }
      } else {
        output.error('Submission failed', { error: result.error, errorCode: result.errorCode });
        process.exit(2);
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
