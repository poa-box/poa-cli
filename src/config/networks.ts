/**
 * Network Configuration — CLI wrapper over @poa-box/core/chains.
 *
 * The chain table (NETWORKS) and pure helpers live in core, shared verbatim
 * with every other consumer so CLI and frontend chain config can never drift.
 * The two env-reading resolvers are re-bound to process.env here so all
 * pre-extraction call sites keep their signatures.
 */

import {
  getGatewaySubgraphUrl as coreGetGatewaySubgraphUrl,
  resolveNetworkConfig as coreResolveNetworkConfig,
} from '@poa-box/core/chains';
import type { NetworkConfig } from '@poa-box/core/chains';

export * from '@poa-box/core/chains';

/**
 * Resolve the PAID (decentralised gateway) subgraph endpoint for a chain, or
 * undefined when none is configured. See @poa-box/core/chains for the precedence
 * (POP_<NET>_SUBGRAPH_GATEWAY > _FALLBACK > _ID > built-in gatewaySubgraphId).
 */
export function getGatewaySubgraphUrl(chainId: number): string | undefined {
  return coreGetGatewaySubgraphUrl(chainId, process.env);
}

/**
 * Resolve the effective network config using env vars + CLI overrides.
 * Priority: CLI flag > per-chain env var > POP_DEFAULT_CHAIN env > error
 */
export function resolveNetworkConfig(chainIdOverride?: number): NetworkConfig & { resolvedRpc: string; resolvedSubgraph: string } {
  return coreResolveNetworkConfig(chainIdOverride, process.env);
}
