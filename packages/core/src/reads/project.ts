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
import type { GraphClient } from '../graph/client';
import { FETCH_PROJECTS_DATA } from '../graph/documents/task';
import { parseProjectId } from '../encoding';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
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
  const result = await client.query<ProjectsDataResult>(FETCH_PROJECTS_DATA, { orgId }, chainId);
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
    const result = await client.query<ProjectsDataResult>(FETCH_PROJECTS_DATA, { orgId }, chainId);
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
