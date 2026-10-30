import { ethers } from 'ethers';
import { requireRawUint } from '../../amounts';
import type { SubmissionRecoveryReaders } from '../../execute/recovery';
export { guardedRpcSigner } from './ethers';
export type { GuardedRpcSignerCallbacks } from './ethers';
export { createSponsoredExecutionAdapter } from './sponsored';
export type { SponsoredExecutionPorts, SponsoredOperationPreparation, PreparedSponsoredCall, SponsoredWalletSendOptions } from './sponsored';

export interface WalletScope { chainId: number; accountAddress: string }
export interface UnsignedCall { to: string; data: string; value: string }
export interface PreparedWalletCall { readonly kind?: 'transaction'; readonly call: Readonly<UnsignedCall>; readonly nonce: string; readonly fromBlock: string }
export type PreparedTransactionCall = PreparedWalletCall;
export type PreparedUserOperationCall = import('./sponsored').PreparedSponsoredCall;
export type PreparedAccountCall = PreparedTransactionCall | PreparedUserOperationCall;
export type AccountSendResult = { kind?: 'transaction'; txHash: string } | { kind: 'user-operation'; userOpHash: string; computedHash: string };
export interface WalletActionOptions { signal?: AbortSignal; isCurrent: () => boolean }
export interface WalletSendOptions extends WalletActionOptions {
  /** Required by sponsored transports before signing; EOA transports ignore it. */
  beforeSign?: () => unknown | Promise<unknown>;
  beforeSend: () => unknown | Promise<unknown>;
}
/** Shared workflow transport. A user-operation hash is its own identity and is
 * never presented as an enclosing transaction hash. */
