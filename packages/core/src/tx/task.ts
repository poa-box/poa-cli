/**
 * Task-domain transaction builders (TaskManagerNew).
 *
 * Level 1 — pure builders (sync, zero I/O). One per contract write; they take
 * resolved addresses + prepared values and return a TxIntent. ALL argument
 * encoding lives here, byte-for-byte as the CLI encodes it: stringToBytes
 * titles, ipfsCidToBytes32 hashes, parseUnits amounts (18d PT payouts, token
 * registry decimals for bounties), and the v6/legacy createTask arity switch
 * via TaskManagerFeatures + LEGACY_TM_FRAGMENTS.
 *
 * Level 2 — resolved builders (async, `<action>Intent(ctx, params)`). They
 * resolve the org's TaskManager via reads/resolve, replicate the CLI's
 * payout/pricing derivation and read-merge logic, pin metadata via ../ipfs,
 * then delegate to the Level-1 builder. Duplicate checks, idempotency caches,
 * confirmation prompts and lens pre-flights are CLI UX and are deliberately
 * NOT ported.
 */

import { ethers } from 'ethers';
import type { TxIntent } from './intent';
import { buildGovernanceProposal, encodeExecutorCall, type ExecutionCall } from './governance';
import { getAbi } from '../contracts';
import {
  stringToBytes,
  ipfsCidToBytes32,
  parseTaskId,
  parseProjectId,
  parseDeadline,
  parseDurationSeconds,
} from '../encoding';
import {
  detectTaskManagerFeatures,
  featureUnavailable,
  LEGACY_TM_FRAGMENTS,
  type TaskManagerFeatures,
} from '../version';
import { getTokenDecimals } from '../chains';
import {
  calculatePayout,
  payoutConfigFromMetadata,
  type PayoutConfig,
} from '../payout';
import { parsePermList, formatMask, describeMask } from '../perms';
import { pinJson, fetchJson } from '../ipfs';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
import { requireAddress } from '../validation';
import type { PopContext } from '../context';
import { resolveOrgModules, requireModule } from '../reads/resolve';
import { FETCH_ORG_PAYOUT_CONFIG } from '../graph/documents/org';
import { FETCH_PROJECTS_DATA } from '../graph/documents/task';
import {
  findSubgraphTask,
  taskPermsTiers,
  resolveProjectFromList,
  type TaskPermsResult,
  type ProjectsDataResult,
  type SubgraphProject,
} from '../reads/task';
import {
  buildTaskMetadata,
  serializeTaskMetadata,
  buildTaskRejectionMetadata,
  serializeTaskRejectionMetadata,
  buildTaskApplicationMetadata,
  serializeTaskApplicationMetadata,
  type TaskMetadata,
} from '../metadata/task';
import { buildProposalMetadata, serializeProposalMetadata } from '../metadata/proposal';
import { getTaskOnChain, getFoldersRoot, TASK_STATUS, taskStatusName } from '../task-lens';

// ─────────────────────────── shared encoding helpers ───────────────────────────

/** TaskManager.ConfigKey.ROLE_PERM — verified enum index (src/commands/task/perms.ts:49). */
export const CONFIG_KEY_ROLE_PERM = 2;

/**
 * Bounty payout in raw token units, exactly as the CLI computes it
 * (task/create.ts, task/create-batch.ts): parsed only when an amount > 0 was
 * given AND the token is not the zero address; otherwise the literal 0.
 */
function computeBountyPayoutWei(
  bountyToken: string,
  bountyAmount: number | string | undefined
): ethers.BigNumber | number {
  if (bountyAmount && Number(bountyAmount) > 0 && bountyToken !== ethers.constants.AddressZero) {
    return ethers.utils.parseUnits(bountyAmount.toString(), getTokenDecimals(bountyToken));
  }
  return 0;
}

/** Accepts the CLI's string forms ('7d', ISO, unix) or a pre-resolved number. */
function parseDeadlineInput(value: string | number): number {
  return parseDeadline(String(value));
}

/** Accepts the CLI's string forms ('48h', '3600') or a pre-resolved number. */
function parseWindowInput(value: string | number): number {
  return parseDurationSeconds(String(value));
}

/**
 * parseDeadline for the update path: the contract deliberately accepts a
 * PAST absolute deadline here (admin lever — immediately opens a CLAIMED
 * task to takeover), so downgrade parseDeadline's past-check to a flag.
 * Only absolute forms (unix seconds / ISO date) can resolve to the past —
 * relative forms ("7d") are always future — so re-parsing with now=0 never
 * changes relative math. Port of src/commands/task/update.ts parseUpdateDeadline.
 */
export function parseUpdateDeadline(input: string): { value: number; isPast: boolean } {
  try {
    return { value: parseDeadline(input), isPast: false };
  } catch (err: any) {
    if (err instanceof CliError && /is in the past/.test(err.message)) {
      return { value: parseDeadline(input, 0), isPast: true };
    }
    throw err;
  }
}

/**
 * Parse a folders-root input: CIDv0 (Qm…), 0x-prefixed bytes32, or "clear".
 * Deliberately stricter than ipfsCidToBytes32 (which keccaks arbitrary
 * strings — a silent footgun for a root pointer).
 * Port of src/commands/task/folders.ts parseFoldersRoot.
 */
export function parseFoldersRoot(input: string): string {
  const trimmed = (input || '').trim();
  if (trimmed.toLowerCase() === 'clear') return ethers.constants.HashZero;
  if (trimmed.startsWith('0x')) {
    if (trimmed.length === 66 && ethers.utils.isHexString(trimmed, 32)) return trimmed.toLowerCase();
    throw new CliError(`Invalid bytes32 root "${input}".`, EXIT.USAGE, 'Pass a 32-byte 0x-prefixed hex value, a Qm… CIDv0, or "clear".');
  }
  if (trimmed.startsWith('Qm')) {
    const converted = ipfsCidToBytes32(trimmed);
    if (converted === ethers.constants.HashZero) {
      throw new CliError(`Could not decode CIDv0 "${input}".`, EXIT.USAGE, 'Check the CID — it must be a base58 CIDv0 (Qm…, 46 chars).');
    }
    return converted;
  }
  throw new CliError(`Unparseable --new-root "${input}".`, EXIT.USAGE, 'Pass a Qm… CIDv0, a 0x-prefixed bytes32, or "clear".');
}

/**
 * Parse a hat-id input (decimal or 0x hex) into a BigNumber.
 * Port of src/commands/task/perms.ts parseHatId (same message).
 */
export function parseHatId(input: string | number | ethers.BigNumber): ethers.BigNumber {
  try {
    return ethers.BigNumber.from(String(input).trim());
  } catch {
    throw new CliError(`Invalid --hat "${input}".`, EXIT.USAGE, 'Pass the hat ID as a decimal or 0x-hex integer (see pop org roles).');
  }
}

// ─────────────────────────── Level 1: pure builders ───────────────────────────

export interface CreateTaskArgs {
  taskManagerAddress: string;
  /** Human PT amount (18 decimals applied here, as `pop task create` does). */
  payout: number | string;
  /** Raw title; encoded with stringToBytes here. */
  title: string;
  /** CIDv0 or bytes32 metadata pointer; converted with ipfsCidToBytes32. */
  metadataHash: string;
  /** Resolved bytes32 project id. */
  projectId: string;
  /** ERC20 bounty token; defaults to AddressZero (no bounty). */
  bountyToken?: string;
  /** Human bounty amount; decimals come from the token registry. */
  bountyAmount?: number | string;
  requiresApplication?: boolean;
  /** Unix seconds (0 = none). v6 orgs only — ignored on the legacy signature. */
  absoluteDeadline?: number;
  /** Seconds (0 = none). v6 orgs only — ignored on the legacy signature. */
  completionWindow?: number;
  /**
   * Feature probe result: `deadlines` picks the 9-arg v6 createTask; without
   * it the pre-v6 7-arg signature is encoded via LEGACY_TM_FRAGMENTS (the
   * synced ABI no longer contains it).
   */
  features: Pick<TaskManagerFeatures, 'deadlines'>;
  orgId?: string;
}

/**
 * Port of `pop task create` — src/commands/task/create.ts (createTask send).
 * v6 9-arg: [payoutWei, titleBytes, metadataHash, pid, bountyToken,
 * bountyPayoutWei, requiresApplication, absoluteDeadline, completionWindow];
 * legacy 7-arg drops the two deadline words and uses LEGACY_TM_FRAGMENTS.
 */
