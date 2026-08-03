/**
 * Network Configuration
 * Mirrors frontend networks.js for full parity on POP-deployed chains.
 *
 * Chains come in two flavors:
 *   1. POP-deployed chains (Gnosis, Arbitrum, Sepolia, BaseSepolia) — full
 *      subgraph + deployment support. Set `isExternal: false` (default).
 *   2. External chains (Ethereum mainnet, Optimism, Base, Polygon) — no POP
 *      deployment, no POP subgraph. Used by read-only commands like
 *      `pop org probe-access` to inspect foreign governance contracts
 *      (Compound Governor Bravo, Aave V3, Uniswap, etc). Set
 *      `isExternal: true` so subgraph sweepers skip them.
 *
 * Adding an external chain: set `isExternal: true`, leave `subgraphUrl: ''`,
 * and use an empty `bountyTokens` map. Commands that require a POP subgraph
 * (org activity, task lists, proposal history) will refuse to run on external
 * chains — probe-access and other foreign-contract tools work fine.
 *
 * Env-derived resolution (getGatewaySubgraphUrl, resolveNetworkConfig) reads
 * from an injected EnvSource — the CLI passes process.env; browser hosts pass
 * whatever env object they assemble. Pure lookups need no env at all.
 */

import { EnvSource, EMPTY_ENV } from './env';

export interface NetworkConfig {
  chainId: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrl: string;
  blockExplorer: string;
  isTestnet: boolean;
  /**
   * True if POP is NOT deployed on this chain. External chains are
   * useful for read-only contract inspection (probe-access) but
   * cannot be used for POP operations like task management, voting,
   * treasury, or governance. Defaults to false when omitted.
   */
  isExternal?: boolean;
  /**
   * Default block range per getLogs chunk for this chain. L2 chains have
   * stricter RPC limits than L1 — Optimism/Base public RPCs reject ranges
   * above ~2000-5000 blocks. Commands like audit-vetoken use this value
   * when the user doesn't pass --chunk. Defaults to 10000 when omitted.
   */
  defaultLogsChunkBlocks?: number;
  subgraphUrl: string;
  /**
   * Subgraph ID on The Graph's DECENTRALISED network (the "paid" gateway tier).
   *
   * `subgraphUrl` above points at Graph Studio, which is free but capped at
   * 3K queries/day. The same deployment is also published to the gateway,
   * where it is addressed by this base58 subgraph ID and billed against
   * `GRAPH_API_KEY`. lib/subgraph.ts uses Studio first and switches here when
   * the free quota is spent — see `getGatewaySubgraphUrl` below.
   *
   * Leave undefined when the deployment has not been published to the
   * decentralised network; the chain then has no paid tier unless the
   * operator supplies one via `POP_<NET>_SUBGRAPH_GATEWAY` /
   * `POP_<NET>_SUBGRAPH_ID`.
   */
  gatewaySubgraphId?: string;
  bountyTokens: Record<string, string>;
}

/**
 * Base URL for The Graph's decentralised gateway. A full endpoint is
 * `${base}/${gatewaySubgraphId}`. Override with POP_GRAPH_GATEWAY_URL to point
 * at a self-hosted or regional gateway.
 *
 * NOTE: the LEGACY gateway form embedded the API key in the path
 * (`/api/<KEY>/subgraphs/id/<ID>`). This modern form does not — the key travels
 * in the Authorization header instead, so the URL is safe to print.
 */
export const DEFAULT_GRAPH_GATEWAY_URL = 'https://gateway.thegraph.com/api/subgraphs/id';

