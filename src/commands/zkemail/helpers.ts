/**
 * Shared plumbing for `pop zkemail *`.
 *
 * The ZkEmailInvites module is OPTIONAL per org — `organization.zkEmailInvites` is null for
 * orgs deployed without it — and a deployed module with `merkleRoot == 0` is DORMANT (every
 * claim reverts until governance publishes an allowlist). Both states get a named error rather
 * than a confusing revert.
 */

import { ethers } from 'ethers';
import { query, queryWithFieldFallback } from '../../lib/subgraph';
import { resolveOrgId } from '../../lib/resolve';
import { createReadContract } from '../../lib/contracts';
import { resolveNetworkConfig } from '../../config/networks';
import { FETCH_ZKEMAIL_MODULE_TIERS, FETCH_ORG_ROLE_NAMES } from '../../queries/zkemail';
import { bytes32ToIpfsCid, ipfsCidToBytes32 } from '../../lib/encoding';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';

export interface ZkEmailModuleState {
  orgId: string;
  orgName: string | null;
  address: string;
  /** On-chain active merkle root; ethers.constants.HashZero when dormant. */
  merkleRoot: string;
  /** On-chain allowlist CID digest (bytes32). */
  allowlistCidDigest: string;
  /** allowlistCidDigest decoded back to a CIDv0, or null when unset. */
  allowlistCid: string | null;
  /** True when no allowlist is committed — every claim reverts with AllowlistNotActive. */
  dormant: boolean;
  // Undefined when the wiring was not fetched: pre-#197 without `withWiring`, or a field the
  // module has genuinely never set (universalFactory may be address(0) at init).
  executor?: string;
  domainVerifier?: string;
  emailVerifier?: string;
  dkimRegistry?: string;
  accountRegistry?: string;
  universalFactory?: string;
  /** True when the wiring came from the subgraph rather than eth_calls. */
  indexedWiring: boolean;
}

export interface SubgraphAllowlistEntry {
  index: number;
  entryType: string;
  identifier: string | null;
  identifierHash: string | null;
  hatIds: string[];
  roleIndexes: number[];
}

/**
 * Resolve the org's ZkEmailInvites proxy from the subgraph.
 * Throws a named error when the org has no module rather than letting a null address
 * turn into an opaque call failure.
 */
export async function resolveZkEmailModule(
  orgArg: string | undefined,
  chainId?: number
): Promise<{ orgId: string; orgName: string | null; address: string; subgraph: any; indexedWiring: boolean }> {
  const orgId = await resolveOrgId(orgArg, chainId);
  // Modern tier carries the wiring + DKIM keys (subgraph-pop #197); the legacy tier is the
  // allowlist-only shape served before it. tierIndex tells callers whether they still have to
  // fall back to RPC for the rest.
  const { data: res, tierIndex } = await queryWithFieldFallback<{ organization: any }>(
    FETCH_ZKEMAIL_MODULE_TIERS.map((q) => ({ query: q, variables: { orgId } })),
    { chainId }
  );
  const indexedWiring = tierIndex === 0;
  const org = res.organization;
  if (!org) {
    throw new CliError(`Organization ${orgId} not found on this chain.`, EXIT.USAGE);
  }
  const mod = org.zkEmailInvites;
  if (!mod?.id) {
    throw new CliError(
      `Org "${org.name || orgId}" has no ZkEmailInvites module.`,
      EXIT.PRECONDITION,
      'ZK Email invites are opt-in per org — the module is wired at deploy time via '
        + 'OrgDeployer.deployFullOrgWithZkEmail. Existing orgs need a governance-approved module install.'
    );
  }
  return { orgId, orgName: org.name ?? null, address: mod.id, subgraph: mod, indexedWiring };
}

/**
 * Read the module's state, preferring the subgraph.
 *
 * `activeRoot` and `activeAllowlistCid` are indexed on the ZkEmailInvites entity, so the
 * allowlist half needs no RPC at all — `resolveZkEmailModule` has already fetched it. Only the
 * wiring addresses (executor + the four verifier/registry pointers) are unindexed, so they are
 * fetched on demand: pass `withWiring` when the caller actually renders them (`zkemail status`).
 *
 * Pass an existing `provider` to avoid opening a second connection.
 */
