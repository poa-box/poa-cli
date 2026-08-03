/**
 * Org write builders.
 *
 * Ports:
 *   - `pop org deploy`             — src/commands/org/deploy.ts
 *   - `pop org update-metadata`    — src/commands/org/update-metadata.ts
 *   - `pop org set-metadata-admin` — src/commands/org/set-metadata-admin.ts
 *
 * Level-1 builders are pure (sync, zero I/O) and own ALL argument encoding.
 * Level-2 `<action>Intent(ctx, params)` builders resolve addresses via the
 * subgraph, pin metadata to IPFS, and delegate to Level 1.
 */

import { ethers } from 'ethers';
import type { TxIntent } from './intent';
import type { PopContext } from '../context';
import { getAbi, createReadContract } from '../contracts';
import { stringToBytes, ipfsCidToBytes32 } from '../encoding';
import { pinJson, pinFile, fetchJson } from '../ipfs';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
import { resolveOrgId, resolveOrgModules } from '../reads/resolve';
import { FETCH_INFRASTRUCTURE_ADDRESSES } from '../graph/documents/infrastructure';
import type { InfrastructureAddresses } from '../graph/documents/infrastructure';
import { FETCH_ORG_FULL_DATA } from '../graph/documents/org';
import {
  buildOrgDeployMetadata,
  mergeOrgMetadata,
  serializeOrgMetadata,
} from '../metadata/org';
import type { OrgLink, OrgMetadataUpdates } from '../metadata/org';
import { buildProposalMetadata, serializeProposalMetadata } from '../metadata/proposal';
import { buildGovernanceProposal } from './governance';

// ---------------------------------------------------------------------------
// Shared infra resolution
// ---------------------------------------------------------------------------

/**
 * OrgRegistry proxy address — global infrastructure, not an org module.
 * Same lookup + error as `pop org update-metadata` / `pop org set-metadata-admin`.
 */
async function resolveOrgRegistryAddress(ctx: PopContext): Promise<string> {
  const infra = await ctx.client.query<InfrastructureAddresses>(
    FETCH_INFRASTRUCTURE_ADDRESSES,
    {},
    ctx.chainId
  );
  const orgRegistryAddr = infra.poaManagerContracts?.[0]?.orgRegistryProxy;
  if (!orgRegistryAddr) {
    throw new CliError('Could not resolve OrgRegistry address from subgraph', EXIT.INFRA);
  }
  return orgRegistryAddr;
}

// ---------------------------------------------------------------------------
// pop org deploy — config schema + pure param assembly
// ---------------------------------------------------------------------------

/**
 * Org deploy config schema (port of the config-file schema in
 * src/commands/org/deploy.ts). Matches the DeploymentParams struct expected
 * by OrgDeployer.deployFullOrg().
 */
export interface OrgDeployConfig {
  orgName: string;
  deployerUsername?: string;
  description?: string;
  links?: OrgLink[];
  autoUpgrade?: boolean;
  hybridVoting: {
    thresholdPct: number;
    classes: Array<{
      strategy: 'DIRECT' | 'ERC20_BAL';
      slicePct: number;
      quadratic?: boolean;
      minBalance?: string;
      asset?: string;
      hatIds?: number[];
    }>;
  };
  directDemocracy: {
    thresholdPct: number;
  };
  roles: Array<{
    name: string;
    image?: string;
    canVote: boolean;
    vouching?: {
      enabled: boolean;
      quorum: number;
      voucherRoleIndex: number;
      combineWithHierarchy?: boolean;
    };
    defaults?: {
      eligible: boolean;
      standing: boolean;
    };
    hierarchy?: {
      adminRoleIndex: number;
    };
    distribution?: {
      mintToDeployer: boolean;
      additionalWearers?: string[];
    };
    hatConfig?: {
      maxSupply: number;
      mutableHat: boolean;
    };
  }>;
  roleAssignments: {
    quickJoinRoles: number[];
    tokenMemberRoles: number[];
    tokenApproverRoles: number[];
    taskCreatorRoles: number[];
    educationCreatorRoles?: number[];
    educationMemberRoles?: number[];
    hybridProposalCreatorRoles: number[];
    ddVotingRoles: number[];
    ddCreatorRoles: number[];
  };
  metadataAdminRoleIndex?: number;
  educationHub?: { enabled: boolean };
  paymaster?: {
    operatorRoleIndex: number;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    defaultBudgetCapPerEpoch: string;
    defaultBudgetEpochLen: number;
    funding?: string;
  };
  /**
   * Optional org-wide TaskManager ROLE_PERM grants applied at deploy time
   * (OrgDeployer.TaskManagerPermConfig — roleIndices resolve to hat IDs,
   * masks are TaskPerm bitmasks: 1=create 2=claim 4=review 8=assign …).
   */
  taskManagerPerms?: {
    roleIndices: number[];
    masks: number[];
  };
}

