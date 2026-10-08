/**
 * Task-domain subgraph reads: the projects/tasks tree, task stats, permission
 * masks, folders root, and v7 release history.
 *
 * Ports the read paths of `pop task list` / `view` / `stats` /
 * `perms show` / `folders show` (src/commands/task/{list,view,stats,perms,
 * folders}.ts) onto the injected GraphClient. Tier arrays come from
 * ../graph/documents/task where they already exist; the stats / perms /
 * folders documents lived inline in the CLI command files and are ported here
 * verbatim, comments included — the live-verification notes are load-bearing.
 */

import type { GraphClient, FieldFallbackTier } from '../graph/client';
import {
  projectsDataTiers,
  FETCH_TASK_RELEASE_HISTORY,
  FETCH_TASK_RELEASE_HISTORY_LEGACY,
  FETCH_TASK_DATA_WITH_RELEASES,
  FETCH_TASK_DATA,
  FETCH_TASK_DATA_LEGACY,
  PROJECT_TASK_PAGE_TIERS,
  FETCH_TASK_SUBMISSION_HISTORY,
} from '../graph/documents/task';
import { parseProjectId, parseTaskId } from '../encoding';
import { FETCH_AUTHORITY_PERMS, readAuthorityRows, isAuthorityReady } from './authority';
import { AUTHORITY_KEYS, projectContext } from '../tx/authority';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
import { ethers } from 'ethers';

// ────────────────────── projects/tasks tree ──────────────────────

/** Subgraph Task entity as served by FETCH_PROJECTS_DATA (fields vary by tier). */
export interface SubgraphTask {
  /** Composite entity id `<taskManager>-<taskId>`. */
  id: string;
  /** Bare numeric task id (string). */
  taskId: string;
  title: string | null;
  metadataHash: string | null;
  metadata: Record<string, any> | null;
  status: string;
  payout: string | null;
  bountyToken?: string | null;
  bountyPayout?: string | null;
  assignee?: string | null;
  assigneeUsername?: string | null;
  requiresApplication?: boolean | null;
  createdAt?: string | null;
  /** v6 deadline fields — null means unset on-chain, absent means tier didn't serve them. */
  completionWindow?: string | null;
  absoluteDeadline?: string | null;
  claimDeadline?: string | null;
  reclaimCount?: string | null;
  /** v7 release fields — tier 0 (Gnosis) only. */
  releaseCount?: string | null;
  lastReleasedAt?: string | null;
  [key: string]: any;
}

/** Subgraph Project entity as served by FETCH_PROJECTS_DATA. */
export interface SubgraphProject {
  /** Composite entity id `<taskManager>-<projectIdHex>`. */
  id: string;
  title: string | null;
  metadataHash?: string | null;
  metadata?: Record<string, any> | null;
  cap?: string | null;
  createdAt?: string | null;
  tasks?: SubgraphTask[];
  [key: string]: any;
}

export interface ProjectsDataResult {
  organization: {
    id: string;
    taskManager: {
      id: string;
      creatorHatIds?: string[];
      projects: SubgraphProject[];
    } | null;
  } | null;
}

export interface ProjectsDataRead {
  data: ProjectsDataResult;
  /** Which tier served (see PROJECTS_DATA_TIERS in ../graph/documents/task). */
  tierIndex: number;
  /**
   * Tier 0 adds the v7 release fields (subgraph #201, Gnosis only today);
   * tier 1 is the same document WITHOUT them, so it still carries deadlines.
   * `<= 1` and not `=== 0`: inserting the release tier shifted every index,
   * and reading this as `=== 0` would silently degrade every non-Gnosis org.
   */
  hasDeadlineData: boolean;
  /** Gate release-field rendering on the SERVED TIER, never on truthiness. */
  hasReleaseData: boolean;
}

/**
 * The org's full projects → tasks tree with tier fallback.
 * Port of the read at src/commands/task/list.ts:129 (also view.ts:95).
 */
