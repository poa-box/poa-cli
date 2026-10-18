import { ethers } from 'ethers';
import { requireRawUint, RawUintInput } from '../amounts';

export const USER_OPERATION_EVENTS = new ethers.utils.Interface([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  'event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)',
]);
export interface UserOperationExpectation {
  userOpHash: string; entryPoint: string; sender?: string; nonce?: RawUintInput;
}
export interface OperationReceipt {
  /** Exact 0/1 as Number, bigint, decimal or hex text. Absent means logs-only evidence. */
  status?: number | string | bigint;
  transactionHash?: string;
  logs?: readonly { address: string; topics: readonly string[]; data: string }[];
}
export interface UserOperationOutcome {
  status: 'succeeded' | 'failed' | 'unknown';
  userOpHash: string; entryPoint: string; code?: string; sender?: string; nonce?: string;
  actualGasCost?: string; actualGasUsed?: string; revertReason?: string;
}

function receiptStatus(status: OperationReceipt['status']): 0 | 1 | 'absent' | 'invalid' {
  if (status === undefined) return 'absent';
  if (typeof status === 'number') return status === 0 ? 0 : status === 1 ? 1 : 'invalid';
  if (typeof status === 'bigint') return status === 0n ? 0 : status === 1n ? 1 : 'invalid';
  if (typeof status === 'string' && /^(?:\d+|0[xX][\da-fA-F]+)$/.test(status)) {
    const value = BigInt(status);
    return value === 0n ? 0 : value === 1n ? 1 : 'invalid';
  }
  return 'invalid';
}

/** Only an exact, valid target event establishes inner success. Missing outer status retains logs-only semantics. */
export function decodeUserOperationOutcome(receipt: OperationReceipt | null | undefined, expected: UserOperationExpectation): UserOperationOutcome {
  if (!/^0x[\da-fA-F]{64}$/.test(expected.userOpHash)) throw new Error('Invalid userOpHash');
  const entryPoint = ethers.utils.getAddress(expected.entryPoint);
  if (entryPoint === ethers.constants.AddressZero) throw new Error('Zero EntryPoint');
  const sender = expected.sender === undefined ? undefined : ethers.utils.getAddress(expected.sender);
  const nonce = expected.nonce === undefined ? undefined : requireRawUint(expected.nonce);
  const base = { userOpHash: expected.userOpHash, entryPoint };
  const unknown = (code: string): UserOperationOutcome => ({ ...base, status: 'unknown', code });
  if (!receipt) return unknown('MISSING_RECEIPT');
  const outerStatus = receiptStatus(receipt.status);
  if (outerStatus === 'invalid') return unknown('INVALID_RECEIPT_STATUS');
  if (outerStatus === 0) return { ...base, status: 'failed', code: 'OUTER_REVERTED' };
  if (!Array.isArray(receipt.logs)) return unknown('MISSING_LOGS');
  const topic = USER_OPERATION_EVENTS.getEventTopic('UserOperationEvent').toLowerCase();
  const reasonTopic = USER_OPERATION_EVENTS.getEventTopic('UserOperationRevertReason').toLowerCase();
  const target = receipt.logs.filter(log => log.address?.toLowerCase() === entryPoint.toLowerCase()
    && log.topics?.[0]?.toLowerCase() === topic && log.topics?.[1]?.toLowerCase() === expected.userOpHash.toLowerCase());
  if (!target.length) return unknown('MISSING_TARGET_EVENT');
  if (target.length !== 1) return unknown('CONFLICTING_TARGET_EVENTS');
  let args: ethers.utils.Result;
  try {
    const log = target[0];
    const decoded = USER_OPERATION_EVENTS.parseLog({ topics: [...log.topics], data: log.data });
    // ABI decoding alone accepts noncanonical bools and surplus bytes.
    const encoded = USER_OPERATION_EVENTS.encodeEventLog(USER_OPERATION_EVENTS.getEvent('UserOperationEvent'), Array.from(decoded.args));
    if (encoded.data.toLowerCase() !== log.data.toLowerCase() || encoded.topics.length !== log.topics.length
      || encoded.topics.some((t, i) => t.toLowerCase() !== log.topics[i].toLowerCase())) return unknown('MALFORMED_TARGET_EVENT');
    args = decoded.args;
  } catch { return unknown('MALFORMED_TARGET_EVENT'); }
  if ((sender !== undefined && args.sender.toLowerCase() !== sender.toLowerCase()) || (nonce !== undefined && args.nonce.toString() !== nonce)) return unknown('TARGET_IDENTITY_MISMATCH');
  const evidence: UserOperationOutcome = { ...base, status: args.success ? 'succeeded' : 'failed', sender: args.sender,
    nonce: args.nonce.toString(), actualGasCost: args.actualGasCost.toString(), actualGasUsed: args.actualGasUsed.toString() };
  if (args.success) return evidence;
  const reasons: string[] = [];
  for (const log of receipt.logs) {
    if (log.address?.toLowerCase() !== entryPoint.toLowerCase() || log.topics?.[0]?.toLowerCase() !== reasonTopic || log.topics?.[1]?.toLowerCase() !== expected.userOpHash.toLowerCase()) continue;
    try {
      const parsed = USER_OPERATION_EVENTS.parseLog({ topics: [...log.topics], data: log.data }).args;
      if (parsed.sender.toLowerCase() === args.sender.toLowerCase() && parsed.nonce.eq(args.nonce)) reasons.push(parsed.revertReason);
    } catch { /* Target failure remains established without a readable reason. */ }
  }
  if (reasons.length === 1) evidence.revertReason = reasons[0];
  return evidence;
}
