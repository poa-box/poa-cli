/**
 * User write builders — UniversalAccountRegistry (registerAccount /
 * changeUsername / setProfileMetadata) and QuickJoinNew (quickJoinWithUser /
 * authority autojoin).
 *
 * Level 1: pure, sync builders taking resolved addresses + prepared values.
 * Level 2: async `<action>Intent(ctx, params)` builders that resolve the
 * registry / QuickJoin address via the subgraph, merge + pin profile
 * metadata, and delegate to Level 1.
 *
 * Chain semantics (preserved CLI behavior): usernames and profile metadata
 * are HOME-CHAIN account-registry state, so the registry-scoped Level-2
 * builders default to HOME_CHAIN_ID — deliberately IGNORING ctx.chainId (the
 * CLI ignores POP_DEFAULT_CHAIN the same way; an explicit `chainId` param
 * wins). The org-scoped QuickJoin builders use ctx.chainId as usual.
 *
 * NOT ported (CLI-side revert prediction / flow UX): checkUsernameFree,
 * AccountUnknown prediction, the live re-read of quickJoin.accountRegistry()
 * before a 2-tx join (a write-target pointer that updateAddresses can
 * re-point — see src/commands/user/join.ts).
 */

import { ethers } from 'ethers';
import type { TxIntent } from './intent';
import { getAbi } from '../contracts';
import type { PopContext } from '../context';
import { pinJson } from '../ipfs';
import { ipfsCidToBytes32 } from '../encoding';
import { requireValidUsername } from '../validation';
import { HOME_CHAIN_ID } from '../chains';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
import {
  FETCH_INFRASTRUCTURE_ADDRESSES,
  InfrastructureAddresses,
} from '../graph/documents/infrastructure';
import {
  buildUserProfileMetadata,
  serializeUserProfileMetadata,
  UserProfileMetadata,
  UserProfileUpdates,
  USER_PROFILE_FIELDS,
} from '../metadata/user';
import { resolveOrgModules, requireModule } from '../reads/resolve';
import { getRegistryAndAccount } from '../reads/user';

// ───────────────────────────── Level 1 — pure ─────────────────────────────

export interface RegisterAccountArgs {
  /** UniversalAccountRegistry address (home chain unless overridden). */
  registryAddress: string;
  /** Validated username (3-32 alphanumeric+underscore — requireValidUsername). */
  username: string;
}

/**
 * Port of `pop user register` — src/commands/user/register.ts (also tx 1 of
 * the 2-tx `pop user join` flow — src/commands/user/join.ts).
 * UniversalAccountRegistry.registerAccount(string username); reverts
 * UsernameTaken when the name is held. For the join flow, register on the
 * SAME registry the org's QuickJoin consults (quickJoin.accountRegistry(),
 * re-read live in the CLI) — registering anywhere else leaves
 * quickJoinWithUser reverting NoUsername.
 */
export function buildRegisterAccount(a: RegisterAccountArgs): TxIntent {
  return {
    to: a.registryAddress,
    abi: getAbi('UniversalAccountRegistry'),
    method: 'registerAccount',
    args: [a.username],
    meta: {
      domain: 'user',
      action: 'register',
      summary: { username: a.username, registry: a.registryAddress },
    },
  };
}

export interface ChangeUsernameArgs {
  registryAddress: string;
  /** Validated new username. */
  newUsername: string;
}

/**
 * Port of `pop user update-profile --username` —
 * src/commands/user/update-profile.ts.
 * UniversalAccountRegistry.changeUsername(string newUsername) — DESTRUCTIVE:
 * the old username is released for anyone to claim the moment the tx lands.
 * Reverts AccountUnknown without an existing registration and UsernameTaken
 * when the new name is held.
 */
export function buildChangeUsername(a: ChangeUsernameArgs): TxIntent {
  return {
    to: a.registryAddress,
    abi: getAbi('UniversalAccountRegistry'),
    method: 'changeUsername',
    args: [a.newUsername],
    meta: {
      domain: 'user',
      action: 'change-username',
      summary: { username: a.newUsername, registry: a.registryAddress },
    },
  };
}

