/**
 * Treasury reads — typed wrappers over graph/documents/treasury.
 *
 * Serves the read paths of `pop treasury view` (src/commands/treasury/view.ts),
 * `pop treasury distributions` (src/commands/treasury/distributions.ts), the
 * distribution lookups of `pop treasury claim` / `claim-mine`, and the member
 * snapshots that `compute-merkle` / `claim-mine` build merkle trees from.
 *
 * Read-sourcing policy (inherited from the CLI, comments load-bearing):
 *   - display reads (view / distributions) are pure subgraph
 *   - `distribution(id:)` answers null — NOT an error — for an id it has not
 *     indexed, and a brand-new distribution is exactly the case where someone
 *     claims early. Callers MUST treat null as "not indexed yet" and fall back
 *     to PaymentManager.getDistribution, never render it as DistributionNotFound.
 *   - the write-gating twins (hasClaimed / isOptedOut / getDistribution as a
 *     revert predictor) stay on RPC in the host. isOptedOut in particular has
 *     no trustworthy indexed twin: the OptOutToggle table has ZERO rows on all
 *     nine live Gnosis PaymentManagers (verified 2026-07) because zero
 *     OptOutToggled events have ever been emitted, so the mapping is
 *     unexercised and no live row proves it indexes correctly.
 */

import { ethers } from 'ethers';
import type { GraphClient } from '../graph/client';
import {
  FETCH_TREASURY_DATA,
  FETCH_DISTRIBUTION_BY_ID,
  FETCH_ACTIVE_DISTRIBUTIONS,
  distributionEntityId,
} from '../graph/documents/treasury';
import { resolveOrgId } from './resolve';
import { createReadContract } from '../contracts';
import { getNetworkByChainId, getTokenByAddress } from '../chains';
import { requireAssetRef, requireRawUint, sumRawAssetAmounts, type AssetRef, type RawAssetAmount } from '../amounts';
import { assertPlanScope, assertSourceBlock, assertSourceRef, knownFact, requireCompleteSnapshot, unknownFact, type Fact, type SourceRef, type SourceSnapshot } from '../data/facts';
import { readIndexedPageFacts, type IndexedRow, type ProtocolQuery } from './protocol';
import { readWorkPageFacts, requireWorkSource } from './project';
import { FETCH_TREASURY_TASK_ACTIVITY_PAGE, FETCH_PROMISED_BOUNTIES_PAGE, FETCH_DISTRIBUTIONS_PAGE, FETCH_PAYMENTS_PAGE, FETCH_DISTRIBUTION_CLAIMS_PAGE } from '../graph/documents/treasury';
import { FETCH_EXECUTED_DISTRIBUTION_PROPOSALS_PAGE } from '../graph/documents/financial-history';
import { parseDistributionClaimsDiscoveryMarker } from '../metadata/distribution';
import type { PaymentManagerRound, PaymentManagerState } from '../treasury/planning';
import { assertTreasuryModuleBindings } from '../treasury/evidence';

export { distributionEntityId };

// ---------------------------------------------------------------------------
// Raw subgraph entity shapes (as FETCH_TREASURY_DATA returns them)
// ---------------------------------------------------------------------------

export interface DistributionClaimRow {
  id: string;
  claimer: string;
  claimerUsername: string | null;
  amount: string;
  claimedAt: string;
  transactionHash: string;
}

export interface DistributionRow {
  id: string;
  distributionId: string;
  payoutToken: string;
  totalAmount: string;
  totalClaimed: string;
  checkpointBlock: string;
  createdAtBlock: string | null;
  merkleRoot: string;
  /** Enum is exactly Active | Finalized. */
  status: 'Active' | 'Finalized' | string;
  createdAt: string | null;
  finalizedAt: string | null;
  unclaimedAmount: string | null;
  claims: DistributionClaimRow[];
}

export interface PaymentRow {
  id: string;
  payer: string;
  payerUsername: string | null;
  amount: string;
  token: string;
  receivedAt: string;
  transactionHash: string;
}

