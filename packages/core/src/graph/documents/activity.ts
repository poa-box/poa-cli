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
    $authorityId: Bytes
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

    activeVouches: subjectVouchRecords(
      where: { authority: $authorityId, active: true }
      orderBy: vouchedAt
      orderDirection: desc
      first: 100
    ) {
      subject { subjectId }
      wearer: user
      membership { userUsername vouchCount }
      voucher
      voucherUsername
      epoch
      config { epoch }
      createdAt: vouchedAt
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

/** Preserve activity JSON keys while taking the live epoch and count from authority rows. */
export function normalizeAuthorityVouches(rows: any[]): any[] {
  return rows.filter(v => v.active !== false && v.config && String(v.epoch) === String(v.config.epoch))
    .map(v => ({ hatId: v.subject.subjectId, wearer: v.wearer,
      wearerUsername: v.membership?.userUsername ?? null, voucher: v.voucher,
      voucherUsername: v.voucherUsername, vouchCount: v.membership?.vouchCount ?? 0,
      createdAt: v.createdAt }));
}
