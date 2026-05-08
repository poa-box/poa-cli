import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import fs from 'fs';
import { createSigner } from '../../lib/signer';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32, parseProjectId } from '../../lib/encoding';
import { getTokenDecimals } from '../../config/tokens';
import * as output from '../../lib/output';
import { resolveOrgContracts } from './helpers';

interface BatchArgs {
  org?: string;
  project: string;
  file: string;
  'continue-on-error'?: boolean;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
}

interface TaskLine {
  name: string;
  description: string;
  payout: number;
  difficulty?: string;
  estHours?: number;
  location?: string;
  bountyToken?: string;
  bountyAmount?: number;
  requiresApplication?: boolean;
}

export const createBatchHandler = {
  builder: (yargs: Argv) => yargs
    .option('project', { type: 'string', demandOption: true, describe: 'Project ID (shared for all tasks)' })
    .option('file', { type: 'string', demandOption: true, describe: 'JSONL file (one task JSON per line)' })
    .option('continue-on-error', { type: 'boolean', default: false, describe: 'Skip failed tasks instead of stopping' }),

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

    // Parse all lines upfront to catch errors before sending any transactions
    const tasks: TaskLine[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        const task = JSON.parse(lines[i]) as TaskLine;
        if (!task.name || !task.description || task.payout === undefined) {
          throw new Error('Missing required fields: name, description, payout');
        }
        tasks.push(task);
      } catch (err: any) {
        output.error(`Line ${i + 1}: ${err.message}`);
        if (!argv.continueOnError) process.exit(1);
      }
    }

    output.info(`Creating ${tasks.length} tasks...`);

    try {
      const { taskManagerAddress } = await resolveOrgContracts(argv.org as string, argv.chain);
      const { signer } = createSigner({ privateKey: argv.privateKey as string, chainId: argv.chain, rpcUrl: argv.rpc as string });
      const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', signer);
      const pid = parseProjectId(argv.project);

      // Task #508 (HB#967): use TaskManager.createTasksBatch (selector
      // 0xc18aa1c9 — single atomic call, all-or-nothing semantics) instead
      // of the previous per-task client-side loop. Saves N×(21k base + per-call
      // overhead) gas and reduces sponsored-tx pressure on the PaymasterHub
      // (companion to Proposal #66 paymaster whitelist).
      //
      // Per the contract spec (poa-box/POP TaskManager.sol L456-475):
      // - permission checked once via _requireCanCreate(pid)
      // - reverts with EmptyBatch() if tasks.length == 0 (we early-return so
      //   we never trigger this on the contract)
      // - per-task validation runs inside _createTask; one bad task aborts
      //   the whole batch. With --continue-on-error the caller can split + retry.

      const spin = output.spinner(`Building batch of ${tasks.length} task(s) (pinning metadata in parallel)...`);
      spin.start();

      // Pin all metadata in parallel BEFORE building the tuple array. Each
      // task's metadata pin is independent; serializing them would dominate
      // wall-time for any non-trivial batch.
      const tupleInputs = await Promise.all(
        tasks.map(async (task) => {
          const metadata = {
            name: task.name,
            description: task.description,
            location: task.location || '',
            difficulty: task.difficulty || 'medium',
            estHours: task.estHours || 0,
            submission: '',
          };
          const cid = await pinJson(JSON.stringify(metadata));
          const metadataHash = ipfsCidToBytes32(cid);
          const titleBytes = stringToBytes(task.name);
          const payoutWei = ethers.utils.parseUnits(task.payout.toString(), 18);

          const bountyToken = task.bountyToken || ethers.constants.AddressZero;
          let bountyPayoutWei: ethers.BigNumber | number = 0;
          if (task.bountyAmount && task.bountyAmount > 0 && bountyToken !== ethers.constants.AddressZero) {
            const decimals = getTokenDecimals(bountyToken);
            bountyPayoutWei = ethers.utils.parseUnits(task.bountyAmount.toString(), decimals);
          }

          // Tuple order MUST match the Solidity struct CreateTaskInput:
          // (payout, title, metadataHash, bountyToken, bountyPayout, requiresApplication)
          // NOTE: pid is NOT in the tuple — it's a top-level arg to createTasksBatch.
          return [
            payoutWei,
            titleBytes,
            metadataHash,
            bountyToken,
            bountyPayoutWei,
            task.requiresApplication || false,
          ];
        })
      );

      spin.stop();

      // Task #514 (HB#969): in --dry-run mode, surface the encoded calldata
      // BEFORE attempting gas estimation. The acceptance criterion 'easy to
      // verify visually' requires user-visible calldata output; pre-#514
      // behavior was silent gas-estimate-then-revert which gave operators no
      // way to inspect the encoded batch shape pre-flight.
      if (argv.dryRun) {
        const calldata = contract.interface.encodeFunctionData('createTasksBatch', [pid, tupleInputs]);
        const sizeBytes = (calldata.length - 2) / 2;
        output.info(`[dry-run] Encoded calldata (${sizeBytes} bytes, selector ${calldata.slice(0, 10)}):`);
        console.log(calldata);
        output.info(`[dry-run] Will encode ${tasks.length} task(s) into a single createTasksBatch call.`);
      }

      const batchSpin = output.spinner(`Submitting createTasksBatch (${tasks.length} tasks, single atomic tx)...`);
      batchSpin.start();

      const result = await executeTx(
        contract,
        'createTasksBatch',
        [pid, tupleInputs],
        { dryRun: argv.dryRun }
      );

      batchSpin.stop();

      const results: Array<{ name: string; taskId?: string; txHash?: string; status: string; error?: string }> = [];

      if (result.success) {
        // Parse N TaskCreated events from the receipt and zip with input names.
        // Order is preserved: the contract creates tasks in input order, so
        // logs[k].args.id corresponds to tasks[k] (subject to other events
        // interleaved — we filter by event name then assume order).
        const taskCreatedEvents = (result.logs ?? []).filter((l: any) => l.name === 'TaskCreated');
        for (let i = 0; i < tasks.length; i++) {
          const task = tasks[i];
          const evt = taskCreatedEvents[i];
          const taskId = evt?.args?.id?.toString();
          if (taskId) {
            results.push({ name: task.name, taskId, txHash: result.txHash, status: 'ok' });
            output.success(`[${i + 1}/${tasks.length}] "${task.name}" created`, { taskId });
          } else {
            // Receipt was successful but we couldn't match an event for this
            // index. Treat as soft-warning rather than failure since the tx
            // landed; the operator can verify on-chain.
            results.push({ name: task.name, txHash: result.txHash, status: 'ok-no-event' });
            output.warn(`[${i + 1}/${tasks.length}] "${task.name}" — tx succeeded but TaskCreated event not parsed at index ${i}`);
          }
        }
      } else {
        // Whole batch reverted — record per-task failure with the same reason.
        // continueOnError is now a soft hint: with batch-atomic semantics it
        // doesn't change behavior on a single-tx revert. For per-task
        // continue-on-error flow, callers should split the batch client-side.
        for (const task of tasks) {
          results.push({ name: task.name, status: 'failed', error: result.error });
        }
        output.error(`Batch failed atomically: ${result.error}`);
        if (argv.continueOnError) {
          output.warn(`--continue-on-error has no effect on atomic batch reverts. To bypass a bad task, split the input and retry.`);
        }
      }

      // Summary
      const succeeded = results.filter(r => r.status === 'ok' || r.status === 'ok-no-event').length;
      const failed = results.filter(r => r.status === 'failed').length;

      if (output.isJsonMode()) {
        output.json({
          results,
          total: tasks.length,
          succeeded,
          failed,
          txHash: result.txHash,
          atomic: true,
        });
      } else {
        console.log('');
        output.info(
          `Batch complete (atomic): ${succeeded} succeeded, ${failed} failed out of ${tasks.length}` +
            (result.txHash ? `  tx ${result.txHash}` : ''),
        );
      }

      if (failed > 0) process.exit(2);
    } catch (err: any) {
      output.error(err.message);
      process.exit(1);
    }
  },
};
