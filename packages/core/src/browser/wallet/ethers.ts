import { ethers } from 'ethers';
import { Eip1193Provider } from './index';

export interface GuardedRpcSignerCallbacks {
  beforeSend(): unknown | Promise<unknown>;
  assertCurrent(): void;
  assertIntent(transaction: Record<string, unknown>): void;
  onDispatch(): void;
  onHash(hash: unknown): void;
}
/** Request-local ethers bridge extracted from the frontend TransactionManager.
 * Keeps ethers' ContractTransaction/wait behavior while guarding its actual RPC
 * request after JsonRpcSigner's asynchronous transaction population. */
export async function guardedRpcSigner(signer: ethers.Signer, { beforeSend, assertCurrent, assertIntent, onDispatch, onHash }: GuardedRpcSignerCallbacks) {
  if (!(signer instanceof ethers.providers.JsonRpcSigner) || !(signer.provider instanceof ethers.providers.Web3Provider)) return null;
  const originalProvider = signer.provider;
  const transport = originalProvider.provider as Eip1193Provider;
  // Subscribe before the initial awaits, so an A -> B -> A switch is fenced too.
  let walletChanged = false, dispatched = false, disposed = false;
  const changed = () => { walletChanged = true; };
  const listens = typeof transport?.on === 'function' && typeof transport?.removeListener === 'function';
  if (listens) { transport.on!('accountsChanged', changed); transport.on!('chainChanged', changed); }
  let provider: ethers.providers.Web3Provider | undefined;
  const dispose = () => {
    disposed = true;
    try { if (listens) { transport.removeListener!('accountsChanged', changed); transport.removeListener!('chainChanged', changed); } } catch { /* Preserve known outcome. */ }
    try { provider?.removeAllListeners(); } catch { /* Shared provider is untouched. */ }
  };
  try {
    const account = (await signer.getAddress()).toLowerCase(), network = await originalProvider.getNetwork();
    const request = typeof transport?.request === 'function' ? transport.request.bind(transport)
      : ({ method, params }: { method: string; params?: unknown[] }) => originalProvider.send(method, params ?? []);
    const current = () => {
      if (disposed) throw new Error('This signing session is no longer active.');
      assertCurrent();
      if (walletChanged) throw new Error('Your account or network changed. Please try again.');
    };
    current();
    provider = new ethers.providers.Web3Provider({ request: async (payload: { method: string; params?: unknown[] }) => {
      if (payload.method !== 'eth_sendTransaction') return request(payload);
      current();
      if (dispatched) throw new Error('This transaction has already been submitted. Check its status before trying again.');
      // Reserve before the first identity await. Parallel contract calls cannot
      // share this request-local signer even while final review is pending.
      dispatched = true;
      const accounts = await request({ method: 'eth_accounts', params: [] }), chain = await request({ method: 'eth_chainId', params: [] });
      current();
      if (!Array.isArray(accounts) || String(accounts[0]).toLowerCase() !== account) throw new Error('Your account changed. Please try again.');
      if (typeof chain !== 'string' || !/^0x[\da-f]+$/i.test(chain) || BigInt(chain) !== BigInt(network.chainId)) throw new Error('Your network changed. Please try again.');
      await beforeSend();
      current();
      const tx = payload.params?.[0] as Record<string, unknown> | undefined;
      if (String(tx?.from).toLowerCase() !== account || (tx?.chainId !== undefined && BigInt(String(tx.chainId)) !== BigInt(network.chainId))) throw new Error('The transaction account or network changed. Please try again.');
      assertIntent(tx!);
      onDispatch();
      const hash = await request(payload);
      onHash(hash); return hash;
    } }, network);
    return { signer: provider.getSigner(account), dispose };
  } catch (error) { dispose(); throw error; }
}
