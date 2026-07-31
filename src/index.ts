#!/usr/bin/env node

import { loadEnvFiles } from './lib/env-load';

// Load env before the imports below execute — tsconfig targets CommonJS, so
// emitted require() order follows import order and this call runs first.
// Precedence: cwd/.env > ~/.pop/.env > ~/.pop-agent/.env (earlier files win).
loadEnvFiles();
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { setJsonMode, setQuietMode, setVerbose } from './lib/output';
import * as output from './lib/output';
import { CliError } from './lib/errors';

// Import command registrations
import { registerTaskCommands } from './commands/task';
import { registerProjectCommands } from './commands/project';
import { registerOrgCommands } from './commands/org';
import { registerVoteCommands } from './commands/vote';
import { registerUserCommands } from './commands/user';
import { registerEducationCommands } from './commands/education';
import { registerVouchCommands } from './commands/vouch';
import { registerTokenCommands } from './commands/token';
import { registerTreasuryCommands } from './commands/treasury';
import { registerPaymasterCommands } from './commands/paymaster';
import { registerRoleCommands } from './commands/role';
import { registerZkEmailCommands } from './commands/zkemail';
import { registerConfigCommands } from './commands/config';
import { initHandler } from './commands/init';
import { applyDefaultOrgFallback } from './lib/default-org';

/**
 * The agent surface (`pop agent`, `pop brain`) lives in @poa/agent — a separate
 * package carrying the heavy p2p/CRDT dependency tree (libp2p, helia,
 * automerge). A human `npm install @poa/cli` never fetches any of it; in this
 * repo, or on a host that installed both packages, the probe finds it and the
 * commands work exactly as before.
 *
 * Visibility is separate from availability: the groups are HIDDEN from
 * `pop --help` unless POP_AGENT_MODE=1 (the `pop-agent` bin sets it), but they
 * always EXECUTE when invoked explicitly — every skill and script calling
 * `pop agent triage` or `pop brain read` keeps working unchanged. A yargs
 * command registered with a `false` description is exactly that: invocable,
 * unlisted.
 */
interface AgentPlugin {
  registerAgentCommands: (y: any) => any;
  registerBrainCommands: (y: any) => any;
}

function loadAgentPlugin(): AgentPlugin | null {
  const candidates = [
    '@poa/agent', // installed alongside @poa/cli
    require('path').join(__dirname, '..', 'packages', 'agent', 'dist'), // in-repo build
  ];
  for (const spec of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(spec);
      if (mod?.registerAgentCommands && mod?.registerBrainCommands) return mod;
    } catch { /* not installed / not built — the human surface stands alone */ }
  }
  return null;
}

/**
 * When @poa/agent is not installed, every invocation shape must reach the
 * install hint — `pop brain read --doc x` as much as bare `pop brain`. The
 * builder disables strict parsing for the group (unknown flags would
 * otherwise die with a yargs options dump before any handler runs) and the
 * group-level handler prints the hint.
 */
function agentUnavailableBuilder() {
  return (y: any) => y.strict(false);
}
function agentUnavailableHandler(group: string) {
  return () => {
    output.error(`'pop ${group}' needs the @poa/agent package, which is not installed.`, {
      suggestion: 'In this repo: yarn --cwd packages/agent install && yarn --cwd packages/agent build. '
        + '(@poa/agent is not yet published to npm — in-repo build is the only install.)',
    });
    process.exit(1);
  };
}

