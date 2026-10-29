/**
 * Transaction Execution
 * Send transactions, wait for confirmation, support dry-run mode.
 * Routes through EIP-7702 gas sponsorship when options.sponsored is provided
 * (core never reads env — the CLI resolves sponsorship config into options).
 */

import { ethers } from 'ethers';
import { isolateUserOperationReceiptLogs } from '../reads/provenance';
import { getNetworkByChainId } from '../chains';
import { decodeContractError } from '../error-catalog';
import { SponsoredSubmissionError } from '../sponsorship-config';
import type { SponsoredConfig, SponsoredSendOptions, SponsoredSubmission } from '../sponsorship-config';
import { decodeUserOperationOutcome, USER_OPERATION_EVENTS, UserOperationExpectation, UserOperationOutcome } from './outcome';
import type { TxIntent } from '../tx/intent';

// Local aliases, structurally identical to viem's Hex/Address. This module is
// the PLAIN-EOA executor: viem is an optional peer, so neither its runtime
// nor its DECLARATIONS may enter this file's closure (a skipLibCheck:false
// consumer without viem must typecheck). Values flow to viem without casts.
type Hex = `0x${string}`;
type Address = `0x${string}`;

// Re-exported for convenience — canonical home is sponsorship-config.
export type { SponsoredConfig };

export type ErrorCode =
  | 'TX_REVERTED'
  | 'INSUFFICIENT_FUNDS'
  | 'NETWORK_ERROR'
  | 'USER_REJECTED'
  | 'GAS_ESTIMATION_FAILED'
  | 'CONTRACT_ERROR'
  | 'UNKNOWN_ERROR';

export interface TxResult {
  success: boolean;
  txHash?: string;
  blockNumber?: number;
  gasUsed?: string;
  explorerUrl?: string;
  logs?: ethers.utils.LogDescription[];
  error?: string;
  errorCode?: ErrorCode;
  /** Decoded custom-error name (e.g. 'BadStatus') when revert data was decodable */
  errorName?: string;
  /** Decoded custom-error args (empty for parameterless errors) */
  errorArgs?: any[];
  /** Actionable next step from the error catalog */
  suggestion?: string;
  /** Original provider/ethers message when the catalog replaced it */
  rawMessage?: string;
  sponsored?: boolean;
  userOpHash?: string;
  outcome?: UserOperationOutcome;
  submission?: SponsoredSubmission;
  /** Direct receipt, or sponsored operation-scoped receipt for domain decoding. */
  receipt?: ethers.providers.TransactionReceipt;
  /** Full bundler receipt, kept separately from operation-scoped domain logs. */
  outerReceipt?: ethers.providers.TransactionReceipt;
  logScope?: 'operation' | 'unknown';
  /** Dry-run fields (set when options.dryRun is true; no tx is sent) */
  dryRun?: boolean;
  gasEstimate?: string;
  calldata?: string;
  to?: string;
  method?: string;
}

export interface SponsoredExecutionAdapter {
  entryPoint: Hex;
  isDelegated(address: Address, rpcUrl?: string): Promise<boolean>;
  sendSponsored(privateKey: Hex, to: Address, data: Hex, orgId: Hex, hatId: bigint, options?: SponsoredSendOptions): Promise<{ txHash: Hex; userOpHash: Hex }>;
}

export interface TxOptions {
  dryRun?: boolean;
  gasLimit?: number;
  value?: ethers.BigNumber;
  /**
   * Sponsorship config, or a thunk resolving it. The thunk is invoked INSIDE
   * the executor's try/catch and only after the dry-run short-circuit — so a
   * host whose config resolution can throw (the CLI parses POP_HAT_ID from
   * env with BigInt()) gets a classified TxResult instead of a rejection, and
   * dry runs never touch sponsorship at all (pre-extraction CLI behavior).
   */
  sponsored?: SponsoredConfig | (() => SponsoredConfig | undefined);
  /** Emit the legacy `dry-run:0x…` txHash in dry-run results (CLI: POP_LEGACY_DRYRUN_TXHASH=1). */
  legacyDryRunTxHash?: boolean;
  /** Bundler/RPC routing forwarded to sendSponsored (CLI maps POP_BUNDLER_URL / PIMLICO_API_KEY). */
  sponsoredSend?: SponsoredSendOptions;
  /** Inject transports for offline hosts/tests. No signer/storage lifecycle policy. */
  sponsoredAdapter?: SponsoredExecutionAdapter;
  sponsoredAdapterLoader?: () => Promise<SponsoredExecutionAdapter>;
}

