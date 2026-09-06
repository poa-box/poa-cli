/**
 * Pre-flight Checks
 * Read-only validations that run before a write command sends its
 * transaction, so predictable failures surface as one actionable message
 * instead of an on-chain revert (or a silent wrong-state write). Contract
 * reads batch through Multicall3 in a single RPC round-trip; local checks
 * run concurrently. ALL failures are collected before throwing.
 */

import { ethers } from 'ethers';
import { PreconditionError } from './errors';
import { tryAggregate, getEthBalanceCall, decodeEthBalance } from './multicall';
import { getAbi } from './contracts';
import { formatToken } from './format';
import {
  STORAGE_KEYS,
  TASK_STATUS,
  taskStatusName,
  encodeLensCall,
  decodeLensResult,
  decodeTaskInfo,
  deriveClaimState,
  TaskOnChain,
} from './task-lens';
import type { SponsoredConfig } from './sponsorship-config';

export interface CheckResult {
  ok: boolean;
  detail?: string;
  suggestion?: string;
}

export interface PreflightCheck {
  /** Short human label, e.g. 'gas balance' or 'task 12 status'. */
  label: string;
  /** Read-only eth_call, batched through Multicall3 with the other checks. */
  call?: { to: string; data: string };
  /** Local/off-chain check; runs concurrently with the batched calls. */
  local?: () => Promise<CheckResult> | CheckResult;
  /** Interpret the batched call's result. Used only when `call` is set. */
  interpret?: (returnData: string, success: boolean) => CheckResult;
}

interface Failure {
  label: string;
  detail?: string;
  suggestion?: string;
}

function formatFailure(f: Failure): string {
  let line = `  ✗ ${f.label}`;
  if (f.detail) line += `: ${f.detail}`;
  if (f.suggestion) line += ` (${f.suggestion})`;
  return line;
}

/**
 * Run all checks (batched calls + concurrent locals), collect every failure,
 * and throw a single PreconditionError listing them. `opts.skip` (from a
 * --skip-checks flag) bypasses everything.
 */
export async function runPreflight(
  provider: ethers.providers.Provider,
  checks: PreflightCheck[],
  opts?: { skip?: boolean }
): Promise<void> {
  if (opts?.skip || checks.length === 0) return;

  const callIndexes: number[] = [];
  const calls: Array<{ to: string; data: string }> = [];
  const localIndexes: number[] = [];
  checks.forEach((check, i) => {
    if (check.call) {
      callIndexes.push(i);
      calls.push(check.call);
    } else if (check.local) {
      localIndexes.push(i);
    }
  });

  const [callResults, localResults] = await Promise.all([
    tryAggregate(provider, calls),
    Promise.all(
      localIndexes.map(async (i) => {
        try {
          return await checks[i].local!();
        } catch (err: any) {
          return { ok: false, detail: err?.message || String(err) };
        }
      })
    ),
  ]);

  const results: Array<CheckResult | undefined> = new Array(checks.length);
  callIndexes.forEach((checkIdx, i) => {
    const check = checks[checkIdx];
    const { success, returnData } = callResults[i];
    try {
      results[checkIdx] = check.interpret
        ? check.interpret(returnData, success)
        : { ok: success, detail: success ? undefined : 'call reverted' };
    } catch (err: any) {
      results[checkIdx] = { ok: false, detail: `could not interpret result: ${err?.message || err}` };
    }
  });
  localIndexes.forEach((checkIdx, i) => {
    results[checkIdx] = localResults[i];
  });

  const failures: Failure[] = [];
  checks.forEach((check, i) => {
    const result = results[i];
    if (result && !result.ok) {
      failures.push({ label: check.label, detail: result.detail, suggestion: result.suggestion });
    }
  });

  if (failures.length > 0) {
    throw new PreconditionError(
      `Pre-flight checks failed:\n${failures.map(formatFailure).join('\n')}`
    );
  }
}

const DEFAULT_MIN_GAS_WEI = ethers.utils.parseEther('0.0001');

