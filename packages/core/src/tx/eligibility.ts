/**
 * EligibilityModuleNew transaction builders — the vouch/* and role/* write
 * surface (both CLI domains write to the same module).
 *
 * Level 1 (`build*`): pure, synchronous — resolved module address + prepared
 * values in, TxIntent out. ALL argument encoding lives here and matches the
 * CLI's executeTx calls byte-for-byte.
 *
 * Level 2 (`*Intent`): async — resolve the org's eligibility module via the
 * subgraph, replicate the CLI's derivations (role-name→hatId, single-vs-batch
 * method choice, metadata pinning for role applications, the audit-M-03
 * vouch/default-eligibility conflict guard), then delegate to Level 1.
 *
 * NOT ported into builders (host concerns, run them via reads/eligibility +
 * preflight.ts exactly as the CLI does): requireSuperAdmin, the vouch-for /
 * claim / revoke revert-prediction gates, gas-balance checks, idempotency,
 * and confirmation prompts. The ONE preflight that IS ported is the M-03
 * conflict guard in configureVouchingIntent / setDefaultEligibilityIntent,
 * because its state check + callStatic simulation is the only version-proof
 * predictor of the DefaultEligibilityConflictsWithVouch revert and the CLI
 * enforces it inline (src/commands/vouch/config.ts,
 * src/commands/role/eligibility.ts).
 */

import { ethers } from 'ethers';
import type { TxIntent } from './intent';
import { getAbi, createReadContract } from '../contracts';
import type { PopContext } from '../context';
import { CliError, PreconditionError } from '../errors';
import { EXIT } from '../exit-codes';
import { pinJson } from '../ipfs';
import { ipfsCidToBytes32 } from '../encoding';
import { requireAddress } from '../validation';
import { vouchConflictsWithDefaultEligibility } from '../perms';
import {
  buildRoleApplicationMetadata,
  serializeRoleApplicationMetadata,
  RoleApplicationMetadata,
} from '../metadata/role';
import {
  resolveEligibilityModule,
  resolveRoleNameToHatId,
  parseHatId,
  batchEligibilityReadsSettled,
} from '../reads/eligibility';

const ABI_NAME = 'EligibilityModuleNew';

// ---------------------------------------------------------------------------
// Level 1 — pure builders (vouch surface)
// ---------------------------------------------------------------------------

export interface VouchForArgs {
  eligibilityModuleAddress: string;
  wearer: string;
  hatId: ethers.BigNumberish;
  orgId?: string;
}

/** Port of `pop vouch for` — src/commands/vouch/for.ts: vouchFor(wearer, hatId). */
export function buildVouchFor(a: VouchForArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'vouchFor',
    args: [a.wearer, a.hatId],
    meta: {
      domain: 'vouch',
      action: 'for',
      orgId: a.orgId,
      summary: { wearer: a.wearer, hat: String(a.hatId) },
    },
  };
}

export interface ClaimVouchedHatArgs {
  eligibilityModuleAddress: string;
  hatId: ethers.BigNumberish;
  orgId?: string;
}

/**
 * Port of `pop vouch claim` — src/commands/vouch/claim.ts:
 * claimVouchedHat(hatId). Claim-based pattern — quorum never auto-mints.
 */
export function buildClaimVouchedHat(a: ClaimVouchedHatArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'claimVouchedHat',
    args: [a.hatId],
    meta: {
      domain: 'vouch',
      action: 'claim',
      orgId: a.orgId,
      summary: { hat: String(a.hatId) },
    },
  };
}

export interface RevokeVouchArgs {
  eligibilityModuleAddress: string;
  wearer: string;
  hatId: ethers.BigNumberish;
  orgId?: string;
}

/** Port of `pop vouch revoke` — src/commands/vouch/revoke.ts: revokeVouch(wearer, hatId). */
export function buildRevokeVouch(a: RevokeVouchArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'revokeVouch',
    args: [a.wearer, a.hatId],
    meta: {
      domain: 'vouch',
      action: 'revoke',
      orgId: a.orgId,
      summary: { wearer: a.wearer, hat: String(a.hatId) },
    },
  };
}

export interface ResetVouchesArgs {
  eligibilityModuleAddress: string;
  hatId: ethers.BigNumberish;
  orgId?: string;
}

/**
 * Port of `pop vouch reset` (no --wearer) — src/commands/vouch/reset.ts:
 * resetVouches(hatId). DESTRUCTIVE, superAdmin-only: DELETES the hat's
 * VouchConfig (vouching becomes disabled) and bumps the vouch epoch so every
 * existing vouch for the hat is invalidated.
 */
export function buildResetVouches(a: ResetVouchesArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'resetVouches',
    args: [a.hatId],
    meta: {
      domain: 'vouch',
      action: 'reset',
      orgId: a.orgId,
      summary: { hat: String(a.hatId), scope: 'whole-hat' },
    },
  };
}

export interface ClearWearerVouchesArgs {
  eligibilityModuleAddress: string;
  wearer: string;
  hatId: ethers.BigNumberish;
  orgId?: string;
}

