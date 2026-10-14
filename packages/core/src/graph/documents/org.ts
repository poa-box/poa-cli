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
      membershipAuthority {
        id
        isRouterBound
        cutoverAt
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
      membershipAuthority {
        id
        isRouterBound
        cutoverAt
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
    organizations(where: { name: $name }, first: 100) {
      id
      name
      membershipAuthority { id isRouterBound cutoverAt }
    }
  }
`;

export const FETCH_USER_ORGANIZATIONS = `
  query FetchUserOrganizations($userAddress: Bytes!) {
    users(first: 1000, where: { address: $userAddress }) {
      id
      membershipStatus
      participationTokenBalance
      totalTasksCompleted
      totalVotes
      organization {
        id
        name
        membershipAuthority { id isRouterBound cutoverAt }
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

/** Unfiltered ID page: consumers advance this cursor before rejecting retired organizations.
 * No legacy/name/date allowlist and no capped nested user/project/task selections. */
export const FETCH_ORG_DIRECTORY_PAGE = `query OrgDirectoryPage($cursor: Bytes!, $first: Int!, $block: Block_height) {
  _meta(block: $block) { block { number hash timestamp } }
  organizations(first: $first, orderBy: id, orderDirection: asc, block: $block, where: { id_gt: $cursor }) {
    id name deployedAt metadataHash
    metadata { id description logo backgroundColor useTokenSymbol }
    membershipAuthority { id isRouterBound cutoverAt }
    participationToken { id name symbol totalSupply }
    taskManager { id organization { id } }
  }
}`;

/** Stream task status over the explicitly supported organization set, including >100 projects.
 * Deleted projects are excluded; every status is retained for deliberate consumer aggregation. */
export const FETCH_ORG_TASK_COUNT_PAGE = `query OrgTaskCountPage($taskManagers: [Bytes!]!, $cursor: String!, $first: Int!, $block: Block_height) {
  _meta(block: $block) { block { number hash timestamp } }
  tasks(first: $first, orderBy: id, orderDirection: asc, block: $block,
    where: { id_gt: $cursor, taskManager_in: $taskManagers, project_: { deleted: false } }) {
    id status taskManager project { id deleted taskManager { id organization { id } } }
  }
}`;

const MEMBERSHIP_CARD_ORG = `id name metadataHash
  metadata { id logo description useTokenSymbol }
  participationToken { symbol }
  membershipAuthority { id isRouterBound cutoverAt }`;
const MEMBERSHIP_CARD_HISTORY = `id address firstSeenAt lastActiveAt participationTokenBalance
  totalTasksCompleted totalVotes totalModulesCompleted`;

/** All role rows, including inactive memberships: current authority and old contributions differ.
 * Full eligibility inputs permit canonical authority projection rather than trusting a stale cache. */
export const FETCH_AUTHORITY_MEMBERSHIP_CARDS_PAGE = `query AuthorityMembershipCardsPage($userAddress: Bytes!, $cursor: String!, $first: Int!, $block: Block_height) {
  _meta(block: $block) { block { number hash timestamp } }
  subjectMemberships(first: $first, orderBy: id, orderDirection: asc, block: $block,
    where: { user: $userAddress, id_gt: $cursor, subject_: { kind: Role } }) {
    id user accepted eligible isMember claimable acceptedAt seededWhilePaused
    ruleKind emailVerified vouchCount vouchEpoch vouchMet eligibilitySource
    subject { subjectId kind defaultAllow vouchConfig { quorum epoch } }
    organization { ${MEMBERSHIP_CARD_ORG} }
    userEntity { ${MEMBERSHIP_CARD_HISTORY} }
  }
}`;

/** Historical contributors with no current authority row remain visible in supported migrated orgs. */
export const FETCH_USER_MEMBERSHIP_HISTORY_PAGE = `query UserMembershipHistoryPage($userAddress: Bytes!, $cursor: String!, $first: Int!, $block: Block_height) {
  _meta(block: $block) { block { number hash timestamp } }
  users(first: $first, orderBy: id, orderDirection: asc, block: $block,
    where: { address: $userAddress, id_gt: $cursor }) {
    ${MEMBERSHIP_CARD_HISTORY}
    organization { ${MEMBERSHIP_CARD_ORG} }
  }
}`;
