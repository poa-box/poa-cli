/** Old executed Hybrid distribution descriptions retain their stored CID/root
 * markers. Each page is flat, executed-only and independently cursor-scoped. */
export const FETCH_EXECUTED_DISTRIBUTION_PROPOSALS_PAGE = `
  query FetchExecutedDistributionProposalsPage($orgId: ID!, $hybridVoting: String!, $cursor: String!, $first: Int!, $block: Block_height) {
    organization(id: $orgId, block: $block) { id hybridVoting { id organization { id } } }
    proposals(block: $block, first: $first, orderBy: id, orderDirection: asc,
      where: { hybridVoting: $hybridVoting, id_gt: $cursor, status: Executed }) {
      id proposalId status descriptionHash metadata { description }
      hybridVoting { id organization { id } }
    }
    _meta(block: $block) { block { number hash timestamp } }
  }
`;
