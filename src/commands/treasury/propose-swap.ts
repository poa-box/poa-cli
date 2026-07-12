/**
 * pop treasury propose-swap — governance proposal for a treasury token swap
 * through a Curve-style pool.
 *
 * Option 0 executes three calls: PaymentManager.withdraw(token → Executor),
 * ERC20.approve(pool), pool.exchange(i, j, dx, min_dy). withdraw is
 * executor-only on-chain (verified against contracts origin/main
 * src/PaymentManager.sol), hence the governance wrap. DESTRUCTIVE: puts a
 * treasury swap on the ballot, so non-interactive runs must pass --yes.
 *
 * Amount decimals: --amount uses the from-token's decimals, --min-out the
 * to-token's (known-token table, 18 as default). When --min-out is omitted
 * the default is 95% of the pool quote (falling back to 95% of the input
 * when the quote is unavailable).
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
import { requireAddress } from '../../lib/validation';
import { getTokenDecimals } from '../../config/tokens';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface ProposeSwapArgs {
  org: string;
  'from-token': string;
  'to-token': string;
  amount: number;
  'min-out'?: number;
  'pool': string;
  'from-index': number;
  'to-index': number;
  duration: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

const ERC20_ABI = ['function approve(address spender, uint256 amount) returns (bool)'];
const CURVE_ABI = ['function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)'];

export const proposeSwapHandler = {
  builder: (yargs: Argv) => yargs
    .option('from-token', { type: 'string', demandOption: true, describe: 'Token to sell (address)' })
    .option('to-token', { type: 'string', demandOption: true, describe: 'Token to receive (address)' })
    .option('amount', { type: 'number', demandOption: true, describe: 'Amount to swap (human units of from-token)' })
    .option('min-out', { type: 'number', describe: 'Minimum output amount in to-token units (default: 95% of the pool quote)' })
    .option('pool', { type: 'string', demandOption: true, describe: 'Curve pool address' })
    .option('from-index', { type: 'number', demandOption: true, describe: 'Curve coin index for from-token (0 or 1)' })
    .option('to-index', { type: 'number', demandOption: true, describe: 'Curve coin index for to-token (0 or 1)' })
    .option('duration', { type: 'number', default: 1440, describe: 'Vote duration in minutes' })
    .example('pop treasury propose-swap --from-token 0xA... --to-token 0xB... --amount 100 --pool 0xPool... --from-index 0 --to-index 1', 'Propose swapping 100 tokens via Curve (24h vote)')
    .epilogue('Executes withdraw → approve → exchange from the Executor if the vote passes; min_dy protects against slippage at execution time.'),

  handler: async (argv: ArgumentsCamelCase<ProposeSwapArgs>) => {
    const spin = output.spinner('Creating swap proposal...');
    spin.start();

    try {
      if (!Number.isFinite(argv.amount) || argv.amount <= 0) {
        throw new CliError(`--amount must be a positive number, got "${argv.amount}".`, EXIT.USAGE);
      }
      const fromToken = requireAddress(argv.fromToken as string, 'from-token');
      const toToken = requireAddress(argv.toToken as string, 'to-token');
      const poolAddr = requireAddress(argv.pool as string, 'pool');

      const ctx = await getWriteContext(argv);
      const executorAddr = requireModule(ctx.modules, 'executorAddress');
      const pmAddr = requireModule(ctx.modules, 'paymentManagerAddress');
      const hybridVotingAddr = ctx.modules.hybridVotingAddress;
      if (!hybridVotingAddr) {
        throw new PreconditionError('HybridVoting not deployed for this org — cannot create a governance proposal.');
      }

      const fromDecimals = getTokenDecimals(fromToken);
      const toDecimals = getTokenDecimals(toToken);
      const amountWei = ethers.utils.parseUnits(argv.amount.toString(), fromDecimals);

      // Get a quote from the pool
      spin.text = 'Getting swap quote...';
      const poolContract = new ethers.Contract(poolAddr, [
        'function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)',
      ], ctx.provider);

      let expectedOut: ethers.BigNumber | null = null;
      try {
        expectedOut = await poolContract.get_dy(argv.fromIndex, argv.toIndex, amountWei);
      } catch {
        expectedOut = null; // quote unavailable — fall back below
      }

      const minOut = argv.minOut !== undefined
        ? ethers.utils.parseUnits(argv.minOut.toString(), toDecimals)
        : (expectedOut ?? amountWei).mul(95).div(100); // 5% slippage default

      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      const expectedLabel = expectedOut ? ethers.utils.formatUnits(expectedOut, toDecimals) : 'unavailable';

      await confirmWrite(argv, {
        amount: `${argv.amount} (from-token units)`,
        token: `${fromToken} → ${toToken}`,
        expectedOutput: expectedLabel,
        minOutput: ethers.utils.formatUnits(minOut, toDecimals),
        pool: poolAddr,
        recipient: `Executor ${executorAddr} (receives the output)`,
        via: `HybridVoting proposal (${argv.duration} min vote)`,
        org: argv.org,
        chain: ctx.networkName,
      }, { destructive: true, actionLabel: 'About to propose a TREASURY SWAP' });

      // Encode execution calls:
      // 1. Withdraw from PaymentManager to Executor
      const withdrawIface = new ethers.utils.Interface([
        'function withdraw(address token, address to, uint256 amount)',
      ]);
      const withdrawData = withdrawIface.encodeFunctionData('withdraw', [
        fromToken, executorAddr, amountWei,
      ]);

      // 2. Approve pool to spend from-token
      const erc20Iface = new ethers.utils.Interface(ERC20_ABI);
      const approveData = erc20Iface.encodeFunctionData('approve', [poolAddr, amountWei]);

      // 3. Call pool.exchange()
      const curveIface = new ethers.utils.Interface(CURVE_ABI);
      const exchangeData = curveIface.encodeFunctionData('exchange', [
        argv.fromIndex, argv.toIndex, amountWei, minOut,
      ]);

      const calls = [
        [pmAddr, ethers.BigNumber.from(0), withdrawData],    // withdraw from treasury
        [fromToken, ethers.BigNumber.from(0), approveData],  // approve DEX
        [poolAddr, ethers.BigNumber.from(0), exchangeData],  // swap
      ];

      // Build proposal metadata
      const proposalMeta = {
        description: `Swap ${argv.amount} tokens via Curve pool ${poolAddr}. Withdraws from PaymentManager, approves pool, executes swap. Expected output: ~${expectedLabel}. Min output: ${ethers.utils.formatUnits(minOut, toDecimals)}.`,
        optionNames: [`Execute swap (${argv.amount} tokens)`, 'Do not swap'],
        createdAt: Date.now(),
      };

      const txSpin = output.spinner('Pinning proposal metadata...');
      txSpin.start();
      const cid = await pinJson(JSON.stringify(proposalMeta));
      const descriptionHash = ipfsCidToBytes32(cid);
      const title = stringToBytes(`Treasury swap: ${argv.amount} tokens via Curve`);

      const batches = [calls, []]; // option 0 = swap, option 1 = no-op

      txSpin.text = 'Creating proposal...';
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
        successMsg: 'Swap proposal created',
        fields: {
          proposalId,
          amount: argv.amount.toString(),
          expectedOutput: expectedOut ? ethers.utils.formatUnits(expectedOut, toDecimals) : undefined,
          minOutput: ethers.utils.formatUnits(minOut, toDecimals),
          pool: poolAddr,
          fromToken,
          toToken,
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