export function buildCreateTask(a: CreateTaskArgs): TxIntent {
  const payoutWei = ethers.utils.parseUnits(a.payout.toString(), 18);
  const titleBytes = stringToBytes(a.title);
  const metadataHash = ipfsCidToBytes32(a.metadataHash);
  const bountyToken = a.bountyToken || ethers.constants.AddressZero;
  const bountyPayoutWei = computeBountyPayoutWei(bountyToken, a.bountyAmount);
  const requiresApp = a.requiresApplication || false;

  const v6 = a.features.deadlines;
  return {
    to: a.taskManagerAddress,
    abi: v6 ? getAbi('TaskManagerNew') : (LEGACY_TM_FRAGMENTS as any[]),
    method: 'createTask',
    args: v6
      ? [payoutWei, titleBytes, metadataHash, a.projectId, bountyToken, bountyPayoutWei, requiresApp, a.absoluteDeadline ?? 0, a.completionWindow ?? 0]
      : [payoutWei, titleBytes, metadataHash, a.projectId, bountyToken, bountyPayoutWei, requiresApp],
    meta: {
      domain: 'task',
      action: 'create',
      orgId: a.orgId,
      summary: { name: a.title, projectId: a.projectId, payout: String(a.payout), signature: v6 ? 'v6' : 'legacy7' },
    },
  };
}

/** One row of a v6 createTasksBatch call (prepared values; NO pid inside). */
export interface CreateTaskBatchRow {
  /** Human PT amount (18 decimals applied here). */
  payout: number | string;
  title: string;
  /** CIDv0 or bytes32. */
  metadataHash: string;
  bountyToken?: string;
  bountyAmount?: number | string;
  requiresApplication?: boolean;
  /** Unix seconds (0 = none). */
  absoluteDeadline?: number;
  /** Seconds (0 = none). */
  completionWindow?: number;
}

export interface CreateTasksBatchArgs {
  taskManagerAddress: string;
  /** Resolved bytes32 project id (shared by every row). */
  projectId: string;
  tasks: CreateTaskBatchRow[];
  orgId?: string;
}

/**
 * Port of `pop task create-batch` (v6 path) — src/commands/task/create-batch.ts.
 * ONE all-or-nothing createTasksBatch(pid, CreateTaskInput[]) transaction.
 * CreateTaskInput tuple field order must match the createTasksBatch components
 * in the synced ABI (NOTE: no pid inside): payout, title, metadataHash,
 * bountyToken, bountyPayout, requiresApplication, absoluteDeadline,
 * completionWindow.
 */
export function buildCreateTasksBatch(a: CreateTasksBatchArgs): TxIntent {
  const inputs = a.tasks.map((task) => {
    const bountyToken = task.bountyToken || ethers.constants.AddressZero;
    return [
      ethers.utils.parseUnits(task.payout.toString(), 18),
      stringToBytes(task.title),
      ipfsCidToBytes32(task.metadataHash),
      bountyToken,
      computeBountyPayoutWei(bountyToken, task.bountyAmount),
      task.requiresApplication || false,
      task.absoluteDeadline ?? 0,
      task.completionWindow ?? 0,
    ];
  });

  return {
    to: a.taskManagerAddress,
    abi: getAbi('TaskManagerNew'),
    method: 'createTasksBatch',
    args: [a.projectId, inputs],
    meta: {
      domain: 'task',
      action: 'create-batch',
      orgId: a.orgId,
      summary: { projectId: a.projectId, tasks: a.tasks.length },
    },
  };
}

export interface TaskIdArgs {
  taskManagerAddress: string;
  /** Bare numeric id or subgraph composite `<taskManager>-<id>` (parsed here). */
  taskId: string | number;
  orgId?: string;
}

/** Port of `pop task claim` — src/commands/task/claim.ts (claimTask send). */
export function buildClaimTask(a: TaskIdArgs): TxIntent {
  const id = parseTaskId(a.taskId);
  return {
    to: a.taskManagerAddress,
    abi: getAbi('TaskManagerNew'),
    method: 'claimTask',
    args: [id],
    meta: { domain: 'task', action: 'claim', orgId: a.orgId, summary: { taskId: id } },
  };
}

/**
 * Port of `pop task unclaim` — src/commands/task/unclaim.ts (unclaimTask send).
 * TaskManager v7 only; the feature gate lives in unclaimTaskIntent (the
 * encoding itself is version-independent).
 */
export function buildUnclaimTask(a: TaskIdArgs): TxIntent {
  const id = parseTaskId(a.taskId);
  return {
    to: a.taskManagerAddress,
    abi: getAbi('TaskManagerNew'),
    method: 'unclaimTask',
    args: [id],
    meta: { domain: 'task', action: 'unclaim', orgId: a.orgId, summary: { taskId: id } },
  };
}

export interface SubmitTaskArgs extends TaskIdArgs {
  /** CIDv0 or bytes32 pointer to the merged submission metadata document. */
  submissionHash: string;
}

/** Port of `pop task submit` — src/commands/task/submit.ts (submitTask send). */
export function buildSubmitTask(a: SubmitTaskArgs): TxIntent {
  const id = parseTaskId(a.taskId);
  return {
    to: a.taskManagerAddress,
    abi: getAbi('TaskManagerNew'),
    method: 'submitTask',
    args: [id, ipfsCidToBytes32(a.submissionHash)],
    meta: { domain: 'task', action: 'submit', orgId: a.orgId, summary: { taskId: id } },
  };
}

/**
 * Port of `pop task review --action approve` — src/commands/task/review.ts
 * (completeTask send; releases payout + bounty to the claimer).
 */
export function buildCompleteTask(a: TaskIdArgs): TxIntent {
  const id = parseTaskId(a.taskId);
  return {
    to: a.taskManagerAddress,
    abi: getAbi('TaskManagerNew'),
    method: 'completeTask',
    args: [id],
    meta: { domain: 'task', action: 'complete', orgId: a.orgId, summary: { taskId: id } },
  };
}

export interface RejectTaskArgs extends TaskIdArgs {
  /** CIDv0 or bytes32 pointer to the pinned `{rejection}` document. */
  rejectionHash: string;
}

/**
 * Port of `pop task review --action reject` — src/commands/task/review.ts
 * (rejectTask send; no payout, task returns to CLAIMED).
 */
export function buildRejectTask(a: RejectTaskArgs): TxIntent {
  const id = parseTaskId(a.taskId);
  return {
    to: a.taskManagerAddress,
    abi: getAbi('TaskManagerNew'),
    method: 'rejectTask',
    args: [id, ipfsCidToBytes32(a.rejectionHash)],
    meta: { domain: 'task', action: 'reject', orgId: a.orgId, summary: { taskId: id } },
  };
}

/** Port of `pop task cancel` — src/commands/task/cancel.ts (cancelTask send). */
export function buildCancelTask(a: TaskIdArgs): TxIntent {
  const id = parseTaskId(a.taskId);
  return {
    to: a.taskManagerAddress,
    abi: getAbi('TaskManagerNew'),
    method: 'cancelTask',
    args: [id],
    meta: { domain: 'task', action: 'cancel', orgId: a.orgId, summary: { taskId: id } },
  };
}

export interface AssignTaskArgs extends TaskIdArgs {
  /** Resolved assignee address. */
  assignee: string;
}

/** Port of `pop task assign` — src/commands/task/assign.ts (assignTask send). */
export function buildAssignTask(a: AssignTaskArgs): TxIntent {
  const id = parseTaskId(a.taskId);
  return {
    to: a.taskManagerAddress,
    abi: getAbi('TaskManagerNew'),
    method: 'assignTask',
    args: [id, a.assignee],
    meta: { domain: 'task', action: 'assign', orgId: a.orgId, summary: { taskId: id, assignee: a.assignee } },
  };
}

export interface ApplyForTaskArgs extends TaskIdArgs {
  /** CIDv0 or bytes32 pointer to the pinned `{notes, experience}` document. */
  applicationHash: string;
}

/** Port of `pop task apply` — src/commands/task/apply.ts (applyForTask send). */
export function buildApplyForTask(a: ApplyForTaskArgs): TxIntent {
  const id = parseTaskId(a.taskId);
  return {
    to: a.taskManagerAddress,
    abi: getAbi('TaskManagerNew'),
    method: 'applyForTask',
    args: [id, ipfsCidToBytes32(a.applicationHash)],
    meta: { domain: 'task', action: 'apply', orgId: a.orgId, summary: { taskId: id } },
  };
}

export interface ApproveApplicationArgs extends TaskIdArgs {
  applicant: string;
}

/**
 * Port of `pop task approve-app` — src/commands/task/approve-application.ts
 * (approveApplication send).
 */
