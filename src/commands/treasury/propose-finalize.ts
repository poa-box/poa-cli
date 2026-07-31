/**
 * pop treasury propose-finalize — governance proposal to close a distribution.
 *
 * Wraps PaymentManager.finalizeDistribution(distributionId, minClaimPeriodBlocks)
 * in a HybridVoting proposal whose option-0 batch targets the PaymentManager.
 *
 * Gates — VERIFIED against contracts origin/main src/PaymentManager.sol:
 *   - finalizeDistribution is onlyOwner, and the owner is the Executor
 *     (initialize doc: "typically the Executor") — hence the governance wrap.
 *   - Reverts DistributionNotFound (totalAmount == 0), AlreadyFinalized, and
 *     ClaimPeriodNotExpired when block.number < creationBlock + minClaimPeriodBlocks
 *     (anchored on checkpointBlock — the DEPLOYED contract's anchor, proven by live eth_call.
 *     Audit M-08 proposes re-anchoring on the creation block, but that contract is not
 *     deployed; see the inline note at the guard).
 *   - On success the unclaimed remainder (totalAmount - totalClaimed) is
 *     returned to the owner (Executor treasury) and further claims are blocked.
 *
 * minClaimPeriodBlocks is measured from the distribution's CHECKPOINT block,
 * not from proposal execution — with the default 0 the only claim window is
 * the vote duration itself.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createReadContract, createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32 } from '../../lib/encoding';
import { formatToken } from '../../lib/format';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { resolvePayoutTokenInfo } from './helpers';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface ProposeFinalizeArgs {
  org: string;
  distribution: number;
  'min-claim-blocks'?: number;
  duration: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

const PM_IFACE = new ethers.utils.Interface([
  'function finalizeDistribution(uint256 distributionId, uint256 minClaimPeriodBlocks)',
]);

export const proposeFinalizeHandler = {
  builder: (yargs: Argv) => yargs
    .option('distribution', { type: 'number', demandOption: true, describe: 'Distribution ID to finalize' })
    .option('min-claim-blocks', {
      type: 'number',
      default: 0,
      describe: 'On-chain guard: execution reverts until this many blocks have passed since the distribution\'s CHECKPOINT block (0 = no extra guard beyond the vote duration)',
    })
    .option('duration', { type: 'number', default: 60, describe: 'Vote duration in minutes' })
    .example('pop treasury propose-finalize --distribution 3', 'Propose closing distribution 3 and returning unclaimed funds to the treasury')
    .example('pop treasury propose-finalize --distribution 3 --min-claim-blocks 120960', 'Require ~1 week of blocks since checkpoint before execution can succeed')
    .epilogue(
      'finalizeDistribution is executor-only on-chain, so it must pass a governance vote. '
      + 'Unclaimed funds return to the Executor treasury and further claims are blocked. '
      + 'List distributions and their state with: pop treasury distributions'
    ),

  handler: async (argv: ArgumentsCamelCase<ProposeFinalizeArgs>) => {
    const spin = output.spinner('Reading distribution state...');
    spin.start();

    try {
      const distId = argv.distribution;
      if (!Number.isInteger(distId) || distId < 0) {
        throw new CliError(`Invalid --distribution "${argv.distribution}".`, EXIT.USAGE, 'Pass the numeric distribution ID (pop treasury distributions).');
      }
      const minClaimBlocks = argv.minClaimBlocks ?? 0;
      if (!Number.isInteger(minClaimBlocks) || minClaimBlocks < 0) {
        throw new CliError('--min-claim-blocks must be a non-negative integer.', EXIT.USAGE);
      }

      const ctx = await getWriteContext(argv);
      const paymentManagerAddr = requireModule(ctx.modules, 'paymentManagerAddress');
      const hybridVotingAddr = ctx.modules.hybridVotingAddress;
      if (!hybridVotingAddr) {
        throw new PreconditionError('HybridVoting not deployed for this org — cannot create a governance proposal.');
      }

      // ── Pre-flight (skippable with --no-preflight): authoritative read ──
      // Mirrors the contract's own gates so the proposal isn't doomed at
      // execution: DistributionNotFound / AlreadyFinalized fail fast here.
      let dist: any = null;
      let tokenLabel = 'tokens';
      let unclaimedLabel: string | undefined;
      if (argv.preflight !== false) {
        const pmRead = createReadContract(paymentManagerAddr, 'PaymentManager', ctx.provider);
        try {
          dist = await pmRead.getDistribution(distId);
        } catch {
          throw new PreconditionError(
            `Could not read distribution ${distId} on-chain.`,
            'List distributions with: pop treasury distributions'
          );
        }
        if (ethers.BigNumber.from(dist.totalAmount).isZero()) {
          throw new PreconditionError(
            `Distribution ${distId} does not exist (the contract would revert DistributionNotFound).`,
            'List distributions with: pop treasury distributions'
          );
        }
        if (dist.finalized) {
          throw new PreconditionError(`Distribution ${distId} is already finalized.`);
        }

        const token = await resolvePayoutTokenInfo(ctx.provider, dist.payoutToken, ctx.chainId);
        tokenLabel = token.symbol;
        const unclaimed = ethers.BigNumber.from(dist.totalAmount).sub(dist.totalClaimed);
        unclaimedLabel = formatToken(unclaimed, token.decimals, token.symbol);

        // Anchor on the CHECKPOINT block — that is what the deployed contract uses.
        //
        // Audit M-08 proposes re-anchoring the claim window on the creation block
        // (`anchorBlock = creationBlock == 0 ? checkpointBlock : creationBlock`), but that
        // build is NOT deployed. Verified against live Gnosis PaymentManager
        // 0x409f51250dc5c66bb1d6952f947d841192f1140e, distribution 4
        // (checkpointBlock 45623101, subgraph createdAtBlock 45623935): an eth_call of
        // finalizeDistribution(4, N) with N chosen so checkpoint+N has passed but
        // creation+N has not returns 0x — NO revert — while an N that clears neither
        // returns 0x4dece07e (ClaimPeriodNotExpired). The gate is real and it is anchored
        // at checkpointBlock.
        //
        // Anchoring on createdAtBlock therefore warns about windows that have ALREADY
        // cleared and prints a clearance block ~800-1500 blocks too late. Since creation
        // >= checkpoint always, a future M-08 hub would make this warning fire slightly
        // early rather than wrongly — re-anchor here only once M-08 is actually deployed
        // (and gate it behind a version probe, since both builds will be live at once).
        if (minClaimBlocks > 0) {
          try {
            const currentBlock = await ctx.provider.getBlockNumber();
            const guardClearsAt = Number(dist.checkpointBlock) + minClaimBlocks;
            if (currentBlock < guardClearsAt) {
              output.warn(
                `Execution will revert ClaimPeriodNotExpired until block ${guardClearsAt} `
                + `(currently ${currentBlock}) — make sure the vote is executed after that.`
              );
            }
          } catch { /* best-effort warning only */ }
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      // Encode the executor-only call as the option-0 execution batch.
      const finalizeCall = PM_IFACE.encodeFunctionData('finalizeDistribution', [distId, minClaimBlocks]);
      const batches = [
        [[paymentManagerAddr, ethers.BigNumber.from(0), finalizeCall]], // option 0: finalize
        [], // option 1: keep open
      ];

      await confirmWrite(argv, {
        distribution: `#${distId}`,
        unclaimed: unclaimedLabel ? `${unclaimedLabel} returns to the Executor treasury` : undefined,
        minClaimBlocks: minClaimBlocks || 'none (vote duration is the claim window)',
        via: `HybridVoting proposal (${argv.duration} min vote)`,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'Propose finalizing distribution' });

      const title = `Finalize distribution #${distId}`;
      const metadata = {
        description: `Finalize distribution #${distId} via PaymentManager.finalizeDistribution(${distId}, ${minClaimBlocks}). `
          + `Blocks further claims and returns the unclaimed remainder${unclaimedLabel ? ` (${unclaimedLabel})` : ''} to the Executor treasury. `
          + `Payout token: ${tokenLabel}. Min claim period: ${minClaimBlocks} blocks from the checkpoint block.`,
        optionNames: [title, 'Keep the distribution open'],
        createdAt: Date.now(),
      };

      const txSpin = output.spinner('Pinning metadata + creating proposal...');
      txSpin.start();
      const cid = await pinJson(JSON.stringify(metadata));
      const descriptionHash = ipfsCidToBytes32(cid);
      const titleBytes = stringToBytes(title);

      const voting = createWriteContract(hybridVotingAddr, 'HybridVotingNew', ctx.signer);
      const result = await executeTx(
        voting,
        'createProposal',
        [titleBytes, descriptionHash, argv.duration, 2, batches, []],
        { dryRun: argv.dryRun }
      );
      txSpin.stop();

      const proposalEvent = result.logs?.find(l => l.name === 'NewProposal' || l.name === 'NewHatProposal');
      const proposalId = proposalEvent?.args?.id?.toString();

      finishWrite(result, {
        successMsg: proposalId !== undefined
          ? `Proposal #${proposalId} created — needs a vote to finalize distribution #${distId}`
          : `Proposal created — needs a vote to finalize distribution #${distId}`,
        fields: {
          proposalId,
          distributionId: distId,
          minClaimPeriodBlocks: minClaimBlocks,
          unclaimed: unclaimedLabel,
          duration: `${argv.duration} minutes`,
          ipfsCid: cid,
          nextStep: `pop vote cast --proposal ${proposalId ?? '<id>'} --choice 0`,
        },
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
