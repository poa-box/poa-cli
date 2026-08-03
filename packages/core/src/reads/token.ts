/**
 * Participation-token reads — typed wrappers over graph/documents/token.
 *
 * Serves the read paths of `pop token balance` (src/commands/token/balance.ts)
 * and `pop token requests` (src/commands/token/requests.ts), plus the
 * subgraph half of the token-address resolution in
 * src/commands/token/helpers.ts.
 *
 * NOT ported here (deliberately — see the header of
 * src/commands/token/helpers.ts): readTokenGates / checkWearsAnyHat /
 * readTokenRequest. Those are provider-bound revert predictors that MUST stay
 * on RPC: ParticipationTokenContract.executor/.hatsContract are the zero
 * address on all live subgraph rows, memberHatIds/approverHatIds are not
 * indexed at all, and requests(id) is the existence/state gate evaluated
 * immediately before a write — subgraph lag there means knowingly
 * broadcasting a doomed transaction.
 */

import type { GraphClient } from '../graph/client';
import {
  FETCH_TOKEN_BALANCE,
  FETCH_PENDING_TOKEN_REQUESTS,
  FETCH_ALL_TOKEN_REQUESTS,
  FETCH_USER_TOKEN_REQUESTS,
  tokenBalanceId,
} from '../graph/documents/token';
import { resolveOrgModules, requireModule } from './resolve';

/**
 * Resolve an org (name or hex ID) to its ParticipationToken address.
 * Port of resolveTokenAddress in src/commands/token/helpers.ts — the
 * subgraph-only half of that file (the hat-gate readers stay in the CLI).
 */
export async function resolveParticipationToken(
  client: GraphClient,
  orgIdOrName: string | undefined,
  chainId?: number
): Promise<{ orgId: string; tokenAddress: string }> {
  const modules = await resolveOrgModules(client, orgIdOrName, chainId);
  return {
    orgId: modules.orgId,
    tokenAddress: requireModule(modules, 'participationTokenAddress'),
  };
}

/**
 * Indexed balance snapshot for one holder.
 *
 * `balanceWei === null` means NO INDEXED ROW — not a zero balance. A missing
 * TokenBalance row and a genuine zero are indistinguishable from the subgraph
 * alone, so callers that must tell them apart settle it with an on-chain
 * balanceOf (the CLI keeps that RPC fallback; see `pop token balance`).
 */
export interface TokenBalanceSnapshot {
  tokenAddress: string;
  /** Indexed ERC20 symbol ('PT', 'KUBIX', ... — populated on every live row), or null when the token contract is not indexed. */
  symbol: string | null;
  /** 18-decimal wei balance as a decimal string, or null when no row is indexed for this holder. */
  balanceWei: string | null;
  /** Unix seconds of the last indexed balance change, or null when no row. */
  updatedAt: string | null;
}

/**
 * Subgraph read behind `pop token balance` — src/commands/token/balance.ts.
 * TokenBalance mirrors ERC20 balanceOf exactly (verified live: the sum of a
 * token's TokenBalance rows equals its indexed totalSupply).
 */
export async function getTokenBalance(
  client: GraphClient,
  tokenAddress: string,
  holder: string,
  chainId?: number
): Promise<TokenBalanceSnapshot> {
  const data = await client.query<{
    participationTokenContract: { id: string; symbol: string | null } | null;
    tokenBalance: { id: string; balance: string; updatedAt: string } | null;
  }>(
    FETCH_TOKEN_BALANCE,
    { token: tokenAddress.toLowerCase(), balanceId: tokenBalanceId(tokenAddress, holder) },
    chainId
  );

  const symbol = data?.participationTokenContract?.symbol
    ? String(data.participationTokenContract.symbol)
    : null;
  const balanceWei =
    data?.tokenBalance?.balance !== null && data?.tokenBalance?.balance !== undefined
      ? String(data.tokenBalance.balance)
      : null;
  const updatedAt = data?.tokenBalance?.updatedAt !== undefined && data?.tokenBalance?.updatedAt !== null
    ? String(data.tokenBalance.updatedAt)
    : null;

  return { tokenAddress, symbol, balanceWei, updatedAt };
}

/**
 * Raw indexed token-request row. Field availability depends on the query that
 * served it: the pending query carries `createdAtBlock` but not the
 * resolution fields; the all/user queries carry
 * `approvedAt`/`cancelledAt`/`approver` but not `createdAtBlock`; the
 * user-scoped query omits `requester` (it is the filter). `metadata` is the
 * indexed {reason, submittedAt} document and may be null when the IPFS
 * document was not resolvable at indexing time.
 */
export interface TokenRequestRow {
  id: string;
  requestId: string;
  requester?: string;
  /** 18-decimal wei as a decimal string. */
  amount: string;
  ipfsHash: string;
  metadata: { reason: string | null; submittedAt: string | null } | null;
  status: string;
  createdAt: string;
  createdAtBlock?: string;
  approvedAt?: string | null;
  cancelledAt?: string | null;
  approver?: string | null;
  transactionHash?: string | null;
}

/**
 * List token requests for a ParticipationToken.
 * Subgraph read behind `pop token requests` — src/commands/token/requests.ts
 * (`status: 'pending'` ⇒ FETCH_PENDING_TOKEN_REQUESTS, `'all'` ⇒
 * FETCH_ALL_TOKEN_REQUESTS; pending is the CLI default).
 */
export async function listTokenRequests(
  client: GraphClient,
  tokenAddress: string,
  opts?: { status?: 'pending' | 'all'; chainId?: number }
): Promise<TokenRequestRow[]> {
  const gqlQuery = opts?.status === 'all' ? FETCH_ALL_TOKEN_REQUESTS : FETCH_PENDING_TOKEN_REQUESTS;
  const result = await client.query<{ tokenRequests: TokenRequestRow[] | null }>(
    gqlQuery,
    { tokenAddress },
    opts?.chainId
  );
  return result.tokenRequests || [];
}

/**
 * One requester's token-request history (newest first, max 50) —
 * FETCH_USER_TOKEN_REQUESTS from graph/documents/token. Rows omit
 * `requester` (it is the filter variable).
 */
export async function listUserTokenRequests(
  client: GraphClient,
  tokenAddress: string,
  userAddress: string,
  chainId?: number
): Promise<TokenRequestRow[]> {
  const result = await client.query<{ tokenRequests: TokenRequestRow[] | null }>(
    FETCH_USER_TOKEN_REQUESTS,
    { tokenAddress, userAddress: userAddress.toLowerCase() },
    chainId
  );
  return result.tokenRequests || [];
}
