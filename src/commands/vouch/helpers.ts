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
 */

import { ethers } from 'ethers';
import { resolveOrgModules, requireModule } from '../../lib/resolve';
import { createReadContract } from '../../lib/contracts';
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

/** Read the module's superAdmin address (public getter, verified). */
export async function getSuperAdmin(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string
): Promise<string> {
  const contract = createReadContract(eligibilityModuleAddress, 'EligibilityModuleNew', provider);
  return await contract.superAdmin();
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
    throw new PreconditionError(
      `Could not read superAdmin() from the eligibility module at ${eligibilityModuleAddress}.`,
      'Check RPC connectivity and that the org has an EligibilityModule deployed.'
    );
  }
  if (admin.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new PreconditionError(
      `${action} is superAdmin-only — the module superAdmin is ${admin}, but you are signing as ${signerAddress}.`,
      'Run with the superAdmin key. If the superAdmin is the org executor, route this change through a governance proposal instead.'
    );
  }
  return admin;
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
 * Read the signer-side vouching gate in one batch: canUserVouch (the
 * authoritative on-chain answer), getCurrentDailyVouchCount vs
 * getMaxDailyVouches, and getUserJoinTime for the new-account grace.
 */
export async function readVoucherGate(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string,
  voucher: string
): Promise<VoucherGate> {
  const contract = createReadContract(eligibilityModuleAddress, 'EligibilityModuleNew', provider);
  const [canVouch, dailyUsed, maxDaily, joinTime] = await Promise.all([
    contract.canUserVouch(voucher),
    contract.getCurrentDailyVouchCount(voucher),
    contract.getMaxDailyVouches(),
    contract.getUserJoinTime(voucher),
  ]);
  return {
    canVouch: Boolean(canVouch),
    dailyUsed: ethers.BigNumber.from(dailyUsed).toNumber(),
    maxDaily: ethers.BigNumber.from(maxDaily).toNumber(),
    joinTime: ethers.BigNumber.from(joinTime).toNumber(),
  };
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
 * Batched pre-flight reads for `pop vouch for`: the signer gate, the hat's
 * vouch config (enabled/quorum), and the wearer's current count for the
 * progress line.
 */
export async function readVouchPreflight(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string,
  hatId: ethers.BigNumberish,
  voucher: string,
  wearer: string
): Promise<VouchPreflightState> {
  const contract = createReadContract(eligibilityModuleAddress, 'EligibilityModuleNew', provider);
  const [gate, rawConfig, currentCount] = await Promise.all([
    readVoucherGate(provider, eligibilityModuleAddress, voucher),
    contract.getVouchConfig(hatId),
    contract.currentVouchCount(hatId, wearer),
  ]);
  return {
    gate,
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

/** Read getWearerStatus + vouch progress for a claim pre-flight. */
export async function readClaimGate(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string,
  wearer: string,
  hatId: ethers.BigNumberish
): Promise<ClaimGateState> {
  const contract = createReadContract(eligibilityModuleAddress, 'EligibilityModuleNew', provider);
  const [status, rawConfig, currentCount] = await Promise.all([
    contract.getWearerStatus(wearer, hatId),
    contract.getVouchConfig(hatId),
    contract.currentVouchCount(hatId, wearer),
  ]);
  return {
    eligible: Boolean(status.eligible ?? status[0]),
    standing: Boolean(status.standing ?? status[1]),
    config: decodeVouchConfig(rawConfig),
    currentCount: ethers.BigNumber.from(currentCount).toNumber(),
  };
}

/** True when the signer's own vouch record exists (raw, epoch-unaware). */
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

/** True when `applicant` has an active application for `hatId`. */
export async function hasActiveApplication(
  provider: ethers.providers.Provider,
  eligibilityModuleAddress: string,
  hatId: ethers.BigNumberish,
  applicant: string
): Promise<boolean> {
  const contract = createReadContract(eligibilityModuleAddress, 'EligibilityModuleNew', provider);
  return Boolean(await contract.hasActiveApplication(hatId, applicant));
}

/** Read paused() (superAdmin emergency-pause state). */
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
