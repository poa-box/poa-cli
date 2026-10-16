import { ethers } from 'ethers';
import { requireRawUint, RawUintInput } from '../amounts';
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
  logs: readonly { address: string; topics: readonly string[]; data: string; logIndex?: number }[];
}
const transactions = new WeakSet<object>();
const transactionChains = new WeakMap<CanonicalTransaction, number>();
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
    logs: Object.freeze(receipt.logs.map(log => Object.freeze({ address: log.address, topics: Object.freeze([...log.topics]), data: log.data, ...(log.logIndex === undefined ? {} : { logIndex: log.logIndex }) }))) });
  const result: SourceSnapshot<CanonicalTransaction> = Object.freeze({ source: Object.freeze({ ...source, block: Object.freeze({ ...selected }),
    ...(source.contracts ? { contracts: Object.freeze({ ...source.contracts }) } : {}) }), data,
    coverage: Object.freeze({ status: 'complete' as const, expectedKeys: Object.freeze([txHash]), receivedKeys: Object.freeze([txHash]), missingIds: Object.freeze([]), failedIds: Object.freeze([]), issues: Object.freeze([]) }) });
  transactions.add(result);
  transactionChains.set(data, source.chainId);
  return result;
}
export function requireCanonicalTransaction(evidence: SourceSnapshot<CanonicalTransaction>, scope: SourceRef, freshness: ProvenanceFreshness): CanonicalTransaction {
  if (!transactions.has(evidence)) throw new Error('CANONICAL_TRANSACTION_PROOF_REQUIRED');
  requireProvenanceFreshness(evidence.source, freshness);
  return requireCompleteSnapshot(evidence, { scope, indexed: false, snapshot: 'pinned', block: scope.block });
}

/** ERC-4337 v0.7 PackedUserOperation from the canonical EntryPoint interface.
 * Only handleOps is supported; aggregated operations require a different proof.
 */
