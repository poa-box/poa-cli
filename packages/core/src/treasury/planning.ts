import { ethers } from 'ethers';
import { parseDecimalAmountToRaw, requireAssetRef, requireRawUint, type AssetRef, type RawAssetAmount } from '../amounts';
import { assertPlanScope, assertSourceBlock, assertSourceRef, requireCompleteSnapshot, type Fact, type PlanResult, type PlanScope, type SourceBlock, type SourceSnapshot } from '../data/facts';
import type { ExecutionCall } from '../tx/governance';
import { validateGovernanceBatches } from '../governance/capabilities';
import { assertTreasuryModuleBindings } from './evidence';

export interface ExactRecipient { to: string; amount: string }
export interface RawRecipient { to: string; amountRaw: string }
export function prepareExactRecipients(recipients: readonly ExactRecipient[], decimals: number): RawRecipient[] {
  return validateRawRecipients(recipients.map(r => ({ to: r.to, amountRaw: parseDecimalAmountToRaw(r.amount, decimals) })));
}
export function validateRawRecipients(recipients: readonly RawRecipient[]): RawRecipient[] {
  if (!Array.isArray(recipients) || recipients.length === 0 || recipients.length > 8) throw new Error('INVALID_RECIPIENT_COUNT');
  return recipients.map(r => {
    const to = nonzeroAddress(r.to);
    const amountRaw = requireRawUint(r.amountRaw);
    if (amountRaw === '0') throw new Error('ZERO_AMOUNT');
    return { to, amountRaw };
  });
}
/** Deliberate null/empty/zero aliases only. Arbitrary token metadata is injected. */
export function treasuryTokenAddress(token: string | null): string {
  return token === null || token === '' ? ethers.constants.AddressZero : ethers.utils.getAddress(token);
}
function nonzeroAddress(address: string): string {
  const value = ethers.utils.getAddress(address);
  if (value === ethers.constants.AddressZero) throw new Error('ZERO_ADDRESS');
  return value;
}
function uint(value: string): bigint { return BigInt(requireRawUint(value)); }
function add(a: bigint, b: bigint): bigint { return BigInt(requireRawUint(a + b)); }
function blocked<T>(error: unknown): PlanResult<T> {
  const message = error instanceof Error ? error.message : '';
  const explicit = error && typeof error === 'object' && 'code' in error ? String(error.code) : message;
  const code = /^[A-Z][A-Z0-9_]*$/.test(explicit) ? explicit : 'INVALID_TREASURY_EVIDENCE';
  return { status: 'blocked', codes: [code], prerequisites: [{ code }], consequences: [] };
}
function sameAsset(a: AssetRef, b: AssetRef): void {
  requireAssetRef(a); requireAssetRef(b);
  if (a.chainId !== b.chainId || a.address.toLowerCase() !== b.address.toLowerCase() || a.decimals !== b.decimals) throw new Error('ASSET_MISMATCH');
}
function complete<T>(snapshot: SourceSnapshot<T>, scope: PlanScope, block: SourceBlock): T {
  if (!ethers.utils.isHexString(scope.orgId, 32) || !scope.contract) throw new Error('EXPLICIT_ORG_CONTRACT_REQUIRED');
  nonzeroAddress(scope.contract);
  return requireCompleteSnapshot(snapshot, { scope, block, indexed: false, snapshot: 'pinned' });
}
export interface PaymentManagerRound {
  distributionId: string;
  payoutToken: string;
  totalAmount: string;
  totalClaimed: string;
  finalized: boolean;
  checkpointBlock: string;
  /** No getDistribution creationBlock getter. Supply independently scoped creation-event facts. */
  creationBlock: Fact<string>;
}
export interface PaymentManagerState {
  asset: AssetRef;
  balanceRaw: string;
  distributionCounterRaw: string;
  /** All IDs 1..counter, including finalized rounds and other assets. */
  rounds: readonly PaymentManagerRound[];
  /** Optional independent fact; this contract has no public totalCommitted getter. */
  commitmentRaw?: Fact<string>;
}
export interface PaymentManagerAvailabilityInput {
  snapshot: SourceSnapshot<PaymentManagerState>;
  scope: PlanScope;
  block: SourceBlock;
  asset: AssetRef;
  minClaimPeriodBlocks: string;
}
export interface PaymentManagerAvailability {
  balanceRaw: string;
  committedRaw: string;
  spendableRaw: string;
  releasableRaw: string;
  spendableAfterReleaseRaw: string;
  finalizeIds: readonly string[];
  commitmentProvenance: 'derived-complete-rpc-enumeration';
}
function assertPaymentManagerBindings(snapshot: SourceSnapshot<PaymentManagerState>, scope: PlanScope): void {
  const binding = { chainId: scope.chainId, contracts: { paymentManager: scope.contract! } };
  assertTreasuryModuleBindings(snapshot.source, scope, binding);
  for (const fact of [...(Array.isArray(snapshot.data.rounds) ? snapshot.data.rounds.map(round => round.creationBlock) : []), snapshot.data.commitmentRaw]) {
    if (fact?.source) assertTreasuryModuleBindings(fact.source, snapshot.source, scope, binding);
  }
}
/** Solvency evidence is an authoritative, same-block complete RPC enumeration.
 * A claim never releases commitment. Partial rounds are never automatically closed. */
