/**
 * pop vote execute — finalize an ended proposal (announceWinner).
 *
 * Finalize an ended proposal by calling HybridVoting.announceWinner.
 * This is the one canonical path: announceWinner both announces the winner
 * and executes the winning option's calls through the Executor. The Executor
 * is gated to `allowedCaller()` (HybridVoting), so there is no way to execute
 * proposal calls by calling the Executor directly.
 *
 * Relationship to other commands:
 *   - `pop vote announce-all` — batch-announces all ended proposals (preferred)
 *   - `pop vote announce` — announces one (alias of this command)
 *   - `pop vote execute` — this command, kept for symmetry with the docs
 *
 * DESTRUCTIVE: announcing is irreversible and executes on-chain calls. The
 * confirm policy requires an explicit --yes in non-interactive sessions.
 *
 * Safety layers, in order:
 *   1. subgraph state gate (already executed / failed / still active)
 *   2. callStatic.announceWinner probe (skippable with --no-preflight) —
 *      catches would-revert BEFORE gas is burned
 *   3. receipt log scan — the Executor catches failed sub-calls and emits
 *      CallFailed/ProposalExecutionFailed while the OUTER tx succeeds, so
 *      "tx mined" alone is not success
 *
 * A proposal announced whose execution REVERTED (executionFailed=true) is retryable
 * since audit H-05: the contract releases the in-flight `executed` lock in its catch
 * branch, so re-running announceWinner replays the batch. This command warns and then
 * lets the callStatic pre-flight decide, which keeps it correct against both the
 * upgraded and the pre-audit contracts.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { query } from '../../lib/subgraph';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { resolveProposalId, announceWinnerProbe, parseAnnounceReceipt } from './helpers';

interface ExecuteArgs {
  org: string;
  proposal: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const executeHandler = {
  builder: (yargs: Argv) => yargs
    .option('proposal', { type: 'string', demandOption: true, describe: 'Proposal ID (number) or fuzzy title query' })
    .option('idempotency-key', { type: 'string', describe: 'Task #375 (HB#217) idempotency cache.' })
    .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache.' })
    .example('pop vote execute --proposal 12 --yes', 'Finalize proposal #12 non-interactively (destructive — --yes required)'),

  handler: async (argv: ArgumentsCamelCase<ExecuteArgs>) => {
    const spin = output.spinner('Checking proposal state...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);
      const hybridVotingAddress = ctx.modules?.hybridVotingAddress;
      if (!hybridVotingAddress) {
        throw new CliError('No HybridVoting contract found for this org', EXIT.PRECONDITION);
      }

      const proposalId = await resolveProposalId(String(argv.proposal), hybridVotingAddress, argv.chain);

      // Check proposal state via subgraph
      const proposalResult = await query<any>(`
        query GetProposal($votingId: String!, $proposalId: String!) {
          proposals(where: { hybridVoting: $votingId, proposalId: $proposalId }, first: 1) {
            proposalId
            status
            winningOption
            wasExecuted
            executionFailed
            isValid
            winnerAnnouncedAt
          }
        }
      `, {
        votingId: hybridVotingAddress,
        proposalId: proposalId.toString(),
      }, argv.chain);

      const proposal = proposalResult.proposals?.[0];
      if (!proposal) {
        throw new CliError(`Proposal #${proposalId} not found`, EXIT.USAGE, 'List proposals with: pop vote list');
      }

      if (proposal.wasExecuted) {
        spin.stop();
        output.info(`Proposal #${proposalId} was already executed`);
        return;
      }

      if (proposal.executionFailed) {
        // NOT terminal. Audit H-05 (contracts #185) resets `p.executed = false` in the catch
        // branch specifically "so this finalize can be retried once the revert cause is fixed"
        // (HybridVotingCore._announceWinner; DirectDemocracyVoting._finalize only sets executed
        // inside the successful try). Re-running announceWinner IS the intended fix path.
        //
        // Deliberately not version-gated: the callStatic probe below is the arbiter. On a
        // pre-#185 contract the retry reverts AlreadyExecuted and the probe reports that
        // cleanly; on #185 it proceeds. Blocking here would deny the retry on both.
        output.warn(
          `Proposal #${proposalId} was announced but its execution reverted on-chain. `
          + 'Since the security audit this is RETRYABLE — fix the cause (target paused, quote '
          + 'expired, executor underfunded) and re-run this command. On an older deployment the '
          + 'pre-flight below will report AlreadyExecuted, and a new proposal is the only route.'
        );
      }

      if (proposal.winnerAnnouncedAt) {
        spin.stop();
        output.info(
          `Proposal #${proposalId} winner is already announced (valid=${proposal.isValid}). ` +
          `Nothing to do.`
        );
        return;
      }

      if (proposal.status !== 'Ended') {
        throw new CliError(
          `Proposal #${proposalId} is still ${proposal.status} — must be Ended to finalize`,
          EXIT.PRECONDITION
        );
      }

      const contract = createWriteContract(hybridVotingAddress, 'HybridVotingNew', ctx.signer);

      // Pre-flight: callStatic catches announce reverts before burning gas
      // (skippable with --no-preflight).
      if (argv.preflight !== false) {
        spin.text = 'Pre-flight check (callStatic)...';
        const probe = await announceWinnerProbe(contract, proposalId);
        if (!probe.ok) {
          spin.stop();
          output.error(
            `Pre-flight check FAILED — announceWinner would revert.\n` +
            `  Reason: ${probe.reason}\n` +
            `  Check current state with: pop vote list\n` +
            `  Skip this check (not recommended): add --no-preflight`
          );
          process.exit(EXIT.TX_FAILED);
          return;
        }
      }
      spin.stop();

      // DESTRUCTIVE: irreversibly finalizes the vote and executes the
      // winning option's calls. Non-TTY sessions must pass --yes.
      await confirmWrite(argv, {
        proposal: `#${proposalId}`,
        action: 'announceWinner — finalizes the vote and executes the winning option\'s calls',
        org: argv.org,
        chain: ctx.networkName,
      }, { destructive: true, actionLabel: 'About to finalize proposal' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Announcing winner (this also executes calls)...');
        txSpin.start();
        const result = await executeTx(
          contract,
          'announceWinner',
          [proposalId],
          { dryRun: argv.dryRun }
        );
        txSpin.stop();

        // Inner-failure scan: the Executor swallows failed sub-calls, so the
        // outer tx can succeed while the proposal's calls reverted.
        if (result.success && !result.dryRun) {
          const receipt = parseAnnounceReceipt(result);
          if (receipt.innerFailure) {
            output.error(`Proposal #${proposalId} ANNOUNCED but EXECUTION FAILED`, {
              txHash: result.txHash,
              explorerUrl: result.explorerUrl,
              winningOption: receipt.winningOption,
              failedCalls: receipt.failedCalls,
              note: 'The proposal was finalized but inner execution reverted. ' +
                'Gas was burned. Diagnose by inspecting the CallFailed events in the tx, ' +
                'fix the issue, and create a new proposal. The old one cannot be re-executed.',
            });
            process.exit(EXIT.TX_FAILED);
          }
          finishWrite(result, {
            successMsg: `Proposal #${proposalId} finalized`,
            fields: {
              proposalId,
              winningOption: receipt.winningOption,
              valid: receipt.valid,
              executed: receipt.executed,
            },
          });
          return { proposal: proposalId, txHash: result.txHash };
        }

        finishWrite(result, {
          successMsg: `Proposal #${proposalId} finalized`,
          fields: { proposalId },
        });
        return { proposal: proposalId, txHash: result.txHash };
      };

      // Dry runs simulate unconditionally — no idempotency consult/record.
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'vote.execute', run);
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
