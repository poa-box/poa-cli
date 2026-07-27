/**
 * pop task assign — assign a task to an address/username (v6 takeover aware).
 *
 * Same claimability gate as pop task claim: an UNCLAIMED task assigns
 * normally; a CLAIMED task assigns only when the previous claim's deadline
 * has strictly passed (expired-claim takeover, TaskClaimExpired is emitted);
 * anything else fails fast before the transaction.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { parseTaskId } from '../../lib/encoding';
import { formatToken } from '../../lib/format';
import { TaskOnChain } from '../../lib/task-lens';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { requireModule } from '../../lib/resolve';
import { requireAddress } from '../../lib/validation';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import {
  readTaskForPreflight,
  gateClaimableTask,
  claimReceiptFields,
  echoClaimReceipt,
} from './claim';

interface AssignArgs {
  org: string;
  task: string;
  assignee?: string;
  username?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

async function resolveUsernameToAddress(username: string, chainId?: number): Promise<string> {
  const { queryAllChains } = require('../../lib/subgraph');
  const query = `{ accounts(where: { username: "${username}" }, first: 1) { id username } }`;
  const results = await queryAllChains(query, {});
  for (const r of results) {
    const account = r.data?.accounts?.[0];
    if (account) return account.id;
  }
  throw new Error(`Username "${username}" not found. Check spelling or use --assignee with the address.`);
}

export const assignHandler = {
  builder: (yargs: Argv) => yargs
    .option('task', { type: 'string', demandOption: true, describe: 'Task ID' })
    .option('assignee', { type: 'string', describe: 'Address to assign to' })
    .option('username', { type: 'string', describe: 'Username to assign to (resolves to address)' })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Explicit idempotency key. Two assigns of the same task within 15 minutes return the same result without re-submitting. Default: auto-derived from argv.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit.',
    })
    .check((argv) => {
      if (!argv.assignee && !argv.username) throw new Error('Either --assignee or --username is required');
      return true;
    }),

  handler: async (argv: ArgumentsCamelCase<AssignArgs>) => {
    const spin = output.spinner('Checking task state...');

    try {
      let assignee: string;
      if (argv.username) {
        assignee = await resolveUsernameToAddress(argv.username as string, argv.chain);
        console.log(`  Resolved "${argv.username}" → ${assignee.slice(0, 12)}...`);
      } else {
        assignee = requireAddress(argv.assignee, 'assignee');
      }
      spin.start();

      const ctx = await getWriteContext(argv);
      const taskManagerAddress = requireModule(ctx.modules, 'taskManagerAddress');
      const parsedTaskId = parseTaskId(argv.task);

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      let task: TaskOnChain | null = null;
      let takeover = false;
      if (argv.preflight !== false) {
        task = await readTaskForPreflight(ctx.provider, taskManagerAddress, argv.task);
        takeover = gateClaimableTask(task, argv.task, 'assigning');
        if (!takeover && task.requiresApplication) {
          output.warn(
            `Task ${argv.task} requires applications — assignTask may revert with RequiresApplication. ` +
            `If it does, approve an application instead: pop task approve-app --task ${argv.task} --applicant ${assignee}`
          );
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      if (takeover && task) {
        output.info(`Taking over expired claim from ${task.claimer} — assigning to ${assignee}`);
      }

      await confirmWrite(argv, {
        task: `#${argv.task}`,
        assignee,
        payout: task ? formatToken(task.payout, 18, 'PT') : undefined,
        takeover: takeover && task ? `expired claim by ${task.claimer}` : undefined,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to assign task' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Assigning task...');
        txSpin.start();
        const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', ctx.signer);
        const result = await executeTx(contract, 'assignTask', [parsedTaskId, assignee], { dryRun: argv.dryRun });
        txSpin.stop();

        const receiptFields = claimReceiptFields(result);
        finishWrite(result, {
          successMsg: `Task ${argv.task} assigned to ${assignee}`,
          fields: { taskId: argv.task, assignee, ...receiptFields },
        });
        echoClaimReceipt(receiptFields, task, 'The assignee must submit');
        return { taskId: argv.task, assignee, txHash: result.txHash };
      };

      // Dry runs simulate unconditionally: no idempotency read or record.
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'task.assign', run);
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