function buildExplorerUrl(txHash: string, chainId: number): string | undefined {
  const network = getNetworkByChainId(chainId);
  if (!network?.blockExplorer) return undefined;
  return `${network.blockExplorer}/tx/${txHash}`;
}

export function parseEventLogs(
  receipt: ethers.providers.TransactionReceipt,
  contractInterface: ethers.utils.Interface,
  emitter?: string
): ethers.utils.LogDescription[] {
  const parsed: ethers.utils.LogDescription[] = [];
  for (const log of receipt.logs) {
    if (emitter && log.address?.toLowerCase() !== emitter.toLowerCase()) continue;
    try {
      parsed.push(contractInterface.parseLog(log));
    } catch {
      // Log from a different contract — skip
    }
  }
  return parsed;
}

export interface ClassifiedError {
  message: string;
  code: ErrorCode;
  errorName?: string;
  errorArgs?: any[];
  suggestion?: string;
  rawMessage?: string;
}

/**
 * Enrich a revert classification with a decoded custom error when the revert
 * data is decodable. The catalog human text replaces the message (the original
 * is kept in rawMessage); unknown selectors keep the original message but
 * still expose the selector via errorName.
 */
function withDecodedError(error: any, iface: ethers.utils.Interface | undefined, base: ClassifiedError): ClassifiedError {
  const decoded = decodeContractError(error, iface);
  if (!decoded) return base;
  if (decoded.name.startsWith('UnknownCustomError(')) {
    return { ...base, errorName: decoded.name };
  }
  return {
    message: decoded.human,
    code: base.code,
    errorName: decoded.name,
    errorArgs: decoded.args,
    suggestion: decoded.suggestion,
    rawMessage: base.message,
  };
}

/**
 * Map a raw ethers/provider error to a stable error code + human message.
 * When an interface is provided, revert data is decoded against it (then
 * against the global ABI error registry) on the TX_REVERTED and
 * GAS_ESTIMATION_FAILED paths.
 */
export function classifyError(error: any, iface?: ethers.utils.Interface): ClassifiedError {
  error = error ?? {};
  const msg = error.message || 'Transaction failed';

  if (error.code === 'INSUFFICIENT_FUNDS' || msg.includes('insufficient funds')) {
    return { message: 'Insufficient funds for gas + value', code: 'INSUFFICIENT_FUNDS' };
  }
  if (error.code === 'ACTION_REJECTED' || msg.includes('user rejected')) {
    return { message: 'Transaction rejected by user', code: 'USER_REJECTED' };
  }
  if (error.code === 'UNPREDICTABLE_GAS_LIMIT' || msg.includes('cannot estimate gas')) {
    const reason = error.reason || error.error?.reason || error.error?.message || msg;
    return withDecodedError(error, iface, {
      message: `Transaction would revert: ${reason}`,
      code: 'GAS_ESTIMATION_FAILED',
    });
  }
  if (error.code === 'NETWORK_ERROR' || error.code === 'SERVER_ERROR' || msg.includes('ECONNREFUSED')) {
    return { message: `Network error: ${msg}`, code: 'NETWORK_ERROR' };
  }
  if (error.reason) {
    return withDecodedError(error, iface, { message: `Reverted: ${error.reason}`, code: 'TX_REVERTED' });
  }
  if (error.error?.message) {
    return withDecodedError(error, iface, { message: error.error.message, code: 'TX_REVERTED' });
  }
  return { message: msg, code: 'UNKNOWN_ERROR' };
}

/**
 * ERC-4337 EntryPoint events needed to detect inner UserOp failures.
 * Topic 0 of UserOperationEvent:
 *   0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f
 */
const ENTRY_POINT_EVENTS = USER_OPERATION_EVENTS;

/** Error(string) selector — unwrap to the plain revert string */
const ERROR_STRING_SELECTOR = '0x08c379a0';

/**
 * Turn raw revert bytes (e.g. UserOperationRevertReason.revertReason) into a
 * human message: unwraps Error(string), otherwise decodes custom errors via
 * the error catalog. Returns null when the bytes are empty/undecodable.
 */
