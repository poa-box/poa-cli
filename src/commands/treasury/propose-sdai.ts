/**
 * pop treasury propose-sdai — governance proposal to move idle treasury xDAI
 * into the sDAI savings vault for yield (Gnosis Chain only — the WXDAI/sDAI
 * addresses below are Gnosis mainnet deployments).
 *
 * Option 0 executes three calls from the Executor: wrap xDAI → WXDAI,
 * approve the sDAI vault, deposit. DESTRUCTIVE: puts a treasury allocation
 * on the ballot, so non-interactive runs must pass --yes explicitly.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32 } from '../../lib/encoding';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { formatToken } from '../../lib/format';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

const GNOSIS_CHAIN_ID = 100;
const WXDAI = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d';
const SDAI = '0xaf204776c7245bF4147c2612BF6e5972Ee483701';

const WXDAI_ABI = new ethers.utils.Interface([
  'function deposit() payable',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const SDAI_ABI = new ethers.utils.Interface([
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function balanceOf(address) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
]);

interface ProposeSdaiArgs {
  org: string;
  amount: number;
  duration: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

export const proposeSdaiHandler = {
  builder: (yargs: Argv) => yargs
    .option('amount', { type: 'number', demandOption: true, describe: 'xDAI amount to deposit into sDAI' })
    .option('duration', { type: 'number', default: 60, describe: 'Vote duration in minutes' })
    .example('pop treasury propose-sdai --amount 25', 'Propose moving 25 idle xDAI into sDAI for yield (60 min vote)')
    .epilogue('Gnosis Chain only. Withdrawing later needs another proposal (sDAI redeem via pop treasury send-style execution).'),

  handler: async (argv: ArgumentsCamelCase<ProposeSdaiArgs>) => {
    const spin = output.spinner('Creating sDAI deposit proposal...');
    spin.start();

    try {
      const amount = argv.amount as number;
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new CliError(`--amount must be a positive number, got "${argv.amount}".`, EXIT.USAGE);
      }

      const ctx = await getWriteContext(argv);
      if (ctx.chainId !== GNOSIS_CHAIN_ID) {
        throw new PreconditionError(
          `The sDAI strategy is Gnosis-only (WXDAI/sDAI addresses are Gnosis mainnet); current chain is ${ctx.networkName}.`,
          'Re-run with --chain 100.'
        );
      }
      const executorAddr = requireModule(ctx.modules, 'executorAddress');
      const hybridVotingAddr = ctx.modules.hybridVotingAddress;
      if (!hybridVotingAddr) {
        throw new PreconditionError('HybridVoting not deployed for this org — cannot create a governance proposal.');
      }

      const amountWei = ethers.utils.parseEther(amount.toString());

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      // The wrap call spends the Executor's native balance at execution time.
      const execBalance = await ctx.provider.getBalance(executorAddr);
      if (argv.preflight !== false && execBalance.lt(amountWei)) {
        throw new PreconditionError(
          `Executor holds ${formatToken(execBalance, 18, 'xDAI')} but the deposit needs ${amount} xDAI — execution would fail.`,
          'Lower --amount or fund the treasury first.'
        );
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });

      // Check current sDAI holdings (context for the confirm + metadata)
      const sdaiContract = new ethers.Contract(SDAI, SDAI_ABI.fragments, ctx.provider);
      const currentShares = await sdaiContract.balanceOf(executorAddr);
      const currentAssets = currentShares.gt(0) ? await sdaiContract.convertToAssets(currentShares) : ethers.BigNumber.from(0);
      spin.stop();

      await confirmWrite(argv, {
        amount: `${amount} xDAI → sDAI vault`,
        token: `sDAI ${SDAI}`,
        recipient: `Executor ${executorAddr} (receives the sDAI shares)`,
        currentSdai: `${formatToken(currentShares)} shares (${formatToken(currentAssets)} WXDAI equivalent)`,
        remainingLiquid: formatToken(execBalance.sub(amountWei), 18, 'xDAI'),
        via: `HybridVoting proposal (${argv.duration} min vote)`,
        org: argv.org,
        chain: ctx.networkName,
      }, { destructive: true, actionLabel: 'About to propose a TREASURY ALLOCATION into sDAI' });

      // Encode execution calls: wrap → approve → deposit
      const wrapCall = WXDAI_ABI.encodeFunctionData('deposit', []);
      const approveCall = WXDAI_ABI.encodeFunctionData('approve', [SDAI, amountWei]);
      const depositCall = SDAI_ABI.encodeFunctionData('deposit', [amountWei, executorAddr]);

      const option0Batch = [
        [WXDAI, amountWei, wrapCall],
        [WXDAI, ethers.BigNumber.from(0), approveCall],
        [SDAI, ethers.BigNumber.from(0), depositCall],
      ];
      const batches = [option0Batch, []];

      // Pin metadata
      const metadata = {
        description: `Deposit ${amount} xDAI into sDAI (${SDAI}) for yield. Three execution steps: wrap xDAI to WXDAI, approve WXDAI, deposit into sDAI vault. Current sDAI holdings: ${ethers.utils.formatEther(currentShares)} shares (${ethers.utils.formatEther(currentAssets)} WXDAI equivalent). Executor retains ${ethers.utils.formatEther(execBalance.sub(amountWei))} xDAI liquid.`,
        optionNames: [`Deposit ${amount} xDAI into sDAI`, 'Keep xDAI liquid'],
        createdAt: Date.now(),
      };

      const txSpin = output.spinner('Pinning metadata...');
      txSpin.start();
      const cid = await pinJson(JSON.stringify(metadata));
      const descriptionHash = ipfsCidToBytes32(cid);
      const titleBytes = stringToBytes(`Deposit ${amount} xDAI into sDAI for yield`);

      txSpin.text = 'Sending transaction...';
      const contract = createWriteContract(hybridVotingAddr, 'HybridVotingNew', ctx.signer);
      const result = await executeTx(
        contract,
        'createProposal',
        [titleBytes, descriptionHash, argv.duration, 2, batches, []],
        { dryRun: argv.dryRun }
      );
      txSpin.stop();

      const proposalEvent = result.logs?.find(l => l.name === 'NewProposal' || l.name === 'NewHatProposal');
      const proposalId = proposalEvent?.args?.id?.toString();

      finishWrite(result, {
        successMsg: 'sDAI deposit proposal created',
        fields: {
          proposalId,
          amount: `${amount} xDAI`,
          currentSdai: `${ethers.utils.formatEther(currentShares)} shares`,
          currentValue: `${ethers.utils.formatEther(currentAssets)} WXDAI`,
          remainingLiquid: `${ethers.utils.formatEther(execBalance.sub(amountWei))} xDAI`,
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