/**
 * Port of `pop vouch reset --wearer` — src/commands/vouch/reset.ts:
 * clearWearerVouches(wearer, hatId). Surgical per-wearer invalidation
 * (sentinel epoch + count wipe); other wearers' vouches and the hat's config
 * are untouched. superAdmin-only.
 */
export function buildClearWearerVouches(a: ClearWearerVouchesArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'clearWearerVouches',
    args: [a.wearer, a.hatId],
    meta: {
      domain: 'vouch',
      action: 'clear-wearer',
      orgId: a.orgId,
      summary: { hat: String(a.hatId), wearer: a.wearer, scope: 'single-wearer' },
    },
  };
}

export interface ConfigureVouchingArgs {
  eligibilityModuleAddress: string;
  hatId: ethers.BigNumberish;
  /** uint32; 0 disables vouching (`enabled` is derived on-chain as quorum > 0). */
  quorum: number;
  membershipHatId: ethers.BigNumberish;
  combineWithHierarchy: boolean;
  orgId?: string;
}

/**
 * Port of `pop vouch config set` — src/commands/vouch/config.ts:
 * configureVouching(hatId, quorum, membershipHatId, combineWithHierarchy).
 * superAdmin-only; configuring bumps the hat's vouch epoch, invalidating all
 * existing vouches.
 */
export function buildConfigureVouching(a: ConfigureVouchingArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'configureVouching',
    args: [a.hatId, a.quorum, a.membershipHatId, a.combineWithHierarchy],
    meta: {
      domain: 'vouch',
      action: 'config-set',
      orgId: a.orgId,
      summary: {
        hat: String(a.hatId),
        quorum: a.quorum,
        membershipHat: String(a.membershipHatId),
        combineWithHierarchy: a.combineWithHierarchy,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Level 1 — pure builders (role surface)
// ---------------------------------------------------------------------------

export interface ApplyForRoleArgs {
  eligibilityModuleAddress: string;
  hatId: ethers.BigNumberish;
  /** bytes32 — ipfsCidToBytes32 of the pinned role-application metadata. */
  applicationHash: string;
  orgId?: string;
}

/**
 * Port of `pop role apply` — src/commands/role/apply.ts:
 * applyForRole(hatId, applicationHash). Signaling only — grants no
 * eligibility.
 */
export function buildApplyForRole(a: ApplyForRoleArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'applyForRole',
    args: [a.hatId, a.applicationHash],
    meta: {
      domain: 'role',
      action: 'apply',
      orgId: a.orgId,
      summary: { hat: String(a.hatId) },
    },
  };
}

export interface WithdrawApplicationArgs {
  eligibilityModuleAddress: string;
  hatId: ethers.BigNumberish;
  orgId?: string;
}

/**
 * Port of `pop role withdraw-application` —
 * src/commands/role/withdraw-application.ts: withdrawApplication(hatId).
 */
export function buildWithdrawApplication(a: WithdrawApplicationArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'withdrawApplication',
    args: [a.hatId],
    meta: {
      domain: 'role',
      action: 'withdraw-application',
      orgId: a.orgId,
      summary: { hat: String(a.hatId) },
    },
  };
}

export interface CreateHatWithEligibilityArgs {
  eligibilityModuleAddress: string;
  parentHatId: ethers.BigNumberish;
  /** Role name — stored as the hat `details` string. */
  details: string;
  /** uint32 — max simultaneous wearers. */
  maxSupply: number;
  mutable: boolean;
  /** Hat image URI; empty string when omitted (CLI: `argv.image ?? ''`). */
  imageURI?: string;
  defaultEligible: boolean;
  defaultStanding: boolean;
  /** Addresses to mint the new hat to immediately; empty when omitted. */
  mintTo?: string[];
  /**
   * Per-mint-to flags. Default TRUE per address — the CLI ALWAYS forces true
   * so initial wearers are eligible regardless of the hat defaults.
   */
  wearerEligibleFlags?: boolean[];
  wearerStandingFlags?: boolean[];
  orgId?: string;
}

/**
 * Port of `pop role create` — src/commands/role/create.ts:
 * createHatWithEligibility(CreateHatParams). The tuple is built in EXACT ABI
 * order (verified in abi CreateHatParams components):
 *   (uint256 parentHatId, string details, uint32 maxSupply, bool _mutable,
 *    string imageURI, bool defaultEligible, bool defaultStanding,
 *    address[] mintToAddresses, bool[] wearerEligibleFlags,
 *    bool[] wearerStandingFlags)
 * superAdmin-only.
 */
export function buildCreateHatWithEligibility(a: CreateHatWithEligibilityArgs): TxIntent {
  const mintTo = a.mintTo ?? [];
  const eligibleFlags = a.wearerEligibleFlags ?? mintTo.map(() => true);
  const standingFlags = a.wearerStandingFlags ?? mintTo.map(() => true);
  if (eligibleFlags.length !== mintTo.length || standingFlags.length !== mintTo.length) {
    throw new CliError(
      'wearerEligibleFlags/wearerStandingFlags must match mintTo length.',
      EXIT.USAGE
    );
  }

  // CreateHatParams tuple — MUST match ABI component order (see doc comment).
  const params = [
    a.parentHatId,                  // parentHatId (uint256)
    a.details,                      // details (string)
    a.maxSupply,                    // maxSupply (uint32)
    a.mutable,                      // _mutable (bool)
    a.imageURI ?? '',               // imageURI (string)
    a.defaultEligible,              // defaultEligible (bool)
    a.defaultStanding,              // defaultStanding (bool)
    mintTo,                         // mintToAddresses (address[])
    eligibleFlags,                  // wearerEligibleFlags (bool[])
    standingFlags,                  // wearerStandingFlags (bool[])
  ];

  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'createHatWithEligibility',
    args: [params],
    meta: {
      domain: 'role',
      action: 'create',
      orgId: a.orgId,
      summary: {
        name: a.details,
        parentHat: String(a.parentHatId),
        maxSupply: a.maxSupply,
        mintTo: mintTo.length,
      },
    },
  };
}

