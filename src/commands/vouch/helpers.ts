/**
 * Shared EligibilityModule helpers for the vouch + role domains.
 *
 * Both domains write to the same module, whose admin surface is superAdmin-
 * gated. Facts VERIFIED against contracts origin/main src/EligibilityModule.sol:
 *
 * - `superAdmin()` public getter exists; every eligibility/hat-admin write is
 *   `onlySuperAdmin` (setWearerEligibility, setDefaultEligibility,
 *   clearWearerEligibility, batchSetWearerEligibility, setDefaultEligibility,
 *   createHatWithEligibility, mintHatToAddress, batchMintHats, pause/unpause,
 *   transferSuperAdmin, setUserJoinTime, setUserJoinTimeNow, configureVouching,
 *   resetVouches, clearWearerVouches).
 * - VouchConfig struct: (uint32 quorum, uint256 membershipHatId, uint8 flags)
 *   with flags bit 0 = enabled (ENABLED_FLAG 0x01) and bit 1 =
 *   combineWithHierarchy (COMBINE_HIERARCHY_FLAG 0x02). Getter: getVouchConfig.
 * - Rate limiting: getMaxDailyVouches() (DEFAULT_MAX_DAILY_VOUCHES = 20 when
 *   unset), getCurrentDailyVouchCount(user) keyed by UTC day
 *   (block.timestamp / 86400), getUserJoinTime(user), and the authoritative
 *   combined answer canUserVouch(user).
 * - vouchFor does NOT auto-mint at quorum: reaching quorum makes
 *   getWearerStatus() return eligible, and the wearer claims explicitly via
 *   claimVouchedHat (claim-based pattern per the contract doc comment).
 *
 * READ SOURCING (subgraph vs RPC), settled 2026-07-30 against the live
 * poa-gnosis-v-1 / poa-arb-v-1 deployments:
 *
 * - DISPLAY reads (pop vouch status, pop vouch config show) go SUBGRAPH-FIRST
 *   with the RPC getter kept as fallback: VouchConfig.{quorum,membershipHatId,
 *   enabled,combinesWithHierarchy} and a count of active Vouch rows are
 *   verified-populated and byte-for-byte equal to the on-chain values.
 * - WRITE PRE-FLIGHT reads stay on RPC. superAdmin(), paused(),
 *   hasVouched(), hasActiveApplication(), getWearerStatus(), getDefaultRules()
 *   and the vouch-for/claim gates all exist to PREDICT A REVERT; indexing lag
 *   there either broadcasts a doomed transaction or blocks a valid one.
 *   They are instead batched through Multicall3 so each pre-flight costs ONE
 *   round-trip instead of N.
 * - NO subgraph field exists for getMaxDailyVouches(),
 *   getCurrentDailyVouchCount() or canUserVouch(); UserJoinTime has ZERO rows
 *   on the live Gnosis deployment. The whole VoucherGate therefore stays RPC.
 */

import { ethers } from 'ethers';
import { resolveOrgModules, requireModule } from '../../lib/resolve';
import { createReadContract } from '../../lib/contracts';
import { tryAggregate, Call, CallResult } from '../../lib/multicall';
import { query } from '../../lib/subgraph';
import { FETCH_VOUCH_CONFIG, FETCH_VOUCH_STATUS } from '../../queries/vouch';
import { formatAddress } from '../../lib/encoding';
import { formatRelativeTime } from '../../lib/format';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';

export async function resolveEligibilityModule(orgIdOrName: string | undefined, chainId?: number): Promise<{ orgId: string; eligibilityModuleAddress: string }> {
  const modules = await resolveOrgModules(orgIdOrName, chainId);
  return {
    orgId: modules.orgId,
    eligibilityModuleAddress: requireModule(modules, 'eligibilityModuleAddress'),
  };
}

/** VouchConfig.flags bit 0 — vouching enabled (quorum > 0 at configure time). */
export const VOUCH_FLAG_ENABLED = 0x01;
/** VouchConfig.flags bit 1 — hierarchy eligibility also grants/authorizes. */
export const VOUCH_FLAG_COMBINE_HIERARCHY = 0x02;