export const NETWORKS: Record<string, NetworkConfig> = {
  arbitrum: {
    chainId: 42161,
    name: 'Arbitrum One',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrl: 'https://arbitrum-one-rpc.publicnode.com',
    defaultLogsChunkBlocks: 2000,
    blockExplorer: 'https://arbiscan.io',
    isTestnet: false,
    subgraphUrl: 'https://api.studio.thegraph.com/query/73367/poa-arb-v-1/version/latest',
    // No gatewaySubgraphId: the Arbitrum deployment has not been published to
    // the decentralised network (or its ID is not known here), so Arbitrum has
    // no paid tier by default. Set POP_ARBITRUM_SUBGRAPH_ID once it is published.
    bountyTokens: {
      USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    },
  },
  gnosis: {
    chainId: 100,
    name: 'Gnosis',
    nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
    rpcUrl: 'https://rpc.gnosischain.com',
    blockExplorer: 'https://gnosisscan.io',
    isTestnet: false,
    subgraphUrl: 'https://api.studio.thegraph.com/query/73367/poa-gnosis-v-1/version/latest',
    // Verified against the live gateway: this ID serves the same deployment as
    // the Studio URL above (identical `_meta.block` within one block).
    gatewaySubgraphId: '576YA6oF16nA2uG5Q9KFfBSvJm4ZNKzWZkwh8eWXaxJs',
    bountyTokens: {
      BREAD: '0xa555d5344f6FB6c65da19e403Cb4c1eC4a1a5Ee3',
      USDC: '0xDDAfbb505ad214D7b80b1f830fcCc89B60fB7A83',
      WXDAI: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',
      sDAI: '0xaf204776c7245bF4147c2612BF6e5972Ee483701',
    },
  },
  sepolia: {
    chainId: 11155111,
    name: 'Sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    blockExplorer: 'https://sepolia.etherscan.io',
    isTestnet: true,
    // No POP subgraph is deployed here — the Graph Studio deployment was removed (the frontend
    // dropped these endpoints in its PR #441; the URL now answers "deployment does not exist").
    // Empty means "RPC-only chain": getAllSubgraphUrls() filters on truthiness, and
    // lib/subgraph.ts turns a subgraph-backed command into one actionable error.
    subgraphUrl: '',
    bountyTokens: {
      USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    },
  },
  baseSepolia: {
    chainId: 84532,
    name: 'Base Sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrl: 'https://base-sepolia-rpc.publicnode.com',
    blockExplorer: 'https://sepolia.basescan.org',
    isTestnet: true,
    // No POP subgraph deployed — see the Sepolia note above.
    subgraphUrl: '',
    bountyTokens: {
      USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    },
  },
  // ---------------------------------------------------------------------
  // External chains (HB#326, task #341) — read-only probe targets.
  // POP is NOT deployed on any of these. Added so `pop org probe-access
  // --chain <id>` works without the --rpc workaround from HB#336. See
  // the NetworkConfig.isExternal field comment at the top of this file
  // for the semantics.
  // ---------------------------------------------------------------------
  ethereum: {
    chainId: 1,
    name: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrl: 'https://ethereum.publicnode.com',
    blockExplorer: 'https://etherscan.io',
    isTestnet: false,
    isExternal: true,
    subgraphUrl: '',
    bountyTokens: {},
  },
  optimism: {
    chainId: 10,
    name: 'Optimism',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrl: 'https://optimism-rpc.publicnode.com',
    blockExplorer: 'https://optimistic.etherscan.io',
    isTestnet: false,
    isExternal: true,
    defaultLogsChunkBlocks: 2000,
    subgraphUrl: '',
    bountyTokens: {},
  },
  base: {
    chainId: 8453,
    name: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrl: 'https://base-rpc.publicnode.com',
    blockExplorer: 'https://basescan.org',
    isTestnet: false,
    isExternal: true,
    defaultLogsChunkBlocks: 2000,
    subgraphUrl: '',
    bountyTokens: {},
  },
  polygon: {
    chainId: 137,
    name: 'Polygon',
    nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
    rpcUrl: 'https://polygon-bor-rpc.publicnode.com',
    blockExplorer: 'https://polygonscan.com',
    isTestnet: false,
    isExternal: true,
    subgraphUrl: '',
    bountyTokens: {},
  },
};

/** Home chain for accounts/passkeys */
export const HOME_NETWORK = 'arbitrum';
export const HOME_CHAIN_ID = NETWORKS[HOME_NETWORK].chainId;

/** Default chain for org deployment */
export const DEFAULT_DEPLOY_NETWORK = 'gnosis';
export const DEFAULT_DEPLOY_CHAIN_ID = NETWORKS[DEFAULT_DEPLOY_NETWORK].chainId;