export interface SetWearerEligibilityArgs {
  eligibilityModuleAddress: string;
  wearer: string;
  hatId: ethers.BigNumberish;
  eligible: boolean;
  standing: boolean;
  orgId?: string;
}

/**
 * Port of `pop role eligibility set` (single-wearer) —
 * src/commands/role/eligibility.ts:
 * setWearerEligibility(wearer, hatId, eligible, standing). superAdmin-only.
 */
export function buildSetWearerEligibility(a: SetWearerEligibilityArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'setWearerEligibility',
    args: [a.wearer, a.hatId, a.eligible, a.standing],
    meta: {
      domain: 'role',
      action: 'eligibility-set',
      orgId: a.orgId,
      summary: { hat: String(a.hatId), wearer: a.wearer, eligible: a.eligible, standing: a.standing },
    },
  };
}

export interface BatchSetWearerEligibilityArgs {
  eligibilityModuleAddress: string;
  hatId: ethers.BigNumberish;
  wearers: string[];
  eligibleFlags: boolean[];
  standingFlags: boolean[];
  orgId?: string;
}

/**
 * Port of `pop role eligibility set --file` (batch) —
 * src/commands/role/eligibility.ts:
 * batchSetWearerEligibility(hatId, wearers[], eligibleFlags[], standingFlags[]).
 * superAdmin-only.
 */
export function buildBatchSetWearerEligibility(a: BatchSetWearerEligibilityArgs): TxIntent {
  if (a.eligibleFlags.length !== a.wearers.length || a.standingFlags.length !== a.wearers.length) {
    throw new CliError(
      'eligibleFlags/standingFlags must match wearers length.',
      EXIT.USAGE
    );
  }
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'batchSetWearerEligibility',
    args: [a.hatId, a.wearers, a.eligibleFlags, a.standingFlags],
    meta: {
      domain: 'role',
      action: 'eligibility-set-batch',
      orgId: a.orgId,
      summary: { hat: String(a.hatId), count: a.wearers.length },
    },
  };
}

export interface ClearWearerEligibilityArgs {
  eligibilityModuleAddress: string;
  wearer: string;
  hatId: ethers.BigNumberish;
  orgId?: string;
}

/**
 * Port of `pop role eligibility clear` — src/commands/role/eligibility.ts:
 * clearWearerEligibility(wearer, hatId) — removes the wearer-specific rule so
 * the hat DEFAULTS apply again. superAdmin-only.
 */
export function buildClearWearerEligibility(a: ClearWearerEligibilityArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'clearWearerEligibility',
    args: [a.wearer, a.hatId],
    meta: {
      domain: 'role',
      action: 'eligibility-clear',
      orgId: a.orgId,
      summary: { hat: String(a.hatId), wearer: a.wearer },
    },
  };
}

export interface SetDefaultEligibilityArgs {
  eligibilityModuleAddress: string;
  hatId: ethers.BigNumberish;
  eligible: boolean;
  standing: boolean;
  orgId?: string;
}

/**
 * Port of `pop role eligibility set-default` —
 * src/commands/role/eligibility.ts:
 * setDefaultEligibility(hatId, eligible, standing). superAdmin-only. See
 * setDefaultEligibilityIntent for the audit-M-03 conflict guard the CLI runs
 * before this write.
 */
export function buildSetDefaultEligibility(a: SetDefaultEligibilityArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'setDefaultEligibility',
    args: [a.hatId, a.eligible, a.standing],
    meta: {
      domain: 'role',
      action: 'eligibility-set-default',
      orgId: a.orgId,
      summary: { hat: String(a.hatId), eligible: a.eligible, standing: a.standing },
    },
  };
}

export interface TransferSuperAdminArgs {
  eligibilityModuleAddress: string;
  newSuperAdmin: string;
  orgId?: string;
}

/**
 * Port of `pop role admin transfer` — src/commands/role/admin.ts:
 * transferSuperAdmin(newSuperAdmin). DESTRUCTIVE — hands over the ENTIRE
 * module (roles, eligibility, vouching, pause). superAdmin-only.
 */
export function buildTransferSuperAdmin(a: TransferSuperAdminArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'transferSuperAdmin',
    args: [a.newSuperAdmin],
    meta: {
      domain: 'role',
      action: 'admin-transfer',
      orgId: a.orgId,
      summary: { newSuperAdmin: a.newSuperAdmin },
    },
  };
}

