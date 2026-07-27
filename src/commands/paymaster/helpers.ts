/**
 * Paymaster helpers — PaymasterHub address resolution + org registration read.
 *
 * The PaymasterHub is a singleton shared across all orgs (one proxy per
 * chain), so its address comes from the infrastructure query, not the org's
 * module list.
 */

import { ethers } from 'ethers';
import { query } from '../../lib/subgraph';
import { FETCH_INFRASTRUCTURE_ADDRESSES } from '../../queries/infrastructure';
import type { InfrastructureAddresses } from '../../queries/infrastructure';
import { createReadContract } from '../../lib/contracts';
import { PreconditionError } from '../../lib/errors';

export interface PaymasterInfra {
  paymasterHubAddress: string;
  poaManagerAddress: string | null;
}

/** Resolve the chain's PaymasterHub proxy (+ PoaManager) from the subgraph. */
export async function resolvePaymasterInfra(chainId?: number): Promise<PaymasterInfra> {
  const infra = await query<InfrastructureAddresses>(FETCH_INFRASTRUCTURE_ADDRESSES, {}, chainId);
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

/**
 * Read the hub's OrgConfig for an org. `registered` is derived the same way
 * the contract does it (adminHatId != 0 — see PaymasterHub._registerOrg).
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

/** Subject key for a hat-scoped paymaster budget: the hat ID as bytes32. */
export function hatSubjectKey(hatId: ethers.BigNumberish): string {
  return ethers.utils.hexZeroPad(ethers.BigNumber.from(hatId).toHexString(), 32);
}