/** Port of indicesToBitmap in src/commands/org/deploy.ts. */
export function indicesToBitmap(indices: number[]): ethers.BigNumber {
  let bitmap = ethers.BigNumber.from(0);
  for (const i of indices) {
    bitmap = bitmap.or(ethers.BigNumber.from(1).shl(i));
  }
  return bitmap;
}

/**
 * Reject role indices that do not name a role in the config.
 *
 * RoleResolver reverts UnregisteredRole(roleIdx) when a bitmap bit has no registered hat
 * (audit M-09) — previously hat 0 was silently stored as an "authorized" hat and the deploy
 * succeeded with a broken allowlist. Either way the config is wrong, and we know roles.length
 * here, so name the offending field instead of surfacing a bare index from gas estimation
 * (older deployers) or an aborted deploy (upgraded ones).
 */
export function assertRoleIndices(
  field: string,
  indices: number[] | undefined,
  roleCount: number
): void {
  for (const i of indices ?? []) {
    if (!Number.isInteger(i) || i < 0 || i >= roleCount) {
      throw new CliError(
        `${field} references role index ${i}, but the config defines ${roleCount} role(s) (valid: 0-${roleCount - 1}).`,
        EXIT.USAGE,
        'Role indices are positions in the config\'s `roles` array — renumber them after adding '
          + 'or removing a role.'
      );
    }
  }
}

/**
 * Derive the deterministic orgId + normalized name the deployer uses:
 * orgId = keccak256(orgName.toLowerCase().replace(/\s+/g, '-')).
 * The normalized name is also the default deployer username.
 */
export function deriveOrgId(orgName: string): { orgId: string; normalizedName: string } {
  const normalizedName = orgName.toLowerCase().replace(/\s+/g, '-');
  return {
    orgId: ethers.utils.keccak256(ethers.utils.toUtf8Bytes(normalizedName)),
    normalizedName,
  };
}

// ---------------------------------------------------------------------------
// pop org deploy — EIP-712 RegisterAccount signature helper
// ---------------------------------------------------------------------------

/**
 * Minimal structural type for an ethers v5 signer that can sign EIP-712
 * typed data (Wallet and JsonRpcSigner both satisfy it).
 */
export interface RegisterAccountSigner {
  _signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>
  ): Promise<string>;
}

