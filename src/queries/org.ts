/**
 * Organization Queries
 * Ported from frontend queries.js
 */

export const FETCH_ORG_BY_ID = `
  query FetchOrgById($id: Bytes!) {
    organization(id: $id) {
      id
      name
      metadataHash
      deployedAt
      topHatId
      roleHatIds
      participationToken {
        id
        name
        symbol
        totalSupply
      }
      quickJoin {
        id
      }
      hybridVoting {
        id
        thresholdPct
        quorum
      }
      directDemocracyVoting {
        id
        thresholdPct
        quorum
      }
      taskManager {
        id
        projects {
          id
          title
          deleted
        }
      }
      educationHub {
        id
        nextModuleId
      }
      executorContract {
        id
      }
      eligibilityModule {
        id
      }
      paymentManager {
        id
      }
      zkEmailInvites {
        id
      }
      users {
        id
        address
        account {
          username
          metadata {
            avatar
          }
        }
        participationTokenBalance
        membershipStatus
        currentHatIds
      }
      roles(where: { isUserRole: true }) {
        id
        hatId
        name
        image
        canVote
        isUserRole
      }
    }
  }
`;

export const FETCH_ORG_FULL_DATA = `
  query FetchOrgFullData($orgId: Bytes!) {
    organization(id: $orgId) {
      id
      name
      metadataHash
      metadataAdminHatId
      metadata {
        id
        description
        template
        backgroundColor
        logo
        hideTreasury
        useTokenSymbol
        taskPayoutHoursOnly
        taskPayoutHourlyRate
        links {
          name
          url
          index
        }
      }
      deployedAt
      topHatId
      roleHatIds
      participationToken {
        id
        name
        symbol
        totalSupply
      }
      quickJoin {
        id
      }
      hybridVoting {
        id
        thresholdPct
        quorum
      }
      directDemocracyVoting {
        id
        thresholdPct
        quorum
      }
      zkEmailInvites {
        id
      }
      taskManager {
        id
        creatorHatIds
        projects(where: { deleted: false }, first: 100) {
          id
          tasks(first: 1000) {
            id
            status
          }
        }
      }
      educationHub {
        id
        modules {
          id
          moduleId
          title
          contentHash
          metadata {
            description
            link
            quiz
            answersJson
          }
          payout
          status
          completions {
            learner
          }
        }
      }
      executorContract {
        id
      }
      eligibilityModule {
        id
      }
      paymentManager {
        id
      }
      users(orderBy: participationTokenBalance, orderDirection: desc, first: 100) {
        id
        address
        account {
          username
          metadata {
            avatar
          }
        }
        participationTokenBalance
        membershipStatus
        currentHatIds
        totalTasksCompleted
        totalVotes
        firstSeenAt
      }
      roles(where: { isUserRole: true }) {
        id
        hatId
        name
        image
        canVote
        isUserRole
        hat {
          name
        }
      }
    }
  }
`;

export const GET_ORG_BY_NAME = `
  query GetOrgByName($name: String!) {
    organizations(where: { name: $name }, first: 1) {
      id
      name
    }
  }
`;

export const FETCH_USER_ORGANIZATIONS = `
  query FetchUserOrganizations($userAddress: Bytes!) {
    users(where: { address: $userAddress, membershipStatus: Active }) {
      id
      membershipStatus
      participationTokenBalance
      totalTasksCompleted
      totalVotes
      organization {
        id
        name
        metadataHash
        participationToken {
          symbol
        }
      }
    }
  }
`;

/**
 * Just the org's payout convention + token symbol.
 *
 * Deliberately narrow: `pop task create` needs it on every invocation to price a task the way
 * the web app would, and FETCH_ORG_FULL_DATA pulls every user, role, task and proposal.
 */
export const FETCH_ORG_PAYOUT_CONFIG = `
  query FetchOrgPayoutConfig($orgId: Bytes!) {
    organization(id: $orgId) {
      id
      metadata {
        useTokenSymbol
        taskPayoutHoursOnly
        taskPayoutHourlyRate
      }
      participationToken {
        symbol
      }
    }
  }
`;
