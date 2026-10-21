import type { Argv, ArgumentsCamelCase } from 'yargs';
import { buildCreateProjectRaw } from '@poa-box/core/tx/project';
import { deriveProjectCreatorAuthorization } from '@poa-box/core/tasks/project-creator';
import { readPreparedInput, preparedIntentOutput } from '../user/prepare';
import * as output from '../../lib/output';
import { EXIT } from '../../lib/exit-codes';

export function prepareProjectAction(action: string, input: Record<string, any>): unknown {
  if (action === 'creator-authorization') return { prepared: true, broadcast: false, liveAuthorizationVerified: false,
    authorization: deriveProjectCreatorAuthorization(input as any) };
  if (action !== 'create') throw new Error(`Unsupported project preparation: ${action}`);
  return preparedIntentOutput(buildCreateProjectRaw(input as any));
}

export const prepareHandler = {
  builder: (yargs: Argv) => yargs
    .positional('action', { choices: ['create', 'creator-authorization'] as const, default: 'create', describe: 'Raw creation calldata or supplied creator-evidence projection' })
    .option('file', { type: 'string', demandOption: true, describe: 'JSON raw project arguments, or scoped taskManager/authority/memberships snapshots for creator-authorization' })
    .example('pop project prepare creator-authorization --file creator-evidence.json --json', 'Project current-creator authorization from supplied pinned observations')
    .epilogue('Prepares locally. Creator projection validates supplied evidence and retains unknowns; it does not collect live settings or authorize a transaction. Raw caps include the uint128 unlimited sentinel. Permission, freshness and deployed-module checks belong to the executing host.'),
  handler: async (argv: ArgumentsCamelCase<{ action?: string; file: string }>) => {
    try { output.json(prepareProjectAction(argv.action ?? 'create', readPreparedInput(argv.file))); }
    catch (err: any) { output.error(err?.message || String(err)); process.exit(EXIT.USAGE); }
  },
};
