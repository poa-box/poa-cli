/**
 * Paymaster reads — PaymasterHub infrastructure resolution + org sponsorship
 * state. Port of src/commands/paymaster/helpers.ts (client-injected) plus the
 * pure epoch helper from src/commands/paymaster/status.ts.
 *
 * The PaymasterHub is a singleton shared across all orgs (one proxy per
 * chain), so its address comes from the infrastructure query, not the org's
 * module list.
 *
 * ── Where the numbers come from (KEEP — verified field-by-field) ────────────
 * ENTRY_POINT, the OrgConfig, the fee caps and EVERY budget come from the
 * subgraph (see graph/documents/paymaster.ts for the field-by-field
 * verification against both live deployments). Three things deliberately
 * STAY ON RPC — the schema has fields for some of them, but the VALUES are
 * wrong on live rows:
 *   • getOrgFinancials — PaymasterOrgConfig.totalSpent/.depositBalance are
 *     indexed WITHOUT the 1.01x solidarity fee the hub also debits, so they
 *     sit at exactly 1/1.01 of the contract's `spent` on both live chains
 *     (proven to the wei on Gnosis and Arbitrum). `available` decides whether
 *     sponsorship still works, so it must be the chain's number. The call also
 *     carries solidarityUsedThisPeriod + periodStart, which have no subgraph
 *     field at all.
 *   • getSolidarityFund — numActiveOrgs and feePercentageBps have no field,
 *     the indexed solidarityBalance is stale on Gnosis (6376552300000000 wei
 *     high), and solidarityDistributionPaused reads `false` on Arbitrum while
 *     the contract reports `true`.
 *   • EntryPoint.balanceOf — the ERC-4337 singleton is not a subgraph data
 *     source.
 *
 * Two ways to read an org's paymaster config, and the difference matters:
 *
 *   readPaymasterOrgConfig()               — authoritative eth_call. Use it
 *     wherever the answer decides whether a transaction gets broadcast
 *     (deposit's OrgNotRegistered gate). Subgraph lag there means knowingly
 *     sending a doomed tx.
 *   readPaymasterOrgConfigPreferSubgraph() — subgraph first, but ONLY trusts a
 *     POSITIVE "registered" answer; a negative one is always re-confirmed on
 *     chain before anything is written. The subgraph can lag behind a fresh
 *     registration, it can never invent one, so a positive is safe to trust and
 *     a negative is not.
 */

import { ethers } from 'ethers';
import type { GraphClient } from '../graph/client';
import { FETCH_INFRASTRUCTURE_ADDRESSES } from '../graph/documents/infrastructure';
import type { InfrastructureAddresses } from '../graph/documents/infrastructure';
import { FETCH_PAYMASTER_STATE_TIERS } from '../graph/documents/paymaster';
import type { PaymasterStateResponse } from '../graph/documents/paymaster';
import { createReadContract } from '../contracts';
import { PreconditionError } from '../errors';

export interface PaymasterInfra {
  paymasterHubAddress: string;
  poaManagerAddress: string | null;
}

/** Resolve the chain's PaymasterHub proxy (+ PoaManager) from the subgraph. */
export async function resolvePaymasterInfra(
  client: GraphClient,
  chainId?: number
): Promise<PaymasterInfra> {
  const infra = await client.query<InfrastructureAddresses>(FETCH_INFRASTRUCTURE_ADDRESSES, {}, chainId);
  const record = infra.poaManagerContracts?.[0];
  const paymasterHubAddress = record?.paymasterHubProxy;
  if (!paymasterHubAddress) {
    throw new PreconditionError(
      'PaymasterHub not indexed for this chain.',
      'The subgraph may still be syncing, or gas sponsorship is not deployed on this chain.'
    );
  }
  return { paymasterHubAddress, poaManagerAddress: record?.id ?? null };
}

export interface PaymasterOrgConfig {
  adminHatId: ethers.BigNumber;
  operatorHatId: ethers.BigNumber;
  paused: boolean;
  registeredAt: number;
  bannedFromSolidarity: boolean;
  registered: boolean;
}

/** Fee caps in raw contract units (wei per gas / gas units). */
export interface PaymasterFeeCaps {
  maxFeePerGas: ethers.BigNumber;
  maxPriorityFeePerGas: ethers.BigNumber;
  maxCallGas: number;
  maxVerificationGas: number;
  maxPreVerificationGas: number;
}

/** One budget row as the subgraph has it. `totalUsed` is null on the legacy tier. */
export interface PaymasterBudgetRecord {
  subjectKey: string;
  capPerEpoch: ethers.BigNumber;
  usedInEpoch: ethers.BigNumber;
  epochLen: number;
  epochStart: number;
  totalUsed: ethers.BigNumber | null;
}