export function buildApproveApplication(a: ApproveApplicationArgs): TxIntent {
  const id = parseTaskId(a.taskId);
  return {
    to: a.taskManagerAddress,
    abi: getAbi('TaskManagerNew'),
    method: 'approveApplication',
    args: [id, a.applicant],
    meta: { domain: 'task', action: 'approve-app', orgId: a.orgId, summary: { taskId: id, applicant: a.applicant } },
  };
}

export interface UpdateTaskArgs extends TaskIdArgs {
  /** MERGED final payout in wei (the CLI's read-merge produces wei values). */
  payoutWei: ethers.BigNumberish;
  /** Merged final title; encoded with stringToBytes here. */
  title: string;
  /** Merged final metadata pointer (CIDv0 or bytes32; '' ⇒ HashZero). */
  metadataHash: string;
  /** Merged final bounty token (AddressZero = none). */
  bountyToken: string;
  /** Merged final bounty payout in raw token units. */
  bountyPayoutWei: ethers.BigNumberish;
  /** Merged final absolute deadline (unix seconds; 0 = none). */
  absoluteDeadline: number;
  /** Merged final completion window (seconds; 0 = none). */
  completionWindow: number;
}

/**
 * Port of `pop task update` — src/commands/task/update.ts (updateTask send).
 * updateTask is a FULL OVERWRITE on-chain (8-arg v6 signature): every field is
 * the merged FINAL value, in wei — use updateTaskIntent for the read-merge.
 * The CLI refuses the pre-v6 6-field signature entirely (features.deadlines
 * gate), so this builder only ever emits the v6 shape.
 */
export function buildUpdateTask(a: UpdateTaskArgs): TxIntent {
  const id = parseTaskId(a.taskId);
  return {
    to: a.taskManagerAddress,
    abi: getAbi('TaskManagerNew'),
    method: 'updateTask',
    args: [
      id,
      a.payoutWei,
      stringToBytes(a.title),
      ipfsCidToBytes32(a.metadataHash),
      a.bountyToken,
      a.bountyPayoutWei,
      a.absoluteDeadline,
      a.completionWindow,
    ],
    meta: { domain: 'task', action: 'update', orgId: a.orgId, summary: { taskId: id, title: a.title } },
  };
}

export interface UpdateTaskMetadataArgs extends TaskIdArgs {
  /** Merged final title; encoded with stringToBytes here. */
  title: string;
  /** Merged final metadata pointer (CIDv0 or bytes32). */
  metadataHash: string;
}

/**
 * Port of `pop task edit-meta` — src/commands/task/edit-meta.ts
 * (updateTaskMetadata send). v5+; preserves payout/bounty on-chain but fully
 * overwrites the title + metadata pointer pair.
 */
export function buildUpdateTaskMetadata(a: UpdateTaskMetadataArgs): TxIntent {
  const id = parseTaskId(a.taskId);
  return {
    to: a.taskManagerAddress,
    abi: getAbi('TaskManagerNew'),
    method: 'updateTaskMetadata',
    args: [id, stringToBytes(a.title), ipfsCidToBytes32(a.metadataHash)],
    meta: { domain: 'task', action: 'edit-meta', orgId: a.orgId, summary: { taskId: id, title: a.title } },
  };
}

export interface SetProjectRolePermArgs {
  taskManagerAddress: string;
  /** Resolved bytes32 project id. */
  projectId: string;
  hatId: ethers.BigNumberish;
  /** TaskPerm bitmask (uint8). */
  mask: number;
  orgId?: string;
}

/**
 * Port of `pop task perms set` — src/commands/task/perms.ts:309
 * (setProjectRolePerm send; creator-hat/executor gate stays on-chain).
 */
export function buildSetProjectRolePerm(a: SetProjectRolePermArgs): TxIntent {
  const hatId = ethers.BigNumber.from(a.hatId);
  return {
    to: a.taskManagerAddress,
    abi: getAbi('TaskManagerNew'),
    method: 'setProjectRolePerm',
    args: [a.projectId, hatId, a.mask],
    meta: {
      domain: 'task',
      action: 'perms-set',
      orgId: a.orgId,
      summary: { projectId: a.projectId, hatId: hatId.toString(), mask: a.mask, permissions: formatMask(a.mask) },
    },
  };
}

/**
 * The executor-gated setConfig(ROLE_PERM, abi.encode(uint256 hatId, uint8
 * mask)) call `pop task perms propose-global` wraps in a proposal —
 * src/commands/task/perms.ts:418. The CLI encodes via an inline
 * `setConfig(uint8,bytes)` interface; the synced TaskManagerNew ABI carries
 * the same signature, so the calldata is byte-identical.
 */
export function buildSetGlobalRolePermCall(
  taskManagerAddress: string,
  hatId: ethers.BigNumberish,
  mask: number
): ExecutionCall {
  const encodedValue = ethers.utils.defaultAbiCoder.encode(
    ['uint256', 'uint8'],
    [ethers.BigNumber.from(hatId), mask]
  );
  return encodeExecutorCall('TaskManagerNew', taskManagerAddress, 'setConfig', [CONFIG_KEY_ROLE_PERM, encodedValue]);
}

export interface ProposeGlobalRolePermArgs {
  hybridVotingAddress: string;
  taskManagerAddress: string;
  hatId: ethers.BigNumberish;
  mask: number;
  durationMinutes: ethers.BigNumberish;
  /** bytes32 of the pinned proposal metadata (ipfsCidToBytes32 applied by caller or here via CID). */
  descriptionHash: string;
  orgId?: string;
}

/**
 * Port of `pop task perms propose-global` — src/commands/task/perms.ts:400.
 * HybridVoting.createProposal(titleBytes, descriptionHash, duration, 2,
 * [[setConfig call], []], []) — option 0 applies the mask, option 1 keeps
 * current. Title matches the CLI's deterministic string.
 */
export function buildProposeGlobalRolePerm(a: ProposeGlobalRolePermArgs): TxIntent {
  const hatId = ethers.BigNumber.from(a.hatId);
  const permsLabel = formatMask(a.mask);
  const title = `Set global task permissions for hat ${hatId.toString()} to ${permsLabel}`;
  return buildGovernanceProposal({
    votingAddress: a.hybridVotingAddress,
    votingAbiName: 'HybridVotingNew',
    title,
    descriptionHash: ipfsCidToBytes32(a.descriptionHash),
    durationMinutes: a.durationMinutes,
    numOptions: 2,
    batches: [
      [buildSetGlobalRolePermCall(a.taskManagerAddress, hatId, a.mask)], // option 0: apply
      [], // option 1: keep current
    ],
    hatIds: [],
    orgId: a.orgId,
    domain: 'task',
    action: 'perms-propose-global',
    summary: { hatId: hatId.toString(), mask: a.mask, permissions: permsLabel },
  });
}

export interface SetFoldersArgs {
  taskManagerAddress: string;
  /** CAS guard: the root believed current (read over RPC, never the subgraph). */
  expectedCurrentRoot: string;
  /** New bytes32 root (use parseFoldersRoot for Qm…/'clear' inputs). */
  newRoot: string;
  orgId?: string;
}

/**
 * Port of `pop task folders set` — src/commands/task/folders.ts:286
 * (setFolders send). CAS-guarded: reverts FoldersRootStale when
 * expectedCurrentRoot no longer matches; the CLI's read-retry-once loop is
 * execution-time behavior and stays host-side.
 */
export function buildSetFolders(a: SetFoldersArgs): TxIntent {
  return {
    to: a.taskManagerAddress,
    abi: getAbi('TaskManagerNew'),
    method: 'setFolders',
    args: [a.expectedCurrentRoot, a.newRoot],
    meta: {
      domain: 'task',
      action: 'folders-set',
      orgId: a.orgId,
      summary: { expectedCurrentRoot: a.expectedCurrentRoot, newRoot: a.newRoot },
    },
  };
}

// ─────────────────────────── Level 2: resolved builders ───────────────────────────

interface ResolvedTaskManager {
  orgId: string;
  taskManagerAddress: string;
  hybridVotingAddress: string | null;
}

async function resolveTaskManager(ctx: PopContext, org: string | undefined): Promise<ResolvedTaskManager> {
  const modules = await resolveOrgModules(ctx.client, org, ctx.chainId);
  return {
    orgId: modules.orgId,
    taskManagerAddress: requireModule(modules, 'taskManagerAddress'),
    hybridVotingAddress: modules.hybridVotingAddress,
  };
}

/**
 * Feature probe for builders whose ENCODING depends on it. `features` override
 * wins; otherwise detection needs ctx.provider (the CLI always has one — a
 * subgraph-served implementation could pick the wrong calldata shape, see
 * version.ts).
 */
