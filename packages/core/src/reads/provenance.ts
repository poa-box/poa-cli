import { ethers } from 'ethers';
import { requireRawUint } from '../amounts';
import { ENTRY_POINT } from '../accounts/constants';
import { getAbi } from '../contracts';
import { assertSourceBlock, requireCompleteSnapshot, SourceRef, SourceSnapshot } from '../data/facts';
import { decodeUserOperationOutcome, USER_OPERATION_EVENTS } from '../execute/outcome';

/** Only exact lookups. No getLogs, trace, discovery, signing or history scan. */
export type ProvenanceProvider = Pick<ethers.providers.Provider, 'getNetwork' | 'getBlock' | 'getTransaction' | 'getTransactionReceipt'>;
export interface ProvenanceFreshness { now: number; maxAgeSeconds: number }
export interface CanonicalTransaction {
  transactionHash: string;
  inclusion: { number: string; hash: string };
  from: string; to: string; data: string; value: string;
  logs: readonly { address: string; topics: readonly string[]; data: string }[];
}
const transactions = new WeakSet<object>();
function hash(value: string): string {
  if (!/^0x[\da-f]{64}$/i.test(value)) throw new Error('INVALID_PROVENANCE_HASH');
  return value.toLowerCase();
}
export function requireProvenanceFreshness(source: SourceRef, freshness: ProvenanceFreshness): void {
  if (!Number.isSafeInteger(freshness.now) || !Number.isSafeInteger(freshness.maxAgeSeconds) || freshness.maxAgeSeconds < 0
    || source.observedAt === undefined || freshness.now < source.observedAt || freshness.now - source.observedAt > freshness.maxAgeSeconds) throw new Error('PROVENANCE_STALE');
  if (source.snapshot !== 'pinned' || !source.block?.hash) throw new Error('HASH_PINNED_PROVENANCE_REQUIRED');
}
/** Trusted host provider supplies canonical observations; this is not a light-client proof.
 * Seven bounded RPC requests, including chain identity and before/after hash checks.
 * The host must select an appropriately confirmed block and a trustworthy endpoint.
 */
export async function readCanonicalTransaction(input: {
  source: SourceRef; provider: ProvenanceProvider; transactionHash: string; freshness: ProvenanceFreshness;
}): Promise<SourceSnapshot<CanonicalTransaction>> {
  const { source, provider } = input;
  // Validate source structure/coverage before any network operation.
  requireCompleteSnapshot({ source, data: null, coverage: { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] } }, { indexed: false });
  requireProvenanceFreshness(source, input.freshness);
  const txHash = hash(input.transactionHash);
  const selected = source.block!;
  if ((await provider.getNetwork()).chainId !== source.chainId) throw new Error('PROVENANCE_CHAIN_MISMATCH');
  const before = await provider.getBlock(selected.hash!);
  // Also resolve by number: a retrievable orphan hash is not canonical evidence.
  const [tx, receipt, selectedCanonical] = await Promise.all([
    provider.getTransaction(txHash), provider.getTransactionReceipt(txHash), provider.getBlock(ethers.BigNumber.from(selected.number).toHexString()),
  ]);
  const block = (row: ethers.providers.Block | null) => row ? { number: String(row.number), hash: row.hash, timestamp: String(row.timestamp) } : undefined;
  assertSourceBlock(block(before), selected);
  assertSourceBlock(block(selectedCanonical), selected);
  if (!tx || !receipt || !tx.to || receipt.status !== 1 || tx.chainId !== source.chainId
    || hash(tx.hash) !== txHash || hash(receipt.transactionHash) !== txHash
    || tx.blockNumber !== receipt.blockNumber || tx.blockHash?.toLowerCase() !== receipt.blockHash?.toLowerCase()
    || BigInt(receipt.blockNumber) > BigInt(selected.number)) throw new Error('TRANSACTION_PROVENANCE_UNSETTLED');
  const inclusion = { number: String(receipt.blockNumber), hash: hash(receipt.blockHash) };
  const [canonical, after] = await Promise.all([
    provider.getBlock(ethers.BigNumber.from(inclusion.number).toHexString()), provider.getBlock(ethers.BigNumber.from(selected.number).toHexString()),
  ]);
  assertSourceBlock(block(canonical), inclusion);
  assertSourceBlock(block(after), selected);
  if (!Array.isArray(receipt.logs) || receipt.logs.some(log => log.removed || log.transactionHash?.toLowerCase() !== txHash
    || log.blockHash?.toLowerCase() !== inclusion.hash || String(log.blockNumber) !== inclusion.number)) throw new Error('RECEIPT_LOG_PROVENANCE_MISMATCH');
  const data: CanonicalTransaction = Object.freeze({ transactionHash: txHash, inclusion: Object.freeze(inclusion),
    from: ethers.utils.getAddress(tx.from), to: ethers.utils.getAddress(tx.to), data: tx.data, value: tx.value.toString(),
    logs: Object.freeze(receipt.logs.map(log => Object.freeze({ address: log.address, topics: Object.freeze([...log.topics]), data: log.data }))) });
  const result: SourceSnapshot<CanonicalTransaction> = Object.freeze({ source: Object.freeze({ ...source, block: Object.freeze({ ...selected }),
    ...(source.contracts ? { contracts: Object.freeze({ ...source.contracts }) } : {}) }), data,
    coverage: Object.freeze({ status: 'complete' as const, expectedKeys: Object.freeze([txHash]), receivedKeys: Object.freeze([txHash]), missingIds: Object.freeze([]), failedIds: Object.freeze([]), issues: Object.freeze([]) }) });
  transactions.add(result);
  return result;
}
export function requireCanonicalTransaction(evidence: SourceSnapshot<CanonicalTransaction>, scope: SourceRef, freshness: ProvenanceFreshness): CanonicalTransaction {
  if (!transactions.has(evidence)) throw new Error('CANONICAL_TRANSACTION_PROOF_REQUIRED');
  requireProvenanceFreshness(evidence.source, freshness);
  return requireCompleteSnapshot(evidence, { scope, indexed: false, snapshot: 'pinned', block: scope.block });
}

