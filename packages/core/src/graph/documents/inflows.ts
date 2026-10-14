/** Historical root collections include retired modules. Every stream has its
 * own cursor; current organization address is deliberately not a filter. */
export const FETCH_HISTORICAL_POTS_PAGE = `
  query FetchHistoricalPotsPage($taskCursor: Bytes!, $paymentCursor: Bytes!, $executorCursor: Bytes!, $first: Int!, $block: Block_height) {
    taskManagers(block: $block, first: $first, orderBy: id, orderDirection: asc, where: { id_gt: $taskCursor }) { id createdAtBlock organization { id } }
    paymentManagerContracts(block: $block, first: $first, orderBy: id, orderDirection: asc, where: { id_gt: $paymentCursor }) { id createdAtBlock organization { id } }
    executorContracts(block: $block, first: $first, orderBy: id, orderDirection: asc, where: { id_gt: $executorCursor }) { id createdAtBlock organization { id } }
    _meta(block: $block) { block { number hash timestamp } }
  }
`;
/** Recorded PaymentReceived facts only; no claim of exhaustive native receipts
 * to every module, causal returns or token Transfer/native-event dedup. */
export const FETCH_NATIVE_DEPOSITS_PAGE = `
  query FetchNativeDepositsPage($cursor: Bytes!, $first: Int!, $block: Block_height) {
    payments(block: $block, first: $first, orderBy: id, orderDirection: asc,
      where: { id_gt: $cursor, token: "0x0000000000000000000000000000000000000000" }) {
      id payer amount token receivedAtBlock transactionHash paymentManager { id organization { id } }
    }
    _meta(block: $block) { block { number hash timestamp } }
  }
`;

/** Global historical hubs, including former instances. No organization filter. */
export const FETCH_PAYMASTER_HUB_POTS_PAGE = `
  query FetchPaymasterHubPotsPage($cursor: Bytes!, $first: Int!, $block: Block_height) {
    paymasterHubContracts(block: $block, first: $first, orderBy: id, orderDirection: asc, where: { id_gt: $cursor }) { id createdAtBlock }
    _meta(block: $block) { block { number hash timestamp } }
  }
`;
/** Bounded inclusive recorded streams, not exhaustive native revenue. IDs are
 * opaque Bytes entity identities; no log index is inferred from their bytes. */
export const FETCH_INDEXED_NATIVE_PAYMENTS_PAGE = `
  query FetchIndexedNativePaymentsPage($cursor: Bytes!, $first: Int!, $block: Block_height, $fromBlock: BigInt!, $toBlock: BigInt!) {
    payments(block: $block, first: $first, orderBy: id, orderDirection: asc,
      where: { id_gt: $cursor, token: "0x0000000000000000000000000000000000000000", receivedAtBlock_gte: $fromBlock, receivedAtBlock_lte: $toBlock }) {
      id payer amount token receivedAtBlock transactionHash paymentManager { id organization { id } }
    }
    _meta(block: $block) { block { number hash timestamp } }
  }
`;
export const FETCH_INDEXED_ORG_DEPOSITS_PAGE = `
  query FetchIndexedOrgDepositsPage($cursor: Bytes!, $first: Int!, $block: Block_height, $fromBlock: BigInt!, $toBlock: BigInt!) {
    paymasterDepositEvents(block: $block, first: $first, orderBy: id, orderDirection: asc,
      where: { id_gt: $cursor, eventType: OrgDeposit, eventAtBlock_gte: $fromBlock, eventAtBlock_lte: $toBlock }) {
      id from amount eventType eventAtBlock transactionHash paymasterHub { id }
    }
    _meta(block: $block) { block { number hash timestamp } }
  }
`;
export const FETCH_INDEXED_DONATIONS_PAGE = `
  query FetchIndexedDonationsPage($cursor: Bytes!, $first: Int!, $block: Block_height, $fromBlock: BigInt!, $toBlock: BigInt!) {
    solidarityEvents(block: $block, first: $first, orderBy: id, orderDirection: asc,
      where: { id_gt: $cursor, eventType: DonationReceived, eventAtBlock_gte: $fromBlock, eventAtBlock_lte: $toBlock }) {
      id from amount eventType eventAtBlock transactionHash paymasterHub { id }
    }
    _meta(block: $block) { block { number hash timestamp } }
  }
`;
