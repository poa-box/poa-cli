/** Durable local submission journal. Contains identities and digests, never keys/calldata/URLs. */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { ethers } from 'ethers';
import {
  createSubmissionRecovery, normalizeSubmissionRecovery, submissionIntentKey,
  transitionSubmissionRecovery, reconcileSubmissionRecovery, canAbandonSubmissionRecovery,
  type SubmissionRecoveryRecord, type SubmissionRecoveryEvent, type SubmissionRecoveryReaders, type RecoveryTransaction,
} from '@poa-box/core/execute/recovery';

export function recoveryDirectory(): string {
  return path.join(process.env.POP_AGENT_HOME || path.join(os.homedir(), '.pop'), 'submissions');
}
export function journalFile(chainId: number, account: string): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Invalid journal chain');
  return path.join(recoveryDirectory(), `${chainId}-${ethers.utils.getAddress(account).toLowerCase()}.json`);
}
export function loadSubmission(chainId: number, account: string): SubmissionRecoveryRecord | undefined {
  const file = journalFile(chainId, account);
  try { return normalizeSubmissionRecovery(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error: any) { if (error.code === 'ENOENT') return undefined; throw new Error('Submission journal is invalid or unreadable; repair it before sending.'); }
}
export function persistSubmission(record: SubmissionRecoveryRecord): void {
  const safe = normalizeSubmissionRecovery(record), file = journalFile(safe.scope.chainId, safe.scope.accountAddress);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(safe) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
/** No age-based expiry. Only a demonstrably dead local process can lose its lock. */
export function acquireSubmissionLock(chainId: number, account: string): () => void {
  const lock = `${journalFile(chainId, account)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const token = randomUUID(), prepared = `${lock}.prepared-${token}`;
  fs.mkdirSync(prepared, { mode: 0o700 });
  fs.writeFileSync(path.join(prepared, token), JSON.stringify({ pid: process.pid, host: os.hostname() }), { flag: 'wx', mode: 0o600 });
  try {
    try { fs.renameSync(prepared, lock); }
    catch (error: any) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      const owners = fs.readdirSync(lock);
      if (owners.length !== 1) throw new Error('Submission account is locked; lock ownership cannot be proven.');
      const ownerFile = path.join(lock, owners[0]);
      const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
      if (owner.host !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Submission account is locked by another host or unknown owner.');
      try { process.kill(owner.pid, 0); throw new Error('Submission account is locked by a running process.'); }
      catch (probe: any) { if (probe.code !== 'ESRCH') throw probe; }
      // Only the process that removes this exact owner file may remove the old
      // directory. Concurrent reclaimers cannot remove a newly acquired lock.
      fs.unlinkSync(ownerFile);
      fs.rmdirSync(lock);
      fs.renameSync(prepared, lock);
    }
  } catch (error) {
    fs.rmSync(prepared, { recursive: true, force: true }); throw error;
  }
  return () => {
    const released = `${lock}.released-${token}`;
    fs.renameSync(lock, released);
    fs.unlinkSync(path.join(released, token)); fs.rmdirSync(released);
  };
}
export function transitionJournal(record: SubmissionRecoveryRecord, event: SubmissionRecoveryEvent): SubmissionRecoveryRecord {
  const next = transitionSubmissionRecovery(record, { scope: record.scope, ownerId: record.ownerId, attemptId: record.attemptId, revision: record.revision }, event);
  persistSubmission(next); return next;
}
export function startSubmission(chainId: number, account: string, call: { to: string; data: string; value?: string }): SubmissionRecoveryRecord {
  const previous = loadSubmission(chainId, account);
  if (previous && !['succeeded', 'failed', 'replaced', 'aborted'].includes(previous.phase)) {
    throw new Error(`Unresolved submission (${previous.phase}) blocks this account. Run pop execution recover --address ${account} --chain ${chainId}; never resend an unknown operation.`);
  }
  const intentKey = submissionIntentKey([call]);
  const scope = { chainId, accountAddress: account, intentKey,
    sessionKey: ethers.utils.id('pop-cli-session-v2'), contextKey: ethers.utils.id(`pop-cli-chain:${chainId}`) };
  const record = createSubmissionRecovery(scope, randomUUID(), randomUUID());
  persistSubmission(record); return record;
}
export function providerRecoveryReaders(provider: ethers.providers.JsonRpcProvider, bundlerUrl?: string, requireAuthorization = false): SubmissionRecoveryReaders {
  const hexBlock = (number: string) => ethers.utils.hexValue(ethers.BigNumber.from(number));
  const rawTransaction = (tx: any): RecoveryTransaction => ({ hash: tx.hash, from: tx.from, to: tx.to, input: tx.input ?? tx.data,
    nonce: ethers.BigNumber.from(tx.nonce).toString(), value: ethers.BigNumber.from(tx.value).toString(),
    ...(tx.chainId != null ? { chainId: ethers.BigNumber.from(tx.chainId).toString() } : {}),
    blockNumber: tx.blockNumber == null ? null : ethers.BigNumber.from(tx.blockNumber).toString(), blockHash: tx.blockHash,
    ...(Array.isArray(tx.authorizationList) ? { authorizationList: tx.authorizationList } : tx.type !== undefined && ethers.BigNumber.from(tx.type).eq(4) ? {} : { authorizationList: [] }) });
  return {
    getChainId: async () => (await provider.getNetwork()).chainId,
    getTransactionReceipt: hash => provider.getTransactionReceipt(hash),
    getTransaction: async hash => {
      if (requireAuthorization) { const tx = await provider.send('eth_getTransactionByHash', [hash]); return tx ? rawTransaction(tx) : null; }
      const tx = await provider.getTransaction(hash);
      if (tx?.type === 4) {
        const raw = await provider.send('eth_getTransactionByHash', [hash]);
        if (!raw || !Array.isArray(raw.authorizationList)) throw new Error('Transaction authorization list unavailable');
        return rawTransaction(raw);
      }
      return tx ? { ...tx, value: tx.value.toString(), chainId: tx.chainId } : null;
    },
    getBlock: async number => { const b = await provider.getBlock(hexBlock(number)); return b ? { number: b.number, hash: b.hash } : null; },
    getBlockNumber: () => provider.getBlockNumber(),
    getBlockTransactions: async number => {
      if (requireAuthorization) {
        const block = await provider.send('eth_getBlockByNumber', [hexBlock(number), true]);
        if (!Array.isArray(block?.transactions)) throw new Error('Recovery block transactions unavailable');
        return block.transactions.map(rawTransaction);
      }
      return (await provider.getBlockWithTransactions(hexBlock(number))).transactions.map(tx => ({ ...tx, value: tx.value.toString() }));
    },
    ...(bundlerUrl ? { getUserOperationReceipt: async (hash: string) => {
      const bundler = new ethers.providers.JsonRpcProvider(bundlerUrl);
      const value = await bundler.send('eth_getUserOperationReceipt', [hash]);
      return value?.receipt?.transactionHash ? { transactionHash: value.receipt.transactionHash } : null;
    } } : {}),
  };
}
export async function recoverSubmission(chainId: number, account: string, provider: ethers.providers.JsonRpcProvider,
  options: { maxBlocks?: number; candidateTxHash?: string; abandon?: boolean; bundlerUrl?: string } = {}) {
  const release = acquireSubmissionLock(chainId, account);
  try {
    let record = loadSubmission(chainId, account);
    if (!record) throw new Error('No saved submission for this account and chain.');
    if (record.scope.chainId !== chainId || record.scope.accountAddress !== account.toLowerCase()) throw new Error('Journal scope mismatch');
    if (options.abandon) {
      if (!canAbandonSubmissionRecovery(record)) throw new Error('Broadcast may have occurred; this record cannot be abandoned.');
      record = transitionJournal(record, { type: 'abort' });
      return { record, outcome: { status: 'unknown' as const, code: 'PRE_BROADCAST_ABORTED' } };
    }
    const result = await reconcileSubmissionRecovery(record, providerRecoveryReaders(provider, options.bundlerUrl, Boolean(record.authorizationKey)), options);
    if (result.outcome.status !== 'unknown') result.record = transitionJournal(record, { type: 'settle', status: result.outcome.status });
    return result;
  } finally { release(); }
}
