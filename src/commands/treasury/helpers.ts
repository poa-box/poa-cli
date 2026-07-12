import { ethers } from 'ethers';
import { resolveOrgModules, requireModule } from '../../lib/resolve';
import { createReadContract } from '../../lib/contracts';
import { getNetworkByChainId } from '../../config/networks';
import { getTokenByAddress } from '../../config/tokens';

export async function resolveTreasuryContracts(orgIdOrName: string | undefined, chainId?: number) {
  const modules = await resolveOrgModules(orgIdOrName, chainId);
  return {
    orgId: modules.orgId,
    paymentManagerAddress: requireModule(modules, 'paymentManagerAddress'),
    executorAddress: modules.executorAddress,
  };
}

export interface PayoutTokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  isNative: boolean;
}

/**
 * Resolve a distribution payout token to human units. PaymentManager uses
 * address(0) for the chain's native token (verified: claimDistribution
 * transfers raw value when payoutToken == address(0)); ERC20s are resolved
 * via a live decimals()/symbol() read with the known-token table then an
 * 18-decimals default as fallbacks.
 */
export async function resolvePayoutTokenInfo(
  provider: ethers.providers.Provider,
  tokenAddress: string,
  chainId?: number
): Promise<PayoutTokenInfo> {
  if (!tokenAddress || tokenAddress === ethers.constants.AddressZero) {
    const native = getNetworkByChainId(chainId ?? 0)?.nativeCurrency?.symbol ?? 'native';
    return { address: ethers.constants.AddressZero, symbol: native, decimals: 18, isNative: true };
  }

  const known = getTokenByAddress(tokenAddress);
  let decimals = known?.decimals;
  let symbol = known?.symbol;
  try {
    const erc20 = createReadContract(tokenAddress, 'ERC20', provider);
    const [liveDecimals, liveSymbol] = await Promise.all([
      erc20.decimals(),
      erc20.symbol().catch(() => undefined),
    ]);
    decimals = Number(liveDecimals);
    symbol = liveSymbol ?? symbol;
  } catch {
    // Live read failed — fall back to the known-token table / 18.
  }
  return {
    address: tokenAddress,
    symbol: symbol ?? 'tokens',
    decimals: decimals ?? 18,
    isNative: false,
  };
}