export interface MintHatToAddressArgs {
  eligibilityModuleAddress: string;
  hatId: ethers.BigNumberish;
  wearer: string;
  orgId?: string;
}

/**
 * Port of `pop role admin mint` (single wearer) — src/commands/role/admin.ts:
 * mintHatToAddress(hatId, wearer). superAdmin-only.
 */
export function buildMintHatToAddress(a: MintHatToAddressArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'mintHatToAddress',
    args: [a.hatId, a.wearer],
    meta: {
      domain: 'role',
      action: 'admin-mint',
      orgId: a.orgId,
      summary: { hat: String(a.hatId), wearer: a.wearer },
    },
  };
}

export interface BatchMintHatsArgs {
  eligibilityModuleAddress: string;
  hatIds: ethers.BigNumberish[];
  wearers: string[];
  orgId?: string;
}

/**
 * Port of `pop role admin mint` (comma-separated wearers) —
 * src/commands/role/admin.ts: batchMintHats(hatIds[], wearers[]). The CLI
 * replicates ONE hat per wearer (`wearers.map(() => hatId)`); mintHatsIntent
 * derives that. superAdmin-only.
 */
export function buildBatchMintHats(a: BatchMintHatsArgs): TxIntent {
  if (a.hatIds.length !== a.wearers.length) {
    throw new CliError('hatIds must match wearers length.', EXIT.USAGE);
  }
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'batchMintHats',
    args: [a.hatIds, a.wearers],
    meta: {
      domain: 'role',
      action: 'admin-mint-batch',
      orgId: a.orgId,
      summary: { count: a.wearers.length },
    },
  };
}

export interface PauseArgs {
  eligibilityModuleAddress: string;
  orgId?: string;
}

/** Port of `pop role admin pause` — src/commands/role/admin.ts: pause(). superAdmin-only. */
export function buildPause(a: PauseArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'pause',
    args: [],
    meta: {
      domain: 'role',
      action: 'admin-pause',
      orgId: a.orgId,
      summary: { module: a.eligibilityModuleAddress },
    },
  };
}

/** Port of `pop role admin unpause` — src/commands/role/admin.ts: unpause(). superAdmin-only. */
export function buildUnpause(a: PauseArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'unpause',
    args: [],
    meta: {
      domain: 'role',
      action: 'admin-unpause',
      orgId: a.orgId,
      summary: { module: a.eligibilityModuleAddress },
    },
  };
}

export interface SetUserJoinTimeArgs {
  eligibilityModuleAddress: string;
  user: string;
  /** Unix seconds. */
  joinTime: ethers.BigNumberish;
  orgId?: string;
}

/**
 * Port of `pop role admin set-join-time --timestamp` —
 * src/commands/role/admin.ts: setUserJoinTime(user, joinTime). Governs the
 * new-account vouching grace. superAdmin-only.
 */
export function buildSetUserJoinTime(a: SetUserJoinTimeArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'setUserJoinTime',
    args: [a.user, a.joinTime],
    meta: {
      domain: 'role',
      action: 'admin-set-join-time',
      orgId: a.orgId,
      summary: { user: a.user, timestamp: String(a.joinTime) },
    },
  };
}

export interface SetUserJoinTimeNowArgs {
  eligibilityModuleAddress: string;
  user: string;
  orgId?: string;
}

/**
 * Port of `pop role admin set-join-time` (no --timestamp) —
 * src/commands/role/admin.ts: setUserJoinTimeNow(user) — uses the current
 * block time. superAdmin-only.
 */
export function buildSetUserJoinTimeNow(a: SetUserJoinTimeNowArgs): TxIntent {
  return {
    to: a.eligibilityModuleAddress,
    abi: getAbi(ABI_NAME),
    method: 'setUserJoinTimeNow',
    args: [a.user],
    meta: {
      domain: 'role',
      action: 'admin-set-join-time',
      orgId: a.orgId,
      summary: { user: a.user, timestamp: 'now' },
    },
  };
}

// ---------------------------------------------------------------------------
// Level 2 — resolved builders (vouch surface)
// ---------------------------------------------------------------------------

export interface VouchForParams {
  org: string;
  /** Address of the user to vouch for. */
  wearer: string;
  /** Hat ID; either this or `role` is required. */
  hat?: string | number;
  /** Role name — resolved to a hat ID via the subgraph, as the CLI's --role. */
  role?: string;
  /**
   * The signing address, when known — enables the CLI's self-vouch guard
   * ("You cannot vouch for yourself.").
   */
  voucher?: string;
}

/** Port of `pop vouch for` — src/commands/vouch/for.ts (org + role-name resolution). */
export async function vouchForIntent(ctx: PopContext, params: VouchForParams): Promise<TxIntent> {
  const wearer = requireAddress(params.wearer, 'address');

  let hatId = params.hat !== undefined ? String(params.hat) : undefined;
  if (!hatId && params.role) {
    hatId = await resolveRoleNameToHatId(ctx.client, params.org, params.role, ctx.chainId);
  }
  if (!hatId) {
    throw new CliError('Either --hat or --role is required', EXIT.USAGE);
  }

  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);

  if (params.voucher && wearer.toLowerCase() === params.voucher.toLowerCase()) {
    throw new PreconditionError(
      'You cannot vouch for yourself.',
      'Ask another member holding the membership hat to vouch for you.'
    );
  }

  return buildVouchFor({ eligibilityModuleAddress, wearer, hatId, orgId });
}