export interface AccountTransport {
  getIdentity(options?: { signal?: AbortSignal }): Promise<WalletScope>;
  prepare(input: WalletActionOptions & { scope: WalletScope; call: UnsignedCall }): Promise<PreparedAccountCall>;
  send(prepared: PreparedAccountCall, options: WalletSendOptions): Promise<AccountSendResult>;
  recoveryReaders: SubmissionRecoveryReaders;
  dispose(): void;
}
export interface WalletAdapter {
  getIdentity(options?: { signal?: AbortSignal }): Promise<WalletScope>;
  prepare(input: WalletActionOptions & { scope: WalletScope; call: UnsignedCall }): Promise<PreparedWalletCall>;
  send(prepared: PreparedWalletCall, options: WalletSendOptions): Promise<{ txHash: string }>;
  recoveryReaders: SubmissionRecoveryReaders;
  dispose(): void;
}
export interface Eip1193Provider {
  request(request: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}
export interface EthersWalletOptions {
  signer?: ethers.Signer;
  provider?: ethers.providers.Provider;
  ethereum?: Eip1193Provider;
  /** Must enter the actual wallet boundary immediately, without further awaited setup. */
  dispatchPopulatedTransaction?: (transaction: Readonly<Record<string, unknown>>) => Promise<unknown>;
}
const address = (value: string): string => {
  const result = ethers.utils.getAddress(value).toLowerCase();
  if (result === ethers.constants.AddressZero) throw new Error('NONZERO_ADDRESS_REQUIRED');
  return result;
};
export function normalizeWalletScope(scope: WalletScope): WalletScope {
  if (!Number.isSafeInteger(scope?.chainId) || scope.chainId <= 0) throw new Error('INVALID_WALLET_SCOPE');
  return { chainId: scope.chainId, accountAddress: address(scope.accountAddress) };
}
export function guardWalletAction(signal: AbortSignal | undefined, isCurrent: (() => boolean) | undefined): void {
  if (signal?.aborted) throw new Error('WALLET_ACTION_CANCELLED');
  if (typeof isCurrent !== 'function' || isCurrent() !== true) throw new Error('WALLET_SCOPE_CHANGED');
}
const same = (a: WalletScope, b: WalletScope) => a.chainId === b.chainId && a.accountAddress === b.accountAddress;

/** Extracted from the role-consumer wallet adapter. The EIP-1193 request is the
 * final boundary: no ethers population or identity await follows beforeSend. */
export function createEthersWalletAdapter(options: EthersWalletOptions = {}): WalletAdapter {
  const ethereum = options.ethereum;
  let provider = options.provider ?? options.signer?.provider ?? undefined;
  let signer = options.signer;
  if (ethereum) {
    const bridge = new ethers.providers.Web3Provider(ethereum as ethers.providers.ExternalProvider, 'any');
    provider = bridge; signer = bridge.getSigner();
  }
  if (!signer?.getAddress || !provider?.getNetwork || !signer.estimateGas) throw new Error('INJECTED_WALLET_REQUIRED');
  if (!ethereum && typeof options.dispatchPopulatedTransaction !== 'function') throw new Error('EXPLICIT_WALLET_DISPATCH_REQUIRED');
  const walletSigner = signer, walletProvider = provider;
  const preparedCalls = new WeakMap<PreparedWalletCall, { scope: WalletScope; generation: number; used: boolean }>();
  let generation = 0, disposed = false;
  const changed = () => { generation++; };
  ethereum?.on?.('accountsChanged', changed); ethereum?.on?.('chainChanged', changed);
  const guard = (options: WalletActionOptions) => {
    if (disposed) throw new Error('WALLET_ADAPTER_DISPOSED');
    guardWalletAction(options.signal, options.isCurrent);
  };
  const getIdentity = async ({ signal }: { signal?: AbortSignal } = {}): Promise<WalletScope> => {
    if (disposed) throw new Error('WALLET_ADAPTER_DISPOSED');
    if (signal?.aborted) throw new Error('WALLET_ACTION_CANCELLED');
    const chainId = ethereum ? Number(BigInt(String(await ethereum.request({ method: 'eth_chainId' })))) : (await walletProvider.getNetwork()).chainId;
    const accountAddress = address(await walletSigner.getAddress());
    if (signal?.aborted) throw new Error('WALLET_ACTION_CANCELLED');
    return normalizeWalletScope({ chainId, accountAddress });
  };
  const transaction = (row: ethers.providers.TransactionResponse | null) => row && ({ hash: row.hash, from: row.from, to: row.to, nonce: row.nonce,
    data: row.data, value: row.value.toString(), chainId: row.chainId, blockNumber: row.blockNumber, blockHash: row.blockHash });
  return {
    getIdentity,
    async prepare({ scope: inputScope, call: inputCall, ...action }) {
      guard(action);
      const scope = Object.freeze(normalizeWalletScope(inputScope));
      if (!inputCall || typeof inputCall.value !== 'string' || !/^0x(?:[\da-f]{2})*$/i.test(inputCall.data)) throw new Error('EXACT_UNSIGNED_CALL_REQUIRED');
      const call = Object.freeze({ to: address(inputCall.to), data: inputCall.data.toLowerCase(), value: requireRawUint(inputCall.value) });
      const startGeneration = generation;
      if (!same(await getIdentity(action), scope)) throw new Error('WALLET_IDENTITY_MISMATCH');
      const nonce = requireRawUint(await walletSigner.getTransactionCount('pending'));
      const fromBlock = requireRawUint(await walletProvider.getBlockNumber());
      guard(action);
      if (!same(await getIdentity(action), scope)) throw new Error('WALLET_IDENTITY_MISMATCH');
      guard(action);
      if (generation !== startGeneration) throw new Error('WALLET_SCOPE_CHANGED');
      const prepared = Object.freeze({ nonce, fromBlock, call });
      preparedCalls.set(prepared, { scope, generation, used: false });
      return prepared;
    },
    async send(prepared, action) {
      let entry: { scope: WalletScope; generation: number; used: boolean };
      let populated: Readonly<Record<string, unknown>>, wire: unknown;
      try {
        const saved = preparedCalls.get(prepared);
        if (!saved || saved.used) throw new Error('FRESH_PREPARED_WALLET_CALL_REQUIRED');
        entry = saved; entry.used = true;
        if (typeof action?.beforeSend !== 'function') throw new Error('FINAL_REVIEW_REQUIRED');
        guard(action);
        if (!same(await getIdentity(action), entry.scope)) throw new Error('WALLET_IDENTITY_MISMATCH');
        const request = { ...prepared.call, from: entry.scope.accountAddress, chainId: entry.scope.chainId, nonce: prepared.nonce };
        const gasLimit = requireRawUint((await walletSigner.estimateGas(request as unknown as ethers.providers.TransactionRequest)).toString());
        if (gasLimit === '0') throw new Error('WALLET_GAS_ESTIMATE_UNAVAILABLE');
        populated = Object.freeze({ ...request, gasLimit });
        if (ethereum) wire = Object.freeze(ethers.providers.JsonRpcProvider.hexlifyTransaction(populated as ethers.providers.TransactionRequest, { from: true }));
        guard(action);
        if (generation !== entry.generation) throw new Error('WALLET_SCOPE_CHANGED');
        if (requireRawUint(await walletSigner.getTransactionCount('pending')) !== prepared.nonce) throw new Error('WALLET_NONCE_CHANGED');
        if (!same(await getIdentity(action), entry.scope)) throw new Error('WALLET_IDENTITY_MISMATCH');
        guard(action);
        if (generation !== entry.generation) throw new Error('WALLET_SCOPE_CHANGED');
        await action.beforeSend();
        guard(action);
        if (generation !== entry.generation) throw new Error('WALLET_SCOPE_CHANGED');
      } catch (cause) {
        throw Object.assign(new Error('WALLET_HANDOFF_REFUSED', { cause }), { dispatched: false });
      }
      try {
        const result = await (ethereum ? ethereum.request({ method: 'eth_sendTransaction', params: [wire] }) : options.dispatchPopulatedTransaction!(populated));
        const hash = typeof result === 'string' ? result : (result as { hash?: string })?.hash;
        if (!/^0x[\da-f]{64}$/i.test(hash || '')) throw new Error('WALLET_HASH_UNAVAILABLE');
        return { txHash: hash!.toLowerCase() };
      } catch (cause) {
        throw Object.assign(new Error('WALLET_SEND_UNCONFIRMED', { cause }), { dispatched: true });
      }
    },
    recoveryReaders: {
      getChainId: async () => (await walletProvider.getNetwork()).chainId,
      getTransactionReceipt: hash => walletProvider.getTransactionReceipt(hash),
      getTransaction: async hash => transaction(await walletProvider.getTransaction(hash)),
      getBlock: number => walletProvider.getBlock(ethers.BigNumber.from(number).toNumber()),
      getBlockNumber: () => walletProvider.getBlockNumber(),
      getBlockTransactions: async number => (await walletProvider.getBlockWithTransactions(ethers.BigNumber.from(number).toNumber()))?.transactions?.map(row => transaction(row)!) ?? [],
    },
    dispose() { disposed = true; generation++; ethereum?.removeListener?.('accountsChanged', changed); ethereum?.removeListener?.('chainChanged', changed); },
  };
}
export function createEip1193WalletAdapter(options: { ethereum: Eip1193Provider }): WalletAdapter {
  return createEthersWalletAdapter(options);
}