export interface TreasuryData {
  id: string;
  executorContract: {
    id: string;
    isPaused: boolean;
    owner: string | null;
    allowedCaller: string | null;
    sweeps: Array<{ id: string; to: string; amount: string; sweptAt: string; transactionHash: string }>;
  } | null;
  participationToken: { id: string; name: string; symbol: string; totalSupply: string } | null;
  paymentManager: {
    id: string;
    owner: string | null;
    revenueShareToken: string | null;
    distributionCounter: string;
    distributions: DistributionRow[];
    payments: PaymentRow[];
  } | null;
}

/**
 * Full treasury overview — subgraph read behind `pop treasury view`
 * (src/commands/treasury/view.ts) and `pop treasury distributions`
 * (src/commands/treasury/distributions.ts). Returns the raw organization
 * entity; null when the org is unknown on this chain.
 */
export async function fetchTreasuryData(
  client: GraphClient,
  orgIdOrName: string | undefined,
  chainId?: number
): Promise<TreasuryData | null> {
  const orgId = await resolveOrgId(client, orgIdOrName, chainId);
  const result = await client.query<{ organization: TreasuryData | null }>(
    FETCH_TREASURY_DATA,
    { orgId },
    chainId
  );
  return result.organization ?? null;
}

/**
 * Distribution list, optionally filtered by status — the selection behind
 * `pop treasury distributions --status ...`.
 */
export async function listDistributions(
  client: GraphClient,
  orgIdOrName: string | undefined,
  chainId?: number,
  status?: 'Active' | 'Finalized'
): Promise<DistributionRow[]> {
  const org = await fetchTreasuryData(client, orgIdOrName, chainId);
  let distributions = org?.paymentManager?.distributions ?? [];
  if (status) distributions = distributions.filter((d) => d.status === status);
  return distributions;
}

export interface IndexedDistribution {
  id: string;
  distributionId: string;
  /** Re-checksummed at the boundary (the subgraph stores addresses lowercased,
   * while the ABI-decoded getDistribution() path yields EIP-55 — without this
   * the value silently changes case depending on whether the distribution
   * happens to be indexed). */
  payoutToken: string;
  totalAmount: string;
  totalClaimed: string;
  checkpointBlock: string;
  /** The contract has NO getter for this — subgraph-only field. */
  createdAtBlock: string | null;
  merkleRoot: string;
  status: 'Active' | 'Finalized' | string;
  /** Derived exactly like `pop treasury claim` does: status === 'Finalized'.
   * The enum only becomes Finalized once DistributionFinalized is indexed, so
   * a false positive is impossible; a stale Active is caught at gas estimation. */
  finalized: boolean;
}

/**
 * One distribution by (paymentManager, distributionId) — the indexed twin of
 * PaymentManager.getDistribution(), read behind `pop treasury claim`
 * (src/commands/treasury/claim.ts).
 *
 * Returns null when the subgraph has not indexed the id — callers MUST fall
 * back to getDistribution() on-chain, never treat null as DistributionNotFound.
 */
export async function fetchDistributionById(
  client: GraphClient,
  paymentManagerAddress: string,
  distributionId: number | string,
  chainId?: number
): Promise<IndexedDistribution | null> {
  const result = await client
    .query<{ distribution: any }>(
      FETCH_DISTRIBUTION_BY_ID,
      { id: distributionEntityId(paymentManagerAddress, distributionId) },
      chainId
    )
    .catch(() => ({ distribution: null }));
  const indexed = result.distribution;
  if (!indexed) return null;
  return {
    ...indexed,
    payoutToken: ethers.utils.getAddress(indexed.payoutToken),
    finalized: indexed.status === 'Finalized',
  };
}

export interface ActiveDistributionRow {
  distributionId: string;
  totalAmount: string;
  merkleRoot: string;
  checkpointBlock: string;
  payoutToken: string;
  claims: Array<{ claimer: string }>;
}

/**
 * Every still-claimable distribution with its claim log — the read behind
 * `pop treasury claim-mine` (src/commands/treasury/claim-mine.ts).
 */