export interface ClaimVouchedHatParams {
  org: string;
  hat: string | number;
}

/** Port of `pop vouch claim` — src/commands/vouch/claim.ts (org resolution). */
export async function claimVouchedHatIntent(ctx: PopContext, params: ClaimVouchedHatParams): Promise<TxIntent> {
  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);
  return buildClaimVouchedHat({ eligibilityModuleAddress, hatId: String(params.hat), orgId });
}

export interface RevokeVouchParams {
  org: string;
  /** Address whose vouch to revoke (the wearer YOU vouched for). */
  wearer: string;
  hat: string | number;
}

/** Port of `pop vouch revoke` — src/commands/vouch/revoke.ts (org resolution). */
export async function revokeVouchIntent(ctx: PopContext, params: RevokeVouchParams): Promise<TxIntent> {
  const wearer = requireAddress(params.wearer, 'address');
  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);
  return buildRevokeVouch({ eligibilityModuleAddress, wearer, hatId: String(params.hat), orgId });
}

export interface ResetVouchesParams {
  org: string;
  hat: string | number;
  /** When set: surgical clearWearerVouches(wearer, hat); else resetVouches(hat). */
  wearer?: string;
}

/**
 * Port of `pop vouch reset` — src/commands/vouch/reset.ts. Derives the method
 * exactly as the CLI does: --wearer → clearWearerVouches (surgical), no
 * --wearer → resetVouches (deletes the VouchConfig + bumps the epoch).
 * DESTRUCTIVE, superAdmin-only.
 */
export async function resetVouchesIntent(ctx: PopContext, params: ResetVouchesParams): Promise<TxIntent> {
  const hatId = parseHatId(params.hat);
  const wearer = params.wearer ? requireAddress(params.wearer, 'wearer') : undefined;
  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);
  return wearer
    ? buildClearWearerVouches({ eligibilityModuleAddress, wearer, hatId, orgId })
    : buildResetVouches({ eligibilityModuleAddress, hatId, orgId });
}

export interface ConfigureVouchingParams {
  org: string;
  hat: string | number;
  /** Vouches required to become claimable; 0 disables vouching. */
  quorum: number;
  /** Hat whose wearers are allowed to vouch. */
  membershipHat: string | number;
  combineHierarchy?: boolean;
  /**
   * The signing address — used by the M-03 callStatic simulation, which the
   * CLI runs from the real superAdmin. Guard is skipped when absent.
   */
  from?: string;
  /** false skips the M-03 conflict guard (the CLI's --no-preflight). */
  preflight?: boolean;
}

/**
 * Port of `pop vouch config set` — src/commands/vouch/config.ts, including the
 * audit-M-03 reverse-direction guard: enabling vouching WITH combine-hierarchy
 * on a hat that is already default-eligible reverts
 * DefaultEligibilityConflictsWithVouch on modules that implement the check —
 * everyone is eligible anyway, so the quorum would be a no-op. The state is
 * detected via getDefaultRules, then the exact call is simulated from `from`
 * (state alone is version-ambiguous — deployed v6 modules accept it). Only a
 * contract revert blocks; transport failures degrade and let gas estimation be
 * the real gate. Requires ctx.provider + params.from to run.
 */
export async function configureVouchingIntent(ctx: PopContext, params: ConfigureVouchingParams): Promise<TxIntent> {
  const hatId = parseHatId(params.hat);
  const membershipHatId = parseHatId(params.membershipHat);
  const quorum = params.quorum;
  if (!Number.isInteger(quorum) || quorum < 0 || quorum > 0xffffffff) {
    throw new CliError(`Invalid --quorum ${quorum}.`, EXIT.USAGE, 'Pass a non-negative integer (uint32).');
  }
  const combine = Boolean(params.combineHierarchy);

  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);

  const needsDefaultRules = combine && quorum > 0;
  if (params.preflight !== false && needsDefaultRules && ctx.provider && params.from) {
    const [rulesResult] = await batchEligibilityReadsSettled(ctx.provider, eligibilityModuleAddress, [
      { fn: 'getDefaultRules', args: [hatId] },
    ]);
    // A failed read (older module without the getter) downgrades to a skipped
    // soft check rather than blocking the write — same as the CLI.
    const rules = rulesResult.status === 'fulfilled' ? rulesResult.value : null;
    if (rules !== null && Boolean(rules.eligible ?? rules[0])) {
      // The STATE conflicts, but only a module implementing the M-03 revert rejects the
      // write — the deployed v6 modules do NOT. Simulate the exact call instead — the
      // only version-proof revert predictor.
      const sim = createReadContract(eligibilityModuleAddress, ABI_NAME, ctx.provider);
      try {
        await sim.callStatic.configureVouching(hatId, quorum, membershipHatId, combine, { from: params.from });
        // Module accepts the write anyway (the CLI warns and proceeds).
      } catch (simErr: any) {
        // Only a CONTRACT revert proves the module enforces M-03; a transport
        // failure proves nothing and must not block a valid write.
        if (simErr?.code === 'CALL_EXCEPTION' || simErr?.code === 'UNPREDICTABLE_GAS_LIMIT') {
          throw new PreconditionError(
            `Hat ${hatId} is default-eligible — everyone already qualifies — so a vouch quorum `
              + 'combined with the hat hierarchy would have no effect, and the module rejects it.',
            `Close the hat first: pop role eligibility set-default --hat ${hatId} --no-eligible, `
              + 'or re-run without --combine-hierarchy.',
          );
        }
      }
    }
  }

  return buildConfigureVouching({
    eligibilityModuleAddress,
    hatId,
    quorum,
    membershipHatId,
    combineWithHierarchy: combine,
    orgId,
  });
}