/** Parse a --hat argument (decimal or 0x-hex) into a BigNumber hat ID. */
export function parseHatId(input: string | number): ethers.BigNumber {
  try {
    return ethers.BigNumber.from(String(input).trim());
  } catch {
    throw new CliError(
      `Invalid --hat "${input}".`,
      EXIT.USAGE,
      'Pass the hat ID as a decimal or 0x-hex integer (see pop org roles).'
    );
  }
}

/** Decoded VouchConfig tuple (quorum, membershipHatId, flags). */
export interface VouchConfigView {
  quorum: number;
  membershipHatId: string;
  enabled: boolean;
  combineWithHierarchy: boolean;
}

/** Decode a raw getVouchConfig/vouchConfigs result into named fields. */
export function decodeVouchConfig(raw: { quorum: ethers.BigNumberish; membershipHatId: ethers.BigNumberish; flags: ethers.BigNumberish }): VouchConfigView {
  const flags = ethers.BigNumber.from(raw.flags).toNumber();
  return {
    quorum: ethers.BigNumber.from(raw.quorum).toNumber(),
    membershipHatId: ethers.BigNumber.from(raw.membershipHatId).toString(),
    enabled: (flags & VOUCH_FLAG_ENABLED) !== 0,
    combineWithHierarchy: (flags & VOUCH_FLAG_COMBINE_HIERARCHY) !== 0,
  };
}

/** One EligibilityModule view call in a Multicall3 batch. */
export interface EligibilityRead {
  fn: string;
  args: any[];
}

/**
 * Batch EligibilityModule view calls into ONE Multicall3 round-trip
 * (src/lib/multicall.ts degrades to parallel provider.call on chains without
 * the canonical deployment, so callers always get one result per call).
 *
 * Every caller is a write pre-flight, so a sub-call that reverts must NEVER be
 * silently decoded as a falsy answer: Multicall3.tryAggregate is invoked with
 * requireSuccess=false, and any call that comes back unsuccessful is re-issued
 * through the ethers contract so the original error propagates exactly as it
 * did before batching.
 *
 * Return shape matches `contract.fn(...)`: a single output is unwrapped, a
 * multi-output (getWearerStatus, getDefaultRules) stays an ethers Result with
 * both named and positional access.
 */
export async function batchEligibilityReadsSettled(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string,
  reads: EligibilityRead[]
): Promise<PromiseSettledResult<any>[]> {
  const contract = createReadContract(eligibilityModuleAddress, 'EligibilityModuleNew', provider);
  const iface = contract.interface;

  let results: CallResult[] = [];
  try {
    const calls: Call[] = reads.map(r => ({
      to: eligibilityModuleAddress,
      data: iface.encodeFunctionData(r.fn, r.args),
    }));
    results = await tryAggregate(provider, calls);
  } catch {
    results = [];
  }

  return Promise.allSettled(reads.map(async (read, i) => {
    const result = results[i];
    if (!result || !result.success || !result.returnData || result.returnData === '0x') {
      // Not batchable / reverted — re-issue so the natural error surfaces.
      return contract[read.fn](...read.args);
    }
    const decoded = iface.decodeFunctionResult(read.fn, result.returnData);
    return decoded.length === 1 ? decoded[0] : decoded;
  }));
}

/** batchEligibilityReadsSettled, rethrowing the first failure (Promise.all semantics). */
export async function batchEligibilityReads(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string,
  reads: EligibilityRead[]
): Promise<any[]> {
  const settled = await batchEligibilityReadsSettled(provider, eligibilityModuleAddress, reads);
  return settled.map((entry) => {
    if (entry.status === 'rejected') throw entry.reason;
    return entry.value;
  });
}

/**
 * Subgraph VouchConfig row → the same VouchConfigView the RPC tuple decodes to.
 * `enabled` is authoritative in the subgraph (the contract derives it as
 * quorum > 0 and emits it on VouchConfigSet), so it is used directly rather
 * than re-derived from flags.
 */
function vouchConfigFromSubgraph(row: any): VouchConfigView | null {
  if (!row) return null;
  if (row.quorum === null || row.quorum === undefined) return null;
  if (row.enabled === null || row.enabled === undefined) return null;
  if (row.membershipHatId === null || row.membershipHatId === undefined) return null;
  if (row.combinesWithHierarchy === null || row.combinesWithHierarchy === undefined) return null;
  return {
    quorum: Number(row.quorum),
    membershipHatId: String(row.membershipHatId),
    enabled: Boolean(row.enabled),
    combineWithHierarchy: Boolean(row.combinesWithHierarchy),
  };
}

