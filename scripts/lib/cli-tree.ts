/**
 * cli-tree — build a structured model of the pop CLI command tree without
 * executing src/index.ts (which loads .env files and immediately runs main()).
 *
 * How it works: each domain's register*Commands function is invoked with a
 * recording fake that implements the yargs Argv chain surface. `.command()`,
 * `.option()`, `.options()`, `.positional()` and `.demandOption()` record;
 * every other method is a chainable no-op (Proxy get-trap). Recorded command
 * builders are then invoked recursively with fresh recorders to capture
 * nested subcommands (e.g. `pop brain retro <action>` → start/list/show/...).
 *
 * Consumers: scripts/generate-cli-docs.ts (reference generator) and
 * test/docs/doc-commands.test.ts (docs ↔ CLI drift harness).
 */

import { registerTaskCommands } from '../../src/commands/task';
import { registerProjectCommands } from '../../src/commands/project';
import { registerOrgCommands } from '../../src/commands/org';
import { registerVoteCommands } from '../../src/commands/vote';
import { registerUserCommands } from '../../src/commands/user';
import { registerEducationCommands } from '../../src/commands/education';
import { registerVouchCommands } from '../../src/commands/vouch';
import { registerTokenCommands } from '../../src/commands/token';
import { registerTreasuryCommands } from '../../src/commands/treasury';
import { registerPaymasterCommands } from '../../src/commands/paymaster';
import { registerRoleCommands } from '../../src/commands/role';
import { registerZkEmailCommands } from '../../src/commands/zkemail';
import { registerConfigCommands } from '../../src/commands/config';
import { initHandler } from '../../src/commands/init';

export interface OptSpec {
  name: string;
  type?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  choices?: Array<string | number>;
  aliases?: string[];
  variadic?: boolean;
  hidden?: boolean;
}

export interface CliCommand {
  /** Action name without positional tokens, e.g. 'retro' for 'retro <action>' */
  name: string;
  /** Full invocation path, e.g. 'pop brain retro show' */
  fullName: string;
  description: string;
  positionals: OptSpec[];
  /** Flags in registration order (generator sorts alphabetically for output) */
  options: Record<string, OptSpec>;
  subcommands?: CliCommand[];
}

export interface CliDomain {
  domain: string;
  description: string;
  commands: CliCommand[];
}

export interface CliTreeDiagnostic {
  command: string;
  error: string;
}

/**
 * Static mirror of the global options registered in src/index.ts.
 * Keep in sync with the .option() calls there — the doc-test harness treats
 * these as valid on every command.
 */
export const GLOBAL_FLAGS: Record<string, OptSpec> = {
  org: { name: 'org', type: 'string', description: 'Organization ID or name (or set POP_DEFAULT_ORG)' },
  chain: { name: 'chain', type: 'number', description: 'Chain ID override' },
  rpc: { name: 'rpc', type: 'string', description: 'RPC URL override' },
  json: { name: 'json', type: 'boolean', default: false, description: 'Output JSON for machine consumption' },
  'private-key': { name: 'private-key', type: 'string', description: 'Private key (hex)' },
  'dry-run': { name: 'dry-run', type: 'boolean', default: false, description: 'Simulate without sending transactions' },
  yes: { name: 'yes', type: 'boolean', aliases: ['y'], default: false, description: 'Skip confirmations' },
  verbose: { name: 'verbose', type: 'boolean', aliases: ['v'], default: false, description: 'Debug output' },
  quiet: { name: 'quiet', type: 'boolean', aliases: ['q'], default: false, description: 'Suppress non-essential output' },
  preflight: { name: 'preflight', type: 'boolean', default: true, description: 'Run pre-flight checks before writes (--no-preflight to skip)' },
};

/** Mirrors the .command('<domain> <action>', ...) registrations in src/index.ts, same order. */
const DOMAINS: Array<{ domain: string; description: string; register: (y: any) => unknown }> = [
  { domain: 'task', description: 'Task management', register: registerTaskCommands },
  { domain: 'project', description: 'Project management', register: registerProjectCommands },
  { domain: 'org', description: 'Organization management', register: registerOrgCommands },
  { domain: 'vote', description: 'Governance & voting', register: registerVoteCommands },
  { domain: 'user', description: 'User & membership', register: registerUserCommands },
  { domain: 'education', description: 'Education modules', register: registerEducationCommands },
  { domain: 'vouch', description: 'Vouching system', register: registerVouchCommands },
  { domain: 'token', description: 'Participation token requests', register: registerTokenCommands },
  { domain: 'treasury', description: 'Treasury & distributions', register: registerTreasuryCommands },
  { domain: 'paymaster', description: 'Gas sponsorship (ERC-4337)', register: registerPaymasterCommands },
  { domain: 'role', description: 'Role applications', register: registerRoleCommands },
  { domain: 'zkemail', description: 'ZK Email role invites (allowlists)', register: registerZkEmailCommands },
  { domain: 'config', description: 'View and validate configuration', register: registerConfigCommands },
];

