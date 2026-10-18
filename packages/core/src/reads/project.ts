/**
 * Project-domain subgraph reads and project-id resolution.
 *
 * Ports the read path of `pop project list` (src/commands/project/list.ts) and
 * the project-input resolver shared by `pop project delete`
 * (src/commands/project/delete.ts resolveProjectInput) onto the injected
 * GraphClient. Projects live under the task domain's FETCH_PROJECTS_DATA
 * document — there is no separate projects query.
 */

import { ethers } from 'ethers';
import { requireRawUint } from '../amounts';
import { assertSourceRef, Fact, knownFact, PlanScope, requireCompleteSnapshot, SourceRef, SourceSnapshot, unknownFact } from '../data/facts';
import { readIndexedPageFacts, type ProtocolQuery, type IndexedRow, type IndexedPageFactsOptions } from './protocol';
import { FETCH_PROJECTS_PAGE, FETCH_PROJECT_MANAGERS_PAGE } from '../graph/documents/task';
import type { GraphClient } from '../graph/client';
import { FETCH_PROJECTS_DATA } from '../graph/documents/task';
import { parseProjectId } from '../encoding';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
import { fetchProjectsData } from './task';
import type { SubgraphProject, ProjectsDataResult } from './task';

/**
 * List an org's (non-deleted) projects, tasks included.
 * Port of the read at src/commands/project/list.ts:37 — a bare
 * FETCH_PROJECTS_DATA query (no tier fallback; `pop project list` never used
 * the deadline/release fields, so the base document always validates).
 */
export async function listProjects(
  client: GraphClient,
  orgId: string,
  chainId?: number
): Promise<SubgraphProject[]> {
  const { data: result } = await fetchProjectsData(client, orgId, chainId);
  return result.organization?.taskManager?.projects || [];
}

/**
 * Resolve project input to the on-chain bytes32 pid:
 * bytes32 hex and subgraph composite IDs resolve locally; a plain decimal
 * maps to bytes32(uint) (on-chain pids are counters — verified against
 * _createProjectCore in TaskManager.sol); anything else is treated as a
 * project title and matched via the subgraph.
 *
 * Port of src/commands/project/delete.ts resolveProjectInput (same messages,
 * same resolution order — note decimal beats title here, unlike task create's
 * resolver which tries the title first).
 */
export async function resolveProjectInput(
  client: GraphClient,
  input: string,
  orgId: string,
  chainId?: number
): Promise<{ pid: string; title?: string }> {
  if (input.startsWith('0x') && input.length === 66) return { pid: input };
  if (/^0x[a-fA-F0-9]{40}-/.test(input)) return { pid: parseProjectId(input) };
  if (/^\d+$/.test(input)) {
    return { pid: ethers.utils.hexZeroPad(ethers.BigNumber.from(input).toHexString(), 32) };
  }

  // Title lookup via the subgraph (case-insensitive).
  let projects: SubgraphProject[] = [];
  try {
    const { data: result } = await fetchProjectsData(client, orgId, chainId);
    projects = result.organization?.taskManager?.projects || [];
  } catch {
    throw new CliError(
      `Could not resolve project "${input}" — the subgraph is unavailable for title lookup.`,
      EXIT.INFRA,
      'Pass the 0x-prefixed bytes32 project ID instead (pop project list --json).'
    );
  }
  const match = projects.find((p) => (p.title || '').toLowerCase() === input.toLowerCase());
  if (match) return { pid: parseProjectId(match.id), title: match.title ?? undefined };

  const available = projects.map((p) => p.title).filter(Boolean).join(', ');
  throw new CliError(
    `Project "${input}" not found.`,
    EXIT.USAGE,
    `Available projects: ${available || 'none'} (or pass the 0x-prefixed bytes32 project ID).`
  );
}

export interface WorkPageOptions { source: SourceRef; query: ProtocolQuery; pageSize?: number; maxPages?: number }
/** Complete transport evidence does not make indexed membership current live authority. */
export function requireWorkSource(source: SourceRef): { orgId: string; taskManager: string } {
  assertSourceRef(source);
  if (source.block && source.snapshot !== 'pinned') throw new Error('Explicit indexed block requires pinned source');
  if (!source.indexed || !source.orgId || !source.contract) throw new Error('Explicit indexed org/contract scope required');
  if (!ethers.utils.isHexString(source.orgId, 32) || source.contract.toLowerCase() === ethers.constants.AddressZero) throw new Error('Valid org/nonzero task-manager scope required');
  return { orgId: source.orgId.toLowerCase(), taskManager: source.contract.toLowerCase() };
}
export function validateWorkProject(row: IndexedRow, source: SourceRef): void {
  const manager = row.taskManager as { id?: string; organization?: { id?: string } } | undefined;
  if (manager?.id?.toLowerCase() !== source.contract!.toLowerCase() || manager?.organization?.id?.toLowerCase() !== source.orgId!.toLowerCase()) throw new Error('Project source mismatch');
  if (typeof row.id !== 'string' || !row.id || row.deleted !== false) throw new Error('Missing/deleted project');
  if (typeof row.projectId !== 'string' || !ethers.utils.isHexString(row.projectId, 32)) throw new Error('Invalid project ID');
}
/** Lightweight binding is selected in every page response at the collection's block.
 * In particular, an empty stream cannot certify an unrelated/missing module. */