/** The Graph caps a page at 1000 entities; a full page means "cannot derive". */
const VOUCH_PAGE_CAP = 1000;

/**
 * Subgraph read of a hat's vouch config. Returns null — meaning "fall back to
 * the RPC getter" — when the query fails, when the row is missing (absence is
 * ambiguous between never-configured and not-yet-indexed), or when a field is
 * null on an older deployment.
 */
export async function fetchVouchConfigFromSubgraph(
  eligibilityModuleAddress: string,
  hatId: ethers.BigNumber,
  chainId?: number
): Promise<VouchConfigView | null> {
  try {
    const data = await query<any>(
      FETCH_VOUCH_CONFIG,
      { eligibilityModuleId: eligibilityModuleAddress, hatId: hatId.toString() },
      chainId
    );
    return vouchConfigFromSubgraph(data?.vouchConfigs?.[0]);
  } catch {
    return null;
  }
}

/** Wearer-side vouch progress for `pop vouch status` (display only). */
export interface WearerVouchState {
  config: VouchConfigView;
  currentCount: number;
}

/**
 * Subgraph read of a hat's vouch config PLUS the wearer's current vouch count
 * (the number of active Vouch rows, verified equal to on-chain
 * currentVouchCount). Returns null to mean "fall back to RPC".
 */
export async function fetchWearerVouchStateFromSubgraph(
  eligibilityModuleAddress: string,
  hatId: ethers.BigNumber,
  wearer: string,
  chainId?: number
): Promise<WearerVouchState | null> {
  try {
    const data = await query<any>(
      FETCH_VOUCH_STATUS,
      {
        eligibilityModuleId: eligibilityModuleAddress,
        hatId: hatId.toString(),
        wearer,
      },
      chainId
    );
    const config = vouchConfigFromSubgraph(data?.vouchConfigs?.[0]);
    if (!config) return null;
    const vouches = data?.vouches;
    if (!Array.isArray(vouches) || vouches.length >= VOUCH_PAGE_CAP) return null;
    return { config, currentCount: vouches.length };
  } catch {
    return null;
  }
}

/**
 * RPC read of the same wearer-side state, batched into one round-trip.
 * `enabled` is derived from the config flags rather than a separate
 * isVouchingEnabled() call — the contract's getter is literally
 * `_isVouchingEnabled(vouchConfigs[hatId].flags)` (VERIFIED in
 * src/EligibilityModule.sol), so the answer is identical.
 */
export async function readWearerVouchStateOnchain(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string,
  hatId: ethers.BigNumberish,
  wearer: string
): Promise<WearerVouchState> {
  const [rawConfig, currentCount] = await batchEligibilityReads(provider, eligibilityModuleAddress, [
    { fn: 'vouchConfigs', args: [hatId] },
    { fn: 'currentVouchCount', args: [hatId, wearer] },
  ]);
  return {
    config: decodeVouchConfig(rawConfig),
    currentCount: ethers.BigNumber.from(currentCount).toNumber(),
  };
}

/**
 * Wearer-side vouch progress, SUBGRAPH-FIRST with the RPC batch as fallback.
 * Display-only (`pop vouch status`) — never used to gate a write.
 *
 * `preferSubgraph: false` (set when the caller passed an explicit --rpc)
 * skips the subgraph entirely so an explicitly targeted node stays the
 * source of truth.
 */
export async function readWearerVouchState(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string,
  hatId: ethers.BigNumber,
  wearer: string,
  opts: { chainId?: number; preferSubgraph?: boolean } = {}
): Promise<{ state: WearerVouchState; source: 'subgraph' | 'rpc' }> {
  if (opts.preferSubgraph !== false) {
    const fromSubgraph = await fetchWearerVouchStateFromSubgraph(
      eligibilityModuleAddress,
      hatId,
      wearer,
      opts.chainId
    );
    if (fromSubgraph) return { state: fromSubgraph, source: 'subgraph' };
  }
  const state = await readWearerVouchStateOnchain(provider, eligibilityModuleAddress, hatId, wearer);
  return { state, source: 'rpc' };
}

