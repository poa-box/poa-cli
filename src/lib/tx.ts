/**
 * Transaction Execution — CLI wrapper over @poa-box/core/execute.
 *
 * The full pipeline (gas estimation as revert prediction, dry-run calldata,
 * EIP-7702 sponsored routing with EOA fallback, receipt-log parsing, error
 * classification/decoding) lives in @poa-box/core/execute/ethers and is
 * environment-free. This wrapper restores the CLI's implicit env behavior:
 *
 *   - sponsorship auto-resolves from env (POP_PRIVATE_KEY/POP_ORG_ID/POP_HAT_ID
 *     + PIMLICO_API_KEY|POP_BUNDLER_URL) when options.sponsored is not given
 *   - bundler routing comes from POP_BUNDLER_URL / PIMLICO_API_KEY
 *   - POP_LEGACY_DRYRUN_TXHASH=1 keeps the legacy dry-run txHash field
 *
 * executeTx keeps its pre-extraction signature for every command and for
 * @poa-box/agent's `@poa-box/cli/lib/tx` deep import.
 */

import { ethers } from 'ethers';
import { getNetworkByChainId } from '../config/networks';
import { decodeUserOperationOutcome } from '@poa-box/core/execute/outcome';
import { isolateUserOperationReceiptLogs } from '@poa-box/core/reads/provenance';
import { resolveSponsoredConfig as resolveSponsoredConfigWithEnv } from '@poa-box/core/sponsorship-config';
import {
  executeContractTx,
  executeIntent as coreExecuteIntent,
  classifyError,
  detectUserOpFailure,
  parseEventLogs,
} from '@poa-box/core/execute/ethers';
import type { TxResult as CoreTxResult, TxOptions as CoreTxOptions, ErrorCode, ClassifiedError } from '@poa-box/core/execute/ethers';
import type { TxIntent } from '@poa-box/core/tx/intent';
import { resolveSponsoredConfig } from './sponsorship-config';
import type { SponsoredConfig } from './sponsorship-config';
import { acquireSubmissionLock, startSubmission, transitionJournal, persistSubmission, providerRecoveryReaders } from './submission-recovery';
import { reconcileSubmissionRecovery, type SubmissionRecoveryRecord } from '@poa-box/core/execute/recovery';

// Re-exported for backward compatibility — canonical home is sponsorship-config.
export { resolveSponsoredConfig };
export type { SponsoredConfig };

export { classifyError, detectUserOpFailure, parseEventLogs };
export type { ErrorCode, ClassifiedError };
export type TxResult = CoreTxResult & { recovery?: { account: string; chainId: number; phase: string; computedHash?: string; txHash?: string; nonce?: string } };

export interface TxOptions {
  dryRun?: boolean;
  gasLimit?: number;
  value?: ethers.BigNumber;
  sponsored?: SponsoredConfig;
}

/** Explicit Wallet flags own account selection; env supplies routing and org policy.
 * Nonexportable signers retain explicit config and core enforces account equality. */
export function resolveTransactionSponsorship(signer: ethers.Signer, options: TxOptions = {}): SponsoredConfig | undefined {
  if (options.sponsored) return options.sponsored;
  return resolveSponsoredConfigWithEnv(signer instanceof ethers.Wallet ? { ...process.env, POP_PRIVATE_KEY: signer.privateKey } : process.env);
}

function withCliEnv(options: TxOptions): CoreTxOptions {
  return {
    ...options,
    // Explicit config wins; otherwise auto-resolve from env exactly as before.
    // A THUNK, not a value: core invokes it inside its try/catch after the
    // dry-run short-circuit, so a malformed POP_HAT_ID yields a classified
    // TxResult on live writes and never touches --dry-run (pre-extraction
    // ordering — resolveSponsoredConfig ran inside executeTx's try block).
    sponsored: options.sponsored || (() => resolveSponsoredConfig()),
    sponsoredSend: {
      bundlerUrl: process.env.POP_BUNDLER_URL || undefined,
      pimlicoApiKey: process.env.PIMLICO_API_KEY || undefined,
    },
    legacyDryRunTxHash: process.env.POP_LEGACY_DRYRUN_TXHASH === '1',
  };
}

