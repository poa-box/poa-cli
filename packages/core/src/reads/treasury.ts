/**
 * Treasury reads — typed wrappers over graph/documents/treasury.
 *
 * Serves the read paths of `pop treasury view` (src/commands/treasury/view.ts),
 * `pop treasury distributions` (src/commands/treasury/distributions.ts), the
 * distribution lookups of `pop treasury claim` / `claim-mine`, and the member
 * snapshots that `compute-merkle` / `claim-mine` build merkle trees from.
 *
 * Read-sourcing policy (inherited from the CLI, comments load-bearing):
 *   - display reads (view / distributions) are pure subgraph
 *   - `distribution(id:)` answers null — NOT an error — for an id it has not
 *     indexed, and a brand-new distribution is exactly the case where someone
 *     claims early. Callers MUST treat null as "not indexed yet" and fall back
 *     to PaymentManager.getDistribution, never render it as DistributionNotFound.
 *   - the write-gating twins (hasClaimed / isOptedOut / getDistribution as a
 *     revert predictor) stay on RPC in the host. isOptedOut in particular has
 *     no trustworthy indexed twin: the OptOutToggle table has ZERO rows on all
 *     nine live Gnosis PaymentManagers (verified 2026-07) because zero
 *     OptOutToggled events have ever been emitted, so the mapping is
 *     unexercised and no live row proves it indexes correctly.
 */

import { ethers } from 'ethers';
import type { GraphClient } from '../graph/client';
import {
  FETCH_TREASURY_DATA,
  FETCH_DISTRIBUTION_BY_ID,
  FETCH_ACTIVE_DISTRIBUTIONS,
  distributionEntityId,
} from '../graph/documents/treasury';
import { resolveOrgId } from './resolve';
import { createReadContract } from '../contracts';
import { getNetworkByChainId, getTokenByAddress } from '../chains';

export { distributionEntityId };

// ---------------------------------------------------------------------------
// Raw subgraph entity shapes (as FETCH_TREASURY_DATA returns them)
// ---------------------------------------------------------------------------

export interface DistributionClaimRow {
  id: string;
  claimer: string;
  claimerUsername: string | null;
  amount: string;
  claimedAt: string;
  transactionHash: string;
}

export interface DistributionRow {
  id: string;
  distributionId: string;
  payoutToken: string;
  totalAmount: string;
  totalClaimed: string;
  checkpointBlock: string;
  createdAtBlock: string | null;
  merkleRoot: string;
  /** Enum is exactly Active | Finalized. */
  status: 'Active' | 'Finalized' | string;
  createdAt: string | null;
  finalizedAt: string | null;
  unclaimedAmount: string | null;
  claims: DistributionClaimRow[];
}

export interface PaymentRow {
  id: string;
  payer: string;
  payerUsername: string | null;
  amount: string;
  token: string;
  receivedAt: string;
  transactionHash: string;
}

export interface TreasuryData {
  id: string;
  executorContract: {
    id: string;
    isPaused: boolean;
    owner: string | null;
    allowedCaller: string | null;
    sweeps: Array<{ id: string; to: string; amount: string; sweptAt: string; transactionHash: string }>;
  } | null;
  participationToken: { id: string; name: string; symbol: string; totalSupply: string } | null;
  paymentManager: {
    id: string;
    owner: string | null;
    revenueShareToken: string | null;
    distributionCounter: string;
    distributions: DistributionRow[];
    payments: PaymentRow[];
  } | null;
}

/**
 * Full treasury overview — subgraph read behind `pop treasury view`
 * (src/commands/treasury/view.ts) and `pop treasury distributions`
 * (src/commands/treasury/distributions.ts). Returns the raw organization
 * entity; null when the org is unknown on this chain.
 */
export async function fetchTreasuryData(
  client: GraphClient,
  orgIdOrName: string | undefined,
  chainId?: number
): Promise<TreasuryData | null> {
  const orgId = await resolveOrgId(client, orgIdOrName, chainId);
  const result = await client.query<{ organization: TreasuryData | null }>(
    FETCH_TREASURY_DATA,
    { orgId },
    chainId
  );
  return result.organization ?? null;
}

/**
 * Distribution list, optionally filtered by status — the selection behind
 * `pop treasury distributions --status ...`.
 */
export async function listDistributions(
  client: GraphClient,
  orgIdOrName: string | undefined,
  chainId?: number,
  status?: 'Active' | 'Finalized'
): Promise<DistributionRow[]> {
  const org = await fetchTreasuryData(client, orgIdOrName, chainId);
  let distributions = org?.paymentManager?.distributions ?? [];
  if (status) distributions = distributions.filter((d) => d.status === status);
  return distributions;
}

