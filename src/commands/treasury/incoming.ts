import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveNetworkConfig } from '../../config/networks';
import * as output from '../../lib/output';

const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '0xa555d5344f6fb6c65da19e403cb4c1ec4a1a5ee3': { symbol: 'BREAD', decimals: 18 },
  '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83': { symbol: 'USDC', decimals: 6 },
  '0xaf204776c7245bf4147c2612bf6e5972ee483701': { symbol: 'sDAI', decimals: 18 },
  '0xe91d153e0b41518a2ce8dd3d7944fa863463a97d': { symbol: 'WXDAI', decimals: 18 },
};

// Known internal addresses — filtered out when --external-only is set.
// These are org-owned or protocol-internal contracts that transfer tokens TO the
// Executor as part of normal operations (not external client payments).
const INTERNAL_FROM_ADDRESSES: Record<string, string> = {
  '0x0000000000000000000000000000000000000000': 'zero (mint)',
  '0x409f51250dc5c66bb1d6952f947d841192f1140e': 'PaymentManager',
  '0xf3d8f3de71657d342db60dd714c8a2ae37eac6b4': 'Curve BREAD/WXDAI pool',
  '0xaf204776c7245bf4147c2612bf6e5972ee483701': 'sDAI vault',
};

interface IncomingArgs {
  org: string;
  blocks?: number;
  chain?: number;
  rpc?: string;
  externalOnly?: boolean;
}

export const incomingHandler = {
  builder: (yargs: Argv) => yargs
    .option('blocks', { type: 'number', default: 100000, describe: 'Number of blocks to scan' })
    .option('external-only', { type: 'boolean', default: false, describe: 'Filter out internal transfers (mints, PaymentManager, Curve pool, sDAI vault) — shows only potential client payments' }),

  handler: async (argv: ArgumentsCamelCase<IncomingArgs>) => {
    const spin = output.spinner('Scanning for incoming payments...');
    spin.start();

    try {
      const chainId = argv.chain || 100;
      const config = resolveNetworkConfig(chainId);
      const provider = new ethers.providers.JsonRpcProvider(config.resolvedRpc, chainId);

      // Executor address
      const executor = '0x9116bb47ef766cd867151fee8823e662da3bdad9';
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - (argv.blocks as number));

      // Scan ERC20 Transfer events TO the executor
      const transferTopic = ethers.utils.id('Transfer(address,address,uint256)');
      const executorTopic = ethers.utils.hexZeroPad(executor, 32);

      spin.text = `Scanning blocks ${fromBlock} to ${currentBlock}...`;
      const logs = await provider.getLogs({
        fromBlock,
        toBlock: currentBlock,
        topics: [transferTopic, null, executorTopic],
      });

      // Also check native xDAI transfers
      // (Can't easily scan native transfers without trace API — skip for now)

      const transfers: any[] = [];
      let internalFiltered = 0;
      for (const log of logs) {
        const tokenAddr = log.address.toLowerCase();
        const token = KNOWN_TOKENS[tokenAddr] || { symbol: tokenAddr.slice(0, 8), decimals: 18 };
        const from = '0x' + log.topics[1].slice(26);
        const fromLower = from.toLowerCase();
        const amount = ethers.BigNumber.from(log.data);
        const formatted = parseFloat(ethers.utils.formatUnits(amount, token.decimals));

        if (formatted <= 0) continue;

        const isInternal = !!INTERNAL_FROM_ADDRESSES[fromLower];
        if (argv.externalOnly && isInternal) {
          internalFiltered++;
          continue;
        }

        const block = await provider.getBlock(log.blockNumber);
        transfers.push({
          token: token.symbol,
          amount: formatted.toFixed(token.decimals > 6 ? 4 : 2),
          from: from.slice(0, 8) + '...' + from.slice(-4),
          fullFrom: from,
          source: isInternal ? INTERNAL_FROM_ADDRESSES[fromLower] : 'external',
          blockNumber: log.blockNumber,
          timestamp: block ? new Date(block.timestamp * 1000).toISOString() : 'unknown',
          txHash: log.transactionHash,
        });
      }

      // Current balances
      const xdaiBalance = ethers.utils.formatEther(await provider.getBalance(executor));
      const balances: any[] = [{ token: 'xDAI', balance: parseFloat(xdaiBalance).toFixed(4) }];

      for (const [addr, token] of Object.entries(KNOWN_TOKENS)) {
        try {
          const contract = new ethers.Contract(addr, ['function balanceOf(address) view returns (uint256)'], provider);
          const bal = await contract.balanceOf(executor);
          const formatted = parseFloat(ethers.utils.formatUnits(bal, token.decimals));
          if (formatted > 0) {
            balances.push({ token: token.symbol, balance: formatted.toFixed(token.decimals > 6 ? 4 : 2) });
          }
        } catch {}
      }

      spin.stop();

      const result: any = {
        executor,
        scanRange: `${fromBlock} to ${currentBlock} (${argv.blocks} blocks)`,
        currentBalances: balances,
        incomingTransfers: transfers.length,
        transfers: transfers.sort((a, b) => b.blockNumber - a.blockNumber),
      };
      if (argv.externalOnly) {
        result.externalOnly = true;
        result.internalFiltered = internalFiltered;
      }

      if (argv.json) {
        output.json(result);
      } else {
        console.log(`\n  Treasury Incoming — ${executor.slice(0, 8)}...`);
        console.log('  ' + '─'.repeat(45));
        console.log('  Current balances:');
        for (const b of balances) {
          console.log(`    ${b.token}: ${b.balance}`);
        }
        console.log(`\n  Incoming transfers (last ${argv.blocks} blocks): ${transfers.length}`);
        if (transfers.length > 0) {
          for (const t of transfers.slice(0, 10)) {
            console.log(`    ${t.timestamp.slice(0, 10)} ${t.token} ${t.amount} from ${t.from}`);
          }
        } else {
          console.log('    No incoming token transfers found.');
        }
        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
