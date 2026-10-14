/**
 * ZK Email reads — module resolution + state for `pop zkemail status` /
 * `pop zkemail claims`. Port of src/commands/zkemail/helpers.ts (client- and
 * provider-injected) plus the claim-history read from
 * src/commands/zkemail/claims.ts.
 *
 * The ZkEmailInvites module is OPTIONAL per org — `organization.zkEmailInvites`
 * is null for orgs deployed without it — and a deployed module with
 * `merkleRoot == 0` is DORMANT (every claim reverts until governance publishes
 * an allowlist). Both states get a named error rather than a confusing revert.
 */

import { ethers } from 'ethers';
import type { GraphClient } from '../graph/client';
import {
  FETCH_ZKEMAIL_MODULE_TIERS,
  FETCH_ZKEMAIL_MODULE,
  FETCH_ZKEMAIL_CLAIMS,
  FETCH_ZKEMAIL_ACTIVE_ROOT,
  FETCH_ORG_ROLE_NAMES,
} from '../graph/documents/zkemail';
import { resolveOrgId } from './resolve';
import { createReadContract } from '../contracts';
import { resolveNetworkConfig } from '../chains';
import { bytes32ToIpfsCid, ipfsCidToBytes32 } from '../encoding';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
import type { EnvSource } from '../env';
import {
  Fact, SourceRef, SourceSnapshot, PlanScope, PlanResult, knownFact, unknownFact,
  requireCompleteSnapshot, assertPlanScope, assertSourceBlock, assertSourceRef,
} from '../data/facts';
import { metadataPointerToBytes32 } from '../encoding/cid';
import { VerifiedAllowlist, projectVerifiedAllowlistLeaves } from '../email/allowlist';
import { EmailCircuitVersion } from '../email/proof';
import { domainHash, emailHash, norm, requireAllowlistUint } from '../zkemail';

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
 * Resolve the org's ZkEmailInvites proxy from the subgraph. Port of
 * resolveZkEmailModule in src/commands/zkemail/helpers.ts.
 * Throws a named error when the org has no module rather than letting a null
 * address turn into an opaque call failure.
 */
