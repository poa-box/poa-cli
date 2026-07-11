/**
 * pop task submit — submit work for a claimed task.
 *
 * Order matters (fixed in the v6 migration): pre-flight runs FIRST, so a
 * submission that would revert (wrong status, not the claimer) fails fast
 * without wasting an IPFS pin. Then the pin, then the transaction.
 *
 * Expiry semantics (v6, verified against contracts origin/main): a lapsed
 * claim deadline NEVER blocks the original claimer's submitTask — it only
 * makes the task takeover-able by others until the submission lands. So an
 * expired claim is a WARNING here, not a failure.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { execFileSync } from 'child_process';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { parseTaskId, ipfsCidToBytes32 } from '../../lib/encoding';
import { formatCountdown } from '../../lib/format';
import { getTaskOnChain, deriveClaimState, TASK_STATUS, TaskOnChain } from '../../lib/task-lens';
import { runPreflight, checkGasBalance, checkTaskStatus } from '../../lib/preflight';
import { getWriteContext, finishWrite, withIdempotency } from '../../lib/command';
import { requireModule } from '../../lib/resolve';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import { query } from '../../lib/subgraph';
import { FETCH_PROJECTS_DATA } from '../../queries/task';
import * as output from '../../lib/output';

interface SubmitArgs {
  org: string;
  task: string;
  submission: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  commit?: boolean;
  commitFiles?: string;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
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
    }),

  handler: async (argv: ArgumentsCamelCase<SubmitArgs>) => {
    const spin = output.spinner('Submitting task...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);
      const taskManagerAddress = requireModule(ctx.modules, 'taskManagerAddress');
      const parsedTaskId = parseTaskId(argv.task);

      const run = async (): Promise<Record<string, any>> => {
        // ── 1. PRE-FLIGHT FIRST (skippable with --no-preflight) ──────────
        // Status must be CLAIMED and the claimer must be this signer — fail
        // fast (exit 4) BEFORE the IPFS pin so doomed submissions don't
        // waste pins. The deadline read is warning-only (see module header).
        spin.text = 'Running pre-flight checks...';
        let onChainTask: TaskOnChain | null = null;
        if (argv.preflight !== false) {
          onChainTask = await getTaskOnChain(ctx.provider, taskManagerAddress, parsedTaskId)
            .catch(() => null); // warning data only — checkTaskStatus below is the gate
        }
        await runPreflight(ctx.provider, [
          checkGasBalance(ctx.address),
          checkTaskStatus(taskManagerAddress, parsedTaskId, [TASK_STATUS.CLAIMED], {
            claimerMustBe: ctx.address,
          }),
        ], { skip: !argv.preflight });

        if (onChainTask && deriveClaimState(onChainTask) === 'expired-claimable') {
          const deadline = onChainTask.claimDeadline || onChainTask.absoluteDeadline || 0;
          output.warn(
            `Your claim deadline passed (${formatCountdown(deadline)}) — the task is takeover-able ` +
            'by others until you submit. Submitting now still counts.'
          );
        }

        // ── 2. Fetch existing metadata so the submission preserves it ────
        spin.text = 'Fetching task metadata...';
        const taskData = await query<any>(FETCH_PROJECTS_DATA, { orgId: ctx.orgId }, argv.chain);
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

        // ── 3. Pin, THEN send ─────────────────────────────────────────────
        spin.text = 'Pinning submission to IPFS...';
        const cid = await pinJson(JSON.stringify(submissionMetadata));
        const submissionHash = ipfsCidToBytes32(cid);

        spin.text = 'Sending transaction...';
        const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', ctx.signer);
        const result = await executeTx(contract, 'submitTask', [parsedTaskId, submissionHash], { dryRun: argv.dryRun });
        spin.stop();

        finishWrite(result, {
          successMsg: `Task ${argv.task} submitted`,
          fields: { taskId: argv.task, ipfsCid: cid },
        });

        // Task #355 (HB#185): optional auto-commit. Runs git add + git
        // commit on the explicit files list AFTER the on-chain submission
        // lands (never on --dry-run). Failure here is a warning, not an
        // error — the submission is the source of truth and we never roll
        // it back over a git issue.
        if (argv.commit && result.success && !result.dryRun) {
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

        return { taskId: argv.task, txHash: result.txHash, ipfsCid: cid };
      };

      // Idempotency (task #370) wraps the whole pipeline so a retry within
      // the TTL returns the cached result BEFORE re-running pre-flight
      // (post-success the status is SUBMITTED, which would otherwise fail
      // the retry instead of confirming it). Dry runs bypass the cache.
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'task.submit', run);
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
