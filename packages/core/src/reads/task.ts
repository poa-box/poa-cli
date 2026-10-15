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

import { requireRawUint } from '../amounts';
import { Fact, knownFact, PlanScope, requireCompleteSnapshot, SourceBlock, SourceRef, SourceSnapshot, unknownFact } from '../data/facts';
import { readIndexedPageFacts, type ProtocolQuery, type IndexedRow } from './protocol';
import { requireWorkSource, validateWorkProject, readWorkPageFacts, type WorkPageOptions } from './project';
import { FETCH_TASKS_PAGE, FETCH_TASKS_PAGE_LEGACY, FETCH_TASK_CLAIM_EXPIRIES_PAGE, FETCH_TASK_APPLICATIONS_PAGE } from '../graph/documents/task';
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

/** Companion read: capped/failed pages retain data and explicit coverage. No optional history in this query. */
export function listTasksComplete(options: WorkPageOptions): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  const variables = requireWorkSource(options.source);
  const query: ProtocolQuery = async (doc, vars, source) => {
    try {
      const response = await options.query(doc, vars, source);
      if (Array.isArray(response.errors) && response.errors.length) throw { response };
      return response;
    } catch (error) {
      const errors = (error as any)?.response?.errors ?? (error as any)?.errors;
      const messages: unknown[] = Array.isArray(errors) && errors.length ? errors.map(e => e?.message) : [(error as any)?.message];
      if (!messages.every(m => typeof m === 'string' && /^(?:Type `Task` has no field `(?:absoluteDeadline|completionWindow|claimDeadline)`|Cannot query field "(?:absoluteDeadline|completionWindow|claimDeadline)" on type "Task"\.?)$/.test(m))) throw error;
      return options.query(FETCH_TASKS_PAGE_LEGACY, vars, source);
    }
  };
  return readWorkPageFacts({ ...options, query, variables, document: FETCH_TASKS_PAGE, collection: 'tasks', initialCursor: '',
    validateRow: row => {
      if (String(row.taskManager).toLowerCase() !== options.source.contract!.toLowerCase()) throw new Error('Task source mismatch');
      validateWorkProject(row.project as IndexedRow, options.source);
      requireRawUint(row.taskId as string); requireRawUint(row.payout as string); requireRawUint(row.bountyPayout as string);
    } });
}
export function listTaskClaimExpiriesComplete(options: WorkPageOptions & { task: string | number }): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  requireWorkSource(options.source);
  const taskId = taskEntityId(options.source.contract!, options.task);
  return readIndexedPageFacts({ ...options, document: FETCH_TASK_CLAIM_EXPIRIES_PAGE, collection: 'taskClaimExpiries', initialCursor: '0x',
    variables: { taskId, taskManager: options.source.contract!.toLowerCase() },
    validateRow: row => {
      const task = row.task as { id?: string; taskManager?: string } | undefined;
      if (task?.id !== taskId || task?.taskManager?.toLowerCase() !== options.source.contract!.toLowerCase()) throw new Error('Expiry task mismatch');
      requireRawUint(row.expiredAt as string); requireRawUint(row.expiredAtBlock as string);
    } });
}

export interface TaskApplicationPageOptions {
  source: SourceRef; query: ProtocolQuery;
  /** Exact decimal task ID or canonical TaskManager-taskId entity ID. */
  task: string;
  pageSize: number; maxPages: number;
}
export interface TaskApplicationData {
  /** Original validated parent, including for a terminal empty application stream. */
  task: IndexedRow | null;
  applications: readonly IndexedRow[];
}
function validateApplicationTask(row: IndexedRow, source: SourceRef, taskId: string): void {
  if (!row || row.id !== taskId || typeof row.taskId !== 'string'
    || requireRawUint(row.taskId) !== taskId.slice(43)
    || typeof row.taskManager !== 'string' || row.taskManager.toLowerCase() !== source.contract!.toLowerCase()) throw new Error('Application task mismatch');
  validateWorkProject(row.project as IndexedRow, source);
}
function validateApplication(row: IndexedRow, source: SourceRef, taskId: string): void {
  if (typeof row.id !== 'string' || !row.id) throw new Error('Invalid application ID');
  validateApplicationTask(row.task as IndexedRow, source, taskId);
  if (typeof row.applicant !== 'string' || !ethers.utils.isAddress(row.applicant) || row.applicant.toLowerCase() === ethers.constants.AddressZero
    || typeof row.approved !== 'boolean' || typeof row.applicationHash !== 'string' || !ethers.utils.isHexString(row.applicationHash, 32)) throw new Error('Invalid application');
  for (const field of ['applicantUsername', 'approverUsername'] as const) if (row[field] !== null && typeof row[field] !== 'string') throw new Error('Invalid application username');
  if (row.approver !== null && (typeof row.approver !== 'string' || !ethers.utils.isAddress(row.approver))) throw new Error('Invalid approver');
  for (const field of ['appliedAt', 'appliedAtBlock'] as const) {
    if (typeof row[field] !== 'string') throw new Error('Missing application timestamp/block');
    requireRawUint(row[field]);
  }
  if (BigInt(row.appliedAtBlock as string) > BigInt(source.block!.number)) throw new Error('Future application');
  if (row.approvedAt !== null) { if (typeof row.approvedAt !== 'string') throw new Error('Invalid approval time'); requireRawUint(row.approvedAt); }
  if (row.metadata !== null) {
    const meta = row.metadata as IndexedRow;
    if (!meta || typeof meta !== 'object' || typeof meta.id !== 'string' || !meta.id) throw new Error('Invalid application metadata');
    for (const field of ['notes', 'experience'] as const) if (meta[field] !== null && typeof meta[field] !== 'string') throw new Error('Invalid application metadata');
    if (meta.indexedAt !== null) { if (typeof meta.indexedAt !== 'string') throw new Error('Invalid metadata time'); requireRawUint(meta.indexedAt); }
  }
}
/** On-demand indexed detail/action read, with explicit bounds and same-response
 * parent/module/_meta proof on EVERY page. No board-wide RPC or host cache.
 * A full final page, malformed/foreign rows or a failed page remains incomplete. */