export interface PaymasterSubgraphState {
  /** Hub address the indexer knows about — cross-check before trusting the rest. */
  hubAddress: string | null;
  /** Checksummed to match what ENTRY_POINT() would have returned. */
  entryPoint: string | null;
  orgConfig: PaymasterOrgConfig | null;
  /**
   * All-zero when the org row exists but has no PaymasterFeeCaps edge — that is
   * the contract's "never configured" default, verified against getFeeCaps() on
   * five orgs across both live deployments. Null only when the org row itself is
   * missing, in which case the caller must fall back to RPC.
   */
  feeCaps: PaymasterFeeCaps | null;
  /** Null (not empty) when the org row is missing, so "no budgets" stays distinguishable. */
  budgets: PaymasterBudgetRecord[] | null;
}

const EMPTY_STATE: PaymasterSubgraphState = {
  hubAddress: null,
  entryPoint: null,
  orgConfig: null,
  feeCaps: null,
  budgets: null,
};

const ZERO_FEE_CAPS: PaymasterFeeCaps = {
  maxFeePerGas: ethers.BigNumber.from(0),
  maxPriorityFeePerGas: ethers.BigNumber.from(0),
  maxCallGas: 0,
  maxVerificationGas: 0,
  maxPreVerificationGas: 0,
};

/**
 * Read the hub state the subgraph can serve accurately: the immutable
 * ENTRY_POINT, the org's OrgConfig, its fee caps and ALL of its budgets.
 * Subgraph half of `pop paymaster status` (src/commands/paymaster/status.ts).
 *
 * Never throws — every failure (unreachable subgraph, chain with no deployment,
 * unindexed org) degrades to nulls so the caller falls back to eth_calls.
 *
 * Financials and the solidarity fund are deliberately NOT here; see the module
 * header for the measurements that disqualified them.
 */
export async function fetchPaymasterSubgraphState(
  client: GraphClient,
  orgId: string,
  chainId?: number
): Promise<PaymasterSubgraphState> {
  let data: PaymasterStateResponse;
  try {
    const result = await client.queryWithFieldFallback<PaymasterStateResponse>(
      FETCH_PAYMASTER_STATE_TIERS.map(q => ({ query: q, variables: { orgId: orgId.toLowerCase() } })),
      { chainId }
    );
    data = result.data;
  } catch {
    return EMPTY_STATE;
  }

  const hub = data?.paymasterHubContracts?.[0];
  const row = data?.paymasterOrgConfigs?.[0];

  let entryPoint: string | null = null;
  if (hub?.entryPoint) {
    // The subgraph stores Bytes lowercased; ENTRY_POINT() returns a checksummed
    // address. Re-checksum so output is byte-identical either way.
    try {
      const checksummed = ethers.utils.getAddress(hub.entryPoint);
      // The zero address is a documented PLACEHOLDER, not an answer. The mapping
      // seeds hub.entryPoint = Address.zero() in getOrCreateHub, and the deploy
      // path only fills it via a try_ENTRY_POINT() call that falls back to zero
      // (PaymasterInitialized fires before InfrastructureDeployed, so
      // handlePaymasterInitialized never runs for the initial deploy).
      //
      // getAddress() happily accepts it, so without this guard a placeholder
      // becomes a non-null `entryPoint` that callers then use as an eth_call
      // TARGET: balanceOf against address(0) returns '0x' and decoding throws
      // CALL_EXCEPTION. null makes callers fall back to the ENTRY_POINT() read.
      entryPoint = checksummed === ethers.constants.AddressZero ? null : checksummed;
    } catch {
      entryPoint = null;
    }
  }

  if (!row) {
    return { ...EMPTY_STATE, hubAddress: hub?.id ?? null, entryPoint };
  }

  let orgConfig: PaymasterOrgConfig | null = null;
  try {
    const adminHatId = ethers.BigNumber.from(row.adminHatId);
    orgConfig = {
      adminHatId,
      operatorHatId: ethers.BigNumber.from(row.operatorHatId),
      paused: Boolean(row.isPaused),
      registeredAt: Number(row.registeredAt ?? 0) || 0,
      bannedFromSolidarity: Boolean(row.isBannedFromSolidarity),
      // Derived exactly like PaymasterHub._registerOrg does it.
      registered: !adminHatId.isZero(),
    };
  } catch {
    return { ...EMPTY_STATE, hubAddress: hub?.id ?? null, entryPoint };
  }

  const feeCaps: PaymasterFeeCaps = row.feeCaps
    ? {
      maxFeePerGas: ethers.BigNumber.from(row.feeCaps.maxFeePerGas),
      maxPriorityFeePerGas: ethers.BigNumber.from(row.feeCaps.maxPriorityFeePerGas),
      maxCallGas: Number(row.feeCaps.maxCallGas ?? 0),
      maxVerificationGas: Number(row.feeCaps.maxVerificationGas ?? 0),
      maxPreVerificationGas: Number(row.feeCaps.maxPreVerificationGas ?? 0),
    }
    : ZERO_FEE_CAPS;

  const budgets: PaymasterBudgetRecord[] = (row.budgets ?? []).map(b => ({
    subjectKey: b.subjectKey,
    capPerEpoch: ethers.BigNumber.from(b.capPerEpoch),
    usedInEpoch: ethers.BigNumber.from(b.usedInEpoch),
    epochLen: Number(b.epochLen ?? 0),
    epochStart: Number(b.epochStart ?? 0),
    totalUsed: b.totalUsed !== undefined && b.totalUsed !== null
      ? ethers.BigNumber.from(b.totalUsed)
      : null,
  }));

  return {
    hubAddress: row.paymasterHub?.id ?? hub?.id ?? null,
    entryPoint,
    orgConfig,
    feeCaps,
    budgets,
  };
}

