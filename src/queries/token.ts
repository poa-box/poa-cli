/**
 * Token Request Queries
 * Ported from frontend queries.js
 */

export const FETCH_PENDING_TOKEN_REQUESTS = `
  query FetchPendingTokenRequests($tokenAddress: String!) {
    tokenRequests(
      where: { participationToken: $tokenAddress, status: Pending }
      orderBy: createdAt
      orderDirection: desc
      first: 100
    ) {
      id
      requestId
      requester
      amount
      ipfsHash
      metadata {
        reason
        submittedAt
      }
      status
      createdAt
      createdAtBlock
      transactionHash
    }
  }
`;

export const FETCH_USER_TOKEN_REQUESTS = `
  query FetchUserTokenRequests($tokenAddress: String!, $userAddress: Bytes!) {
    tokenRequests(
      where: { participationToken: $tokenAddress, requester: $userAddress }
      orderBy: createdAt
      orderDirection: desc
      first: 50
    ) {
      id
      requestId
      amount
      ipfsHash
      metadata {
        reason
        submittedAt
      }
      status
      createdAt
      approvedAt
      cancelledAt
      approver
      transactionHash
    }
  }
`;

export const FETCH_ALL_TOKEN_REQUESTS = `
  query FetchAllTokenRequests($tokenAddress: String!) {
    tokenRequests(
      where: { participationToken: $tokenAddress }
      orderBy: createdAt
      orderDirection: desc
      first: 100
    ) {
      id
      requestId
      requester
      amount
      ipfsHash
      metadata {
        reason
        submittedAt
      }
      status
      createdAt
      approvedAt
      cancelledAt
      approver
      transactionHash
    }
  }
`;

// ─────────────────────── ParticipationToken balances ───────────────────────
//
// TokenBalance is a complete mirror of ERC20 balanceOf: verified live on
// poa-gnosis-v-1 that sum(TokenBalance.balance) == ParticipationTokenContract
// .totalSupply for a token with multiple holders (0x5cafc2fa…, 3 rows,
// 8273e18 both sides). Row id is `${tokenAddress}-${holderAddress}`, both
// lowercase.
//
// ParticipationTokenContract.symbol is populated on every live row ('PT',
// 'KUBIX', 'TEST'), which is strictly better than the hardcoded 'PT' guess the
// balance command used when the symbol() call failed.
//
// NOTE for future work: ParticipationTokenContract.executor and .hatsContract
// exist in this same schema but are ZERO on all 9 live Gnosis rows, and
// memberHatIds/approverHatIds are not indexed at all — the token hat gates
// still have to be read from the contract (see src/commands/token/helpers.ts).

/** Single holder balance + token symbol — `pop token balance`. */
export const FETCH_TOKEN_BALANCE = `
  query FetchTokenBalance($token: ID!, $balanceId: ID!) {
    participationTokenContract(id: $token) {
      id
      symbol
    }
    tokenBalance(id: $balanceId) {
      id
      balance
      updatedAt
    }
  }
`;

/** Many holder balances in one round-trip — `pop vote analyze`. */
export const FETCH_TOKEN_BALANCES = `
  query FetchTokenBalances($token: String!, $accounts: [Bytes!]) {
    tokenBalances(first: 1000, where: { participationToken: $token, account_in: $accounts }) {
      account
      balance
    }
  }
`;

/** Compose the TokenBalance entity id from a token + holder address. */
export function tokenBalanceId(tokenAddress: string, holder: string): string {
  return `${tokenAddress.toLowerCase()}-${holder.toLowerCase()}`;
}
