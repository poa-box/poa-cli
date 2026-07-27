/**
 * Shared helpers for education commands.
 *
 * EducationHub facts (verified contracts origin/main src/EducationHub.sol):
 *   - getModule(id) returns (uint256 payout, bool exists) and REVERTS
 *     ModuleUnknown for unknown ids — so a failed eth_call means "does not
 *     exist", not an RPC problem, in checkModuleExists.
 *   - hasCompleted(learner, id) is the per-account completion bitmap;
 *     completeModule reverts AlreadyCompleted on a second attempt.
 *   - Module metadata (title bytes + contentHash) is EVENT-ONLY — the chain
 *     stores just {answerHash, payout, exists}, so current title/metadata
 *     must come from the subgraph/IPFS.
 */

import { ethers } from 'ethers';
import type { PreflightCheck } from '../../lib/preflight';

export const EDU_READ_IFACE = new ethers.utils.Interface([
  'function getModule(uint256 id) view returns (uint256 payout, bool exists)',
  'function hasCompleted(address learner, uint256 id) view returns (bool)',
]);

/**
 * Module exists on-chain. getModule reverts ModuleUnknown for unknown ids,
 * so an unsuccessful call IS the "not found" signal.
 */
export function checkModuleExists(educationHubAddr: string, moduleId: ethers.BigNumberish): PreflightCheck {
  const id = ethers.BigNumber.from(moduleId);
  return {
    label: `module ${id.toString()}`,
    call: {
      to: educationHubAddr,
      data: EDU_READ_IFACE.encodeFunctionData('getModule', [id]),
    },
    interpret: (returnData, success) => {
      if (!success || !returnData || returnData === '0x') {
        return {
          ok: false,
          detail: 'module does not exist on-chain (getModule reverted ModuleUnknown)',
          suggestion: 'list modules with pop education list',
        };
      }
      const [, exists] = EDU_READ_IFACE.decodeFunctionResult('getModule', returnData);
      if (exists) return { ok: true };
      return { ok: false, detail: 'module does not exist on-chain', suggestion: 'list modules with pop education list' };
    },
  };
}

/**
 * Learner has NOT already completed the module (completeModule reverts
 * AlreadyCompleted otherwise — each module pays out once per account).
 */
export function checkNotCompleted(
  educationHubAddr: string,
  learner: string,
  moduleId: ethers.BigNumberish
): PreflightCheck {
  const id = ethers.BigNumber.from(moduleId);
  return {
    label: `module ${id.toString()} completion`,
    call: {
      to: educationHubAddr,
      data: EDU_READ_IFACE.encodeFunctionData('hasCompleted', [learner, id]),
    },
    interpret: (returnData, success) => {
      if (!success || !returnData || returnData === '0x') {
        return { ok: false, detail: 'could not read completion state', suggestion: 'check RPC connectivity' };
      }
      const [completed] = EDU_READ_IFACE.decodeFunctionResult('hasCompleted', returnData);
      if (!completed) return { ok: true };
      return {
        ok: false,
        detail: `already completed by ${learner}`,
        suggestion: 'each module pays out once per account — pick another with pop education list',
      };
    },
  };
}
