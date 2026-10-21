/**
 * Voting Queries
 * Ported from frontend queries.js
 */

/**
 * Fuzzy --proposal resolution: recent proposals for ONE voting contract,
 * addressed directly by contract address (works for HybridVoting and
 * DirectDemocracyVoting — whichever entity matches the address answers,
 * the other root field returns null). Titles are stored decoded by the
 * subgraph, so they can be scored with bestMatches directly.
 */
export const RECENT_PROPOSALS_FOR_RESOLVE = `
  query RecentProposalsForResolve($votingId: ID!, $first: Int!) {
    hybridVotingContract(id: $votingId) {
      id
      proposals(orderBy: startTimestamp, orderDirection: desc, first: $first) {
        proposalId
        title
        status
        endTimestamp
      }
    }
    directDemocracyVotingContract(id: $votingId) {
      id
      ddvProposals(orderBy: startTimestamp, orderDirection: desc, first: $first) {
        proposalId
        title
        status
        endTimestamp
      }
    }
  }
`;

/**
 * One proposal's voting-window state for the cast pre-flight
 * ("not obviously ended"). Same dual-entity addressing as above.
 */
export const PROPOSAL_STATE_FOR_PREFLIGHT = `
  query ProposalStateForPreflight($votingId: ID!, $proposalId: BigInt!) {
    hybridVotingContract(id: $votingId) {
      proposals(where: { proposalId: $proposalId }, first: 1) {
        proposalId
        status
        endTimestamp
      }
    }
    directDemocracyVotingContract(id: $votingId) {
      ddvProposals(where: { proposalId: $proposalId }, first: 1) {
        proposalId
        status
        endTimestamp
      }
    }
  }
`;

export const FETCH_VOTING_DATA = `
  query FetchVotingDataNew($orgId: ID!) {
    organization(id: $orgId) {
      id
      hybridVoting {
        id
        thresholdPct
        quorum
        classVersion
        votingClasses(where: { isActive: true }, orderBy: classIndex, orderDirection: asc) {
          id
          classIndex
          version
          strategy
          slicePct
          quadratic
          minBalance
          asset
          hatIds
          isActive
        }
        proposals(orderBy: startTimestamp, orderDirection: desc, first: 50) {
          id
          proposalId
          title
          descriptionHash
          metadata {
            id
            description
            optionNames
          }
          numOptions
          startTimestamp
          endTimestamp
          status
          winningOption
          isValid
          wasExecuted
          executionFailed
          executionError
          isHatRestricted
          restrictedHatIds
          proposer
          proposerUsername
          creatorUsername
          classesVersion
          votes {
            voter
            voterUsername
            optionIndexes
            optionWeights
            classRawPowers
            votedAt
          }
        }
      }
      directDemocracyVoting {
        id
        thresholdPct
        quorum
        ddvProposals(orderBy: startTimestamp, orderDirection: desc, first: 50) {
          id
          proposalId
          title
          descriptionHash
          metadata {
            id
            description
            optionNames
          }
          numOptions
          startTimestamp
          endTimestamp
          status
          winningOption
          isValid
          executionFailed
          executionError
          isHatRestricted
          restrictedHatIds
          proposer
          proposerUsername
          votes {
            voter
            optionIndexes
            optionWeights
          }
        }
      }
    }
  }
`;

/**
 * FETCH_VOTING_DATA without the subgraph #195 attribution fields.
 *
 * A GraphQL document is validated as a whole, so a single unknown field fails the entire
 * query — not just that selection. `pop vote announce-all` (a WRITE that announces winners)
 * shares this document, so against a subgraph pinned before #195 the org would lose the
 * ability to announce ANY proposal. Derived from the full query by deletion so the two
 * cannot drift apart.
 */
export const FETCH_VOTING_DATA_LEGACY = FETCH_VOTING_DATA
  .split('\n')
  .filter((line) => !/^\s*(proposer|proposerUsername|creatorUsername|classesVersion|classVersion)\s*$/.test(line))
  .join('\n');

/** Full archives have independent emitter cursors. Single relation equality is
 * supported by Graph Node; no multi-hop child-filter query plan is used. */
const ARCHIVE_FIELDS = `id proposalId title descriptionHash numOptions startTimestamp endTimestamp
  status winningOption isValid executionFailed executionError isHatRestricted restrictedHatIds proposer proposerUsername
  createdAtBlock transactionHash
  metadata { id description optionNames createdAt actionSummaries promotedFrom }`;
const HYBRID_ARCHIVE_FIELDS = `${ARCHIVE_FIELDS} creatorUsername wasExecuted classesVersion
  hybridVoting { id organization { id } }
  classesChange { id version numClasses classesHash changedAt changedAtBlock transactionHash
    hybridVoting { id organization { id } }
    votingClasses(first: 8, orderBy: classIndex, orderDirection: asc) {
      id change { id } version classIndex strategy slicePct quadratic minBalance asset hatIds isActive
    }
  }`;
const DD_ARCHIVE_FIELDS = `${ARCHIVE_FIELDS} directDemocracyVoting { id organization { id } }`;

export const FETCH_HYBRID_PROPOSALS_PAGE = `
  query FetchHybridProposalsPage($orgId: ID!, $voting: String!, $cursor: String!, $first: Int!, $block: Block_height) {
    organization(id: $orgId, block: $block) { id hybridVoting { id } }
    proposals(first: $first, orderBy: id, orderDirection: asc, where: {hybridVoting: $voting, id_gt: $cursor}, block: $block) { ${HYBRID_ARCHIVE_FIELDS} }
    _meta(block: $block) { block { number hash timestamp } }
  }
`;
export const FETCH_DD_PROPOSALS_PAGE = `
  query FetchDDProposalsPage($orgId: ID!, $voting: String!, $cursor: String!, $first: Int!, $block: Block_height) {
    organization(id: $orgId, block: $block) { id directDemocracyVoting { id } }
    ddvproposals(first: $first, orderBy: id, orderDirection: asc, where: {directDemocracyVoting: $voting, id_gt: $cursor}, block: $block) { ${DD_ARCHIVE_FIELDS} }
    _meta(block: $block) { block { number hash timestamp } }
  }
`;
/** Full composite identity, never first-50 lookup or a Number proposalId. */
export const FETCH_PROPOSAL_DETAIL = `
  query FetchProposalDetail($orgId: ID!, $compositeId: String!, $block: Block_height) {
    organization(id: $orgId, block: $block) { id hybridVoting { id } directDemocracyVoting { id } }
    proposals(first: 1, where: {id: $compositeId}, block: $block) { ${HYBRID_ARCHIVE_FIELDS} }
    ddvproposals(first: 1, where: {id: $compositeId}, block: $block) { ${DD_ARCHIVE_FIELDS} }
    _meta(block: $block) { block { number hash timestamp } }
  }
`;
