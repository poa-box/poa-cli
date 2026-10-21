import type { Argv, ArgumentsCamelCase } from 'yargs';
import * as fs from 'fs';
import * as path from 'path';
import * as output from '@poa-box/cli/lib/output';

/** Discover the installed CLI, rather than teaching agents a stale command list. */
export const capabilitiesHandler = {
  builder: (yargs: Argv) => yargs
    .option('domain', { type: 'string', describe: 'Filter capabilities by CLI domain (for example role, task, execution)' })
    .option('read-only', { type: 'boolean', default: false, describe: 'Only commands without broadcasts or external/local side effects' }),
  handler: async (argv: ArgumentsCamelCase<{ domain?: string; 'read-only'?: boolean }>) => {
    try {
      const root = path.dirname(require.resolve('@poa-box/cli/package.json'));
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'generated', 'cli-manifest.json'), 'utf8'));
      if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.commands)) throw new Error('Unsupported CLI capability manifest');
      const domain = argv.domain?.trim();
      const commands = manifest.commands.filter((command: any) => command.kind === 'command'
        && (!domain || command.name.split(' ')[0] === domain)
        && (!argv.readOnly || (command.readOnly === true && command.broadcasts === false && Array.isArray(command.sideEffects) && command.sideEffects.length === 0)));
      if (domain && commands.length === 0) throw new Error(`No matching commands in CLI domain ${domain}`);
      const result = {
        schemaVersion: 1, cliVersion: require('@poa-box/cli/package.json').version, commands,
        policy: {
          observeWith: 'POP_READONLY=1 and --address/POP_ADDRESS; always use --json',
          incompleteEvidence: 'Unknown or incomplete facts cannot authorize a write, establish an empty board, or prove an absent ballot.',
          preparation: 'An unsigned plan or prepared intent is not proof of current authority. Revalidate scope, source, freshness, and consequences before execution.',
          roleCreation: 'Create the subject first, confirm exact creation/execution provenance, then review configuration against the confirmed ID.',
          treasury: 'Reserve unresolved rounds; spend only independently proven available balance. Missing historical payouts are unavailable, not zero.',
          recovery: 'Inspect execution status and recover exact submissions before any retry. An unknown send must never trigger an automatic resend.',
          consent: '--json is formatting; destructive writes require explicit --yes. Respect the configured agent execution mode.',
        },
      };
      if (output.isJsonMode()) output.json(result);
      else {
        output.table(['Command', 'Broadcasts', 'Destructive', 'Side effects'], commands.map((command: any) => [
          `pop ${command.name}`, String(command.broadcasts), String(command.destructive), command.sideEffects.join(', '),
        ]));
        output.info('Use --json for argument schemas and protocol decision rules.');
      }
    } catch (error: any) { output.error(error.message); process.exit(1); }
  },
};
