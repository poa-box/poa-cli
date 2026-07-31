/**
 * Role / hat-admin queries (pop org roles, pop org view, pop org set-metadata-admin).
 *
 * Kept separate from queries/org.ts and queries/role.ts so the roles commands
 * can carry the vouch-config fields without touching the shared org document.
 *
 * VERIFIED against the live Gnosis (poa-gnosis-v-1) and Arbitrum (poa-arb-v-1)
 * deployments on 2026-07-30:
 *   - Hat.vouchConfig exists on BOTH schemas and is populated. Every non-null
 *     row has enabled=true, quorum>=1, membershipHatId!=0.
 *   - A null Hat.vouchConfig means "vouching was never configured for this
 *     hat", not "the subgraph is missing data": for every role whose
 *     vouchConfig is null (ELIGIBILITY_ADMIN on all 9 Gnosis orgs + Arb's
 *     "Poa", plus Test6/TaskRunner, Test6/Treasurer, Decentral Park/Neighbor)
 *     an eth_call to EligibilityModule returned isVouchingEnabled()==false and
 *     vouchConfigs().quorum==0 — exactly what the CLI renders for a null row.
 *   - Role.hat is non-null on all 31 Gnosis roles and all 3 Arbitrum roles.
 *   - subgraph src/eligibility-module.ts handleVouchConfigSet writes quorum /
 *     membershipHatId / enabled / combinesWithHierarchy on EVERY VouchConfigSet
 *     event, including disables, so the row does not go stale after a change.
 *   - Organization.metadataAdminHatId is non-null on all 9 Gnosis orgs and the
 *     1 Arbitrum org, and subgraph src/org-registry.ts
 *     handleOrgMetadataAdminHatSet rewrites it on every OrgMetadataAdminHatSet.
 *     Spot-checked Argus against OrgRegistry.getOrgMetadataAdminHat on Gnosis:
 *     identical (30222100625258283641858621132055137413908072809768050515156576961036288).
 */

/**
 * Tier 0 for `pop org roles`: roles + members + the vouch config inlined via
 * Role.hat.vouchConfig. Serving this tier means the command issues ZERO
 * eth_calls (previously 2 per role: isVouchingEnabled + vouchConfigs).
 */
export const FETCH_ROLES_MEMBERS_AND_VOUCH = `
  query FetchRolesMembersAndVouch($id: Bytes!) {
    organization(id: $id) {
      roles(where: { isUserRole: true }) {
        id
        hatId
        name
        image
        canVote
        isUserRole
        hat {
          id
          vouchConfig {
            enabled
            quorum
            membershipHatId
            combinesWithHierarchy
          }
        }
      }
      users {
        address
        participationTokenBalance
        membershipStatus
        currentHatIds
        account {
          username
        }
      }
      eligibilityModule {
        id
      }
    }
  }
`;

/**
 * Tier 1 for `pop org roles`: the legacy shape, for any deployment whose
 * schema predates Hat.vouchConfig. When this tier serves, the command falls
 * back to batched EligibilityModule reads through Multicall3.
 */
export const FETCH_ROLES_AND_MEMBERS = `
  query FetchRolesAndMembers($id: Bytes!) {
    organization(id: $id) {
      roles(where: { isUserRole: true }) {
        id
        hatId
        name
        image
        canVote
        isUserRole
      }
      users {
        address
        participationTokenBalance
        membershipStatus
        currentHatIds
        account {
          username
        }
      }
      eligibilityModule {
        id
      }
    }
  }
`;

/**
 * Current metadata-admin hat for one org — the subgraph mirror of
 * OrgRegistry.getOrgMetadataAdminHat(orgId).
 */
export const FETCH_ORG_METADATA_ADMIN_HAT = `
  query FetchOrgMetadataAdminHat($orgId: Bytes!) {
    organization(id: $orgId) {
      id
      metadataAdminHatId
    }
  }
`;

/** Shape of the FETCH_ORG_METADATA_ADMIN_HAT response. */
export interface OrgMetadataAdminHatResult {
  organization: { id: string; metadataAdminHatId: string | null } | null;
}
