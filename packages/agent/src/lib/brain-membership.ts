/**
 * Brain dynamic allowlist — derive the authorized-author set from on-chain
 * organization membership instead of a hand-maintained JSON file.
 *
 * Task #330 (HB#312 Hudson directive): the static brain-allowlist.json
 * blocks the "clone repo → onboard → apply → vouched → fully in" flow
 * because new members have to be added to the JSON file by hand after
 * their vouch lands. This module replaces the JSON with a subgraph-backed
 * lookup of active members of the configured org.
 *
 * Design:
 *
 *   - Cache the full member address set for ~5 minutes (addresses in
 *     lowercase). Invalidating per-address on every verify would hammer
 *     the subgraph; per-org batch fetch is the right granularity.
 *
 *   - On network error, throw. Callers (the verify path) catch and fall
 *     back to the static allowlist. The fallback log is emitted by the
 *     caller, not here, because this module is pure lookup.
 *
 *   - Org and chain are read from POP_DEFAULT_ORG / POP_DEFAULT_CHAIN
 *     (or POP_BRAIN_ORG / POP_BRAIN_CHAIN if set — a future multi-org
 *     brain layer will need per-doc org, but MVP is one-brain-per-org).
 *
 *   - The subgraph query is a narrow extract of the triage.ts pattern:
 *     just organization.users with membershipStatus = Active, nothing
 *     else. No tasks, no proposals, no treasury.
 *
 * The JSON allowlist stays in place for:
 *   (1) fresh clones before the first subgraph request succeeds
 *   (2) offline / air-gapped operators
 *   (3) manual emergency overrides for keys outside the DAO
 */

import { query } from '@poa/cli/lib/subgraph';
import { resolveOrgModules } from '@poa/cli/lib/resolve';
import { resolveNetworkConfig } from '@poa/cli/config/networks';

const MEMBERS_QUERY = `
  query BrainMembers($orgId: Bytes!) {
    organization(id: $orgId) {
      users(first: 100) {
        address
        membershipStatus
      }
    }
  }
`;

interface MembershipCacheEntry {
  members: Set<string>;
  expiresAt: number;
}

const cache = new Map<string, MembershipCacheEntry>();
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function cacheKey(orgId: string, chainId: number): string {
  return `${chainId}:${orgId.toLowerCase()}`;
}

/**
 * Fetch the active member address set for an org. Caches per (chainId, orgId).
 * Throws on subgraph error — callers handle fallback.
 *
 * @param orgIdOrName  Org identifier (POP_DEFAULT_ORG if undefined)
 * @param chainId      Chain ID (POP_DEFAULT_CHAIN if undefined)
 * @param opts.ttlMs   Override cache TTL (default 5 min)
 */
export async function fetchOrgMembers(
  orgIdOrName?: string,
  chainId?: number,
  opts: { ttlMs?: number } = {},
): Promise<Set<string>> {
  const effectiveChain =
    chainId ?? (process.env.POP_BRAIN_CHAIN ? Number(process.env.POP_BRAIN_CHAIN) : undefined);
  const network = resolveNetworkConfig(effectiveChain);
  const resolved = await resolveOrgModules(
    orgIdOrName ?? process.env.POP_BRAIN_ORG ?? process.env.POP_DEFAULT_ORG,
    network.chainId,
  );
  const key = cacheKey(resolved.orgId, network.chainId);
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.members;
  }

  const result = await query<any>(MEMBERS_QUERY, { orgId: resolved.orgId }, network.chainId);
  const org = result?.organization;
  if (!org) {
    throw new Error(`Brain membership: org ${resolved.orgId} not found in subgraph`);
  }

  const members = new Set<string>();
  for (const u of org.users || []) {
    if (u.membershipStatus === 'Active' && u.address) {
      members.add(String(u.address).toLowerCase());
    }
  }

  cache.set(key, { members, expiresAt: Date.now() + ttl });
  return members;
}

/**
 * Is the given address currently an active member of the configured org?
 * Returns true if the address holds the member hat, false if not found.
 * Throws on network error — caller handles fallback.
 */
export async function isOrgMember(
  address: string,
  orgIdOrName?: string,
  chainId?: number,
): Promise<boolean> {
  const members = await fetchOrgMembers(orgIdOrName, chainId);
  return members.has(address.toLowerCase());
}

/** Invalidate the cache (useful for tests and pop brain doctor refreshes). */
export function clearMembershipCache(): void {
  cache.clear();
}

/**
 * Non-throwing variant: returns the member set or null on any error.
 * Used by pop brain doctor to show current dynamic membership without
 * bailing the whole health check.
 */
export async function tryFetchOrgMembers(
  orgIdOrName?: string,
  chainId?: number,
): Promise<Set<string> | null> {
  try {
    return await fetchOrgMembers(orgIdOrName, chainId);
  } catch {
    return null;
  }
}