function describeRevertData(
  data: string,
  iface?: ethers.utils.Interface
): { message: string; name?: string; suggestion?: string } | null {
  if (typeof data !== 'string' || !data.startsWith('0x') || data.length < 10) return null;
  if (data.slice(0, 10).toLowerCase() === ERROR_STRING_SELECTOR) {
    try {
      const [reason] = ethers.utils.defaultAbiCoder.decode(['string'], '0x' + data.slice(10));
      return { message: `Reverted: ${reason}` };
    } catch {
      return null;
    }
  }
  const decoded = decodeContractError({ data }, iface);
  if (!decoded) return null;
  return { message: decoded.human, name: decoded.name, suggestion: decoded.suggestion };
}

/**
 * ERC-4337 critical check: the outer bundler tx ALWAYS has status=1, even
 * when the inner UserOp call reverts. The actual success/failure of the
 * inner call is in the UserOperationEvent log emitted by the EntryPoint.
 * Returns a failure TxResult when the inner call reverted (decoding the
 * UserOperationRevertReason payload for a human message), else null.
 */
export function detectUserOpFailure(
  receipt: ethers.providers.TransactionReceipt,
  txHash: string,
  chainId: number,
  iface?: ethers.utils.Interface,
  expected?: UserOperationExpectation
): TxResult | null {
  if (expected) {
    const outcome = decodeUserOperationOutcome(receipt, expected);
    if (outcome.status === 'succeeded') return null;
    const detail = outcome.revertReason ? describeRevertData(outcome.revertReason, iface) : null;
    return { success: false, txHash, sponsored: true, userOpHash: expected.userOpHash, outcome, receipt,
      explorerUrl: buildExplorerUrl(txHash, chainId), errorCode: outcome.status === 'failed' ? 'TX_REVERTED' : 'UNKNOWN_ERROR',
      error: outcome.status === 'failed' ? `Sponsored UserOp inner call reverted.${detail ? ` Reason: ${detail.message}` : ''}` : `Sponsored outcome unknown: ${outcome.code}`,
      errorName: detail?.name, suggestion: detail?.suggestion };
  }
  const userOpTopic = ENTRY_POINT_EVENTS.getEventTopic('UserOperationEvent');
  const userOpLog = receipt.logs.find((log) => log.topics[0] === userOpTopic);
  if (!userOpLog) return null;

  let innerSuccess: boolean;
  try {
    innerSuccess = ENTRY_POINT_EVENTS.parseLog(userOpLog).args.success as boolean;
  } catch {
    return null; // Unparseable event — assume success rather than false-alarm
  }
  if (innerSuccess) return null;

  // Inner call failed — look for UserOperationRevertReason for detail
  const revertTopic = ENTRY_POINT_EVENTS.getEventTopic('UserOperationRevertReason');
  const revertLog = receipt.logs.find((log) => log.topics[0] === revertTopic);
  let detail = revertLog ? ` Revert data available in tx ${txHash}` : '';
  let errorName: string | undefined;
  let suggestion: string | undefined;

  if (revertLog) {
    try {
      const revertReason = ENTRY_POINT_EVENTS.parseLog(revertLog).args.revertReason as string;
      const described = describeRevertData(revertReason, iface);
      if (described) {
        detail = ` Reason: ${described.message}`;
        errorName = described.name;
        suggestion = described.suggestion;
      }
    } catch {
      // Keep the generic detail
    }
  }

  return {
    success: false,
    txHash,
    explorerUrl: buildExplorerUrl(txHash, chainId),
    error: `Sponsored UserOp inner call reverted (tx succeeded but execution failed).${detail}`,
    errorCode: 'TX_REVERTED',
    errorName,
    suggestion,
    sponsored: true,
  };
}

/**
 * Try to send a transaction via EIP-7702 gas sponsorship.
 * Returns null only when no sponsored request was submitted.
 */