async function requireFeatures(
  ctx: PopContext,
  taskManagerAddress: string,
  orgId: string,
  override: TaskManagerFeatures | undefined,
  purpose: string
): Promise<TaskManagerFeatures> {
  if (override) return override;
  if (!ctx.provider) {
    throw new CliError(
      `${purpose} needs the org's TaskManager feature set. Provide ctx.provider (for detection) or params.features.`,
      EXIT.USAGE
    );
  }
  return detectTaskManagerFeatures(ctx.provider, taskManagerAddress, ctx.chainId, {
    orgId,
    client: ctx.client,
  });
}

/** Best-effort probe for gates that do not change the encoding (e.g. unclaim). */
async function maybeFeatures(
  ctx: PopContext,
  taskManagerAddress: string,
  orgId: string,
  override: TaskManagerFeatures | undefined
): Promise<TaskManagerFeatures | null> {
  if (override) return override;
  if (!ctx.provider) return null;
  return detectTaskManagerFeatures(ctx.provider, taskManagerAddress, ctx.chainId, {
    orgId,
    client: ctx.client,
  });
}

interface OrgPayoutConfigResult {
  config: PayoutConfig & { useTokenSymbol: boolean };
  error: unknown | null;
}

/**
 * Read the org's payout convention, distinguishing "no pricing configured"
 * (org row with null metadata ⇒ default pricing is correct) from "org not
 * indexed / subgraph down" (refuse-to-guess). Port of the config read in
 * task/create.ts:213 / create-batch.ts:167.
 */
async function fetchOrgPayoutConfig(ctx: PopContext, orgId: string): Promise<OrgPayoutConfigResult> {
  let config: PayoutConfig & { useTokenSymbol: boolean } = {
    hoursOnly: false, hourlyRate: null, useTokenSymbol: false,
  };
  let error: unknown | null = null;
  try {
    const cfg = await ctx.client.query<any>(FETCH_ORG_PAYOUT_CONFIG, { orgId }, ctx.chainId);
    if (!cfg.organization) {
      // A successful query with NO org row (indexer lag on a fresh org) is
      // indistinguishable from "no pricing configured" only by accident —
      // treat it like a failed fetch so derivation refuses to guess.
      throw new Error('organization not indexed');
    }
    config = payoutConfigFromMetadata(cfg.organization?.metadata);
  } catch (err) {
    // Only fatal when a payout must be DERIVED — explicit payouts do not
    // depend on org pricing.
    error = err;
  }
  return { config, error };
}

/**
 * Resolve a project input the way `pop task create` does (task/create.ts:178):
 * bytes32 hex as-is → subgraph title match → numeric index → error listing
 * the available titles. NOTE the order differs from project delete's resolver
 * (reads/project resolveProjectInput), which tries numerics before titles.
 */
async function resolveCreateProjectPid(ctx: PopContext, orgId: string, projectInput: string): Promise<string> {
  if (projectInput.startsWith('0x') && projectInput.length === 66) return projectInput;

  const projResult = await ctx.client.query<ProjectsDataResult>(FETCH_PROJECTS_DATA, { orgId }, ctx.chainId);
  const projects: SubgraphProject[] = projResult.organization?.taskManager?.projects || [];
  const match = projects.find((p) => (p.title || '').toLowerCase() === projectInput.toLowerCase());
  if (match) {
    // Extract bytes32 project ID from subgraph composite ID: "{contractAddress}-{projectIdHex}"
    return parseProjectId(match.id);
  }
  const num = parseInt(projectInput, 10);
  if (!isNaN(num)) {
    return ethers.utils.hexZeroPad(ethers.utils.hexlify(num), 32);
  }
  const available = projects.map((p) => p.title).filter(Boolean).join(', ');
  throw new Error(`Project "${projectInput}" not found. Available: ${available || 'none'}`);
}

export interface CreateTaskParams {
  org: string;
  /** Project name, bytes32 pid, or numeric index (resolved like the CLI). */
  project: string;
  name: string;
  description: string;
  /** Omit to price the task from the org's payout convention (refuses to guess when the subgraph is down). */
  payout?: number;
  difficulty?: string;
  estHours?: number;
  location?: string;
  bountyToken?: string;
  bountyAmount?: number;
  requiresApplication?: boolean;
  /** '7d' / ISO / unix (string forms parsed like the CLI); v6 orgs only. */
  deadline?: string | number;
  /** '48h' / seconds; v6 orgs only. */
  completionWindow?: string | number;
  /** Skip detection (offline hosts). */
  features?: TaskManagerFeatures;
}

/**
 * Port of `pop task create` — src/commands/task/create.ts. Resolves the org +
 * project, feature-gates the deadline flags, derives the payout exactly as
 * the web app would when omitted, pins the canonical metadata document, and
 * delegates to buildCreateTask. Duplicate-check and idempotency are CLI UX
 * and are not ported.
 */
export async function createTaskIntent(ctx: PopContext, p: CreateTaskParams): Promise<TxIntent> {
  // Parse deadline flags up-front so bad input fails before any network work.
  const deadlineFlagsSet = p.deadline !== undefined || p.completionWindow !== undefined;
  const absoluteDeadline = p.deadline !== undefined ? parseDeadlineInput(p.deadline) : 0;
  const completionWindow = p.completionWindow !== undefined ? parseWindowInput(p.completionWindow) : 0;

  const { orgId, taskManagerAddress } = await resolveTaskManager(ctx, p.org);

  // Feature-gate: pre-v6 TaskManagers only expose the 7-arg createTask.
  const features = await requireFeatures(ctx, taskManagerAddress, orgId, p.features, 'createTask');
  if (!features.deadlines && deadlineFlagsSet) {
    throw new CliError(
      featureUnavailable(
        'task deadlines',
        'TaskManager v6',
        'Re-run without --deadline/--completion-window, or upgrade the org TaskManager beacon.'
      ),
      EXIT.PRECONDITION
    );
  }

  const pid = await resolveCreateProjectPid(ctx, orgId, p.project);

  // Price the task. TaskManager stores whatever payout it is handed, so pricing is a
  // convention shared with the web app rather than an on-chain rule — when payout is
  // omitted, derive it exactly as the UI does.
  const { config: payoutConfig, error: payoutConfigError } = await fetchOrgPayoutConfig(ctx, orgId);

  let derivedPayout: number | null = null;
  if (p.payout === undefined) {
    if (payoutConfigError) {
      // Deriving from the hard-coded default config would silently misprice the
      // task for any org with hours-only or custom hourly pricing — and the
      // payout goes on-chain. Refuse rather than guess.
      throw new CliError(
        'Could not read the org payout config (subgraph unreachable), so a payout cannot be derived safely.',
        EXIT.PRECONDITION,
        'Pass --payout explicitly, or retry when the subgraph is reachable.'
      );
    }
    derivedPayout = calculatePayout(p.difficulty || 'medium', p.estHours || 0, payoutConfig);
    if (derivedPayout <= 0) {
      throw new CliError(
        'Could not derive a payout: the org pays by hours only and --est-hours is 0.',
        EXIT.USAGE,
        'Pass --est-hours, or set --payout explicitly.'
      );
    }
  }
  const payoutAmount = p.payout ?? derivedPayout!;

  // Metadata JSON (key order must match the frontend exactly — see metadata/task).
  const metadata: TaskMetadata = buildTaskMetadata({
    name: p.name,
    description: p.description,
    location: p.location || '',
    difficulty: p.difficulty || 'medium',
    estHours: p.estHours || 0,
    submission: '',
  });
  const cid = await pinJson(serializeTaskMetadata(metadata), ctx.ipfs);

  const intent = buildCreateTask({
    taskManagerAddress,
    payout: payoutAmount,
    title: p.name,
    metadataHash: cid,
    projectId: pid,
    bountyToken: p.bountyToken,
    bountyAmount: p.bountyAmount,
    requiresApplication: p.requiresApplication,
    absoluteDeadline,
    completionWindow,
    features,
    orgId,
  });
  intent.meta.ipfs = { cid, metadata };
  if (derivedPayout !== null && intent.meta.summary) intent.meta.summary.derivedPayout = derivedPayout;
  return intent;
}

/** One JSONL row of `pop task create-batch` (the file parsing stays host-side). */
export interface CreateTaskBatchRowParams {
  name: string;
  description: string;
  payout?: number;
  difficulty?: string;
  estHours?: number;
  location?: string;
  bountyToken?: string;
  bountyAmount?: number;
  requiresApplication?: boolean;
  /** Per-row absolute claim deadline (overrides the batch default; v6 only). */
  deadline?: string | number;
  /** Per-row completion window (overrides the batch default; v6 only). */
  completionWindow?: string | number;
}