export async function resolveZkEmailModule(
  client: GraphClient,
  orgArg: string | undefined,
  chainId?: number
): Promise<{ orgId: string; orgName: string | null; address: string; subgraph: any; indexedWiring: boolean }> {
  const orgId = await resolveOrgId(client, orgArg, chainId);
  // Modern tier carries the wiring + DKIM keys (subgraph-pop #197); the legacy tier is the
  // allowlist-only shape served before it. tierIndex tells callers whether they still have to
  // fall back to RPC for the rest.
  const { data: res, tierIndex } = await client.queryWithFieldFallback<{ organization: any }>(
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
 * Read the module's state, preferring the subgraph. Port of readModuleState in
 * src/commands/zkemail/helpers.ts (the read behind `pop zkemail status`).
 *
 * `activeRoot` and `activeAllowlistCid` are indexed on the ZkEmailInvites entity, so the
 * allowlist half needs no RPC at all — `resolveZkEmailModule` has already fetched it. Only the
 * wiring addresses (executor + the four verifier/registry pointers) are unindexed pre-#197, so
 * they are fetched on demand: pass `withWiring` when the caller actually renders them.
 *
 * Pass an existing `provider` to avoid opening a second connection; when omitted and an RPC
 * read is needed, a JsonRpcProvider is built from resolveNetworkConfig(chainId, env).
 */
export async function readModuleState(
  address: string,
  orgId: string,
  orgName: string | null,
  chainId?: number,
  provider?: ethers.providers.Provider,
  opts?: { subgraph?: any; withWiring?: boolean; withDkimRegistry?: boolean; env?: EnvSource }
): Promise<ZkEmailModuleState> {
  const indexed = opts?.subgraph;
  // The subgraph stores the CID as a decoded CIDv0 string and the root as Bytes. It is the
  // authority for both; on-chain reads are only needed when the module is not indexed yet.
  //
  // In practice this is always true for the in-repo callers: BOTH tiers of
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
    ? (provider ?? new ethers.providers.JsonRpcProvider(resolveNetworkConfig(chainId, opts?.env).resolvedRpc))
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

/**
 * The indexed active root for an org's module, identity-guarded — the display
 * read used by `pop zkemail propose-allowlist`
 * (src/commands/zkemail/propose-allowlist.ts).
 *
 * Returns:
 *   - a root string (HashZero for a dormant module whose row EXISTS), or
 *   - null when the row is missing / the indexed module id does not match
 *     `moduleAddress` (a stale org->module pointer must not describe a
 *     different contract than the one a proposal targets). Callers fall back
 *     to merkleRoot() on-chain for the null case.
 */
export async function fetchIndexedActiveRoot(
  client: GraphClient,
  orgId: string,
  moduleAddress: string,
  chainId?: number
): Promise<string | null> {
  try {
    const res = await client.query<{ organization: any }>(FETCH_ZKEMAIL_ACTIVE_ROOT, { orgId }, chainId);
    const mod = res.organization?.zkEmailInvites;
    if (!mod?.id || String(mod.id).toLowerCase() !== moduleAddress.toLowerCase()) return null;
    return (mod.activeRoot as string | null) ?? ethers.constants.HashZero;
  } catch {
    return null;
  }
}

export interface ZkEmailClaimRow {
  id: string;
  kind: string;
  claimer: string;
  claimerUsername: string | null;
  /** The allowlist leaf the claim used — may belong to a SUPERSEDED allowlist. */
  identifierHash: string;
  hatIds: string[];
  /** Absent on the passkey onboarding path, which does not emit it (majority of live Gnosis claims). */
  nullifier: string | null;
  registeredUsername: string | null;
  claimedAt: string;
  claimedAtBlock: string;
  transactionHash: string;
}

/**
 * Claim history for a module, most recent first — the read behind
 * `pop zkemail claims` (src/commands/zkemail/claims.ts). Indexed since
 * subgraph-pop #197; on a chain still serving the legacy tier the claim events
 * were seen but every parameter was discarded, so there is nothing to read —
 * callers should gate on `indexedWiring` from resolveZkEmailModule like the
 * CLI does.
 */
export async function fetchZkEmailClaims(
  client: GraphClient,
  moduleAddress: string,
  chainId?: number,
  limit = 50
): Promise<ZkEmailClaimRow[]> {
  const res = await client.query<{ zkEmailClaims: ZkEmailClaimRow[] }>(
    FETCH_ZKEMAIL_CLAIMS,
    { module: moduleAddress.toLowerCase(), first: Math.max(1, Math.min(1000, limit)) },
    chainId
  );
  return res.zkEmailClaims ?? [];
}

/** Map hatId -> role name so allowlists render as "gmail.com -> Member". */
export async function fetchRoleNames(
  client: GraphClient,
  orgId: string,
  chainId?: number
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const res = await client.query<{ organization: any }>(FETCH_ORG_ROLE_NAMES, { orgId }, chainId);
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

// Truthful companion for safety decisions. Legacy CLI display shapes above remain unchanged.

export interface InviteStateFacts {
  root: Fact<string>;
  cidDigest: Fact<string>;
  entries: Fact<readonly SubgraphAllowlistEntry[]>;
  executor: Fact<string>;
  domainVerifier: Fact<string>;
  emailVerifier: Fact<string>;
  dkimRegistry: Fact<string>;
  accountRegistry: Fact<string>;
  universalFactory: Fact<string>;
  /** Fresh authority/router cutover and executor->authority binding, checked by the injected reader. */
  authorityReady: Fact<boolean>;
  authorityMatches: Fact<boolean>;
  minterAuthorized: Fact<boolean>;
  /** Exact proven From-domain + pubkeyHash validity, never provider DKIM domain alone. */
  dkimKeyValid: Fact<boolean>;
  circuitVersion: Fact<EmailCircuitVersion>;
  /** Identity of the serving/deployed verification key, supplied by the host capability check. */
  keyVersion: Fact<string>;
  /** Needed only for a sponsored action. */
  budgetAvailable: Fact<boolean>;
}
export interface InviteStateEvidence {
  indexed: SourceSnapshot<InviteStateFacts>;
  authoritative?: SourceSnapshot<InviteStateFacts>;
}
const inviteFields = ['root', 'cidDigest', 'entries', 'executor', 'domainVerifier', 'emailVerifier', 'dkimRegistry',
  'accountRegistry', 'universalFactory', 'authorityReady', 'authorityMatches', 'minterAuthorized', 'dkimKeyValid',
  'circuitVersion', 'keyVersion', 'budgetAvailable'] as const;
function unknownInviteFacts(code: string, source: SourceRef): InviteStateFacts {
  return Object.fromEntries(inviteFields.map(key => [key, unknownFact(code, source)])) as unknown as InviteStateFacts;
}
function bytesFact(value: unknown, source: SourceRef): Fact<string> {
  return typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value)
    ? knownFact(value.toLowerCase(), source) : unknownFact('INDEXED_FIELD_UNAVAILABLE', source);
}
function addressFact(value: unknown, source: SourceRef): Fact<string> {
  return typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value)
    ? knownFact(value.toLowerCase(), source) : unknownFact('INDEXED_FIELD_UNAVAILABLE', source);
}

/** Strict companion normalization; the legacy display normalizer keeps its historical defaults. */
function indexedInviteEntries(entries: readonly any[]): SubgraphAllowlistEntry[] {
  let previous = -1;
  return entries.map(entry => {
    if (!entry || !['domain', 'email'].includes(entry.entryType)
      || (entry.identifier !== null && typeof entry.identifier !== 'string')
      || typeof entry.identifierHash !== 'string' || !/^0x[\da-f]{64}$/i.test(entry.identifierHash)
      || !Array.isArray(entry.hatIds) || !entry.hatIds.length || !Array.isArray(entry.roleIndexes)) throw new Error('Incomplete indexed entry');
    const safeIndex = (value: string | number) => {
      const exact = BigInt(requireAllowlistUint(value));
      if (exact > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe indexed display position');
      return Number(exact);
    };
    const index = safeIndex(entry.index);
    if (index <= previous) throw new Error('Duplicate or unordered indexed entries');
    previous = index;
    const identifier = entry.identifier;
    if (entry.entryType === 'domain' && !norm(identifier)) throw new Error('Missing indexed domain name');
    if (identifier) {
      const hash = entry.entryType === 'domain' ? domainHash(identifier) : emailHash(identifier);
      if (hash !== entry.identifierHash.toLowerCase()) throw new Error('Mismatched indexed descriptor');
    }
    return { index, entryType: entry.entryType, identifier, identifierHash: entry.identifierHash.toLowerCase(),
      hatIds: entry.hatIds.map(requireAllowlistUint), roleIndexes: entry.roleIndexes.map(safeIndex) };
  });
}

/**
 * Inject the host's existing graph client and optional authoritative snapshot callback.
 * No RPC/provider is constructed, and no network fallback is implicit. The query has a 1000-row cap.
 */
export async function readInviteStateFacts(args: {
  scope: PlanScope & { orgId: string; contract: string };
  source: SourceRef;
  query: (document: string, variables: { orgId: string }, chainId: number) => Promise<{ organization?: any }>;
  readAuthoritative?: () => Promise<SourceSnapshot<InviteStateFacts>>;
}): Promise<InviteStateEvidence> {
  assertSourceRef(args.source);
  assertPlanScope(args.source, args.scope);
  if (!args.source.indexed) throw new Error('Indexed invitation reader requires indexed source');
  // The existing document has no block selector. Never label that latest query a pinned read.
  if (args.source.snapshot === 'pinned' || args.source.block !== undefined) throw new Error('Invitation graph document cannot pin a block');
  const source = args.source;
  let data = unknownInviteFacts('INDEX_UNAVAILABLE', source);
  const issues: { code: string }[] = [];
  let status: 'complete' | 'incomplete' | 'unavailable' = 'complete';
  try {
    const response = await args.query(FETCH_ZKEMAIL_MODULE, { orgId: args.scope.orgId }, args.scope.chainId);
    const org = response?.organization, mod = org?.zkEmailInvites;
    if (String(org?.id).toLowerCase() !== args.scope.orgId.toLowerCase()
      || String(mod?.id).toLowerCase() !== args.scope.contract.toLowerCase()) {
      issues.push({ code: 'INDEX_SCOPE_MISMATCH' }); status = 'unavailable';
    } else {
      data.root = bytesFact(mod.activeRoot, source);
      if (mod.activeAllowlistCid != null) {
        try { data.cidDigest = knownFact(metadataPointerToBytes32(mod.activeAllowlistCid), source); }
        catch { data.cidDigest = unknownFact('INDEXED_CID_INVALID', source); }
      }
      for (const field of ['executor', 'domainVerifier', 'emailVerifier', 'accountRegistry', 'universalFactory'] as const) {
        data[field] = addressFact(mod[field], source);
      }
      data.dkimRegistry = addressFact(mod.dkimRegistry?.id, source);
      const allowlist = mod.activeAllowlist;
      if (!allowlist || data.root.state !== 'known' || typeof allowlist.root !== 'string'
        || allowlist.root.toLowerCase() !== data.root.value || !Array.isArray(allowlist.entries)) {
        data.entries = unknownFact('INDEX_LIST_UNVERIFIED', source);
      } else if (allowlist.entries.length >= 1000) {
        issues.push({ code: 'INDEX_LIST_CAPPED' }); status = 'incomplete';
        data.entries = unknownFact('INDEX_LIST_CAPPED', source);
      } else if (allowlist.entries.length === 0 && data.root.value !== ethers.constants.HashZero) {
        issues.push({ code: 'INDEX_LIST_EMPTY' }); status = 'incomplete';
        data.entries = unknownFact('INDEX_LIST_EMPTY', source);
      } else {
        try { data.entries = knownFact(indexedInviteEntries(allowlist.entries), source); }
        catch {
          data.entries = unknownFact('INDEX_LIST_INVALID', source); issues.push({ code: 'INDEX_LIST_INVALID' }); status = 'incomplete';
        }
      }
      if (!Array.isArray(mod.dkimRegistry?.keys)) issues.push({ code: 'INDEX_KEYS_UNAVAILABLE' });
      else if (mod.dkimRegistry.keys.length >= 1000) issues.push({ code: 'INDEX_KEYS_CAPPED' });
      if (issues.length && status === 'complete') status = 'incomplete';
    }
  } catch {
    data = unknownInviteFacts('INDEX_READ_FAILED', source); status = 'unavailable'; issues.push({ code: 'INDEX_READ_FAILED' });
  }
  const indexed: SourceSnapshot<InviteStateFacts> = { source, data, coverage: {
    status, receivedKeys: status === 'unavailable' ? [] : [args.scope.contract], missingIds: [],
    failedIds: status === 'unavailable' ? [args.scope.contract] : [], issues, cap: 1000, pages: 1,
  } };
  // A callback failure remains a rejected read. Never manufacture an authoritative empty success.
  const authoritative = args.readAuthoritative ? await args.readAuthoritative() : undefined;
  return { indexed, ...(authoritative ? { authoritative } : {}) };
}

export interface InviteActionReady { root: string; cidDigest: string; version: EmailCircuitVersion; keyVersion: string }
export interface InviteStateProjection {
  lifecycle: Fact<'active' | 'dormant'>;
  indexedEntries: Fact<readonly SubgraphAllowlistEntry[]>;
  action: PlanResult<InviteActionReady>;
}

/** Latest authoritative wiring is required for readiness; indexed evidence is descriptive only. */
export function projectInviteState(args: {
  scope: PlanScope & { orgId: string; contract: string };
  evidence: InviteStateEvidence;
  document?: VerifiedAllowlist;
  /** A host must attest this fetched document belongs to the current CID, not merely an equal root. */
  documentCidDigest?: string;
  version: EmailCircuitVersion;
  keyVersion: string;
  enrollment?: boolean;
  sponsored?: boolean;
  /** Optional explicit freshness gate; no ambient clock. */
  freshness?: { nowSeconds: number; maxAgeSeconds: number };
}): InviteStateProjection {
  const codes: string[] = [];
  const block = (code: string) => { if (!codes.includes(code)) codes.push(code); };
  let lifecycle: Fact<'active' | 'dormant'> = unknownFact('AUTHORITATIVE_ROOT_UNAVAILABLE');
  let indexedEntries: Fact<readonly SubgraphAllowlistEntry[]> = unknownFact('INDEX_LIST_UNVERIFIED');
  try {
    const index = requireCompleteSnapshot(args.evidence.indexed, { scope: args.scope, indexed: true });
    indexedEntries = index.entries;
  } catch { /* Capped, failed or wrongly scoped index stays unknown. */ }
  const authoritative = args.evidence.authoritative;
  let facts: InviteStateFacts | undefined;
  try {
    if (!authoritative) throw new Error('Missing authority');
    facts = requireCompleteSnapshot(authoritative, { scope: args.scope, indexed: false });
    if (authoritative.source.snapshot !== 'latest' && authoritative.source.snapshot !== 'pinned') throw new Error('Unspecified live snapshot');
    if (args.freshness) {
      const { nowSeconds, maxAgeSeconds } = args.freshness;
      const observed = authoritative.source.observedAt;
      if (!Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0
        || observed === undefined || observed > nowSeconds || nowSeconds - observed > maxAgeSeconds) throw new Error('Stale source');
    }
  } catch { facts = undefined; block('AUTHORITATIVE_STATE_UNAVAILABLE'); }
  function value<T>(fact: Fact<T> | undefined, name: string): T | undefined {
    if (!fact || fact.state !== 'known') { block(`${name}_UNKNOWN`); return undefined; }
    if (fact.source) {
      try {
        assertSourceRef(fact.source);
        assertPlanScope(fact.source, args.scope);
        if (fact.source.indexed || (fact.source.snapshot !== 'latest' && fact.source.snapshot !== 'pinned')) throw new Error('Non-authoritative fact');
        if (authoritative?.source.block) assertSourceBlock(fact.source.block, authoritative.source.block);
        if (args.freshness) {
          const observed = fact.source.observedAt;
          if (observed === undefined || observed > args.freshness.nowSeconds
            || args.freshness.nowSeconds - observed > args.freshness.maxAgeSeconds) throw new Error('Stale fact');
        }
      } catch { block(`${name}_SCOPE_MISMATCH`); return undefined; }
    }
    return fact.value;
  }
  const root = value(facts?.root, 'ROOT'), cid = value(facts?.cidDigest, 'CID');
  if (root !== undefined && /^0x[\da-f]{64}$/i.test(root)) {
    lifecycle = knownFact(root.toLowerCase() === ethers.constants.HashZero ? 'dormant' : 'active', authoritative!.source);
    if (root.toLowerCase() === ethers.constants.HashZero) block('ALLOWLIST_DORMANT');
  } else block('ROOT_INVALID');
  if (cid === undefined || !/^0x[\da-f]{64}$/i.test(cid) || cid.toLowerCase() === ethers.constants.HashZero) block('CID_UNAVAILABLE');
  const requireAddress = (fact: Fact<string> | undefined, name: string) => {
    const address = value(fact, name);
    if (address !== undefined && (!/^0x[\da-f]{40}$/i.test(address) || BigInt(address) === 0n)) block(`${name}_UNSET`);
  };
  requireAddress(facts?.executor, 'EXECUTOR'); requireAddress(facts?.dkimRegistry, 'DKIM_REGISTRY');
  if (args.version !== 'v1' && args.version !== 'v2') block('CIRCUIT_UNSUPPORTED');
  requireAddress(args.version === 'v1' ? facts?.domainVerifier : facts?.emailVerifier, 'VERIFIER');
  for (const [name, fact] of [ ['AUTHORITY_READY', facts?.authorityReady], ['AUTHORITY_MATCHES', facts?.authorityMatches],
    ['MINTER_AUTHORIZED', facts?.minterAuthorized], ['DKIM_KEY_VALID', facts?.dkimKeyValid] ] as const) {
    const actual = value(fact, name); if (actual !== undefined && actual !== true) block(`${name}_FALSE`);
  }
  if (value(facts?.circuitVersion, 'CIRCUIT_VERSION') !== args.version) block('CIRCUIT_VERSION_MISMATCH');
  if (!args.keyVersion || value(facts?.keyVersion, 'KEY_VERSION') !== args.keyVersion) block('KEY_VERSION_MISMATCH');
  if (args.enrollment) { requireAddress(facts?.accountRegistry, 'ACCOUNT_REGISTRY'); requireAddress(facts?.universalFactory, 'FACTORY'); }
  if (args.sponsored && value(facts?.budgetAvailable, 'BUDGET') !== true) block('BUDGET_UNAVAILABLE');
  try {
    if (!args.document) throw new Error('Missing document');
    projectVerifiedAllowlistLeaves(args.document);
    if (args.document.orgId !== args.scope.orgId.toLowerCase() || args.document.root !== root?.toLowerCase()
      || args.documentCidDigest?.toLowerCase() !== cid?.toLowerCase()) throw new Error('Document scope mismatch');
  } catch { block('VERIFIED_DOCUMENT_UNAVAILABLE'); }
  return { lifecycle, indexedEntries, action: codes.length ? { status: 'blocked', codes,
    prerequisites: codes.map(code => ({ code, scope: args.scope })), consequences: [] }
    : { status: 'ready', data: { root: root!, cidDigest: cid!, version: args.version, keyVersion: args.keyVersion }, consequences: [] } };
}