export function paymentManagerAvailability(input: PaymentManagerAvailabilityInput): PlanResult<PaymentManagerAvailability> {
  try {
    const state = complete(input.snapshot, input.scope, input.block);
    assertPaymentManagerBindings(input.snapshot, input.scope);
    sameAsset(state.asset, input.asset);
    if (input.asset.chainId !== input.scope.chainId) throw new Error('ASSET_CHAIN_MISMATCH');
    const balance = uint(state.balanceRaw), counter = uint(state.distributionCounterRaw);
    const period = uint(input.minClaimPeriodBlocks), now = uint(input.block.number);
    if (!Array.isArray(state.rounds) || BigInt(state.rounds.length) !== counter) throw new Error('ROUND_COUNTER_MISMATCH');
    const ids = new Set<string>();
    let committed = 0n, releasable = 0n;
    const finalizeIds: string[] = [];
    for (const round of state.rounds) {
      const id = requireRawUint(round.distributionId), numericId = BigInt(id);
      if (numericId === 0n || numericId > counter || ids.has(id)) throw new Error('MISSING_OR_DUPLICATE_ROUND');
      ids.add(id);
      const total = uint(round.totalAmount), claimed = uint(round.totalClaimed), checkpoint = uint(round.checkpointBlock);
      const token = ethers.utils.getAddress(round.payoutToken);
      if (total === 0n || claimed > total || typeof round.finalized !== 'boolean' || checkpoint >= now) throw new Error('INCONSISTENT_ROUND');
      if (round.finalized || token.toLowerCase() !== input.asset.address.toLowerCase()) continue;
      committed = add(committed, total);
      if (claimed !== total) continue;
      if (round.creationBlock.state !== 'known') throw new Error('CREATION_BLOCK_UNKNOWN');
      if (round.creationBlock.source) {
        assertSourceRef(round.creationBlock.source);
        assertPlanScope(round.creationBlock.source, { chainId: input.scope.chainId, orgId: input.scope.orgId, contract: input.scope.contract });
        if (round.creationBlock.source.snapshot !== 'pinned') throw new Error('CREATION_BLOCK_UNPINNED');
        assertSourceBlock(round.creationBlock.source.block, input.block);
      }
      const creation = uint(round.creationBlock.value), anchor = creation === 0n ? checkpoint : creation;
      if (creation > now || (creation !== 0n && creation <= checkpoint)) throw new Error('INCONSISTENT_CREATION_BLOCK');
      const eligibleAt = add(anchor, period);
      if (now >= eligibleAt) { releasable = add(releasable, total); finalizeIds.push(id); }
    }
    if (state.commitmentRaw) {
      if (state.commitmentRaw.state !== 'known') throw new Error('COMMITMENT_UNKNOWN');
      if (state.commitmentRaw.source) {
        assertSourceRef(state.commitmentRaw.source);
        assertPlanScope(state.commitmentRaw.source, { ...input.scope, contracts: undefined });
        assertSourceBlock(state.commitmentRaw.source.block, input.block);
        if (state.commitmentRaw.source.indexed || state.commitmentRaw.source.snapshot !== 'pinned') throw new Error('COMMITMENT_SOURCE_MISMATCH');
      }
      if (uint(state.commitmentRaw.value) !== committed) throw new Error('COMMITMENT_MISMATCH');
    }
    finalizeIds.sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
    return { status: 'ready', data: { balanceRaw: balance.toString(), committedRaw: committed.toString(),
      spendableRaw: (balance > committed ? balance - committed : 0n).toString(), releasableRaw: releasable.toString(),
      spendableAfterReleaseRaw: (balance > committed - releasable ? balance - (committed - releasable) : 0n).toString(),
      finalizeIds, commitmentProvenance: 'derived-complete-rpc-enumeration' }, consequences: [] };
  } catch (error) { return blocked(error); }
}
export type TreasuryTransferSource =
  | { kind: 'executor'; address: string; balance: SourceSnapshot<RawAssetAmount> }
  | { kind: 'payment-manager'; address: string; snapshot: SourceSnapshot<PaymentManagerState> };