export interface CreateTasksBatchParams {
  org: string;
  /** Passed straight through parseProjectId, as the CLI does (no title lookup). */
  project: string;
  tasks: CreateTaskBatchRowParams[];
  /** Batch-wide defaults; rows may override. */
  deadline?: string | number;
  completionWindow?: string | number;
  features?: TaskManagerFeatures;
}

/**
 * Port of `pop task create-batch` — src/commands/task/create-batch.ts.
 * Returns ONE createTasksBatch intent (all-or-nothing) on v6 orgs, or one
 * legacy 7-arg createTask intent PER ROW on pre-v6 orgs (the CLI sends those
 * sequentially; --continue-on-error is host-side execution policy). Per-row
 * metadata is pinned in input order so receipt TaskCreated logs line up.
 */
export async function createTasksBatchIntents(
  ctx: PopContext,
  p: CreateTasksBatchParams
): Promise<TxIntent[]> {
  // Batch-wide defaults parsed up-front so bad input fails before network work.
  const defaultDeadline = p.deadline !== undefined ? parseDeadlineInput(p.deadline) : 0;
  const defaultWindow = p.completionWindow !== undefined ? parseWindowInput(p.completionWindow) : 0;
  const batchDeadlineSet = p.deadline !== undefined || p.completionWindow !== undefined;

  interface ParsedRow extends CreateTaskBatchRowParams {
    payout: number;
    payoutProvided: boolean;
    absoluteDeadline: number;
    completionWindowSecs: number;
    deadlineSet: boolean;
  }

  const tasks: ParsedRow[] = [];
  for (let i = 0; i < p.tasks.length; i++) {
    const task = p.tasks[i];
    if (!task.name || !task.description) {
      throw new CliError(`Row ${i + 1}: Missing required fields: name, description`, EXIT.USAGE);
    }
    // Rows go through String() + parse exactly like the CLI (create-batch.ts:129).
    const absoluteDeadline = task.deadline !== undefined
      ? parseDeadline(String(task.deadline))
      : defaultDeadline;
    const completionWindowSecs = task.completionWindow !== undefined
      ? parseDurationSeconds(String(task.completionWindow))
      : defaultWindow;
    tasks.push({
      ...task,
      payout: task.payout ?? 0,
      payoutProvided: task.payout !== undefined,
      absoluteDeadline,
      completionWindowSecs,
      deadlineSet: batchDeadlineSet || task.deadline !== undefined || task.completionWindow !== undefined,
    });
  }

  // Client-side EmptyBatch guard (the v6 contract reverts on empty input).
  if (tasks.length === 0) {
    throw new CliError('EmptyBatch: file parsed to 0 valid tasks — nothing to create.', EXIT.USAGE);
  }

  const { orgId, taskManagerAddress } = await resolveTaskManager(ctx, p.org);

  // Same pricing convention as `pop task create`.
  const { config: payoutConfig, error: payoutConfigError } = await fetchOrgPayoutConfig(ctx, orgId);
  const needsDerivation = tasks.filter((t) => !t.payoutProvided);
  if (needsDerivation.length > 0 && payoutConfigError) {
    throw new CliError(
      `Could not read the org payout config (subgraph unreachable), and ${needsDerivation.length} `
      + `row(s) omit "payout": ${needsDerivation.map((t) => t.name).join(', ')}. `
      + 'Add explicit payouts to those rows, or retry when the subgraph is reachable.',
      EXIT.PRECONDITION
    );
  }
  for (const t of tasks) {
    if (!t.payoutProvided) {
      t.payout = calculatePayout(t.difficulty || 'medium', t.estHours || 0, payoutConfig);
    }
  }
  const unpriced = tasks.filter((t) => !t.payoutProvided && t.payout <= 0);
  if (unpriced.length > 0) {
    throw new CliError(
      `${unpriced.length} row(s) could not be priced (no "payout", and difficulty/estHours `
      + `derive to 0): ${unpriced.map((t) => t.name).join(', ')}`,
      EXIT.USAGE
    );
  }

  const pid = parseProjectId(p.project);

  const features = await requireFeatures(ctx, taskManagerAddress, orgId, p.features, 'createTasksBatch');
  if (tasks.some((t) => t.deadlineSet) && !features.deadlines) {
    throw new CliError(
      featureUnavailable(
        'task deadlines',
        'TaskManager v6',
        'Re-run without --deadline/--completion-window, or upgrade the org TaskManager beacon.'
      ),
      EXIT.PRECONDITION
    );
  }

  // Per-row metadata: exactly buildMetadata() from create-batch.ts, pinned in
  // input order.
  const pinned: Array<{ row: ParsedRow; cid: string; metadata: TaskMetadata }> = [];
  for (const row of tasks) {
    const metadata = buildTaskMetadata({
      name: row.name,
      description: row.description,
      location: row.location || '',
      difficulty: row.difficulty || 'medium',
      estHours: row.estHours || 0,
      submission: '',
    });
    const cid = await pinJson(serializeTaskMetadata(metadata), ctx.ipfs);
    pinned.push({ row, cid, metadata });
  }

  if (features.batchCreate) {
    const intent = buildCreateTasksBatch({
      taskManagerAddress,
      projectId: pid,
      tasks: pinned.map(({ row, cid }) => ({
        payout: row.payout,
        title: row.name,
        metadataHash: cid,
        bountyToken: row.bountyToken,
        bountyAmount: row.bountyAmount,
        requiresApplication: row.requiresApplication,
        absoluteDeadline: row.absoluteDeadline,
        completionWindow: row.completionWindowSecs,
      })),
      orgId,
    });
    intent.meta.ipfs = { cid: pinned[0].cid, metadata: pinned.map((x) => x.metadata) };
    return [intent];
  }

  // Legacy pre-v6 org: per-task 7-arg createTask intents (sequential sends).
  return pinned.map(({ row, cid, metadata }) => {
    const intent = buildCreateTask({
      taskManagerAddress,
      payout: row.payout,
      title: row.name,
      metadataHash: cid,
      projectId: pid,
      bountyToken: row.bountyToken,
      bountyAmount: row.bountyAmount,
      requiresApplication: row.requiresApplication,
      features: { deadlines: false },
      orgId,
    });
    intent.meta.ipfs = { cid, metadata };
    return intent;
  });
}

export interface TaskActionParams {
  org: string;
  /** Bare numeric id or subgraph composite `<taskManager>-<id>`. */
  task: string | number;
}

/** Port of `pop task claim` — src/commands/task/claim.ts. */
export async function claimTaskIntent(ctx: PopContext, p: TaskActionParams): Promise<TxIntent> {
  const { orgId, taskManagerAddress } = await resolveTaskManager(ctx, p.org);
  return buildClaimTask({ taskManagerAddress, taskId: p.task, orgId });
}

export interface UnclaimTaskParams extends TaskActionParams {
  features?: TaskManagerFeatures;
}

/**
 * Port of `pop task unclaim` — src/commands/task/unclaim.ts (TaskManager v7).
 * Feature-gated like the CLI when a provider (or features override) is
 * available; without either the gate is skipped — the encoding is identical
 * and the contract is the authority. The self-vs-force consent tiering and
 * the lens gate are host UX.
 */
export async function unclaimTaskIntent(ctx: PopContext, p: UnclaimTaskParams): Promise<TxIntent> {
  const { orgId, taskManagerAddress } = await resolveTaskManager(ctx, p.org);
  const features = await maybeFeatures(ctx, taskManagerAddress, orgId, p.features);
  if (features && !features.unclaim) {
    throw new CliError(
      featureUnavailable(
        'releasing a claimed task',
        'TaskManager v7',
        'Upgrade the org\'s TaskManager beacon, or wait for the claim deadline to expire so it can be taken over.'
      ),
      EXIT.PRECONDITION
    );
  }
  return buildUnclaimTask({ taskManagerAddress, taskId: p.task, orgId });
}

export interface SubmitTaskParams extends TaskActionParams {
  submission: string;
}

/**
 * Port of `pop task submit` — src/commands/task/submit.ts. The submission is
 * a FULL OVERWRITE of the task's metadata pointer, so the current document is
 * read first (subgraph → IPFS fallback) and merged; when the base is
 * unrecoverable this REFUSES (exit INFRA) rather than blanking the task's
 * name/description/dueDate. Pre-flight (CLAIMED + claimer) is host UX.
 */