/** ERC-4337 v0.7 PackedUserOperation from the canonical EntryPoint interface.
 * Aggregated and multi-operation transactions deliberately need a richer exact-call proof.
 */
const entryPoint = new ethers.utils.Interface([
  'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)',
]);
export function decodeCanonicalCall(iface: ethers.utils.Interface, data: string): ethers.utils.TransactionDescription {
  if (typeof data !== 'string' || data.length > 2_000_002) throw new Error('PROVENANCE_CALLDATA_LIMIT');
  const parsed = iface.parseTransaction({ data });
  if (iface.encodeFunctionData(parsed.signature, parsed.args).toLowerCase() !== data.toLowerCase()) throw new Error('NONCANONICAL_PROVENANCE_CALLDATA');
  return parsed;
}
export interface ExactTransactionCall { target: string; caller: string; data: string; operationStatus: 'succeeded' | 'failed'; userOpHash?: string }
/** A direct call or one proven v0.7 operation executing one call. No guessed log isolation. */
export function exactTransactionCall(tx: CanonicalTransaction, chainId: number): ExactTransactionCall {
  if (tx.value !== '0') throw new Error('UNSUPPORTED_PROVENANCE_VALUE');
  if (tx.to.toLowerCase() !== ENTRY_POINT.toLowerCase()) return { target: tx.to, caller: tx.from, data: tx.data, operationStatus: 'succeeded' };
  const parsed = decodeCanonicalCall(entryPoint, tx.data);
  if (parsed.name !== 'handleOps' || parsed.args.ops.length !== 1) throw new Error('EXACT_OPERATION_ISOLATION_REQUIRED');
  const op = parsed.args.ops[0];
  const digest = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
    [op.sender, op.nonce, ethers.utils.keccak256(op.initCode), ethers.utils.keccak256(op.callData), op.accountGasLimits, op.preVerificationGas, op.gasFees, ethers.utils.keccak256(op.paymasterAndData)]));
  const userOpHash = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['bytes32', 'address', 'uint256'], [digest, ENTRY_POINT, chainId]));
  const topic = USER_OPERATION_EVENTS.getEventTopic('UserOperationEvent').toLowerCase();
  if (tx.logs.filter(log => log.address.toLowerCase() === ENTRY_POINT.toLowerCase() && log.topics[0]?.toLowerCase() === topic).length !== 1) throw new Error('EXACT_OPERATION_ISOLATION_REQUIRED');
  const outcome = decodeUserOperationOutcome({ status: 1, logs: tx.logs }, { userOpHash, entryPoint: ENTRY_POINT, sender: op.sender, nonce: requireRawUint(op.nonce.toString()) });
  if (outcome.status === 'unknown') throw new Error('OPERATION_PROVENANCE_UNSETTLED');
  const accountCall = decodeCanonicalCall(new ethers.utils.Interface(getAbi('PasskeyAccount')), op.callData);
  if (accountCall.name !== 'execute' || !accountCall.args.value.isZero()) throw new Error('EXACT_ACCOUNT_CALL_REQUIRED');
  return { target: accountCall.args.target, caller: op.sender, data: accountCall.args.data, operationStatus: outcome.status, userOpHash };
}
