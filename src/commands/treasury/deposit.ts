/**
 * pop treasury deposit — deposit ERC20 tokens into the org treasury.
 *
 * Two transactions from YOUR wallet: ERC20.approve(PaymentManager, amount)
 * then PaymentManager.payERC20(token, amount) (verified against contracts
 * origin/main src/PaymentManager.sol — payERC20 pulls via transferFrom and
 * emits PaymentReceived). DESTRUCTIVE: your tokens irreversibly move to the
 * treasury; getting them back requires a governance vote (pop treasury send).
 *
 * Pre-flight (skippable with --no-preflight) checks your wallet's token
 * balance covers the deposit, and gas.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createReadContract, createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { requireAddress } from '../../lib/validation';
import { getTokenDecimals } from '../../config/tokens';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { formatToken } from '../../lib/format';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface DepositArgs {
  org?: string;
  token: string;
  amount: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

export const depositHandler = {
  builder: (yargs: Argv) => yargs
    .option('token', { type: 'string', demandOption: true, describe: 'ERC20 token address' })
    .option('amount', { type: 'number', demandOption: true, describe: 'Amount to deposit (human token units)' })
    .example('pop treasury deposit --token 0xToken... --amount 40', 'Approve + deposit 40 tokens into the PaymentManager')
    .epilogue(
      'Sends two transactions: approve, then payERC20. Deposited funds belong to the org — '
      + 'withdrawing them requires a governance vote (pop treasury send).'
    ),

  handler: async (argv: ArgumentsCamelCase<DepositArgs>) => {
    const spin = output.spinner('Preparing treasury deposit...');
    spin.start();

    try {
      const tokenAddr = requireAddress(argv.token, 'token');
      if (!Number.isFinite(argv.amount) || argv.amount <= 0) {
        throw new CliError(`--amount must be a positive number, got "${argv.amount}".`, EXIT.USAGE);
      }

      const ctx = await getWriteContext(argv);
      const paymentManagerAddress = requireModule(ctx.modules, 'paymentManagerAddress');

      const erc20Read = createReadContract(tokenAddr, 'ERC20', ctx.provider);
      let decimals = getTokenDecimals(tokenAddr);
      let symbol: string | undefined;
      try {
        const [liveDecimals, liveSymbol] = await Promise.all([
          erc20Read.decimals(),
          erc20Read.symbol().catch(() => undefined),
        ]);
        decimals = Number(liveDecimals);
        symbol = liveSymbol;
      } catch {
        // Live read failed — fall back to the known-token table / 18.
      }
      const amountWei = ethers.utils.parseUnits(argv.amount.toString(), decimals);

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      if (argv.preflight !== false) {
        try {
          const balance: ethers.BigNumber = await erc20Read.balanceOf(ctx.address);
          if (balance.lt(amountWei)) {
            throw new PreconditionError(
              `Your wallet holds ${formatToken(balance, decimals, symbol)} but the deposit needs ${formatToken(amountWei, decimals, symbol)}.`,
              'Reduce --amount or fund the wallet first.'
            );
          }
        } catch (err) {
          if (err instanceof PreconditionError) throw err;
          // balance unreadable — let the transaction surface the real error
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        deposit: formatToken(amountWei, decimals, symbol ?? tokenAddr),
        token: tokenAddr,
        to: `PaymentManager ${paymentManagerAddress}`,
        org: argv.org,
        chain: ctx.networkName,
        note: 'two transactions (approve + payERC20); withdrawing later requires a governance vote',
      }, { destructive: true, actionLabel: 'About to DEPOSIT tokens to the org treasury' });

      // Step 1: Approve ERC20 spend
      const txSpin = output.spinner('Approving token spend...');
      txSpin.start();
      const erc20 = createWriteContract(tokenAddr, 'ERC20', ctx.signer);
      const approveResult = await executeTx(erc20, 'approve', [paymentManagerAddress, amountWei], { dryRun: argv.dryRun });

      if (!approveResult.success) {
        txSpin.stop();
        output.error('Token approval failed', {
          error: approveResult.error,
          errorCode: approveResult.errorCode,
          suggestion: approveResult.suggestion,
        });
        process.exit(EXIT.TX_FAILED);
        return;
      }

      // Step 2: Deposit via payERC20
      txSpin.text = 'Depositing tokens...';
      const pm = createWriteContract(paymentManagerAddress, 'PaymentManager', ctx.signer);
      const result = await executeTx(pm, 'payERC20', [tokenAddr, amountWei], { dryRun: argv.dryRun });
      txSpin.stop();

      finishWrite(result, {
        successMsg: 'Deposit successful',
        fields: {
          amount: `${argv.amount}`,
          token: tokenAddr,
          symbol,
          amountWei: amountWei.toString(),
          paymentManager: paymentManagerAddress,
          approveTxHash: approveResult.dryRun ? undefined : approveResult.txHash,
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
