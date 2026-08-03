/**
 * ParticipationToken write builders — token request / approve / cancel.
 *
 * Level 1: pure, sync builders that take resolved addresses + fully-prepared
 * values and return a TxIntent. Level 2: async `<action>Intent(ctx, params)`
 * builders that resolve the org's token address via the subgraph and pin the
 * request metadata to IPFS, then delegate to Level 1 — replicating exactly
 * what the CLI commands do before executeTx.
 *
 * Preflight (hat gates, requests(id) existence/state probes) is NOT ported:
 * those are provider-bound revert predictors that stay in the CLI
 * (src/commands/token/helpers.ts documents why they must stay on RPC).
 */

import { ethers } from 'ethers';
import type { TxIntent } from './intent';
import { getAbi } from '../contracts';
import type { PopContext } from '../context';
import { pinJson } from '../ipfs';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
import {
  buildTokenRequestMetadata,
  serializeTokenRequestMetadata,
  TokenRequestMetadata,
} from '../metadata/token';
import { resolveParticipationToken } from '../reads/token';

const UINT96_MAX = ethers.BigNumber.from(2).pow(96).sub(1);

/**
 * Parse a PT amount to 18-decimal wei, enforcing the contract's uint96 bound.
 * Port of parseRequestAmount in `pop token request` —
 * src/commands/token/request.ts (same messages and exit codes).
 */
export function parseRequestAmount(amount: number | string): ethers.BigNumber {
  let wei: ethers.BigNumber;
  try {
    wei = ethers.utils.parseUnits(String(amount), 18);
  } catch {
    throw new CliError(`Invalid --amount "${amount}".`, EXIT.USAGE, 'Pass a decimal PT amount, e.g. --amount 12.5');
  }
  if (wei.lte(0)) {
    throw new CliError('--amount must be greater than zero (the contract reverts ZeroAmount).', EXIT.USAGE);
  }
  if (wei.gt(UINT96_MAX)) {
    throw new CliError(`--amount overflows the contract's uint96 amount field.`, EXIT.USAGE, 'Request a smaller amount.');
  }
  return wei;
}

// ───────────────────────────── Level 1 — pure ─────────────────────────────

export interface RequestTokensArgs {
  participationTokenAddress: string;
  /** 18-decimal wei, bounded to uint96 (see parseRequestAmount). */
  amountWei: ethers.BigNumberish;
  /** IPFS CID of the pinned {reason, submittedAt} document — the CID STRING, not bytes32. */
  ipfsHash: string;
  orgId?: string;
}

/**
 * Port of `pop token request` — src/commands/token/request.ts.
 * ParticipationToken.requestTokens(uint96 amount, string ipfsHash): amount in
 * 18 decimals, ipfsHash as the CID string (not bytes32). isMember-gated
 * on-chain (executor or any allowed member hat); reverts ZeroAmount on a zero
 * amount or empty ipfsHash. Emits Requested(id) — parse receipt logs for the
 * request id.
 */
export function buildRequestTokens(a: RequestTokensArgs): TxIntent {
  return {
    to: a.participationTokenAddress,
    abi: getAbi('ParticipationToken'),
    method: 'requestTokens',
    args: [a.amountWei, a.ipfsHash],
    meta: {
      domain: 'token',
      action: 'request',
      orgId: a.orgId,
      summary: { amountWei: String(a.amountWei), ipfsHash: a.ipfsHash },
    },
  };
}

export interface ApproveTokenRequestArgs {
  participationTokenAddress: string;
  /** Numeric request id (`pop token requests`). */
  requestId: ethers.BigNumberish;
  orgId?: string;
}

/**
 * Port of `pop token approve` — src/commands/token/approve.ts.
 * ParticipationToken.approveRequest(uint256 id) — DESTRUCTIVE: mints the
 * requested PT straight to the requester, irreversibly. onlyApprover
 * (executor or any allowed approver hat); reverts RequestUnknown /
 * AlreadyApproved, and NotRequester when the approver IS the requester.
 */
export function buildApproveRequest(a: ApproveTokenRequestArgs): TxIntent {
  return {
    to: a.participationTokenAddress,
    abi: getAbi('ParticipationToken'),
    method: 'approveRequest',
    args: [a.requestId],
    meta: {
      domain: 'token',
      action: 'approve',
      orgId: a.orgId,
      summary: { requestId: String(a.requestId) },
    },
  };
}

