import { AUTHORITY_KEYS } from '@poa-box/core/tx/authority';
/**
 * pop token approve — approve a pending token request (MINTS new PT).
 *
 * Calls ParticipationToken.approveRequest(uint256 id) — VERIFIED against
 * contracts origin/main src/ParticipationToken.sol: onlyApprover (executor
 * or any allowed approver hat), reverts RequestUnknown / AlreadyApproved,
 * and NotRequester when the approver IS the requester (no self-approval).
 * Approval mints the requested amount straight to the requester and cannot
 * be undone — hence the DESTRUCTIVE confirmation gate.
 *
 * Pre-flight (skippable with --no-preflight) reads the request on-chain to
 * fail fast on every revert path, and checks the signer's approver hat.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { formatToken } from '../../lib/format';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance, PreflightCheck } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { readTokenGates, readTokenRequest, checkTokenPermission, TokenRequestOnChain } from './helpers';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface ApproveArgs {
  org?: string;
  request: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

export const approveHandler = {
  builder: (yargs: Argv) => yargs
    .option('request', { type: 'number', demandOption: true, describe: 'Request ID to approve' })
    .example('pop token approve --request 3', 'Mint the PT for request #3 to its requester')
    .example('pop token approve --request 3 --yes --json', 'Non-interactive approval (agents): --yes is required because approval mints irreversibly')
    .epilogue('Approvers only (executor or holders of PT_APPROVE permission); you cannot approve your own request. List pending requests with: pop token requests'),

  handler: async (argv: ArgumentsCamelCase<ApproveArgs>) => {
    const spin = output.spinner('Checking token request...');
    spin.start();

    try {
      if (!Number.isInteger(argv.request) || argv.request <= 0) {
        throw new CliError(`Invalid --request "${argv.request}".`, EXIT.USAGE, 'Pass the numeric request ID (pop token requests).');
      }

      const ctx = await getWriteContext(argv);
      const tokenAddress = requireModule(ctx.modules, 'participationTokenAddress');

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      // Mirror the contract's revert gates before any gas is spent.
      let request: TokenRequestOnChain | null = null;
      const checks: PreflightCheck[] = [checkGasBalance(ctx.address)];
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
            `Request ${argv.request} does not exist (or was cancelled) — the contract would revert RequestUnknown.`,
            'List requests with: pop token requests'
          );
        }
        if (request.approved) {
          throw new PreconditionError(`Request ${argv.request} is already approved — the tokens were minted.`);
        }
        if (request.requester.toLowerCase() === ctx.address.toLowerCase()) {
          throw new PreconditionError(
            'You cannot approve your own request (the contract reverts NotRequester).',
            'Ask another approver to run this command.'
          );
        }
        try {
          const gates = await readTokenGates(ctx.provider, tokenAddress);
          if (ctx.address.toLowerCase() !== gates.executor.toLowerCase()) {
            checks.push(checkTokenPermission(gates.authorityAddress, ctx.address, AUTHORITY_KEYS.PT_APPROVE));
          }
        } catch {
          // Gate reads failed — let the tx surface the real error.
        }
      }
      await runPreflight(ctx.provider, checks, { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        request: `#${argv.request}`,
        mint: request ? formatToken(request.amount, 18, 'PT') : undefined,
        requester: request?.requester,
        org: argv.org,
        chain: ctx.networkName,
      }, { destructive: true, actionLabel: 'About to APPROVE token request (mints new tokens, cannot be undone)' });

      const txSpin = output.spinner('Approving token request...');
      txSpin.start();
      const contract = createWriteContract(tokenAddress, 'ParticipationToken', ctx.signer);
      const result = await executeTx(contract, 'approveRequest', [argv.request], { dryRun: argv.dryRun });
      txSpin.stop();

      finishWrite(result, {
        successMsg: `Request #${argv.request} approved`,
        fields: {
          requestId: argv.request,
          minted: request ? formatToken(request.amount, 18, 'PT') : undefined,
          mintedWei: request?.amount.toString(),
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
