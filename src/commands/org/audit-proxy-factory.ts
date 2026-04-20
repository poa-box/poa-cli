/**
 * pop org audit-proxy-factory — detect E-proxy identity-obfuscating patterns.
 *
 * Task #473 (sentinel HB#811 claim). Sprint 20 rank-3 per Proposal #65.
 *
 * E-proxy identity-obfuscating is the v2.0-canonical sub-pattern where
 * end-user voter identities are hidden behind intermediary proxy contracts.
 * Classic example: Maker DSChief factory — each user deploys their own
 * DSProxy, voting through it masks the end-user EOA from the governance
 * contract's perspective (voter.address is the proxy, not the owner).
 *
 * Detection approach (MVP scaffold):
 *   1. Given a governance contract address + chain, identify top-N recent
 *      voter addresses (via Snapshot or on-chain event scan).
 *   2. For each voter, check `eth_getCode(voter) != 0x` (= voter is contract,
 *      not EOA). Contract-voters are proxy-CANDIDATES.
 *   3. Count proxy-share = proxy-voters / total top-N voters.
 *   4. Classify DAO as E-proxy identity-obfuscating if proxy-share > 50%.
 *
 * Future extensions (v2+):
 *   - Resolve proxy → end-user via ownership reads (DSProxy `owner()`,
 *     OpenZeppelin Ownable, CREATE2 salt inversion)
 *   - Detect specific factory patterns (Clone factory, CREATE2, DSProxy)
 *   - Cross-reference against known factories (dsproxy-registry, Safe factory)
 *
 * Scope of initial ship (HB#811 scaffold):
 *   - Command registered + --help surfaces flags
 *   - Pure helper functions exported for tests
 *   - Integration with Snapshot-voter-list OR explicit --voters flag
 *   - Contract-vs-EOA classifier via eth_getCode
 *   - JSON output shape settled
 *   - Unit tests for pure helpers
 *   - Real Snapshot integration + factory-pattern detection lands in HB#812+.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveNetworkConfig } from '../../config/networks';
import * as output from '../../lib/output';

export type VoterClass = 'eoa' | 'proxy-candidate' | 'unknown';

/**
 * Proxy-family taxonomy (HB#833 v1.2, vigil HB#471-endorsed).
 * Categorizes contract bytecode into known proxy families by size + signature.
 * - 'eip-1167': OpenZeppelin minimal proxy clone (EIP-1167 standard)
 * - 'dsproxy-maker': Maker VoteProxyFactory-deployed DSProxy (3947 bytes exactly)
 * - 'safe-proxy': Gnosis Safe SafeProxy forwarder (~170 bytes, delegatecall pattern)
 * - 'other-contract': any other contract bytecode not matching known families
 * - 'none': EOA (no code)
 */
export type ProxyFamily = 'eip-1167' | 'dsproxy-maker' | 'safe-proxy' | 'other-contract' | 'none';

interface AuditProxyFactoryArgs {
  address?: string;
  space?: string;
  voters?: string;
  chain?: number;
  rpc?: string;
  json?: boolean;
  governanceToken?: string;
  governanceTokenChain?: number;
  governanceTokenRpc?: string;
}

/**
 * v2.1.9 E-proxy-multisig variant annotation (vigil HB#487, sentinel HB#849 canonical).
 * Variant A (direct-token-holding): Safe holds governance tokens directly (e.g. Uniswap Safe 1001 UNI)
 * Variant B (delegation-VP-receipt): Safe receives delegated VP without holding tokens (e.g. Balancer + ArbFdn Safes at 0)
 *
 * Pure post-classification annotation — `classifyProxyFamily()` stays bytecode-only per v2.1.9
 * compatibility guarantee. Variant is only meaningful for family === 'safe-proxy'.
 */
export type MultisigVariant = 'A-token-holding' | 'B-delegation-receipt' | 'unknown';

export interface ProxyFactoryAuditResult {
  target: string;
  chainId: number;
  status: 'scaffold' | 'partial' | 'complete';
  note?: string;
  voters?: Array<{
    address: string;
    class: VoterClass;
    codeSize?: number;
    family?: ProxyFamily;
    owners?: string[];
    multisigVariant?: MultisigVariant;
    governanceTokenBalance?: string;
  }>;
  classSummary?: Record<VoterClass, number>;
  familySummary?: Record<ProxyFamily, number>;
  proxyShare?: number;
  classification?: 'E-proxy-identity-obfuscating' | 'not-E-proxy' | 'inconclusive';
}

