/**
 * EIP-7702 Gas Sponsorship — CLI wrapper over @poa-box/core/execute/sponsored.
 *
 * The userop construction (paymaster data encoding, v0.7 hash, dummy-signature
 * gas estimation, bundler submission) lives in core, environment-free. This
 * wrapper restores the CLI's env-driven bundler selection: POP_BUNDLER_URL for
 * a self-hosted bundler (task #425), else PIMLICO_API_KEY for Pimlico.
 */

import type { Hex, Address } from 'viem';
import {
  sendSponsored as coreSendSponsored,
  EOA_DELEGATION,
  PAYMASTER_HUB,
  ENTRY_POINT,
  encodePaymasterData,
  isDelegated,
  delegateEOA,
  getUserOpHash,
  encodeCall,
} from '@poa-box/core/execute/sponsored';
import type { SponsoredSendOptions } from '@poa-box/core/execute/sponsored';

export {
  EOA_DELEGATION,
  PAYMASTER_HUB,
  ENTRY_POINT,
  encodePaymasterData,
  isDelegated,
  delegateEOA,
  getUserOpHash,
  encodeCall,
};
export type { SponsoredSendOptions };

/**
 * Send a sponsored transaction via the bundler. Pre-extraction signature:
 * bundler routing falls back to env (POP_BUNDLER_URL, then PIMLICO_API_KEY)
 * when the options don't name one.
 */
export async function sendSponsored(
  privateKey: Hex,
  to: Address,
  data: Hex,
  orgId: Hex,
  hatId: bigint,
  options?: {
    rpcUrl?: string;
    value?: bigint;
    pimlicoApiKey?: string;
    bundlerUrl?: string;
  }
): Promise<{ txHash: Hex; userOpHash: Hex }> {
  return coreSendSponsored(privateKey, to, data, orgId, hatId, {
    ...options,
    bundlerUrl: options?.bundlerUrl || process.env.POP_BUNDLER_URL || undefined,
    pimlicoApiKey: options?.pimlicoApiKey || process.env.PIMLICO_API_KEY || undefined,
  });
}
