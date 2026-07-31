/**
 * Shared helpers for task commands.
 */

import { resolveOrgModules, requireModule } from '../../lib/resolve';
import type { OrgModules } from '../../lib/resolve';

export interface OrgContracts {
  orgId: string;
  taskManagerAddress: string;
  participationTokenAddress: string;
}

export async function resolveOrgContracts(orgIdOrName: string, chainId?: number): Promise<OrgContracts> {
  const modules = await resolveOrgModules(orgIdOrName, chainId);
  return {
    orgId: modules.orgId,
    taskManagerAddress: requireModule(modules, 'taskManagerAddress'),
    participationTokenAddress: modules.participationTokenAddress || '',
  };
}

/**
 * Find a task in a FETCH_PROJECTS_DATA result by its NUMERIC task id.
 *
 * The subgraph keys tasks by the composite `<taskManager>-<taskId>` while the contract (and
 * `parseTaskId`) uses the bare number, so callers must pass the parsed id — matching on the raw
 * `--task` argument silently misses whenever a user pastes the composite form back in.
 *
 * Shared because the write commands re-pin metadata from whatever this returns: a miss means
 * they rebuild the doc from defaults and the full-overwrite write erases the task's real
 * name/description/location/dueDate.
 */
export function findSubgraphTask(projects: any[], taskId: string): any | null {
  for (const project of projects || []) {
    for (const task of project.tasks || []) {
      if (task.taskId === taskId || task.id?.endsWith(`-${taskId}`)) return task;
    }
  }
  return null;
}
