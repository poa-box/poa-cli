import { ethers } from 'ethers';
import { requireRawUint } from '@poa-box/core/amounts';

const address = value => {
  const result = ethers.utils.getAddress(value).toLowerCase();
  if (result === ethers.constants.AddressZero) throw new Error('NONZERO_ADDRESS_REQUIRED');
  return result;
};
const scopeOf = scope => {
  if (!Number.isSafeInteger(scope?.chainId) || scope.chainId <= 0) throw new Error('INVALID_WALLET_SCOPE');
  return { chainId: scope.chainId, accountAddress: address(scope.accountAddress) };
};
const guard = (signal, isCurrent) => {
  if (signal?.aborted) throw new Error('WALLET_ACTION_CANCELLED');
  if (typeof isCurrent !== 'function' || isCurrent() !== true) throw new Error('WALLET_SCOPE_CHANGED');
};
const same = (actual, expected) => actual.chainId === expected.chainId && actual.accountAddress === expected.accountAddress;

/** Explicitly injected wallet only: no discovery, keys, environment or automatic send.
 * The host's synchronous isCurrent guards its account/session generation. An
 * EIP-1193 bridge additionally fences account/network events during the handoff.
 * An opaque signer needs an explicit dispatcher that enters its wallet boundary
 * immediately; wrapping an unexamined high-level sendTransaction is insufficient. */