/** EIP-712 type set for UniversalAccountRegistry registration. */
export const REGISTER_ACCOUNT_TYPES = {
  RegisterAccount: [
    { name: 'user', type: 'address' },
    { name: 'username', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/** EIP-712 domain for UniversalAccountRegistry registration. */
export function registerAccountDomain(chainId: number, registryAddress: string) {
  return {
    name: 'UniversalAccountRegistry',
    version: '1',
    chainId,
    verifyingContract: registryAddress,
  };
}

export interface RegisterAccountMessage {
  registryAddress: string;
  chainId: number;
  user: string;
  username: string;
  nonce: ethers.BigNumberish;
  deadline: number;
}

/**
 * Port of the EIP-712 RegisterAccount signature step in `pop org deploy`
 * (src/commands/org/deploy.ts): registration happens INSIDE deployFullOrg via
 * this signature — it is not a separate tx. Kept as a separate function taking
 * a Signer so hosts control key custody; everything else here is pure data.
 */
export async function signRegisterAccount(
  signer: RegisterAccountSigner,
  params: RegisterAccountMessage
): Promise<string> {
  const domain = registerAccountDomain(params.chainId, params.registryAddress);
  const message = {
    user: params.user,
    username: params.username,
    nonce: ethers.BigNumber.from(params.nonce).toString(),
    deadline: params.deadline,
  };
  return signer._signTypedData(domain, REGISTER_ACCOUNT_TYPES as any, message);
}

// ---------------------------------------------------------------------------
// pop org deploy — Level 1
// ---------------------------------------------------------------------------

/** Resolved inputs the pure param assembly needs beyond the config file. */
export interface DeploymentResolvedInputs {
  /** keccak256 of the lowercased-dashed org name (see deriveOrgId). */
  orgId: string;
  /** bytes32 of the pinned org metadata CID. */
  metadataHash: string;
  /** UniversalAccountRegistry proxy (globalAccountRegistryProxy). */
  registryAddr: string;
  deployerAddress: string;
  deployerUsername: string;
  /** unix seconds; the CLI uses now + 900 (nonce-bound, so not replayable). */
  regDeadline: number;
  /** UniversalAccountRegistry.nonces(deployerAddress). */
  regNonce: ethers.BigNumberish;
  /** EIP-712 RegisterAccount signature (signRegisterAccount). */
  regSignature: string;
}

/** Recommended gasLimit for deployFullOrg — the CLI always sends 15,000,000. */
export const DEPLOY_FULL_ORG_GAS_LIMIT = 15000000;

/**
 * Pure assembly of the DeploymentParams struct — port of the param build in
 * `pop org deploy` (src/commands/org/deploy.ts:257-403), byte-for-byte the
 * same encoding. Validates taskManagerPerms lengths and every roleAssignments
 * index exactly like the CLI (both gate the broadcast).
 *
 * ABI field order (verified against src/abi/OrgDeployerNew.json +
 * contracts origin/main src/OrgDeployer.sol DeploymentParams):
 *   orgId, orgName, metadataHash, registryAddr, deployerAddress,
 *   deployerUsername, regDeadline, regNonce, regSignature, autoUpgrade,
 *   hybridThresholdPct, ddThresholdPct, hybridClasses, ddInitialTargets,
 *   roles, roleAssignments, metadataAdminRoleIndex, passkeyEnabled,
 *   educationHubConfig, bootstrap, paymasterConfig, taskManagerPerms
 */
export function buildDeploymentParams(
  config: OrgDeployConfig,
  resolved: DeploymentResolvedInputs
): unknown[] {
  // Build hybrid voting classes
  // ABI: strategy(uint8), slicePct(uint8), quadratic(bool), minBalance(uint256), asset(address), hatIds(uint256[])
  const hybridClasses = config.hybridVoting.classes.map((c) => [
    c.strategy === 'DIRECT' ? 0 : 1,       // uint8
    c.slicePct,                              // uint8 (0-100)
    c.quadratic || false,                    // bool
    c.minBalance ? ethers.utils.parseUnits(c.minBalance, 18) : 0, // uint256
    c.asset || ethers.constants.AddressZero, // address
    c.hatIds || [],                          // uint256[]
  ]);

  // Build role configs
  // ABI: name(string), image(string), metadataCID(bytes32), canVote(bool),
  //      vouching(tuple), defaults(tuple), hierarchy(tuple), distribution(tuple), hatConfig(tuple)
  const MAX_UINT32 = 4294967295; // 2^32 - 1
  const roles = config.roles.map((r) => [
    r.name,                                  // string
    r.image || '',                           // string
    ethers.constants.HashZero,               // bytes32 metadataCID
    r.canVote,                               // bool
    [ // vouching: enabled(bool), quorum(uint32), voucherRoleIndex(uint256), combineWithHierarchy(bool)
      r.vouching?.enabled || false,
      r.vouching?.quorum || 0,
      r.vouching?.voucherRoleIndex ?? ethers.constants.MaxUint256,
      r.vouching?.combineWithHierarchy || false,
    ],
    [ // defaults: eligible(bool), standing(bool)
      r.defaults?.eligible ?? true,
      r.defaults?.standing ?? true,
    ],
    [ // hierarchy: adminRoleIndex(uint256)
      r.hierarchy?.adminRoleIndex ?? ethers.constants.MaxUint256,
    ],
    [ // distribution: mintToDeployer(bool), additionalWearers(address[])
      r.distribution?.mintToDeployer ?? true,
      r.distribution?.additionalWearers || [],
    ],
    [ // hatConfig: maxSupply(uint32), mutableHat(bool)
      r.hatConfig?.maxSupply ?? MAX_UINT32,  // uint32, NOT uint256
      r.hatConfig?.mutableHat ?? true,
    ],
  ]);

  // Build role assignment bitmaps
  const ra = config.roleAssignments;

  // Every index must name a real role BEFORE anything is broadcast — a stale index is
  // trivially produced by editing `roles` without renumbering `roleAssignments`.
  const roleCount = config.roles.length;
  assertRoleIndices('roleAssignments.quickJoinRoles', ra.quickJoinRoles, roleCount);
  assertRoleIndices('roleAssignments.tokenMemberRoles', ra.tokenMemberRoles, roleCount);
  assertRoleIndices('roleAssignments.tokenApproverRoles', ra.tokenApproverRoles, roleCount);
  assertRoleIndices('roleAssignments.taskCreatorRoles', ra.taskCreatorRoles, roleCount);
  assertRoleIndices('roleAssignments.educationCreatorRoles', ra.educationCreatorRoles, roleCount);
  assertRoleIndices('roleAssignments.educationMemberRoles', ra.educationMemberRoles, roleCount);
  assertRoleIndices('roleAssignments.hybridProposalCreatorRoles', ra.hybridProposalCreatorRoles, roleCount);
  assertRoleIndices('roleAssignments.ddVotingRoles', ra.ddVotingRoles, roleCount);
  assertRoleIndices('roleAssignments.ddCreatorRoles', ra.ddCreatorRoles, roleCount);

  const roleAssignments = [
    indicesToBitmap(ra.quickJoinRoles),
    indicesToBitmap(ra.tokenMemberRoles),
    indicesToBitmap(ra.tokenApproverRoles),
    indicesToBitmap(ra.taskCreatorRoles),
    indicesToBitmap(ra.educationCreatorRoles || []),
    indicesToBitmap(ra.educationMemberRoles || []),
    indicesToBitmap(ra.hybridProposalCreatorRoles),
    indicesToBitmap(ra.ddVotingRoles),
    indicesToBitmap(ra.ddCreatorRoles),
  ];

  // Build paymaster config
  // ABI: operatorRoleIndex(uint256), autoWhitelistContracts(bool),
  //      maxFeePerGas(uint256), maxPriorityFeePerGas(uint256),
  //      maxCallGas(uint32), maxVerificationGas(uint32), maxPreVerificationGas(uint32),
  //      defaultBudgetCapPerEpoch(uint128), defaultBudgetEpochLen(uint32)
  const pm = config.paymaster;
  const paymasterConfig = pm ? [
    pm.operatorRoleIndex,                                    // uint256
    true,                                                    // bool
    ethers.utils.parseUnits(pm.maxFeePerGas, 'gwei'),       // uint256
    ethers.utils.parseUnits(pm.maxPriorityFeePerGas, 'gwei'), // uint256
    500000,                                                  // uint32 maxCallGas
    500000,                                                  // uint32 maxVerificationGas
    100000,                                                  // uint32 maxPreVerificationGas
    ethers.utils.parseEther(pm.defaultBudgetCapPerEpoch),   // uint128
    pm.defaultBudgetEpochLen,                                // uint32
  ] : [
    ethers.constants.MaxUint256, // operatorRoleIndex = MaxUint256 disables paymaster
    false,                       // autoWhitelistContracts
    0,                           // maxFeePerGas
    0,                           // maxPriorityFeePerGas
    0,                           // maxCallGas
    0,                           // maxVerificationGas
    0,                           // maxPreVerificationGas
    0,                           // defaultBudgetCapPerEpoch
    0,                           // defaultBudgetEpochLen
  ];

  // Optional org-wide TaskManager ROLE_PERM grants
  // (OrgDeployer.TaskManagerPermConfig: roleIndices[] + masks[] — empty
  // arrays skip the bootstrapGlobalPerms step entirely; verified against
  // contracts origin/main src/OrgDeployer.sol).
  const tmPerms = config.taskManagerPerms;
  if (tmPerms && (tmPerms.roleIndices?.length || 0) !== (tmPerms.masks?.length || 0)) {
    throw new CliError(
      'Config invalid: taskManagerPerms.roleIndices and taskManagerPerms.masks must be the same length.',
      EXIT.USAGE
    );
  }
  const taskManagerPerms = [
    tmPerms?.roleIndices || [], // uint256[] roleIndices
    tmPerms?.masks || [],       // uint8[] masks
  ];

  return [
    resolved.orgId,                                          // bytes32
    config.orgName,                                          // string
    resolved.metadataHash,                                   // bytes32
    resolved.registryAddr,                                   // address
    resolved.deployerAddress,                                // address deployerAddress
    resolved.deployerUsername,                               // string deployerUsername
    resolved.regDeadline,                                    // uint256
    resolved.regNonce,                                       // uint256
    resolved.regSignature,                                   // bytes
    config.autoUpgrade ?? true,                              // bool
    config.hybridVoting.thresholdPct,                        // uint8
    config.directDemocracy?.thresholdPct || 51,              // uint8
    hybridClasses,                                           // ClassConfig[]
    [],                                                      // address[] ddInitialTargets
    roles,                                                   // RoleConfig[]
    roleAssignments,                                         // RoleAssignments struct
    config.metadataAdminRoleIndex ?? ethers.constants.MaxUint256, // uint256
    true,                                                    // bool passkeyEnabled
    [config.educationHub?.enabled ?? true],                  // EducationHubConfig struct
    [[], []],                                                // BootstrapConfig struct (projects, tasks)
    paymasterConfig,                                         // PaymasterConfig struct
    taskManagerPerms,                                        // TaskManagerPermConfig struct (roleIndices, masks)
  ];
}

export interface DeployFullOrgArgs {
  /** OrgDeployer proxy (orgDeployerProxy from infrastructure). */
  orgDeployerAddress: string;
  /** Assembled DeploymentParams struct (buildDeploymentParams). */
  deployParams: unknown[];
  /** Optional paymaster funding ETH (parseEther of paymaster.funding). */
  value?: ethers.BigNumberish;
  orgId?: string;
  orgName?: string;
}

/**
 * Port of `pop org deploy` — src/commands/org/deploy.ts.
 * OrgDeployer.deployFullOrg([DeploymentParams]) — the single on-chain write,
 * which internally deploys every org module (registration happens inside it
 * via the EIP-712 signature carried in the params).
 *
 * NOTE: the CLI always sends this with gasLimit 15,000,000
 * (DEPLOY_FULL_ORG_GAS_LIMIT) — pass it in the executor's options; TxIntent
 * carries no gas policy.
 */
export function buildDeployFullOrg(a: DeployFullOrgArgs): TxIntent {
  return {
    to: a.orgDeployerAddress,
    abi: getAbi('OrgDeployerNew'),
    method: 'deployFullOrg',
    args: [a.deployParams],
    value: a.value,
    meta: {
      domain: 'org',
      action: 'deploy',
      orgId: a.orgId,
      summary: {
        orgId: a.orgId,
        orgName: a.orgName,
        gasLimit: DEPLOY_FULL_ORG_GAS_LIMIT,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// pop org deploy — Level 2
// ---------------------------------------------------------------------------

export interface DeployFullOrgParams {
  config: OrgDeployConfig;
  /** The deployer wallet address (registered inside deployFullOrg). */
  deployerAddress: string;
  /** Signs the EIP-712 RegisterAccount message; key custody stays host-side. */
  signer: RegisterAccountSigner;
  /**
   * Registration-signature validity in unix seconds. Default now + 900 like
   * the CLI (must survive an interactive confirmation prompt; nonce-bound, so
   * a longer window is not replayable).
   */
  regDeadline?: number;
}

/**
 * Resolved builder for `pop org deploy` — src/commands/org/deploy.ts.
 *
 * Performs the CLI's pre-steps in the same order: config validation,
 * infrastructure address resolution (orgDeployerProxy +
 * globalAccountRegistryProxy), org metadata pin, on-chain
 * UniversalAccountRegistry.nonces() read (requires ctx.provider), and the
 * EIP-712 RegisterAccount signature — then delegates to buildDeployFullOrg.
 */
export async function deployFullOrgIntent(
  ctx: PopContext,
  params: DeployFullOrgParams
): Promise<TxIntent> {
  const config = params.config;

  // ── Fail fast on config problems before any network work ───────────
  if (!config.orgName) throw new CliError('Config missing: orgName', EXIT.USAGE);
  if (!config.roles?.length) throw new CliError('Config missing: roles', EXIT.USAGE);
  if (!config.hybridVoting) throw new CliError('Config missing: hybridVoting', EXIT.USAGE);
  if (!ctx.provider) {
    throw new CliError('deployFullOrgIntent requires ctx.provider (UniversalAccountRegistry.nonces read)', EXIT.USAGE);
  }
  if (ctx.chainId === undefined) {
    throw new CliError('deployFullOrgIntent requires ctx.chainId (EIP-712 domain)', EXIT.USAGE);
  }

  // Resolve infrastructure addresses
  const infra = await ctx.client.query<InfrastructureAddresses>(
    FETCH_INFRASTRUCTURE_ADDRESSES,
    {},
    ctx.chainId
  );
  const orgDeployerAddr = infra.poaManagerContracts?.[0]?.orgDeployerProxy;
  const registryAddr = infra.poaManagerContracts?.[0]?.globalAccountRegistryProxy;
  if (!orgDeployerAddr) throw new CliError('Could not resolve OrgDeployer address', EXIT.INFRA);
  if (!registryAddr) throw new CliError('Could not resolve UniversalAccountRegistry address', EXIT.INFRA);

  // Generate orgId: keccak256(orgName.toLowerCase().replace(/\s+/g, '-'))
  const { orgId, normalizedName } = deriveOrgId(config.orgName);
  const deployerUsername = config.deployerUsername || normalizedName;

  // Upload org metadata to IPFS
  const metadata = buildOrgDeployMetadata({
    description: config.description,
    links: config.links,
  });
  const metaCid = await pinJson(serializeOrgMetadata(metadata), ctx.ipfs);
  const metadataHash = ipfsCidToBytes32(metaCid);

  // Get registration nonce for deployer
  const registryContract = createReadContract(registryAddr, 'UniversalAccountRegistry', ctx.provider);
  const regNonce: ethers.BigNumber = await registryContract.nonces(params.deployerAddress);
  // 15 min validity by default — see DeployFullOrgParams.regDeadline.
  const regDeadline = params.regDeadline ?? Math.floor(Date.now() / 1000) + 900;

  // Sign EIP-712 registration message
  const regSignature = await signRegisterAccount(params.signer, {
    registryAddress: registryAddr,
    chainId: ctx.chainId,
    user: params.deployerAddress,
    username: deployerUsername,
    nonce: regNonce,
    deadline: regDeadline,
  });

  const deployParams = buildDeploymentParams(config, {
    orgId,
    metadataHash,
    registryAddr,
    deployerAddress: params.deployerAddress,
    deployerUsername,
    regDeadline,
    regNonce,
    regSignature,
  });

  const txValue = config.paymaster?.funding
    ? ethers.utils.parseEther(config.paymaster.funding)
    : undefined;

  const intent = buildDeployFullOrg({
    orgDeployerAddress: orgDeployerAddr,
    deployParams,
    value: txValue,
    orgId,
    orgName: config.orgName,
  });
  intent.meta.ipfs = { cid: metaCid, metadata };
  return intent;
}

// ---------------------------------------------------------------------------
// pop org update-metadata — Level 1
// ---------------------------------------------------------------------------

export interface UpdateOrgMetaArgs {
  /** OrgRegistry proxy (global infrastructure, not an org module). */
  orgRegistryAddress: string;
  orgId: string;
  /** Full replacement org name (the write overwrites name + metadata). */
  name: string;
  /** bytes32 of the pinned metadata CID. */
  metadataHash: string;
}

/**
 * Port of `pop org update-metadata` — src/commands/org/update-metadata.ts.
 * OrgRegistry.updateOrgMetaAsAdmin(orgId, stringToBytes(name), metadataHash).
 * Caller must wear the org's metadata-admin hat (topHat fallback) — revert
 * NotOrgMetadataAdmin otherwise. FULL OVERWRITE of name + metadata hash.
 */
export function buildUpdateOrgMetaAsAdmin(a: UpdateOrgMetaArgs): TxIntent {
  return {
    to: a.orgRegistryAddress,
    abi: getAbi('OrgRegistry'),
    method: 'updateOrgMetaAsAdmin',
    args: [a.orgId, stringToBytes(a.name), a.metadataHash],
    meta: {
      domain: 'org',
      action: 'update-metadata',
      orgId: a.orgId,
      summary: { name: a.name, metadataHash: a.metadataHash },
    },
  };
}

// ---------------------------------------------------------------------------
// pop org update-metadata — Level 2
// ---------------------------------------------------------------------------

export interface UpdateOrgMetaParams extends OrgMetadataUpdates {
  /** Org name or 0x id. */
  org: string;
  /** New org name; omitted keeps the current name (full-overwrite write). */
  name?: string;
  /** Raw logo bytes to pin (replaces the CLI's fs.readFileSync path). */
  logo?: Uint8Array;
}

/**
 * Resolved builder for `pop org update-metadata` — src/commands/org/update-metadata.ts.
 *
 * Merge base is the RAW IPFS doc (fetchJson of the current metadataHash),
 * spread FIRST so unknown keys (e.g. zkEmailAllowlist) and frontend key order
 * survive; refuses (INFRA) when IPFS is unreachable but the subgraph shows
 * metadata exists — proceeding would drop any key the CLI does not model.
 */
export async function updateOrgMetaIntent(
  ctx: PopContext,
  params: UpdateOrgMetaParams
): Promise<TxIntent> {
  if (!params.name && !params.description && !params.logo && !params.logoCid && !params.links
    && params.backgroundColor === undefined && params.hideTreasury === undefined) {
    throw new CliError(
      'At least one metadata field must be provided.',
      EXIT.USAGE,
      'Available: --name, --description, --logo, --links, --background-color, --hide-treasury'
    );
  }

  const orgId = await resolveOrgId(ctx.client, params.org, ctx.chainId);

  // Resolve OrgRegistry address (global infrastructure, not an org module)
  const orgRegistryAddr = await resolveOrgRegistryAddress(ctx);

  // Fetch existing metadata to preserve fields not being updated.
  const existing = await ctx.client.query<{ organization: any }>(
    FETCH_ORG_FULL_DATA,
    { orgId },
    ctx.chainId
  );
  if (!existing.organization) {
    throw new CliError(
      `Organization ${orgId} is not indexed on this chain.`,
      EXIT.INFRA,
      'This write overwrites the org name and metadata wholesale; refusing to send it against '
        + 'an unknown org would otherwise blank both. Check --chain, or retry once indexed.'
    );
  }
  const subgraphMeta = existing.organization.metadata || {};
  const currentName = existing.organization.name || '';
  const currentMetadataHash = existing.organization.metadataHash;

  // The RAW IPFS doc — not the subgraph's typed projection — is the merge base
  // (see mergeOrgMetadata for why).
  let rawMeta: any = null;
  if (currentMetadataHash && currentMetadataHash !== ethers.constants.HashZero) {
    try {
      rawMeta = await fetchJson<any>(currentMetadataHash, ctx.ipfs);
    } catch { /* handled below */ }
  }
  if (!rawMeta && Object.keys(subgraphMeta).length > 0) {
    throw new CliError(
      'Could not fetch the org\'s current metadata from IPFS, so unknown fields cannot be preserved.',
      EXIT.INFRA,
      'This write is a full overwrite — proceeding would drop any metadata key the CLI does not '
        + 'model. Retry once IPFS responds.'
    );
  }
  const currentMeta: any = rawMeta ?? subgraphMeta;

  // Upload logo to IPFS if provided
  let logoCid: string | null = params.logoCid ?? null;
  if (params.logo) {
    logoCid = await pinFile(params.logo, ctx.ipfs);
  }

  const metadata = mergeOrgMetadata(currentMeta, {
    description: params.description,
    links: params.links,
    logoCid,
    backgroundColor: params.backgroundColor,
    hideTreasury: params.hideTreasury,
  });

  // If name not provided, keep the current name (full-overwrite write).
  const nameToSend = params.name || currentName;

  const metaCid = await pinJson(serializeOrgMetadata(metadata), ctx.ipfs);
  const metadataHash = ipfsCidToBytes32(metaCid);

  const intent = buildUpdateOrgMetaAsAdmin({
    orgRegistryAddress: orgRegistryAddr,
    orgId,
    name: nameToSend,
    metadataHash,
  });
  intent.meta.ipfs = { cid: metaCid, metadata };
  if (logoCid) (intent.meta.summary as Record<string, unknown>).logoCid = logoCid;
  return intent;
}

// ---------------------------------------------------------------------------
// pop org set-metadata-admin — Level 1 (governance wrap)
// ---------------------------------------------------------------------------

export interface SetMetadataAdminProposalArgs {
  /** Org HybridVoting module (the proposal target). */
  hybridVotingAddress: string;
  /** OrgRegistry proxy (the option-0 execution target). */
  orgRegistryAddress: string;
  orgId: string;
  /** New metadata-admin hat; 0 clears the override (topHat fallback). */
  hatId: ethers.BigNumberish;
  durationMinutes: ethers.BigNumberish;
  /** Proposal title; default matches the CLI. */
  title?: string;
  /** bytes32 of the pinned proposal metadata CID. */
  descriptionHash: string;
}

/** The exact proposal title `pop org set-metadata-admin` uses. */
export function setMetadataAdminTitle(hatId: ethers.BigNumberish): string {
  return `Set org metadata-admin hat to ${ethers.BigNumber.from(hatId).toString()}`;
}

/**
 * Port of `pop org set-metadata-admin` — src/commands/org/set-metadata-admin.ts.
 *
 * setOrgMetadataAdminHat(bytes32 orgId, uint256 hatId) is executor-only after
 * bootstrap (revert NotOrgExecutor), so it ships as a HybridVoting proposal
 * whose option-0 execution batch calls the OrgRegistry via the executor.
 * Option 1 is "keep current" (empty batch). hatId 0 is meaningful: it clears
 * the override so updateOrgMetaAsAdmin falls back to the org topHat.
 */
export function buildSetMetadataAdminProposal(a: SetMetadataAdminProposalArgs): TxIntent {
  const hatId = ethers.BigNumber.from(a.hatId);
  // Same inline fragment the CLI encodes with — identical selector + calldata
  // to the full OrgRegistry ABI.
  const registryIface = new ethers.utils.Interface([
    'function setOrgMetadataAdminHat(bytes32 orgId, uint256 hatId)',
  ]);
  const setHatCall = registryIface.encodeFunctionData('setOrgMetadataAdminHat', [a.orgId, hatId]);

  return buildGovernanceProposal({
    votingAddress: a.hybridVotingAddress,
    votingAbiName: 'HybridVotingNew',
    title: a.title ?? setMetadataAdminTitle(hatId),
    descriptionHash: a.descriptionHash,
    durationMinutes: a.durationMinutes,
    numOptions: 2,
    batches: [
      [{ target: a.orgRegistryAddress, value: ethers.BigNumber.from(0), calldata: setHatCall }], // option 0: apply
      [], // option 1: keep current
    ],
    hatIds: [],
    orgId: a.orgId,
    domain: 'org',
    action: 'set-metadata-admin',
    summary: { hatId: hatId.toString(), orgRegistry: a.orgRegistryAddress },
  });
}

// ---------------------------------------------------------------------------
// pop org set-metadata-admin — Level 2
// ---------------------------------------------------------------------------

export interface SetMetadataAdminParams {
  /** Org name or 0x id. */
  org: string;
  /** New metadata-admin hat (decimal/hex); 0 = clear (topHat fallback). */
  hatId: ethers.BigNumberish;
  /** Vote duration in minutes — CLI default 60. */
  durationMinutes?: number;
}

/**
 * Resolved builder for `pop org set-metadata-admin` — src/commands/org/set-metadata-admin.ts.
 * Resolves the org's HybridVoting module + the global OrgRegistry, pins the
 * proposal metadata ({description, optionNames, createdAt} — key order is
 * load-bearing), and delegates to buildSetMetadataAdminProposal.
 */
export async function setMetadataAdminIntent(
  ctx: PopContext,
  params: SetMetadataAdminParams
): Promise<TxIntent> {
  const hatId = ethers.BigNumber.from(params.hatId);
  const durationMinutes = params.durationMinutes ?? 60;

  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const hybridVotingAddress = modules.hybridVotingAddress;
  if (!hybridVotingAddress) {
    throw new CliError('HybridVoting not deployed for this org — cannot create a governance proposal.', EXIT.PRECONDITION);
  }

  // OrgRegistry is global infrastructure (not an org module).
  const orgRegistryAddr = await resolveOrgRegistryAddress(ctx);

  const hatLabel = hatId.isZero() ? '0 (clear — topHat fallback)' : hatId.toString();
  const title = setMetadataAdminTitle(hatId);
  // Proposal metadata — key order (description, optionNames, createdAt) is a
  // protocol contract (metadata/proposal.ts); text matches the CLI exactly.
  const metadata = buildProposalMetadata({
    description: `Set the org's metadata-admin hat to ${hatLabel} via OrgRegistry.setOrgMetadataAdminHat. Wearers of this hat can update the org name/metadata directly (pop org update-metadata) without a vote.${hatId.isZero() ? ' A value of 0 clears the override so the org topHat is required instead.' : ''}`,
    optionNames: [title, 'Keep current metadata admin'],
  });

  const cid = await pinJson(serializeProposalMetadata(metadata), ctx.ipfs);
  const descriptionHash = ipfsCidToBytes32(cid);

  const intent = buildSetMetadataAdminProposal({
    hybridVotingAddress,
    orgRegistryAddress: orgRegistryAddr,
    orgId: modules.orgId,
    hatId,
    durationMinutes,
    title,
    descriptionHash,
  });
  intent.meta.ipfs = { cid, metadata };
  return intent;
}
