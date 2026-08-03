/**
 * Transaction intents — the wallet-agnostic write primitive.
 *
 * Every POP write is representable as (to, abi, method, args, value): the CLI
 * has always funneled that tuple into executeTx, and the frontend funnels the
 * same tuple into its three interchangeable transaction managers (direct EOA,
 * ERC-4337 passkey, EIP-7702 sponsored). A TxIntent reifies the tuple as data
 * so ANY of those stacks — plus wagmi/viem, Safe batches, raw JSON-RPC — can
 * execute it:
 *
 *   CLI / agent:     executeIntent(signer, intent)            (execute/ethers)
 *   wagmi/viem:      writeContract({ address: intent.to, abi: intent.abi,
 *                                    functionName: intent.method, args: intent.args })
 *   4337 / 7702:     sendSponsored(key, intent.to, encodeIntent(intent).data, ...)
 *   anything else:   encodeIntent(intent) → { to, data, value }
 *
 * Domain builders (tx/<domain>.ts) return intents; they never sign or send.
 */

import { ethers } from 'ethers';

export interface TxIntentMeta {
  /** Command-style domain, e.g. 'task' | 'vote' | 'org' | 'treasury'. */
  domain: string;
  /** Action within the domain, e.g. 'create' | 'cast' | 'claim'. */
  action: string;
  /** Org the intent targets, when org-scoped. */
  orgId?: string;
  /** Human-readable preview fields for confirmation UIs. */
  summary?: Record<string, unknown>;
  /** Metadata pinned to IPFS while building the intent, if any. */
  ipfs?: { cid: string; metadata: unknown };
}

export interface TxIntent {
  /** Resolved contract address. */
  to: string;
  /** Full fragment set — used for encoding AND receipt-log parsing. */
  abi: any[];
  /** Contract method name, e.g. 'createTask'. */
  method: string;
  /** Fully encoded, contract-ordered arguments. */
  args: unknown[];
  /** Native value, when the method is payable. */
  value?: ethers.BigNumberish;
  meta: TxIntentMeta;
}

/**
 * Pure calldata encoding — no provider, no signer, no network.
 * `value` is returned as a decimal string ('0' when absent) so the result is
 * JSON-serializable and stack-agnostic.
 */
export function encodeIntent(intent: TxIntent): { to: string; data: string; value: string } {
  const iface = new ethers.utils.Interface(intent.abi);
  return {
    to: intent.to,
    data: iface.encodeFunctionData(intent.method, intent.args),
    value: ethers.BigNumber.from(intent.value ?? 0).toString(),
  };
}

/**
 * Materialize an intent as an ethers v5 Contract call triple, for hosts that
 * already speak (contract, method, args) — the CLI's executeTx and the
 * frontend's txManager.execute both do.
 */
export function intentToContractCall(
  intent: TxIntent,
  signerOrProvider: ethers.Signer | ethers.providers.Provider
): { contract: ethers.Contract; method: string; args: unknown[] } {
  return {
    contract: new ethers.Contract(intent.to, intent.abi, signerOrProvider),
    method: intent.method,
    args: intent.args,
  };
}