export interface SetProfileMetadataArgs {
  registryAddress: string;
  /** bytes32 metadata hash — ipfsCidToBytes32 of the pinned profile document. */
  metadataHash: string;
}

/**
 * Port of the metadata tx of `pop user update-profile` —
 * src/commands/user/update-profile.ts.
 * UniversalAccountRegistry.setProfileMetadata(bytes32 metadataHash), where
 * metadataHash = ipfsCidToBytes32(pinJson(serialized profile document)).
 */
export function buildSetProfileMetadata(a: SetProfileMetadataArgs): TxIntent {
  return {
    to: a.registryAddress,
    abi: getAbi('UniversalAccountRegistry'),
    method: 'setProfileMetadata',
    args: [a.metadataHash],
    meta: {
      domain: 'user',
      action: 'set-profile-metadata',
      summary: { metadataHash: a.metadataHash, registry: a.registryAddress },
    },
  };
}

export interface QuickJoinWithUserArgs {
  quickJoinAddress: string;
  orgId?: string;
}

/**
 * Port of `pop user join` (the join tx) — src/commands/user/join.ts.
 * QuickJoinNew.quickJoinWithUser() — NO arguments. The contract reads
 * accountRegistry.getUsername(msg.sender) and reverts NoUsername when it is
 * empty, so the sender must already hold a username on the registry this
 * QuickJoin consults (register first via buildRegisterAccount when needed).
 */
export function buildQuickJoinWithUser(a: QuickJoinWithUserArgs): TxIntent {
  return {
    to: a.quickJoinAddress,
    abi: getAbi('QuickJoinNew'),
    method: 'quickJoinWithUser',
    args: [],
    meta: {
      domain: 'user',
      action: 'join',
      orgId: a.orgId,
      summary: {},
    },
  };
}

function requireUsernameArg(username: string): string {
  try { return requireValidUsername(username); }
  catch (err: any) { throw new CliError(err.message, EXIT.USAGE); }
}

export interface RegisterAccountParams {
  username: string;
  /** Registry chain. Defaults to HOME_CHAIN_ID (Arbitrum) — NOT ctx.chainId. */
  chainId?: number;
}

/**
 * Resolved builder for `pop user register` — src/commands/user/register.ts.
 * Validates the username, resolves the UniversalAccountRegistry address from
 * the infrastructure subgraph (universalAccountRegistries[0].id, falling back
 * to poaManagerContracts[0].globalAccountRegistryProxy), then builds the
 * registerAccount intent. Defaults to the HOME chain, deliberately ignoring
 * ctx.chainId — usernames live on the home chain (the CLI ignores
 * POP_DEFAULT_CHAIN the same way).
 */
export async function registerAccountIntent(
  ctx: PopContext,
  params: RegisterAccountParams
): Promise<TxIntent> {
  const username = requireUsernameArg(params.username);
  const chainId = params.chainId || HOME_CHAIN_ID;

  const infra = await ctx.client.query<InfrastructureAddresses>(
    FETCH_INFRASTRUCTURE_ADDRESSES,
    {},
    chainId
  );
  const registryAddr = infra.universalAccountRegistries?.[0]?.id
    || infra.poaManagerContracts?.[0]?.globalAccountRegistryProxy;
  if (!registryAddr) {
    throw new CliError(
      'Could not resolve the UniversalAccountRegistry address from the subgraph.',
      EXIT.INFRA,
      'The subgraph may be syncing — retry shortly, or pass --chain for a chain with a deployed registry.'
    );
  }

  return buildRegisterAccount({ registryAddress: registryAddr, username });
}

export interface ChangeUsernameParams {
  /** The account being renamed (the eventual tx sender). */
  address: string;
  newUsername: string;
  /** Registry chain. Defaults to HOME_CHAIN_ID — NOT ctx.chainId. */
  chainId?: number;
}