// ---------------------------------------------------------------------------
// Level 2 — resolved builders (role surface)
// ---------------------------------------------------------------------------

export interface ApplyForRoleParams {
  org: string;
  hat: string | number;
  notes?: string;
  experience?: string;
  /** Override the appliedAt timestamp (unix ms). Default Date.now(). */
  appliedAt?: number;
}

/**
 * Port of `pop role apply` — src/commands/role/apply.ts. Pins the
 * {notes, experience, appliedAt} application metadata (metadata/role.ts —
 * key order preserved for frontend/subgraph parity), converts the CID to
 * bytes32, then delegates to buildApplyForRole. The pinned document rides in
 * meta.ipfs.
 */
export async function applyForRoleIntent(ctx: PopContext, params: ApplyForRoleParams): Promise<TxIntent> {
  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);

  const metadata: RoleApplicationMetadata = buildRoleApplicationMetadata({
    notes: params.notes,
    experience: params.experience,
    appliedAt: params.appliedAt,
  });
  const cid = await pinJson(serializeRoleApplicationMetadata(metadata), ctx.ipfs);
  const applicationHash = ipfsCidToBytes32(cid);

  const intent = buildApplyForRole({
    eligibilityModuleAddress,
    hatId: String(params.hat),
    applicationHash,
    orgId,
  });
  intent.meta.ipfs = { cid, metadata };
  return intent;
}

export interface WithdrawApplicationParams {
  org: string;
  hat: string | number;
}

/**
 * Port of `pop role withdraw-application` —
 * src/commands/role/withdraw-application.ts (org resolution).
 */
export async function withdrawApplicationIntent(ctx: PopContext, params: WithdrawApplicationParams): Promise<TxIntent> {
  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);
  return buildWithdrawApplication({ eligibilityModuleAddress, hatId: String(params.hat), orgId });
}

/** Parse "--mint-to a,b,c" into checksummed addresses (empty when omitted). */
export function parseMintTo(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(addr => requireAddress(addr, 'mint-to'));
}

export interface CreateRoleParams {
  org: string;
  parentHat: string | number;
  /** Role name (stored as the hat details). */
  name: string;
  image?: string;
  /** Default 1000, as the CLI. */
  maxSupply?: number;
  mutable?: boolean;
  defaultEligible?: boolean;
  defaultStanding?: boolean;
  /** Comma-separated string (CLI --mint-to) or a prepared address array. */
  mintTo?: string | string[];
}

/**
 * Port of `pop role create` — src/commands/role/create.ts: validates
 * max-supply (uint32), parses/checksums --mint-to, forces the per-mint-to
 * eligible/standing flags TRUE, then delegates to
 * buildCreateHatWithEligibility. superAdmin-only.
 */
export async function createHatWithEligibilityIntent(ctx: PopContext, params: CreateRoleParams): Promise<TxIntent> {
  const parentHatId = parseHatId(params.parentHat);
  const maxSupply = params.maxSupply ?? 1000;
  if (!Number.isInteger(maxSupply) || maxSupply <= 0 || maxSupply > 0xffffffff) {
    throw new CliError(`Invalid --max-supply ${maxSupply}.`, EXIT.USAGE, 'Pass a positive integer that fits uint32.');
  }
  const mintTo = Array.isArray(params.mintTo)
    ? params.mintTo.map(addr => requireAddress(addr, 'mint-to'))
    : parseMintTo(params.mintTo);

  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);

  return buildCreateHatWithEligibility({
    eligibilityModuleAddress,
    parentHatId,
    details: params.name,
    maxSupply,
    mutable: Boolean(params.mutable),
    imageURI: params.image ?? '',
    defaultEligible: Boolean(params.defaultEligible),
    defaultStanding: Boolean(params.defaultStanding),
    mintTo,
    orgId,
  });
}

export interface SetWearerEligibilityParams {
  org: string;
  hat: string | number;
  wearer: string;
  /** Default true (the CLI's --eligible default; --no-eligible → false). */
  eligible?: boolean;
  /** Default true (the CLI's --standing default; --no-standing → false). */
  standing?: boolean;
}

/**
 * Port of `pop role eligibility set` (single wearer) —
 * src/commands/role/eligibility.ts. superAdmin-only.
 */
