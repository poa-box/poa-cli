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
 * Vouch config + the wearer's ACTIVE vouch records for one hat.
 *
 * `vouches.length` is the subgraph equivalent of the on-chain
 * currentVouchCount(hatId, wearer): EligibilityModule increments the counter
 * in vouchFor (emits Vouched) and decrements it in revokeVouch (emits
 * VouchRevoked), and the subgraph creates a Vouch on Vouched / flips
 * isActive=false on VouchRevoked — a 1:1 correspondence with no epoch/reset
 * in between (resetVouches only clears vouchConfigs, not the counter).
 *
 * VERIFIED live against Gnosis RPC on 5 real (hat, wearer) pairs, including
 * three with a count of 2 — active-Vouch count matched currentVouchCount()
 * exactly on all 5.
 *
 * `first: 1000` is the Graph page cap; callers treat a full page as
 * "cannot derive" and fall back to RPC rather than silently under-counting.
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
