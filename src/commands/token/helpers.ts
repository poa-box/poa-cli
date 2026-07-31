/**
 * Token helpers — ParticipationToken resolution + hat-gate pre-flight.
 *
 * Gates — VERIFIED against contracts origin/main src/ParticipationToken.sol:
 *   requestTokens  → isMember     (executor OR any allowed member hat)
 *   approveRequest → onlyApprover (executor OR any allowed approver hat),
 *                    and reverts NotRequester when approver == requester
 *   cancelRequest  → requester OR approver
 *
 * The allowed hat sets are enumerable on-chain via memberHatIds() /
 * approverHatIds(), and the Hats contract via hats() — so membership is
 * "resolvable" whenever those reads succeed. Multi-hat gates are ANY-OF,
 * which checkHasHat (single hat, all-must-pass) can't express; hence
 * checkWearsAnyHat below (single-hat sets still route through checkHasHat).
 *
 * WHY THIS FILE STAYS ON RPC (subgraph audit, verified against the live
 * poa-gnosis-v-1 deployment):
 *   - ParticipationTokenContract.executor and .hatsContract EXIST in the
 *     schema but are the zero address on all 9 live rows, so they cannot
 *     replace pt.executor()/pt.hats() — a zero executor would make every
 *     signer look like a non-executor and a zero Hats address would make the
 *     hat check read from nothing.
 *   - memberHatIds()/approverHatIds() are not indexed at ALL on
 *     ParticipationTokenContract (contrast QuickJoinContract.memberHatIds,
 *     which is), so the allowed hat sets have no subgraph representation.
 *   - The hat balance reads and requests(id) are revert PREDICTORS run
 *     immediately before approveRequest/cancelRequest/requestTokens. Subgraph
 *     lag there means knowingly broadcasting a doomed transaction.
 * What did change: every one of these reads now goes through Multicall3, so
 * the gate config is 1 round-trip instead of 4 and the ANY-OF hat check is 1
 * instead of N.
 */

import { ethers } from 'ethers';
import { resolveOrgModules, requireModule } from '../../lib/resolve';
import { createReadContract } from '../../lib/contracts';
import { tryAggregate } from '../../lib/multicall';
import { checkHasHat, PreflightCheck } from '../../lib/preflight';

export async function resolveTokenAddress(orgIdOrName: string | undefined, chainId?: number): Promise<{ orgId: string; tokenAddress: string }> {
  const modules = await resolveOrgModules(orgIdOrName, chainId);
  return {
    orgId: modules.orgId,
    tokenAddress: requireModule(modules, 'participationTokenAddress'),
  };
}

export interface TokenGateContext {
  hatsAddress: string;
  executor: string;
  memberHatIds: ethers.BigNumber[];
  approverHatIds: ethers.BigNumber[];
}

const GATES_IFACE = new ethers.utils.Interface([
  'function hats() view returns (address)',
  'function executor() view returns (address)',
  'function memberHatIds() view returns (uint256[])',
  'function approverHatIds() view returns (uint256[])',
]);

const GATE_READS = ['hats', 'executor', 'memberHatIds', 'approverHatIds'] as const;

/**
 * Read the token's hat-gate config (member/approver hat sets + executor) in a
 * single Multicall3 round-trip.
 *
 * Throws when ANY of the four reads fails: callers (token request/approve)
 * catch that and skip the gate pre-flight so the transaction itself surfaces
 * the real revert. Silently returning a zero executor or an empty hat set
 * would instead produce a confidently wrong pre-flight verdict.
 */