/**
 * Top-level commands registered directly on the root parser in src/index.ts
 * (i.e. `pop <command>`, not `pop <domain> <action>`). Mirror of the inline
 * `.command(...)` calls there — keep in sync when a top-level command is added.
 */
const TOP_LEVEL: Array<{ name: string; description: string; builder?: (y: any) => unknown }> = [
  {
    name: 'init',
    description: 'Interactive setup: wallet, chain, default org, .env',
    builder: initHandler.builder,
  },
];

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

interface RecordedCommand {
  /** Raw command string as registered, e.g. 'retro <action>' or 'show <retro-id>' */
  tokens: string;
  aliases: string[];
  /** false = hidden command (yargs convention) */
  description: string | false;
  builder?: unknown;
}

interface Recording {
  commands: RecordedCommand[];
  options: Map<string, OptSpec>;
  positionals: Map<string, OptSpec>;
  demanded: string[];
}

function inferType(spec: Record<string, unknown>): string | undefined {
  if (typeof spec.type === 'string') return spec.type;
  if (spec.boolean === true) return 'boolean';
  if (spec.number === true) return 'number';
  if (spec.string === true) return 'string';
  if (spec.array === true) return 'array';
  if (spec.count === true) return 'count';
  if (Array.isArray(spec.choices) && spec.choices.length > 0) return typeof spec.choices[0];
  if ('default' in spec && spec.default !== undefined && spec.default !== null) return typeof spec.default;
  return undefined;
}

function toOptSpec(name: string, raw: unknown): OptSpec {
  const spec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: OptSpec = { name };
  const type = inferType(spec);
  if (type) out.type = type;
  const desc = spec.describe ?? spec.description ?? spec.desc;
  if (typeof desc === 'string') out.description = desc;
  if (spec.demandOption === true || spec.required === true || spec.require === true) out.required = true;
  if ('default' in spec) out.default = spec.default;
  if (Array.isArray(spec.choices)) out.choices = spec.choices.slice() as Array<string | number>;
  if (spec.alias !== undefined) {
    out.aliases = (Array.isArray(spec.alias) ? spec.alias : [spec.alias]).map(String);
  }
  if (spec.hidden === true) out.hidden = true;
  return out;
}

/**
 * A recording fake for the yargs Argv chain. Known methods record; everything
 * else returns the fake itself so arbitrary chains keep working. The Proxy
 * target is a function so call-forms of yargs remain callable too.
 */
function makeRecorder(): { fake: any; recording: Recording } {
  const recording: Recording = {
    commands: [],
    options: new Map(),
    positionals: new Map(),
    demanded: [],
  };

  const recordOption = (key: unknown, spec: unknown) => {
    if (typeof key === 'string') {
      recording.options.set(key, toOptSpec(key, spec));
    } else if (key && typeof key === 'object') {
      // .option({ a: {...}, b: {...} }) / .options({...}) object form
      for (const [k, v] of Object.entries(key as Record<string, unknown>)) {
        recording.options.set(k, toOptSpec(k, v));
      }
    }
  };

  const recordCommand = (nameOrModule: unknown, desc?: unknown, builder?: unknown) => {
    if (Array.isArray(nameOrModule)) {
      // .command(['name', 'alias', ...], desc, builder, handler)
      const names = nameOrModule.map(String);
      recording.commands.push({
        tokens: names[0] ?? '',
        aliases: names.slice(1),
        description: typeof desc === 'string' || desc === false ? desc : '',
        builder,
      });
      return;
    }
    if (nameOrModule && typeof nameOrModule === 'object') {
      // .command({ command, describe, builder, handler }) module form
      const mod = nameOrModule as Record<string, unknown>;
      const cmd = Array.isArray(mod.command) ? mod.command.map(String) : [String(mod.command ?? '')];
      const modDesc = mod.describe ?? mod.description ?? mod.desc;
      recording.commands.push({
        tokens: cmd[0] ?? '',
        aliases: cmd.slice(1),
        description: typeof modDesc === 'string' || modDesc === false ? modDesc : '',
        builder: mod.builder,
      });
      return;
    }
    recording.commands.push({
      tokens: String(nameOrModule ?? ''),
      aliases: [],
      description: typeof desc === 'string' || desc === false ? desc : '',
      builder,
    });
  };

  const methods: Record<string, (...args: any[]) => any> = {
    command: (nameOrModule: unknown, desc?: unknown, builder?: unknown, _handler?: unknown) => {
      recordCommand(nameOrModule, desc, builder);
      return fake;
    },
    option: (key: unknown, spec?: unknown) => {
      recordOption(key, spec);
      return fake;
    },
    options: (key: unknown, spec?: unknown) => {
      recordOption(key, spec);
      return fake;
    },
    positional: (key: unknown, spec?: unknown) => {
      if (typeof key === 'string') {
        recording.positionals.set(key, toOptSpec(key, spec));
      }
      return fake;
    },
    demandOption: (keys: unknown, _msg?: unknown) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        if (typeof k === 'string') recording.demanded.push(k);
      }
      return fake;
    },
  };

  const chainableNoop = (..._args: unknown[]) => fake;

  const fake: any = new Proxy(function yargsRecorder() { /* callable no-op */ }, {
    get(_target, prop) {
      // Never look thenable — builders are sometimes awaited by yargs internals.
      if (prop === 'then') return undefined;
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(methods, prop)) {
        return methods[prop];
      }
      if (typeof prop === 'symbol') return undefined;
      return chainableNoop;
    },
    apply() {
      return fake;
    },
  });

  return { fake, recording };
}

