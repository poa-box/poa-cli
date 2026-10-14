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
