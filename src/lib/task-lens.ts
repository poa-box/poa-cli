/**
 * TaskManager Lens Reader
 * Authoritative on-chain task state via TaskManager.getLensData(uint8,bytes),
 * bypassing subgraph lag. Key numbering and tuple shapes verified against
 * contracts repo origin/main src/TaskManager.sol (getLensData dispatcher) and
 * src/lens/TaskManagerLens.sol (whose getStorage routes through the same
 * variants).
 */

import { ethers } from 'ethers';
import { loadAbi } from './contracts';
import { parseTaskId } from './encoding';

/**
 * TaskManager.getLensData variant selectors, verified against contracts repo
 * origin/main src/TaskManager.sol. NOTE: these are NOT the TaskManagerLens.sol
 * StorageKey enum indexes — that enum keys the lens contract's own
 * getStorage(); the CLI calls the TaskManager dispatcher directly with the
 * variant numbers below (TaskManagerLens.sol itself forwards to these).
 */
export const STORAGE_KEYS = {
  /** abi.encode(uint256 id) → task tuple (see decodeTaskInfo) */
  TASK_INFO: 1,
  /** abi.encode(bytes32 pid) → (uint128 cap, uint128 spent, bool exists) */
  PROJECT_INFO: 2,
  /** '' → (address hats) */
  HATS: 3,
  /** '' → (address executor) */
  EXECUTOR: 4,
  /** '' → (uint256[] hatIds) */
  CREATOR_HATS: 5,
  /** '' → (uint256[] hatIds) */
  PERMISSION_HATS: 6,
  /** abi.encode(uint256 id) → (address[] applicants) */
  TASK_APPLICANTS: 7,
  /** abi.encode(uint256 id, address applicant) → (bytes32 hash) */
  TASK_APPLICATION: 8,
  /** abi.encode(bytes32 pid, address token) → (uint128 cap, uint128 spent) */
  BOUNTY_BUDGET: 9,
  /** '' → (bytes32 foldersRoot) */
  FOLDERS_ROOT: 10,
  /** '' → (uint256[] hatIds) */
  ORGANIZER_HATS: 11,
} as const;

/** Task Status enum (TaskManager.sol). */
export const TASK_STATUS = {
  UNCLAIMED: 0,
  CLAIMED: 1,
  SUBMITTED: 2,
  COMPLETED: 3,
  CANCELLED: 4,
} as const;

export const TASK_STATUS_NAMES: string[] = ['UNCLAIMED', 'CLAIMED', 'SUBMITTED', 'COMPLETED', 'CANCELLED'];

export function taskStatusName(status: number): string {
  return TASK_STATUS_NAMES[status] ?? `UNKNOWN(${status})`;
}

/**
 * v6 task tuple returned by getLensData variant 1 (10 static fields).
 * Pre-v6 implementations return only the first 7 (no deadline words).
 */
const TASK_TUPLE_V6 = ['bytes32', 'uint96', 'address', 'uint96', 'bool', 'uint8', 'address', 'uint48', 'uint32', 'uint48'];
const TASK_TUPLE_LEGACY = ['bytes32', 'uint96', 'address', 'uint96', 'bool', 'uint8', 'address'];

export interface TaskOnChain {
  projectId: string;
  payout: ethers.BigNumber;
  claimer: string;
  bountyPayout: ethers.BigNumber;
  requiresApplication: boolean;
  status: number;
  bountyToken: string;
  /** Unix cutoff for any claim (0 = none). Undefined on pre-v6 implementations. */
  absoluteDeadline?: number;
  /** Per-claim submission window in seconds (0 = none). Undefined pre-v6. */
  completionWindow?: number;
  /** Current claim's deadline, set on claim/assign (0 = none). Undefined pre-v6. */
  claimDeadline?: number;
}

let lensInterface: ethers.utils.Interface | null = null;

/** Minimal Interface holding just getLensData from the synced TaskManagerNew ABI. */
function getLensInterface(): ethers.utils.Interface {
  if (!lensInterface) {
    const fragment = loadAbi('TaskManagerNew').find(
      (f: any) => f.type === 'function' && f.name === 'getLensData'
    );
    if (!fragment) {
      throw new Error('getLensData not found in TaskManagerNew ABI. Run yarn sync-abis.');
    }
    lensInterface = new ethers.utils.Interface([fragment]);
  }
  return lensInterface;
}

/** Encode a raw eth_call payload for TaskManager.getLensData. */
export function encodeLensCall(key: number, params: string = '0x'): string {
  return getLensInterface().encodeFunctionData('getLensData', [key, params]);
}

/** Unwrap the `bytes` payload from a raw getLensData return. */
export function decodeLensResult(returnData: string): string {
  return getLensInterface().decodeFunctionResult('getLensData', returnData)[0];
}

async function callLens(
  provider: ethers.providers.Provider,
  taskManagerAddr: string,
  key: number,
  params: string = '0x'
): Promise<string> {
  const raw = await provider.call({ to: taskManagerAddr, data: encodeLensCall(key, params) });
  return decodeLensResult(raw);
}

function asNumber(value: ethers.BigNumber | number): number {
  return typeof value === 'number' ? value : ethers.BigNumber.from(value).toNumber();
}

/**
 * Decode the task payload from getLensData variant 1. Tries the v6 10-field
 * tuple first; pre-v6 payloads are only 7 words, so the v6 decode throws
 * (out-of-bounds) — fall back to the legacy tuple and leave the deadline
 * fields undefined.
 */