/**
 * Read the module's superAdmin address (public getter, verified).
 *
 * NOT sourced from the subgraph even though EligibilityModuleContract
 * .superAdmin is populated and matches on chain (verified: module
 * 0x27114cb7… → 0x23f90b38… on both). Every caller is requireSuperAdmin, a
 * pure revert predictor for the onlySuperAdmin modifier. Indexing lag over a
 * transferSuperAdmin would either broadcast a doomed admin transaction (the
 * outgoing admin still looks authorised) or hard-block the incoming one, and
 * these are all write paths where one extra eth_call is noise next to the
 * transaction itself.
 */
export async function getSuperAdmin(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string
): Promise<string> {
  const contract = createReadContract(eligibilityModuleAddress, 'EligibilityModuleNew', provider);
  return await contract.superAdmin();
}

/** Shared superAdmin mismatch/unreadable errors for both requireSuperAdmin forms. */
function assertSuperAdmin(admin: string, signerAddress: string, action: string): string {
  if (admin.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new PreconditionError(
      `${action} is superAdmin-only — the module superAdmin is ${admin}, but you are signing as ${signerAddress}.`,
      'Run with the superAdmin key. If the superAdmin is the org executor, route this change through a governance proposal instead.'
    );
  }
  return admin;
}

function unreadableSuperAdmin(eligibilityModuleAddress: string): PreconditionError {
  return new PreconditionError(
    `Could not read superAdmin() from the eligibility module at ${eligibilityModuleAddress}.`,
    'Check RPC connectivity and that the org has an EligibilityModule deployed.'
  );
}

/**
 * Fail fast (exit 4) when the signer is not the module superAdmin, naming
 * who the superAdmin actually is — BEFORE any gas is spent. Returns the
 * superAdmin address on success. All EligibilityModule admin writes are
 * onlySuperAdmin (verified, see module header).
 */
export async function requireSuperAdmin(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string,
  signerAddress: string,
  action: string
): Promise<string> {
  let admin: string;
  try {
    admin = await getSuperAdmin(provider, eligibilityModuleAddress);
  } catch {
    throw unreadableSuperAdmin(eligibilityModuleAddress);
  }
  return assertSuperAdmin(admin, signerAddress, action);
}

/**
 * requireSuperAdmin PLUS one extra pre-flight read, in ONE Multicall3
 * round-trip instead of two sequential eth_calls to the same contract.
 *
 * The two are independent: a superAdmin() failure raises the same
 * PreconditionError requireSuperAdmin does, while a failure of the extra read
 * (older module without the getter, for instance) is returned as
 * `{ extra: null, extraError }` so callers can keep downgrading it to a
 * skipped soft check rather than blocking the write.
 */
export async function requireSuperAdminWithRead<T = any>(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string,
  signerAddress: string,
  action: string,
  extra: EligibilityRead
): Promise<{ admin: string; extra: T | null; extraError: any }> {
  const [adminResult, extraResult] = await batchEligibilityReadsSettled(
    provider,
    eligibilityModuleAddress,
    [{ fn: 'superAdmin', args: [] }, extra]
  );
  if (adminResult.status === 'rejected') throw unreadableSuperAdmin(eligibilityModuleAddress);
  const admin = assertSuperAdmin(adminResult.value, signerAddress, action);
  return extraResult.status === 'fulfilled'
    ? { admin, extra: extraResult.value as T, extraError: null }
    : { admin, extra: null, extraError: extraResult.reason };
}

/** Signer-side vouching gate: the rate-limit/grace reads behind canUserVouch. */
export interface VoucherGate {
  canVouch: boolean;
  dailyUsed: number;
  maxDaily: number;
  /** Unix seconds; 0 = never set (no restriction applies). */
  joinTime: number;
}

/**
 * The four gate reads, in batch order. ALL FOUR ARE RPC-ONLY and cannot be
 * served by the subgraph (verified 2026-07-30 against poa-gnosis-v-1):
 *   canUserVouch            — composite of join-grace + daily limit, no field
 *   getCurrentDailyVouchCount — no field (derivable from Vouch.createdAt, but
 *                             only by re-deriving the contract's UTC-day
 *                             bucketing client-side; left on RPC)
 *   getMaxDailyVouches      — EligibilityModuleContract has no maxDailyVouches
 *                             field even though MaxDailyVouchesSet is emitted
 *   getUserJoinTime         — UserJoinTime entity has ZERO rows live
 */
