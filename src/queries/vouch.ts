/**
 * Vouching Queries
 * Ported from frontend queries.js
 */

/**
 * Vouch config for one hat — the subgraph mirror of
 * EligibilityModule.getVouchConfig(hatId) / vouchConfigs(hatId).
 *
 * Field population VERIFIED live (2026-07-30) on BOTH deployments:
 *   poa-gnosis-v-1 → quorum=1, membershipHatId=2908…, enabled=true,
 *                    combinesWithHierarchy=true/false (both values present)
 *   poa-arb-v-1    → same fields, same shape
 * so no field-fallback tier is required. Callers still degrade to the RPC
 * getter on ANY error (including a hypothetical unknown-field validation
 * failure on a self-hosted older deployment), which is the correct answer
 * rather than a partially-filled one.
 *
 * A MISSING row is deliberately NOT treated as "vouching disabled": callers
 * fall back to RPC, because absence is ambiguous between "no VouchConfigSet
 * event was ever emitted" and "not indexed yet".
 */
export const FETCH_VOUCH_CONFIG = `
  query FetchVouchConfig($eligibilityModuleId: Bytes!, $hatId: BigInt!) {
    vouchConfigs(
      where: { eligibilityModule: $eligibilityModuleId, hatId: $hatId }
      first: 1
    ) {
      id
      hatId
      quorum
      membershipHatId
      enabled
      combinesWithHierarchy
    }
  }
`;

/**
 * TIER 0 — vouch progress read off the subgraph's epoch mirror.
 *
 * EligibilityModule kills stale vouches by bumping an epoch counter rather than
 * emitting a per-vouch invalidation:
 *
 *   configureVouching / batchConfigureVouching / resetVouches → vouchConfigEpoch[hatId]++
 *   clearWearerVouches                                        → wearerVouchEpoch = 2^256-1
 *
 * and `currentVouchCount(hatId, wearer)` returns 0 whenever the two disagree. The
 * subgraph mirrors both counters onto WearerVouchState, so this tier reproduces the
 * getter EXACTLY:
 *
 *   currentCount = (state.epoch == config.epoch) ? state.count : 0
 *
 * No row counting, so no 1000-row page cap and no cross-epoch overcount.
 *
 * `effectiveCount` is the subgraph's own materialisation of that same expression. It
 * is read only as a CONSISTENCY CHECK: the count+epoch comparison is self-correcting
 * while effectiveCount depends on a sweep, so a disagreement means the deployment is
 * buggy and the caller falls back to RPC rather than picking a winner.
 *
 * This tier fails GraphQL validation (unknown field `epoch`) on deployments predating
 * the epoch indexing, which is what drops callers to FETCH_VOUCH_STATUS below.
 */
export const FETCH_VOUCH_STATUS_EPOCH_AWARE = `
  query FetchVouchStatusEpochAware($eligibilityModuleId: Bytes!, $hatId: BigInt!, $wearer: Bytes!) {
    vouchConfigs(
      where: { eligibilityModule: $eligibilityModuleId, hatId: $hatId }
      first: 1
    ) {
      id
      hatId
      quorum
      membershipHatId
      enabled
      combinesWithHierarchy
      epoch
    }
    wearerVouchStates(
      where: {
        eligibilityModule: $eligibilityModuleId
        hatId: $hatId
        wearer: $wearer
      }
      first: 1
    ) {
      id
      count
      effectiveCount
      epoch
      cleared
    }
  }
`;

/**
 * TIER 1 — legacy deployments with no epoch mirror.
 *
 * `vouches.length` approximates the on-chain currentVouchCount(hatId, wearer):
 * EligibilityModule increments the counter in vouchFor (emits Vouched) and decrements
 * it in revokeVouch (emits VouchRevoked), and the subgraph creates a Vouch on Vouched /
 * flips isActive=false on VouchRevoked.
 *
 * VERIFIED live against Gnosis RPC on 5 real (hat, wearer) pairs, including three with
 * a count of 2 — active-Vouch count matched currentVouchCount() exactly on all 5.
 *
 * It is only an APPROXIMATION: on these deployments an epoch bump leaves the superseded
 * rows at isActive=true, so the count runs high after any reconfiguration. `updatedAtBlock`
 * and `createdAtBlock` exist purely so the caller can detect that ambiguity (any vouch
 * older than the config's last update) and refuse to derive.
 *
 * `first: 1000` is the Graph page cap; callers treat a full page as "cannot derive"
 * and fall back to RPC rather than silently under-counting.
 */
export const FETCH_VOUCH_STATUS = `
  query FetchVouchStatus($eligibilityModuleId: Bytes!, $hatId: BigInt!, $wearer: Bytes!) {
    vouchConfigs(
      where: { eligibilityModule: $eligibilityModuleId, hatId: $hatId }
      first: 1
    ) {
      id
      hatId
      quorum
      membershipHatId
      enabled
      combinesWithHierarchy
      updatedAtBlock
    }
    vouches(
      where: {
        eligibilityModule: $eligibilityModuleId
        hatId: $hatId
        wearer: $wearer
        isActive: true
      }
      first: 1000
    ) {
      id
      createdAtBlock
    }
  }
`;

/**
 * Recent vouch activity for `pop vouch list` — display only, never a quorum decision.
 *
 * `isActive` IS THE EPOCH FILTER HERE. On deployments that index the epoch, the indexer
 * flips isActive=false for every vouch a configureVouching/resetVouches/clearWearerVouches
 * voided (recording invalidatedAt to keep that distinct from a voucher's own revokedAt),
 * so this listing is epoch-correct with no extra field. On older deployments the
 * superseded rows are still isActive and will be listed — stale rather than wrong, which
 * is acceptable for a listing but NOT for the quorum maths in FETCH_VOUCH_STATUS above.
 */
export const FETCH_VOUCHES_FOR_ORG = `
  query FetchVouchesForOrg($eligibilityModuleId: Bytes!) {
    vouches(
      where: { eligibilityModule: $eligibilityModuleId, isActive: true }
      orderBy: createdAt
      orderDirection: desc
      first: 200
    ) {
      id
      hatId
      wearer
      wearerUsername
      voucher
      voucherUsername
      vouchCount
      isActive
      createdAt
    }
  }
`;