export async function fetchProjectsData(
  client: Pick<GraphClient, 'queryWithFieldFallback'>,
  orgId: string,
  chainId?: number
): Promise<ProjectsDataRead> {
  const first = await client.queryWithFieldFallback<ProjectsDataResult>(
    projectsDataTiers(orgId),
    { chainId }
  );
  let tierIndex = first.tierIndex;
  const data = first.data;
  const manager = data.organization?.taskManager;
  if (!manager) return { data, tierIndex, hasDeadlineData: tierIndex <= 1, hasReleaseData: tierIndex === 0 };
  const projects = [...(manager.projects ?? [])];
  let page = manager.projects ?? [];
  while (page.length === 50) {
    const cursor = page[page.length - 1].id;
    const next = await client.queryWithFieldFallback<ProjectsDataResult>(
      projectsDataTiers(orgId).map(tier => ({ ...tier, variables: { orgId, projectCursor: cursor } })), { chainId }
    );
    if (!next.data.organization?.taskManager?.projects) throw new CliError('Project pagination returned an incomplete response', EXIT.INFRA);
    page = next.data.organization.taskManager.projects;
    if (page.some(p => p.id <= cursor)) throw new CliError('Project pagination did not advance', EXIT.INFRA);
    projects.push(...page);
    tierIndex = Math.max(tierIndex, next.tierIndex);
  }
  const completeProjects = await Promise.all(projects.map(async project => {
    const tasks = [...(project.tasks ?? [])];
    let taskPage = project.tasks ?? [];
    while (taskPage.length === 1000) {
      const cursor = taskPage[taskPage.length - 1].taskId;
      const next = await client.queryWithFieldFallback<{ project: { tasks: SubgraphTask[] } | null }>(
        PROJECT_TASK_PAGE_TIERS.map(query => ({ query, variables: { projectId: project.id, taskCursor: cursor } })), { chainId }
      );
      if (!next.data.project?.tasks) throw new CliError('Task pagination returned an incomplete response', EXIT.INFRA);
      taskPage = next.data.project.tasks;
      if (taskPage.some(t => ethers.BigNumber.from(t.taskId).gte(cursor))) throw new CliError('Task pagination did not advance', EXIT.INFRA);
      tasks.push(...taskPage);
      tierIndex = Math.max(tierIndex, next.tierIndex);
    }
    return { ...project, tasks };
  }));
  return {
    data: { ...data, organization: { ...data.organization!, taskManager: { ...manager, projects: completeProjects } } },
    tierIndex,
    hasDeadlineData: tierIndex <= 1,
    hasReleaseData: tierIndex === 0,
  };
}

/** Canonical entity ID used by task-manager.ts; never cross an org boundary via a pasted ID. */
export function taskEntityId(taskManagerAddress: string, input: string | number): string {
  const address = ethers.utils.getAddress(taskManagerAddress).toLowerCase();
  if (typeof input === 'number' && !Number.isSafeInteger(input)) throw new CliError('Task ID must be an exact integer string', EXIT.USAGE);
  const raw = String(input).trim();
  if (raw.includes('-') && raw.split('-')[0].toLowerCase() !== address) throw new CliError('Task ID belongs to a different TaskManager', EXIT.USAGE);
  const parsed = parseTaskId(raw);
  if (!/^\d+$/.test(parsed) || raw.split('-').length > 2) throw new CliError('Task ID must be a non-negative integer or a TaskManager-taskId entity ID', EXIT.USAGE);
  const number = ethers.BigNumber.from(parsed);
  if (number.gt(ethers.constants.MaxUint256)) throw new CliError('Task ID exceeds uint256', EXIT.USAGE);
  return `${address}-${number.toString()}`;
}

/** Fetch one task without dropping old tasks or tasks in the 51st project. */
export async function fetchTaskData(
  client: Pick<GraphClient, 'queryWithFieldFallback'>,
  taskManagerAddress: string,
  input: string | number,
  chainId?: number
): Promise<{ task: SubgraphTask | null; tierIndex: number }> {
  const taskId = taskEntityId(taskManagerAddress, input);
  const { data, tierIndex } = await client.queryWithFieldFallback<{ task: SubgraphTask | null }>(
    [FETCH_TASK_DATA_WITH_RELEASES, FETCH_TASK_DATA, FETCH_TASK_DATA_LEGACY].map(query => ({ query, variables: { taskId } })), { chainId }
  );
  return { task: data.task ?? null, tierIndex };
}

