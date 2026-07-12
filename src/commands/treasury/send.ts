/**
 * pop treasury send — governance proposal to transfer treasury funds.
 *
 * Wraps native-value transfers (or ERC20.transfer calls) from the Executor in
 * a HybridVoting proposal: option 0 executes the transfer batch, option 1 is
 * a no-op. Nothing moves unless the vote passes — but the proposal itself is
 * treated as DESTRUCTIVE (it puts a treasury spend on the ballot), so
 * non-interactive runs must pass --yes explicitly.
 *
 * The Executor supports at most 8 calls per option batch, capping batch sends
 * at 8 recipients per proposal.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32 } from '../../lib/encoding';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireAddress } from '../../lib/validation';
import { getTokenDecimals } from '../../config/tokens';
import { getNetworkByChainId } from '../../config/networks';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface SendArgs {
  org: string;
  to?: string;
  amount?: number;
  recipients?: string;
  token: string;
  duration: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

/** Parse --to/--amount or --recipients into a validated recipient list (max 8). */
export function parseRecipients(argv: Pick<SendArgs, 'to' | 'amount' | 'recipients'>): Array<{ to: string; amount: number }> {
  let recipientList: Array<{ to: string; amount: number }>;
  if (argv.recipients) {
    try {
      recipientList = JSON.parse(argv.recipients);
      if (!Array.isArray(recipientList) || recipientList.length === 0) throw new Error('empty array');
    } catch (e: any) {
      throw new CliError(
        `--recipients must be a JSON array: [{"to":"0x...","amount":5},...]. ${e.message}`,
        EXIT.USAGE
      );
    }
    if (recipientList.length > 8) {
      throw new CliError('The Executor supports at most 8 calls per batch — split into multiple proposals.', EXIT.USAGE);
    }
  } else if (argv.to && argv.amount) {
    recipientList = [{ to: argv.to, amount: argv.amount }];
  } else {
    throw new CliError('Provide either --to + --amount, or --recipients for a batch send.', EXIT.USAGE);
  }

  return recipientList.map((r, i) => {
    const to = requireAddress(r.to, `recipients[${i}].to`);
    const amount = Number(r.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new CliError(`Recipient ${to}: amount must be a positive number, got "${r.amount}".`, EXIT.USAGE);
    }
    return { to, amount };
  });
}

export const sendHandler = {
  builder: (yargs: Argv) => yargs
    .option('to', { type: 'string', describe: 'Recipient address (single recipient)' })
    .option('amount', { type: 'number', describe: 'Amount to send (single recipient)' })
    .option('recipients', { type: 'string', describe: 'JSON array for batch: [{"to":"0x...","amount":5},...] (max 8)' })
    .option('token', { type: 'string', default: 'native', describe: 'Token address or "native" for the chain\'s gas token' })
    .option('duration', { type: 'number', default: 60, describe: 'Vote duration in minutes' })
    .example('pop treasury send --to 0xAbc... --amount 5', 'Propose sending 5 xDAI from the Executor (60 min vote)')
    .example('pop treasury send --recipients \'[{"to":"0xA...","amount":5},{"to":"0xB...","amount":3}]\' --token 0xToken...', 'Batch ERC20 transfer proposal')
    .epilogue('Funds move only if the vote passes; option 0 executes the transfers, option 1 does nothing.'),

  handler: async (argv: ArgumentsCamelCase<SendArgs>) => {
    const spin = output.spinner('Creating transfer proposal...');
    spin.start();

    try {
      const isNative = argv.token === 'native';
      const tokenAddr = isNative ? null : requireAddress(argv.token, 'token');
      const recipientList = parseRecipients(argv);

      const ctx = await getWriteContext(argv);
      const hybridVotingAddr = ctx.modules.hybridVotingAddress;
      if (!hybridVotingAddr) {
        throw new PreconditionError('HybridVoting not deployed for this org — cannot create a governance proposal.');
      }

      const tokenLabel = isNative
        ? (getNetworkByChainId(ctx.chainId)?.nativeCurrency?.symbol ?? 'native')
        : (tokenAddr as string);
      const decimals = isNative ? 18 : getTokenDecimals(tokenAddr as string);

      // Encode calls for each recipient
      const calls: Array<[string, ethers.BigNumber, string]> = [];
      let totalAmount = 0;
      for (const r of recipientList) {
        const amountWei = ethers.utils.parseUnits(r.amount.toString(), decimals);
        totalAmount += r.amount;
        if (isNative) {
          calls.push([r.to, amountWei, '0x']);
        } else {
          const iface = new ethers.utils.Interface(ERC20_ABI);
          const transferData = iface.encodeFunctionData('transfer', [r.to, amountWei]);
          calls.push([tokenAddr as string, ethers.BigNumber.from(0), transferData]);
        }
      }

      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        amount: `${totalAmount} ${tokenLabel}`,
        token: isNative ? 'native' : tokenAddr as string,
        recipients: recipientList.map(r => `${r.amount} → ${r.to}`).join(', '),
        via: `HybridVoting proposal (${argv.duration} min vote)`,
        org: argv.org,
        chain: ctx.networkName,
      }, { destructive: true, actionLabel: 'About to propose a TREASURY TRANSFER' });

      const recipientSummary = recipientList.map(r => `${r.amount} ${tokenLabel} → ${r.to.slice(0, 10)}...`).join(', ');
      const proposalMeta = {
        description: `Transfer ${totalAmount} ${tokenLabel} from Executor: ${recipientSummary}. ${recipientList.length} recipient(s).`,
        optionNames: [`Send ${totalAmount} ${tokenLabel} (${recipientList.length} recipients)`, 'Do not send'],
        createdAt: Date.now(),
      };

      const txSpin = output.spinner('Pinning metadata + creating proposal...');
      txSpin.start();
      const cid = await pinJson(JSON.stringify(proposalMeta));
      const descriptionHash = ipfsCidToBytes32(cid);
      const title = stringToBytes(`Send ${totalAmount} ${tokenLabel} to ${recipientList.length} recipient(s)`);

      const batches = [calls, []];

      const contract = createWriteContract(hybridVotingAddr, 'HybridVotingNew', ctx.signer);
      const result = await executeTx(
        contract,
        'createProposal',
        [title, descriptionHash, argv.duration, 2, batches, []],
        { dryRun: argv.dryRun }
      );
      txSpin.stop();

      const proposalEvent = result.logs?.find(l => l.name === 'NewProposal' || l.name === 'NewHatProposal');
      const proposalId = proposalEvent?.args?.id?.toString();

      finishWrite(result, {
        successMsg: 'Transfer proposal created',
        fields: {
          proposalId,
          totalAmount: totalAmount.toString(),
          token: tokenLabel,
          recipients: recipientList.length,
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