/**
 * True when the indexed hub is the hub we independently resolved. A mismatch
 * (redeployed hub the indexer has not caught up with, a hand-set
 * POP_*_SUBGRAPH pointing at another network) means the org row describes a
 * different contract, so the caller must ignore the whole state object.
 */
export function subgraphMatchesHub(state: PaymasterSubgraphState, hubAddress: string): boolean {
  return !!state.hubAddress && state.hubAddress.toLowerCase() === hubAddress.toLowerCase();
}

/**
 * Read the hub's OrgConfig for an org. `registered` is derived the same way
 * the contract does it (adminHatId != 0 — see PaymasterHub._registerOrg).
 *
 * Authoritative eth_call. Keep using this one for revert-predicting gates.
 */
export async function readPaymasterOrgConfig(
  provider: ethers.providers.Provider,
  hubAddress: string,
  orgId: string
): Promise<PaymasterOrgConfig> {
  const hub = createReadContract(hubAddress, 'PaymasterHub', provider);
  const cfg = await hub.getOrgConfig(orgId);
  const adminHatId = ethers.BigNumber.from(cfg.adminHatId);
  return {
    adminHatId,
    operatorHatId: ethers.BigNumber.from(cfg.operatorHatId),
    paused: Boolean(cfg.paused),
    registeredAt: Number(cfg.registeredAt ?? 0),
    bannedFromSolidarity: Boolean(cfg.bannedFromSolidarity),
    registered: !adminHatId.isZero(),
  };
}

/**
 * Registration read for callers that may go on to WRITE.
 *
 * Asymmetric on purpose: an indexed registration is trusted (saves the eth_call
 * on the common "already registered" path), an absent one is re-read on chain
 * before any decision is made. The subgraph only ever lags reality, so a
 * false-negative is possible and a false-positive is not — re-confirming just
 * the negative keeps revert prediction exactly as strong as pure RPC.
 */
export async function readPaymasterOrgConfigPreferSubgraph(
  client: GraphClient,
  provider: ethers.providers.Provider,
  hubAddress: string,
  orgId: string,
  chainId?: number
): Promise<{ config: PaymasterOrgConfig; source: 'subgraph' | 'rpc' }> {
  const state = await fetchPaymasterSubgraphState(client, orgId, chainId);
  if (state.orgConfig?.registered && subgraphMatchesHub(state, hubAddress)) {
    return { config: state.orgConfig, source: 'subgraph' };
  }
  return { config: await readPaymasterOrgConfig(provider, hubAddress, orgId), source: 'rpc' };
}

/** Subject key for a hat-scoped paymaster budget: the hat ID as bytes32. */
export function hatSubjectKey(hatId: ethers.BigNumberish): string {
  return ethers.utils.hexZeroPad(ethers.BigNumber.from(hatId).toHexString(), 32);
}

/**
 * Has this budget's epoch elapsed? Pure port of budgetEpochState from
 * src/commands/paymaster/status.ts.
 *
 * PaymasterHub resets `usedInEpoch` LAZILY, on the next sponsored
 * UserOperation, so a budget whose epoch elapsed months ago still reports the
 * old spend — and getBudget() returns exactly the same stale figure the
 * subgraph does (verified: both return 7993482525000000 for a Gnosis epoch
 * that ended in May). Rather than present a stale number as current spend,
 * check each row against epochStart + epochLen and report it as lapsed, with
 * the effective (post-reset) spend of zero alongside the raw counter.
 */
export function budgetEpochState(
  epochStart: number,
  epochLen: number,
  now: number
): { epochEnd: number | null; expired: boolean } {
  if (!epochLen || !epochStart) return { epochEnd: null, expired: false };
  const epochEnd = epochStart + epochLen;
  return { epochEnd, expired: now >= epochEnd };
}