export interface TaskSubmissionRecord {
  id: string;
  submissionHash: string;
  submittedAt: string;
  submittedAtBlock: string;
  transactionHash: string;
  metadata: { submission?: string | null } | null;
}
export interface TaskReviewRecord {
  id: string;
  rejector: string;
  rejectorUsername?: string | null;
  rejectionHash: string;
  rejectedAt: string;
  rejectedAtBlock: string;
  transactionHash: string;
  metadata: { rejection?: string | null } | null;
  submission: TaskSubmissionRecord | null;
}
export interface TaskSubmissionHistory {
  indexed: boolean;
  latestSubmission: TaskSubmissionRecord | null;
  latestRejection: string | null;
  submissions: TaskSubmissionRecord[];
  rejections: TaskReviewRecord[];
}

/** Full immutable submission/review history, with explicit old-deployment fallback. */
export async function fetchTaskSubmissionHistory(
  client: Pick<GraphClient, 'queryWithFieldFallback'>,
  taskManagerAddress: string,
  input: string | number,
  chainId?: number
): Promise<TaskSubmissionHistory> {
  const taskId = taskEntityId(taskManagerAddress, input);
  const history: TaskSubmissionHistory = { indexed: false, latestSubmission: null, latestRejection: null, submissions: [], rejections: [] };
  let submissionCursor = '0x';
  let rejectionCursor = '0x';
  while (true) {
    const { data, tierIndex } = await client.queryWithFieldFallback<any>([
      { query: FETCH_TASK_SUBMISSION_HISTORY, variables: { taskId, submissionCursor, rejectionCursor } },
      { query: FETCH_TASK_RELEASE_HISTORY_LEGACY, variables: { taskId } },
    ], { chainId });
    if (tierIndex !== 0 || !data.task) return history;
    history.indexed = true;
    history.latestSubmission = data.task.latestSubmission ?? null;
    history.latestRejection = data.task.latestRejection?.id ?? null;
    const submissions: TaskSubmissionRecord[] = data.task.submissions ?? [];
    const rejections: TaskReviewRecord[] = data.task.rejections ?? [];
    if (submissions.some(row => row.id <= submissionCursor) || rejections.some(row => row.id <= rejectionCursor)) throw new CliError('Task history pagination did not advance', EXIT.INFRA);
    history.submissions.push(...submissions);
    history.rejections.push(...rejections);
    if (submissions.length < 1000 && rejections.length < 1000) break;
    if (submissions.length) submissionCursor = submissions[submissions.length - 1].id;
    if (rejections.length) rejectionCursor = rejections[rejections.length - 1].id;
  }
  history.submissions.sort((a, b) => Number(BigInt(b.submittedAtBlock) - BigInt(a.submittedAtBlock)));
  history.rejections.sort((a, b) => Number(BigInt(b.rejectedAtBlock) - BigInt(a.rejectedAtBlock)));
  return history;
}

/** A task row flattened out of the projects tree, with its project attached. */
export interface TaskListRow extends SubgraphTask {
  /** Composite project entity id the task belongs to. */
  projectId: string;
  projectTitle: string | null;
}

/**
 * Flat list of an org's tasks — the friendliest first read (`pop task list`'s
 * data, sans rendering). Sugar over fetchProjectsData: same tiered query, the
 * projects → tasks tree flattened with each row keeping its project identity.
 */
export async function listTasks(
  client: GraphClient,
  orgId: string,
  chainId?: number
): Promise<TaskListRow[]> {
  const { data } = await fetchProjectsData(client, orgId, chainId);
  const projects = data.organization?.taskManager?.projects ?? [];
  return projects.flatMap(p =>
    (p.tasks ?? []).map(t => ({ ...t, projectId: p.id, projectTitle: p.title ?? null }))
  );
}