export async function setWearerEligibilityIntent(ctx: PopContext, params: SetWearerEligibilityParams): Promise<TxIntent> {
  const hatId = parseHatId(params.hat);
  const wearer = requireAddress(params.wearer, 'wearer');
  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);
  return buildSetWearerEligibility({
    eligibilityModuleAddress,
    wearer,
    hatId,
    eligible: params.eligible !== false,
    standing: params.standing !== false,
    orgId,
  });
}

/** One batch entry — the CLI's --file JSON row shape. */
export interface EligibilityBatchEntry {
  wearer: string;
  /** Default true when omitted, as in the CLI's batch file format. */
  eligible?: boolean;
  standing?: boolean;
}

export interface BatchSetWearerEligibilityParams {
  org: string;
  hat: string | number;
  entries: EligibilityBatchEntry[];
}

/**
 * Port of `pop role eligibility set --file` —
 * src/commands/role/eligibility.ts: validates the entries (the CLI's batch
 * JSON shape, minus the fs read — the host loads the file), defaults
 * eligible/standing to true, and encodes
 * batchSetWearerEligibility(hatId, wearers[], eligibles[], standings[]).
 * superAdmin-only.
 */
export async function batchSetWearerEligibilityIntent(
  ctx: PopContext,
  params: BatchSetWearerEligibilityParams
): Promise<TxIntent> {
  const hatId = parseHatId(params.hat);
  if (!Array.isArray(params.entries) || params.entries.length === 0) {
    throw new CliError(
      'Batch file must be a non-empty JSON array.',
      EXIT.USAGE,
      'Expected: [{"wearer": "0x…", "eligible": true, "standing": true}, …]'
    );
  }
  const batch = params.entries.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || !entry.wearer) {
      throw new CliError(`Batch entry ${i} is missing "wearer".`, EXIT.USAGE);
    }
    return {
      wearer: requireAddress(String(entry.wearer), `file entry ${i} wearer`),
      eligible: entry.eligible === undefined ? true : Boolean(entry.eligible),
      standing: entry.standing === undefined ? true : Boolean(entry.standing),
    };
  });

  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);
  return buildBatchSetWearerEligibility({
    eligibilityModuleAddress,
    hatId,
    wearers: batch.map(b => b.wearer),
    eligibleFlags: batch.map(b => b.eligible),
    standingFlags: batch.map(b => b.standing),
    orgId,
  });
}

export interface ClearWearerEligibilityParams {
  org: string;
  hat: string | number;
  wearer: string;
}

/**
 * Port of `pop role eligibility clear` — src/commands/role/eligibility.ts.
 * superAdmin-only.
 */
export async function clearWearerEligibilityIntent(ctx: PopContext, params: ClearWearerEligibilityParams): Promise<TxIntent> {
  const hatId = parseHatId(params.hat);
  const wearer = requireAddress(params.wearer, 'wearer');
  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);
  return buildClearWearerEligibility({ eligibilityModuleAddress, wearer, hatId, orgId });
}

export interface SetDefaultEligibilityParams {
  org: string;
  hat: string | number;
  /** Default true — a bare set-default hits the M-03 guard, as in the CLI. */
  eligible?: boolean;
  standing?: boolean;
  /**
   * The signing address — used by the M-03 callStatic simulation, which the
   * CLI runs from the real superAdmin. Guard is skipped when absent.
   */
  from?: string;
  /** false skips the M-03 conflict guard (the CLI's --no-preflight). */
  preflight?: boolean;
}

/**
 * Port of `pop role eligibility set-default` —
 * src/commands/role/eligibility.ts, including the audit-M-03 guard: making a
 * hat default-eligible while it uses vouching WITH combineWithHierarchy
 * reverts DefaultEligibilityConflictsWithVouch — an open hat makes the vouch
 * quorum meaningless. The state is detected via getVouchConfig +
 * vouchConflictsWithDefaultEligibility (../perms — the browser-pure rule the
 * CLI uses), then the exact call is simulated from `from`, because the state
 * check alone is version-ambiguous: the deployed v6 modules ACCEPT the write
 * (verified live — 17/19 live VouchConfig rows are in the "conflicting"
 * state, so blocking on state alone would refuse a valid write on nearly
 * every hat). Only a contract revert blocks; transport failures degrade and
 * let gas estimation be the real gate. Requires ctx.provider + params.from.
 * superAdmin-only.
 */
