import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createSigner } from '../../lib/signer';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32 } from '../../lib/encoding';
import { resolveOrgId } from '../../lib/resolve';
import {
  argvToIdempotencyString,
  checkIdempotencyCache,
  recordIdempotentResult,
} from '../../lib/idempotency';
import * as output from '../../lib/output';
import { resolveVotingContracts } from './helpers';

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
    }),

  handler: async (argv: ArgumentsCamelCase<CreateArgs>) => {
    const spin = output.spinner('Creating proposal...');
    spin.start();

    try {
      const contracts = await resolveVotingContracts(argv.org, argv.chain);

      // Task #369: idempotency check BEFORE any work that touches IPFS
      // or the chain. We pin to the resolved orgId, not the user input,
      // so `--org argus` and `--org <hex-id>` resolve to the same cache key.
      const resolvedOrgId = await resolveOrgId(argv.org, argv.chain);
      const idempKey = argv.idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!argv.noIdempotency) {
        const cached = checkIdempotencyCache(resolvedOrgId, 'vote.create', idempKey);
        if (cached) {
          spin.stop();
          output.success('Proposal already created (idempotency cache hit)', {
            ...cached,
            cached: true,
            note: 'A prior call within the 15-minute idempotency window produced this result. Pass --no-idempotency to force a new submission.',
          });
          return;
        }
      }
      const { signer } = createSigner({ privateKey: argv.privateKey as string, chainId: argv.chain, rpcUrl: argv.rpc as string });

      const isHybrid = argv.type === 'hybrid';
      const contractAddr = isHybrid ? contracts.hybridVotingAddress : contracts.ddVotingAddress;
      if (!contractAddr) {
        throw new Error(`${isHybrid ? 'HybridVoting' : 'DirectDemocracyVoting'} not deployed for this org`);
      }

      const optionNames = (argv.options as string).split(',').map(s => s.trim());
      const numOptions = optionNames.length;

      if (numOptions < 2) {
        throw new Error('At least 2 options are required');
      }

      // Upload proposal metadata to IPFS
      const proposalMetadata = {
        description: argv.description,
        optionNames,
        createdAt: Date.now(),
      };

      spin.text = 'Pinning proposal metadata to IPFS...';
      const cid = await pinJson(JSON.stringify(proposalMetadata));
      const descriptionHash = ipfsCidToBytes32(cid);

      const titleBytes = stringToBytes(argv.name);
      // Hats IDs are uint256 with high bits set — parseInt loses precision
      // above 2^53, so parse each entry as a BigNumber from the raw string.
      const hatIds = argv.hatIds
        ? (argv.hatIds as string).split(',').map(s => ethers.BigNumber.from(s.trim()))
        : [];

      // Build execution batches: calls go to option 0, other options get empty batches
      const batches: any[][] = [];
      if (argv.calls) {
        const calls = JSON.parse(argv.calls as string);
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

      spin.text = 'Sending transaction...';
      const abiName = isHybrid ? 'HybridVotingNew' : 'DirectDemocracyVotingNew';
      const contract = createWriteContract(contractAddr, abiName, signer);

      const result = await executeTx(
        contract,
        'createProposal',
        [titleBytes, descriptionHash, argv.duration, numOptions, batches, hatIds],
        { dryRun: argv.dryRun }
      );

      spin.stop();

      if (result.success) {
        const proposalEvent = result.logs?.find(l => l.name === 'NewProposal' || l.name === 'NewHatProposal');
        const proposalId = proposalEvent?.args?.id?.toString();
        const successFields: Record<string, any> = {
          proposalId,
          txHash: result.txHash,
          explorerUrl: result.explorerUrl,
          type: argv.type,
          options: optionNames.join(', '),
          duration: `${argv.duration} minutes`,
          ipfsCid: cid,
          executionCalls: argv.calls ? 'yes (on option 0)' : 'none',
        };
        // Task #369: record the successful result so a near-immediate
        // retry (e.g. background-task race, CLI hang-retry) returns this
        // exact result instead of submitting a duplicate proposal.
        if (!argv.noIdempotency) {
          recordIdempotentResult(resolvedOrgId, 'vote.create', idempKey, {
            proposalId,
            txHash: result.txHash,
            ipfsCid: cid,
          });
        }
        output.success('Proposal created', successFields);
      } else {
        output.error('Proposal creation failed', { error: result.error, errorCode: result.errorCode });
        process.exit(2);
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