export function decodeTaskInfo(data: string): TaskOnChain {
  try {
    const d = ethers.utils.defaultAbiCoder.decode(TASK_TUPLE_V6, data);
    return {
      projectId: d[0],
      payout: d[1],
      claimer: d[2],
      bountyPayout: d[3],
      requiresApplication: d[4],
      status: asNumber(d[5]),
      bountyToken: d[6],
      absoluteDeadline: asNumber(d[7]),
      completionWindow: asNumber(d[8]),
      claimDeadline: asNumber(d[9]),
    };
  } catch {
    const d = ethers.utils.defaultAbiCoder.decode(TASK_TUPLE_LEGACY, data);
    return {
      projectId: d[0],
      payout: d[1],
      claimer: d[2],
      bountyPayout: d[3],
      requiresApplication: d[4],
      status: asNumber(d[5]),
      bountyToken: d[6],
    };
  }
}

/**
 * Read a single task's on-chain state. Accepts plain numeric IDs or
 * subgraph-format IDs ("contractAddress-taskId").
 */
export async function getTaskOnChain(
  provider: ethers.providers.Provider,
  taskManagerAddr: string,
  taskId: string | number
): Promise<TaskOnChain> {
  const params = ethers.utils.defaultAbiCoder.encode(['uint256'], [parseTaskId(taskId)]);
  const payload = await callLens(provider, taskManagerAddr, STORAGE_KEYS.TASK_INFO, params);
  return decodeTaskInfo(payload);
}

export interface TaskEnrichmentResult {
  /** Keyed by the original ID string passed in `ids`. */
  tasks: Map<string, TaskOnChain>;
  errors: Array<{ id: string; message: string }>;
}

/**
 * Fetch on-chain state for many tasks with bounded concurrency (default 5,
 * capped at 50 tasks). Per-task failures are collected, never thrown, so
 * callers can render partial data.
 */
export async function enrichTasksWithDeadlines(
  provider: ethers.providers.Provider,
  taskManagerAddr: string,
  ids: Array<string | number>,
  opts?: { concurrency?: number; cap?: number }
): Promise<TaskEnrichmentResult> {
  const concurrency = Math.max(1, opts?.concurrency ?? 5);
  const cap = opts?.cap ?? 50;
  const capped = ids.slice(0, cap);

  const tasks: Map<string, TaskOnChain> = new Map();
  const errors: Array<{ id: string; message: string }> = [];

  for (let i = 0; i < capped.length; i += concurrency) {
    const chunk = capped.slice(i, i + concurrency);
    await Promise.all(chunk.map(async (id) => {
      const key = String(id);
      try {
        tasks.set(key, await getTaskOnChain(provider, taskManagerAddr, id));
      } catch (err: any) {
        errors.push({ id: key, message: err?.message || String(err) });
      }
    }));
  }

  return { tasks, errors };
}

export type ClaimState = 'expired-claimable' | 'expiring-soon' | 'on-track' | 'none';

const EXPIRING_SOON_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Classify a CLAIMED task's deadline state. `claimDeadline` takes precedence
 * over `absoluteDeadline`; zero/undefined deadlines mean "no deadline".
 * A deadline strictly in the past means the claim is forfeitable.
 */
export function deriveClaimState(
  task: Pick<TaskOnChain, 'status' | 'claimDeadline' | 'absoluteDeadline'>,
  now?: number
): ClaimState {
  if (task.status !== TASK_STATUS.CLAIMED) return 'none';
  const deadline = task.claimDeadline || task.absoluteDeadline;
  if (!deadline) return 'none';
  const ts = now ?? Math.floor(Date.now() / 1000);
  if (deadline < ts) return 'expired-claimable';
  if (deadline <= ts + EXPIRING_SOON_WINDOW_SECONDS) return 'expiring-soon';
  return 'on-track';
}

/** Read the org's task folders merkle root (getLensData variant 10). */
export async function getFoldersRoot(
  provider: ethers.providers.Provider,
  taskManagerAddr: string
): Promise<string> {
  const payload = await callLens(provider, taskManagerAddr, STORAGE_KEYS.FOLDERS_ROOT);
  return ethers.utils.defaultAbiCoder.decode(['bytes32'], payload)[0];
}

/** Read organizer hat IDs (getLensData variant 11). */
export async function getOrganizerHats(
  provider: ethers.providers.Provider,
  taskManagerAddr: string
): Promise<ethers.BigNumber[]> {
  const payload = await callLens(provider, taskManagerAddr, STORAGE_KEYS.ORGANIZER_HATS);
  return ethers.utils.defaultAbiCoder.decode(['uint256[]'], payload)[0];
}

/** Read permission hat IDs (getLensData variant 6). */
export async function getPermissionHats(
  provider: ethers.providers.Provider,
  taskManagerAddr: string
): Promise<ethers.BigNumber[]> {
  const payload = await callLens(provider, taskManagerAddr, STORAGE_KEYS.PERMISSION_HATS);
  return ethers.utils.defaultAbiCoder.decode(['uint256[]'], payload)[0];
}

/** Read a task's applicant addresses (getLensData variant 7). */
export async function getTaskApplicants(
  provider: ethers.providers.Provider,
  taskManagerAddr: string,
  taskId: string | number
): Promise<string[]> {
  const params = ethers.utils.defaultAbiCoder.encode(['uint256'], [parseTaskId(taskId)]);
  const payload = await callLens(provider, taskManagerAddr, STORAGE_KEYS.TASK_APPLICANTS, params);
  return ethers.utils.defaultAbiCoder.decode(['address[]'], payload)[0];
}