/**
 * Resolved builder for the username tx of `pop user update-profile` —
 * src/commands/user/update-profile.ts. DESTRUCTIVE: the old username is
 * released on-chain for anyone to claim. Resolves the registry from the same
 * one-round-trip document the CLI uses. The CLI's AccountUnknown /
 * UsernameTaken / no-op-rename predictions are preflight and are not ported.
 */
export async function changeUsernameIntent(
  ctx: PopContext,
  params: ChangeUsernameParams
): Promise<TxIntent> {
  const newUsername = requireUsernameArg(params.newUsername);
  const chainId = params.chainId ?? HOME_CHAIN_ID;

  const { registryAddress } = await getRegistryAndAccount(ctx.client, params.address, chainId);
  if (!registryAddress) {
    throw new CliError(
      'UniversalAccountRegistry not found on this chain.',
      EXIT.INFRA,
      'The subgraph may be syncing — retry shortly.'
    );
  }

  return buildChangeUsername({ registryAddress, newUsername });
}

export interface SetProfileMetadataParams extends UserProfileUpdates {
  /** The account whose profile is being updated (the eventual tx sender). */
  address: string;
  /** Registry chain. Defaults to HOME_CHAIN_ID — NOT ctx.chainId. */
  chainId?: number;
}

/**
 * Resolved builder for the metadata tx of `pop user update-profile` —
 * src/commands/user/update-profile.ts. Reads the existing indexed profile
 * metadata (read-then-merge, so single-field edits preserve the others),
 * builds the {bio, avatar, github, twitter, website} document with the CLI's
 * exact conditional key order, pins it to IPFS, converts the CID to bytes32,
 * and builds the setProfileMetadata intent.
 */
export async function setProfileMetadataIntent(
  ctx: PopContext,
  params: SetProfileMetadataParams
): Promise<TxIntent> {
  const updates: UserProfileUpdates = {
    bio: params.bio,
    avatar: params.avatar,
    github: params.github,
    twitter: params.twitter,
    website: params.website,
  };
  if (!USER_PROFILE_FIELDS.some(field => updates[field] !== undefined)) {
    throw new CliError(
      'Provide at least one field: --bio, --avatar, --github, --twitter, --website',
      EXIT.USAGE
    );
  }

  const chainId = params.chainId ?? HOME_CHAIN_ID;
  const { registryAddress, account } = await getRegistryAndAccount(ctx.client, params.address, chainId);
  if (!registryAddress) {
    throw new CliError(
      'UniversalAccountRegistry not found on this chain.',
      EXIT.INFRA,
      'The subgraph may be syncing — retry shortly.'
    );
  }

  // Merge over the indexed metadata exactly as the CLI does
  // (indexed.account?.metadata || {} — no authority gating on the merge read).
  const metadata: UserProfileMetadata = buildUserProfileMetadata(updates, account?.metadata ?? {});

  const cid = await pinJson(serializeUserProfileMetadata(metadata), ctx.ipfs);
  const metadataHash = ipfsCidToBytes32(cid);

  const intent = buildSetProfileMetadata({ registryAddress, metadataHash });
  intent.meta.ipfs = { cid, metadata };
  return intent;
}

export interface QuickJoinParams {
  /** Org name or hex ID. */
  org: string;
}

/**
 * Resolved builder for `pop user join` (join tx only) —
 * src/commands/user/join.ts. Resolves the org's QuickJoin via the subgraph
 * and builds the quickJoinWithUser intent. The 1-tx vs 2-tx decision (does
 * the sender already hold a username on the registry this QuickJoin
 * consults?) is host orchestration: read state with
 * reads/user.getQuickJoinAccount, re-verify the registry pointer LIVE
 * (quickJoin.accountRegistry() — it is a write target updateAddresses can
 * re-point), and when registration is needed send buildRegisterAccount
 * against THAT registry first.
 */
export async function quickJoinWithUserIntent(
  ctx: PopContext,
  params: QuickJoinParams
): Promise<TxIntent> {
  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const quickJoinAddress = requireModule(modules, 'quickJoinAddress');
  return buildQuickJoinWithUser({ quickJoinAddress, orgId: modules.orgId });
}
