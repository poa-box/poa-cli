import { OrganizationDirectoryRow, readOrganizationDirectoryFacts, readOrganizationTaskCounts } from '../../../../src/reads/org';
import { ProtocolPageOptions } from '../../../../src/reads/protocol';
export async function read(options: ProtocolPageOptions) {
  const directory = await readOrganizationDirectoryFacts(options);
  const counts = await readOrganizationTaskCounts({ ...options, directory });
  const modules: string[] = directory.data.flatMap((o: OrganizationDirectoryRow) => o.taskManager ? [o.taskManager.id] : []);
  return { directory, counts, taskCountVariables: { taskManagers: modules } };
}
