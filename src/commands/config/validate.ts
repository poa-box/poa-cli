import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveNetworkConfig } from '../../config/networks';
import { query, getTransportStatus } from '../../lib/subgraph';
import { FETCH_INFRASTRUCTURE_ADDRESSES } from '../../queries/infrastructure';
import * as output from '../../lib/output';

export const validateHandler = {
  builder: (yargs: Argv) => yargs,

  handler: async (argv: ArgumentsCamelCase<any>) => {
    const results: Array<{ check: string; status: string; detail?: string }> = [];

    // Check chain config
    let chainId: number | undefined;
    try {
      chainId = argv.chain as number || (process.env.POP_DEFAULT_CHAIN ? parseInt(process.env.POP_DEFAULT_CHAIN, 10) : undefined);
      if (!chainId) {
        results.push({ check: 'Chain', status: 'SKIP', detail: 'No chain configured' });
      } else {
        resolveNetworkConfig(chainId);
        results.push({ check: 'Chain', status: 'OK', detail: `Chain ID ${chainId}` });
      }
    } catch (e: any) {
      results.push({ check: 'Chain', status: 'FAIL', detail: e.message });
    }

    // Check RPC
    if (chainId) {
      try {
        const config = resolveNetworkConfig(chainId);
        const provider = new ethers.providers.JsonRpcProvider(config.resolvedRpc, chainId);
        const blockNumber = await provider.getBlockNumber();
        results.push({ check: 'RPC', status: 'OK', detail: `Block #${blockNumber}` });
      } catch (e: any) {
        results.push({ check: 'RPC', status: 'FAIL', detail: e.message });
      }
    }

    // Which subgraph transport will serve reads (free Studio vs paid gateway),
    // and whether GRAPH_API_KEY was detected. Local-only, no network call, and
    // never prints the key. Deliberately never FAILs — an unusable transport
    // already shows up as a Subgraph FAIL below, and this row is diagnostic.
    //
    // Computed here but APPENDED after Gas: the --json payload is a positional
    // array that pre-dates this row, so the new row must not shift the indexes
    // of Subgraph/Wallet/Gas for any out-of-tree consumer.
    let transportRow: { check: string; status: string; detail?: string } | undefined;
    if (chainId) {
      try {
        const t = getTransportStatus(chainId);
        transportRow = {
          check: 'Transport',
          status: t.activeTier ? 'OK' : 'WARN',
          detail: t.summary,
        };
      } catch (e: any) {
        transportRow = { check: 'Transport', status: 'SKIP', detail: e.message };
      }
    }

    // Check subgraph
    if (chainId) {
      try {
        const infra = await query<any>(FETCH_INFRASTRUCTURE_ADDRESSES, {}, chainId);
        const orgCount = infra.orgRegistryContracts?.[0]?.totalOrgs || '?';
        results.push({ check: 'Subgraph', status: 'OK', detail: `${orgCount} orgs indexed` });
      } catch (e: any) {
        results.push({ check: 'Subgraph', status: 'FAIL', detail: e.message.substring(0, 100) });
      }
    }

    // Check private key
    const key = (argv.privateKey as string) || process.env.POP_PRIVATE_KEY;
    let walletAddress: string | undefined;
    if (key) {
      try {
        const wallet = new ethers.Wallet(key);
        walletAddress = wallet.address;
        results.push({ check: 'Wallet', status: 'OK', detail: wallet.address });
      } catch {
        results.push({ check: 'Wallet', status: 'FAIL', detail: 'Invalid private key format' });
      }
    } else {
      results.push({ check: 'Wallet', status: 'SKIP', detail: 'No private key configured' });
    }

    // Check wallet balance (gas)
    if (walletAddress && chainId) {
      try {
        const config = resolveNetworkConfig(chainId);
        const provider = new ethers.providers.JsonRpcProvider(config.resolvedRpc, chainId);
        const balance = await provider.getBalance(walletAddress);
        const balanceFormatted = ethers.utils.formatEther(balance);
        const symbol = config.nativeCurrency.symbol;
        const LOW_GAS_THRESHOLD = ethers.utils.parseEther('0.01');

        if (balance.lt(LOW_GAS_THRESHOLD)) {
          results.push({ check: 'Gas', status: 'WARN', detail: `${balanceFormatted} ${symbol} — low, fund wallet for reliable transacting` });
        } else {
          results.push({ check: 'Gas', status: 'OK', detail: `${balanceFormatted} ${symbol}` });
        }
      } catch {
        results.push({ check: 'Gas', status: 'SKIP', detail: 'Could not query balance' });
      }
    }

    if (transportRow) results.push(transportRow);

    // Output
    if (output.isJsonMode()) {
      output.json(results);
    } else {
      console.log('');
      for (const r of results) {
        const icon = r.status === 'OK' ? '\x1b[32m✓\x1b[0m' : r.status === 'FAIL' ? '\x1b[31m✗\x1b[0m' : r.status === 'WARN' ? '\x1b[33m!\x1b[0m' : '\x1b[33m-\x1b[0m';
        console.log(`  ${icon} ${r.check.padEnd(10)} ${r.detail || ''}`);
      }
      console.log('');

      const failed = results.filter(r => r.status === 'FAIL');
      if (failed.length > 0) {
        process.exit(1);
      }
    }
  },
};
