import { ethers } from 'ethers';
import { requireRawUint } from '@poa-box/core/amounts';
import { ENTRY_POINT } from '@poa-box/core/accounts/constants';
import { isolateUserOperationReceiptLogs } from '@poa-box/core/reads/provenance';
import { submissionIntentKey } from '@poa-box/core/execute/recovery';
import type { RecoveryReceipt, SubmissionRecoveryEvent, SubmissionRecoveryReaders, SubmissionRecoveryRecord } from '@poa-box/core/execute/recovery';
import type { AccountSendResult, PreparedAccountCall } from '../wallet';
import { refuse } from './shared';

/** Digest/nonce/hash identity only. Never persist a signed operation or assertion. */
export function preparedSubmissionEvent(prepared: PreparedAccountCall, callKey: string): SubmissionRecoveryEvent {
  if (submissionIntentKey([prepared.call]) !== callKey) refuse('WALLET_PREPARATION_MISMATCH');
  if (prepared.kind === 'user-operation') {
    if (prepared.entryPoint.toLowerCase() !== ENTRY_POINT.toLowerCase()
      || !/^0x[\da-f]{64}$/i.test(prepared.computedHash)) refuse('USER_OPERATION_IDENTITY_REQUIRED');
    return { type: 'prepare', kind: 'user-operation', nonce: prepared.nonce, fromBlock: prepared.fromBlock,
      entryPoint: prepared.entryPoint, computedHash: prepared.computedHash };
  }
  if (prepared.kind !== undefined && prepared.kind !== 'transaction') refuse('UNSUPPORTED_ACCOUNT_TRANSPORT');
  return { type: 'prepare', kind: 'transaction', nonce: prepared.nonce, fromBlock: prepared.fromBlock, callKey };
}
export function submissionAcknowledgement(prepared: PreparedAccountCall, receipt: AccountSendResult): {
  event: SubmissionRecoveryEvent; identity: { txHash: string } | { userOpHash: string; computedHash: string; entryPoint: string };
} {
  if (prepared.kind === 'user-operation') {
    if (receipt.kind !== 'user-operation' || receipt.userOpHash.toLowerCase() !== prepared.computedHash.toLowerCase()
      || receipt.computedHash.toLowerCase() !== prepared.computedHash.toLowerCase()) refuse('USER_OPERATION_ACKNOWLEDGEMENT_MISMATCH', 'unknown');
    return { event: { type: 'acknowledge' }, identity: { userOpHash: prepared.computedHash, computedHash: prepared.computedHash, entryPoint: prepared.entryPoint } };
  }
  if (receipt.kind === 'user-operation' || !/^0x[\da-f]{64}$/i.test(receipt.txHash)) refuse('TRANSACTION_ACKNOWLEDGEMENT_MISMATCH', 'unknown');
  return { event: { type: 'acknowledge', txHash: receipt.txHash }, identity: { txHash: receipt.txHash } };
}
export function exactSubmissionOperation(record: SubmissionRecoveryRecord) {
  return record.kind === 'user-operation' ? { userOpHash: record.computedHash!, sender: record.scope.accountAddress,
    nonce: record.nonce!, entryPoint: record.entryPoint! } : undefined;
}
export function recoveryCandidateOptions(record: SubmissionRecoveryRecord, candidateTxHash?: string, candidateUserOpHash?: string) {
  if (record.kind === 'user-operation') {
    if (candidateTxHash) refuse('TRANSACTION_CANDIDATE_FOR_USER_OPERATION');
    if (candidateUserOpHash !== undefined && candidateUserOpHash.toLowerCase() !== record.computedHash?.toLowerCase())
      refuse('USER_OPERATION_CANDIDATE_MISMATCH');
    return { maxBlocks: 16 };
  }
  if (candidateUserOpHash) refuse('USER_OPERATION_CANDIDATE_FOR_TRANSACTION');
  return { maxBlocks: 16, ...(candidateTxHash ? { candidateTxHash } : {}) };
}

/** Core recovery proves canonical inclusion and the exact inner success event.
 * Domain IDs additionally require the selected operation's complete execution
 * log window: another bundled operation must never supply a creation event. */
export async function isolateSubmissionReceipt(record: SubmissionRecoveryRecord, receipt: RecoveryReceipt,
  readers: SubmissionRecoveryReaders, callKey: string, callValue = '0'): Promise<RecoveryReceipt> {
  if (record.kind !== 'user-operation') return receipt;
  if (!readers.getTransaction || !receipt.transactionHash || !receipt.logs || receipt.blockNumber == null || !receipt.blockHash)
    refuse('USER_OPERATION_RECEIPT_READERS_REQUIRED', 'unknown');
  if (record.entryPoint?.toLowerCase() !== ENTRY_POINT.toLowerCase()) refuse('UNSUPPORTED_USER_OPERATION_ENTRYPOINT', 'unknown');
  const transaction = await readers.getTransaction(receipt.transactionHash);
  if (!transaction || !transaction.to || transaction.hash.toLowerCase() !== receipt.transactionHash.toLowerCase()
    || transaction.blockNumber == null || requireRawUint(transaction.blockNumber) !== requireRawUint(receipt.blockNumber)
    || transaction.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase()
    || transaction.chainId === undefined || requireRawUint(transaction.chainId) !== String(record.scope.chainId)
    || (transaction.data !== undefined && transaction.input !== undefined && transaction.data.toLowerCase() !== transaction.input.toLowerCase()))
    refuse('USER_OPERATION_TRANSACTION_SCOPE_MISMATCH', 'unknown');
  const logs = receipt.logs.map(log => {
    const index = (log as { logIndex?: number }).logIndex;
    if (!Number.isSafeInteger(index) || index! < 0) refuse('USER_OPERATION_LOG_ORDER_REQUIRED', 'unknown');
    return { ...log, topics: [...log.topics], logIndex: index!, blockNumber: Number(requireRawUint(receipt.blockNumber!)),
      blockHash: receipt.blockHash!, transactionHash: receipt.transactionHash!, transactionIndex: 0, removed: false };
  });
  // The core helper consumes receipt identity, status, and logs only. Ethers'
  // unrelated fee/confirmation fields are not fabricated as evidence here.
  const isolated = isolateUserOperationReceiptLogs({
    transaction: { hash: transaction.hash, from: transaction.from, to: transaction.to,
      data: transaction.data ?? transaction.input ?? '0x', value: ethers.BigNumber.from(requireRawUint(transaction.value)), chainId: record.scope.chainId },
    receipt: { ...receipt, status: 1, logs } as ethers.providers.TransactionReceipt,
    chainId: record.scope.chainId, expected: { ...exactSubmissionOperation(record)!,
      matchesCall: call => submissionIntentKey([{ to: call.target, data: call.data, value: callValue }]) === callKey },
  });
  return { ...receipt, logs: isolated };
}
