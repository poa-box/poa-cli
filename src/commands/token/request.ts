/**
 * pop token request — request participation tokens (PT) from the org.
 *
 * Calls ParticipationToken.requestTokens(uint96 amount, string ipfsHash) —
 * VERIFIED against contracts origin/main src/ParticipationToken.sol: the
 * function is isMember-gated (the caller must be the executor or wear one of
 * the allowed member hats) and reverts ZeroAmount on amount == 0 or an empty
 * ipfsHash. Minting happens later, when an approver runs pop token approve.
 *
 * Pre-flight (skippable with --no-preflight) resolves the member hat set
 * from the token contract (memberHatIds()) and fails fast when the signer
 * wears none of them.
 *
 * The IPFS reason metadata key order ({reason, submittedAt}) matches the
 * frontend exactly — do not reorder.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance, PreflightCheck } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { readTokenGates, checkWearsAnyHat } from './helpers';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface RequestArgs {
  org?: string;
  amount: number;
  reason: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

const UINT96_MAX = ethers.BigNumber.from(2).pow(96).sub(1);

/** Parse --amount to 18-decimal wei, enforcing the contract's uint96 bound. */
export function parseRequestAmount(amount: number | string): ethers.BigNumber {
  let wei: ethers.BigNumber;
  try {
    wei = ethers.utils.parseUnits(String(amount), 18);
  } catch {
    throw new CliError(`Invalid --amount "${amount}".`, EXIT.USAGE, 'Pass a decimal PT amount, e.g. --amount 12.5');
  }
  if (wei.lte(0)) {
    throw new CliError('--amount must be greater than zero (the contract reverts ZeroAmount).', EXIT.USAGE);
  }
  if (wei.gt(UINT96_MAX)) {
    throw new CliError(`--amount overflows the contract's uint96 amount field.`, EXIT.USAGE, 'Request a smaller amount.');
  }
  return wei;
}

export const requestHandler = {
  builder: (yargs: Argv) => yargs
    .option('amount', { type: 'number', demandOption: true, describe: 'Amount of PT to request' })
    .option('reason', { type: 'string', demandOption: true, describe: 'Reason for the request (pinned to IPFS)' })
    .example('pop token request --amount 10 --reason "Facilitated the weekly sync"', 'Request 10 PT — mints once an approver approves')
    .epilogue('Members-only on-chain. Track it with pop token requests; an approver mints it via pop token approve.'),

  handler: async (argv: ArgumentsCamelCase<RequestArgs>) => {
    const spin = output.spinner('Preparing token request...');
    spin.start();

    try {
      const amountWei = parseRequestAmount(argv.amount);
      if (!argv.reason || !String(argv.reason).trim()) {
        throw new CliError('--reason cannot be empty (the contract requires a non-empty ipfsHash).', EXIT.USAGE);
      }

      const ctx = await getWriteContext(argv);
      const tokenAddress = requireModule(ctx.modules, 'participationTokenAddress');

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      // requestTokens is isMember-gated: executor OR any allowed member hat.
      const checks: PreflightCheck[] = [checkGasBalance(ctx.address)];
      if (argv.preflight !== false) {
        try {
          const gates = await readTokenGates(ctx.provider, tokenAddress);
          if (ctx.address.toLowerCase() !== gates.executor.toLowerCase()) {
            if (gates.memberHatIds.length === 0) {
              throw new PreconditionError(
                'No member hats are configured on the participation token — only the executor can request tokens, and your signer is not it.',
                'Ask governance to allow a member hat (setMemberHatAllowed).'
              );
            }
            checks.push(checkWearsAnyHat(ctx.provider, gates.hatsAddress, ctx.address, gates.memberHatIds, {
              label: 'org membership (member hat)',
              detail: `${ctx.address} wears none of the token's member hats — requestTokens would revert NotMember`,
              suggestion: 'join the org first: pop user join',
            }));
          }
        } catch (err) {
          if (err instanceof PreconditionError) throw err;
          // Gate reads failed (RPC hiccup) — let the tx surface the real error.
        }
      }
      await runPreflight(ctx.provider, checks, { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        request: `${argv.amount} PT`,
        reason: argv.reason,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to submit a token request' });

      // Upload reason metadata to IPFS (matches frontend pattern — key order matters)
      const metadata = { reason: argv.reason, submittedAt: Date.now() };
      const txSpin = output.spinner('Pinning request metadata to IPFS...');
      txSpin.start();
      const cid = await pinJson(JSON.stringify(metadata));

      // requestTokens expects (uint96 amount, string ipfsHash)
      // Amount in 18 decimals, ipfsHash is the CID string (not bytes32)
      txSpin.text = 'Sending transaction...';
      const contract = createWriteContract(tokenAddress, 'ParticipationToken', ctx.signer);
      const result = await executeTx(contract, 'requestTokens', [amountWei, cid], { dryRun: argv.dryRun });
      txSpin.stop();

      const requestEvent = result.logs?.find(l => l.name === 'Requested');
      const requestId = requestEvent?.args?.id?.toString();

      finishWrite(result, {
        successMsg: 'Token request submitted',
        fields: {
          requestId,
          amount: `${argv.amount} PT`,
          amountWei: amountWei.toString(),
          ipfsCid: cid,
          nextStep: `an approver mints it with: pop token approve --request ${requestId ?? '<id>'}`,
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
