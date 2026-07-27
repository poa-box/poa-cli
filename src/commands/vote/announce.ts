/**
 * pop vote announce — announce a proposal winner (hybrid or dd).
 *
 * DESTRUCTIVE: announcing is irreversible and executes the winning option's
 * calls through the Executor. The confirm policy requires an explicit --yes
 * in non-interactive sessions.
 *
 * Safety layers, in order:
 *   1. callStatic.announceWinner probe (kept from the original; --force
 *      proceeds despite a failing probe, --no-preflight skips it)
 *   2. receipt log scan — the Executor catches failed sub-calls and emits
 *      CallFailed/ProposalExecutionFailed while the OUTER tx succeeds, so
 *      "tx mined" alone is not success
 *
 * --proposal accepts a numeric ID or a fuzzy title query.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { resolveProposalId, announceWinnerProbe, parseAnnounceReceipt } from './helpers';

interface AnnounceArgs {
  org: string;
  type: string;
  proposal: string;
  force?: boolean;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const announceHandler = {
  builder: (yargs: Argv) => yargs
    .option('type', { type: 'string', demandOption: true, choices: ['hybrid', 'dd'], describe: 'Voting type' })
    .option('proposal', { type: 'string', demandOption: true, describe: 'Proposal ID (number) or fuzzy title query' })
    .option('force', { type: 'boolean', default: false, describe: 'Skip pre-flight check and announce anyway' })
    .option('idempotency-key', { type: 'string', describe: 'Task #375 (HB#217) idempotency cache.' })
    .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache.' })
    .example('pop vote announce --type hybrid --proposal 12 --yes', 'Announce proposal #12 non-interactively (destructive — --yes required)'),

  handler: async (argv: ArgumentsCamelCase<AnnounceArgs>) => {
    const spin = output.spinner('Announcing winner...');
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

      const proposalId = await resolveProposalId(String(argv.proposal), contractAddr, argv.chain);

      const abiName = isHybrid ? 'HybridVotingNew' : 'DirectDemocracyVotingNew';
      const contract = createWriteContract(contractAddr, abiName, ctx.signer);

      // Pre-flight: callStatic catches execution failures before burning gas.
      // --force proceeds anyway; --no-preflight skips the probe entirely.
      if (argv.preflight !== false) {
        spin.text = 'Pre-flight check (callStatic)...';
        const probe = await announceWinnerProbe(contract, proposalId);
        if (!probe.ok) {
          spin.stop();
          output.error(
            `Pre-flight check FAILED — announcement would revert.\n` +
            `  Reason: ${probe.reason}\n` +
            `  Execution would fail on-chain. Common causes:\n` +
            `    - Executor drained by other proposals between creation and now\n` +
            `    - Bridge/oracle quote expired (for proposals with bridge calls)\n` +
            `    - Target contract paused or state changed\n` +
            `  Check current state: pop vote list\n` +
            `  Force anyway (not recommended): add --force`
          );
          if (!argv.force) {
            process.exit(EXIT.TX_FAILED);
          }
          spin.start();
          spin.text = 'Announcing despite pre-flight failure (--force)...';
        }
      }
      spin.stop();

      // DESTRUCTIVE: irreversibly finalizes the vote and executes the
      // winning option's calls. Non-TTY sessions must pass --yes.
      await confirmWrite(argv, {
        proposal: `#${proposalId}`,
        type: argv.type,
        action: 'announceWinner — finalizes the vote and executes the winning option\'s calls',
        org: argv.org,
        chain: ctx.networkName,
      }, { destructive: true, actionLabel: 'About to announce winner' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Announcing winner...');
        txSpin.start();
        // The 2M callGasLimit floor for execution batches (Curve+bridge style,
        // which silently fail at deep subcalls under the default 300K UserOp
        // callGasLimit) is applied inside src/lib/sponsored.ts — no per-call
        // opt-in needed here.
        const result = await executeTx(
          contract,
          'announceWinner',
          [proposalId],
          { dryRun: argv.dryRun }
        );
        txSpin.stop();

        // CRITICAL: check for inner execution failures. The Executor catches
        // failed sub-calls and emits CallFailed/ProposalExecutionFailed events
        // — the outer announceWinner tx still returns successfully. We check
        // the logs to detect this case, otherwise we'd report "success" on a
        // proposal that actually failed to execute.
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
            successMsg: `Winner announced for proposal #${proposalId}`,
            fields: {
              proposalId,
              winningOption: receipt.winningOption,
              valid: receipt.valid,
              executed: receipt.executed,
            },
          });
          return { proposal: proposalId, txHash: result.txHash, winningOption: receipt.winningOption };
        }

        finishWrite(result, {
          successMsg: `Winner announced for proposal #${proposalId}`,
          fields: { proposalId },
        });
        return { proposal: proposalId, txHash: result.txHash };
      };

      // Dry runs simulate unconditionally — no idempotency consult/record.
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'vote.announce', run);
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
