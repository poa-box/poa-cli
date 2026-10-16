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
import { knownFact, requireCompleteSnapshot, unknownFact, type Fact, type SourceSnapshot } from '../data/facts';
import { checkedIndexedTotalQuery, indexedTotalCoverage, indexedTotalIssue, readIndexedTotalState, requireIndexedTotalOptions, type IndexedTotalOptions } from '../data/indexed-completeness';
import { FETCH_TOKEN_HOLDER_TOTAL_PAGE, FETCH_TOKEN_HOLDER_TOTAL_STATE } from '../graph/documents/indexed-completeness';
import { requireRawUint } from '../amounts';
import { readIndexedPageFacts, type IndexedRow } from './protocol';

export interface TokenHolderTotals {
  holders: readonly { account: string; balanceRaw: string }[];
  observedCount: string;
  observedBalanceRaw: string;
  total: Fact<string>;
  balanceTotalRaw: Fact<string>;
  evidence: { state: SourceSnapshot<IndexedRow | null>; balances: SourceSnapshot<readonly IndexedRow[]> };
}

/** All current TokenBalance rows, including zero rows for supply reconciliation.
 * Only positive balances add holders. The exact raw sum must equal totalSupply
 * at the SAME proven block before either total becomes known. */
export async function readTokenHolderTotals(input: IndexedTotalOptions): Promise<SourceSnapshot<TokenHolderTotals>> {
  requireIndexedTotalOptions(input);
  if (!input.source.orgId || !/^0x[\da-f]{64}$/i.test(input.source.orgId)) throw new Error('HOLDER_ORGANIZATION_SCOPE_REQUIRED');
  const token = input.source.contract!.toLowerCase(), orgId = input.source.orgId.toLowerCase();
  const options = { ...input, query: checkedIndexedTotalQuery(input.query) };
  const state = await readIndexedTotalState(options, FETCH_TOKEN_HOLDER_TOTAL_STATE, { token }, 'participationTokenContract', token);
  const valid = new Set<IndexedRow>();
  const balances = await readIndexedPageFacts({ ...options, document: FETCH_TOKEN_HOLDER_TOTAL_PAGE, collection: 'tokenBalances', variables: { token }, initialCursor: '',
    validateRow: row => {
      const relation = row.participationToken as IndexedRow;
      if (relation?.id?.toString().toLowerCase() !== token || (relation.organization as IndexedRow)?.id?.toString().toLowerCase() !== orgId
        || typeof row.account !== 'string' || !/^0x[\da-f]{40}$/i.test(row.account) || /^0x0{40}$/i.test(row.account)
        || row.id !== tokenBalanceId(token, row.account)) throw new Error('HOLDER_ROW_SCOPE_MISMATCH');
      requireRawUint(row.balance as string);
      if (BigInt(requireRawUint(row.updatedAtBlock as string)) > BigInt(input.source.block!.number)) throw new Error('HOLDER_ROW_AFTER_SNAPSHOT');
      valid.add(row);
    } });
  const holders: { account: string; balanceRaw: string }[] = [];
  let balance = 0n;
  for (const row of balances.data) if (valid.has(row)) {
    const raw = requireRawUint(row.balance as string); balance += BigInt(raw);
    if (raw !== '0') holders.push({ account: String(row.account).toLowerCase(), balanceRaw: raw });
  }
  const issues: { code: string }[] = [];
  try {
    const contract = requireCompleteSnapshot(state, { scope: input.source, indexed: true, snapshot: 'pinned', block: input.source.block });
    if (!contract || contract.id !== token || (contract.organization as IndexedRow)?.id?.toString().toLowerCase() !== orgId) throw new Error('HOLDER_TOKEN_SCOPE_MISMATCH');
    if (requireRawUint(contract.totalSupply as string) !== balance.toString()) throw new Error('TOKEN_SUPPLY_RECONCILIATION_FAILED');
  } catch (error) { issues.push(indexedTotalIssue(error)); }
  const coverage = indexedTotalCoverage({ state, balances }, issues), observedCount = String(holders.length), observedBalanceRaw = balance.toString();
  const source = balances.source.snapshot === 'pinned' ? balances.source : state.source;
  return { source, coverage, data: { holders, observedCount, observedBalanceRaw,
    total: coverage.status === 'complete' ? knownFact(observedCount, source) : unknownFact('HOLDER_TOTAL_INCOMPLETE', source),
    balanceTotalRaw: coverage.status === 'complete' ? knownFact(observedBalanceRaw, source) : unknownFact('HOLDER_TOTAL_INCOMPLETE', source), evidence: { state, balances } } };
}

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