/**
 * Find a task in a FETCH_PROJECTS_DATA result by its NUMERIC task id.
 * Port of src/commands/task/helpers.ts findSubgraphTask.
 *
 * The subgraph keys tasks by the composite `<taskManager>-<taskId>` while the contract (and
 * `parseTaskId`) uses the bare number, so callers must pass the parsed id — matching on the raw
 * `--task` argument silently misses whenever a user pastes the composite form back in.
 *
 * Shared because the write commands re-pin metadata from whatever this returns: a miss means
 * they rebuild the doc from defaults and the full-overwrite write erases the task's real
 * name/description/location/dueDate.
 */
export function findSubgraphTask(projects: SubgraphProject[], taskId: string): SubgraphTask | null {
  for (const project of projects || []) {
    for (const task of project.tasks || []) {
      if (task.taskId === taskId || task.id?.endsWith(`-${taskId}`)) return task;
    }
  }
  return null;
}

// ────────────────────── task stats ──────────────────────

/** Port of the inline document at src/commands/task/stats.ts:12. */
export const FETCH_TASK_STATS = `
  query FetchTaskStats($orgId: Bytes!) {
    organization(id: $orgId) {
      users(first: 100) {
        address
        participationTokenBalance
        membershipStatus
        totalTasksCompleted
        totalTasksReleased
        totalTasksLostToExpiry
        account { username }
      }
      taskManager {
        projects(where: { deleted: false }, first: 100) {
          title
          tasks(first: 1000) {
            taskId
            title
            status
            payout
            assignee
            assigneeUsername
            completer
            completerUsername
            createdAt
          }
        }
      }
    }
  }
`;

/**
 * FETCH_TASK_STATS without the claim-churn counters (subgraph #201, TaskManager v7).
 *
 * The two counters are asymmetric: `totalTasksLostToExpiry` is live on Arbitrum too, but
 * `totalTasksReleased` is Gnosis-only as of 2026-08-02 (verified: poa-arb-v-1 answers
 * ``Type `User` has no field `totalTasksReleased```, which `isUnknownFieldError` matches).
 * A document validates as a whole, so they have to share tier 0 — asking for the portable
 * one alongside the Gnosis-only one costs nothing, since the whole query would fail anyway.
 * Derived by deletion so the two tiers cannot drift apart.
 */
export const FETCH_TASK_STATS_LEGACY = FETCH_TASK_STATS
  .split('\n')
  .filter((line) => !/^\s*(totalTasksReleased|totalTasksLostToExpiry)\s*$/.test(line))
  .join('\n');

export interface TaskStatsUser {
  address: string;
  participationTokenBalance: string | null;
  membershipStatus: string | null;
  totalTasksCompleted?: string | null;
  /** Tier 0 only — null row means "not indexed on this chain", not zero. */
  totalTasksReleased?: string | null;
  totalTasksLostToExpiry?: string | null;
  account: { username: string | null } | null;
}

export interface TaskStatsResult {
  organization: {
    users: TaskStatsUser[];
    taskManager: {
      projects: Array<{ title: string | null; tasks: SubgraphTask[] }>;
    } | null;
  } | null;
}

export interface TaskStatsRead {
  data: TaskStatsResult;
  tierIndex: number;
  /** True when the v7 claim-churn counters were served (tier 0). */
  hasChurnCounters: boolean;
}

/**
 * Raw per-member + per-project task analytics inputs.
 * Port of the read at src/commands/task/stats.ts:62 (aggregation stays host-side).
 */
export async function fetchTaskStats(
  client: GraphClient,
  orgId: string,
  chainId?: number
): Promise<TaskStatsRead> {
  const { data, tierIndex } = await client.queryWithFieldFallback<TaskStatsResult>(
    [
      { query: FETCH_TASK_STATS, variables: { orgId } },
      { query: FETCH_TASK_STATS_LEGACY, variables: { orgId } },
    ],
    { chainId }
  );
  return { data, tierIndex, hasChurnCounters: tierIndex === 0 };
}

// ────────────────────── permission masks ──────────────────────

/** Historical project identity plus current authority readiness; no legacy permission rows. */
export const PERMS_QUERY_FULL = `query TaskPermsFull($orgId: Bytes!) {
  organization(id: $orgId) {
    id membershipAuthority { id isRouterBound cutoverAt }
    taskManager { id creatorHatIds organizerHatIds projects(where: { deleted: false }, first: 1000) { id title } }
  }
}`;