export async function fetchActiveDistributions(
  client: GraphClient,
  orgIdOrName: string | undefined,
  chainId?: number
): Promise<ActiveDistributionRow[]> {
  const orgId = await resolveOrgId(client, orgIdOrName, chainId);
  const result = await client.query<{
    organization: { paymentManager: { distributions: ActiveDistributionRow[] } | null } | null;
  }>(FETCH_ACTIVE_DISTRIBUTIONS, { orgId }, chainId);
  return result.organization?.paymentManager?.distributions ?? [];
}

// ---------------------------------------------------------------------------
// Member snapshots for merkle building / reconstruction
// ---------------------------------------------------------------------------

/**
 * Members + PT balances at the CURRENT head — the builder snapshot used by
 * `pop treasury compute-merkle` (src/commands/treasury/compute-merkle.ts).
 * Ordered by PT balance desc: the dust-to-largest-holder rule depends on
 * allocations[0] being the largest holder.
 */
export const FETCH_MEMBERS_PT = `
  query FetchMembersPT($orgId: Bytes!) {
    organization(id: $orgId) {
      users(
        orderBy: participationTokenBalance,
        orderDirection: desc,
        first: 1000
      ) {
        address
        participationTokenBalance
        membershipStatus
        account {
          username
        }
      }
      participationToken {
        totalSupply
      }
    }
  }
`;

/**
 * Members AND opt-out state as of a distribution's checkpoint block — the
 * reconstruction snapshot used by `pop treasury claim-mine`
 * (src/commands/treasury/claim-mine.ts).
 *
 * Both halves are block-scoped on purpose. `pop treasury compute-merkle`
 * excludes opted-out members when it BUILDS the tree (the only place opt-out
 * is enforced since audit L-19), so reconstructing that tree has to reproduce
 * the opt-out set as it was AT BUILD TIME. Using current opt-out state instead
 * would rebuild a different tree the moment anyone toggles after a
 * distribution is created, and every member would get "Root mismatch" for a
 * valid distribution. compute-merkle sets checkpointBlock to the build block,
 * so this is that state.
 *
 * optOutToggles is a TOP-LEVEL entity, so it MUST be scoped to this org's
 * PaymentManager. Unfiltered it returns toggles from every PaymentManager the
 * subgraph indexes (nine on Gnosis today), and any address that opted out of a
 * DIFFERENT org would be dropped from this org's tree — producing a spurious
 * "Root mismatch" that tells every member they cannot claim.
 */
export const FETCH_MEMBERS_AT_BLOCK = `
  query FetchMembersAtBlock($orgId: Bytes!, $block: Int!, $paymentManager: String!) {
    organization(id: $orgId, block: { number: $block }) {
      participationToken { totalSupply }
      users(orderBy: participationTokenBalance, orderDirection: desc, first: 1000) {
        address
        participationTokenBalance
        membershipStatus
      }
    }
    optOutToggles(
      block: { number: $block }
      where: { paymentManager: $paymentManager }
      first: 1000
      orderBy: toggledAtBlock
      orderDirection: asc
    ) {
      user
      optedOut
      toggledAtBlock
    }
  }
`;

export interface MemberPtRow {
  address: string;
  participationTokenBalance: string;
  membershipStatus: string;
  account?: { username: string | null } | null;
}

export interface OptOutToggleRow {
  user: string;
  optedOut: boolean;
  toggledAtBlock: string;
}

/** Current-head member snapshot (compute-merkle builder input). */
export async function fetchMembersPT(
  client: GraphClient,
  orgId: string,
  chainId?: number
): Promise<{ users: MemberPtRow[]; totalSupply: string } | null> {
  const result = await client.query<{
    organization: { users: MemberPtRow[]; participationToken: { totalSupply: string } | null } | null;
  }>(FETCH_MEMBERS_PT, { orgId }, chainId);
  const org = result.organization;
  if (!org) return null;
  return { users: org.users ?? [], totalSupply: org.participationToken?.totalSupply ?? '0' };
}

