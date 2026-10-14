import { ethers } from 'ethers';
import { requireRawUint } from '../amounts';
import type { ExecutionCall } from '../tx/governance';

export type GovernanceLane = 'hybrid' | 'dd';
/** Inspected voting/Executor constants; product duration policy remains host-owned. */
export const GOVERNANCE_LIMITS = Object.freeze({ maxCallsPerBatch: 20, maxOptions: 50, maxClasses: 8,
  maxPollSubjects: 100, minDurationMinutes: 10, maxDurationMinutes: 43200 });
export const CONFIG_CAPABILITIES = Object.freeze({
  hybrid: [
    { key: 0, name: 'threshold', types: ['uint8'], status: 'live', units: 'support-percent' },
    { key: 1, name: 'target-allowed', types: ['address', 'bool'], status: 'deprecated-noop' },
    { key: 2, name: 'executor', types: ['address'], status: 'live' },
    { key: 3, name: 'quorum', types: ['uint32'], status: 'live', units: 'voter-count' },
  ],
  dd: [
    { key: 0, name: 'threshold', types: ['uint8'], status: 'live', units: 'support-percent' },
    { key: 1, name: 'executor', types: ['address'], status: 'live' },
    { key: 2, name: 'target-allowed', types: ['address', 'bool'], status: 'live' },
    { key: 3, name: 'hat-allowed', types: ['uint256', 'bool'], status: 'retired-reverts' },
    { key: 4, name: 'quorum', types: ['uint32'], status: 'live', units: 'voter-count' },
  ],
} as const);

export function classifyGovernanceConfigKey(lane: GovernanceLane, key: number) {
  return CONFIG_CAPABILITIES[lane].find(row => row.key === key);
}
/** Explicit raw-setting guard; low-level generic ABI encoding remains available. */
export function requireLiveGovernanceConfigKey(lane: GovernanceLane, key: number): void {
  const row = classifyGovernanceConfigKey(lane, key);
  if (!row || row.status !== 'live') throw new Error(row?.status === 'deprecated-noop' ? 'DEPRECATED_CONFIG_NOOP' : 'UNSUPPORTED_CONFIG_KEY');
}

export function validateGovernanceBatches(batches: readonly (readonly ExecutionCall[])[], numOptions?: number): void {
  if (!Array.isArray(batches)) throw new Error('INVALID_BATCHES');
  if (numOptions !== undefined && (!Number.isSafeInteger(numOptions) || numOptions < 1 || numOptions > GOVERNANCE_LIMITS.maxOptions
    || (batches.length !== 0 && batches.length !== numOptions))) throw new Error('INVALID_OPTION_BATCH_COUNT');
  for (const batch of batches) {
    if (!Array.isArray(batch)) throw new Error('INVALID_BATCH');
    if (batch.length > GOVERNANCE_LIMITS.maxCallsPerBatch) throw new Error('TOO_MANY_CALLS');
    for (const call of batch) {
      if (!call || !ethers.utils.isAddress(call.target) || call.target.toLowerCase() === ethers.constants.AddressZero
        || !/^0x(?:[\da-f]{2})*$/i.test(call.calldata)) throw new Error('INVALID_EXECUTION_CALL');
      requireRawUint(typeof call.value === 'number' ? call.value : ethers.BigNumber.from(call.value).toString());
    }
  }
}
/** Binding protocol policy: any actual call requires Hybrid, regardless of draft intent label.
 * DD's legacy ABI still carries batches; that does not make it the binding lane. */
export function votingLaneForBatches(batches: readonly (readonly ExecutionCall[])[], pollLane: GovernanceLane = 'dd'): GovernanceLane {
  validateGovernanceBatches(batches);
  if (pollLane !== 'hybrid' && pollLane !== 'dd') throw new Error('INVALID_VOTING_LANE');
  return batches.some(batch => batch.length > 0) ? 'hybrid' : pollLane;
}