export function taskPermsTiers(orgId: string): FieldFallbackTier[] {
  return [{ query: PERMS_QUERY_FULL, variables: { orgId } }];
}

export interface SubgraphRolePermission {
  /** Stable compatibility label; values are authority subject ids (including adopted legacy ids). */
  hatId: string;
  subjectId?: string;
  mask?: number | string;
}

export interface TaskPermsResult {
  organization: {
    id: string;
    taskManager: {
      id: string;
      creatorHatIds?: string[];
      organizerHatIds?: string[];
      globalRolePermissions?: SubgraphRolePermission[];
      projects: Array<{
        id: string;
        title: string | null;
        rolePermissions?: SubgraphRolePermission[];
      }>;
    } | null;
  } | null;
}

export interface TaskPermsRead {
  data: TaskPermsResult;
  tierIndex: number;
}

/**
 * Global + per-project permission masks. Port of the read at
 * src/commands/task/perms.ts:175 (`pop task perms show`).
 */
export async function fetchTaskPerms(
  client: GraphClient, orgId: string, chainId?: number
): Promise<TaskPermsRead> {
  const data = await client.query<any>(PERMS_QUERY_FULL, { orgId }, chainId);
  if (!isAuthorityReady(data.organization)) return { data: { organization: null }, tierIndex: 0 };
  const tm = data.organization.taskManager;
  if (!tm) return { data, tierIndex: 0 };
  const rows = (await readAuthorityRows(client, orgId, FETCH_AUTHORITY_PERMS, 'permRows', chainId))
    .filter(row => row.exists && row.permKey.toLowerCase() === AUTHORITY_KEYS.TM_PERMS.toLowerCase());
  const global = new Map<string, any>(rows.filter(row => row.ctx.toLowerCase() === ethers.constants.HashZero).map(row => [row.subject.subjectId, row]));
  // TaskManager consumes the low uint8 of the authority's OR-mask result.
  const mask = (row: any): number => row ? ethers.BigNumber.from(row.value).and(255).toNumber() : 0;
  const projectRows = (pid: string): SubgraphRolePermission[] => {
    const ctx = projectContext(parseProjectId(pid)).toLowerCase();
    const scoped = new Map<string, any>(rows.filter(row => row.ctx.toLowerCase() === ctx).map(row => [row.subject.subjectId, row]));
    return [...new Set([...global.keys(), ...scoped.keys()])].map(subjectId => {
      const row = scoped.get(subjectId);
      return { hatId: subjectId, subjectId, mask: row ? mask(row) | (row.inheritGlobal ? mask(global.get(subjectId)) : 0) : mask(global.get(subjectId)) };
    });
  };
  tm.globalRolePermissions = [...global.entries()].map(([subjectId, row]) => ({ hatId: subjectId, subjectId, mask: mask(row) }));
  tm.projects = tm.projects.map((p: any) => ({ ...p, rolePermissions: projectRows(p.id) }));
  return { data, tierIndex: 0 };
}

/**
 * Resolve --project-style input (bytes32 hex, subgraph composite ID, or title)
 * to the on-chain bytes32 pid using an already-fetched projects list.
 * Port of src/commands/task/perms.ts resolveProjectFromList (same messages).
 */
export function resolveProjectFromList(
  projects: Array<{ id: string; title?: string | null }>,
  input: string
): { pid: string; title?: string } {
  if (input.startsWith('0x') && input.length === 66) {
    const match = projects.find((p) => parseProjectId(p.id) === input);
    return { pid: input, title: match?.title ?? undefined };
  }
  const byTitle = projects.find((p) => (p.title || '').toLowerCase() === input.toLowerCase());
  if (byTitle) return { pid: parseProjectId(byTitle.id), title: byTitle.title ?? undefined };
  const available = projects.map((p) => p.title).filter(Boolean).join(', ');
  throw new CliError(
    `Project "${input}" not found.`,
    EXIT.USAGE,
    `Available projects: ${available || 'none'} (or pass the 0x-prefixed bytes32 project ID).`
  );
}

// ────────────────────── folders root ──────────────────────

