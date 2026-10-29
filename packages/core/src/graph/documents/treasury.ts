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

// Financial selection is independent of active-board project filtering. Flat
// taskManager/status filters avoid unsupported multi-hop Graph Node plans.
const WORK_BINDING = `organization(id: $orgId, block: $block) { id taskManager { id organization { id } } }`;
const FINANCIAL_TASK_FIELDS = `id taskId taskManager status payout bountyToken bountyPayout
  project { id projectId deleted taskManager { id organization { id } } }`;
export const FETCH_TREASURY_TASK_ACTIVITY_PAGE = `
  query FetchTreasuryTaskActivityPage($orgId: ID!, $taskManager: Bytes!, $cursor: String!, $first: Int!, $block: Block_height) {
    ${WORK_BINDING}
    tasks(block: $block, first: $first, orderBy: id, orderDirection: asc,
      where: { taskManager: $taskManager, id_gt: $cursor, status: Completed }) { ${FINANCIAL_TASK_FIELDS} }
    _meta(block: $block) { block { number hash timestamp } }
  }
`;
export const FETCH_PROMISED_BOUNTIES_PAGE = `
  query FetchPromisedBountiesPage($orgId: ID!, $taskManager: Bytes!, $cursor: String!, $first: Int!, $block: Block_height) {
    ${WORK_BINDING}
    tasks(block: $block, first: $first, orderBy: id, orderDirection: asc,
      where: { taskManager: $taskManager, id_gt: $cursor, status_in: [Open, Assigned, Submitted] }) { ${FINANCIAL_TASK_FIELDS} }
    _meta(block: $block) { block { number hash timestamp } }
  }
`;
const PAYMENT_BINDING = `organization(id: $orgId, block: $block) { id paymentManager { id organization { id } } }`;
export const FETCH_DISTRIBUTIONS_PAGE = `
  query FetchDistributionsPage($orgId: ID!, $paymentManager: String!, $cursor: String!, $first: Int!, $block: Block_height) {
    ${PAYMENT_BINDING}
    distributions(block: $block, first: $first, orderBy: id, orderDirection: asc,
      where: { paymentManager: $paymentManager, id_gt: $cursor }) {
      id distributionId payoutToken totalAmount totalClaimed checkpointBlock createdAtBlock merkleRoot status
      paymentManager { id organization { id } }
    }
    _meta(block: $block) { block { number hash timestamp } }
  }
`;
export const FETCH_PAYMENTS_PAGE = `
  query FetchPaymentsPage($orgId: ID!, $paymentManager: String!, $cursor: Bytes!, $first: Int!, $block: Block_height) {
    ${PAYMENT_BINDING}
    payments(block: $block, first: $first, orderBy: id, orderDirection: asc,
      where: { paymentManager: $paymentManager, id_gt: $cursor }) {
      id payer amount token receivedAt receivedAtBlock transactionHash paymentManager { id organization { id } }
    }
    _meta(block: $block) { block { number hash timestamp } }
  }
`;
export const FETCH_DISTRIBUTION_CLAIMS_PAGE = `
  query FetchDistributionClaimsPage($orgId: ID!, $paymentManager: String!, $distribution: String!, $cursor: String!, $first: Int!, $block: Block_height) {
    ${PAYMENT_BINDING}
    claims(block: $block, first: $first, orderBy: id, orderDirection: asc,
      where: { paymentManager: $paymentManager, distribution: $distribution, id_gt: $cursor }) {
      id claimer amount claimedAt claimedAtBlock transactionHash
      paymentManager { id organization { id } } distribution { id distributionId }
    }
    _meta(block: $block) { block { number hash timestamp } }
  }
`;
