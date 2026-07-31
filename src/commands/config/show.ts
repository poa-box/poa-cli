import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveNetworkConfig, getNetworkNameByChainId } from '../../config/networks';
import { getLoadedEnvFiles } from '../../lib/env-load';
import { query, getTransportStatus, type TransportStatus } from '../../lib/subgraph';
import * as output from '../../lib/output';

/** Minimal subgraph health probe (indexed block). Non-null only on success. */
const SUBGRAPH_META_QUERY = '{ _meta { block { number } } }';

/**
 * Best-effort subgraph reachability + indexed block for `pop config show`.
 * Races the query against a short timeout and NEVER throws — a dead subgraph
 * shows as unreachable rather than crashing the config dump.
 */
async function probeSubgraph(chainId: number): Promise<{ block: number | null; reachable: boolean }> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 4000)
  );
  try {
    const res = await Promise.race([query<any>(SUBGRAPH_META_QUERY, {}, chainId), timeout]);
    const block = res?._meta?.block?.number;
    return { block: typeof block === 'number' ? block : null, reachable: true };
  } catch {
    return { block: null, reachable: false };
  }
}

export const showHandler = {
  builder: (yargs: Argv) => yargs,

  handler: async (argv: ArgumentsCamelCase<any>) => {
    const hasKey = !!(argv.privateKey || process.env.POP_PRIVATE_KEY);
    let address: string | undefined;
    if (hasKey) {
      try {
        const key = (argv.privateKey as string) || process.env.POP_PRIVATE_KEY!;
        address = new ethers.Wallet(key).address;
      } catch { /* invalid key */ }
    }

    const chainId = argv.chain || (process.env.POP_DEFAULT_CHAIN ? parseInt(process.env.POP_DEFAULT_CHAIN, 10) : undefined);
    const networkName = chainId ? getNetworkNameByChainId(chainId) : undefined;

    let rpc: string | undefined;
    let subgraph: string | undefined;
    try {
      if (chainId) {
        const config = resolveNetworkConfig(chainId);
        rpc = config.resolvedRpc;
        subgraph = config.resolvedSubgraph;
      }
    } catch { /* no chain set */ }

    // Which subgraph transport (free Studio vs paid gateway) will serve reads,
    // and whether GRAPH_API_KEY was detected. Local-only; issues no request.
    // getTransportStatus redacts URLs — the API key is never printed.
    let transport: TransportStatus | undefined;
    if (chainId) {
      try {
        transport = getTransportStatus(chainId);
      } catch { /* unsupported chain — already surfaced by the chain row */ }
    }

    // Which .env files were actually loaded (env-load precedence order).
    const loadedEnvFiles = getLoadedEnvFiles();
    const envFileDisplay = loadedEnvFiles.length > 0
      ? loadedEnvFiles.join(', ')
      : '(none — using process env only)';

    // Subgraph health: attempt a lightweight _meta probe (indexed block) and,
    // when possible, the RPC head block so we can show indexing lag. Both are
    // best-effort — wrapped so a dead subgraph/RPC never throws here.
    let subgraphBlock: number | undefined;
    let subgraphHealth = '(no chain set)';
    if (chainId && subgraph) {
      const [meta, headBlock] = await Promise.all([
        probeSubgraph(chainId),
        rpc
          ? new ethers.providers.JsonRpcProvider(rpc, chainId).getBlockNumber().catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!meta.reachable) {
        subgraphHealth = 'unreachable';
      } else if (meta.block === null) {
        subgraphHealth = 'reachable (block unknown)';
      } else {
        subgraphBlock = meta.block;
        const lag = typeof headBlock === 'number' ? headBlock - meta.block : null;
        subgraphHealth = lag !== null && lag >= 0
          ? `indexed block ${meta.block} (${lag} behind head)`
          : `indexed block ${meta.block}`;
      }
    }

    const data = {
      wallet: address || '(not set)',
      chain: chainId ? `${networkName || 'unknown'} (${chainId})` : '(not set)',
      org: process.env.POP_DEFAULT_ORG || '(not set)',
      rpc: rpc ? rpc.substring(0, 60) + (rpc.length > 60 ? '...' : '') : '(not set)',
      subgraph: subgraph ? subgraph.substring(0, 60) + (subgraph.length > 60 ? '...' : '') : '(not set)',
      ipfsApi: process.env.POP_IPFS_API_URL || 'https://api.thegraph.com/ipfs/api/v0 (default)',
      'env file': envFileDisplay,
      'subgraph tier': transport ? transport.summary : '(no chain set)',
      'subgraph health': subgraphHealth,
    };

    if (output.isJsonMode()) {
      output.json({
        wallet: address,
        hasPrivateKey: hasKey,
        chainId,
        networkName,
        org: process.env.POP_DEFAULT_ORG || null,
        rpc,
        subgraph,
        ipfsApi: process.env.POP_IPFS_API_URL || 'https://api.thegraph.com/ipfs/api/v0',
        loadedEnvFiles,
        ...(subgraphBlock !== undefined ? { subgraphBlock } : {}),
        ...(transport ? { subgraphTransport: transport } : {}),
      });
    } else {
      console.log('');
      console.log('  POP CLI Configuration');
      console.log('  ---------------------');
      // Pad keys to the longest label so the two multi-word rows line up too.
      const width = Math.max(...Object.keys(data).map(k => k.length));
      for (const [key, value] of Object.entries(data)) {
        console.log(`  ${key.padEnd(width)}  ${value}`);
      }
      console.log('');
      if (!hasKey) output.warn('No private key set. Write transactions will fail. Set POP_PRIVATE_KEY in .env');
      if (!chainId) output.warn('No default chain set. Set POP_DEFAULT_CHAIN in .env or pass --chain');
    }
  },
};