export interface TreasuryTransferInput {
  scope: PlanScope;
  block: SourceBlock;
  asset: AssetRef;
  destination: string;
  amountRaw: string;
  /** Explicit preference order. No implicit pot selection or partial-source fallback. */
  sources: readonly TreasuryTransferSource[];
  minClaimPeriodBlocks: string;
}
export interface TreasuryTransferPlan {
  source: 'executor' | 'payment-manager'; sourceAddress: string; destination: string;
  asset: AssetRef; amountRaw: string; finalizeIds: readonly string[]; calls: ExecutionCall[];
}
const TRANSFER = new ethers.utils.Interface(['function transfer(address to,uint256 amount)']);
const PAYMENT = new ethers.utils.Interface(['function finalizeDistribution(uint256 distributionId,uint256 minClaimPeriodBlocks)', 'function withdraw(address token,address to,uint256 amount)']);
export function planTreasuryTransfer(input: TreasuryTransferInput): PlanResult<TreasuryTransferPlan> {
  try {
    requireAssetRef(input.asset);
    if (!ethers.utils.isHexString(input.scope.orgId, 32) || input.scope.chainId !== input.asset.chainId) throw new Error('EXPLICIT_ASSET_ORG_SCOPE_REQUIRED');
    const destination = nonzeroAddress(input.destination), amount = uint(input.amountRaw);
    uint(input.minClaimPeriodBlocks); uint(input.block.number);
    if (amount === 0n) throw new Error('ZERO_AMOUNT');
    if (!Array.isArray(input.sources) || !input.sources.length) throw new Error('TRANSFER_SOURCE_REQUIRED');
    const seen = new Set<string>();
    const sources: readonly TreasuryTransferSource[] = input.sources;
    for (const candidate of sources) {
      const address = nonzeroAddress(candidate.address);
      if (seen.has(address.toLowerCase())) throw new Error('DUPLICATE_TRANSFER_SOURCE');
      seen.add(address.toLowerCase());
      const installed = input.scope.contracts?.[candidate.kind === 'executor' ? 'executor' : 'paymentManager'];
      if (!installed || installed.toLowerCase() !== address.toLowerCase()) throw new Error('TRANSFER_MODULE_BINDING_MISMATCH');
      const observedSource = candidate.kind === 'executor' ? candidate.balance.source : candidate.snapshot.source;
      for (const [key, expected] of Object.entries(input.scope.contracts ?? {})) {
        if (observedSource.contracts?.[key] !== undefined) assertPlanScope(observedSource, { chainId: input.scope.chainId, contracts: { [key]: expected } });
      }
      if (address.toLowerCase() === destination.toLowerCase()) throw new Error('SELF_TRANSFER');
      const scope = { chainId: input.scope.chainId, orgId: input.scope.orgId, contract: address };
      let finalizeIds: string[] = [], calls: ExecutionCall[] = [];
      if (candidate.kind === 'executor') {
        const balance = complete(candidate.balance, scope, input.block);
        sameAsset(balance.asset, input.asset);
        if (uint(balance.rawAmount) < amount) continue;
        calls = input.asset.address.toLowerCase() === ethers.constants.AddressZero
          ? [{ target: destination, value: amount.toString(), calldata: '0x' }]
          : [{ target: input.asset.address, value: '0', calldata: TRANSFER.encodeFunctionData('transfer', [destination, amount.toString()]) }];
      } else if (candidate.kind === 'payment-manager') {
        assertPaymentManagerBindings(candidate.snapshot, { ...input.scope, contract: address });
        const availability = paymentManagerAvailability({ ...input, scope, snapshot: candidate.snapshot });
        if (availability.status === 'blocked') return availability;
        if (uint(availability.data.spendableAfterReleaseRaw) < amount) continue;
        let remaining = uint(availability.data.committedRaw);
        for (const id of availability.data.finalizeIds) {
          if (remaining + amount <= uint(availability.data.balanceRaw)) break;
          remaining -= uint(candidate.snapshot.data.rounds.find(r => requireRawUint(r.distributionId) === id)!.totalAmount);
          finalizeIds.push(id);
          calls.push({ target: address, value: '0', calldata: PAYMENT.encodeFunctionData('finalizeDistribution', [id, input.minClaimPeriodBlocks]) });
        }
        if (add(remaining, amount) > uint(availability.data.balanceRaw)) throw new Error('INSUFFICIENT_SPENDABLE');
        calls.push({ target: address, value: '0', calldata: PAYMENT.encodeFunctionData('withdraw', [input.asset.address, destination, amount.toString()]) });
      } else throw new Error('INVALID_TRANSFER_SOURCE');
      validateGovernanceBatches([calls, []], 2);
      return { status: 'ready', data: { source: candidate.kind, sourceAddress: address, destination, asset: { ...input.asset }, amountRaw: amount.toString(), finalizeIds, calls },
        consequences: [{ code: 'REVALIDATE_BEFORE_EXECUTION' }] };
    }
    throw new Error('INSUFFICIENT_SPENDABLE');
  } catch (error) { return blocked(error); }
}
export function buildTreasuryTransferCalls(input: TreasuryTransferInput): PlanResult<ExecutionCall[]> {
  const plan = planTreasuryTransfer(input);
  return plan.status === 'ready' ? { ...plan, data: plan.data.calls } : plan;
}
