/**
 * Multicall3 Batching
 * Batch read-only eth_calls through the canonical Multicall3 deployment
 * (same address on every chain, https://www.multicall3.com). When Multicall3
 * is not deployed on the target chain, degrades to parallel provider.call
 * with per-call error trapping so callers always get one result per call.
 */

import { ethers } from 'ethers';

/** Canonical Multicall3 address (identical across all supported chains). */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL3_IFACE = new ethers.utils.Interface([
  'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) returns (tuple(bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);

export interface Call {
  to: string;
  data: string;
}

export interface CallResult {
  success: boolean;
  returnData: string;
}

/**
 * Multicall3 availability, cached per provider instance (a provider is bound
 * to one chain, so this is effectively per provider/chain).
 */
const availabilityCache: WeakMap<ethers.providers.Provider, Promise<boolean>> = new WeakMap();

function isMulticallAvailable(provider: ethers.providers.Provider): Promise<boolean> {
  let available = availabilityCache.get(provider);
  if (!available) {
    available = provider
      .getCode(MULTICALL3)
      .then((code) => typeof code === 'string' && code.length > 2 && code !== '0x0')
      .catch(() => false);
    availabilityCache.set(provider, available);
  }
  return available;
}

/**
 * Fallback for chains without Multicall3: issue the call directly.
 * getEthBalance calls target Multicall3 itself, so without the deployment
 * they are answered from eth_getBalance instead of eth_call.
 */
async function fallbackCall(
  provider: ethers.providers.Provider,
  call: Call,
  blockTag?: number
): Promise<CallResult> {
  try {
    if (
      call.to.toLowerCase() === MULTICALL3.toLowerCase() &&
      call.data.slice(0, 10).toLowerCase() === MULTICALL3_IFACE.getSighash('getEthBalance').toLowerCase()
    ) {
      const [addr] = MULTICALL3_IFACE.decodeFunctionData('getEthBalance', call.data);
      const balance = await provider.getBalance(addr, blockTag);
      return { success: true, returnData: ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]) };
    }
    const returnData = await provider.call({ to: call.to, data: call.data }, blockTag);
    return { success: true, returnData };
  } catch {
    return { success: false, returnData: '0x' };
  }
}

/**
 * Batch read-only calls through Multicall3.tryAggregate(requireSuccess=false),
 * one RPC round-trip for the whole batch. Per-call reverts surface as
 * { success: false } instead of throwing. When Multicall3 is unavailable
 * (or the aggregate call itself fails), falls back to parallel provider.call
 * with the same per-call error mapping.
 */
export async function tryAggregate(
  provider: ethers.providers.Provider,
  calls: Call[],
  opts?: { blockTag?: number }
): Promise<CallResult[]> {
  if (calls.length === 0) return [];

  if (await isMulticallAvailable(provider)) {
    try {
      const data = MULTICALL3_IFACE.encodeFunctionData('tryAggregate', [
        false,
        calls.map((c) => [c.to, c.data]),
      ]);
      const raw = await provider.call({ to: MULTICALL3, data }, opts?.blockTag);
      const [results] = MULTICALL3_IFACE.decodeFunctionResult('tryAggregate', raw);
      return results.map((r: { success: boolean; returnData: string }) => ({
        success: r.success,
        returnData: r.returnData,
      }));
    } catch {
      // Aggregate call failed — degrade to the parallel fallback below.
    }
  }

  return Promise.all(calls.map((call) => fallbackCall(provider, call, opts?.blockTag)));
}

/** Calldata for Multicall3.getEthBalance(address), for batching native-balance reads. */
export function getEthBalanceCall(address: string): Call {
  return {
    to: MULTICALL3,
    data: MULTICALL3_IFACE.encodeFunctionData('getEthBalance', [address]),
  };
}

/** Decode the uint256 balance from a getEthBalance return payload. */
export function decodeEthBalance(returnData: string): ethers.BigNumber {
  return MULTICALL3_IFACE.decodeFunctionResult('getEthBalance', returnData)[0];
}