export async function readTokenGates(
  provider: ethers.providers.Provider,
  tokenAddress: string
): Promise<TokenGateContext> {
  const results = await tryAggregate(
    provider,
    GATE_READS.map(fn => ({ to: tokenAddress, data: GATES_IFACE.encodeFunctionData(fn, []) }))
  );

  const decoded = GATE_READS.map((fn, i) => {
    const { success, returnData } = results[i];
    if (!success || !returnData || returnData === '0x') {
      throw new Error(`ParticipationToken.${fn}() read failed`);
    }
    return GATES_IFACE.decodeFunctionResult(fn, returnData)[0];
  });

  const [hatsAddress, executor, memberHatIds, approverHatIds] = decoded as
    [string, string, ethers.BigNumberish[], ethers.BigNumberish[]];

  return {
    hatsAddress,
    executor,
    memberHatIds: memberHatIds.map(h => ethers.BigNumber.from(h)),
    approverHatIds: approverHatIds.map(h => ethers.BigNumber.from(h)),
  };
}

const HATS_IFACE = new ethers.utils.Interface([
  'function balanceOf(address wearer, uint256 hatId) view returns (uint256 balance)',
]);

/**
 * ANY-OF hat check mirroring ParticipationToken's _hasHat loop: passes when
 * the wearer holds at least one of `hatIds`. Single-hat sets delegate to the
 * shared checkHasHat (multicall path).
 *
 * The multi-hat path runs as a `local` check because runPreflight's own
 * Multicall3 batch is one-call-per-check and this one needs N. It therefore
 * runs OUTSIDE that batch — so it does its own tryAggregate, making the
 * multi-hat path one round-trip like the single-hat path instead of N.
 *
 * These are revert predictors (NotMember / NotApprover) evaluated immediately
 * before the write, so they stay on the contract: the subgraph does not index
 * Hats wearer balances, and even if it did, lag would mean predicting a
 * revert that will not happen (or missing one that will).
 */
export function checkWearsAnyHat(
  provider: ethers.providers.Provider,
  hatsAddress: string,
  wearer: string,
  hatIds: ethers.BigNumber[],
  opts: { label: string; detail: string; suggestion?: string }
): PreflightCheck {
  if (hatIds.length === 1) {
    return checkHasHat(hatsAddress, wearer, hatIds[0]);
  }
  return {
    label: opts.label,
    local: async () => {
      const results = await tryAggregate(
        provider,
        hatIds.map(id => ({
          to: hatsAddress,
          data: HATS_IFACE.encodeFunctionData('balanceOf', [wearer, id]),
        }))
      );
      const wearsOne = results.some(({ success, returnData }) => {
        if (!success || !returnData || returnData === '0x') return false;
        const balance = HATS_IFACE.decodeFunctionResult('balanceOf', returnData)[0] as ethers.BigNumber;
        return !balance.isZero();
      });
      if (wearsOne) return { ok: true };
      return {
        ok: false,
        detail: `${opts.detail} (checked hats: ${hatIds.map(h => h.toString()).join(', ') || 'none'})`,
        suggestion: opts.suggestion,
      };
    },
  };
}

export interface TokenRequestOnChain {
  requester: string;
  amount: ethers.BigNumber;
  approved: boolean;
  ipfsHash: string;
  exists: boolean;
}

/**
 * Read requests(id) — requester == 0 means unknown/cancelled (RequestUnknown).
 *
 * DELIBERATELY NOT converted to TokenRequest even though the entity carries
 * requester/amount/status/ipfsHash. This is the sole existence + state gate
 * for approve/cancel, and every one of its three verdicts is a revert
 * prediction (RequestUnknown, already-approved, NotRequester). A stale
 * subgraph row — the request was approved or cancelled seconds ago — would
 * make the CLI predict success and broadcast a transaction that is certain to
 * revert. `pop token requests`, which only lists, already reads the subgraph.
 */
export async function readTokenRequest(
  provider: ethers.providers.Provider,
  tokenAddress: string,
  requestId: number
): Promise<TokenRequestOnChain> {
  const pt = createReadContract(tokenAddress, 'ParticipationToken', provider);
  const r = await pt.requests(requestId);
  const requester = String(r.requester ?? r[0]);
  return {
    requester,
    amount: ethers.BigNumber.from(r.amount ?? r[1]),
    approved: Boolean(r.approved ?? r[2]),
    ipfsHash: String(r.ipfsHash ?? r[3]),
    exists: requester !== ethers.constants.AddressZero,
  };
}
