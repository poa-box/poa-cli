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
import { prepareExactRecipients, planTreasuryTransfer } from '@poa-box/core/treasury/planning';
import { readTreasuryPlanningState, treasuryAvailability } from '../../lib/treasury-planning';
import { resolvePayoutTokenInfo } from './helpers';
import type { SourceSnapshot } from '@poa-box/core/data/facts';
import type { RawAssetAmount } from '@poa-box/core/amounts';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinWriteMetadata } from '../../lib/write-metadata';
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
  amount?: number | string;
  recipients?: string;
  token: string;
  duration: number;
  source?: 'executor' | 'payment-manager';
  maxRounds?: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

/** Parse --to/--amount or --recipients into a validated recipient list (max 8). */
export function parseRecipients(argv: Pick<SendArgs, 'to' | 'amount' | 'recipients'>): Array<{ to: string; amount: number | string }> {
  let recipientList: Array<{ to: string; amount: number | string }>;
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
    const amount = r.amount;
    if (!['string', 'number'].includes(typeof amount) || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(amount)) || !/[1-9]/.test(String(amount))) {
      throw new CliError(`Recipient ${to}: amount must be a positive number, got "${r.amount}".`, EXIT.USAGE);
    }
    return { to, amount };
  });
}

export const sendHandler = {
  builder: (yargs: Argv) => yargs
    .option('to', { type: 'string', describe: 'Recipient address (single recipient)' })
    .option('amount', { type: 'string', describe: 'Amount to send (single recipient)' })
    .option('recipients', { type: 'string', describe: 'JSON array for batch: [{"to":"0x...","amount":5},...] (max 8)' })
    .option('token', { type: 'string', default: 'native', describe: 'Token address or "native" for the chain\'s gas token' })
    .option('source', { type: 'string', choices: ['executor', 'payment-manager'], default: 'executor', describe: 'Explicit treasury source; PaymentManager reservations are enforced' })
    .option('max-rounds', { type: 'number', default: 1000, describe: 'Maximum distribution enumeration for PaymentManager solvency' })
    .option('duration', { type: 'number', default: 60, describe: 'Vote duration in minutes' })
    .example('pop treasury send --to 0xAbc... --amount 5', 'Propose sending 5 xDAI from the Executor (60 min vote)')
    .example('pop treasury send --recipients \'[{"to":"0xA...","amount":5},{"to":"0xB...","amount":3}]\' --token 0xToken...', 'Batch ERC20 transfer proposal')
    .epilogue('Funds move only if the vote passes; option 0 executes the transfers, option 1 does nothing.'),

  handler: async (argv: ArgumentsCamelCase<SendArgs>) => {
    const spin = output.spinner('Creating transfer proposal...');
    spin.start();

    try {
      if (!Number.isSafeInteger(argv.duration) || argv.duration <= 0) throw new CliError('Vote duration must be a positive integer number of minutes.', EXIT.USAGE);
      const isNative = argv.token === 'native';
      const tokenAddr = isNative ? null : requireAddress(argv.token, 'token');
      const recipientList = parseRecipients(argv);

      const ctx = await getWriteContext(argv);
      const hybridVotingAddr = ctx.modules.hybridVotingAddress;
      if (!hybridVotingAddr) {
        throw new PreconditionError('HybridVoting not deployed for this org — cannot create a governance proposal.');
      }

      const tokenInfo = await resolvePayoutTokenInfo(ctx.provider, tokenAddr ?? ethers.constants.AddressZero, ctx.chainId);
      const tokenLabel = tokenInfo.symbol;
      const decimals = tokenInfo.decimals;
      const asset = { chainId: ctx.chainId, address: tokenAddr ?? ethers.constants.AddressZero, decimals };
      const exact = prepareExactRecipients(recipientList.map(r => ({ to: r.to, amount: String(r.amount) })), decimals);
      const totalRaw = exact.reduce((sum, r) => sum.add(r.amountRaw), ethers.BigNumber.from(0));
      const totalAmount = ethers.utils.formatUnits(totalRaw, decimals).replace(/\.0$/, '');
      const sourceKind = argv.source ?? 'executor';
      const sourceAddress = sourceKind === 'executor' ? ctx.modules.executorAddress : ctx.modules.paymentManagerAddress;
      if (!sourceAddress) throw new PreconditionError(`The ${sourceKind} treasury source is not installed.`);
      const contracts = { ...(ctx.modules.executorAddress ? { executor: ctx.modules.executorAddress } : {}),
        ...(ctx.modules.paymentManagerAddress ? { paymentManager: ctx.modules.paymentManagerAddress } : {}) };
      const calls: Array<[string, ethers.BigNumber, string]> = [];
      let paymentSnapshot;
      let executorBalance: SourceSnapshot<RawAssetAmount> | undefined;
      let block;
      if (sourceKind === 'payment-manager') {
        paymentSnapshot = await readTreasuryPlanningState({ provider: ctx.provider, chainId: ctx.chainId, orgId: ctx.orgId,
          paymentManager: sourceAddress, asset, maxRounds: argv.maxRounds });
        block = paymentSnapshot.source.block!;
        const available = treasuryAvailability(paymentSnapshot);
        if (available.status !== 'ready') throw new PreconditionError(`Treasury evidence is incomplete: ${available.codes.join(', ')}`);
        if (totalRaw.gt(available.data.spendableRaw)) throw new PreconditionError('The transfer exceeds PaymentManager spendable funds after existing reservations.');
      } else {
        if ((await ctx.provider.getNetwork()).chainId !== ctx.chainId) throw new PreconditionError('RPC chain mismatch');
        const observed = await ctx.provider.getBlock('latest');
        block = { number: String(observed.number), hash: observed.hash, timestamp: String(observed.timestamp) };
        const balance = isNative ? await ctx.provider.getBalance(sourceAddress, observed.number)
          : await new ethers.Contract(tokenAddr!, ['function balanceOf(address) view returns(uint256)'], ctx.provider).balanceOf(sourceAddress, { blockTag: observed.number });
        if (totalRaw.gt(balance)) throw new PreconditionError('The transfer exceeds the Executor balance.');
        executorBalance = { source: { chainId: ctx.chainId, orgId: ctx.orgId, contract: sourceAddress, contracts,
          endpoint: `rpc:${ctx.chainId}`, method: 'eth_call', indexed: false, snapshot: 'pinned', block }, data: { asset, rawAmount: balance.toString() },
          coverage: { status: 'complete', receivedKeys: ['balance'], missingIds: [], failedIds: [], issues: [] } };
        if ((await ctx.provider.getBlock(observed.number)).hash !== observed.hash) throw new PreconditionError('RPC snapshot changed');
      }
      for (const recipient of exact) {
        const plan = planTreasuryTransfer({ scope: { chainId: ctx.chainId, orgId: ctx.orgId, contracts }, block,
          asset, destination: recipient.to, amountRaw: recipient.amountRaw, minClaimPeriodBlocks: '0',
          sources: sourceKind === 'executor' ? [{ kind: 'executor', address: sourceAddress, balance: executorBalance! }]
            : [{ kind: 'payment-manager', address: sourceAddress, snapshot: paymentSnapshot! }] });
        if (plan.status !== 'ready') throw new PreconditionError(`Transfer plan blocked: ${plan.codes.join(', ')}`);
        calls.push(...plan.data.calls.map(c => [c.target, ethers.BigNumber.from(c.value), c.calldata] as [string, ethers.BigNumber, string]));
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
        description: `Transfer ${totalAmount} ${tokenLabel} from ${sourceKind}: ${recipientSummary}. ${recipientList.length} recipient(s).`,
        optionNames: [`Send ${totalAmount} ${tokenLabel} (${recipientList.length} recipients)`, 'Do not send'],
        createdAt: Date.now(),
      };

      const txSpin = output.spinner('Pinning metadata + creating proposal...');
      txSpin.start();
      const cid = await pinWriteMetadata(JSON.stringify(proposalMeta), argv.dryRun);
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
          totalAmountWei: totalRaw.toString(),
          source: sourceKind,
          sourceAddress,
          planningBlock: block,
          revalidateBeforeExecution: true,
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
