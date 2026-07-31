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
 * names, the org's QuickJoin module pointers, the caller's account
 * (username + which registry it lives on), their ERC-20 participation-token
 * balance, their org-user entity (membership, PT balance, hats worn), and
 * their pending participation-token requests. The `status: Pending`
 * filter is inlined (enum literal) to match FETCH_PENDING_TOKEN_REQUESTS
 * in queries/token.ts.
 *
 * Every field here was verified NON-NULL against the live Gnosis
 * (poa-gnosis-v-1) AND Arbitrum (poa-arb-v-1) deployments, and
 * quickJoinContract.{accountRegistry,hatsContract,memberHatIds} were
 * byte-compared against the matching eth_calls on both chains — including
 * the empty-array memberHatIds case, which is genuinely empty on-chain and
 * not an indexing gap.
 *
 * `account.registry` is carried so callers can prove the indexed account
 * belongs to the SAME registry the org's QuickJoin consults before trusting
 * the indexed username (a legacy org can point at a registry this subgraph
 * does not index).
 */
export const FETCH_WHOAMI_ORG_DATA = `
  query WhoamiOrgData(
    $orgId: Bytes!
    $orgUserID: String!
    $tokenAddress: String!
    $userAddress: Bytes!
    $quickJoinAddress: ID!
    $accountID: ID!
    $tokenBalanceID: ID!
  ) {
    organization(id: $orgId) {
      id
      name
      roles(where: { isUserRole: true }) {
        hatId
        name
        # Hats Protocol's toggle flag. When it is false, Hats.isWearerOfHat returns
        # false for EVERY wearer regardless of token balance, and the tokens are NOT
        # burned — so User.currentHatIds still lists the hat. A membership answer
        # derived from currentHatIds alone must AND it with this flag.
        hat {
          active
        }
      }
    }
    quickJoinContract(id: $quickJoinAddress) {
      id
      accountRegistry
      hatsContract
      memberHatIds
    }
    account(id: $accountID) {
      id
      username
      isDeleted
      registry {
        id
      }
    }
    tokenBalance(id: $tokenBalanceID) {
      id
      balance
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

/**
 * Standalone account lookup (no org): the username + registry for one
 * address. Account.id is the LOWERCASED address. Used by `pop user whoami`
 * when no org is configured — the username is home-chain account-registry
 * state, so this runs against the home-chain subgraph instead of building a
 * second JsonRpcProvider just to call getUsername.
 */
export const FETCH_ACCOUNT_USERNAME = `
  query AccountUsername($accountID: ID!) {
    account(id: $accountID) {
      id
      username
      isDeleted
      registry {
        id
      }
    }
  }
`;

/**
 * The org QuickJoin's module pointers plus the caller's account, in one
 * round-trip. `pop user join` needs both: the registry QuickJoin consults
 * (registering anywhere else leaves quickJoinWithUser reverting NoUsername)
 * and whether a username already exists (1-tx vs 2-tx flow).
 *
 * The account is only trustworthy for that decision when
 * `account.registry.id === quickJoinContract.accountRegistry` — see the
 * guard in commands/user/join.ts.
 */
export const FETCH_QUICKJOIN_ACCOUNT = `
  query QuickJoinAccount($quickJoinAddress: ID!, $accountID: ID!) {
    quickJoinContract(id: $quickJoinAddress) {
      id
      accountRegistry
      hatsContract
      memberHatIds
    }
    account(id: $accountID) {
      id
      username
      isDeleted
      registry {
        id
      }
    }
  }
`;

/**
 * Just the QuickJoin module pointers — the addresses `pop user claim-hats`
 * needs before running its (deliberately on-chain) pre-flight probes.
 */
export const FETCH_QUICKJOIN_MODULES = `
  query QuickJoinModules($quickJoinAddress: ID!) {
    quickJoinContract(id: $quickJoinAddress) {
      id
      accountRegistry
      hatsContract
      memberHatIds
    }
  }
`;

/**
 * The indexed account registry plus one account's username and profile
 * metadata, in one round-trip — everything `pop user update-profile` needs
 * before it writes. Replaces two separate subgraph queries plus a
 * getUsername eth_call.
 */
export const FETCH_REGISTRY_AND_ACCOUNT = `
  query RegistryAndAccount($accountID: ID!) {
    universalAccountRegistries(first: 1) {
      id
    }
    account(id: $accountID) {
      id
      username
      isDeleted
      metadata {
        bio
        avatar
        github
        twitter
        website
      }
    }
  }
`;

/** Shape of the `account` selection shared by the queries above. */
export interface IndexedAccount {
  id: string;
  username: string;
  isDeleted: boolean;
  registry?: { id: string } | null;
}

/** Shape of the `quickJoinContract` selection shared by the queries above. */
export interface IndexedQuickJoin {
  id: string;
  accountRegistry: string;
  hatsContract: string;
  memberHatIds: string[];
}

/**
 * True when an indexed account can stand in for a live
 * `registry.getUsername(addr)` read.
 *
 * Two ways it cannot:
 *   - the account was deleted on-chain (the indexed username is a tombstone);
 *   - it lives on a DIFFERENT registry than the one the caller is about to
 *     transact against. Exactly one UniversalAccountRegistry is indexed per
 *     deployment, but a legacy org's QuickJoin can point at another address
 *     (verified: Gnosis org "Test5" points at 0x01a1…8513, which has no code
 *     on Gnosis), and Account.id is the bare address — not registry-scoped —
 *     so a username from the indexed registry would be the wrong answer.
 *
 * `expectedRegistry` omitted means "no registry constraint" (the caller is
 * reading the subgraph's own registry).
 */
export function isAccountAuthoritative(
  account: IndexedAccount | null | undefined,
  expectedRegistry?: string | null
): account is IndexedAccount {
  if (!account || account.isDeleted) return false;
  if (!expectedRegistry) return true;
  const indexed = account.registry?.id;
  if (!indexed) return false;
  return indexed.toLowerCase() === expectedRegistry.toLowerCase();
}

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