// ---------------------------------------------------------------------------
// Tree assembly
// ---------------------------------------------------------------------------

interface ParsedName {
  name: string;
  positionalTokens: Array<{ name: string; required: boolean; variadic: boolean }>;
}

/** Split 'mark-change <retro-id> <change-id>' into name + positional tokens. */
function parseCommandTokens(raw: string): ParsedName {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const nameParts: string[] = [];
  const positionalTokens: ParsedName['positionalTokens'] = [];
  for (const part of parts) {
    const match = /^<(.+)>$/.exec(part) ?? /^\[(.+)\]$/.exec(part);
    if (match) {
      const inner = match[1];
      positionalTokens.push({
        name: inner.replace(/\.\.\.?$/, ''),
        required: part.startsWith('<'),
        variadic: /\.\.\.?$/.test(inner),
      });
    } else if (positionalTokens.length === 0) {
      nameParts.push(part);
    }
  }
  return { name: nameParts.join(' '), positionalTokens };
}

function buildCommand(
  rec: RecordedCommand,
  parentFullName: string,
  diagnostics: CliTreeDiagnostic[],
): CliCommand | null {
  if (rec.description === false) return null; // hidden command — omit from docs
  const { name, positionalTokens } = parseCommandTokens(rec.tokens);
  if (!name) return null;
  const fullName = `${parentFullName} ${name}`;

  const { fake, recording } = makeRecorder();
  if (typeof rec.builder === 'function') {
    try {
      (rec.builder as (y: unknown) => unknown)(fake);
    } catch (err: any) {
      diagnostics.push({ command: fullName, error: err?.message ?? String(err) });
    }
  } else if (rec.builder && typeof rec.builder === 'object') {
    // .command(name, desc, { flag: spec, ... }) object-builder form
    for (const [k, v] of Object.entries(rec.builder as Record<string, unknown>)) {
      recording.options.set(k, toOptSpec(k, v));
    }
  }

  // Chained .demandOption('key') marks options or positionals required.
  for (const key of recording.demanded) {
    const opt = recording.options.get(key) ?? recording.positionals.get(key);
    if (opt) opt.required = true;
  }

  // Positionals: command-string tokens define order and required-ness;
  // .positional() specs contribute type/description/choices/defaults.
  const positionals: OptSpec[] = positionalTokens.map((token) => {
    const declared = recording.positionals.get(token.name);
    const merged: OptSpec = { ...(declared ?? {}), name: token.name };
    if (declared?.required !== true) merged.required = token.required;
    else merged.required = true;
    if (token.variadic) merged.variadic = true;
    return merged;
  });
  const tokenNames = new Set(positionalTokens.map((t) => t.name));
  for (const [key, spec] of recording.positionals) {
    if (!tokenNames.has(key)) positionals.push(spec);
  }

  const subcommands = recording.commands
    .map((child) => buildCommand(child, fullName, diagnostics))
    .filter((cmd): cmd is CliCommand => cmd !== null);

  const command: CliCommand = {
    name,
    fullName,
    description: rec.description,
    positionals,
    options: Object.fromEntries(recording.options),
  };
  if (subcommands.length > 0) command.subcommands = subcommands;
  return command;
}

let domainDiagnostics: CliTreeDiagnostic[] = [];
let topLevelDiagnostics: CliTreeDiagnostic[] = [];

/** Builders that threw while being replayed during the last tree build. */
export function getBuildDiagnostics(): CliTreeDiagnostic[] {
  return [...domainDiagnostics, ...topLevelDiagnostics];
}

export function buildCliTree(): CliDomain[] {
  const diagnostics: CliTreeDiagnostic[] = [];
  const domains = DOMAINS.map(({ domain, description, register }) => {
    const { fake, recording } = makeRecorder();
    try {
      register(fake);
    } catch (err: any) {
      diagnostics.push({ command: `pop ${domain}`, error: err?.message ?? String(err) });
    }
    const commands = recording.commands
      .map((rec) => buildCommand(rec, `pop ${domain}`, diagnostics))
      .filter((cmd): cmd is CliCommand => cmd !== null);
    return { domain, description, commands };
  });
  domainDiagnostics = diagnostics;
  return domains;
}

/**
 * Top-level commands (`pop <command>`), recorded the same way as domain
 * actions so the generator and the doc-command drift test see them too.
 */
export function buildTopLevelCommands(): CliCommand[] {
  const diagnostics: CliTreeDiagnostic[] = [];
  const commands = TOP_LEVEL
    .map(({ name, description, builder }) =>
      buildCommand({ tokens: name, aliases: [], description, builder }, 'pop', diagnostics))
    .filter((cmd): cmd is CliCommand => cmd !== null);
  topLevelDiagnostics = diagnostics;
  return commands;
}
