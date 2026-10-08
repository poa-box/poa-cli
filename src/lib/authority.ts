import { readAuthorityUsers } from '@poa-box/core/reads/authority';
import { subgraphModuleClient } from './subgraph-module-client';
/** Merge current membership into historical org statistics without dropping earlier activity. */
export async function refreshAuthorityUsers(org: any, orgId: string, chainId?: number): Promise<void> {
  org.users = await readAuthorityUsers(subgraphModuleClient(), orgId, org.users ?? [], chainId);
}