export async function submitTaskIntent(ctx: PopContext, p: SubmitTaskParams): Promise<TxIntent> {
  const { orgId, taskManagerAddress } = await resolveTaskManager(ctx, p.org);
  const parsedTaskId = parseTaskId(p.task);

  // Fetch existing metadata so the submission preserves it. Match on the
  // PARSED numeric id, fall back to IPFS before giving up — same ladder as
  // task update / edit-meta.
  let subgraphTask: any = null;
  try {
    const taskData = await ctx.client.query<ProjectsDataResult>(FETCH_PROJECTS_DATA, { orgId }, ctx.chainId);
    subgraphTask = findSubgraphTask(taskData.organization?.taskManager?.projects || [], parsedTaskId);
  } catch { /* handled below */ }

  let existingMeta: any = subgraphTask?.metadata || null;
  if (!existingMeta && subgraphTask?.metadataHash) {
    try {
      existingMeta = await fetchJson(subgraphTask.metadataHash, ctx.ipfs);
    } catch { /* handled below */ }
  }

  if (!existingMeta) {
    throw new CliError(
      `Task ${p.task} metadata is not indexed yet (subgraph lag) — submitting now would `
      + 'overwrite the task\'s name, description and due date with blanks.',
      EXIT.INFRA,
      'Retry in a few seconds. The submission itself is unaffected once metadata resolves.'
    );
  }

  // Merge submission into existing metadata (exact field-by-field parity with
  // submit.ts:141 — note estimatedHours parseFloat and the '' difficulty
  // fallback, which differ from update/edit-meta's merge).
  const submissionMetadata = buildTaskMetadata({
    name: existingMeta?.name || '',
    description: existingMeta?.description || '',
    location: existingMeta?.location || '',
    difficulty: existingMeta?.difficulty || '',
    estHours: existingMeta?.estimatedHours ? parseFloat(existingMeta.estimatedHours) : 0,
    submission: p.submission,
    // The subgraph re-points task.metadata at THIS submission JSON, so a
    // dueDate omitted here is gone for good. Appended last, only when set.
    dueDate: existingMeta?.dueDate ? Math.floor(Number(existingMeta.dueDate)) : undefined,
  });

  const cid = await pinJson(serializeTaskMetadata(submissionMetadata), ctx.ipfs);
  const intent = buildSubmitTask({ taskManagerAddress, taskId: parsedTaskId, submissionHash: cid, orgId });
  intent.meta.ipfs = { cid, metadata: submissionMetadata };
  return intent;
}

/** Port of `pop task review --action approve` — src/commands/task/review.ts. */
export async function completeTaskIntent(ctx: PopContext, p: TaskActionParams): Promise<TxIntent> {
  const { orgId, taskManagerAddress } = await resolveTaskManager(ctx, p.org);
  return buildCompleteTask({ taskManagerAddress, taskId: p.task, orgId });
}

export interface RejectTaskParams extends TaskActionParams {
  /** Rejection reason (the CLI requires --reason for reject). */
  reason: string;
}

/**
 * Port of `pop task review --action reject` — src/commands/task/review.ts.
 * Pins the `{rejection}` document, then builds rejectTask. (The CLI pins
 * after pre-flight + confirm; core has neither, so the pin is the first step.)
 */
export async function rejectTaskIntent(ctx: PopContext, p: RejectTaskParams): Promise<TxIntent> {
  const { orgId, taskManagerAddress } = await resolveTaskManager(ctx, p.org);
  const rejectionMetadata = buildTaskRejectionMetadata(p.reason);
  const cid = await pinJson(serializeTaskRejectionMetadata(rejectionMetadata), ctx.ipfs);
  const intent = buildRejectTask({ taskManagerAddress, taskId: p.task, rejectionHash: cid, orgId });
  intent.meta.ipfs = { cid, metadata: rejectionMetadata };
  return intent;
}

/** Port of `pop task cancel` — src/commands/task/cancel.ts (DESTRUCTIVE; consent is host UX). */
export async function cancelTaskIntent(ctx: PopContext, p: TaskActionParams): Promise<TxIntent> {
  const { orgId, taskManagerAddress } = await resolveTaskManager(ctx, p.org);
  return buildCancelTask({ taskManagerAddress, taskId: p.task, orgId });
}

export interface AssignTaskParams extends TaskActionParams {
  /** Assignee address (checksummed via requireAddress). */
  assignee?: string;
  /** Or a username, resolved across all chains like the CLI. */
  username?: string;
}

/**
 * Port of `pop task assign` — src/commands/task/assign.ts. --username resolves
 * via the same inline all-chains accounts query; --assignee is validated as an
 * address. One of the two is required.
 */
export async function assignTaskIntent(ctx: PopContext, p: AssignTaskParams): Promise<TxIntent> {
  let assignee: string;
  if (p.username) {
    const query = `{ accounts(where: { username: "${p.username}" }, first: 1) { id username } }`;
    const results = await ctx.client.queryAllChains<{ accounts: Array<{ id: string; username: string }> }>(query, {});
    const account = results.map((r) => r.data?.accounts?.[0]).find(Boolean);
    if (!account) {
      throw new Error(`Username "${p.username}" not found. Check spelling or use --assignee with the address.`);
    }
    assignee = account.id;
  } else {
    assignee = requireAddress(p.assignee, 'assignee');
  }

  const { orgId, taskManagerAddress } = await resolveTaskManager(ctx, p.org);
  return buildAssignTask({ taskManagerAddress, taskId: p.task, assignee, orgId });
}

export interface ApplyForTaskParams extends TaskActionParams {
  notes?: string;
  experience?: string;
}

/**
 * Port of `pop task apply` — src/commands/task/apply.ts. Pins the
 * `{notes, experience}` document, then builds applyForTask. The
 * requiresApplication / duplicate-application pre-flights are host UX (the
 * contract's NoApplicationRequired / AlreadyApplied decodes are authoritative).
 */
export async function applyForTaskIntent(ctx: PopContext, p: ApplyForTaskParams): Promise<TxIntent> {
  const { orgId, taskManagerAddress } = await resolveTaskManager(ctx, p.org);
  const applicationData = buildTaskApplicationMetadata({ notes: p.notes, experience: p.experience });
  const cid = await pinJson(serializeTaskApplicationMetadata(applicationData), ctx.ipfs);
  const intent = buildApplyForTask({ taskManagerAddress, taskId: p.task, applicationHash: cid, orgId });
  intent.meta.ipfs = { cid, metadata: applicationData };
  return intent;
}

export interface ApproveApplicationParams extends TaskActionParams {
  applicant: string;
}

/** Port of `pop task approve-app` — src/commands/task/approve-application.ts. */
export async function approveApplicationIntent(
  ctx: PopContext,
  p: ApproveApplicationParams
): Promise<TxIntent> {
  const applicant = requireAddress(p.applicant, 'applicant');
  const { orgId, taskManagerAddress } = await resolveTaskManager(ctx, p.org);
  return buildApproveApplication({ taskManagerAddress, taskId: p.task, applicant, orgId });
}

export interface UpdateTaskParams extends TaskActionParams {
  payout?: number;
  name?: string;
  description?: string;
  /** ERC20 address, or 'none' to clear the bounty. */
  bountyToken?: string;
  bountyAmount?: number;
  /** A PAST value is deliberately accepted (admin takeover lever). */
  deadline?: string;
  completionWindow?: string;
  features?: TaskManagerFeatures;
}

/**
 * Port of `pop task update` — src/commands/task/update.ts. updateTask is a
 * FULL OVERWRITE on-chain, so this reads the current state first (chain via
 * the task lens for payout/bounty/deadlines — ctx.provider required; subgraph
 * + IPFS for title/description/metadata), merges only the fields given, and
 * re-pins metadata ONLY when name/description actually change. Refuses (INFRA)
 * when the overwrite base is unrecoverable. A past deadline is accepted and
 * flagged in meta.summary.deadlineIsPast.
 */