/**
 * Execute a contract method.
 * In dry-run mode: estimates gas and encodes calldata without sending.
 * When sponsored config is available (explicit or from env) and the EOA is
 * delegated, routes through the PaymasterHub for gas sponsorship, falling back
 * to a direct EOA tx. Returns parsed event logs so callers can extract entity IDs.
 */
export async function executeTx(
  contract: ethers.Contract,
  method: string,
  args: any[],
  options: TxOptions = {}
): Promise<TxResult> {
  if (options.dryRun) return executeContractTx(contract, method, args, withCliEnv(options));
  if (process.env.POP_READONLY === '1') return { success: false, errorCode: 'USER_REJECTED', error: 'POP_READONLY=1 — signing and broadcasting are disabled.' };
  // Surface revert predictions before journal/account setup; the executor
  // re-estimates under the account lock immediately before sending.
  const prediction = await executeContractTx(contract, method, args, withCliEnv({ ...options, dryRun: true }));
  if (!prediction.success) return prediction;
  let release: (() => void) | undefined;
  let record: SubmissionRecoveryRecord | undefined;
  try {
    const account = await contract.signer.getAddress();
    const provider = contract.provider as ethers.providers.JsonRpcProvider;
    const chainId = (await provider.getNetwork()).chainId;
    release = acquireSubmissionLock(chainId, account);
    record = startSubmission(chainId, account, { to: contract.address,
      data: contract.interface.encodeFunctionData(method, args), value: options.value?.toString() ?? '0' });
    const advance = (event: Parameters<typeof transitionJournal>[1]) => { record = transitionJournal(record!, event); };
    const signer = new JournalSigner(contract.signer, async transaction => {
      const prepared = await contract.signer.populateTransaction(transaction);
      const nonce = Number(prepared.nonce);
      if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Exact transaction nonce is unavailable');
      const fromBlock = String(await provider.getBlockNumber());
      advance({ type: 'prepare', kind: 'transaction', nonce: String(nonce), callKey: record!.scope.intentKey, fromBlock });
      advance({ type: 'broadcast' });
      const tx = await contract.signer.sendTransaction(prepared);
      advance({ type: 'acknowledge', txHash: tx.hash });
      return tx;
    });
    const envOptions = withCliEnv(options);
    envOptions.sponsored = () => resolveTransactionSponsorship(contract.signer, options);
    envOptions.sponsoredSend = { ...envOptions.sponsoredSend,
      rpcUrl: provider.connection?.url,
      onPrepared: async submission => {
        if (submission.chainId !== chainId) throw new Error('Sponsored chain differs from signer chain');
        advance({ type: 'prepare', kind: 'user-operation', nonce: submission.nonce,
          computedHash: submission.computedHash, entryPoint: submission.entryPoint });
        advance({ type: 'broadcast' });
      },
      onSubmitted: async () => { advance({ type: 'acknowledge' }); },
    };
    const result = await executeContractTx(contract.connect(signer), method, args, envOptions);
    if (['intent', 'signing', 'prepared'].includes(record.phase)) {
      advance({ type: 'abort' });
    } else {
      if (result.txHash) { record = { ...record, txHash: result.txHash, revision: record.revision + 1 }; persistSubmission(record); }
      const settled = await reconcileSubmissionRecovery(record, providerRecoveryReaders(provider,
        process.env.POP_BUNDLER_URL || (process.env.PIMLICO_API_KEY ? `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${process.env.PIMLICO_API_KEY}` : undefined)));
      if (settled.outcome.status !== 'unknown') {
        advance({ type: 'settle', status: settled.outcome.status });
        if (settled.outcome.status === 'succeeded') {
          // Receipt waits can fail after inclusion. Return the reconciled truth
          // to callers as well as the journal, so an agent cannot interpret a
          // false failure as permission to repeat the completed action.
          const outerReceipt = settled.receipt as ethers.providers.TransactionReceipt;
          let receipt = outerReceipt;
          let logScope: 'operation' | 'unknown' | undefined;
          const confirmedHash = settled.outcome.txHash!;
          if (record.kind === 'user-operation') {
            receipt = { ...outerReceipt, logs: [] }; logScope = 'unknown';
            try {
              const transaction = await provider.getTransaction(confirmedHash);
              if (!transaction) throw new Error('OPERATION_TRANSACTION_UNAVAILABLE');
              const logs = isolateUserOperationReceiptLogs({ transaction, receipt: outerReceipt, chainId,
                expected: { userOpHash: record.computedHash!, entryPoint: record.entryPoint!, sender: account, nonce: record.nonce,
                  target: contract.address, data: contract.interface.encodeFunctionData(method, args) } });
              receipt = { ...outerReceipt, logs: [...logs] }; logScope = 'operation';
            } catch { /* Confirmed execution with unknown event scope cannot invent entity IDs. */ }
          }
          const network = getNetworkByChainId(chainId);
          return { success: true, txHash: confirmedHash, blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed?.toString(), logs: parseEventLogs(receipt, contract.interface, contract.address), receipt,
            explorerUrl: network?.blockExplorer ? `${network.blockExplorer}/tx/${confirmedHash}` : undefined,
            ...(record.kind === 'user-operation' ? { sponsored: true, userOpHash: record.computedHash, submission: result.submission,
              outerReceipt, logScope, outcome: decodeUserOperationOutcome(outerReceipt, { userOpHash: record.computedHash!, entryPoint: record.entryPoint!, sender: account, nonce: record.nonce }) } : {}) };
        }
      }
      else {
        advance({ type: 'unresolved' });
        return { ...result, txHash: result.txHash ?? record.txHash, success: false, errorCode: 'UNKNOWN_ERROR',
          error: `Submission outcome is unresolved (${settled.outcome.code}); recover this account before sending again.`,
          suggestion: `pop execution recover --address ${account} --chain ${chainId}`,
          recovery: { account, chainId, phase: record.phase, computedHash: record.computedHash, txHash: record.txHash, nonce: record.nonce } };
      }
    }
    if (['failed', 'replaced'].includes(record.phase)) return { ...result, success: false, errorCode: 'TX_REVERTED', error: record.phase === 'replaced' ? 'The submitted nonce was consumed by a different call.' : (result.error ?? 'The submitted call failed on-chain.') };
    return result;
  } catch (error: any) {
    // A persisted possibly-broadcast identity is retained on every failure.
    // Persistence failures themselves never authorize a different send path.
    if (record && ['submitting', 'submitted', 'unresolved'].includes(record.phase)) {
      try { record = transitionJournal(record, { type: 'unresolved' }); } catch { /* retain last durable identity */ }
    }
    const classified = classifyError(error, contract.interface);
    return { success: false, errorCode: classified.code, error: classified.message,
      txHash: record?.txHash, userOpHash: record?.computedHash,
      recovery: record ? { account: record.scope.accountAddress, chainId: record.scope.chainId, phase: record.phase, computedHash: record.computedHash, txHash: record.txHash, nonce: record.nonce } : undefined,
      suggestion: 'Inspect pop execution status and recover any unresolved submission before retrying.' };
  } finally { release?.(); }
}

