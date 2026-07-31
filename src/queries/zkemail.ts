/**
 * ZkEmailInvites Queries
 *
 * The ZK Email role-invite module is optional per org: `organization.zkEmailInvites` is null
 * for orgs deployed without it. A module with `activeRoot == null` is deployed but dormant —
 * every claim reverts until governance sets an allowlist.
 */

/**
 * Full module read, including the fields added by subgraph-pop #197: the module wiring
 * (executor + verifiers + registries) and the DKIM keys the trusted registry holds.
 *
 * Every one of those replaces an RPC call the CLI used to make — six eth_calls for the wiring
 * and a full-range eth_getLogs scan for the DKIM keys. Until #197 is deployed the whole
 * document fails validation, so callers must go through FETCH_ZKEMAIL_MODULE_TIERS rather than
 * issuing this directly.
 */
export const FETCH_ZKEMAIL_MODULE = `
  query FetchZkEmailModule($orgId: Bytes!) {
    organization(id: $orgId) {
      id
      name
      zkEmailInvites {
        id
        activeRoot
        activeAllowlistCid
        executor
        domainVerifier
        emailVerifier
        accountRegistry
        universalFactory
        claimCount
        dkimRegistry {
          id
          owner
          keys(first: 1000) {
            id
            domainHash
            keyHash
            valid
            validUntil
            revokedAt
          }
        }
        activeAllowlist {
          id
          root
          indexedAt
          entries(orderBy: index, orderDirection: asc, first: 1000) {
            id
            index
            entryType
            identifier
            identifierHash
            hatIds
            roleIndexes
          }
        }
      }
    }
  }
`;

/**
 * The pre-#197 field set: allowlist only, no wiring and no DKIM registry.
 *
 * Derived from the modern query by deletion so the two cannot drift. A GraphQL document is
 * validated as a whole, so a single unknown field fails the entire request — without this tier
 * every `pop zkemail` command would break against a subgraph that has not been redeployed yet.
 */
export const FETCH_ZKEMAIL_MODULE_LEGACY = (() => {
  const lines = FETCH_ZKEMAIL_MODULE.split('\n');
  const out: string[] = [];
  let skipDepth = 0;
  for (const line of lines) {
    const t = line.trim();
    if (skipDepth > 0) {
      // Inside the dkimRegistry block: track braces until it closes.
      if (t.endsWith('{')) skipDepth++;
      else if (t === '}') skipDepth--;
      continue;
    }
    if (t === 'dkimRegistry {') { skipDepth = 1; continue; }
    if (/^(executor|domainVerifier|emailVerifier|accountRegistry|universalFactory|claimCount)$/.test(t)) continue;
    out.push(line);
  }
  return out.join('\n');
})();

/** Modern tier first, pre-#197 tier as the fallback. */
export const FETCH_ZKEMAIL_MODULE_TIERS = [FETCH_ZKEMAIL_MODULE, FETCH_ZKEMAIL_MODULE_LEGACY];

/**
 * Has this specific address already consumed its specific-address invite?
 *
 * Replaces an `isEmailRegistered` eth_call. Only meaningful post-#197; callers fall back to the
 * contract when the entity is absent.
 */
export const FETCH_ZKEMAIL_REGISTERED_EMAIL = `
  query FetchZkEmailRegisteredEmail($id: ID!) {
    zkEmailRegisteredEmail(id: $id) {
      id
      registered
      claimer
      claimedAt
      clearedAt
    }
  }
`;

/**
 * Resolve role hat IDs to human names so an allowlist can be shown as
 * "gmail.com -> Member" instead of a raw uint256.
 */
export const FETCH_ORG_ROLE_NAMES = `
  query FetchOrgRoleNames($orgId: Bytes!) {
    organization(id: $orgId) {
      id
      roles {
        id
        hatId
        name
        isUserRole
        canVote
      }
    }
  }
`;

/**
 * Claim history for a module (subgraph-pop #197).
 *
 * Two things to know when rendering these:
 *   - `nullifier` is null for the passkey onboarding variants (RegisteredAndClaimed*), which do
 *     not emit it. On the live Gnosis module that is most claims, so absence is normal.
 *   - `identifierHash` is the allowlist leaf id the claim used, which may belong to a SUPERSEDED
 *     allowlist. Resolve it against the active entries opportunistically, never assume it hits.
 */
export const FETCH_ZKEMAIL_CLAIMS = `
  query FetchZkEmailClaims($module: String!, $first: Int!) {
    zkEmailClaims(
      where: { module: $module }
      orderBy: claimedAt
      orderDirection: desc
      first: $first
    ) {
      id
      kind
      claimer
      claimerUsername
      identifierHash
      hatIds
      nullifier
      registeredUsername
      claimedAt
      claimedAtBlock
      transactionHash
    }
  }
`;

/**
 * Just the committed allowlist pointer for an org's module.
 *
 * `activeRoot`/`activeAllowlistCid` are the two fields that exist on BOTH deployed schemas —
 * Gnosis (post-#197) and Arbitrum (pre-#197, where ZkEmailInvites is only
 * {id, organization, activeRoot, activeAllowlistCid, activeAllowlist, createdAt, lastUpdatedAt})
 * — so this needs no queryWithFieldFallback tier. Verified populated on live Gnosis:
 * activeRoot = 0x1d5d75df3ee05a0a90c42f0fe423f3c063dedf3466378e45a8343bfef18ebc46.
 *
 * A null `activeRoot` on a module row that EXISTS means dormant (no allowlist committed yet),
 * which is the same thing the contract reports as merkleRoot() == 0. A missing row means "not
 * indexed" and callers must fall back to the contract.
 */
export const FETCH_ZKEMAIL_ACTIVE_ROOT = `
  query FetchZkEmailActiveRoot($orgId: Bytes!) {
    organization(id: $orgId) {
      id
      zkEmailInvites {
        id
        activeRoot
        activeAllowlistCid
      }
    }
  }
`;
