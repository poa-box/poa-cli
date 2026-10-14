/** Opt-in third-party schema only. Addresses, transport, quotes, account
 * capabilities and signing are host inputs; ordinary POP networks are untouched. */
import { ethers } from 'ethers';
import { parseDecimalAmountToRaw, requireRawUint } from '../amounts';
import { assertPlanScope, assertSourceBlock, assertSourceRef, knownFact, requireCompleteSnapshot, unknownFact, type Fact, type SourceBlock, type SourceSnapshot } from '../data/facts';
import type { TxIntent } from '../tx/intent';

export const CASHOUT_SCHEMA_V1 = Object.freeze({ version: 1, tokenDecimals: 6, conversionRateDecimals: 18, payloadBytes: 224 } as const);
export const CASHOUT_PARAMS_TUPLE = [{ type: 'tuple', components: [
  { name: 'depositor', type: 'address' }, { name: 'paymentMethod', type: 'bytes32' },
  { name: 'payeeDetailsHash', type: 'bytes32' }, { name: 'fiatCurrency', type: 'bytes32' },
  { name: 'conversionRate', type: 'uint256' }, { name: 'minIntentAmount', type: 'uint256' }, { name: 'maxIntentAmount', type: 'uint256' },
] }] as const;
export const CASHOUT_RELAY_ABI_V1 = [
  'function recoverFailed(bytes32 requestHash)', 'function failedDepositor(bytes32 requestHash) view returns (address)',
  'function failedAmount(bytes32 requestHash) view returns (uint256)', 'function usdc() view returns (address)',
  'event CashOutDeposited(address indexed depositor, bytes32 indexed requestHash, uint256 amount, bytes32 paymentMethod)',
  'event CashOutFailed(address indexed depositor, bytes32 indexed requestHash, uint256 amount, bytes reason)',
] as const;
export const CASHOUT_ESCROW_ABI_V1 = [
  'function getDeposit(uint256 depositId) view returns (tuple(address depositor,address delegate,address token,tuple(uint256 min,uint256 max) intentAmountRange,bool acceptingIntents,uint256 remainingDeposits,uint256 outstandingIntentAmount,address intentGuardian,bool retainOnEmpty))',
  'function withdrawDeposit(uint256 depositId)',
  'event DepositReceived(uint256 indexed depositId,address indexed depositor,address indexed token,uint256 amount,tuple(uint256 min,uint256 max) intentAmountRange,address delegate,address intentGuardian)',
] as const;
export interface CashoutDescriptor { chainId: number; relay: string; escrow: string; token: string }
function address(value: string): string {
  const result = ethers.utils.getAddress(value);
  if (result === ethers.constants.AddressZero) throw new Error('ZERO_CASHOUT_ADDRESS');
  return result;
}
function descriptor(input: CashoutDescriptor): void {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error('INVALID_CASHOUT_CHAIN');
  address(input.relay); address(input.escrow); address(input.token);
}
function bytes32(value: string): void { if (!ethers.utils.isHexString(value, 32)) throw new Error('INVALID_CASHOUT_BYTES32'); }
export interface CashoutPayload {
  depositor: string; paymentMethod: string; payeeDetailsHash: string; fiatCurrency: string;
  conversionRate: string; minIntentAmount: string; maxIntentAmount: string;
}
export function encodeCashoutPayload(input: CashoutPayload): string {
  address(input.depositor);
  bytes32(input.paymentMethod); bytes32(input.payeeDetailsHash); bytes32(input.fiatCurrency);
  const rate = requireRawUint(input.conversionRate), min = requireRawUint(input.minIntentAmount), max = requireRawUint(input.maxIntentAmount);
  if (rate === '0' || BigInt(min) > BigInt(max)) throw new Error('INVALID_CASHOUT_RANGE_OR_RATE');
  return ethers.utils.defaultAbiCoder.encode(['tuple(address depositor,bytes32 paymentMethod,bytes32 payeeDetailsHash,bytes32 fiatCurrency,uint256 conversionRate,uint256 minIntentAmount,uint256 maxIntentAmount)'],
    [[input.depositor, input.paymentMethod, input.payeeDetailsHash, input.fiatCurrency, rate, min, max]]);
}
export function prepareCashoutPayload(input: Omit<CashoutPayload, 'conversionRate' | 'minIntentAmount' | 'maxIntentAmount'> & { conversionRateDecimal: string; minIntentDecimal: string; maxIntentDecimal: string }): CashoutPayload {
  const payload = { depositor: input.depositor, paymentMethod: input.paymentMethod, payeeDetailsHash: input.payeeDetailsHash, fiatCurrency: input.fiatCurrency,
    conversionRate: parseDecimalAmountToRaw(input.conversionRateDecimal, 18), minIntentAmount: parseDecimalAmountToRaw(input.minIntentDecimal, 6), maxIntentAmount: parseDecimalAmountToRaw(input.maxIntentDecimal, 6) };
  encodeCashoutPayload(payload); return payload;
}
export interface CashoutLog { address: string; topics: readonly string[]; data: string; logIndex: string; transactionHash: string }
export interface CashoutDeposit { depositId: string; depositor: string; token: string; amountRaw: string; logIndex: string; transactionHash: string }
/** Filter emitter AND depositor/token/transaction. Multiple matching deposits
 * stay ambiguous; an optional known deposit ID narrows only explicit evidence. */