export interface IndexedDistribution {
  id: string;
  distributionId: string;
  /** Re-checksummed at the boundary (the subgraph stores addresses lowercased,
   * while the ABI-decoded getDistribution() path yields EIP-55 — without this
   * the value silently changes case depending on whether the distribution
   * happens to be indexed). */
  payoutToken: string;
  totalAmount: string;
  totalClaimed: string;
  checkpointBlock: string;
  /** The contract has NO getter for this — subgraph-only field. */
  createdAtBlock: string | null;
  merkleRoot: string;
  status: 'Active' | 'Finalized' | string;
  /** Derived exactly like `pop treasury claim` does: status === 'Finalized'.
   * The enum only becomes Finalized once DistributionFinalized is indexed, so
   * a false positive is impossible; a stale Active is caught at gas estimation. */
  finalized: boolean;
}

/**
 * One distribution by (paymentManager, distributionId) — the indexed twin of
 * PaymentManager.getDistribution(), read behind `pop treasury claim`
 * (src/commands/treasury/claim.ts).
 *
 * Returns null when the subgraph has not indexed the id — callers MUST fall
 * back to getDistribution() on-chain, never treat null as DistributionNotFound.
 */
export async function fetchDistributionById(
  client: GraphClient,
  paymentManagerAddress: string,
  distributionId: number | string,
  chainId?: number
): Promise<IndexedDistribution | null> {
  const result = await client
    .query<{ distribution: any }>(
      FETCH_DISTRIBUTION_BY_ID,
      { id: distributionEntityId(paymentManagerAddress, distributionId) },
      chainId
    )
    .catch(() => ({ distribution: null }));
  const indexed = result.distribution;
  if (!indexed) return null;
  return {
    ...indexed,
    payoutToken: ethers.utils.getAddress(indexed.payoutToken),
    finalized: indexed.status === 'Finalized',
  };
}

export interface ActiveDistributionRow {
  distributionId: string;
  totalAmount: string;
  merkleRoot: string;
  checkpointBlock: string;
  payoutToken: string;
  claims: Array<{ claimer: string }>;
}

/**
 * Every still-claimable distribution with its claim log — the read behind
 * `pop treasury claim-mine` (src/commands/treasury/claim-mine.ts).
 */
export async function fetchActiveDistributions(
  client: GraphClient,
  orgIdOrName: string | undefined,
  chainId?: number
): Promise<ActiveDistributionRow[]> {
  const orgId = await resolveOrgId(client, orgIdOrName, chainId);
  const result = await client.query<{
    organization: { paymentManager: { distributions: ActiveDistributionRow[] } | null } | null;
  }>(FETCH_ACTIVE_DISTRIBUTIONS, { orgId }, chainId);
  return result.organization?.paymentManager?.distributions ?? [];
}

// ---------------------------------------------------------------------------
// Member snapshots for merkle building / reconstruction
// ---------------------------------------------------------------------------

/**
 * Members + PT balances at the CURRENT head — the builder snapshot used by
 * `pop treasury compute-merkle` (src/commands/treasury/compute-merkle.ts).
 * Ordered by PT balance desc: the dust-to-largest-holder rule depends on
 * allocations[0] being the largest holder.
 */
export const FETCH_MEMBERS_PT = `
  query FetchMembersPT($orgId: Bytes!) {
    organization(id: $orgId) {
      users(
        orderBy: participationTokenBalance,
        orderDirection: desc,
        first: 1000
      ) {
        address
        participationTokenBalance
        membershipStatus
        account {
          username
        }
      }
      participationToken {
        totalSupply
      }
    }
  }
`;

/**
 * Members AND opt-out state as of a distribution's checkpoint block — the
 * reconstruction snapshot used by `pop treasury claim-mine`
 * (src/commands/treasury/claim-mine.ts).
 *
 * Both halves are block-scoped on purpose. `pop treasury compute-merkle`
 * excludes opted-out members when it BUILDS the tree (the only place opt-out
 * is enforced since audit L-19), so reconstructing that tree has to reproduce
 * the opt-out set as it was AT BUILD TIME. Using current opt-out state instead
 * would rebuild a different tree the moment anyone toggles after a
 * distribution is created, and every member would get "Root mismatch" for a
 * valid distribution. compute-merkle sets checkpointBlock to the build block,
 * so this is that state.
 *
 * optOutToggles is a TOP-LEVEL entity, so it MUST be scoped to this org's
 * PaymentManager. Unfiltered it returns toggles from every PaymentManager the
 * subgraph indexes (nine on Gnosis today), and any address that opted out of a
 * DIFFERENT org would be dropped from this org's tree — producing a spurious
 * "Root mismatch" that tells every member they cannot claim.
 */
