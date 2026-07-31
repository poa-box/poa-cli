/**
 * Org Activity Query
 * Compound query for agent heartbeat — fetches all recent changes since a timestamp.
 * Single subgraph round-trip replaces 6+ separate calls.
 *
 * Uses nested org queries for tasks/members (known working pattern),
 * and top-level queries for vouches/tokenRequests/proposals (validated in other query files).
 */

export const FETCH_ORG_ACTIVITY = `
  query FetchOrgActivity(
    $orgId: Bytes!
    $hybridVotingId: String
    $eligibilityModuleId: Bytes
    $tokenAddress: String
  ) {
    # Org overview + tasks + members via nested pattern (known working)
    organization(id: $orgId) {
      id
      name
      participationToken {
        id
        totalSupply
        symbol
      }
      paymentManager {
        distributionCounter
      }
      taskManager {
        id
        projects(where: { deleted: false }, first: 50) {
          id
          title
          tasks(first: 200, orderBy: taskId, orderDirection: desc) {
            id
            taskId
            title
            status
            payout
            assignee
            assigneeUsername
            completer
            completerUsername
            createdAt
            assignedAt
            submittedAt
            completedAt
          }
        }
      }
      users(orderBy: firstSeenAt, orderDirection: desc, first: 20) {
        address
        account { username }
        membershipStatus
        joinMethod
        firstSeenAt
        currentHatIds
      }
      directDemocracyVoting {
        ddvProposals(
          where: { status: "Active" }
          orderBy: startTimestamp
          orderDirection: desc
          first: 50
        ) {
          id
          proposalId
          title
          metadata { description optionNames }
          numOptions
          startTimestamp
          endTimestamp
          status
          isHatRestricted
          restrictedHatIds
          votes { voter optionIndexes optionWeights }
        }
      }
    }

    # Active hybrid proposals — top-level query (validated: proposals entity exists)
    activeHybridProposals: proposals(
      where: { hybridVoting: $hybridVotingId, status: "Active" }
      orderBy: startTimestamp
      orderDirection: desc
      first: 50
    ) {
      id
      proposalId
      title
      metadata { description optionNames }
      numOptions
      startTimestamp
      endTimestamp
      status
      isHatRestricted
      restrictedHatIds
      votes {
        voter
        voterUsername
        optionIndexes
        optionWeights
        classRawPowers
        votedAt
      }
    }

    # Recently ended hybrid proposals (catch outcomes since last heartbeat)
    endedHybridProposals: proposals(
      where: { hybridVoting: $hybridVotingId, status: "Ended" }
      orderBy: startTimestamp
      orderDirection: desc
      first: 10
    ) {
      id
      proposalId
      title
      status
      winningOption
      isValid
      wasExecuted
      executionFailed
      executionError
      votes { voter optionIndexes optionWeights }
    }

    # Active vouches — top-level query (validated in vouch.ts). isActive carries the
    # epoch filter: deployments that index the vouch epoch flip it false for every vouch
    # a configureVouching/resetVouches/clearWearerVouches voided, so this listing needs no
    # extra field. Older deployments still list superseded vouches — stale rather than
    # wrong, which is fine for an activity feed but NOT for quorum maths (see vouch.ts).
    activeVouches: vouches(
      where: { eligibilityModule: $eligibilityModuleId, isActive: true }
      orderBy: createdAt
      orderDirection: desc
      first: 100
    ) {
      hatId
      wearer
      wearerUsername
      voucher
      voucherUsername
      vouchCount
      createdAt
    }

    # Pending token requests — top-level query (validated in token.ts)
    pendingTokenRequests: tokenRequests(
      where: { participationToken: $tokenAddress, status: Pending }
      orderBy: createdAt
      orderDirection: desc
      first: 50
    ) {
      requestId
      requester
      amount
      metadata { reason }
      status
      createdAt
    }
  }
`;