export function decodeCashoutDeposit(input: { descriptor: CashoutDescriptor; chainId: number; depositor: string; transactionHash: string; logs: readonly CashoutLog[]; depositId?: string }): Fact<CashoutDeposit> {
  try {
    descriptor(input.descriptor); address(input.depositor); bytes32(input.transactionHash);
    if (input.chainId !== input.descriptor.chainId) throw new Error('CASHOUT_CHAIN_MISMATCH');
    const iface = new ethers.utils.Interface([...CASHOUT_ESCROW_ABI_V1]);
    const matches = new Map<string, CashoutDeposit>();
    for (const log of input.logs) {
      if (log.address.toLowerCase() !== input.descriptor.escrow.toLowerCase()) continue;
      const topic = iface.getEventTopic('DepositReceived');
      if (log.topics[0]?.toLowerCase() !== topic.toLowerCase()) continue;
      if (log.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase()) throw new Error('CASHOUT_RECEIPT_TX_MISMATCH');
      const decoded = iface.parseLog({ topics: [...log.topics], data: log.data }).args;
      if (decoded.depositor.toLowerCase() !== input.depositor.toLowerCase() || decoded.token.toLowerCase() !== input.descriptor.token.toLowerCase()) continue;
      const depositId = requireRawUint(decoded.depositId.toString());
      if (input.depositId !== undefined && depositId !== requireRawUint(input.depositId)) continue;
      const logIndex = requireRawUint(log.logIndex);
      const value = { depositId, depositor: decoded.depositor, token: decoded.token, amountRaw: requireRawUint(decoded.amount.toString()), logIndex, transactionHash: log.transactionHash };
      const key = `${log.transactionHash.toLowerCase()}:${logIndex}`;
      if (matches.has(key) && JSON.stringify(matches.get(key)) !== JSON.stringify(value)) throw new Error('CONFLICTING_DEPOSIT_LOG');
      matches.set(key, value);
    }
    if (matches.size !== 1) throw new Error(matches.size ? 'AMBIGUOUS_DEPOSIT_EVENT' : 'DEPOSIT_EVENT_UNAVAILABLE');
    return knownFact([...matches.values()][0]);
  } catch (error) { return unknownFact(error instanceof Error ? error.message : 'DEPOSIT_EVENT_UNAVAILABLE'); }
}
export type CashoutRecoveryState =
  | { kind: 'failed'; requestHash: string; depositor: string; token: string; amountRaw: string }
  | { kind: 'escrow'; depositId: string; depositor: string; token: string; remainingDeposits: string; outstandingIntentAmount: string };