/**
 * Port of `pop token cancel` — src/commands/token/cancel.ts.
 * ParticipationToken.cancelRequest(uint256 id) — callable by the REQUESTER or
 * any APPROVER; reverts RequestUnknown for missing ids, AlreadyApproved once
 * minted, NotApprover for everyone else.
 */
export function buildCancelRequest(a: ApproveTokenRequestArgs): TxIntent {
  return {
    to: a.participationTokenAddress,
    abi: getAbi('ParticipationToken'),
    method: 'cancelRequest',
    args: [a.requestId],
    meta: {
      domain: 'token',
      action: 'cancel',
      orgId: a.orgId,
      summary: { requestId: String(a.requestId) },
    },
  };
}

// ──────────────────────────── Level 2 — resolved ───────────────────────────

export interface RequestTokensParams {
  /** Org name or hex ID. */
  org: string;
  /** Decimal PT amount, e.g. 12.5 (parsed with parseRequestAmount). */
  amount: number | string;
  /** Reason pinned to IPFS as {reason, submittedAt}. */
  reason: string;
  /** Override the metadata timestamp (defaults to Date.now(), as the CLI). */
  submittedAt?: number;
}

/**
 * Resolved builder for `pop token request` — src/commands/token/request.ts.
 * Validates amount/reason with the CLI's exact errors, resolves the org's
 * ParticipationToken via the subgraph, pins {reason, submittedAt} to IPFS
 * (exact key order), then builds the requestTokens intent.
 */
export async function requestTokensIntent(
  ctx: PopContext,
  params: RequestTokensParams
): Promise<TxIntent> {
  const amountWei = parseRequestAmount(params.amount);
  if (!params.reason || !String(params.reason).trim()) {
    throw new CliError('--reason cannot be empty (the contract requires a non-empty ipfsHash).', EXIT.USAGE);
  }

  const { orgId, tokenAddress } = await resolveParticipationToken(ctx.client, params.org, ctx.chainId);

  const metadata: TokenRequestMetadata = buildTokenRequestMetadata(params.reason, params.submittedAt);
  const cid = await pinJson(serializeTokenRequestMetadata(metadata), ctx.ipfs);

  const intent = buildRequestTokens({
    participationTokenAddress: tokenAddress,
    amountWei,
    ipfsHash: cid,
    orgId,
  });
  intent.meta.ipfs = { cid, metadata };
  return intent;
}

export interface TokenRequestIdParams {
  /** Org name or hex ID. */
  org: string;
  /** Numeric request id (`pop token requests`). */
  requestId: number;
}

/** Shared id validation — same message/exit code as the approve/cancel commands. */
function requireRequestId(requestId: number): number {
  if (!Number.isInteger(requestId) || requestId <= 0) {
    throw new CliError(`Invalid --request "${requestId}".`, EXIT.USAGE, 'Pass the numeric request ID (pop token requests).');
  }
  return requestId;
}

/**
 * Resolved builder for `pop token approve` — src/commands/token/approve.ts.
 * DESTRUCTIVE: approval mints PT irreversibly to the requester. The CLI's
 * on-chain request/approver-hat preflight is not ported (revert predictors
 * stay on RPC in the CLI).
 */
export async function approveRequestIntent(
  ctx: PopContext,
  params: TokenRequestIdParams
): Promise<TxIntent> {
  const requestId = requireRequestId(params.requestId);
  const { orgId, tokenAddress } = await resolveParticipationToken(ctx.client, params.org, ctx.chainId);
  return buildApproveRequest({ participationTokenAddress: tokenAddress, requestId, orgId });
}

/**
 * Resolved builder for `pop token cancel` — src/commands/token/cancel.ts.
 * Callable by the requester or any approver; the CLI's on-chain
 * existence/not-yet-approved preflight is not ported.
 */
export async function cancelRequestIntent(
  ctx: PopContext,
  params: TokenRequestIdParams
): Promise<TxIntent> {
  const requestId = requireRequestId(params.requestId);
  const { orgId, tokenAddress } = await resolveParticipationToken(ctx.client, params.org, ctx.chainId);
  return buildCancelRequest({ participationTokenAddress: tokenAddress, requestId, orgId });
}
