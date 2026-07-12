/**
 * pop project delete — delete a project (DESTRUCTIVE).
 *
 * Gate — VERIFIED against contracts origin/main src/TaskManager.sol:
 * deleteProject(bytes32 pid) calls _requireCreator() (creator hat or
 * executor) and reverts NotFound when the project does not exist.
 *
 * Pre-flight (skippable with --no-preflight) reads the project via the
 * TaskManager lens (PROJECT_INFO → (cap, spent, exists)) so a bad or
 * already-deleted project ID fails fast (exit 4) before gas is spent.
 *
 * Destructive confirmation: interactive sessions are prompted; non-TTY
 * sessions must pass --yes explicitly.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { parseProjectId } from '../../lib/encoding';
import { STORAGE_KEYS, encodeLensCall, decodeLensResult } from '../../lib/task-lens';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance, PreflightCheck } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { formatToken } from '../../lib/format';
import { query } from '../../lib/subgraph';
import { FETCH_PROJECTS_DATA } from '../../queries/task';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface DeleteArgs {
  org: string;
  project: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

/**
 * Project exists on-chain (lens PROJECT_INFO → (cap, spent, exists)).
 * Same shape as the task-domain check in task/perms.ts.
 */
export function checkProjectExists(taskManagerAddr: string, pid: string): PreflightCheck {
  return {
    label: `project ${pid.slice(0, 10)}…`,
    call: {
      to: taskManagerAddr,
      data: encodeLensCall(STORAGE_KEYS.PROJECT_INFO, ethers.utils.defaultAbiCoder.encode(['bytes32'], [pid])),
    },
    interpret: (returnData, success) => {
      if (!success || !returnData || returnData === '0x') {
        return { ok: false, detail: 'could not read the project on-chain', suggestion: 'check the project ID with pop project list' };
      }
      const [, , exists] = ethers.utils.defaultAbiCoder.decode(
        ['uint128', 'uint128', 'bool'],
        decodeLensResult(returnData)
      );
      if (exists) return { ok: true };
      return { ok: false, detail: 'project does not exist on-chain', suggestion: 'list projects with pop project list' };
    },
  };
}

/**
 * Resolve --project input to the on-chain bytes32 pid:
 * bytes32 hex and subgraph composite IDs resolve locally; a plain decimal
 * maps to bytes32(uint) (on-chain pids are counters — verified against
 * _createProjectCore in TaskManager.sol); anything else is treated as a
 * project title and matched via the subgraph.
 */
async function resolveProjectInput(
  input: string,
  orgId: string,
  chainId?: number
): Promise<{ pid: string; title?: string }> {
  if (input.startsWith('0x') && input.length === 66) return { pid: input };
  if (/^0x[a-fA-F0-9]{40}-/.test(input)) return { pid: parseProjectId(input) };
  if (/^\d+$/.test(input)) {
    return { pid: ethers.utils.hexZeroPad(ethers.BigNumber.from(input).toHexString(), 32) };
  }

  // Title lookup via the subgraph (case-insensitive).
  let projects: any[] = [];
  try {
    const result = await query<any>(FETCH_PROJECTS_DATA, { orgId }, chainId);
    projects = result.organization?.taskManager?.projects || [];
  } catch {
    throw new CliError(
      `Could not resolve project "${input}" — the subgraph is unavailable for title lookup.`,
      EXIT.INFRA,
      'Pass the 0x-prefixed bytes32 project ID instead (pop project list --json).'
    );
  }
  const match = projects.find((p: any) => (p.title || '').toLowerCase() === input.toLowerCase());
  if (match) return { pid: parseProjectId(match.id), title: match.title };

  const available = projects.map((p: any) => p.title).filter(Boolean).join(', ');
  throw new CliError(
    `Project "${input}" not found.`,
    EXIT.USAGE,
    `Available projects: ${available || 'none'} (or pass the 0x-prefixed bytes32 project ID).`
  );
}

export const deleteHandler = {
  builder: (yargs: Argv) => yargs
    .option('project', { type: 'string', demandOption: true, describe: 'Project ID (bytes32 or decimal) or name' })
    .example('pop project delete --project 0x0000…0003', 'Delete project 3 by its bytes32 ID')
    .example('pop project delete --project "Old Initiative" --yes', 'Delete by name, skipping the confirmation prompt'),

  handler: async (argv: ArgumentsCamelCase<DeleteArgs>) => {
    const spin = output.spinner('Checking project...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);
      const taskManagerAddress = requireModule(ctx.modules, 'taskManagerAddress');

      const { pid, title } = await resolveProjectInput(argv.project, ctx.orgId, argv.chain);

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      // Authoritative existence read via the lens BEFORE any gas is spent.
      let capLabel: string | undefined;
      await runPreflight(ctx.provider, [
        checkGasBalance(ctx.address),
        checkProjectExists(taskManagerAddress, pid),
      ], { skip: !argv.preflight });

      // Best-effort cap echo for the confirmation summary (never blocks).
      try {
        const raw = await ctx.provider.call({
          to: taskManagerAddress,
          data: encodeLensCall(STORAGE_KEYS.PROJECT_INFO, ethers.utils.defaultAbiCoder.encode(['bytes32'], [pid])),
        });
        const [cap, spent] = ethers.utils.defaultAbiCoder.decode(
          ['uint128', 'uint128', 'bool'],
          decodeLensResult(raw)
        );
        capLabel = `${formatToken(spent, 18, 'PT')} spent of ${cap.isZero() ? 'unlimited' : formatToken(cap, 18, 'PT')} cap`;
      } catch { /* summary-only — the preflight already validated existence */ }

      spin.stop();

      await confirmWrite(argv, {
        project: title ? `${title} (${pid})` : pid,
        budget: capLabel,
        org: argv.org,
        chain: ctx.networkName,
      }, { destructive: true, actionLabel: 'About to DELETE project (cannot be undone)' });

      const txSpin = output.spinner('Deleting project...');
      txSpin.start();
      const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', ctx.signer);
      const result = await executeTx(contract, 'deleteProject', [pid], { dryRun: argv.dryRun });
      txSpin.stop();

      finishWrite(result, {
        successMsg: 'Project deleted',
        fields: { projectId: pid, project: title },
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