export async function readWorkPageFacts(options: IndexedPageFactsOptions): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  requireWorkSource(options.source);
  const bindingIssues: { code: string; id: string }[] = [];
  let page = 0;
  const result = await readIndexedPageFacts({ ...options, query: async (document, variables, source) => {
    page++;
    const response = await options.query(document, variables, source);
    if (Array.isArray(response.errors) && response.errors.length) return response;
    const org = response.organization as { id?: string; taskManager?: { id?: string; organization?: { id?: string } } | null } | null | undefined;
    const manager = org?.taskManager;
    const missing = !org || typeof org.id !== 'string' || !manager || typeof manager.id !== 'string' || typeof manager.organization?.id !== 'string';
    if (missing || org!.id!.toLowerCase() !== source.orgId!.toLowerCase() || manager!.id!.toLowerCase() !== source.contract!.toLowerCase()
      || manager!.organization!.id!.toLowerCase() !== source.orgId!.toLowerCase()) {
      bindingIssues.push({ code: missing ? 'MODULE_BINDING_UNAVAILABLE' : 'MODULE_BINDING_MISMATCH', id: `page:${page}` });
      throw new Error('Organization/task-manager binding unavailable or mismatched');
    }
    return response;
  } });
  return { ...result, coverage: { ...result.coverage, issues: [...result.coverage.issues, ...bindingIssues] } };
}
export function listProjectsComplete(options: WorkPageOptions): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  const variables = requireWorkSource(options.source);
  return readWorkPageFacts({ ...options, variables, document: FETCH_PROJECTS_PAGE, collection: 'projects', initialCursor: '',
    validateRow: row => { validateWorkProject(row, options.source); if (row.deleted !== false) throw new Error('Deleted project'); requireRawUint(row.cap as string); } });
}
export function listProjectManagersComplete(options: WorkPageOptions): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  const variables = requireWorkSource(options.source);
  return readWorkPageFacts({ ...options, variables, document: FETCH_PROJECT_MANAGERS_PAGE, collection: 'projectManagers', initialCursor: '',
    validateRow: row => {
      validateWorkProject(row.project as IndexedRow, options.source);
      if (row.isActive !== true || typeof row.manager !== 'string' || !ethers.utils.isAddress(row.manager) || row.manager.toLowerCase() === ethers.constants.AddressZero) throw new Error('Invalid manager row');
    } });
}
export function projectManagerFact(snapshot: SourceSnapshot<readonly IndexedRow[]>, scope: PlanScope, projectId: string, account: string): Fact<boolean> {
  try {
    if (!scope.orgId || !scope.contract || !ethers.utils.isAddress(account) || !ethers.utils.isHexString(projectId, 32)) throw new Error('Explicit project/account scope required');
    if ((scope.account && scope.account.toLowerCase() !== account.toLowerCase()) || (snapshot.source.account && snapshot.source.account.toLowerCase() !== account.toLowerCase())) throw new Error('Manager account mismatch');
    const rows = requireCompleteSnapshot(snapshot, { scope });
    const managers = new Set<string>();
    let active = false;
    for (const row of rows) {
      validateWorkProject(row.project as IndexedRow, snapshot.source);
      if (typeof row.isActive !== 'boolean' || typeof row.manager !== 'string' || !ethers.utils.isAddress(row.manager)) throw new Error('Invalid manager');
      if (String((row.project as IndexedRow).projectId).toLowerCase() !== projectId.toLowerCase()) continue;
      const key = row.manager.toLowerCase();
      if (managers.has(key)) throw new Error('Duplicate manager');
      managers.add(key);
      if (key === account.toLowerCase()) active = row.isActive;
    }
    return knownFact(active, { ...snapshot.source, account });
  } catch { return unknownFact('MANAGER_EVIDENCE_UNAVAILABLE', snapshot.source); }
}