export function getNetworkByChainId(chainId: number): NetworkConfig | null {
  return Object.values(NETWORKS).find(n => n.chainId === chainId) || null;
}

export function getNetworkNameByChainId(chainId: number): string | null {
  const entry = Object.entries(NETWORKS).find(([_, config]) => config.chainId === chainId);
  return entry ? entry[0] : null;
}

export function isNetworkSupported(chainId: number): boolean {
  return !!getNetworkByChainId(chainId);
}

export function getSubgraphUrl(chainId: number): string {
  return getNetworkByChainId(chainId)?.subgraphUrl || NETWORKS[HOME_NETWORK].subgraphUrl;
}

/**
 * UPPER_SNAKE env-var infix for a chain: 84532 -> "BASE_SEPOLIA".
 * Single source of truth for the `POP_<NET>_*` env convention so the RPC,
 * subgraph and gateway lookups can never drift apart.
 */
export function getEnvInfixByChainId(chainId: number): string | null {
  const name = getNetworkNameByChainId(chainId);
  return name ? name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase() : null;
}

/**
 * Resolve the PAID (decentralised gateway) subgraph endpoint for a chain, or
 * undefined when none is configured. Requires `GRAPH_API_KEY` at request time —
 * this function only resolves the URL, it does not check for the key.
 *
 * Precedence (first non-empty wins):
 *   1. `POP_<NET>_SUBGRAPH_GATEWAY`   — explicit full URL
 *   2. `POP_<NET>_SUBGRAPH_FALLBACK`  — legacy name for the same thing
 *   3. `POP_<NET>_SUBGRAPH_ID`        — just the base58 ID, joined to the base
 *   4. `NetworkConfig.gatewaySubgraphId` joined to the base
 *
 * The base is `POP_GRAPH_GATEWAY_URL` or DEFAULT_GRAPH_GATEWAY_URL. This
 * replaces the old one-ad-hoc-env-var-per-chain arrangement where only Gnosis
 * could ever reach the gateway.
 */
export function getGatewaySubgraphUrl(chainId: number, env: EnvSource = EMPTY_ENV): string | undefined {
  const infix = getEnvInfixByChainId(chainId);
  if (!infix) return undefined;

  const explicit = (env[`POP_${infix}_SUBGRAPH_GATEWAY`] || '').trim()
    || (env[`POP_${infix}_SUBGRAPH_FALLBACK`] || '').trim();
  if (explicit) return explicit;

  const id = (env[`POP_${infix}_SUBGRAPH_ID`] || '').trim()
    || (getNetworkByChainId(chainId)?.gatewaySubgraphId || '').trim();
  if (!id) return undefined;

  const base = ((env.POP_GRAPH_GATEWAY_URL || '').trim() || DEFAULT_GRAPH_GATEWAY_URL).replace(/\/+$/, '');
  return `${base}/${id}`;
}

export function getAllSubgraphUrls(): Array<{ chainId: number; url: string; name: string }> {
  // External chains (Ethereum mainnet, Optimism, Base, Polygon) have no
  // POP subgraph and are read-only probe targets only. Filter them out
  // here so the subgraph sweeper never tries to query a nonexistent URL.
  return Object.values(NETWORKS)
    .filter(n => !n.isTestnet && !n.isExternal && n.subgraphUrl)
    .map(n => ({ chainId: n.chainId, url: n.subgraphUrl, name: n.name }));
}

/**
 * Resolve the effective network config using env vars + CLI overrides.
 * Priority: CLI flag > per-chain env var > POP_DEFAULT_CHAIN env > error
 */
