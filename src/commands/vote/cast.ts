import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createSigner } from '../../lib/signer';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import {
  argvToIdempotencyString,
  checkIdempotencyCache,
  recordIdempotentResult,
} from '../../lib/idempotency';
import { resolveOrgId } from '../../lib/resolve';
import * as output from '../../lib/output';
import { resolveVotingContracts, resolveProposalId } from './helpers';
import { query } from '../../lib/subgraph';
import { resolveOrgModules } from '../../lib/resolve';

interface CastArgs {
  org: string;
  type: string;
  proposal: string;
  options: string;
  weights: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const castHandler = {
  builder: (yargs: Argv) => yargs
    .option('type', { type: 'string', demandOption: true, choices: ['hybrid', 'dd'], describe: 'Voting type' })
    .option('proposal', { type: 'string', demandOption: true, describe: 'Proposal ID (number) or fuzzy title query (e.g. "bridge retry")' })
    .option('options', { type: 'string', demandOption: true, describe: 'Comma-separated option indices to vote for' })
    .option('weights', { type: 'string', demandOption: true, describe: 'Comma-separated weights (must sum to 100)' })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Task #370 (HB#214): explicit idempotency key. Two casts of the same vote within 15 minutes return the same result without re-submitting.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit.',
    }),

  handler: async (argv: ArgumentsCamelCase<CastArgs>) => {
    const optionIndices = (argv.options as string).split(',').map(s => parseInt(s.trim(), 10));
    const weights = (argv.weights as string).split(',').map(s => parseInt(s.trim(), 10));

    if (optionIndices.length !== weights.length) {
      output.error('Number of options must match number of weights');
      process.exit(1);
      return;
    }

    if (weights.some(w => w < 0)) {
      output.error('Weights must be non-negative');
      process.exit(1);
      return;
    }

    const weightSum = weights.reduce((a, b) => a + b, 0);
    if (weightSum !== 100) {
      output.error(`Weights must sum to 100, got ${weightSum}`);
      process.exit(1);
      return;
    }

    const spin = output.spinner('Casting vote...');
    spin.start();

    try {
      const contracts = await resolveVotingContracts(argv.org, argv.chain);
      const resolvedOrgId = await resolveOrgId(argv.org, argv.chain);
      const { signer } = createSigner({ privateKey: argv.privateKey as string, chainId: argv.chain, rpcUrl: argv.rpc as string });

      // Task #370: idempotency check
      const idempKey = argv.idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!argv.noIdempotency) {
        const cached = checkIdempotencyCache(resolvedOrgId, 'vote.cast', idempKey);
        if (cached) {
          spin.stop();
          output.success(`Vote already cast (idempotency cache hit)`, {
            ...cached,
            cached: true,
            note: 'Prior call within the 15-minute window produced this result. Use --no-idempotency to force re-submit.',
          });
          return;
        }
      }

      const isHybrid = argv.type === 'hybrid';
      const contractAddr = isHybrid ? contracts.hybridVotingAddress : contracts.ddVotingAddress;
      if (!contractAddr) {
        throw new Error(`${isHybrid ? 'HybridVoting' : 'DirectDemocracyVoting'} not deployed for this org`);
      }

      const abiName = isHybrid ? 'HybridVotingNew' : 'DirectDemocracyVotingNew';
      const contract = createWriteContract(contractAddr, abiName, signer);

      // Resolve proposal — accepts numeric ID or fuzzy title query
      spin.text = 'Resolving proposal...';
      const proposalId = await resolveProposalId(
        String(argv.proposal),
        contractAddr,
        argv.chain,
        { preferActive: true }
      );
      // HB#1033: resolve labels BEFORE tx so users see what they're about to cast,
      // not just after. Catches the 0-indexed-input vs 1-indexed-display trap
      // (`pop vote results` shows "#1 ApproveX / #2 Reject" but --options is
      // 0-indexed, so --options 1 selects "Reject" not "ApproveX"). Preview
      // goes to stderr so --json automation stays parseable.
      let optionMap = '';
      try {
        const modules = await resolveOrgModules(argv.org, argv.chain);
        const pq = `{ organization(id: "${modules.orgId}") { hybridVoting { proposals(where: {proposalId: ${proposalId}}) { metadata { optionNames } } } } }`;
        const pResult = await query<any>(pq, {}, argv.chain);
        const names = pResult.organization?.hybridVoting?.proposals?.[0]?.metadata?.optionNames || [];
        if (names.length > 0) {
          optionMap = optionIndices.map((idx: number, i: number) => `${names[idx] || 'Option ' + idx}: ${weights[i]}%`).join(', ');
          spin.stop();
          process.stderr.write(`About to cast: ${optionMap}  (--options is 0-indexed)\n`);
          spin.start();
        }
      } catch { /* non-critical — label preview is best-effort */ }

      spin.text = 'Casting vote...';

      const result = await executeTx(
        contract,
        'vote',
        [proposalId, optionIndices, weights],
        { dryRun: argv.dryRun }
      );

      spin.stop();

      if (result.success) {

        // Task #370: record idempotent result
        if (!argv.noIdempotency) {
          recordIdempotentResult(resolvedOrgId, 'vote.cast', idempKey, {
            proposalId,
            txHash: result.txHash,
            options: optionIndices.join(','),
            weights: weights.join(','),
          });
        }

        output.success(`Vote cast on proposal #${proposalId}`, {
          txHash: result.txHash, explorerUrl: result.explorerUrl,
          proposalId,
          options: optionIndices.join(','),
          weights: weights.join(','),
          ...(optionMap ? { allocation: optionMap } : {}),
        });
      } else {
        output.error('Vote failed', { error: result.error, errorCode: result.errorCode });
        process.exit(2);
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