/**
 * Execute a @poa-box/core TxIntent with the same CLI env bindings as executeTx.
 * New code should prefer building intents (tx/<domain> in @poa-box/core) and
 * executing them here.
 */
export async function executeIntent(
  signer: ethers.Signer,
  intent: TxIntent,
  options: TxOptions = {}
): Promise<TxResult> {
  const contract = new ethers.Contract(intent.to, intent.abi, signer);
  return executeTx(contract, intent.method, intent.args as any[], { ...options, value: options.value ?? (intent.value !== undefined ? ethers.BigNumber.from(intent.value) : undefined) });
}

/** Intercepts the one EOA send while preserving the wrapped signer's capabilities. */
class JournalSigner extends ethers.Signer {
  constructor(private readonly original: ethers.Signer,
    private readonly send: (transaction: ethers.providers.TransactionRequest) => Promise<ethers.providers.TransactionResponse>) {
    super(); ethers.utils.defineReadOnly(this, 'provider', original.provider);
  }
  getAddress() { return this.original.getAddress(); }
  signMessage(message: string | ethers.utils.Bytes) { return this.original.signMessage(message); }
  signTransaction(transaction: ethers.utils.Deferrable<ethers.providers.TransactionRequest>) { return this.original.signTransaction(transaction); }
  connect(provider: ethers.providers.Provider) { return new JournalSigner(this.original.connect(provider), this.send); }
  async sendTransaction(transaction: ethers.utils.Deferrable<ethers.providers.TransactionRequest>) {
    return this.send(await ethers.utils.resolveProperties(transaction));
  }
}
