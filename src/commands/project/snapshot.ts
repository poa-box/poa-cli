import type { Argv, ArgumentsCamelCase } from 'yargs';
import { listProjectsComplete, listProjectManagersComplete } from '@poa-box/core/reads/project';
import { workSnapshotOptions, type SnapshotArgs } from '../task/snapshot';
import * as output from '../../lib/output';
import { EXIT } from '../../lib/exit-codes';

export const snapshotHandler = {
  builder: (yargs: Argv) => yargs
    .option('page-size', { type: 'number', default: 100, describe: 'Rows per page (1–1000)' })
    .option('max-pages', { type: 'number', default: 100, describe: 'Maximum pages per collection' }),
  handler: async (argv: ArgumentsCamelCase<SnapshotArgs>) => {
    try {
      const options = await workSnapshotOptions(argv);
      const [projects, managers] = await Promise.all([listProjectsComplete(options), listProjectManagersComplete(options)]);
      output.json({ projects, managers });
    } catch (err: any) { output.error(err?.message || String(err)); process.exit(EXIT.INFRA); }
  },
};