async function trySponsoredTx(
  contract: ethers.Contract,
  method: string,
  args: any[],
  config: SponsoredConfig,
  options: TxOptions
): Promise<TxResult | null> {
  // All checks before calling sendSponsored establish non-submission.
  let adapter: SponsoredExecutionAdapter;
  let chainId: number;
  let calldata: Hex;
  try {
    if (options.sponsoredAdapterLoader) adapter = await options.sponsoredAdapterLoader();
    else if (options.sponsoredAdapter) adapter = options.sponsoredAdapter;
    else {
      const loaded = require('./sponsored') as typeof import('./sponsored');
      adapter = { ...loaded, entryPoint: loaded.ENTRY_POINT };
    }
    chainId = (await contract.provider.getNetwork()).chainId;
    if (!options.sponsoredAdapter && !options.sponsoredAdapterLoader && chainId !== 100) return null; // Current 7702 deployment is Gnosis-only.
    if (!await adapter.isDelegated(await contract.signer.getAddress() as Address, options.sponsoredSend?.rpcUrl)) return null;
    calldata = contract.interface.encodeFunctionData(method, args) as Hex;
  } catch { return null; }

  let submission: SponsoredSubmission = { phase: 'submitting', entryPoint: adapter.entryPoint, chainId };
  let acceptanceObserved = false;
  try {
    const result = await adapter.sendSponsored(config.privateKey, contract.address as Address, calldata, config.orgId, config.hatId, {
      ...options.sponsoredSend,
      value: options.value ? BigInt(options.value.toString()) : options.sponsoredSend?.value,
      onSubmitted: async observed => {
        acceptanceObserved = true;
        submission = { ...observed };
        await options.sponsoredSend?.onSubmitted?.(observed);
      },
    });
    if (!/^0x[\da-fA-F]{64}$/.test(result?.userOpHash) || !/^0x[\da-fA-F]{64}$/.test(result?.txHash)) throw new Error('Ambiguous sponsored response');
    submission = { ...submission, phase: 'receipt', userOpHash: result.userOpHash, txHash: result.txHash };
    if (submission.computedHash && submission.computedHash.toLowerCase() !== result.userOpHash.toLowerCase()) throw new Error('Bundler operation hash does not match computed hash');
    const receipt = await contract.provider.getTransactionReceipt(result.txHash);
    const expected = { userOpHash: result.userOpHash, entryPoint: adapter.entryPoint, sender: await contract.signer.getAddress(), nonce: submission.nonce };
    const outcome = decodeUserOperationOutcome(receipt, expected);
    if (outcome.status !== 'succeeded') {
      if (receipt) return { ...detectUserOpFailure(receipt, result.txHash, chainId, contract.interface, expected)!, submission };
      return { success: false, txHash: result.txHash, userOpHash: result.userOpHash, sponsored: true, submission, outcome, errorCode: 'UNKNOWN_ERROR', error: 'Sponsored operation outcome is unknown; reconcile by hash.' };
    }
    let scopedReceipt: ethers.providers.TransactionReceipt = { ...receipt!, logs: [] };
    let logScope: 'operation' | 'unknown' = 'unknown';
    try {
      const transaction = await contract.provider.getTransaction(result.txHash);
      if (!transaction) throw new Error('OPERATION_TRANSACTION_UNAVAILABLE');
      const logs = isolateUserOperationReceiptLogs({ transaction, receipt: receipt!, chainId,
        expected: { userOpHash: result.userOpHash, entryPoint: adapter.entryPoint,
          sender: await contract.signer.getAddress(), nonce: submission.nonce, target: contract.address, data: calldata } });
      scopedReceipt = { ...receipt!, logs: [...logs] }; logScope = 'operation';
    } catch { /* Success is known; unproven event scope must not invent domain IDs. */ }
    return { success: true, txHash: result.txHash, userOpHash: result.userOpHash, submission, outcome,
      blockNumber: receipt!.blockNumber, gasUsed: receipt!.gasUsed?.toString(), explorerUrl: buildExplorerUrl(result.txHash, chainId),
      logs: parseEventLogs(scopedReceipt, contract.interface, contract.address), receipt: scopedReceipt, outerReceipt: receipt!, logScope, sponsored: true };
  } catch (error) {
    if (error instanceof SponsoredSubmissionError) {
      if (!acceptanceObserved && error.submission.phase === 'pre-submit') return null;
      if (error.submission.phase !== 'pre-submit') submission = error.submission;
    }
    return { success: false, sponsored: true, submission, txHash: submission.txHash,
      userOpHash: submission.computedHash ?? submission.userOpHash,
      outcome: { status: 'unknown', code: 'SUBMISSION_UNCERTAIN', userOpHash: submission.computedHash ?? submission.userOpHash ?? '', entryPoint: submission.entryPoint },
      errorCode: 'UNKNOWN_ERROR', error: error instanceof Error ? error.message : 'Sponsored submission is uncertain; reconcile without resubmitting.' };
  }
}

