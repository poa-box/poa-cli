/**
 * User & Account Queries
 * Ported from frontend queries.js
 */

export const FETCH_USERNAME = `
  query FetchUsernameNew($id: Bytes!) {
    account(id: $id) {
      id
      username
      profileMetadataHash
      metadata {
        id
        bio
        avatar
        github
        twitter
        website
      }
    }
  }
`;

export const GET_ACCOUNT_BY_USERNAME = `
  query GetAccountByUsername($username: String!) {
    accounts(where: { username: $username }, first: 1) {
      id
      user
      username
    }
  }
`;

/**
 * One-round-trip org snapshot for `pop user whoami`: org name + role-hat
 * names, the caller's org-user entity (membership, PT balance, hats worn),
 * and their pending participation-token requests. The `status: Pending`
 * filter is inlined (enum literal) to match FETCH_PENDING_TOKEN_REQUESTS
 * in queries/token.ts.
 */
export const FETCH_WHOAMI_ORG_DATA = `
  query WhoamiOrgData($orgId: Bytes!, $orgUserID: String!, $tokenAddress: String!, $userAddress: Bytes!) {
    organization(id: $orgId) {
      id
      name
      roles(where: { isUserRole: true }) {
        hatId
        name
      }
    }
    user(id: $orgUserID) {
      id
      membershipStatus
      participationTokenBalance
      currentHatIds
    }
    tokenRequests(
      where: { participationToken: $tokenAddress, requester: $userAddress, status: Pending }
      first: 100
    ) {
      id
    }
  }
`;

export const FETCH_USER_DATA = `
  query FetchUserDataNew($orgUserID: String!, $userAddress: Bytes!) {
    user(id: $orgUserID) {
      id
      address
      participationTokenBalance
      membershipStatus
      currentHatIds
      joinMethod
      totalTasksCompleted
      totalVotes
      totalModulesCompleted
      firstSeenAt
      lastActiveAt
      assignedTasks(first: 20) {
        id
        taskId
        title
        payout
        status
      }
      completedTasks(first: 20) {
        id
        taskId
        title
        payout
      }
      hybridProposalsCreated(first: 20) {
        id
        proposalId
        title
        status
        startTimestamp
        endTimestamp
      }
      modulesCompleted(first: 20) {
        moduleId
        completedAt
      }
    }
    account(id: $userAddress) {
      id
      username
    }
  }
`;