/**
 * Classify a safe-proxy voter into v2.1.9 E-proxy-multisig Variant A vs B
 * by querying balanceOf(voter) on the governance token contract.
 *
 * - balance > 0 → Variant A (direct-token-holding)
 * - balance = 0 → Variant B (delegation-VP-receipt)
 * - call fails → 'unknown'
 *
 * Called only when --governance-token is supplied AND family === 'safe-proxy'.
 * Exported for unit testing.
 */
export async function classifyMultisigVariant(
  provider: ethers.providers.Provider,
  safeAddress: string,
  governanceToken: string,
): Promise<{ variant: MultisigVariant; balance: string }> {
  const abi = ['function balanceOf(address) view returns (uint256)'];
  try {
    const token = new ethers.Contract(governanceToken, abi, provider);
    const bal: ethers.BigNumber = await token.balanceOf(safeAddress);
    const variant: MultisigVariant = bal.isZero() ? 'B-delegation-receipt' : 'A-token-holding';
    return { variant, balance: bal.toString() };
  } catch {
    return { variant: 'unknown', balance: '0' };
  }
}

/**
 * POST a Snapshot GraphQL query with retry + exponential backoff.
 *
 * retro-839 change-5 (vigil HB#483 Task #487): Snapshot GraphQL exhibits
 * transient ECONNRESET + 429 rate-limits + occasional empty-result cache
 * misses on re-runs. This wrapper retries on network errors, 5xx, and 429
 * with 1s/2s/4s backoff (max 3 attempts). 4xx (except 429) fails fast.
 */
