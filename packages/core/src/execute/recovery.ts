/** Durable submission identity and recovery. Storage, locks, clocks and transports belong to the host. */
import { keccak256 } from '@ethersproject/keccak256';
import { toUtf8Bytes } from '@ethersproject/strings';
import { requireRawUint, RawUintInput } from '../amounts';
import { decodeUserOperationOutcome, OperationReceipt, UserOperationExpectation, UserOperationOutcome } from './outcome';

export interface SubmissionScope {
  chainId: number;
  accountAddress: string;
  /** Digests only: no calldata, credential, signature, RPC URL or session secret. */
  intentKey: string;
  sessionKey: string;
  contextKey: string;
}
export type RecoveryPhase = 'intent' | 'signing' | 'prepared' | 'submitting' | 'submitted' | 'unresolved' | 'succeeded' | 'failed' | 'replaced' | 'aborted';
export interface SubmissionRecoveryRecord {
  version: 2;
  scope: SubmissionScope;
  ownerId: string;
  attemptId: string;
  revision: number;
  phase: RecoveryPhase;
  kind?: 'transaction' | 'user-operation';
  nonce?: string;
  entryPoint?: string;
  computedHash?: string;
  txHash?: string;
  /** Exact EOA call digest, separate from the full logical/batch intent. */
  callKey?: string;
  /** A bounded search begins at the block observed before send, never at genesis. */
  fromBlock?: string;
}
export interface SubmissionFence {
  scope: SubmissionScope;
  ownerId: string;
  attemptId: string;
  revision: number;
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const addr = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
const terminal = new Set<RecoveryPhase>(['succeeded', 'failed', 'replaced', 'aborted']);
const phases: RecoveryPhase[] = ['intent', 'signing', 'prepared', 'submitting', 'submitted', 'unresolved', 'succeeded', 'failed', 'replaced', 'aborted'];

export function normalizeSubmissionScope(scope: SubmissionScope): SubmissionScope {
  if (!Number.isSafeInteger(scope.chainId) || scope.chainId <= 0 || !addr(scope.accountAddress)
    || !hash(scope.intentKey) || !hash(scope.sessionKey) || !hash(scope.contextKey)) throw new Error('Invalid submission scope');
  return { chainId: scope.chainId, accountAddress: scope.accountAddress.toLowerCase(), intentKey: scope.intentKey.toLowerCase(), sessionKey: scope.sessionKey.toLowerCase(), contextKey: scope.contextKey.toLowerCase() };
}
export function sameSubmissionScope(a: SubmissionScope, b: SubmissionScope): boolean {
  return JSON.stringify(normalizeSubmissionScope(a)) === JSON.stringify(normalizeSubmissionScope(b));
}
/** Canonical call identity excludes gas, fee and signature so equivalent fee replacements can settle. */
export function submissionIntentKey(calls: readonly { to: string; data: string; value?: RawUintInput }[]): string {
  if (!calls.length) throw new Error('Empty submission intent');
  return keccak256(toUtf8Bytes(JSON.stringify(calls.map(call => {
    if (!addr(call.to) || typeof call.data !== 'string' || !/^0x(?:[\da-f]{2})*$/i.test(call.data)) throw new Error('Invalid submission call');
    return [call.to.toLowerCase(), call.data.toLowerCase(), requireRawUint(call.value ?? '0')];
  }))));
}
/** Allowlist copy is also the persistence codec. Unknown properties are never persisted. */
export function normalizeSubmissionRecovery(record: SubmissionRecoveryRecord): SubmissionRecoveryRecord {
  const scope = normalizeSubmissionScope(record.scope);
  if (record.version !== 2 || !id(record.ownerId) || !id(record.attemptId) || !Number.isSafeInteger(record.revision)
    || record.revision < 0 || !phases.includes(record.phase)) throw new Error('Invalid submission record');
  const result: SubmissionRecoveryRecord = { version: 2, scope, ownerId: record.ownerId, attemptId: record.attemptId, revision: record.revision, phase: record.phase };
  if (record.kind !== undefined) {
    if (!['transaction', 'user-operation'].includes(record.kind)) throw new Error('Invalid submission kind');
    result.kind = record.kind;
  }
  if (record.nonce !== undefined) result.nonce = requireRawUint(record.nonce);
  if (record.fromBlock !== undefined) result.fromBlock = requireRawUint(record.fromBlock);
  for (const key of ['computedHash', 'txHash', 'callKey'] as const) {
    if (record[key] !== undefined) { if (!hash(record[key])) throw new Error('Invalid submission hash'); result[key] = record[key]!.toLowerCase(); }
  }
  if (record.entryPoint !== undefined) { if (!addr(record.entryPoint)) throw new Error('Invalid EntryPoint'); result.entryPoint = record.entryPoint.toLowerCase(); }
  if (!['intent', 'signing', 'aborted'].includes(result.phase)) {
    if (result.nonce === undefined || !result.kind) throw new Error('Missing submission identity');
    if (result.kind === 'user-operation' && (!result.computedHash || !result.entryPoint)) throw new Error('Missing operation identity');
    if (result.kind === 'transaction' && !result.callKey) throw new Error('Missing transaction intent');
    if (result.phase === 'submitted' && result.kind === 'transaction' && !result.txHash) throw new Error('Missing transaction hash');
  }
  return result;
}
export function createSubmissionRecovery(scope: SubmissionScope, ownerId: string, attemptId: string): SubmissionRecoveryRecord {
  return normalizeSubmissionRecovery({ version: 2, scope, ownerId, attemptId, revision: 0, phase: 'intent' });
}
export function assertSubmissionFence(record: SubmissionRecoveryRecord, fence: SubmissionFence): void {
  if (!sameSubmissionScope(record.scope, fence.scope) || record.ownerId !== fence.ownerId || record.attemptId !== fence.attemptId
    || record.revision !== fence.revision) throw new Error('Stale submission owner or scope');
}
export type SubmissionRecoveryEvent =
  | { type: 'signing' }
  | { type: 'prepare'; kind: 'transaction' | 'user-operation'; nonce: string; entryPoint?: string; computedHash?: string; callKey?: string; fromBlock?: string }
  | { type: 'broadcast' }
  | { type: 'acknowledge'; txHash?: string }
  | { type: 'unresolved' }
  | { type: 'settle'; status: 'succeeded' | 'failed' | 'replaced' }
  | { type: 'abort' };
/** No timeout event exists. Only a fenced pre-broadcast owner can abort. Receipt recovery is separate. */
export function transitionSubmissionRecovery(record: SubmissionRecoveryRecord, fence: SubmissionFence, event: SubmissionRecoveryEvent): SubmissionRecoveryRecord {
  record = normalizeSubmissionRecovery(record);
  assertSubmissionFence(record, fence);
  if (terminal.has(record.phase)) throw new Error('Submission is already terminal');
  const next = { ...record, revision: record.revision + 1 };
  switch (event.type) {
    case 'signing':
      if (record.phase !== 'intent') throw new Error('Invalid signing transition');
      next.phase = 'signing'; break;
    case 'prepare':
      if (!['intent', 'signing'].includes(record.phase)) throw new Error('Cannot replace prepared identity');
      Object.assign(next, event); delete (next as any).type; next.phase = 'prepared'; break;
    case 'broadcast':
      if (record.phase !== 'prepared') throw new Error('Submission is not prepared');
      next.phase = 'submitting'; break;
    case 'acknowledge':
      if (record.phase !== 'submitting') throw new Error('Submission was not sent');
      if (event.txHash !== undefined) next.txHash = event.txHash;
      next.phase = 'submitted'; break;
    case 'unresolved':
      if (!['submitting', 'submitted', 'unresolved'].includes(record.phase)) throw new Error('Submission was not sent');
      next.phase = 'unresolved'; break;
    case 'settle':
      if (!['submitting', 'submitted', 'unresolved'].includes(record.phase)) throw new Error('Submission was not sent');
      next.phase = event.status; break;
    case 'abort':
      if (!canAbandonSubmissionRecovery(record)) throw new Error('Broadcast may have occurred');
      next.phase = 'aborted'; break;
  }
  return normalizeSubmissionRecovery(next);
}
/** Host must also hold the exact exclusive lock. A lease age or expired timer is never sufficient. */
export function canAbandonSubmissionRecovery(record: SubmissionRecoveryRecord): boolean {
  normalizeSubmissionRecovery(record);
  return ['intent', 'signing', 'prepared'].includes(record.phase);
}
export interface RecoveryTransaction {
  hash: string; from: string; nonce: RawUintInput; to?: string | null; input?: string; data?: string; value: RawUintInput;
  chainId?: RawUintInput;
  blockNumber?: RawUintInput | null;
  blockHash?: string | null;
}
export interface RecoveryReceipt extends OperationReceipt {
  blockNumber?: RawUintInput | null;
  blockHash?: string | null;
}
export interface RecoveryBlock {
  number: RawUintInput;
  hash: string;
}
export interface SubmissionRecoveryReaders {
  getChainId(): Promise<number>;
  getTransactionReceipt(hash: string): Promise<RecoveryReceipt | null>;
  /** Required to settle EOA recovery, including an already saved hash. */
  getTransaction?(hash: string): Promise<RecoveryTransaction | null>;
  /** Canonical number lookup, never an orphan block lookup by hash. */
  getBlock?(blockNumber: string): Promise<RecoveryBlock | null>;
  getUserOperationReceipt?(hash: string): Promise<{ transactionHash: string } | null>;
  getBlockNumber?(): Promise<RawUintInput>;
  getBlockTransactions?(blockNumber: string): Promise<readonly RecoveryTransaction[]>;
}
export interface SubmissionRecoveryOutcome extends Partial<Omit<UserOperationOutcome, 'status'>> {
  status: 'succeeded' | 'failed' | 'replaced' | 'unknown';
  code?: string;
  txHash?: string;
}
export interface SubmissionRecoveryResult {
  record: SubmissionRecoveryRecord;
  outcome: SubmissionRecoveryOutcome;
  receipt?: RecoveryReceipt;
}
export interface SubmissionRecoveryOptions {
  maxBlocks?: number;
  /** Explicit read-only candidate after the prefix window; never rewrites saved identity or sends. */
  candidateTxHash?: string;
}
/** Exact mined nonce evidence can establish a fee replacement or a different action consuming that nonce. */
export function evaluateEoaRecoveryCandidate(record: SubmissionRecoveryRecord, transaction: RecoveryTransaction, receipt: RecoveryReceipt): SubmissionRecoveryOutcome {
  record = normalizeSubmissionRecovery(record);
  try {
    if (record.kind !== 'transaction' || !['submitting', 'submitted', 'unresolved'].includes(record.phase)
      || transaction.from?.toLowerCase() !== record.scope.accountAddress || requireRawUint(transaction.nonce) !== record.nonce
      || transaction.chainId === undefined || requireRawUint(transaction.chainId) !== String(record.scope.chainId)
      || !hash(transaction.hash) || receipt.transactionHash?.toLowerCase() !== transaction.hash.toLowerCase()) return { status: 'unknown', code: 'TRANSACTION_IDENTITY_MISMATCH' };
    if (!hash(transaction.blockHash) || !hash(receipt.blockHash) || transaction.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()
      || transaction.blockNumber == null || receipt.blockNumber == null
      || requireRawUint(transaction.blockNumber) !== requireRawUint(receipt.blockNumber)) return { status: 'unknown', code: 'TRANSACTION_INCLUSION_MISMATCH' };
    const succeeded = [1, 1n, '1', '0x1'].includes(receipt.status!);
    const failed = [0, 0n, '0', '0x0'].includes(receipt.status!);
    if (!succeeded && !failed) return { status: 'unknown', code: 'INVALID_RECEIPT_STATUS' };
    // Missing or conflicting input is not proof of either the original call or a replacement.
    if ((transaction.input === undefined && transaction.data === undefined)
      || (transaction.input !== undefined && transaction.data !== undefined && transaction.input.toLowerCase() !== transaction.data.toLowerCase())) return { status: 'unknown', code: 'TRANSACTION_CALL_UNAVAILABLE' };
    if ((transaction.to !== null && !addr(transaction.to)) || !/^0x(?:[\da-f]{2})*$/i.test((transaction.input ?? transaction.data)!)) return { status: 'unknown', code: 'TRANSACTION_CALL_UNAVAILABLE' };
    requireRawUint(transaction.value);
    const sameCall = !!transaction.to && submissionIntentKey([{ to: transaction.to, data: (transaction.input ?? transaction.data)!, value: transaction.value }]) === record.callKey;
    return { status: sameCall ? succeeded ? 'succeeded' : 'failed' : 'replaced', txHash: transaction.hash };
  } catch { return { status: 'unknown', code: 'TRANSACTION_IDENTITY_MISMATCH' }; }
}
/** An unrelated reverted outer transaction cannot settle the expected operation. */
export function decodeReceiptBoundUserOperationOutcome(receipt: OperationReceipt | null | undefined, expected: UserOperationExpectation): UserOperationOutcome {
  const base = decodeUserOperationOutcome(null, expected);
  if (!receipt || !hash(receipt.transactionHash)) return { ...base, code: 'MISSING_TRANSACTION_HASH' };
  if (receipt.status === undefined) return { ...base, code: 'MISSING_RECEIPT_STATUS' };
  const bound = decodeUserOperationOutcome({ ...receipt, status: 1 }, expected);
  return bound.status === 'unknown' ? bound : decodeUserOperationOutcome(receipt, expected);
}
/** Bounded, injected readonly reads. Absence/dropped/pending/replaced-but-unmined never authorizes resubmission. */
export async function reconcileSubmissionRecovery(record: SubmissionRecoveryRecord, readers: SubmissionRecoveryReaders, options: SubmissionRecoveryOptions = {}): Promise<SubmissionRecoveryResult> {
  record = normalizeSubmissionRecovery(record);
  const unknown = (code: string): SubmissionRecoveryResult => ({ record, outcome: { status: 'unknown', code } });
  const maxBlocks = options.maxBlocks ?? 16;
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 64) throw new Error('Invalid recovery block bound');
  if (options.candidateTxHash !== undefined && (!hash(options.candidateTxHash) || record.kind !== 'transaction')) throw new Error('Invalid exact recovery candidate');
  try {
    if (await readers.getChainId() !== record.scope.chainId) return unknown('CHAIN_MISMATCH');
    if (!['submitting', 'submitted', 'unresolved'].includes(record.phase)) return unknown('NOT_BROADCAST');
    let txHash = options.candidateTxHash ?? record.txHash;
    let receipt: RecoveryReceipt | null = null;
    if (record.kind === 'transaction' && txHash) {
      try { receipt = await readers.getTransactionReceipt(txHash); } catch { /* Try the bounded exact-nonce evidence path. */ }
      if (!receipt) {
        if (options.candidateTxHash) return unknown('RECEIPT_UNAVAILABLE');
        txHash = undefined;
      }
    }
    if (record.kind === 'user-operation') {
      if (!txHash) txHash = (await readers.getUserOperationReceipt?.(record.computedHash!))?.transactionHash;
    } else if (!txHash) {
      if (record.fromBlock === undefined || !readers.getBlockNumber || !readers.getBlockTransactions) return unknown('HASH_UNAVAILABLE');
      const last = BigInt(requireRawUint(await readers.getBlockNumber()));
      const first = BigInt(record.fromBlock);
      if (last < first) return unknown('RECOVERY_BLOCK_NOT_AVAILABLE');
      // Scan only the captured prefix. A limit hit remains explicitly unresolved if no exact nonce is found.
      const end = last < first + BigInt(maxBlocks - 1) ? last : first + BigInt(maxBlocks - 1);
      let match: RecoveryTransaction | undefined;
      for (let block = first; block <= end && !match; block++) {
        const rows = await readers.getBlockTransactions(block.toString());
        const matches = rows.filter(tx => tx.from?.toLowerCase() === record.scope.accountAddress && requireRawUint(tx.nonce) === record.nonce);
        if (matches.length > 1) return unknown('CONFLICTING_NONCE_EVIDENCE');
        match = matches[0];
      }
      if (!match) return unknown(last > end ? 'RECOVERY_WINDOW_EXCEEDED' : 'NONCE_NOT_MINED');
      txHash = match.hash;
    }
    if (!hash(txHash)) return unknown('HASH_UNAVAILABLE');
    receipt = receipt ?? await readers.getTransactionReceipt(txHash);
    if (!receipt || receipt.transactionHash?.toLowerCase() !== txHash.toLowerCase() || receipt.status === undefined) return unknown('RECEIPT_UNAVAILABLE');
    if (record.kind === 'user-operation') {
      const outcome = decodeReceiptBoundUserOperationOutcome(receipt, { userOpHash: record.computedHash!, entryPoint: record.entryPoint!, sender: record.scope.accountAddress, nonce: record.nonce });
      return { record, receipt, outcome: { ...outcome, txHash } };
    }
    if (!readers.getTransaction || !readers.getBlock) return unknown('TRANSACTION_READERS_UNAVAILABLE');
    const transaction = await readers.getTransaction(txHash);
    if (!transaction || transaction.hash?.toLowerCase() !== txHash.toLowerCase()) return unknown('TRANSACTION_IDENTITY_MISMATCH');
    const outcome = evaluateEoaRecoveryCandidate(record, transaction, receipt);
    if (outcome.status === 'unknown') return { record, receipt, outcome };
    const number = requireRawUint(receipt.blockNumber!);
    // Check canonical inclusion twice around the final receipt observation. Provider observations,
    // not light-client proofs; host selects confirmation depth and a trustworthy endpoint.
    const canonical = (block: RecoveryBlock | null) => !!block && requireRawUint(block.number) === number
      && hash(block.hash) && block.hash.toLowerCase() === receipt!.blockHash!.toLowerCase();
    if (!canonical(await readers.getBlock(number))) return unknown('NONCANONICAL_TRANSACTION_INCLUSION');
    const closingReceipt = await readers.getTransactionReceipt(txHash);
    if (!closingReceipt || evaluateEoaRecoveryCandidate(record, transaction, closingReceipt).status !== outcome.status
      || closingReceipt.blockHash?.toLowerCase() !== receipt.blockHash!.toLowerCase()
      || !canonical(await readers.getBlock(number)) || await readers.getChainId() !== record.scope.chainId) return unknown('RECOVERY_EVIDENCE_CHANGED');
    return { record, receipt: closingReceipt, outcome };
  } catch { return unknown('RECOVERY_READ_FAILED'); }
}
