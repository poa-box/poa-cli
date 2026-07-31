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
  query FetchVotingDataNew($orgId: Bytes!) {
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
