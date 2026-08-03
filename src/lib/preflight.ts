/**
 * Preflight checks — CLI wrapper over @poa/core/preflight.
 *
 * The declarative check engine (Multicall3 batching, callStatic probes, all
 * check factories) lives in core. The one CLI binding: checkGasBalance
 * auto-resolves sponsorship from env (a sponsored wallet needs no gas), which
 * core takes as an injected parameter. The local export shadows the star
 * re-export per ES module rules.
 */

import { ethers } from 'ethers';
import { checkGasBalance as coreCheckGasBalance } from '@poa/core/preflight';
import type { PreflightCheck } from '@poa/core/preflight';
import { resolveSponsoredConfig } from './sponsorship-config';

export * from '@poa/core/preflight';

/**
 * Gas-balance check; skipped for sponsored wallets (env-resolved, as before —
 * see @poa/core/preflight for why a zero balance is fine under sponsorship).
 */
export function checkGasBalance(address: string, minWei?: ethers.BigNumber): PreflightCheck {
  return coreCheckGasBalance(address, minWei, resolveSponsoredConfig());
}
