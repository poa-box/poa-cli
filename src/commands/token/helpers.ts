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
 */

import { ethers } from 'ethers';
import { resolveOrgModules, requireModule } from '../../lib/resolve';
import { createReadContract } from '../../lib/contracts';
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

/** Read the token's hat-gate config (member/approver hat sets + executor). */
export async function readTokenGates(
  provider: ethers.providers.Provider,
  tokenAddress: string
): Promise<TokenGateContext> {
  const pt = createReadContract(tokenAddress, 'ParticipationToken', provider);
  const [hatsAddress, executor, memberHatIds, approverHatIds] = await Promise.all([
    pt.hats(),
    pt.executor(),
    pt.memberHatIds(),
    pt.approverHatIds(),
  ]);
  return {
    hatsAddress,
    executor,
    memberHatIds: (memberHatIds as ethers.BigNumberish[]).map(h => ethers.BigNumber.from(h)),
    approverHatIds: (approverHatIds as ethers.BigNumberish[]).map(h => ethers.BigNumber.from(h)),
  };
}

const HATS_IFACE = new ethers.utils.Interface([
  'function balanceOf(address wearer, uint256 hatId) view returns (uint256 balance)',
]);

/**
 * ANY-OF hat check mirroring ParticipationToken's _hasHat loop: passes when
 * the wearer holds at least one of `hatIds`. Single-hat sets delegate to the
 * shared checkHasHat (multicall path).
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
      const hats = new ethers.Contract(hatsAddress, HATS_IFACE.fragments, provider);
      const balances: ethers.BigNumber[] = await Promise.all(
        hatIds.map(id => hats.balanceOf(wearer, id))
      );
      if (balances.some(b => !b.isZero())) return { ok: true };
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

/** Read requests(id) — requester == 0 means unknown/cancelled (RequestUnknown). */
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
