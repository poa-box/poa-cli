/**
 * pop token cancel — cancel a pending (unapproved) token request.
 *
 * Calls ParticipationToken.cancelRequest(uint256 id) — VERIFIED against
 * contracts origin/main src/ParticipationToken.sol: callable by the
 * REQUESTER or any APPROVER (executor / approver-hat wearer); reverts
 * RequestUnknown for missing ids, AlreadyApproved once minted, and
 * NotApprover for everyone else. Pre-flight mirrors those gates.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { formatToken } from '../../lib/format';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { readTokenRequest, TokenRequestOnChain } from './helpers';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface CancelArgs {
  org?: string;
  request: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

export const cancelHandler = {
  builder: (yargs: Argv) => yargs
    .option('request', { type: 'number', demandOption: true, describe: 'Request ID to cancel' })
    .example('pop token cancel --request 3', 'Withdraw pending request #3 (requester or any approver)'),

  handler: async (argv: ArgumentsCamelCase<CancelArgs>) => {
    const spin = output.spinner('Checking token request...');
    spin.start();

    try {
      if (!Number.isInteger(argv.request) || argv.request <= 0) {
        throw new CliError(`Invalid --request "${argv.request}".`, EXIT.USAGE, 'Pass the numeric request ID (pop token requests).');
      }

      const ctx = await getWriteContext(argv);
      const tokenAddress = requireModule(ctx.modules, 'participationTokenAddress');

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      let request: TokenRequestOnChain | null = null;
      if (argv.preflight !== false) {
        try {
          request = await readTokenRequest(ctx.provider, tokenAddress, argv.request);
        } catch {
          throw new PreconditionError(
            `Could not read request ${argv.request} on-chain.`,
            'List requests with: pop token requests'
          );
        }
        if (!request.exists) {
          throw new PreconditionError(
            `Request ${argv.request} does not exist (or was already cancelled) — the contract would revert RequestUnknown.`,
            'List requests with: pop token requests'
          );
        }
        if (request.approved) {
          throw new PreconditionError(
            `Request ${argv.request} is already approved — the tokens were minted, so it can no longer be cancelled.`
          );
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        request: `#${argv.request}`,
        amount: request ? formatToken(request.amount, 18, 'PT') : undefined,
        requester: request?.requester,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to cancel token request' });

      const txSpin = output.spinner('Cancelling token request...');
      txSpin.start();
      const contract = createWriteContract(tokenAddress, 'ParticipationToken', ctx.signer);
      const result = await executeTx(contract, 'cancelRequest', [argv.request], { dryRun: argv.dryRun });
      txSpin.stop();

      finishWrite(result, {
        successMsg: `Request #${argv.request} cancelled`,
        fields: {
          requestId: argv.request,
          amount: request ? formatToken(request.amount, 18, 'PT') : undefined,
          requester: request?.requester,
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