export function createEthersWalletAdapter({ signer, provider = signer?.provider, ethereum, dispatchPopulatedTransaction } = {}) {
  if (ethereum) { provider = new ethers.providers.Web3Provider(ethereum, 'any'); signer = provider.getSigner(); }
  if (!signer?.getAddress || !provider?.getNetwork || !(signer.estimateGas || provider.estimateGas)) throw new Error('INJECTED_WALLET_REQUIRED');
  if (!ethereum && typeof dispatchPopulatedTransaction !== 'function') throw new Error('EXPLICIT_WALLET_DISPATCH_REQUIRED');
  const preparedCalls = new WeakMap();
  const transaction = row => row && ({ hash: row.hash, from: row.from, to: row.to, nonce: row.nonce,
    data: row.data ?? row.input, value: ethers.BigNumber.isBigNumber(row.value) ? row.value.toString() : row.value,
    chainId: row.chainId, blockNumber: row.blockNumber, blockHash: row.blockHash });
  let generation = 0;
  const changed = () => { generation++; };
  ethereum?.on?.('accountsChanged', changed); ethereum?.on?.('chainChanged', changed);
  const getIdentity = async ({ signal } = {}) => {
    if (signal?.aborted) throw new Error('WALLET_ACTION_CANCELLED');
    const chainId = ethereum ? Number(BigInt(await ethereum.request({ method: 'eth_chainId' }))) : (await provider.getNetwork()).chainId;
    const accountAddress = address(await signer.getAddress());
    if (signal?.aborted) throw new Error('WALLET_ACTION_CANCELLED');
    return scopeOf({ chainId, accountAddress });
  };
  return {
    getIdentity,
    async prepare({ scope, call, signal, isCurrent }) {
      guard(signal, isCurrent);
      scope = Object.freeze(scopeOf(scope));
      if (!call || typeof call.value !== 'string' || !/^0x(?:[\da-f]{2})*$/i.test(call.data)) throw new Error('EXACT_UNSIGNED_CALL_REQUIRED');
      call = Object.freeze({ to: address(call.to), data: call.data.toLowerCase(), value: requireRawUint(call.value) });
      if (!same(await getIdentity({ signal }), scope)) throw new Error('WALLET_IDENTITY_MISMATCH');
      const nonce = requireRawUint(await signer.getTransactionCount('pending'));
      const fromBlock = requireRawUint(await provider.getBlockNumber());
      guard(signal, isCurrent);
      if (!same(await getIdentity({ signal }), scope)) throw new Error('WALLET_IDENTITY_MISMATCH');
      guard(signal, isCurrent);
      const prepared = Object.freeze({ nonce, fromBlock, call });
      preparedCalls.set(prepared, { scope, generation, used: false });
      return prepared;
    },
    async send(prepared, { signal, isCurrent, beforeSend } = {}) {
      let entry, populated, wire;
      try {
        entry = preparedCalls.get(prepared);
        if (!entry || entry.used) throw new Error('FRESH_PREPARED_WALLET_CALL_REQUIRED');
        entry.used = true; // Reserve synchronously: even parallel calls cannot share a handle.
        if (typeof beforeSend !== 'function') throw new Error('FINAL_REVIEW_REQUIRED');
        guard(signal, isCurrent);
        if (!same(await getIdentity({ signal }), entry.scope)) throw new Error('WALLET_IDENTITY_MISMATCH');
        const request = { ...prepared.call, from: entry.scope.accountAddress, chainId: entry.scope.chainId, nonce: prepared.nonce };
        const gasLimit = await (signer.estimateGas ? signer.estimateGas(request) : provider.estimateGas(request));
        populated = Object.freeze({ ...request, gasLimit: requireRawUint(ethers.BigNumber.isBigNumber(gasLimit) ? gasLimit.toString() : gasLimit) });
        if (populated.gasLimit === '0') throw new Error('WALLET_GAS_ESTIMATE_UNAVAILABLE');
        // Formatting is also completed before the final review. The browser
        // path must not call ethers.sendTransaction, which can do more RPC work.
        if (ethereum) wire = Object.freeze(ethers.providers.JsonRpcProvider.hexlifyTransaction(populated, { from: true }));
        guard(signal, isCurrent);
        if (generation !== entry.generation) throw new Error('WALLET_SCOPE_CHANGED');
        if (requireRawUint(await signer.getTransactionCount('pending')) !== prepared.nonce) throw new Error('WALLET_NONCE_CHANGED');
        if (!same(await getIdentity({ signal }), entry.scope)) throw new Error('WALLET_IDENTITY_MISMATCH');
        guard(signal, isCurrent);
        if (generation !== entry.generation) throw new Error('WALLET_SCOPE_CHANGED');
        // Controller persists its broadcast barrier and performs the final core
        // review here. No awaited identity/setup work may follow this callback.
        await beforeSend();
        guard(signal, isCurrent);
        if (generation !== entry.generation) throw new Error('WALLET_SCOPE_CHANGED');
      } catch (cause) {
        throw Object.assign(new Error('WALLET_HANDOFF_REFUSED', { cause }), { dispatched: false });
      }
      try {
        // Exactly this boundary follows the synchronous guard above. Generic
        // dispatchers are an explicit host capability, never inferred from a signer.
        const result = await (ethereum ? ethereum.request({ method: 'eth_sendTransaction', params: [wire] }) : dispatchPopulatedTransaction(populated));
        const hash = typeof result === 'string' ? result : result?.hash;
        if (!/^0x[\da-f]{64}$/i.test(hash || '')) throw new Error('WALLET_HASH_UNAVAILABLE');
        return { txHash: hash.toLowerCase() };
      } catch (cause) {
        throw Object.assign(new Error('WALLET_SEND_UNCONFIRMED', { cause }), { dispatched: true });
      }
    },
    // Core decides canonical outcome. These ports never clear a journal or resend.
    recoveryReaders: {
      getChainId: async () => (await provider.getNetwork()).chainId,
      getTransactionReceipt: hash => provider.getTransactionReceipt(hash),
      getTransaction: async hash => transaction(await provider.getTransaction(hash)),
      getBlock: number => provider.getBlock(ethers.BigNumber.from(number).toNumber()),
      getBlockNumber: () => provider.getBlockNumber(),
      getBlockTransactions: async number => (await provider.getBlockWithTransactions(ethers.BigNumber.from(number).toNumber()))?.transactions?.map(transaction) ?? [],
    },
    dispose() { generation++; ethereum?.removeListener?.('accountsChanged', changed); ethereum?.removeListener?.('chainChanged', changed); },
  };
}