/** Block-pinned member + opt-out snapshot (claim-mine reconstruction input). */
export async function fetchMembersAtBlock(
  client: GraphClient,
  orgId: string,
  block: number,
  paymentManagerAddress: string,
  chainId?: number
): Promise<{ users: MemberPtRow[]; totalSupply: string; optOutToggles: OptOutToggleRow[] } | null> {
  const result = await client.query<{
    organization: { users: MemberPtRow[]; participationToken: { totalSupply: string } | null } | null;
    optOutToggles: OptOutToggleRow[];
  }>(
    FETCH_MEMBERS_AT_BLOCK,
    { orgId, block, paymentManager: paymentManagerAddress.toLowerCase() },
    chainId
  );
  const org = result.organization;
  if (!org) return null;
  return {
    users: org.users ?? [],
    totalSupply: org.participationToken?.totalSupply ?? '0',
    optOutToggles: result.optOutToggles ?? [],
  };
}

/**
 * Latest toggle per user wins — the log is ascending, so the last write for an
 * address is its state at the pinned block. Pure port of the fold in
 * `pop treasury claim-mine`.
 */
export function optedOutSetFromToggles(toggles: OptOutToggleRow[]): Set<string> {
  const optedOut = new Set<string>();
  for (const t of toggles ?? []) {
    const addr = String(t.user).toLowerCase();
    if (t.optedOut) optedOut.add(addr);
    else optedOut.delete(addr);
  }
  return optedOut;
}

// ---------------------------------------------------------------------------
// Payout token metadata
// ---------------------------------------------------------------------------

export interface PayoutTokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  isNative: boolean;
}

/**
 * Resolve a distribution payout token to human units — port of
 * resolvePayoutTokenInfo in src/commands/treasury/helpers.ts (shared by claim,
 * claim-mine, propose-distribution and propose-finalize so amounts render
 * identically).
 *
 * PaymentManager uses address(0) for the chain's native token (verified:
 * claimDistribution transfers raw value when payoutToken == address(0));
 * ERC20s are resolved via a live decimals()/symbol() read with the known-token
 * table then an 18-decimals default as fallbacks. RPC on purpose: the subgraph
 * does not index arbitrary ERC20s. When no provider is supplied the live read
 * is skipped and the table/default fallback applies directly.
 */
export async function resolvePayoutTokenInfo(
  provider: ethers.providers.Provider | undefined,
  tokenAddress: string,
  chainId?: number
): Promise<PayoutTokenInfo> {
  if (!tokenAddress || tokenAddress === ethers.constants.AddressZero) {
    const native = getNetworkByChainId(chainId ?? 0)?.nativeCurrency?.symbol ?? 'native';
    return { address: ethers.constants.AddressZero, symbol: native, decimals: 18, isNative: true };
  }

  const known = getTokenByAddress(tokenAddress);
  let decimals = known?.decimals;
  let symbol = known?.symbol;
  if (provider) {
    try {
      const erc20 = createReadContract(tokenAddress, 'ERC20', provider);
      const [liveDecimals, liveSymbol] = await Promise.all([
        erc20.decimals(),
        erc20.symbol().catch(() => undefined),
      ]);
      decimals = Number(liveDecimals);
      symbol = liveSymbol ?? symbol;
    } catch {
      // Live read failed — fall back to the known-token table / 18.
    }
  }
  return {
    address: tokenAddress,
    symbol: symbol ?? 'tokens',
    decimals: decimals ?? 18,
    isNative: false,
  };
}