export function resolveNetworkConfig(
  chainIdOverride?: number,
  env: EnvSource = EMPTY_ENV
): NetworkConfig & { resolvedRpc: string; resolvedSubgraph: string } {
  const chainId = chainIdOverride
    || (env.POP_DEFAULT_CHAIN ? parseInt(env.POP_DEFAULT_CHAIN, 10) : undefined);

  if (!chainId) {
    throw new Error('No chain specified. Set POP_DEFAULT_CHAIN in .env or pass --chain flag.');
  }

  const network = getNetworkByChainId(chainId);
  if (!network) {
    throw new Error(`Unsupported chain ID: ${chainId}. Supported: ${Object.values(NETWORKS).map(n => `${n.name} (${n.chainId})`).join(', ')}`);
  }

  // Convert camelCase to UPPER_SNAKE: baseSepolia → BASE_SEPOLIA
  const networkName = getEnvInfixByChainId(chainId)!;

  // An override that is present-but-empty (`POP_SUBGRAPH_URL=` on its own line,
  // which is exactly what the shipped .env templates contain) must NOT shadow
  // the built-in default. `''` is already falsy, but trim first so a stray
  // space or CR from a hand-edited .env behaves the same way.
  const envUrl = (name: string): string | undefined => {
    const raw = env[name];
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    return trimmed || undefined;
  };

  const resolvedRpc = envUrl(`POP_${networkName}_RPC`)
    || (chainIdOverride ? undefined : envUrl('POP_RPC_URL'))
    || network.rpcUrl;

  const resolvedSubgraph = envUrl(`POP_${networkName}_SUBGRAPH`)
    || (chainIdOverride ? undefined : envUrl('POP_SUBGRAPH_URL'))
    || network.subgraphUrl;

  return { ...network, resolvedRpc, resolvedSubgraph };
}

// ═════════════════════════════════════════════════════════════════════════
// Token registry (ported from src/config/tokens.ts)
// ═════════════════════════════════════════════════════════════════════════

/**
 * Token configuration — decimals and metadata for known tokens.
 * Must match frontend token handling for correct amount encoding.
 */

export interface TokenInfo {
  symbol: string;
  decimals: number;
  address: string;
}

/** Participation Token is always 18 decimals */
export const PARTICIPATION_TOKEN_DECIMALS = 18;

/** Known tokens across all chains, keyed by lowercase address */
const KNOWN_TOKENS: Record<string, TokenInfo> = {
  // Arbitrum
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6, address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  // Gnosis
  '0xa555d5344f6fb6c65da19e403cb4c1ec4a1a5ee3': { symbol: 'BREAD', decimals: 18, address: '0xa555d5344f6FB6c65da19e403Cb4c1eC4a1a5Ee3' },
  '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83': { symbol: 'USDC', decimals: 6, address: '0xDDAfbb505ad214D7b80b1f830fcCc89B60fB7A83' },
  '0xe91d153e0b41518a2ce8dd3d7944fa863463a97d': { symbol: 'WXDAI', decimals: 18, address: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d' },
  // Sepolia
  '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238': { symbol: 'USDC', decimals: 6, address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  // Base Sepolia
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': { symbol: 'USDC', decimals: 6, address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
};

export function getTokenByAddress(address: string): TokenInfo | null {
  return KNOWN_TOKENS[address.toLowerCase()] || null;
}

/**
 * Reverse lookup by symbol. Case-insensitive. Returns the first matching
 * token across all chains — if the same symbol exists on multiple chains
 * (e.g. USDC on Gnosis/Arbitrum/Sepolia), the caller should narrow by
 * chain using getTokenByAddress after resolving the chain-specific address
 * via another channel.
 */
export function getTokenBySymbol(symbol: string): TokenInfo | null {
  const want = symbol.toUpperCase();
  for (const t of Object.values(KNOWN_TOKENS)) {
    if (t.symbol.toUpperCase() === want) return t;
  }
  return null;
}

/**
 * Resolve a user-supplied token identifier to a checksummed address.
 * If input starts with 0x, returns it unchanged (caller's responsibility
 * to pre-validate). Otherwise treats it as a symbol and resolves via
 * getTokenBySymbol, throwing if unknown.
 */
export function resolveTokenAddress(input: string): string {
  if (input.startsWith('0x')) return input;
  const token = getTokenBySymbol(input);
  if (!token) {
    throw new Error(`Unknown token symbol: ${input}. Add it to config/tokens.ts or pass a 0x address.`);
  }
  return token.address;
}

export function getTokenDecimals(address: string): number {
  const token = getTokenByAddress(address);
  if (!token) {
    throw new Error(`Unknown bounty token: ${address}. Add it to config/tokens.ts or use a known token.`);
  }
  return token.decimals;
}