export async function readModuleState(
  address: string,
  orgId: string,
  orgName: string | null,
  chainId?: number,
  provider?: ethers.providers.Provider,
  opts?: { subgraph?: any; withWiring?: boolean; withDkimRegistry?: boolean }
): Promise<ZkEmailModuleState> {
  const indexed = opts?.subgraph;
  // The subgraph stores the CID as a decoded CIDv0 string and the root as Bytes. It is the
  // authority for both; on-chain reads are only needed when the module is not indexed yet.
  //
  // In practice this is always true for the three in-repo callers: BOTH tiers of
  // FETCH_ZKEMAIL_MODULE_TIERS select `activeRoot` (it exists on the Arbitrum pre-#197 schema
  // too), and resolveZkEmailModule throws before returning a module-less org — so the
  // merkleRoot()/allowlistCid() pair below never fires today. It is kept because `opts` is
  // optional on this exported helper: a caller that omits `subgraph` must still get a correct
  // answer rather than an undefined root.
  const haveIndexed = indexed != null && indexed.activeRoot !== undefined;

  let merkleRoot: string;
  let allowlistCid: string | null;
  let cidDigest: string;

  // Post-#197 the module entity carries the wiring, so `withWiring` needs no RPC either.
  const indexedHasWiring = indexed != null && indexed.executor !== undefined;
  const wantsWiring = opts?.withWiring === true || opts?.withDkimRegistry === true;
  const needsRpc = !haveIndexed || (wantsWiring && !indexedHasWiring);
  const p = needsRpc
    ? (provider ?? new ethers.providers.JsonRpcProvider(resolveNetworkConfig(chainId).resolvedRpc))
    : null;
  const c = p ? createReadContract(address, 'ZkEmailInvites', p) : null;

  if (haveIndexed) {
    merkleRoot = indexed.activeRoot ?? ethers.constants.HashZero;
    allowlistCid = indexed.activeAllowlistCid ?? null;
    cidDigest = allowlistCid ? ipfsCidToBytes32(allowlistCid) : ethers.constants.HashZero;
  } else {
    const [root, digest] = await Promise.all([c!.merkleRoot(), c!.allowlistCid()]);
    merkleRoot = root;
    cidDigest = digest;
    allowlistCid = bytes32ToIpfsCid(digest);
  }

  // Wiring: indexed since subgraph-pop #197, so the six eth_calls below only run against a
  // deployment that predates it. `dkimRegistry` is an entity reference there, hence the `.id`.
  //
  // NOT dead code. Gnosis serves #197, but ARBITRUM (chain 42161) still runs the older
  // deployment QmYGCS4pXoaqXX7WjaPEhA56kiwgC14z7jsstZzEQgxgUp, whose ZkEmailInvites type is
  // only {id, organization, activeRoot, activeAllowlistCid, activeAllowlist, createdAt,
  // lastUpdatedAt} — no executor, no dkimRegistry — so the LEGACY tier is what wins there and
  // `indexedHasWiring` is false. Verified by introspection 2026-07. Deleting this branch would
  // break `pop zkemail status --chain 42161` the moment an Arbitrum org installs the module.
  let executor: string | undefined;
  let domainVerifier: string | undefined;
  let emailVerifier: string | undefined;
  let dkimRegistry: string | undefined;
  let accountRegistry: string | undefined;
  let universalFactory: string | undefined;

  if (indexedHasWiring) {
    executor = indexed.executor ?? undefined;
    domainVerifier = indexed.domainVerifier ?? undefined;
    emailVerifier = indexed.emailVerifier ?? undefined;
    dkimRegistry = indexed.dkimRegistry?.id ?? undefined;
    accountRegistry = indexed.accountRegistry ?? undefined;
    universalFactory = indexed.universalFactory ?? undefined;
  } else if (opts?.withWiring && c) {
    [executor, domainVerifier, emailVerifier, dkimRegistry, accountRegistry, universalFactory] =
      await Promise.all([
        c.executor(), c.domainVerifier(), c.emailVerifier(),
        c.dkimRegistry(), c.accountRegistry(), c.universalFactory(),
      ]);
  } else if (opts?.withDkimRegistry && c) {
    // `zkemail check` needs only this one pointer; pulling all six would be five wasted calls.
    dkimRegistry = await c.dkimRegistry();
  }

  return {
    orgId,
    orgName,
    address,
    merkleRoot,
    allowlistCidDigest: cidDigest,
    allowlistCid,
    dormant: merkleRoot === ethers.constants.HashZero,
    executor,
    domainVerifier,
    emailVerifier,
    dkimRegistry,
    accountRegistry,
    universalFactory,
    indexedWiring: indexedHasWiring,
  };
}

/** Map hatId -> role name so allowlists render as "gmail.com -> Member". */
export async function fetchRoleNames(orgId: string, chainId?: number): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const res = await query<{ organization: any }>(FETCH_ORG_ROLE_NAMES, { orgId }, chainId);
    for (const r of res.organization?.roles ?? []) {
      if (r.hatId && r.name) map.set(ethers.BigNumber.from(r.hatId).toString(), r.name);
    }
  } catch {
    // Role names are cosmetic — a subgraph hiccup must not fail an allowlist read.
  }
  return map;
}

/** Render a hat ID as "Member (0x2a)" when the name is known, else the raw id. */
export function labelHat(hatId: string, names: Map<string, string>): string {
  const dec = ethers.BigNumber.from(hatId).toString();
  const name = names.get(dec);
  return name ? `${name} (${dec})` : dec;
}

/** Normalize the subgraph's allowlist entries into a stable shape. */
export function normalizeEntries(allowlist: any): SubgraphAllowlistEntry[] {
  return (allowlist?.entries ?? []).map((e: any) => ({
    index: Number(e.index),
    entryType: e.entryType,
    identifier: e.identifier ?? null,
    identifierHash: e.identifierHash ?? null,
    hatIds: (e.hatIds ?? []).map((h: any) => ethers.BigNumber.from(h).toString()),
    roleIndexes: (e.roleIndexes ?? []).map((r: any) => Number(r)),
  }));
}
