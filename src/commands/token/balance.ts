/**
 * pop token balance — participation token balance for an address.
 *
 * Served from the subgraph: TokenBalance mirrors ERC20 balanceOf exactly
 * (verified live — sum of a token's TokenBalance rows equals its indexed
 * totalSupply) and ParticipationTokenContract.symbol is populated on every
 * live row ('PT', 'KUBIX', 'TEST'), which beats the hardcoded 'PT' guess.
 *
 * balanceOf()/symbol() stay as the fallback and are still used whenever the
 * subgraph has no row for this holder — a missing row and a genuine zero are
 * indistinguishable, so the contract settles it rather than reporting a zero
 * that might just be indexing lag.
 *
 * JSON keeps the classic fields (address/balance/balanceWei/token/symbol)
 * with an additive `source`.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createProvider , resolveIdentityAddress } from '../../lib/signer';
import { createReadContract } from '../../lib/contracts';
import { formatToken } from '../../lib/format';
import { query } from '../../lib/subgraph';
import { FETCH_TOKEN_BALANCE, tokenBalanceId } from '../../queries/token';
import * as output from '../../lib/output';
import { resolveTokenAddress } from './helpers';

interface BalanceArgs {
  org?: string;
  address?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
}

export const balanceHandler = {
  builder: (yargs: Argv) => yargs
    .option('address', { type: 'string', describe: 'Address to check (defaults to signer)' })
    .example('pop token balance', 'Your PT balance in the default org')
    .example('pop token balance --address 0xAbc... --json', 'Machine-readable balance for another address'),

  handler: async (argv: ArgumentsCamelCase<BalanceArgs>) => {
    const spin = output.spinner('Checking balance...');
    spin.start();

    try {
      const address = resolveIdentityAddress(argv, { required: true, purpose: 'token balance' })!;

      const { tokenAddress } = await resolveTokenAddress(argv.org, argv.chain);

      let balance: ethers.BigNumber | null = null;
      let symbol: string | null = null;
      // An explicit --rpc says WHERE to read from (a fork, a private node), so
      // it opts out of the subgraph instead of being silently ignored.
      if (!argv.rpc) {
        try {
          const data = await query<any>(FETCH_TOKEN_BALANCE, {
            token: tokenAddress.toLowerCase(),
            balanceId: tokenBalanceId(tokenAddress, address),
          }, argv.chain);
          if (data?.participationTokenContract?.symbol) {
            symbol = String(data.participationTokenContract.symbol);
          }
          if (data?.tokenBalance?.balance !== null && data?.tokenBalance?.balance !== undefined) {
            balance = ethers.BigNumber.from(String(data.tokenBalance.balance));
          }
        } catch {
          // Subgraph unavailable on this chain (or older schema) — the
          // contract answers below.
        }
      }

      const source: 'subgraph' | 'rpc' = balance !== null ? 'subgraph' : 'rpc';
      if (balance === null || symbol === null) {
        const provider = createProvider({ chainId: argv.chain, rpcUrl: argv.rpc as string });
        const contract = createReadContract(tokenAddress, 'ParticipationToken', provider);
        const [onChainBalance, onChainSymbol] = await Promise.all([
          balance === null ? contract.balanceOf(address) : Promise.resolve(balance),
          symbol === null ? contract.symbol().catch(() => 'PT') : Promise.resolve(symbol),
        ]);
        balance = ethers.BigNumber.from(onChainBalance);
        symbol = String(onChainSymbol);
      }

      const formatted = ethers.utils.formatUnits(balance, 18);

      spin.stop();

      if (output.isJsonMode()) {
        output.json({ address, balance: formatted, balanceWei: balance.toString(), token: tokenAddress, symbol, source });
      } else {
        console.log(`\n  ${address}: ${formatToken(balance, 18, symbol)}\n`);
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
