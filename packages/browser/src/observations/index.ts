import { ethers } from 'ethers';
import { getAbi } from '@poa-box/core/contracts';
import { knownFact, unknownFact } from '@poa-box/core/data/facts';
import { submissionIntentKey } from '@poa-box/core/execute/recovery';
import type { WorkflowHost } from '../workflows/types';
import { address, fail, ObservationRuntime, uint, WorkflowReaderOptions } from './common';
import { pollReader, ballotReader } from './governance';
import { enrollmentReader } from './enrollment';
import { taskReader } from './tasks';
export type { WorkflowReaderOptions, ObservationProvider, ObservationLimits } from './common';
export const SUPPORTED_WORKFLOW_OBSERVATION_DEPLOYMENTS = ['authority-v2'] as const;

/** Protocol observation assembly for complete authority-bound V2 deployments.
 * Only injected read ports are used; this factory never connects a wallet,
 * publishes metadata, signs, broadcasts or acquires an account lease.
 */
export function createWorkflowReaders(options: WorkflowReaderOptions) {
  const runtime = new ObservationRuntime(options);
  const simulate: WorkflowHost['simulate'] = (call, action) => runtime.run(action.scope, action.signal, async signal => {
    const contract = address(call.to);
    if (typeof call.data !== 'string' || !/^0x(?:[\da-f]{2})*$/i.test(call.data) || typeof call.value !== 'string') fail('EXACT_SIMULATION_CALL_REQUIRED');
    uint(call.value);
    const key = Object.entries(runtime.scope.contracts).find(([key, value]) => value === contract && ['hybridVoting', 'directDemocracyVoting', 'quickJoin', 'taskManager'].includes(key))?.[0];
    const abiName = key === 'hybridVoting' ? 'HybridVotingNew' : key === 'directDemocracyVoting' ? 'DirectDemocracyVotingNew'
      : key === 'quickJoin' ? 'QuickJoinNew' : key === 'taskManager' ? 'TaskManagerNew' : undefined;
    if (!abiName) fail('SIMULATION_MODULE_UNSUPPORTED');
    const [network, latest] = await Promise.all([runtime.options.provider.getNetwork(), runtime.options.provider.getBlock('latest')]); runtime.guard(signal);
    if (network.chainId !== runtime.scope.chainId || !latest) fail('RPC_CHAIN_OR_BLOCK_MISMATCH');
    const block = { number: uint(latest.number, 31), hash: latest.hash, timestamp: uint(latest.timestamp, 64) };
    await runtime.canonical(block, signal);
    // Empty code cannot masquerade as a successful zero-return eth_call.
    const observed = await runtime.rpc(contract, getAbi(abiName), key === 'taskManager' ? 'getLensData' : 'executor', key === 'taskManager' ? [4, '0x'] : [], block, signal);
    const executor = key === 'taskManager' ? ethers.utils.defaultAbiCoder.decode(['address'], observed)[0] : observed;
    if (address(executor) !== runtime.scope.contracts.executor) fail('SIMULATION_MODULE_BINDING_MISMATCH');
    const source = runtime.source(contract, false, block, 'workflow-exact-simulation', runtime.scope.account);
    let succeeds;
    try {
      const result = await runtime.options.provider.call({ to: contract, from: runtime.scope.account, data: call.data, value: call.value }, Number(block.number));
      runtime.guard(signal);
      if (typeof result !== 'string' || !/^0x(?:[\da-f]{2})*$/i.test(result)) fail('SIMULATION_RESPONSE_UNAVAILABLE');
      succeeds = knownFact(true, source);
    } catch (error) {
      runtime.guard(signal);
      const failure = error as { code?: string; data?: unknown };
      // Only an explicit EVM call exception establishes a revert. Generic RPC
      // failures and missing/malformed return data remain unknown.
      succeeds = failure.code === 'CALL_EXCEPTION' && typeof failure.data === 'string' && /^0x(?:[\da-f]{2})*$/i.test(failure.data)
        ? knownFact(false, source) : unknownFact<boolean>('SIMULATION_UNAVAILABLE', source);
    }
    await runtime.canonical(block, signal);
    return runtime.snapshot({ callKey: submissionIntentKey([call]), succeeds }, source);
  });
  return { poll: pollReader(runtime), ballot: ballotReader(runtime), enrollment: enrollmentReader(runtime), task: taskReader(runtime), simulate };
}
