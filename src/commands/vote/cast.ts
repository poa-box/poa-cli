/**
 * pop vote cast — cast a weighted vote on a proposal.
 *
 * Input safety kept from the original implementation: option/weight counts
 * must match, weights must be non-negative and sum to exactly 100 (the
 * contract's invariant) — all validated before any network traffic.
 *
 * --proposal accepts a numeric ID or a fuzzy title query (resolved against
 * the voting contract's recent proposals with preferActive: an ended homonym
 * never shadows the one still-open match, since you can only cast on an
 * open proposal).
 *
 * Pre-flight (skippable with --no-preflight): gas balance + the proposal
 * exists on-chain (proposalsCount > id) via one Multicall3 round-trip.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { runPreflight, checkGasBalance, checkProposalActive } from '../../lib/preflight';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { resolveProposalId } from './helpers';
import { query } from '../../lib/subgraph';

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
  yes?: boolean;
  preflight?: boolean;
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
    })
    .example('pop vote cast --type hybrid --proposal 12 --options 0 --weights 100', 'All-in on option 0')
    .example('pop vote cast --type hybrid --proposal "bridge retry" --options 0,1 --weights 60,40', 'Fuzzy title query + split weights'),

  handler: async (argv: ArgumentsCamelCase<CastArgs>) => {
    const optionIndices = (argv.options as string).split(',').map(s => parseInt(s.trim(), 10));
    const weights = (argv.weights as string).split(',').map(s => parseInt(s.trim(), 10));

    if (optionIndices.length !== weights.length) {
      output.error('Number of options must match number of weights');
      process.exit(EXIT.USAGE);
      return;
    }

    if (weights.some(w => w < 0)) {
      output.error('Weights must be non-negative');
      process.exit(EXIT.USAGE);
      return;
    }

    const weightSum = weights.reduce((a, b) => a + b, 0);
    if (weightSum !== 100) {
      output.error(`Weights must sum to 100, got ${weightSum}`);
      process.exit(EXIT.USAGE);
      return;
    }

    const spin = output.spinner('Casting vote...');
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

      // Resolve proposal — accepts numeric ID or fuzzy title query
      spin.text = 'Resolving proposal...';
      const proposalId = await resolveProposalId(
        String(argv.proposal),
        contractAddr,
        argv.chain,
        { preferActive: true }
      );

      // Pre-flight: gas + the proposal actually exists on this contract.
      await runPreflight(ctx.provider, [
        checkGasBalance(ctx.address),
        checkProposalActive(contractAddr, proposalId),
      ], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        proposal: `#${proposalId}`,
        type: argv.type,
        options: optionIndices.join(','),
        weights: weights.map(w => `${w}%`).join(','),
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to cast vote' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Casting vote...');
        txSpin.start();
        const abiName = isHybrid ? 'HybridVotingNew' : 'DirectDemocracyVotingNew';
        const contract = createWriteContract(contractAddr, abiName, ctx.signer);
        const result = await executeTx(
          contract,
          'vote',
          [proposalId, optionIndices, weights],
          { dryRun: argv.dryRun }
        );
        txSpin.stop();

        // Resolve option names for clarity (non-critical, subgraph best-effort)
        let optionMap = '';
        if (result.success && !result.dryRun) {
          try {
            const pq = `{ organization(id: "${ctx.orgId}") { hybridVoting { proposals(where: {proposalId: ${proposalId}}) { metadata { optionNames } } } } }`;
            const pResult = await query<any>(pq, {}, argv.chain);
            const names = pResult.organization?.hybridVoting?.proposals?.[0]?.metadata?.optionNames || [];
            if (names.length > 0) {
              optionMap = optionIndices.map((idx: number, i: number) => `${names[idx] || 'Option ' + idx}: ${weights[i]}%`).join(', ');
            }
          } catch { /* non-critical */ }
        }

        finishWrite(result, {
          successMsg: `Vote cast on proposal #${proposalId}`,
          fields: {
            proposalId,
            options: optionIndices.join(','),
            weights: weights.join(','),
            ...(optionMap ? { allocation: optionMap } : {}),
          },
        });
        return {
          proposalId,
          txHash: result.txHash,
          options: optionIndices.join(','),
          weights: weights.join(','),
        };
      };

      // Dry runs simulate unconditionally — no idempotency consult/record.
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'vote.cast', run);
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