export async function updateTaskIntent(ctx: PopContext, p: UpdateTaskParams): Promise<TxIntent> {
  // 0. Fail fast on input problems before any network work.
  const changed = (['payout', 'name', 'description', 'bountyToken', 'bountyAmount', 'deadline', 'completionWindow'] as const)
    .filter((key) => p[key] !== undefined);
  if (changed.length === 0) {
    throw new CliError(
      'Nothing to update — pass at least one field flag.',
      EXIT.USAGE,
      'Available: --payout, --name, --description, --bounty-token, --bounty-amount, --deadline, --completion-window'
    );
  }

  let deadlineIsPast = false;
  let newAbsoluteDeadline: number | undefined;
  if (p.deadline !== undefined) {
    const parsed = parseUpdateDeadline(p.deadline);
    newAbsoluteDeadline = parsed.value;
    deadlineIsPast = parsed.isPast;
  }
  const newCompletionWindow = p.completionWindow !== undefined
    ? parseDurationSeconds(p.completionWindow)
    : undefined;

  // 1. Resolve org, gate on the v6 signature.
  const { orgId, taskManagerAddress } = await resolveTaskManager(ctx, p.org);
  const taskId = parseTaskId(p.task);

  const features = await requireFeatures(ctx, taskManagerAddress, orgId, p.features, 'updateTask');
  if (!features.deadlines) {
    // Pre-v6 implementations expose a 6-field updateTask that no longer
    // exists in the synced ABI — do NOT attempt it; degrade clearly.
    throw new CliError(
      featureUnavailable(
        'full task editing (updateTask)',
        'TaskManager v6',
        'Upgrade the org TaskManager beacon, or use pop task edit-meta if the org supports metadata-only edits.'
      ),
      EXIT.PRECONDITION
    );
  }

  // 2. READ: current on-chain fields (authoritative via lens).
  if (!ctx.provider) {
    throw new CliError(
      'updateTask needs ctx.provider: the current payout/bounty/deadlines are read from the TaskManager lens (a full overwrite must preserve them).',
      EXIT.USAGE
    );
  }
  const current = await getTaskOnChain(ctx.provider, taskManagerAddress, taskId);
  if (current.status === TASK_STATUS.COMPLETED || current.status === TASK_STATUS.CANCELLED) {
    throw new CliError(
      `Task ${taskId} is ${taskStatusName(current.status)} — terminal states are immutable on-chain.`,
      EXIT.PRECONDITION,
      'Create a new task instead (pop task create).'
    );
  }

  // 3. READ: current title/description/metadata (subgraph → IPFS fallback).
  const metadataChanging = p.name !== undefined || p.description !== undefined;
  let subgraphTask: any = null;
  try {
    const result = await ctx.client.query<ProjectsDataResult>(FETCH_PROJECTS_DATA, { orgId }, ctx.chainId);
    subgraphTask = findSubgraphTask(result.organization?.taskManager?.projects || [], taskId);
  } catch { /* handled below based on what the merge needs */ }

  let metadata: any = subgraphTask?.metadata || null;
  if (!metadata && subgraphTask?.metadataHash) {
    try {
      metadata = await fetchJson(subgraphTask.metadataHash, ctx.ipfs);
    } catch { /* IPFS lag — handled below */ }
  }

  const currentName: string | undefined = metadata?.name ?? subgraphTask?.title ?? undefined;
  const currentDescription: string | undefined = metadata?.description ?? undefined;
  const currentMetadataHash: string | undefined = subgraphTask?.metadataHash ?? undefined;

  // updateTask overwrites title + metadataHash even when only, say, payout
  // changed — so the current values must be recoverable.
  if (!metadataChanging && (currentName === undefined || !currentMetadataHash)) {
    throw new CliError(
      `Task ${taskId} metadata is not indexed yet (subgraph lag) — cannot preserve the current title/metadata through a full-overwrite update.`,
      EXIT.INFRA,
      'Retry in a few seconds, or pass --name and --description explicitly.'
    );
  }
  if (metadataChanging
    && (p.name === undefined || p.description === undefined)
    && (currentName === undefined || currentDescription === undefined)) {
    throw new CliError(
      `Task ${taskId} metadata is not indexed yet (subgraph lag) — cannot merge a partial metadata edit.`,
      EXIT.INFRA,
      'Retry in a few seconds, or pass BOTH --name and --description.'
    );
  }

  // 4. MERGE: given fields override, everything else preserved.
  const finalPayout = p.payout !== undefined
    ? ethers.utils.parseUnits(p.payout.toString(), 18)
    : current.payout;

  let finalBountyToken = current.bountyToken;
  if (p.bountyToken !== undefined) {
    if (p.bountyToken.toLowerCase() === 'none') {
      finalBountyToken = ethers.constants.AddressZero;
    } else if (ethers.utils.isAddress(p.bountyToken)) {
      finalBountyToken = ethers.utils.getAddress(p.bountyToken);
    } else {
      throw new CliError(`Invalid --bounty-token "${p.bountyToken}".`, EXIT.USAGE, 'Pass an ERC20 address, or "none" to clear the bounty.');
    }
  }

  let finalBountyPayout: ethers.BigNumber = current.bountyPayout;
  if (finalBountyToken === ethers.constants.AddressZero) {
    finalBountyPayout = ethers.BigNumber.from(0); // zero token ⇒ zero payout (contract validation)
  } else if (p.bountyAmount !== undefined) {
    finalBountyPayout = p.bountyAmount > 0
      ? ethers.utils.parseUnits(p.bountyAmount.toString(), getTokenDecimals(finalBountyToken))
      : ethers.BigNumber.from(0);
  }
  // (CLI-only warning when the token changed without --bounty-amount: the raw
  // current amount is kept, which may mean a different human value.)

  const finalDeadline = newAbsoluteDeadline !== undefined ? newAbsoluteDeadline : (current.absoluteDeadline ?? 0);
  const finalWindow = newCompletionWindow !== undefined ? newCompletionWindow : (current.completionWindow ?? 0);
  const finalName = p.name ?? currentName ?? '';
  const finalDescription = p.description ?? currentDescription ?? '';

  // Re-pin only when the metadata content actually changes.
  let finalMetadataHash = currentMetadataHash
    ? ipfsCidToBytes32(currentMetadataHash)
    : ethers.constants.HashZero;
  let newCid: string | undefined;
  let pinnedMetadata: TaskMetadata | undefined;
  const metadataActuallyChanged = metadataChanging
    && (finalName !== currentName || finalDescription !== currentDescription);
  if (metadataActuallyChanged) {
    // Key order MUST match task create (frontend parity) — see metadata/task.
    // When the current doc could not be fetched, location/difficulty/estHours
    // reset to defaults exactly as the CLI warns they will.
    pinnedMetadata = buildTaskMetadata({
      name: finalName,
      description: finalDescription,
      location: metadata?.location || '',
      difficulty: metadata?.difficulty || 'medium',
      estHours: metadata?.estimatedHours || metadata?.estHours || 0,
      submission: metadata?.submission || '',
      // Soft due date is metadata-borne; a re-pin that drops it deletes it.
      dueDate: metadata?.dueDate ? Math.floor(Number(metadata.dueDate)) : undefined,
    });
    newCid = await pinJson(serializeTaskMetadata(pinnedMetadata), ctx.ipfs);
    finalMetadataHash = ipfsCidToBytes32(newCid);
  }

  const intent = buildUpdateTask({
    taskManagerAddress,
    taskId,
    payoutWei: finalPayout,
    title: finalName,
    metadataHash: finalMetadataHash,
    bountyToken: finalBountyToken,
    bountyPayoutWei: finalBountyPayout,
    absoluteDeadline: finalDeadline,
    completionWindow: finalWindow,
    orgId,
  });
  if (newCid && pinnedMetadata) intent.meta.ipfs = { cid: newCid, metadata: pinnedMetadata };
  intent.meta.summary = {
    ...intent.meta.summary,
    fieldsChanged: changed.join(','),
    ...(deadlineIsPast ? { deadlineIsPast: true } : {}),
  };
  return intent;
}

export interface EditTaskMetadataParams extends TaskActionParams {
  name?: string;
  description?: string;
  features?: TaskManagerFeatures;
}

/**
 * Port of `pop task edit-meta` — src/commands/task/edit-meta.ts
 * (updateTaskMetadata; TaskManager v5+). Reads the current name/description
 * (subgraph → IPFS fallback), merges, and re-pins. Returns NULL when the merge
 * is a no-op — the CLI short-circuits with success and never sends. The
 * terminal-status read uses the lens when ctx.provider is present (parity);
 * without one, the contract's BadStatus revert is the authority.
 */