export interface CashoutRecoveryFacts {
  kind: 'failed' | 'escrow'; owner: boolean; recoverableAmountRaw: string; outstandingIntentAmountRaw: string;
  transactionOnlyCapability: Fact<boolean>;
  initiationCapability: Fact<never>;
}
export function projectRecoveryFacts(input: { descriptor: CashoutDescriptor; account: string; block: SourceBlock; snapshot: SourceSnapshot<CashoutRecoveryState>; transactionCapability: Fact<boolean> }): Fact<CashoutRecoveryFacts> {
  try {
    descriptor(input.descriptor); address(input.account);
    const contract = input.snapshot.data.kind === 'failed' ? input.descriptor.relay : input.descriptor.escrow;
    const scope = { chainId: input.descriptor.chainId, account: input.account, contract };
    const state = requireCompleteSnapshot(input.snapshot, { scope, indexed: false, snapshot: 'pinned', block: input.block });
    if (address(state.token).toLowerCase() !== input.descriptor.token.toLowerCase()) throw new Error('CASHOUT_TOKEN_MISMATCH');
    // Zero failed depositor is the authoritative no-pending sentinel.
    const depositor = ethers.utils.getAddress(state.depositor);
    const owner = depositor.toLowerCase() === input.account.toLowerCase();
    let amount: string, outstanding = '0';
    if (state.kind === 'failed') { bytes32(state.requestHash); amount = requireRawUint(state.amountRaw); }
    else if (state.kind === 'escrow') { requireRawUint(state.depositId); amount = requireRawUint(state.remainingDeposits); outstanding = requireRawUint(state.outstandingIntentAmount); }
    else throw new Error('INVALID_CASHOUT_RECOVERY_KIND');
    if (depositor === ethers.constants.AddressZero && amount !== '0') throw new Error('INCONSISTENT_RECOVERY_STATE');
    let capability = input.transactionCapability;
    if (capability.state === 'known') {
      if (typeof capability.value !== 'boolean' || !capability.source) throw new Error('CASHOUT_CAPABILITY_SCOPE_REQUIRED');
      assertSourceRef(capability.source);
      assertPlanScope(capability.source, scope); assertSourceBlock(capability.source.block, input.block);
      if (capability.source.indexed || capability.source.snapshot !== 'pinned') throw new Error('CASHOUT_CAPABILITY_SOURCE_MISMATCH');
    }
    return knownFact({ kind: state.kind, owner, recoverableAmountRaw: owner ? amount : '0', outstandingIntentAmountRaw: outstanding,
      transactionOnlyCapability: capability, initiationCapability: unknownFact('PERMIT2_INITIATION_CAPABILITY_UNPROVEN') }, input.snapshot.source);
  } catch (error) { return unknownFact(error instanceof Error ? error.message : 'CASHOUT_RECOVERY_UNKNOWN', input.snapshot.source); }
}
export function buildRecoverFailed(input: { descriptor: CashoutDescriptor; requestHash: string }): TxIntent {
  descriptor(input.descriptor); bytes32(input.requestHash);
  return { to: input.descriptor.relay, abi: [...CASHOUT_RELAY_ABI_V1], method: 'recoverFailed', args: [input.requestHash], value: '0',
    meta: { domain: 'cashout', action: 'recover-failed', summary: { chainId: input.descriptor.chainId, token: input.descriptor.token, requestHash: input.requestHash } } };
}
export function buildWithdrawDeposit(input: { descriptor: CashoutDescriptor; depositId: string }): TxIntent {
  descriptor(input.descriptor);
  const depositId = requireRawUint(input.depositId);
  return { to: input.descriptor.escrow, abi: [...CASHOUT_ESCROW_ABI_V1], method: 'withdrawDeposit', args: [depositId], value: '0',
    meta: { domain: 'cashout', action: 'withdraw-deposit', summary: { chainId: input.descriptor.chainId, token: input.descriptor.token, depositId } } };
}