/**
 * Execute a contract method.
 * In dry-run mode: estimates gas and encodes calldata without sending.
 * When sponsored config is provided and the EOA is delegated, routes through
 * the PaymasterHub for gas sponsorship. Falls back to direct EOA tx if
 * sponsorship is established to be unavailable before submission.
 * Returns parsed event logs so callers can extract entity IDs.
 */
export async function executeContractTx(
  contract: ethers.Contract,
  method: string,
  args: any[],
  options: TxOptions = {}
): Promise<TxResult> {
  try {
    // Estimate gas first (also validates the tx would succeed)
    const gasEstimate = await contract.estimateGas[method](...args, {
      value: options.value,
    });

    if (options.dryRun) {
      const calldata = contract.interface.encodeFunctionData(method, args);
      return {
        success: true,
        dryRun: true,
        gasEstimate: gasEstimate.toString(),
        calldata,
        to: contract.address,
        method,
        txHash: options.legacyDryRunTxHash
          ? `dry-run:${calldata.slice(0, 20)}...`
          : undefined,
      };
    }

    // Try sponsored tx when explicit config is provided (core never reads env —
    // the CLI resolves POP_PRIVATE_KEY/POP_ORG_ID/… into options.sponsored).
    // Thunks resolve here, inside the try, after the dry-run return above.
    const sponsoredConfig = typeof options.sponsored === 'function'
      ? options.sponsored()
      : options.sponsored;
    if (sponsoredConfig) {
      // The signer is the account the host authorized. A transport-configured
      // wallet must never silently substitute a different sending account.
      if (new ethers.Wallet(sponsoredConfig.privateKey).address.toLowerCase() !== (await contract.signer.getAddress()).toLowerCase()) {
        return { success: false, errorCode: 'USER_REJECTED', error: 'Sponsored signing key does not match the authorized transaction signer.',
          suggestion: 'Use a sponsorship key for the authorized signer or disable sponsorship for this action.' };
      }
      const sponsoredResult = await trySponsoredTx(contract, method, args, sponsoredConfig, options);
      if (sponsoredResult) {
        return sponsoredResult;
      }
      // Fall through to direct tx
    }

    // Send transaction (direct EOA)
    const tx = await contract[method](...args, {
      gasLimit: options.gasLimit || gasEstimate.mul(120).div(100),
      value: options.value,
    });

    // Wait for confirmation
    const receipt = await tx.wait(1);
    const chainId = await contract.provider.getNetwork().then(n => n.chainId);

    return {
      success: true,
      txHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      explorerUrl: buildExplorerUrl(receipt.transactionHash, chainId),
      logs: parseEventLogs(receipt, contract.interface, contract.address),
      receipt,
    };
  } catch (error: any) {
    // Pass the contract interface so custom-error revert data is decoded into a
    // human message + suggestion, and propagate every classified field so
    // callers (e.g. the CLI's finishWrite) can surface the catalog name/hint
    // (not just the raw message).
    const classified = classifyError(error, contract.interface);
    return {
      success: false,
      error: classified.message,
      errorCode: classified.code,
      errorName: classified.errorName,
      errorArgs: classified.errorArgs,
      suggestion: classified.suggestion,
      rawMessage: classified.rawMessage,
    };
  }
}

/**
 * Execute a TxIntent with an ethers signer.
 * Thin adapter over executeContractTx: constructs the contract from the
 * intent's resolved address + ABI, and merges the intent's native value into
 * the tx options (an explicit options.value wins).
 */
export async function executeIntent(
  signer: ethers.Signer,
  intent: TxIntent,
  options: TxOptions = {}
): Promise<TxResult> {
  const contract = new ethers.Contract(intent.to, intent.abi, signer);
  const value =
    options.value ??
    (intent.value !== undefined ? ethers.BigNumber.from(intent.value) : undefined);
  return executeContractTx(contract, intent.method, intent.args as any[], { ...options, value });
}