/**
 * Wallet holds at least `minWei` (default 0.0001 ether) of the chain's
 * native gas token, read via Multicall3.getEthBalance. Pass the resolved
 * sponsorship config as `sponsored` to skip the check for sponsored wallets
 * (the CLI resolves it from env via resolveSponsoredConfig).
 */
export function checkGasBalance(
  address: string,
  minWei?: ethers.BigNumber,
  sponsored?: SponsoredConfig
): PreflightCheck {
  const min = minWei ?? DEFAULT_MIN_GAS_WEI;
  // Sponsored writes (EIP-7702 / ERC-4337) don't spend the EOA's own gas, so a
  // zero balance is expected and fine — the whole point of the "members
  // transact without ever holding gas" path. When sponsorship is configured,
  // skip the balance requirement rather than forcing --no-preflight. (If the
  // EOA isn't actually delegated, executeContractTx falls back to a direct tx
  // whose own gas estimation surfaces the shortfall with a decoded error.)
  if (sponsored !== undefined) {
    return { label: 'gas balance', local: () => ({ ok: true }) };
  }
  return {
    label: 'gas balance',
    call: getEthBalanceCall(address),
    interpret: (returnData, success) => {
      if (!success || !returnData || returnData === '0x') {
        return { ok: false, detail: 'could not read wallet balance', suggestion: 'check RPC connectivity' };
      }
      const balance = decodeEthBalance(returnData);
      if (balance.gte(min)) return { ok: true };
      return {
        ok: false,
        detail: `wallet holds ${formatToken(balance)} native gas token, below the ${formatToken(min)} minimum`,
        suggestion: `fund ${address} with gas before retrying`,
      };
    },
  };
}

const AUTHORITY_MEMBERSHIP_IFACE = new ethers.utils.Interface([
  'function isMember(uint256 subject,address user) view returns (bool)',
]);

/** Live accepted-and-eligible membership check for transaction preflight. */
export function checkSubjectMembership(authorityAddress: string, user: string, subject: ethers.BigNumberish): PreflightCheck {
  const id = ethers.BigNumber.from(subject);
  return { label: 'authority membership',
    call: { to: authorityAddress, data: AUTHORITY_MEMBERSHIP_IFACE.encodeFunctionData('isMember', [id, user]) },
    interpret: (data, success) => {
      if (!success || !data || data === '0x') return { ok: false, detail: 'Could not read MembershipAuthority membership' };
      if (AUTHORITY_MEMBERSHIP_IFACE.decodeFunctionResult('isMember', data)[0]) return { ok: true };
      return { ok: false, detail: `${user} is not a member of subject ${id.toString()}`, suggestion: 'List roles with pop org roles and accept eligible roles with pop role claim' };
    } };
}

let uarInterface: ethers.utils.Interface | null = null;

function getUarInterface(): ethers.utils.Interface {
  if (!uarInterface) {
    uarInterface = new ethers.utils.Interface(getAbi('UniversalAccountRegistry'));
  }
  return uarInterface;
}

/** Username is unregistered (UAR getAddressOfUsername returns the zero address). */
export function checkUsernameFree(registryAddr: string, username: string): PreflightCheck {
  return {
    label: `username "${username}"`,
    call: {
      to: registryAddr,
      data: getUarInterface().encodeFunctionData('getAddressOfUsername', [username]),
    },
    interpret: (returnData, success) => {
      if (!success || !returnData || returnData === '0x') {
        return { ok: false, detail: 'could not query the account registry', suggestion: 'verify the registry address' };
      }
      const holder = getUarInterface().decodeFunctionResult('getAddressOfUsername', returnData)[0] as string;
      if (holder === ethers.constants.AddressZero) return { ok: true };
      return {
        ok: false,
        detail: `already registered to ${holder}`,
        suggestion: 'pick a different username',
      };
    },
  };
}

/**
 * Task is in one of `allowedStatuses` (authoritative on-chain read via
 * TaskManager.getLensData). Options:
 * - claimerMustBe: task.claimer must equal this address (case-insensitive)
 * - allowExpiredTakeover: a CLAIMED task outside allowedStatuses still passes
 *   when its claim deadline has lapsed (deriveClaimState === 'expired-claimable')
 * - now: injectable unix timestamp for deadline math (tests)
 */
