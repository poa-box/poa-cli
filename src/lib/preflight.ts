/**
 * Preflight checks — CLI wrapper over @poa-box/core/preflight.
 *
 * The declarative check engine (Multicall3 batching, callStatic probes, all
 * check factories) lives in core. The one CLI binding: checkGasBalance
 * auto-resolves sponsorship from env (a sponsored wallet needs no gas), which
 * core takes as an injected parameter. The local export shadows the star
 * re-export per ES module rules.
 */

import { ethers } from 'ethers';
import { checkGasBalance as coreCheckGasBalance } from '@poa-box/core/preflight';
import type { PreflightCheck } from '@poa-box/core/preflight';
import { resolveSponsoredConfig } from './sponsorship-config';

export * from '@poa-box/core/preflight';

/**
 * Gas-balance check; skipped for sponsored wallets (env-resolved, as before —
 * see @poa-box/core/preflight for why a zero balance is fine under sponsorship).
 */
export function checkGasBalance(address: string, minWei?: ethers.BigNumber): PreflightCheck {
  return coreCheckGasBalance(address, minWei, resolveSponsoredConfig());
}
