import { ethers } from 'ethers';
import { resolveOrgModules, requireModule } from '../../lib/resolve';
import { createReadContract } from '../../lib/contracts';
import { tryAggregate } from '../../lib/multicall';
import { PreflightCheck } from '../../lib/preflight';

export async function resolveTokenAddress(orgIdOrName: string | undefined, chainId?: number): Promise<{ orgId: string; tokenAddress: string }> {
  const modules = await resolveOrgModules(orgIdOrName, chainId);
  return {
    orgId: modules.orgId,
    tokenAddress: requireModule(modules, 'participationTokenAddress'),
  };
}

export interface TokenGateContext { authorityAddress: string; executor: string; }
const GATES_IFACE = new ethers.utils.Interface([
  'function membershipAuthority() view returns (address)', 'function executor() view returns (address)',
]);
export async function readTokenGates(provider: ethers.providers.Provider, tokenAddress: string): Promise<TokenGateContext> {
  const methods = ['membershipAuthority', 'executor'];
  const results = await tryAggregate(provider, methods.map(fn => ({ to: tokenAddress, data: GATES_IFACE.encodeFunctionData(fn) })));
  const decoded = results.map((r, i) => {
    if (!r.success || !r.returnData || r.returnData === '0x') throw new Error(`ParticipationToken.${methods[i]} read failed`);
    return GATES_IFACE.decodeFunctionResult(methods[i], r.returnData)[0];
  });
  return { authorityAddress: decoded[0], executor: decoded[1] };
}
const AUTHORITY_IFACE = new ethers.utils.Interface(['function hasPerm(address,bytes32,bytes32) view returns (uint256)']);
export function checkTokenPermission(authorityAddress: string, user: string, key: string): PreflightCheck {
  return { label: 'authority token permission',
    call: { to: authorityAddress, data: AUTHORITY_IFACE.encodeFunctionData('hasPerm', [user, key, ethers.constants.HashZero]) },
    interpret: (data, success) => {
      if (!success || data === '0x') return { ok: false, detail: 'Authority permission could not be read' };
      const allowed = !AUTHORITY_IFACE.decodeFunctionResult('hasPerm', data)[0].isZero();
      return { ok: allowed, detail: allowed ? undefined : 'Missing token permission in MembershipAuthority', suggestion: 'Ask governance to grant the required authority permission to your role.' };
    } };
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