export async function setDefaultEligibilityIntent(ctx: PopContext, params: SetDefaultEligibilityParams): Promise<TxIntent> {
  const hatId = parseHatId(params.hat);
  const eligible = params.eligible !== false;
  const standing = params.standing !== false;

  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);

  if (params.preflight !== false && eligible && ctx.provider && params.from) {
    const [configResult] = await batchEligibilityReadsSettled(ctx.provider, eligibilityModuleAddress, [
      { fn: 'getVouchConfig', args: [hatId] },
    ]);
    // A failed read downgrades to a skipped soft check rather than blocking
    // the write — same as the CLI.
    const vc = configResult.status === 'fulfilled' ? configResult.value : null;
    if (vc !== null && vouchConflictsWithDefaultEligibility(Number(vc.flags), Number(vc.quorum), true)) {
      // The STATE conflicts, but only a module that implements the M-03 revert
      // actually rejects the write. Simulate the exact call instead — the only
      // version-proof revert predictor.
      const sim = createReadContract(eligibilityModuleAddress, ABI_NAME, ctx.provider);
      try {
        await sim.callStatic.setDefaultEligibility(hatId, eligible, standing, { from: params.from });
        // Module accepts the write anyway (the CLI warns and proceeds).
      } catch (simErr: any) {
        // Only a CONTRACT revert proves the module enforces M-03; a transport
        // failure proves nothing and must not block a valid write.
        if (simErr?.code === 'CALL_EXCEPTION' || simErr?.code === 'UNPREDICTABLE_GAS_LIMIT') {
          throw new PreconditionError(
            `Hat ${hatId} uses vouching with combine-hierarchy (quorum ${vc.quorum}). Making it `
              + 'default-eligible would make that quorum a no-op, so the module rejects it.',
            'Drop combine-hierarchy or disable vouching first: '
              + `pop vouch config set --hat ${hatId} --quorum 0`,
          );
        }
      }
    }
  }

  return buildSetDefaultEligibility({ eligibilityModuleAddress, hatId, eligible, standing, orgId });
}

export interface TransferSuperAdminParams {
  org: string;
  /** New superAdmin address. */
  to: string;
  /** Current signer, when known — enables the CLI's self-transfer guard. */
  from?: string;
}

/**
 * Port of `pop role admin transfer` — src/commands/role/admin.ts.
 * DESTRUCTIVE, superAdmin-only.
 */
export async function transferSuperAdminIntent(ctx: PopContext, params: TransferSuperAdminParams): Promise<TxIntent> {
  const to = requireAddress(params.to, 'to');
  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);
  if (params.from && to.toLowerCase() === params.from.toLowerCase()) {
    throw new PreconditionError('The target is already the superAdmin (you).', 'Pass a different --to address.');
  }
  return buildTransferSuperAdmin({ eligibilityModuleAddress, newSuperAdmin: to, orgId });
}

export interface MintHatsParams {
  org: string;
  hat: string | number;
  /** Comma-separated string (CLI --wearer) or a prepared address array. */
  wearer: string | string[];
}

/**
 * Port of `pop role admin mint` — src/commands/role/admin.ts. Derives the
 * method exactly as the CLI does: one wearer → mintHatToAddress(hat, wearer);
 * several → batchMintHats(hat replicated per wearer, wearers).
 * superAdmin-only.
 */
export async function mintHatsIntent(ctx: PopContext, params: MintHatsParams): Promise<TxIntent> {
  const hatId = parseHatId(params.hat);
  const wearers = (Array.isArray(params.wearer) ? params.wearer : String(params.wearer).split(','))
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(addr => requireAddress(addr, 'wearer'));
  if (wearers.length === 0) {
    throw new CliError('No valid --wearer addresses provided.', EXIT.USAGE);
  }

  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);
  return wearers.length === 1
    ? buildMintHatToAddress({ eligibilityModuleAddress, hatId, wearer: wearers[0], orgId })
    : buildBatchMintHats({ eligibilityModuleAddress, hatIds: wearers.map(() => hatId), wearers, orgId });
}

export interface PauseParams {
  org: string;
}

/** Port of `pop role admin pause` — src/commands/role/admin.ts. superAdmin-only. */
export async function pauseIntent(ctx: PopContext, params: PauseParams): Promise<TxIntent> {
  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);
  return buildPause({ eligibilityModuleAddress, orgId });
}

/** Port of `pop role admin unpause` — src/commands/role/admin.ts. superAdmin-only. */
export async function unpauseIntent(ctx: PopContext, params: PauseParams): Promise<TxIntent> {
  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);
  return buildUnpause({ eligibilityModuleAddress, orgId });
}

export interface SetJoinTimeParams {
  org: string;
  user: string;
  /** Unix seconds; omit to use the current block time via setUserJoinTimeNow. */
  timestamp?: number;
}

/**
 * Port of `pop role admin set-join-time` — src/commands/role/admin.ts.
 * Derives the method exactly as the CLI does: --timestamp →
 * setUserJoinTime(user, ts); omitted → setUserJoinTimeNow(user).
 * superAdmin-only.
 */
export async function setUserJoinTimeIntent(ctx: PopContext, params: SetJoinTimeParams): Promise<TxIntent> {
  const user = requireAddress(params.user, 'user');
  if (params.timestamp !== undefined && (!Number.isInteger(params.timestamp) || params.timestamp < 0)) {
    throw new CliError(
      `Invalid --timestamp ${params.timestamp}.`,
      EXIT.USAGE,
      'Pass unix seconds, or omit to use the current block time.'
    );
  }

  const { orgId, eligibilityModuleAddress } = await resolveEligibilityModule(ctx.client, params.org, ctx.chainId);
  return params.timestamp !== undefined
    ? buildSetUserJoinTime({ eligibilityModuleAddress, user, joinTime: params.timestamp, orgId })
    : buildSetUserJoinTimeNow({ eligibilityModuleAddress, user, orgId });
}
