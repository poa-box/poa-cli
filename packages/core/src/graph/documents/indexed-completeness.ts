/** Existing serving entities, not hypothetical aggregate counters. Every
 * collection and metadata response selects the same block. */
const META = '_meta(block: $block) { deployment hasIndexingErrors block { number hash timestamp } }';

export const FETCH_CURRENT_MEMBER_TOTAL_STATE = `query CurrentMemberTotalState($orgId: ID!, $block: Block_height) {
  ${META}
  organization(id: $orgId, block: $block) {
    id executorContract { id } eligibilityModule { id }
    membershipAuthority { id isRouterBound cutoverAt acceptedMembershipCount }
  }
}`;
export const FETCH_CURRENT_MEMBER_TOTAL_PAGE = `query CurrentMemberTotalPage($orgId: String!, $authority: String!, $cursor: String!, $first: Int!, $block: Block_height) {
  ${META}
  subjectMemberships(first: $first, orderBy: id, orderDirection: asc, block: $block,
    where: { organization: $orgId, authority: $authority, id_gt: $cursor }) {
    id user accepted emailVerified ruleKind vouchCount vouchEpoch
    organization { id } authority { id }
    subject { id subjectId kind defaultAllow organization { id } authority { id } vouchConfig { quorum epoch } }
  }
}`;
export const FETCH_TOKEN_HOLDER_TOTAL_STATE = `query TokenHolderTotalState($token: ID!, $block: Block_height) {
  ${META}
  participationTokenContract(id: $token, block: $block) { id totalSupply organization { id } }
}`;
export const FETCH_TOKEN_HOLDER_TOTAL_PAGE = `query TokenHolderTotalPage($token: String!, $cursor: String!, $first: Int!, $block: Block_height) {
  ${META}
  tokenBalances(first: $first, orderBy: id, orderDirection: asc, block: $block,
    where: { participationToken: $token, id_gt: $cursor }) {
    id account balance updatedAtBlock participationToken { id organization { id } }
  }
}`;
export const FETCH_ALL_COMPLETIONS_STATE = `query AllCompletionsState($hub: ID!, $block: Block_height) {
  ${META}
  educationHubContract(id: $hub, block: $block) { id organization { id } }
}`;
export const FETCH_ALL_COMPLETIONS_PAGE = `query AllCompletionsPage($orgId: String!, $hub: String!, $cursor: String!, $first: Int!, $block: Block_height) {
  ${META}
  moduleCompletions(first: $first, orderBy: id, orderDirection: asc, block: $block,
    where: { educationHub: $hub, educationHub_: { organization: $orgId }, id_gt: $cursor }) {
    id moduleId learner completedAt completedAtBlock transactionHash module { id } educationHub { id organization { id } }
  }
}`;

/** peer-cashoutrelay-base schema: request IDs are Bytes, sorted ascending by
 * id with strict id_gt (not timestamps, offset paging, or wallet nested lists).
 * The deployed mapping has one relay data source and no per-request relay field. */
export const FETCH_CASHOUT_DISCOVERY_STATE = `query CashoutDiscoveryState($relay: ID!, $block: Block_height) {
  ${META}
  relayContract(id: $relay, block: $block) { id usdc escrow }
  relayContracts(first: 2, block: $block) { id }
}`;
export const FETCH_CASHOUT_DISCOVERY_PAGE = `query CashoutDiscoveryPage($wallet: String!, $statuses: [CashOutStatus!]!, $cursor: Bytes!, $first: Int!, $block: Block_height) {
  ${META}
  cashOutRequests(first: $first, orderBy: id, orderDirection: asc, block: $block,
    where: { depositor: $wallet, status_in: $statuses, id_gt: $cursor }) {
    id requestHash depositor { id } pendingFor { id } status amount paymentMethod failureReason
    createdAtBlock createdAtTimestamp createdTxHash
  }
}`;
