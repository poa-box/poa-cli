/**
 * pop vote create — create a hybrid or direct-democracy proposal.
 *
 * Governance safety: when --calls attaches an execution batch to option 0,
 * the interactive confirm summary DECODES each call — the target address is
 * resolved to its org-module name (TaskManager, Executor, …) and the calldata
 * selector to a function signature via the known ABIs — so a human approves
 * "TaskManager → setConfig(uint8,bytes)" rather than an opaque hex blob.
 * Undecodable calls are labeled UNDECODABLE, never hidden.
 *
 * Hat IDs are uint256 with high bits set — parseInt loses precision above
 * 2^53, so each entry is parsed as a BigNumber from the raw string.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32 } from '../../lib/encoding';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { describeExecutionCalls, ExecutionCallInput } from './helpers';

interface CreateArgs {
  org: string;
  type: string;
  name: string;
  description: string;
  duration: number;
  options: string;
  'hat-ids'?: string;
  calls?: string;
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
    .option('type', { type: 'string', demandOption: true, choices: ['hybrid', 'dd'], describe: 'Voting type' })
    .option('name', { type: 'string', demandOption: true, describe: 'Proposal title' })
    .option('description', { type: 'string', demandOption: true, describe: 'Proposal description' })
    .option('duration', { type: 'number', demandOption: true, describe: 'Duration in minutes' })
    .option('options', { type: 'string', demandOption: true, describe: 'Comma-separated option names' })
    .option('hat-ids', { type: 'string', describe: 'Comma-separated hat IDs for restricted voting' })
    .option('calls', { type: 'string', describe: 'JSON array of execution calls for option 0: [{"target":"0x...","value":"0","data":"0x..."}]' })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Task #369 (HB#213): explicit idempotency key. Two calls with the same orgId + this key within 15 minutes return the same proposalId without re-submitting. Default: auto-derived from a hash of the full argv (transient fields like --private-key and --dry-run excluded). Use --no-idempotency to opt out entirely.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit a new proposal. Use only when you intentionally want a duplicate write.',
    })
    .example('pop vote create --type hybrid --name "Fund audit" --description "…" --duration 1440 --options "Approve,Reject"', 'Plain 2-option proposal with a 24h window')
    .example('pop vote create --type hybrid --name "Set quorum" --description "…" --duration 60 --options "Apply,Keep" --calls \'[{"target":"0x…","value":"0","data":"0x…"}]\'', 'Attach execution calls to option 0 (decoded in the confirm summary)'),

  handler: async (argv: ArgumentsCamelCase<CreateArgs>) => {
    const spin = output.spinner('Creating proposal...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);

      const isHybrid = argv.type === 'hybrid';
      const contractAddr = isHybrid ? ctx.modules?.hybridVotingAddress : ctx.modules?.ddVotingAddress;
      if (!contractAddr) {
        throw new CliError(
          `${isHybrid ? 'HybridVoting' : 'DirectDemocracyVoting'} not deployed for this org`,
          EXIT.PRECONDITION
        );
      }

      const optionNames = (argv.options as string).split(',').map(s => s.trim());
      const numOptions = optionNames.length;
      if (numOptions < 2) {
        throw new CliError('At least 2 options are required', EXIT.USAGE);
      }

      // Hats IDs are uint256 with high bits set — parseInt loses precision
      // above 2^53, so parse each entry as a BigNumber from the raw string.
      const hatIds = argv.hatIds
        ? (argv.hatIds as string).split(',').map(s => ethers.BigNumber.from(s.trim()))
        : [];

      // Build execution batches: calls go to option 0, other options get empty batches
      let calls: ExecutionCallInput[] | null = null;
      const batches: any[][] = [];
      if (argv.calls) {
        try {
          calls = JSON.parse(argv.calls as string);
        } catch (parseErr: any) {
          throw new CliError(`--calls is not valid JSON: ${parseErr?.message ?? parseErr}`, EXIT.USAGE);
        }
        if (!Array.isArray(calls)) {
          throw new CliError('--calls must be a JSON array of {target, value, data} objects', EXIT.USAGE);
        }
        const option0Batch = calls.map((c: any) => [
          c.target,
          ethers.BigNumber.from(c.value || '0'),
          c.data,
        ]);
        batches.push(option0Batch);
        for (let i = 1; i < numOptions; i++) {
          batches.push([]);
        }
      }

      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      // Confirm summary. Execution calls are decoded (module name + function
      // signature) so the human sees WHAT the proposal would execute.
      const summary: Record<string, string | number | undefined> = {
        type: argv.type,
        title: argv.name,
        options: optionNames.join(', '),
        duration: `${argv.duration} minutes`,
        org: argv.org,
        chain: ctx.networkName,
      };
      if (calls && calls.length > 0) {
        describeExecutionCalls(calls, ctx.modules).forEach((line, i) => {
          summary[`call ${i + 1}/${calls!.length}`] = line;
        });
      }
      await confirmWrite(argv, summary, { actionLabel: 'About to create proposal' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Pinning proposal metadata to IPFS...');
        txSpin.start();

        // Upload proposal metadata to IPFS (key order matches the frontend).
        const proposalMetadata = {
          description: argv.description,
          optionNames,
          createdAt: Date.now(),
        };
        const cid = await pinJson(JSON.stringify(proposalMetadata));
        const descriptionHash = ipfsCidToBytes32(cid);
        const titleBytes = stringToBytes(argv.name);

        txSpin.text = 'Sending transaction...';
        const abiName = isHybrid ? 'HybridVotingNew' : 'DirectDemocracyVotingNew';
        const contract = createWriteContract(contractAddr, abiName, ctx.signer);

        const result = await executeTx(
          contract,
          'createProposal',
          [titleBytes, descriptionHash, argv.duration, numOptions, batches, hatIds],
          { dryRun: argv.dryRun }
        );
        txSpin.stop();

        const proposalEvent = result.logs?.find(l => l.name === 'NewProposal' || l.name === 'NewHatProposal');
        const proposalId = proposalEvent?.args?.id?.toString();

        finishWrite(result, {
          successMsg: 'Proposal created',
          fields: {
            proposalId,
            type: argv.type,
            options: optionNames.join(', '),
            duration: `${argv.duration} minutes`,
            ipfsCid: cid,
            executionCalls: argv.calls ? 'yes (on option 0)' : 'none',
          },
        });
        return { proposalId, txHash: result.txHash, ipfsCid: cid };
      };

      // Dry runs simulate unconditionally: they neither consult nor record
      // the idempotency cache (nothing lands on-chain). This also fixes the
      // old behavior of recording a cache entry for a dry run, which made a
      // real submit within the TTL falsely report "already created".
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'vote.create', run);
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