export async function listTaskApplicationsComplete(options: TaskApplicationPageOptions): Promise<SourceSnapshot<TaskApplicationData>> {
  const variables = requireWorkSource(options.source);
  if (options.source.snapshot !== 'pinned' || typeof options.task !== 'string'
    || ![options.pageSize, options.maxPages].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 1000)) throw new Error('Pinned task applications and explicit bounds required');
  const taskId = taskEntityId(options.source.contract!, options.task);
  const parentIssues: { code: string; id: string }[] = [];
  let parent: IndexedRow | null = null;
  const applicants = new Set<string>();
  let page = 0;
  const result = await readWorkPageFacts({ ...options, variables: { ...variables, taskId },
    document: FETCH_TASK_APPLICATIONS_PAGE, collection: 'taskApplications', initialCursor: '',
    query: async (document, vars, source) => {
      page++;
      const response = await options.query(document, vars, source);
      if (Array.isArray(response.errors) && response.errors.length) return response;
      try {
        const parents = response.tasks;
        if (!Array.isArray(parents) || parents.length !== 1) throw new Error('Application parent unavailable');
        validateApplicationTask(parents[0], source, taskId);
        if (parent && (parents[0].project.id !== (parent.project as IndexedRow).id
          || parents[0].project.projectId !== (parent.project as IndexedRow).projectId)) throw new Error('Application project changed');
        parent ??= parents[0];
      } catch (error) { parentIssues.push({ code: 'APPLICATION_TASK_BINDING_UNAVAILABLE', id: `page:${page}` }); throw error; }
      return response;
    }, validateRow: row => {
      validateApplication(row, options.source, taskId);
      const project = (row.task as IndexedRow).project as IndexedRow;
      if (project.id !== (parent!.project as IndexedRow).id || project.projectId !== (parent!.project as IndexedRow).projectId) throw new Error('Application project mismatch');
      const applicant = (row.applicant as string).toLowerCase();
      if (applicants.has(applicant)) throw new Error('Duplicate applicant');
      applicants.add(applicant);
    } });
  return { ...result, data: { task: parent, applications: result.data },
    coverage: { ...result.coverage, issues: [...result.coverage.issues, ...parentIssues] } };
}
export interface TaskApplicantInput {
  applications: SourceSnapshot<TaskApplicationData>;
  /** TaskManager/org/account and expected endpoint. */
  scope: PlanScope;
  task: string;
  /** Host's currently selected observation; never infer freshness from old rows. */
  block: SourceBlock;
}
/** Exact indexed alreadyApplied fact for scope.account, gated on full enumeration.
 * Preview/capped collections never prove absence (or bypass this coverage gate). */
export function projectTaskApplicant(input: TaskApplicantInput): Fact<boolean> {
  const source = input.applications.source;
  try {
    requireWorkSource(source);
    if (!input.scope.account || !ethers.utils.isAddress(input.scope.account) || input.scope.account.toLowerCase() === ethers.constants.AddressZero
      || !input.scope.orgId || !input.scope.contract || !input.scope.endpoint || !input.block || typeof input.task !== 'string') throw new Error('Applicant scope required');
    if (source.account && source.account.toLowerCase() !== input.scope.account.toLowerCase()) throw new Error('Applicant account mismatch');
    const data = requireCompleteSnapshot(input.applications, { scope: { ...input.scope, account: undefined }, indexed: true, snapshot: 'pinned', block: input.block });
    const taskId = taskEntityId(input.scope.contract, input.task);
    validateApplicationTask(data.task!, source, taskId);
    const applicationKeys = new Set(input.applications.coverage.receivedKeys);
    if (!Array.isArray(data.applications) || data.applications.length !== applicationKeys.size) throw new Error('Application coverage mismatch');
    const applicants = new Set<string>();
    for (const row of data.applications) {
      validateApplication(row, source, taskId);
      if (!applicationKeys.delete(row.id as string)) throw new Error('Application key mismatch');
      const project = (row.task as IndexedRow).project as IndexedRow;
      if (project.id !== (data.task!.project as IndexedRow).id || project.projectId !== (data.task!.project as IndexedRow).projectId) throw new Error('Application project mismatch');
      const applicant = (row.applicant as string).toLowerCase();
      if (applicants.has(applicant)) throw new Error('Duplicate applicant');
      applicants.add(applicant);
    }
    return knownFact(applicants.has(input.scope.account.toLowerCase()), { ...source, account: input.scope.account });
  } catch { return unknownFact('TASK_APPLICANT_EVIDENCE_UNAVAILABLE', source); }
}