export interface TreasuryPageOptions { source: SourceRef; query: ProtocolQuery; pageSize?: number; maxPages?: number }
/** One root task stream; deleted-project completions must remain visible in finance. */
export function readTreasuryWorkFacts(options: TreasuryPageOptions & { kind: 'completed' | 'promised' }): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  const variables = requireWorkSource(options.source);
  if (options.kind !== 'completed' && options.kind !== 'promised') throw new Error('INVALID_WORK_HISTORY_KIND');
  return readWorkPageFacts({ ...options, variables, collection: 'tasks', initialCursor: '',
    document: options.kind === 'completed' ? FETCH_TREASURY_TASK_ACTIVITY_PAGE : FETCH_PROMISED_BOUNTIES_PAGE,
    validateRow: row => {
      const project = row.project as { deleted?: boolean; taskManager?: { id?: string; organization?: { id?: string } } } | undefined;
      if (String(row.taskManager).toLowerCase() !== options.source.contract!.toLowerCase()
        || project?.taskManager?.id?.toLowerCase() !== options.source.contract!.toLowerCase()
        || project.taskManager.organization?.id?.toLowerCase() !== options.source.orgId!.toLowerCase()
        || typeof project.deleted !== 'boolean') throw new Error('TASK_HISTORY_SCOPE_MISMATCH');
      const validStatuses = options.kind === 'completed' ? ['Completed'] : ['Open', 'Assigned', 'Submitted'];
      if (!validStatuses.includes(String(row.status))) throw new Error('TASK_HISTORY_STATUS_MISMATCH');
      requireRawUint(row.taskId as string);
      // Asset/payout field absence is a field-level unknown, separate from row transport.
      for (const key of ['payout', 'bountyPayout']) if (row[key] !== undefined && row[key] !== null) requireRawUint(row[key] as string);
    } });
}
/** Exact asset-separated bounty totals; missing metadata/units never become zero. */
export function projectTreasuryBountyTotals(snapshot: SourceSnapshot<readonly IndexedRow[]>, assets: readonly AssetRef[]): Fact<RawAssetAmount[]> {
  try {
    const rows = requireCompleteSnapshot(snapshot);
    const registry = new Map<string, AssetRef>();
    for (const asset of assets) {
      requireAssetRef(asset);
      if (asset.chainId !== snapshot.source.chainId) throw new Error('ASSET_CHAIN_MISMATCH');
      const key = asset.address.toLowerCase();
      if (registry.has(key)) throw new Error('AMBIGUOUS_ASSET_METADATA');
      registry.set(key, asset);
    }
    const amounts = rows.map(row => {
      if (typeof row.bountyToken !== 'string' || row.bountyPayout == null) throw new Error('BOUNTY_FIELD_UNKNOWN');
      const asset = registry.get(ethers.utils.getAddress(row.bountyToken).toLowerCase());
      if (!asset) throw new Error('ASSET_METADATA_UNKNOWN');
      return { asset, rawAmount: requireRawUint(row.bountyPayout as string) };
    });
    return knownFact(sumRawAssetAmounts(amounts), snapshot.source);
  } catch (error) { return unknownFact(error instanceof Error ? error.message : 'WORK_TOTAL_UNKNOWN', snapshot.source); }
}
/** Same-response installed module binding is mandatory even on an empty page. */
function readFinancialPage(options: TreasuryPageOptions, module: 'paymentManager' | 'hybridVoting', document: string, collection: string,
  initialCursor: string, extra: Record<string, unknown>, validateRow: (row: IndexedRow) => void): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  assertSourceRef(options.source);
  if (!options.source.indexed || !ethers.utils.isHexString(options.source.orgId, 32) || !options.source.contract
    || !ethers.utils.isAddress(options.source.contract) || options.source.contract.toLowerCase() === ethers.constants.AddressZero
    || (options.source.block && options.source.snapshot !== 'pinned')) throw new Error('EXPLICIT_INDEXED_MODULE_SCOPE_REQUIRED');
  const bindingIssues: { code: string }[] = [];
  return readIndexedPageFacts({ ...options, document, collection, initialCursor,
    variables: { orgId: options.source.orgId, [module]: options.source.contract.toLowerCase(), ...extra }, validateRow,
    query: async (doc, variables, source) => {
      const response = await options.query(doc, variables, source);
      if (Array.isArray(response.errors) && response.errors.length) return response;
      const org = response.organization as IndexedRow | undefined;
      const manager = org?.[module] as { id?: string; organization?: { id?: string } } | undefined;
      if (String(org?.id).toLowerCase() !== source.orgId!.toLowerCase() || manager?.id?.toLowerCase() !== source.contract!.toLowerCase()
        || manager.organization?.id?.toLowerCase() !== source.orgId!.toLowerCase()) {
        bindingIssues.push({ code: 'MODULE_BINDING_UNAVAILABLE_OR_MISMATCHED' });
        throw new Error('Module binding mismatch');
      }
      return response;
    } }).then(result => ({ ...result, coverage: { ...result.coverage, issues: [...result.coverage.issues, ...bindingIssues] } }));
}
function validateFinancialModule(row: IndexedRow, module: string, source: SourceRef): void {
  const binding = row[module] as { id?: string; organization?: { id?: string } } | undefined;
  if (binding?.id?.toLowerCase() !== source.contract!.toLowerCase() || binding.organization?.id?.toLowerCase() !== source.orgId!.toLowerCase()) throw new Error('FINANCIAL_ROW_SCOPE_MISMATCH');
}
export function readDistributionHistoryFacts(options: TreasuryPageOptions): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  return readFinancialPage(options, 'paymentManager', FETCH_DISTRIBUTIONS_PAGE, 'distributions', '', {}, row => {
    validateFinancialModule(row, 'paymentManager', options.source);
    for (const key of ['distributionId', 'totalAmount', 'totalClaimed', 'checkpointBlock', 'createdAtBlock']) requireRawUint(row[key] as string);
    if (BigInt(row.totalClaimed as string) > BigInt(row.totalAmount as string) || !['Active', 'Finalized'].includes(String(row.status))) throw new Error('INVALID_DISTRIBUTION');
    ethers.utils.getAddress(row.payoutToken as string);
    if (!ethers.utils.isHexString(row.merkleRoot as string, 32)) throw new Error('INVALID_ROOT');
  });
}
export function readPaymentHistoryFacts(options: TreasuryPageOptions): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  return readFinancialPage(options, 'paymentManager', FETCH_PAYMENTS_PAGE, 'payments', '0x', {}, row => {
    validateFinancialModule(row, 'paymentManager', options.source);
    for (const key of ['amount', 'receivedAt', 'receivedAtBlock']) requireRawUint(row[key] as string);
    ethers.utils.getAddress(row.payer as string); ethers.utils.getAddress(row.token as string);
    if (!ethers.utils.isHexString(row.transactionHash as string, 32)) throw new Error('INVALID_PAYMENT_TX');
  });
}
export function readDistributionClaimFacts(options: TreasuryPageOptions & { distributionId: string }): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  const distribution = distributionEntityId(options.source.contract!, requireRawUint(options.distributionId));
  return readFinancialPage(options, 'paymentManager', FETCH_DISTRIBUTION_CLAIMS_PAGE, 'claims', '', { distribution }, row => {
    validateFinancialModule(row, 'paymentManager', options.source);
    if ((row.distribution as { id?: string })?.id !== distribution) throw new Error('CLAIM_DISTRIBUTION_MISMATCH');
    for (const key of ['amount', 'claimedAt', 'claimedAtBlock']) requireRawUint(row[key] as string);
    ethers.utils.getAddress(row.claimer as string);
    if (!ethers.utils.isHexString(row.transactionHash as string, 32)) throw new Error('INVALID_CLAIM_TX');
  });
}
export interface DistributionReferenceRow { proposal: IndexedRow; reference: Fact<{ cid: string; merkleRoot: string }> }
export async function readDistributionReferences(options: TreasuryPageOptions): Promise<SourceSnapshot<readonly DistributionReferenceRow[]>> {
  const result = await readFinancialPage(options, 'hybridVoting', FETCH_EXECUTED_DISTRIBUTION_PROPOSALS_PAGE, 'proposals', '', {}, row => {
    validateFinancialModule(row, 'hybridVoting', options.source);
    if (row.status !== 'Executed') throw new Error('NOT_EXECUTED');
    requireRawUint(row.proposalId as string);
  });
  return { ...result, data: result.data.map(proposal => {
    const description = (proposal.metadata as { description?: unknown } | undefined)?.description;
    return { proposal, reference: typeof description === 'string' ? parseDistributionClaimsDiscoveryMarker(description) : unknownFact('PROPOSAL_METADATA_UNKNOWN', result.source) };
  }) };
}