export function checkTaskStatus(
  taskManagerAddr: string,
  taskId: ethers.BigNumberish,
  allowedStatuses: number[],
  opts?: { claimerMustBe?: string; allowExpiredTakeover?: boolean; now?: number }
): PreflightCheck {
  const id = ethers.BigNumber.from(taskId);
  return {
    label: `task ${id.toString()} status`,
    call: {
      to: taskManagerAddr,
      data: encodeLensCall(STORAGE_KEYS.TASK_INFO, ethers.utils.defaultAbiCoder.encode(['uint256'], [id])),
    },
    interpret: (returnData, success) => {
      if (!success || !returnData || returnData === '0x') {
        return {
          ok: false,
          detail: 'could not read the task on-chain — it may not exist',
          suggestion: 'check the task ID with pop task list',
        };
      }
      let task: TaskOnChain;
      try {
        task = decodeTaskInfo(decodeLensResult(returnData));
      } catch {
        return { ok: false, detail: 'could not decode on-chain task data', suggestion: 'check the task ID' };
      }

      if (!allowedStatuses.includes(task.status)) {
        if (opts?.allowExpiredTakeover && task.status === TASK_STATUS.CLAIMED) {
          if (deriveClaimState(task, opts.now) === 'expired-claimable') {
            return { ok: true, detail: `previous claim by ${task.claimer} expired — takeover allowed` };
          }
          return {
            ok: false,
            detail: `claimed by ${task.claimer} and the claim deadline has not passed`,
            suggestion: 'wait for the claim to expire or pick another task',
          };
        }
        return {
          ok: false,
          detail: `status is ${taskStatusName(task.status)}, expected ${allowedStatuses.map(taskStatusName).join(' or ')}`,
          suggestion: 'inspect the task with pop task view',
        };
      }

      if (opts?.claimerMustBe && task.claimer.toLowerCase() !== opts.claimerMustBe.toLowerCase()) {
        return {
          ok: false,
          detail: `claimed by ${task.claimer}, not ${opts.claimerMustBe}`,
          suggestion: 'only the current claimer can perform this action',
        };
      }

      return { ok: true };
    },
  };
}

const VOTING_IFACE = new ethers.utils.Interface([
  'function proposalsCount() view returns (uint256 count)',
]);

/**
 * Proposal ID exists on the voting contract (proposalsCount() > id).
 *
 * Kept on RPC on purpose. Counting Proposal/DDVProposal rows in the subgraph
 * would be semantically equivalent, but it saves nothing and costs something:
 * this check's `call` rides inside the SAME Multicall3 batch as the gas-balance
 * check that every write already performs, so dropping it removes zero RPC
 * round-trips while adding a subgraph round-trip. Worse, the propose→cast
 * sequence agents run means the proposal is frequently seconds old, and an
 * un-indexed row would block a perfectly legitimate vote. Net: strictly worse.
 */
export function checkProposalActive(votingAddr: string, proposalId: number): PreflightCheck {
  return {
    label: `proposal ${proposalId}`,
    call: { to: votingAddr, data: VOTING_IFACE.encodeFunctionData('proposalsCount') },
    interpret: (returnData, success) => {
      if (!success || !returnData || returnData === '0x') {
        return { ok: false, detail: 'could not read proposalsCount', suggestion: 'verify the voting contract address' };
      }
      const count = VOTING_IFACE.decodeFunctionResult('proposalsCount', returnData)[0] as ethers.BigNumber;
      if (count.gt(proposalId)) return { ok: true };
      const detail = count.isZero()
        ? `proposal ${proposalId} does not exist — no proposals have been created yet`
        : `proposal ${proposalId} does not exist — proposal IDs run 0 to ${count.sub(1).toString()}`;
      return { ok: false, detail, suggestion: 'list proposals with pop vote list' };
    },
  };
}