async function snapshotGraphQL(
  query: string,
  variables: Record<string, unknown>,
  verbose = false,
): Promise<any> {
  const url = 'https://hub.snapshot.org/graphql';
  const body = JSON.stringify({ query, variables });
  const maxAttempts = 3;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (resp.status === 429 || resp.status >= 500) {
        throw new Error(`Snapshot HTTP ${resp.status}`);
      }
      if (!resp.ok) {
        throw new Error(`Snapshot HTTP ${resp.status} (non-retryable)`);
      }
      const json = (await resp.json()) as any;
      if (json.errors) throw new Error(`Snapshot: ${json.errors[0].message}`);
      return json;
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      const retryable =
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('EAI_AGAIN') ||
        msg.includes('fetch failed') ||
        msg.includes('HTTP 429') ||
        /HTTP 5\d\d/.test(msg);
      if (!retryable || attempt === maxAttempts) break;
      const delayMs = 1000 * Math.pow(2, attempt - 1);
      if (verbose) {
        // eslint-disable-next-line no-console
        console.warn(`  [snapshot] attempt ${attempt}/${maxAttempts} failed (${msg}); retrying in ${delayMs}ms`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr || new Error('Snapshot: unknown error');
}

/**
 * Fetch top-N voters from a Snapshot space via GraphQL.
 * Returns voter addresses sorted by voting-power participation.
 *
 * Uses last 100 proposals as voter discovery window.
 */
async function fetchSnapshotTopVoters(space: string, topN: number, verbose = false): Promise<string[]> {
  const query = `
    query($space: String!) {
      proposals(where: {space: $space, state: "closed"}, first: 100, orderBy: "created", orderDirection: desc) {
        id
      }
    }
  `;
  const propJson = await snapshotGraphQL(query, { space }, verbose);
  const proposalIds = (propJson.data?.proposals || []).map((p: any) => p.id);
  if (proposalIds.length === 0) return [];

  const votesQuery = `
    query($proposals: [String!]!) {
      votes(where: {proposal_in: $proposals}, first: 1000, orderBy: "vp", orderDirection: desc) {
        voter vp
      }
    }
  `;
  const votesJson = await snapshotGraphQL(votesQuery, { proposals: proposalIds }, verbose);

  // Aggregate VP per voter
  const voterVp = new Map<string, number>();
  for (const v of votesJson.data?.votes || []) {
    const prev = voterVp.get(v.voter) || 0;
    voterVp.set(v.voter, prev + (v.vp || 0));
  }

  // Sort by total VP descending, take top-N
  return Array.from(voterVp.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([addr]) => addr);
}

/**
 * Classify a single voter as EOA vs proxy-candidate via code-presence check.
 * Exported for unit testing.
 *
 * @param code raw bytecode returned by eth_getCode (e.g. "0x" for EOA)
 * @returns classification
 */
export function classifyVoterByCode(code: string): VoterClass {
  if (!code || code === '0x' || code === '0x0') return 'eoa';
  // Minimal proxy bytecode (EIP-1167) is ~45 bytes; any code > 2 chars ("0x") is contract.
  if (code.length > 2) return 'proxy-candidate';
  return 'unknown';
}

/**
 * HB#834 v1.3: owner-resolution for proxy voters.
 * Given a proxy family + address, attempt to enumerate the underlying owners
 * via family-specific ABI calls. Returns null on failure (RPC error, ABI mismatch,
 * or unsupported family).
 *
 * Currently supports:
 *   - 'safe-proxy': Gnosis Safe getOwners() returning address[]
 *   - 'dsproxy-maker': Maker DSProxy owner() returning address (wraps in [])
 * Other families return null (EIP-1167 requires implementation-slot read; out of scope for v1.3).
 */
export async function resolveProxyOwners(
  provider: ethers.providers.Provider,
  address: string,
  family: ProxyFamily,
): Promise<string[] | null> {
  if (family === 'safe-proxy') {
    const abi = ['function getOwners() view returns (address[])'];
    const safe = new ethers.Contract(address, abi, provider);
    try {
      const owners = await safe.getOwners();
      return owners.map((a: string) => a.toLowerCase());
    } catch {
      return null;
    }
  }
  if (family === 'dsproxy-maker') {
    // HB#476 vigil investigation: Maker 3947-byte proxies exposed neither owner()
    // (sentinel original attempt) nor cold()/hot() (vigil attempted fix). Direct
    // probe shows call reverts on all 3 common DSProxy ABIs. Contract type is
    // IDENTIFIED by bytecode signature but its exact OWNERSHIP INTERFACE is
    // unresolved. Likely custom proxy contract NOT standard Maker VoteProxy.
    // Best available: try each ABI in priority order, return null on all-fail.
    const attempts = [
      { abi: ['function cold() view returns (address)', 'function hot() view returns (address)'], call: async (c: any) => {
        const [cold, hot] = await Promise.all([c.cold(), c.hot()]);
        return [cold.toLowerCase(), hot.toLowerCase()];
      }},
      { abi: ['function owner() view returns (address)'], call: async (c: any) => {
        const o = await c.owner();
        return [o.toLowerCase()];
      }},
    ];
    for (const { abi, call } of attempts) {
      try {
        const c = new ethers.Contract(address, abi, provider);
        return await call(c);
      } catch { /* try next */ }
    }
    return null;
  }
  return null;
}

/**
 * Classify a contract's bytecode into a known proxy family by size + signature.
 * Returns 'none' for EOAs, 'other-contract' for contracts not matching known patterns.
 *
 * Size-based heuristics are empirical (derived from HB#409 Maker Chief finding,
 * HB#832 Uniswap multisig observation, EIP-1167 standard).
 *
 * Exported for unit testing.
 */
export function classifyProxyFamily(code: string): ProxyFamily {
  if (!code || code === '0x' || code === '0x0') return 'none';
  const codeSize = (code.length - 2) / 2;

  // EIP-1167 minimal proxy: exactly 45 bytes, starts with the deterministic signature
  // 0x363d3d373d3d3d363d73<20-byte target>5af43d82803e903d91602b57fd5bf3
  if (codeSize === 45 && code.toLowerCase().startsWith('0x363d3d373d3d3d363d73')) {
    return 'eip-1167';
  }

  // Maker VoteProxyFactory DSProxy: deterministic 3947-byte bytecode
  // per HB#409 vigil finding (all 5 Chief top-voters had identical 3947-byte code).
  if (codeSize === 3947) {
    return 'dsproxy-maker';
  }

  // Gnosis Safe SafeProxy forwarder: typically 170-175 bytes (small delegatecall stub).
  // Uniswap voter-5 observation HB#832: 170 bytes exactly.
  if (codeSize >= 168 && codeSize <= 180) {
    return 'safe-proxy';
  }

  return 'other-contract';
}

/**
 * Aggregate per-voter classifications into a proxy-share percentage.
 * proxy-share = proxy-candidate count / total classified voters.
 * Exported for unit testing.
 */
export function computeProxyShare(classes: VoterClass[]): {
  summary: Record<VoterClass, number>;
  proxyShare: number;
} {
  const summary: Record<VoterClass, number> = { eoa: 0, 'proxy-candidate': 0, unknown: 0 };
  for (const c of classes) summary[c]++;
  const total = summary.eoa + summary['proxy-candidate'];
  const proxyShare = total > 0 ? summary['proxy-candidate'] / total : 0;
  return { summary, proxyShare: parseFloat(proxyShare.toFixed(3)) };
}

/**
 * Classify DAO E-proxy status from proxy-share + voter count.
 * - proxy-share > 0.5 AND voters ≥ 5: E-proxy-identity-obfuscating
 * - proxy-share <= 0.5 AND voters ≥ 5: not-E-proxy
 * - voters < 5: inconclusive (small-sample caveat)
 */
export function classifyDao(
  proxyShare: number,
  totalVoters: number
): 'E-proxy-identity-obfuscating' | 'not-E-proxy' | 'inconclusive' {
  if (totalVoters < 5) return 'inconclusive';
  return proxyShare > 0.5 ? 'E-proxy-identity-obfuscating' : 'not-E-proxy';
}

export const auditProxyFactoryHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('address', {
        type: 'string',
        describe: 'Governance contract address (e.g. Maker Chief). Exclusive with --space.',
      })
      .option('space', {
        type: 'string',
        describe: 'Snapshot space ID (voter list sourced from Snapshot). Exclusive with --address.',
      })
      .option('voters', {
        type: 'string',
        describe: 'Comma-separated voter addresses to classify (overrides --address/--space voter discovery)',
      })
      .option('chain', {
        type: 'number',
        default: 1,
        describe: 'Chain ID for on-chain code reads (default: 1 = mainnet)',
      })
      .option('rpc', {
        type: 'string',
        describe: 'RPC URL override',
      })
      .option('governance-token', {
        type: 'string',
        describe: 'Optional governance token address. If set, safe-proxy voters are annotated with v2.1.9 E-proxy-multisig Variant A (token-holding) vs B (delegation-receipt) via balanceOf(voter).',
      })
      .option('governance-token-chain', {
        type: 'number',
        describe: 'Chain ID for --governance-token queries. Defaults to --chain. Use a different chain for cross-chain DAOs (e.g. --chain 1 + --governance-token-chain 42161 for Arbitrum L2 token + L1 signer-Safe).',
      })
      .option('governance-token-rpc', {
        type: 'string',
        describe: 'RPC URL override for --governance-token-chain (optional, falls back to resolved config).',
      })
      .check((argv) => {
        if (!argv.address && !argv.space && !argv.voters) {
          throw new Error('Must provide --address, --space, or --voters');
        }
        if (argv.governanceToken && !ethers.utils.isAddress(argv.governanceToken as string)) {
          throw new Error(`--governance-token must be a valid address, got: ${argv.governanceToken}`);
        }
        return true;
      }),

  handler: async (argv: ArgumentsCamelCase<AuditProxyFactoryArgs>) => {
    const spin = output.spinner(`Auditing E-proxy factory patterns...`);
    spin.start();

    try {
      const chainId = (argv.chain as number) || 1;
      const target = argv.address || argv.space || argv.voters || 'unknown';
      const network = resolveNetworkConfig(chainId);
      const rpcUrl = argv.rpc || network.resolvedRpc;
      // HB#469 vigil bug fix: JsonRpcProvider auto-detection fails silently on
      // some public RPCs. Use StaticJsonRpcProvider with explicit chainId to
      // skip auto-detection.
      const provider = new ethers.providers.StaticJsonRpcProvider(
        rpcUrl,
        { chainId, name: network.name || `chain-${chainId}` },
      );

      // Voter discovery:
      //   1. --voters: explicit comma-separated list (scaffold behavior)
      //   2. --space: Snapshot space, fetch top-N voters via GraphQL (HB#824 addition)
      //   3. --address: governance-contract event scan (deferred HB#825+)
      let voterAddresses: string[] = [];
      let discoverySource: string = 'explicit';
      if (argv.voters) {
        voterAddresses = argv.voters.split(',').map((a) => a.trim()).filter(Boolean);
        discoverySource = 'explicit';
      } else if (argv.space) {
        spin.text = `Fetching top-5 voters for Snapshot space ${argv.space}...`;
        voterAddresses = await fetchSnapshotTopVoters(argv.space, 5, argv.verbose === true);
        discoverySource = `snapshot:${argv.space}`;
        if (voterAddresses.length === 0) {
          // retro-839 change-5: empty result can be a cache-miss race on re-runs.
          // Wait 2s and retry once before declaring the space voter-less.
          spin.text = `No voters returned; retrying in 2s (cache-miss fallback)...`;
          await new Promise((r) => setTimeout(r, 2000));
          voterAddresses = await fetchSnapshotTopVoters(argv.space, 5, argv.verbose === true);
        }
        if (voterAddresses.length === 0) {
          spin.stop();
          output.error(`No voters found for Snapshot space "${argv.space}" (after retry)`);
          process.exit(1);
        }
      } else {
        spin.stop();
        const result: ProxyFactoryAuditResult = {
          target,
          chainId,
          status: 'scaffold',
          note: 'Voter discovery from --address requires governance-contract event scan (HB#825+). Use --space for Snapshot voter list OR --voters for explicit addresses.',
        };
        if (argv.json) {
          output.json(result);
        } else {
          output.info(`audit-proxy-factory (scaffold): ${JSON.stringify(result, null, 2)}`);
        }
        return;
      }

      // Classify each voter via eth_getCode
      spin.text = `Classifying ${voterAddresses.length} voters...`;
      const governanceToken = argv.governanceToken as string | undefined;
      // HB#489 cross-chain: allow governance-token queries against a different chain
      // (e.g. ARB on L2 while signer-Safes are on L1). Defaults to voter-chain.
      let tokenProvider = provider;
      const tokenChainId = argv.governanceTokenChain as number | undefined;
      if (governanceToken && tokenChainId && tokenChainId !== chainId) {
        const tokenNetwork = resolveNetworkConfig(tokenChainId);
        const tokenRpcUrl = (argv.governanceTokenRpc as string | undefined) || tokenNetwork.resolvedRpc;
        tokenProvider = new ethers.providers.StaticJsonRpcProvider(
          tokenRpcUrl,
          { chainId: tokenChainId, name: tokenNetwork.name || `chain-${tokenChainId}` },
        );
      }
      const classified = await Promise.all(
        voterAddresses.map(async (addr) => {
          try {
            const code = await provider.getCode(addr);
            const cls = classifyVoterByCode(code);
            const family = classifyProxyFamily(code);
            const ownersResolved = await resolveProxyOwners(provider, addr, family);
            const variantInfo =
              governanceToken && family === 'safe-proxy'
                ? await classifyMultisigVariant(tokenProvider, addr, governanceToken)
                : null;
            return {
              address: addr,
              class: cls,
              codeSize: code ? (code.length - 2) / 2 : 0,
              family,
              ...(ownersResolved ? { owners: ownersResolved } : {}),
              ...(variantInfo
                ? { multisigVariant: variantInfo.variant, governanceTokenBalance: variantInfo.balance }
                : {}),
            };
          } catch (e: any) {
            if (argv.verbose) console.error(`[audit-proxy-factory] getCode(${addr}) error:`, e?.message || e);
            return { address: addr, class: 'unknown' as VoterClass, codeSize: 0, family: 'none' as ProxyFamily };
          }
        })
      );

      const { summary, proxyShare } = computeProxyShare(classified.map((v) => v.class));
      const classification = classifyDao(proxyShare, voterAddresses.length);
      const familySummary: Record<ProxyFamily, number> = {
        'eip-1167': 0, 'dsproxy-maker': 0, 'safe-proxy': 0, 'other-contract': 0, 'none': 0,
      };
      for (const v of classified) familySummary[v.family]++;

      const result: ProxyFactoryAuditResult = {
        target,
        chainId,
        status: 'partial',
        voters: classified,
        classSummary: summary,
        familySummary,
        proxyShare,
        classification,
        note: `Voter discovery: ${discoverySource}. Factory-pattern detection + proxy→owner resolution deferred to future work.`,
      };

      spin.stop();

      if (argv.json) {
        output.json(result);
      } else {
        output.success(`audit-proxy-factory: ${target}`, {
          voters: voterAddresses.length,
          eoa: summary.eoa,
          proxyCandidates: summary['proxy-candidate'],
          proxyShare: `${(proxyShare * 100).toFixed(1)}%`,
          classification,
        });
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