export const FETCH_MEMBERS_AT_BLOCK = `
  query FetchMembersAtBlock($orgId: Bytes!, $block: Int!, $paymentManager: String!) {
    organization(id: $orgId, block: { number: $block }) {
      participationToken { totalSupply }
      users(orderBy: participationTokenBalance, orderDirection: desc, first: 1000) {
        address
        participationTokenBalance
        membershipStatus
      }
    }
    optOutToggles(
      block: { number: $block }
      where: { paymentManager: $paymentManager }
      first: 1000
      orderBy: toggledAtBlock
      orderDirection: asc
    ) {
      user
      optedOut
      toggledAtBlock
    }
  }
`;

export interface MemberPtRow {
  address: string;
  participationTokenBalance: string;
  membershipStatus: string;
  account?: { username: string | null } | null;
}

export interface OptOutToggleRow {
  user: string;
  optedOut: boolean;
  toggledAtBlock: string;
}

/** Current-head member snapshot (compute-merkle builder input). */
export async function fetchMembersPT(
  client: GraphClient,
  orgId: string,
  chainId?: number
): Promise<{ users: MemberPtRow[]; totalSupply: string } | null> {
  const result = await client.query<{
    organization: { users: MemberPtRow[]; participationToken: { totalSupply: string } | null } | null;
  }>(FETCH_MEMBERS_PT, { orgId }, chainId);
  const org = result.organization;
  if (!org) return null;
  return { users: org.users ?? [], totalSupply: org.participationToken?.totalSupply ?? '0' };
}

/** Block-pinned member + opt-out snapshot (claim-mine reconstruction input). */
export async function fetchMembersAtBlock(
  client: GraphClient,
  orgId: string,
  block: number,
  paymentManagerAddress: string,
  chainId?: number
): Promise<{ users: MemberPtRow[]; totalSupply: string; optOutToggles: OptOutToggleRow[] } | null> {
  const result = await client.query<{
    organization: { users: MemberPtRow[]; participationToken: { totalSupply: string } | null } | null;
    optOutToggles: OptOutToggleRow[];
  }>(
    FETCH_MEMBERS_AT_BLOCK,
    { orgId, block, paymentManager: paymentManagerAddress.toLowerCase() },
    chainId
  );
  const org = result.organization;
  if (!org) return null;
  return {
    users: org.users ?? [],
    totalSupply: org.participationToken?.totalSupply ?? '0',
    optOutToggles: result.optOutToggles ?? [],
  };
}

/**
 * Latest toggle per user wins — the log is ascending, so the last write for an
 * address is its state at the pinned block. Pure port of the fold in
 * `pop treasury claim-mine`.
 */
export function optedOutSetFromToggles(toggles: OptOutToggleRow[]): Set<string> {
  const optedOut = new Set<string>();
  for (const t of toggles ?? []) {
    const addr = String(t.user).toLowerCase();
    if (t.optedOut) optedOut.add(addr);
    else optedOut.delete(addr);
  }
  return optedOut;
}

// ---------------------------------------------------------------------------
// Payout token metadata
// ---------------------------------------------------------------------------

export interface PayoutTokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  isNative: boolean;
}

/**
 * Resolve a distribution payout token to human units — port of
 * resolvePayoutTokenInfo in src/commands/treasury/helpers.ts (shared by claim,
 * claim-mine, propose-distribution and propose-finalize so amounts render
 * identically).
 *
 * PaymentManager uses address(0) for the chain's native token (verified:
 * claimDistribution transfers raw value when payoutToken == address(0));
 * ERC20s are resolved via a live decimals()/symbol() read with the known-token
 * table then an 18-decimals default as fallbacks. RPC on purpose: the subgraph
 * does not index arbitrary ERC20s. When no provider is supplied the live read
 * is skipped and the table/default fallback applies directly.
 */
export async function resolvePayoutTokenInfo(
  provider: ethers.providers.Provider | undefined,
  tokenAddress: string,
  chainId?: number
): Promise<PayoutTokenInfo> {
  if (!tokenAddress || tokenAddress === ethers.constants.AddressZero) {
    const native = getNetworkByChainId(chainId ?? 0)?.nativeCurrency?.symbol ?? 'native';
    return { address: ethers.constants.AddressZero, symbol: native, decimals: 18, isNative: true };
  }

  const known = getTokenByAddress(tokenAddress);
  let decimals = known?.decimals;
  let symbol = known?.symbol;
  if (provider) {
    try {
      const erc20 = createReadContract(tokenAddress, 'ERC20', provider);
      const [liveDecimals, liveSymbol] = await Promise.all([
        erc20.decimals(),
        erc20.symbol().catch(() => undefined),
      ]);
      decimals = Number(liveDecimals);
      symbol = liveSymbol ?? symbol;
    } catch {
      // Live read failed — fall back to the known-token table / 18.
    }
  }
  return {
    address: tokenAddress,
    symbol: symbol ?? 'tokens',
    decimals: decimals ?? 18,
    isNative: false,
  };
}