const VOUCHER_GATE_READS = (voucher: string): EligibilityRead[] => [
  { fn: 'canUserVouch', args: [voucher] },
  { fn: 'getCurrentDailyVouchCount', args: [voucher] },
  { fn: 'getMaxDailyVouches', args: [] },
  { fn: 'getUserJoinTime', args: [voucher] },
];

function decodeVoucherGate(raw: any[]): VoucherGate {
  const [canVouch, dailyUsed, maxDaily, joinTime] = raw;
  return {
    canVouch: Boolean(canVouch),
    dailyUsed: ethers.BigNumber.from(dailyUsed).toNumber(),
    maxDaily: ethers.BigNumber.from(maxDaily).toNumber(),
    joinTime: ethers.BigNumber.from(joinTime).toNumber(),
  };
}

/**
 * Read the signer-side vouching gate in ONE Multicall3 round-trip:
 * canUserVouch (the authoritative on-chain answer), getCurrentDailyVouchCount
 * vs getMaxDailyVouches, and getUserJoinTime for the new-account grace.
 */
export async function readVoucherGate(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string,
  voucher: string
): Promise<VoucherGate> {
  const raw = await batchEligibilityReads(provider, eligibilityModuleAddress, VOUCHER_GATE_READS(voucher));
  return decodeVoucherGate(raw);
}

/** Approximate new-user grace used only for the unlock estimate (deployed v4 modules). */
const NEW_USER_GRACE_SECONDS = 2 * 86400;

/**
 * Human reason why a signer cannot vouch right now, derived from the gate
 * reads. canUserVouch is authoritative; this maps its `false` to the same
 * friendly reasons the contract enforces (daily rate limit, else the
 * new-account grace). Returns null when the signer can vouch.
 */
export function vouchRestriction(
  gate: VoucherGate,
  now: number = Math.floor(Date.now() / 1000)
): { message: string; suggestion: string } | null {
  if (gate.canVouch) return null;

  if (gate.dailyUsed >= gate.maxDaily) {
    const nextUtcMidnight = (Math.floor(now / 86400) + 1) * 86400;
    return {
      message: `Daily vouch limit reached (${gate.dailyUsed}/${gate.maxDaily} used today).`,
      suggestion: `The counter resets at the next UTC midnight (${formatRelativeTime(nextUtcMidnight, now)}).`,
    };
  }

  const unlockAt = gate.joinTime > 0 ? gate.joinTime + NEW_USER_GRACE_SECONDS : 0;
  const unlockHint = unlockAt > now
    ? `Vouching unlocks ${formatRelativeTime(unlockAt, now)} (about 2 days after joining).`
    : 'New accounts must wait out a short grace period before vouching.';
  return {
    message: 'Account too new — new members cannot vouch during the join grace period.',
    suggestion: unlockHint,
  };
}

/** "2/3 used today" quota fragment shared by vouch status + vouch for. */
export function vouchQuotaLabel(gate: VoucherGate): string {
  return `${gate.dailyUsed}/${gate.maxDaily} used today`;
}

/** Everything `pop vouch for` pre-flights in one read batch. */
export interface VouchPreflightState {
  gate: VoucherGate;
  config: VouchConfigView;
  /** Wearer's current (epoch-aware) vouch count for the hat. */
  currentCount: number;
}

/**
 * Pre-flight reads for `pop vouch for`, in ONE Multicall3 round-trip (was six
 * separate eth_calls): the signer gate, the hat's vouch config
 * (enabled/quorum), and the wearer's current count for the progress line.
 *
 * Deliberately RPC — this gates a write, and every field predicts a revert
 * (VouchingNotEnabled, NewUserVouchingRestricted, VouchingRateLimitExceeded).
 */
export async function readVouchPreflight(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string,
  hatId: ethers.BigNumberish,
  voucher: string,
  wearer: string
): Promise<VouchPreflightState> {
  const raw = await batchEligibilityReads(provider, eligibilityModuleAddress, [
    ...VOUCHER_GATE_READS(voucher),
    { fn: 'getVouchConfig', args: [hatId] },
    { fn: 'currentVouchCount', args: [hatId, wearer] },
  ]);
  const [rawConfig, currentCount] = raw.slice(4);
  return {
    gate: decodeVoucherGate(raw.slice(0, 4)),
    config: decodeVouchConfig(rawConfig),
    currentCount: ethers.BigNumber.from(currentCount).toNumber(),
  };
}

