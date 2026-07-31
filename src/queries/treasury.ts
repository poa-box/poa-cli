/**
 * Treasury Queries
 * Ported from frontend queries.js
 */

export const FETCH_TREASURY_DATA = `
  query FetchTreasuryData($orgId: Bytes!) {
    organization(id: $orgId) {
      id
      executorContract {
        id
        isPaused
        owner
        allowedCaller
        sweeps(first: 50, orderBy: sweptAt, orderDirection: desc) {
          id
          to
          amount
          sweptAt
          transactionHash
        }
      }
      participationToken {
        id
        name
        symbol
        totalSupply
      }
      paymentManager {
        id
        owner
        revenueShareToken
        distributionCounter
        distributions(first: 100, orderBy: createdAt, orderDirection: desc) {
          id
          distributionId
          payoutToken
          totalAmount
          totalClaimed
          checkpointBlock
          createdAtBlock
          merkleRoot
          status
          createdAt
          finalizedAt
          unclaimedAmount
          claims(first: 200) {
            id
            claimer
            claimerUsername
            amount
            claimedAt
            transactionHash
          }
        }
        payments(first: 100, orderBy: receivedAt, orderDirection: desc) {
          id
          payer
          payerUsername
          amount
          token
          receivedAt
          transactionHash
        }
      }
    }
  }
`;

/**
 * Subgraph entity id for a distribution: `<paymentManager>-<distributionId>`, with the
 * PaymentManager address lower-cased (the mapping keys off `event.address`, which the Graph
 * node serialises lower-case). Verified against live Gnosis rows, e.g.
 * `0x409f51250dc5c66bb1d6952f947d841192f1140e-1`.
 */
export function distributionEntityId(paymentManager: string, distributionId: number | string): string {
  return `${paymentManager.toLowerCase()}-${distributionId}`;
}

/**
 * One distribution, by entity id — the indexed twin of PaymentManager.getDistribution().
 *
 * Field mapping (all six on-chain struct members that have a getter):
 *   payoutToken     -> payoutToken
 *   totalAmount     -> totalAmount
 *   checkpointBlock -> checkpointBlock
 *   merkleRoot      -> merkleRoot
 *   totalClaimed    -> totalClaimed
 *   finalized       -> status == "Finalized"   (enum is exactly Active | Finalized)
 *
 * Plus `createdAtBlock`, which the contract has NO getter for — `Distribution.creationBlock`
 * is private state — so the subgraph is the only source for it. All of these are populated on
 * every live Gnosis row (verified 2026-07: 5/5 distributions non-null on every field) and the
 * whole field set also exists on the Arbitrum deployment
 * (QmYGCS4pXoaqXX7WjaPEhA56kiwgC14z7jsstZzEQgxgUp), so no queryWithFieldFallback tier is needed.
 *
 * `distribution(id:)` returns null (not an error) for an unknown id, which callers MUST treat as
 * "not indexed yet" and resolve on-chain — never as DistributionNotFound.
 */
export const FETCH_DISTRIBUTION_BY_ID = `
  query FetchDistributionById($id: ID!) {
    distribution(id: $id) {
      id
      distributionId
      payoutToken
      totalAmount
      totalClaimed
      checkpointBlock
      createdAtBlock
      merkleRoot
      status
    }
  }
`;

/**
 * Every still-claimable distribution for an org, with the claim log needed to skip the ones
 * this wallet already took. Shared by `pop treasury claim-mine`; `pop treasury claim` reads the
 * single-distribution form above so the two commands agree on one source for the same values.
 */
export const FETCH_ACTIVE_DISTRIBUTIONS = `
  query FetchActiveDistributions($orgId: Bytes!) {
    organization(id: $orgId) {
      paymentManager {
        distributions(where: { status: "Active" }, first: 50) {
          distributionId
          totalAmount
          merkleRoot
          checkpointBlock
          payoutToken
          claims { claimer }
        }
      }
    }
  }
`;
