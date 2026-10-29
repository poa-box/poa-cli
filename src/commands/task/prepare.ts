import type { Argv, ArgumentsCamelCase } from 'yargs';
import { buildCreateTaskRaw, buildCreateAndAssignTaskRaw, buildCreateTasksBatchRaw, taskConfigCall } from '@poa-box/core/tx/task';
import { decideTaskActions } from '@poa-box/core/tasks/policy';
import { mergeTaskMetadataFinal, requireTaskMetadataFinal, serializeTaskMetadata } from '@poa-box/core/metadata/task';
import { readPreparedInput, preparedIntentOutput } from '../user/prepare';
import * as output from '../../lib/output';
import { EXIT } from '../../lib/exit-codes';

export function prepareTaskAction(action: string, input: Record<string, any>): unknown {
  if (action === 'policy') return { decisions: decideTaskActions(input as any), executionVerified: false };
  if (action === 'metadata') {
    if (input.mode !== 'patch' && input.mode !== 'replace') throw new Error('Task metadata mode must be patch or replace');
    const metadata = input.mode === 'patch' ? mergeTaskMetadataFinal(input.existing ?? null, input.updates)
      : requireTaskMetadataFinal(input.metadata);
    return { prepared: true, broadcast: false, metadata, serialized: serializeTaskMetadata(metadata) };
  }
  const intent = action === 'create' ? buildCreateTaskRaw({ ...input, features: { deadlines: true } } as any)
    : action === 'create-and-assign' ? buildCreateAndAssignTaskRaw({ ...input, features: { deadlines: true } } as any)
    : action === 'create-batch' ? buildCreateTasksBatchRaw(input as any)
    : action === 'config' ? taskConfigCall(input.taskManagerAddress, input.config, input.orgId)
    : undefined;
  if (!intent) throw new Error(`Unsupported task preparation: ${action}`);
  return preparedIntentOutput(intent);
}
export const prepareHandler = {
  builder: (yargs: Argv) => yargs
    .positional('action', { choices: ['create', 'create-and-assign', 'create-batch', 'config', 'metadata', 'policy'] as const })
    .option('file', { type: 'string', demandOption: true, describe: 'JSON raw-unit task arguments, explicit metadata merge, or scoped policy facts' })
    .epilogue('Local preparation only. Raw payouts/caps are decimal strings. Policy facts are supplied evidence and do not attest current permissions or deployed contract support.'),
  handler: async (argv: ArgumentsCamelCase<{ action: string; file: string }>) => {
    try { output.json(prepareTaskAction(argv.action, readPreparedInput(argv.file))); }
    catch (err: any) { output.error(err?.message || String(err)); process.exit(EXIT.USAGE); }
  },
};
