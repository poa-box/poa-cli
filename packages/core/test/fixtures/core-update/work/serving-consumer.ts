import { SourceSnapshot } from '../../../../src/data/facts';
import { IndexedRow } from '../../../../src/reads/protocol';
import { WorkPageOptions, listProjectsComplete, listProjectManagersComplete, readWorkPageFacts } from '../../../../src/reads/project';
import { listTasksComplete } from '../../../../src/reads/task';
import { FETCH_TASKS_PAGE } from '../../../../src/graph/documents/task';
export async function read(options: WorkPageOptions): Promise<readonly SourceSnapshot<readonly IndexedRow[]>[]> {
  return Promise.all([listProjectsComplete(options), listProjectManagersComplete(options), listTasksComplete(options),
    readWorkPageFacts({ ...options, document: FETCH_TASKS_PAGE, collection: 'tasks', variables: { orgId: options.source.orgId, taskManager: options.source.contract }, initialCursor: '' })]);
}