/**
 * Tier 0: v4 schema with folders provenance on Organization.
 * Port of FOLDERS_QUERY_FULL at src/commands/task/folders.ts:54 — foldersRoot
 * verified populated on live Gnosis (org Test6 = 0x8694f683…).
 */
export const FOLDERS_QUERY_FULL = `
  query OrgFolders($orgId: Bytes!) {
    organization(id: $orgId) {
      id
      foldersRoot
      foldersUpdatedAt
      foldersUpdatedBy
    }
  }
`;

/** Tier 1: pre-folders schema. */
export const FOLDERS_QUERY_LEGACY = `
  query OrgFoldersLegacy($orgId: Bytes!) {
    organization(id: $orgId) {
      id
    }
  }
`;

export interface OrgFoldersResult {
  organization: {
    id: string;
    foldersRoot?: string | null;
    foldersUpdatedAt?: string | null;
    foldersUpdatedBy?: string | null;
  } | null;
}

export interface OrgFoldersRead {
  data: OrgFoldersResult;
  tierIndex: number;
  /**
   * Normalised root, or null. A null foldersRoot means "no FoldersUpdated ever
   * indexed", which is NOT the same as "root is zero" — callers must fall back
   * to the on-chain lens (getFoldersRoot) rather than assume.
   */
  indexedRoot: string | null;
}

/**
 * The org's indexed folders root + provenance. Port of the read at
 * src/commands/task/folders.ts:169 (`pop task folders show`).
 */
export async function fetchOrgFolders(
  client: GraphClient,
  orgId: string,
  chainId?: number
): Promise<OrgFoldersRead> {
  const { data, tierIndex } = await client.queryWithFieldFallback<OrgFoldersResult>(
    [
      { query: FOLDERS_QUERY_FULL, variables: { orgId } },
      { query: FOLDERS_QUERY_LEGACY, variables: { orgId } },
    ],
    { chainId }
  );
  return { data, tierIndex, indexedRoot: normalizeRoot(data.organization?.foldersRoot) };
}

/**
 * Normalise a subgraph bytes32 to the 0x-prefixed lowercase form the lens returns.
 * Port of src/commands/task/folders.ts normalizeRoot.
 */
export function normalizeRoot(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return ethers.utils.isHexString(trimmed, 32) ? trimmed : null;
}

// ────────────────────── v7 release history ──────────────────────

export interface TaskReleaseEntry {
  id: string;
  previousClaimer: string;
  previousClaimerUsername: string | null;
  caller: string;
  callerUsername: string | null;
  selfRelease: boolean;
  releasedAt: string;
  releasedAtBlock?: string;
  transactionHash: string;
}

export interface TaskReleaseHistoryResult {
  task: {
    id: string;
    taskId: string;
    status: string;
    releaseCount?: string | null;
    lastReleasedAt?: string | null;
    releases?: TaskReleaseEntry[];
  } | null;
}

export interface TaskReleaseHistoryRead {
  data: TaskReleaseHistoryResult;
  tierIndex: number;
  /** tierIndex 1 means "release history not indexed here" — releases absent, not empty. */
  hasReleaseHistory: boolean;
}

/**
 * One task's release history (subgraph #201, Gnosis-only today). Port of the
 * read at src/commands/task/view.ts:277. `taskEntityId` is the Task ENTITY id
 * — `<lowercased taskManager address>-<numeric task id>`, not the bare number.
 * The CLI issues this only when the shared projects document already reported
 * `releaseCount > 0`, keeping the common path at one round-trip.
 */
export async function fetchTaskReleaseHistory(
  client: GraphClient,
  taskEntityId: string,
  first = 20,
  chainId?: number
): Promise<TaskReleaseHistoryRead> {
  const { data, tierIndex } = await client.queryWithFieldFallback<TaskReleaseHistoryResult>(
    [
      { query: FETCH_TASK_RELEASE_HISTORY, variables: { taskId: taskEntityId, first } },
      { query: FETCH_TASK_RELEASE_HISTORY_LEGACY, variables: { taskId: taskEntityId } },
    ],
    { chainId }
  );
  return { data, tierIndex, hasReleaseHistory: tierIndex === 0 };
}