const entryPoint = new ethers.utils.Interface([
  'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)',
  'event BeforeExecution()',
]);
export function decodeCanonicalCall(iface: ethers.utils.Interface, data: string): ethers.utils.TransactionDescription {
  if (typeof data !== 'string' || data.length > 2_000_002) throw new Error('PROVENANCE_CALLDATA_LIMIT');
  const parsed = iface.parseTransaction({ data });
  if (iface.encodeFunctionData(parsed.signature, parsed.args).toLowerCase() !== data.toLowerCase()) throw new Error('NONCANONICAL_PROVENANCE_CALLDATA');
  return parsed;
}
export interface ExactTransactionCall { target: string; caller: string; data: string; operationStatus: 'succeeded' | 'failed'; userOpHash?: string }
/** Optional identity is a constraint on canonical calldata, never proof by itself. */
export interface ExactOperationIdentity { userOpHash?: string; sender?: string; nonce?: RawUintInput; entryPoint?: string }
export interface ExactTransactionCallSelector extends ExactOperationIdentity {
  target?: string;
  data?: string;
  /** Pure intent predicate over decoded calls only, never over receipt events.
   * Domain readers must still validate the selected call and its isolated events. */
  matchesCall?: (call: Readonly<Pick<ExactTransactionCall, 'target' | 'caller' | 'data'>>) => boolean;
}
export interface ExactTransactionExecution extends ExactTransactionCall {
  /** Direct receipt logs, or only the selected operation's execution window.
   * Includes that operation's postOp logs; excludes validation, other operations,
   * the terminal UserOperationEvent, and beneficiary compensation. */
  logs: CanonicalTransaction['logs'];
}
function operationHash(op: ethers.utils.Result, chainId: number): string {
  const digest = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
    [op.sender, op.nonce, ethers.utils.keccak256(op.initCode), ethers.utils.keccak256(op.callData), op.accountGasLimits, op.preVerificationGas, op.gasFees, ethers.utils.keccak256(op.paymasterAndData)]));
  return ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['bytes32', 'address', 'uint256'], [digest, ENTRY_POINT, chainId]));
}
function accountCall(op: ethers.utils.Result, userOpHash: string, operationStatus: 'succeeded' | 'failed'): ExactTransactionCall {
  const parsed = decodeCanonicalCall(new ethers.utils.Interface(getAbi('PasskeyAccount')), op.callData);
  if (parsed.name !== 'execute' || !parsed.args.value.isZero()) throw new Error('EXACT_ACCOUNT_CALL_REQUIRED');
  return { target: parsed.args.target, caller: op.sender, data: parsed.args.data, operationStatus, userOpHash };
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Legacy two-argument form retains its strict single-operation call-only contract.
 * Pass a selector (even {}) for canonical execution-log isolation and multi-op support.
 * No transaction/proof cloning: the isolated view references the observed log objects. */
export function exactTransactionCall(tx: CanonicalTransaction, chainId: number): ExactTransactionCall;
export function exactTransactionCall(tx: CanonicalTransaction, chainId: number, selector: ExactTransactionCallSelector): ExactTransactionExecution;
export function exactTransactionCall(tx: CanonicalTransaction, chainId: number, selector?: ExactTransactionCallSelector): ExactTransactionCall | ExactTransactionExecution {
  if (tx.value !== '0') throw new Error('UNSUPPORTED_PROVENANCE_VALUE');
  if (selector !== undefined && transactionChains.get(tx) !== chainId) throw new Error('CANONICAL_TRANSACTION_CHAIN_PROOF_REQUIRED');
  const expectedHash = selector?.userOpHash === undefined ? undefined : hash(selector.userOpHash);
  const sender = selector?.sender === undefined ? undefined : ethers.utils.getAddress(selector.sender);
  const nonce = selector?.nonce === undefined ? undefined : requireRawUint(selector.nonce);
  if (selector?.entryPoint !== undefined && !same(ethers.utils.getAddress(selector.entryPoint), ENTRY_POINT)) throw new Error('OPERATION_ENTRYPOINT_MISMATCH');
  const matches = (call: ExactTransactionCall) => (sender === undefined || same(call.caller, sender))
    && (selector?.target === undefined || same(call.target, selector.target))
    && (selector?.data === undefined || same(call.data, selector.data)) && (!selector?.matchesCall || selector.matchesCall(Object.freeze({ target: call.target, caller: call.caller, data: call.data })));
  if (!same(tx.to, ENTRY_POINT)) {
    const direct: ExactTransactionCall = { target: tx.to, caller: tx.from, data: tx.data, operationStatus: 'succeeded' };
    if (selector === undefined) return direct;
    if (expectedHash !== undefined || nonce !== undefined || selector.entryPoint !== undefined || !matches(direct)) throw new Error('EXACT_OPERATION_IDENTITY_MISMATCH');
    return { ...direct, logs: tx.logs };
  }
  let parsed: ethers.utils.TransactionDescription;
  try { parsed = decodeCanonicalCall(entryPoint, tx.data); }
  catch { throw new Error('EXACT_HANDLE_OPS_CALL_REQUIRED'); }
  const ops = parsed.args.ops as ethers.utils.Result[];
  if (parsed.name !== 'handleOps' || !ops.length) throw new Error('EXACT_OPERATION_ISOLATION_REQUIRED');
  const topic = USER_OPERATION_EVENTS.getEventTopic('UserOperationEvent');
  const eventIndices = tx.logs.flatMap((log, i) => same(log.address, ENTRY_POINT) && same(log.topics[0] ?? '', topic) ? [i] : []);
  if (selector === undefined) {
    if (ops.length !== 1 || eventIndices.length !== 1) throw new Error('EXACT_OPERATION_ISOLATION_REQUIRED');
    const op = ops[0], userOpHash = operationHash(op, chainId);
    const outcome = decodeUserOperationOutcome({ status: 1, logs: tx.logs }, { userOpHash, entryPoint: ENTRY_POINT, sender: op.sender, nonce: requireRawUint(op.nonce.toString()) });
    if (outcome.status === 'unknown') throw new Error('OPERATION_PROVENANCE_UNSETTLED');
    return accountCall(op, userOpHash, outcome.status);
  }
  // The whole receipt must retain its canonical order, including validation logs.
  // Block-global log indices need not start at zero, but a complete receipt is contiguous.
  if (tx.logs.some((log, i) => !Number.isSafeInteger(log.logIndex) || log.logIndex! < 0
    || (i > 0 && log.logIndex !== tx.logs[i - 1].logIndex! + 1))) throw new Error('RECEIPT_LOG_ORDER_REQUIRED');
  const beforeTopic = entryPoint.getEventTopic('BeforeExecution');
  const before = tx.logs.flatMap((log, i) => same(log.address, ENTRY_POINT) && same(log.topics[0] ?? '', beforeTopic) ? [i] : []);
  if (before.length !== 1 || tx.logs[before[0]].topics.length !== 1 || tx.logs[before[0]].data !== '0x'
    || eventIndices.length !== ops.length || eventIndices.some(i => i <= before[0])) throw new Error('EXACT_OPERATION_BOUNDARIES_REQUIRED');
  const hashes = ops.map(op => operationHash(op, chainId));
  if (new Set(hashes).size !== ops.length || new Set(ops.map(op => op.sender.toLowerCase() + ':' + op.nonce.toString())).size !== ops.length) throw new Error('DUPLICATE_OPERATION_IDENTITY');
  const outcomes = ops.map((op, i) => {
    const log = tx.logs[eventIndices[i]];
    const outcome = decodeUserOperationOutcome({ status: 1, logs: [log] }, { userOpHash: hashes[i], entryPoint: ENTRY_POINT, sender: op.sender, nonce: requireRawUint(op.nonce.toString()) });
    // Also bind paymaster to the packed calldata. Its postOp lies in this window.
    const paymaster = op.paymasterAndData === '0x' ? ethers.constants.AddressZero : op.paymasterAndData.slice(0, 42);
    if ((op.paymasterAndData !== '0x' && ethers.utils.hexDataLength(op.paymasterAndData) < 52)
      || outcome.status === 'unknown' || !same(log.topics[3] ?? '', ethers.utils.hexZeroPad(paymaster, 32))) throw new Error('OPERATION_EVENT_ORDER_OR_IDENTITY_MISMATCH');
    return outcome.status;
  });
  const candidates: { call: ExactTransactionCall; index: number }[] = [];
  for (const [i, op] of ops.entries()) {
    if ((expectedHash !== undefined && hashes[i] !== expectedHash) || (sender !== undefined && !same(op.sender, sender))
      || (nonce !== undefined && op.nonce.toString() !== nonce)) continue;
    let call: ExactTransactionCall;
    try { call = accountCall(op, hashes[i], outcomes[i]); }
    catch { continue; } // Other accounts/methods may co-bundle; never infer their inner call.
    if (matches(call)) candidates.push({ call, index: i });
  }
  if (candidates.length !== 1) throw new Error(candidates.length ? 'EXACT_OPERATION_IDENTITY_REQUIRED' : 'EXACT_OPERATION_IDENTITY_MISMATCH');
  const { call, index } = candidates[0];
  return { ...call, logs: Object.freeze(tx.logs.slice((index === 0 ? before[0] : eventIndices[index - 1]) + 1, eventIndices[index])) };
}
