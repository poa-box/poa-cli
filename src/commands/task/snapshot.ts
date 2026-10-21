import type { Argv, ArgumentsCamelCase } from 'yargs';
import { listTasksComplete, listTaskApplicationsComplete, listTaskClaimExpiriesComplete, projectTaskApplicant } from '@poa-box/core/reads/task';
import { listProjectsComplete, listProjectManagersComplete } from '@poa-box/core/reads/project';
import { createIndexedSource } from '../../lib/indexed-source';
import { resolveOrgModules, requireModule } from '../../lib/resolve';
import { resolveNetworkConfig } from '../../config/networks';
import * as output from '../../lib/output';
import { EXIT } from '../../lib/exit-codes';
import { CliError } from '../../lib/errors';
import { requireAddress } from '@poa-box/core/validation';

export interface SnapshotArgs { org: string; chain?: number; task?: string; account?: string; pageSize?: number; maxPages?: number }
export async function workSnapshotOptions(argv: SnapshotArgs) {
  const chainId = resolveNetworkConfig(argv.chain).chainId;
  const modules = await resolveOrgModules(argv.org, chainId);
  const host = await createIndexedSource({ chainId, orgId: modules.orgId, contract: requireModule(modules, 'taskManagerAddress') });
  return { source: host.source, query: host.protocolQuery, pageSize: argv.pageSize ?? 100, maxPages: argv.maxPages ?? 100 };
}
export const snapshotHandler = {
  builder: (yargs: Argv) => yargs
    .option('task', { type: 'string', describe: 'Include independently paged applications and claim-expiry history for this task' })
    .option('account', { type: 'string', describe: 'With --task, project this account’s exact indexed applicant presence/absence; incomplete evidence stays unknown' })
    .option('page-size', { type: 'number', default: 100, describe: 'Rows per page (1–1000)' })
    .option('max-pages', { type: 'number', default: 100, describe: 'Maximum pages per independent collection; reaching the cap remains incomplete' }),
  handler: async (argv: ArgumentsCamelCase<SnapshotArgs>) => {
    try {
      if (argv.account !== undefined && !argv.task) throw new CliError('--account requires --task', EXIT.USAGE);
      let account: string | undefined;
      if (argv.account !== undefined) {
        try { account = requireAddress(argv.account, 'account'); }
        catch (error: any) { throw new CliError(error.message, EXIT.USAGE); }
        if (/^0x0{40}$/i.test(account)) throw new CliError('--account must be nonzero', EXIT.USAGE);
      }
      const options = await workSnapshotOptions(argv);
      const [tasks, projects, managers, applications, claimExpiries] = await Promise.all([
        listTasksComplete(options), listProjectsComplete(options), listProjectManagersComplete(options),
        argv.task ? listTaskApplicationsComplete({ ...options, task: argv.task }) : undefined,
        argv.task ? listTaskClaimExpiriesComplete({ ...options, task: argv.task }) : undefined,
      ]);
      const applicant = account && applications && argv.task ? projectTaskApplicant({ applications, task: argv.task,
        block: options.source.block!, scope: { chainId: options.source.chainId, orgId: options.source.orgId,
          contract: options.source.contract, endpoint: options.source.endpoint, account } }) : undefined;
      output.json({ tasks, projects, managers, ...(argv.task ? { applications, claimExpiries } : {}),
        ...(account ? { applicant } : {}) });
    } catch (err: any) { output.error(err?.message || String(err)); process.exit(err instanceof CliError ? err.code : EXIT.INFRA); }
  },
};