async function main() {
  const agentPlugin = loadAgentPlugin();
  // Hidden from human help; `pop-agent` (or POP_AGENT_MODE=1) reveals them.
  // yargs accepts `false` as "register but do not list"; @types/yargs models
  // that as a separate overload a union type cannot select, hence the cast.
  const agentDesc = (s: string): string =>
    (process.env.POP_AGENT_MODE === '1' ? s : (false as unknown as string));
  const cli = yargs(hideBin(process.argv))
    .scriptName('pop')
    .usage('$0 <domain> <action> [options]')
    .command('task <action>', 'Task management', registerTaskCommands)
    .command('project <action>', 'Project management', registerProjectCommands)
    .command('org <action>', 'Organization management', registerOrgCommands)
    .command('vote <action>', 'Governance & voting', registerVoteCommands)
    .command('user <action>', 'User & membership', registerUserCommands)
    .command('education <action>', 'Education modules', registerEducationCommands)
    .command('vouch <action>', 'Vouching system', registerVouchCommands)
    .command('token <action>', 'Participation token requests', registerTokenCommands)
    .command('treasury <action>', 'Treasury & distributions', registerTreasuryCommands)
    .command('paymaster <action>', 'Gas sponsorship (ERC-4337)', registerPaymasterCommands)
    .command('role <action>', 'Role applications', registerRoleCommands)
    .command('zkemail <action>', 'ZK Email role invites (allowlists)', registerZkEmailCommands)
    .command('config <action>', 'View and validate configuration', registerConfigCommands)
    .command('agent <action>', agentDesc('Agent operations & monitoring'),
      agentPlugin ? agentPlugin.registerAgentCommands : agentUnavailableBuilder(),
      agentPlugin ? undefined : agentUnavailableHandler('agent'))
    .command('brain <action>', agentDesc('P2P CRDT brain layer (live-sync knowledge)'),
      agentPlugin ? agentPlugin.registerBrainCommands : agentUnavailableBuilder(),
      agentPlugin ? undefined : agentUnavailableHandler('brain'))
    // Top-level onboarding wizard. Registered before the global --org option so
    // it is clearly not an org-scoped command; its handler never resolves an
    // org, so the POP_DEFAULT_ORG middleware fallback below never blocks it.
    .command('init', 'Interactive setup: wallet, chain, default org, .env', initHandler.builder, initHandler.handler)
    .option('org', {
      type: 'string',
      description: 'Organization ID or name (or set POP_DEFAULT_ORG)',
      global: true,
    })
    .option('chain', {
      type: 'number',
      description: 'Chain ID override',
      global: true,
    })
    .option('rpc', {
      type: 'string',
      description: 'RPC URL override',
      global: true,
    })
    .option('json', {
      type: 'boolean',
      description: 'Output JSON for machine consumption',
      default: false,
      global: true,
    })
    .option('private-key', {
      type: 'string',
      description: 'Private key (hex)',
      global: true,
    })
    .option('address', {
      type: 'string',
      description: 'Observe as this address for identity-scoped reads (or set POP_ADDRESS) — no key needed',
      global: true,
    })
    .option('dry-run', {
      type: 'boolean',
      description: 'Simulate without sending transactions',
      default: false,
      global: true,
    })
    .option('yes', {
      alias: 'y',
      type: 'boolean',
      description: 'Skip confirmations',
      default: false,
      global: true,
    })
    .option('verbose', {
      alias: 'v',
      type: 'boolean',
      description: 'Debug output',
      default: false,
      global: true,
    })
    .option('quiet', {
      alias: 'q',
      type: 'boolean',
      description: 'Suppress non-essential output',
      default: false,
      global: true,
    })
    .option('preflight', {
      type: 'boolean',
      description: 'Run pre-flight checks before writes (--no-preflight to skip)',
      default: true,
      hidden: false,
      global: true,
    })
    .middleware([(argv) => {
      if (argv.json) {
        setJsonMode(true);
      }
      setQuietMode(Boolean(argv.quiet));
      setVerbose(Boolean(argv.verbose));
      // Fall back to POP_DEFAULT_ORG if --org not provided (excludes `init`).
      applyDefaultOrgFallback(argv);
    }])
    .strict()
    .demandCommand(1, 'Please specify a command')
    .completion('completion', 'Generate shell completion script')
    .help()
    .version('0.1.0')
    .wrap(Math.min(110, yargs.terminalWidth()));

  try {
    await cli.parse();
  } catch (err: any) {
    if (err instanceof CliError) {
      output.error(err.message, { suggestion: err.suggestion });
      process.exit(err.code);
    }
    // yargs handles its own errors (missing args, unknown commands)
    if (err.name !== 'YError') {
      output.error(err.message || 'Unknown error');
      process.exit(1);
    }
  }
}

main();