/** These callbacks must issue block-qualified read-only RPC and independently
 * attest the response source. No source is synthesized from a requested hash.
 * getDistribution does not expose creationBlock; inject separately observed
 * creation-event facts, or retain unknown (closure will then be blocked). */
export interface PaymentManagerPlanningReader {
  readCounter(source: SourceRef): Promise<Fact<string>>;
  readBalance(asset: AssetRef, source: SourceRef): Promise<Fact<string>>;
  readDistribution(distributionId: string, source: SourceRef): Promise<Fact<Omit<PaymentManagerRound, 'creationBlock'>>>;
}
export interface PaymentManagerObservedState {
  asset: AssetRef; rounds: readonly PaymentManagerRound[];
  distributionCounterRaw: Fact<string>; balanceRaw: Fact<string>;
}
export async function readPaymentManagerPlanningSnapshot(input: {
  source: SourceRef; asset: AssetRef; reader: PaymentManagerPlanningReader;
  /** Explicit bound prevents huge counter allocations. Full enumeration is mandatory for planning. */
  maxRounds: number;
  creationBlocks?: Readonly<Record<string, Fact<string>>>;
}): Promise<SourceSnapshot<PaymentManagerObservedState>> {
  assertSourceRef(input.source); requireAssetRef(input.asset);
  if (input.source.indexed || input.source.snapshot !== 'pinned' || !input.source.block || !input.source.orgId || !input.source.contract
    || input.source.contract.toLowerCase() === ethers.constants.AddressZero || !ethers.utils.isHexString(input.source.orgId, 32)
    || input.asset.chainId !== input.source.chainId || !Number.isSafeInteger(input.maxRounds) || input.maxRounds < 0) throw new Error('INVALID_RPC_ENUMERATION_INPUT');
  const binding = { chainId: input.source.chainId, contracts: { paymentManager: input.source.contract } };
  assertTreasuryModuleBindings(input.source, binding);
  const received: string[] = [], failed: string[] = [], issues: { code: string; id?: string }[] = [];
  const rounds: PaymentManagerRound[] = [];
  let proven: SourceRef | undefined;
  let counter: string | undefined, balance: string | undefined;
  let counterFact: Fact<string> | undefined, balanceFact: Fact<string> | undefined;
  const readFact = <T>(fact: Fact<T>, key: string): T => {
    if (fact.state !== 'known' || !fact.source) throw new Error('RPC_FACT_UNKNOWN_OR_UNPROVEN');
    assertSourceRef(fact.source);
    assertPlanScope(fact.source, { chainId: input.source.chainId, orgId: input.source.orgId,
      contract: key === 'balance' && input.asset.address.toLowerCase() !== ethers.constants.AddressZero ? input.asset.address : input.source.contract,
      ...(key === 'balance' ? { account: input.source.contract } : {}), endpoint: input.source.endpoint });
    assertTreasuryModuleBindings(fact.source, input.source, binding);
    if (fact.source.indexed || fact.source.snapshot !== 'pinned') throw new Error('RPC_FACT_SOURCE_MISMATCH');
    assertSourceBlock(fact.source.block, input.source.block!);
    if (proven) { assertSourceBlock(fact.source.block, proven.block!); assertSourceBlock(proven.block, fact.source.block!); }
    else proven = fact.source;
    received.push(key); return fact.value;
  };
  const recordFailure = (key: string, error: unknown) => { failed.push(key); issues.push({ code: error instanceof Error ? error.message : 'RPC_READ_FAILED', id: key }); };
  try { const fact = await input.reader.readCounter(input.source); counter = requireRawUint(readFact(fact, 'counter')); counterFact = knownFact(counter, fact.source); }
  catch (error) { recordFailure('counter', error); }
  try { const fact = await input.reader.readBalance(input.asset, input.source); balance = requireRawUint(readFact(fact, 'balance')); balanceFact = knownFact(balance, fact.source); }
  catch (error) { recordFailure('balance', error); }
  let expected = ['counter', 'balance'];
  if (counter !== undefined) {
    if (BigInt(counter) > BigInt(input.maxRounds)) issues.push({ code: 'ROUND_CAP' });
    else {
      const ids = Array.from({ length: Number(counter) }, (_, i) => String(i + 1));
      expected = [...expected, ...ids];
      // Parallel IO, ordered proof validation/results: completion timing cannot
      // choose which page/block optional dimensions become the reference proof.
      const results = await Promise.allSettled(ids.map(id => input.reader.readDistribution(id, input.source)));
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index], result = results[index];
        try {
          if (result.status === 'rejected') throw result.reason;
          const row = readFact(result.value, id);
          if (requireRawUint(row.distributionId) !== id) throw new Error('RPC_DISTRIBUTION_ID_MISMATCH');
          for (const field of ['totalAmount', 'totalClaimed', 'checkpointBlock']) requireRawUint(row[field as keyof typeof row] as string);
          ethers.utils.getAddress(row.payoutToken);
          if (typeof row.finalized !== 'boolean' || row.totalAmount === '0' || BigInt(row.totalClaimed) > BigInt(row.totalAmount)) throw new Error('INVALID_RPC_DISTRIBUTION');
          rounds.push({ ...row, creationBlock: input.creationBlocks?.[id] ?? unknownFact('CREATION_BLOCK_GETTER_ABSENT') });
        } catch (error) { recordFailure(id, error); }
      }
    }
  }
  const source = proven ? { ...input.source, block: proven.block } : (() => { const { block: _requested, ...scope } = input.source; return { ...scope, snapshot: 'unknown' as const }; })();
  const receivedKeys = received.filter(key => !failed.includes(key));
  const missing = expected.filter(key => !receivedKeys.includes(key));
  const data = { asset: { ...input.asset }, rounds, distributionCounterRaw: counterFact ?? unknownFact<string>('COUNTER_UNKNOWN', source),
    balanceRaw: balanceFact ?? unknownFact<string>('BALANCE_UNKNOWN', source) };
  return { source, data, coverage: { status: issues.length || failed.length || missing.length ? proven ? 'incomplete' : 'unavailable' : 'complete',
    expectedKeys: expected, receivedKeys, missingIds: missing, failedIds: failed, issues, cap: input.maxRounds } };
}
/** Explicit known-field + complete-transport narrowing for the safety planner. */
export function paymentManagerPlanningState(snapshot: SourceSnapshot<PaymentManagerObservedState>): Fact<SourceSnapshot<PaymentManagerState>> {
  try {
    const data = requireCompleteSnapshot(snapshot, { indexed: false, snapshot: 'pinned' });
    if (data.balanceRaw.state !== 'known' || data.distributionCounterRaw.state !== 'known') throw new Error('RPC_FIELDS_UNKNOWN');
    requireAssetRef(data.asset);
    if (data.asset.chainId !== snapshot.source.chainId || !snapshot.source.contract || !snapshot.source.orgId) throw new Error('RPC_FIELDS_SCOPE_UNKNOWN');
    const binding = { chainId: snapshot.source.chainId, contracts: { paymentManager: snapshot.source.contract } };
    assertTreasuryModuleBindings(snapshot.source, binding);
    for (const [key, fact] of [['counter', data.distributionCounterRaw], ['balance', data.balanceRaw]] as const) {
      requireRawUint(fact.value);
      if (fact.source) {
        assertSourceRef(fact.source);
        assertPlanScope(fact.source, { chainId: snapshot.source.chainId, orgId: snapshot.source.orgId, endpoint: snapshot.source.endpoint,
          contract: key === 'balance' && data.asset.address.toLowerCase() !== ethers.constants.AddressZero ? data.asset.address : snapshot.source.contract,
          ...(key === 'balance' ? { account: snapshot.source.contract } : {}) });
        assertTreasuryModuleBindings(fact.source, snapshot.source, binding);
        if (fact.source.indexed || fact.source.snapshot !== 'pinned') throw new Error('RPC_FIELDS_SOURCE_MISMATCH');
        assertSourceBlock(fact.source.block, snapshot.source.block!); assertSourceBlock(snapshot.source.block, fact.source.block!);
      }
    }
    return knownFact({ ...snapshot, data: { asset: data.asset, rounds: data.rounds, balanceRaw: requireRawUint(data.balanceRaw.value), distributionCounterRaw: requireRawUint(data.distributionCounterRaw.value) } }, snapshot.source);
  } catch (error) { return unknownFact(error instanceof Error ? error.message : 'RPC_ENUMERATION_INCOMPLETE', snapshot.source); }
}