/** Claim-side pre-flight state for `pop vouch claim`. */
export interface ClaimGateState {
  eligible: boolean;
  standing: boolean;
  config: VouchConfigView;
  currentCount: number;
}

/**
 * Read getWearerStatus + vouch progress for a claim pre-flight, in ONE
 * Multicall3 round-trip (was three eth_calls).
 *
 * getWearerStatus stays RPC on purpose. Besides gating a write, the subgraph's
 * WearerEligibility entity is NOT equivalent: it only materialises when an
 * admin sets a wearer-specific rule. VERIFIED live — wearer
 * 0x1302e867… reached quorum on hat 29089782865237956866… and
 * getWearerStatus() returns (true, true) on chain, yet the Gnosis subgraph has
 * ZERO WearerEligibility rows for that address. Sourcing the claim gate from
 * the subgraph would reject every vouch-eligible claimer.
 */
export async function readClaimGate(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string,
  wearer: string,
  hatId: ethers.BigNumberish
): Promise<ClaimGateState> {
  const [status, rawConfig, currentCount] = await batchEligibilityReads(provider, eligibilityModuleAddress, [
    { fn: 'getWearerStatus', args: [wearer, hatId] },
    { fn: 'getVouchConfig', args: [hatId] },
    { fn: 'currentVouchCount', args: [hatId, wearer] },
  ]);
  return {
    eligible: Boolean(status.eligible ?? status[0]),
    standing: Boolean(status.standing ?? status[1]),
    config: decodeVouchConfig(rawConfig),
    currentCount: ethers.BigNumber.from(currentCount).toNumber(),
  };
}

/**
 * True when the signer's own vouch record exists (raw, epoch-unaware).
 *
 * RPC-only: the sole caller is `pop vouch revoke`'s pre-flight, which exists
 * to predict revokeVouch's HasNotVouched revert. The subgraph could answer it
 * (Vouch filtered on hatId+wearer+voucher+isActive is populated), but a stale
 * "false" blocks a legitimate revoke and a stale "true" broadcasts a doomed
 * one.
 */
export async function hasVouched(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string,
  hatId: ethers.BigNumberish,
  wearer: string,
  voucher: string
): Promise<boolean> {
  const contract = createReadContract(eligibilityModuleAddress, 'EligibilityModuleNew', provider);
  return Boolean(await contract.hasVouched(hatId, wearer, voucher));
}

/**
 * True when `applicant` has an active application for `hatId`.
 *
 * RPC-only. RoleApplication.active IS populated on the live subgraph, but the
 * ONLY caller of this helper is `pop role withdraw-application`'s pre-flight
 * (src/commands/role/withdraw-application.ts), which predicts the
 * NoActiveApplication revert — there is no display caller. `pop role
 * applications` already reads the subgraph directly via
 * src/queries/role.ts.
 */
export async function hasActiveApplication(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string,
  hatId: ethers.BigNumberish,
  applicant: string
): Promise<boolean> {
  const contract = createReadContract(eligibilityModuleAddress, 'EligibilityModuleNew', provider);
  return Boolean(await contract.hasActiveApplication(hatId, applicant));
}

/**
 * Read paused() (superAdmin emergency-pause state).
 *
 * RPC-only. EligibilityModuleContract.isPaused is populated and agrees with
 * chain (verified: false on module 0x27114cb7… both ways), but the only caller
 * is `pop role admin pause/unpause`, which uses it to predict OpenZeppelin's
 * ExpectedPause / EnforcedPause revert.
 */
export async function isPaused(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string
): Promise<boolean> {
  const contract = createReadContract(eligibilityModuleAddress, 'EligibilityModuleNew', provider);
  return Boolean(await contract.paused());
}

/** Short "0x1234…abcd vs 0x9876…ef01" pair for confirm summaries. */
export function addressPair(a: string, b: string): string {
  return `${formatAddress(a)} → ${formatAddress(b)}`;
}
