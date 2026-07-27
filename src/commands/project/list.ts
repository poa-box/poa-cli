/**
 * pop project list — list an org's projects (subgraph read).
 *
 * v6 polish: resolves --org by name or hex (previously the raw value was
 * passed straight to the subgraph, so names silently returned nothing),
 * PT caps render through formatToken, and --json emits a structured
 * payload (including an empty array instead of silence when there are
 * no projects).
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { query } from '../../lib/subgraph';
import { resolveOrgId } from '../../lib/resolve';
import { parseProjectId } from '../../lib/encoding';
import { formatToken } from '../../lib/format';
import { FETCH_PROJECTS_DATA } from '../../queries/task';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface ListArgs {
  org: string;
  chain?: number;
}

export const listHandler = {
  builder: (yargs: Argv) => yargs
    .example('pop project list', 'List all projects in the default org')
    .example('pop project list --json', 'Machine-readable project list with caps and task counts'),

  handler: async (argv: ArgumentsCamelCase<ListArgs>) => {
    const spin = output.spinner('Fetching projects...');
    spin.start();

    try {
      const orgId = await resolveOrgId(argv.org, argv.chain);
      const result = await query<any>(FETCH_PROJECTS_DATA, { orgId }, argv.chain);
      const projects = result.organization?.taskManager?.projects || [];

      spin.stop();

      if (output.isJsonMode()) {
        // Script-compatible: same keys as the pre-v6 table output (which
        // --json used to serialize row-by-row), with additive lowercase
        // fields for structured consumers. Empty orgs now emit [] instead
        // of nothing.
        output.json(projects.map((p: any) => {
          const tasks = p.tasks || [];
          const open = tasks.filter((t: any) => t.status === 'Open').length;
          const completed = tasks.filter((t: any) => t.status === 'Completed').length;
          const capDisplay = p.cap && p.cap !== '0' ? formatToken(p.cap, 18, 'PT') : 'unlimited';
          return {
            ID: p.id,
            Name: p.title || 'Untitled',
            'PT Cap': capDisplay,
            Tasks: `${tasks.length} (${open} open, ${completed} done)`,
            Created: p.createdAt ? new Date(parseInt(p.createdAt) * 1000).toLocaleDateString() : '',
            projectId: parseProjectId(p.id),
            capRaw: p.cap || '0',
            taskCounts: { total: tasks.length, open, completed },
            createdAt: p.createdAt ? Number(p.createdAt) : null,
          };
        }));
        return;
      }

      if (projects.length === 0) {
        output.info('No projects found');
        return;
      }

      const rows = projects.map((p: any) => {
        const taskCount = (p.tasks || []).length;
        const openTasks = (p.tasks || []).filter((t: any) => t.status === 'Open').length;
        const completedTasks = (p.tasks || []).filter((t: any) => t.status === 'Completed').length;
        const cap = p.cap && p.cap !== '0' ? formatToken(p.cap, 18, 'PT') : 'unlimited';
        return [
          p.id,
          p.title || 'Untitled',
          cap,
          `${taskCount} (${openTasks} open, ${completedTasks} done)`,
          p.createdAt ? new Date(parseInt(p.createdAt) * 1000).toLocaleDateString() : '',
        ];
      });

      output.table(['ID', 'Name', 'PT Cap', 'Tasks', 'Created'], rows);
    } catch (err: any) {
      spin.stop();
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err?.message || String(err));
      process.exit(EXIT.USAGE);
    }
  },
};