export async function editTaskMetadataIntent(
  ctx: PopContext,
  p: EditTaskMetadataParams
): Promise<TxIntent | null> {
  if (p.name === undefined && p.description === undefined) {
    throw new CliError('Nothing to edit — pass --name and/or --description.', EXIT.USAGE);
  }

  const { orgId, taskManagerAddress } = await resolveTaskManager(ctx, p.org);
  const taskId = parseTaskId(p.task);

  // Feature-gate: updateTaskMetadata shipped with TaskManager v5.
  const features = await requireFeatures(ctx, taskManagerAddress, orgId, p.features, 'updateTaskMetadata');
  if (!features.editMeta) {
    throw new CliError(
      featureUnavailable(
        'post-claim metadata editing',
        'TaskManager v5',
        'Upgrade the org TaskManager beacon, or recreate the task with the corrected metadata.'
      ),
      EXIT.PRECONDITION
    );
  }

  // Authoritative status read (also proves the task exists) when a provider
  // is available.
  if (ctx.provider) {
    const current = await getTaskOnChain(ctx.provider, taskManagerAddress, taskId);
    if (current.status === TASK_STATUS.COMPLETED || current.status === TASK_STATUS.CANCELLED) {
      throw new CliError(
        `Task ${taskId} is ${taskStatusName(current.status)} — terminal states are immutable on-chain.`,
        EXIT.PRECONDITION,
        'Metadata of completed/cancelled tasks cannot be edited.'
      );
    }
  }

  // READ current metadata: subgraph first, IPFS pointer as fallback.
  let subgraphTask: any = null;
  try {
    const result = await ctx.client.query<ProjectsDataResult>(FETCH_PROJECTS_DATA, { orgId }, ctx.chainId);
    subgraphTask = findSubgraphTask(result.organization?.taskManager?.projects || [], taskId);
  } catch { /* handled below */ }

  let metadata: any = subgraphTask?.metadata || null;
  if (!metadata && subgraphTask?.metadataHash) {
    try {
      metadata = await fetchJson(subgraphTask.metadataHash, ctx.ipfs);
    } catch { /* handled below */ }
  }

  const currentName: string | undefined = metadata?.name ?? subgraphTask?.title ?? undefined;
  const currentDescription: string | undefined = metadata?.description ?? undefined;

  if ((p.name === undefined && currentName === undefined)
    || (p.description === undefined && currentDescription === undefined)) {
    throw new CliError(
      `Task ${taskId} metadata is not indexed yet (subgraph lag) — cannot merge a partial metadata edit.`,
      EXIT.INFRA,
      'Retry in a few seconds, or pass BOTH --name and --description.'
    );
  }

  // MERGE
  const finalName = p.name ?? currentName ?? '';
  const finalDescription = p.description ?? currentDescription ?? '';
  if (finalName === currentName && finalDescription === currentDescription) {
    // No-op: the CLI reports success without sending anything.
    return null;
  }

  // Key order MUST match task create (frontend parity) — see metadata/task.
  const metadataJson = buildTaskMetadata({
    name: finalName,
    description: finalDescription,
    location: metadata?.location || '',
    difficulty: metadata?.difficulty || 'medium',
    estHours: metadata?.estimatedHours || metadata?.estHours || 0,
    submission: metadata?.submission || '',
    // Soft due date is metadata-borne; a re-pin that drops it deletes it.
    dueDate: metadata?.dueDate ? Math.floor(Number(metadata.dueDate)) : undefined,
  });

  const cid = await pinJson(serializeTaskMetadata(metadataJson), ctx.ipfs);
  const intent = buildUpdateTaskMetadata({ taskManagerAddress, taskId, title: finalName, metadataHash: cid, orgId });
  intent.meta.ipfs = { cid, metadata: metadataJson };
  return intent;
}

export interface SetProjectRolePermParams {
  org: string;
  /** Project bytes32 id or title (resolved via the perms tiers, like the CLI). */
  project: string;
  /** Hat id (decimal or 0x hex). */
  hat: string | number | ethers.BigNumber;
  /** Comma-separated permission list ('create,claim' / 'none') or a raw mask. */
  perms: string | number;
}

/**
 * Port of `pop task perms set` — src/commands/task/perms.ts:309. Resolves the
 * project by hex or title (PERMS_QUERY_FULL/LEGACY tiers), parses the perm
 * list into a mask, and builds setProjectRolePerm. The creator-hat/executor
 * gate stays on-chain (masks are not readable per-wearer).
 */
export async function setProjectRolePermIntent(
  ctx: PopContext,
  p: SetProjectRolePermParams
): Promise<TxIntent> {
  const mask = typeof p.perms === 'number' ? p.perms : parsePermList(p.perms);
  const hatId = parseHatId(p.hat);

  const { orgId, taskManagerAddress } = await resolveTaskManager(ctx, p.org);

  let pid: string;
  if (p.project.startsWith('0x') && p.project.length === 66) {
    pid = p.project;
  } else {
    const { data } = await ctx.client.queryWithFieldFallback<TaskPermsResult>(
      taskPermsTiers(orgId),
      { chainId: ctx.chainId }
    );
    pid = resolveProjectFromList(data.organization?.taskManager?.projects || [], p.project).pid;
  }

  return buildSetProjectRolePerm({ taskManagerAddress, projectId: pid, hatId, mask, orgId });
}

export interface ProposeGlobalRolePermParams {
  org: string;
  hat: string | number | ethers.BigNumber;
  perms: string | number;
  /** Vote duration in minutes (CLI default 60). */
  duration?: number;
}

/**
 * Port of `pop task perms propose-global` — src/commands/task/perms.ts:400.
 * setConfig(ROLE_PERM) is executor-only, so the change ships as a HybridVoting
 * proposal whose option-0 batch targets the TaskManager. Pins the proposal
 * metadata {description, optionNames, createdAt} (exact key order), then
 * delegates to buildProposeGlobalRolePerm.
 */
export async function proposeGlobalRolePermIntent(
  ctx: PopContext,
  p: ProposeGlobalRolePermParams
): Promise<TxIntent> {
  const mask = typeof p.perms === 'number' ? p.perms : parsePermList(p.perms);
  const hatId = parseHatId(p.hat);
  const duration = p.duration ?? 60;

  const { orgId, taskManagerAddress, hybridVotingAddress } = await resolveTaskManager(ctx, p.org);
  if (!hybridVotingAddress) {
    throw new CliError('HybridVoting not deployed for this org — cannot create a governance proposal.', EXIT.PRECONDITION);
  }

  const permsLabel = formatMask(mask);
  const title = `Set global task permissions for hat ${hatId.toString()} to ${permsLabel}`;
  // Proposal metadata — key order {description, optionNames, createdAt} is a
  // protocol contract (same shape every governance wrap pins).
  const metadata = buildProposalMetadata({
    description: `Set the GLOBAL TaskPerm mask for hat ${hatId.toString()} to ${mask} (${permsLabel}) via TaskManager.setConfig(ROLE_PERM). ${describeMask(mask).join('; ') || 'Revokes all global task permissions for this hat.'}`,
    optionNames: [title, 'Keep current permissions'],
  });
  const cid = await pinJson(serializeProposalMetadata(metadata), ctx.ipfs);

  const intent = buildProposeGlobalRolePerm({
    hybridVotingAddress,
    taskManagerAddress,
    hatId,
    mask,
    durationMinutes: duration,
    descriptionHash: cid,
    orgId,
  });
  intent.meta.ipfs = { cid, metadata };
  return intent;
}

export interface SetFoldersParams {
  org: string;
  /** New folder-tree root: Qm… CIDv0, 0x-prefixed bytes32, or "clear". */
  newRoot: string;
  /**
   * CAS guard override. When omitted it is read from chain via the lens
   * (ctx.provider required) — deliberately NEVER the subgraph: a stale value
   * guarantees the FoldersRootStale revert this read exists to predict.
   */
  expectedCurrentRoot?: string;
  features?: TaskManagerFeatures;
}

/**
 * Port of `pop task folders set` — src/commands/task/folders.ts:286
 * (TaskManager v4+). Parses the new root, auto-fills the CAS expected root
 * from chain, and returns NULL when the root already matches (the CLI reports
 * success without sending). The stale-root retry-once loop is execution-time
 * behavior and stays host-side.
 */
export async function setFoldersIntent(ctx: PopContext, p: SetFoldersParams): Promise<TxIntent | null> {
  const newRoot = parseFoldersRoot(p.newRoot);

  const { orgId, taskManagerAddress } = await resolveTaskManager(ctx, p.org);

  const features = await maybeFeatures(ctx, taskManagerAddress, orgId, p.features);
  if (features && !features.folders) {
    throw new CliError(
      featureUnavailable(
        'task folders',
        'TaskManager v4',
        'Upgrade the org TaskManager beacon to use folder organization.'
      ),
      EXIT.PRECONDITION
    );
  }

  let expectedRoot = p.expectedCurrentRoot;
  if (expectedRoot === undefined) {
    if (!ctx.provider) {
      throw new CliError(
        'setFolders needs the current root for its CAS guard. Provide ctx.provider (read over RPC) or params.expectedCurrentRoot.',
        EXIT.USAGE
      );
    }
    expectedRoot = await getFoldersRoot(ctx.provider, taskManagerAddress);
  }

  if (expectedRoot.toLowerCase() === newRoot.toLowerCase()) {
    // Already up to date — the CLI reports success without sending.
    return null;
  }

  return buildSetFolders({ taskManagerAddress, expectedCurrentRoot: expectedRoot, newRoot, orgId });
}
