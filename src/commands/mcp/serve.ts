/**
 * pop mcp serve — a stdio MCP server generated from the command manifest.
 *
 * Zero dependencies: MCP's stdio transport is newline-delimited JSON-RPC 2.0,
 * small enough to speak directly. Every tool is one CLI command, executed as
 * a child process of THIS binary with --json — so the server inherits every
 * safety property the CLI already has (confirmWrite consent, POP_READONLY,
 * the tiered subgraph transport) instead of re-implementing them.
 *
 * Exposure policy (safety-map derived, least privilege by default):
 *   default                       read-only commands only; optional side-effect
 *                                 flags denied and child POP_READONLY forced
 *   --allow-writes /              adds non-destructive writes; --yes is
 *   POP_MCP_ALLOW_WRITES=1        appended (the operator consented by opting in)
 *   --allow-destructive /         adds destructive writes too (vote execute,
 *   POP_MCP_ALLOW_DESTRUCTIVE=1   token approve, …); implies allow-writes
 *
 * POP_READONLY=1 overrides all write opt-ins. Default read-only children always
 * receive it, even when the server's own environment contains signing credentials.
 *
 * Protocol notes: stdout carries ONLY JSON-RPC frames (the CLI's own output
 * lib is never used here); diagnostics go to stderr. Handles initialize,
 * ping, tools/list, tools/call; notifications are consumed silently.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { execFile } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import manifest from '../../generated/cli-manifest.json';

const PROTOCOL_VERSION = '2024-11-05';
const CALL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

interface ArgumentSpec {
  type?: string; description?: string; default?: unknown; choices?: unknown[]; required?: boolean; hidden?: boolean;
}
export interface ManifestCommand {
  name: string;
  kind: string;
  description: string;
  readOnly: boolean;
  broadcasts: boolean;
  destructive: boolean;
  sideEffects: string[];
  positionals: Array<ArgumentSpec & { name: string }>;
  options: Record<string, ArgumentSpec>;
}

interface ServeArgs {
  'allow-writes'?: boolean;
  'allow-destructive'?: boolean;
}

function toolName(commandName: string): string {
  return 'pop_' + commandName.replace(/[^a-z0-9]+/gi, '_');
}

function jsonSchemaType(t?: string): { type: string; items?: { type: string } } {
  switch (t) {
    case 'boolean': return { type: 'boolean' };
    case 'number': case 'count': return { type: 'number' };
    case 'array': return { type: 'array', items: { type: 'string' } };
    default: return { type: 'string' };
  }
}

const SERVER_MANAGED = new Set(['json', 'yes', 'quiet', 'verbose', 'help', 'version', 'private-key']);
const CONDITIONAL_EFFECT = /^[a-z][a-z-]*\(--([a-z][a-z0-9-]*)\)$/i;

function commandAllowed(command: ManifestCommand, allowWrites: boolean, allowDestructive: boolean): boolean {
  if (command.kind !== 'command' || command.name === 'init' || command.name === 'mcp serve' || command.name.startsWith('mcp ')) return false;
  if (command.destructive && !allowDestructive) return false;
  if ((command.broadcasts || command.readOnly !== true) && !allowWrites) return false;
  if (!allowWrites) for (const effect of command.sideEffects ?? []) {
    const flag = CONDITIONAL_EFFECT.exec(effect)?.[1], spec = flag ? command.options?.[flag] : undefined;
    // A conditional side effect is safe only when omitting its exposed flag
    // disables it. Unknown effects and unconditional local/public writes close
    // the capability entirely until the operator opts in.
    if (!flag || !spec || (spec.default !== undefined && spec.default !== false && spec.default !== null && spec.default !== '')) return false;
  }
  return true;
}

function exposedOptions(command: ManifestCommand, allowWrites: boolean): Record<string, ArgumentSpec> {
  const options: Record<string, ArgumentSpec> = Object.create(null);
  const blocked = new Set<string>(SERVER_MANAGED);
  if (!allowWrites) {
    // Defense in depth for the known publishing/file-output switches, including
    // old manifests which predate conditional local-file side-effect metadata.
    blocked.add('pin'); blocked.add('out');
    for (const effect of command.sideEffects ?? []) { const flag = CONDITIONAL_EFFECT.exec(effect)?.[1]; if (flag) blocked.add(flag); }
  }
  const available: Record<string, ArgumentSpec> = { ...manifest.globalFlags, ...command.options };
  for (const [name, spec] of Object.entries(available)) {
    if (!blocked.has(name) && !spec.hidden) options[name] = spec;
  }
  return options;
}

export function buildTools(allowWrites: boolean, allowDestructive: boolean) {
  allowWrites ||= allowDestructive;
  const commands = (manifest.commands as unknown as ManifestCommand[]).filter((c) => {
    return commandAllowed(c, allowWrites, allowDestructive);
  });

  const tools = commands.map((c) => {
    const properties: Record<string, unknown> = Object.create(null);
    const required: string[] = [];
    for (const p of c.positionals ?? []) {
      properties[p.name] = { ...jsonSchemaType(p.type), description: p.description ?? `positional <${p.name}>`, ...(p.choices ? { enum: p.choices } : {}) };
      if (p.required) required.push(p.name);
    }
    for (const [name, spec] of Object.entries(exposedOptions(c, allowWrites))) {
      properties[name] = {
        ...jsonSchemaType(spec.type),
        ...(spec.description ? { description: spec.description } : {}),
        ...(spec.default !== undefined ? { default: spec.default } : {}),
        ...(spec.choices ? { enum: spec.choices } : {}),
      };
      if (spec.required) required.push(name);
    }
    const enabledEffects = allowWrites ? c.sideEffects ?? [] : [];
    const readOnly = !c.broadcasts && c.readOnly && enabledEffects.length === 0;
    const marker = c.destructive ? ' [DESTRUCTIVE WRITE]' : c.broadcasts ? ' [WRITE — broadcasts a transaction]'
      : enabledEffects.length ? ` [SIDE EFFECTS: ${enabledEffects.join(', ')}]` : '';
    return {
      name: toolName(c.name),
      description: `${c.description}${marker}`,
      inputSchema: { type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) },
      annotations: { readOnlyHint: readOnly, destructiveHint: c.destructive || enabledEffects.some(effect => effect.startsWith('ipfs-pin')) },
    };
  });

  // The manifest itself, so an integrator can fetch the machine-readable
  // command spec (readOnly/destructive/sideEffects per command) through MCP.
  tools.push({
    name: 'pop_manifest',
    description: 'The @poa-box/cli machine-readable command manifest: every command with readOnly, broadcasts, destructive, and sideEffects classifications.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
  });

  return { commands, tools };
}

function checkArguments(specs: Record<string, ArgumentSpec>, input: unknown): asserts input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool arguments must be a JSON object');
  for (const key of Object.keys(input)) if (!Object.prototype.hasOwnProperty.call(specs, key)) throw new Error(`Unknown or unavailable argument: ${key.slice(0, 80)}`);
  for (const [name, spec] of Object.entries(specs)) {
    const value = (input as Record<string, unknown>)[name];
    if (value === undefined) { if (spec.required) throw new Error(`Missing required argument: ${name}`); continue; }
    const valid = spec.type === 'array' ? Array.isArray(value) && value.every(item => typeof item === 'string' && !item.includes('\0'))
      : spec.type === 'boolean' ? typeof value === 'boolean'
        : spec.type === 'number' || spec.type === 'count' ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === 'string' && !value.includes('\0');
    if (!valid || (spec.choices && !spec.choices.includes(value))) throw new Error(`Invalid value for argument: ${name}`);
  }
}

export function argvTokens(command: ManifestCommand, input: unknown, allowWrites = false, allowDestructive = false): string[] {
  allowWrites ||= allowDestructive;
  if (!commandAllowed(command, allowWrites, allowDestructive)) throw new Error('Command is unavailable under this server policy');
  const specs = Object.assign(Object.create(null), exposedOptions(command, allowWrites));
  for (const positional of command.positionals ?? []) specs[positional.name] = positional;
  checkArguments(specs, input);
  const tokens = command.name.split(' ');
  for (const p of command.positionals ?? []) {
    const v = input?.[p.name];
    if (v !== undefined) {
      if (Array.isArray(v) || String(v).startsWith('-')) throw new Error(`Option-like positional argument is not allowed: ${p.name}`);
      tokens.push(String(v));
    }
  }
  for (const [key, value] of Object.entries(input ?? {})) {
    if ((command.positionals ?? []).some((p) => p.name === key)) continue;
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) tokens.push(`--${key}=${String(v)}`);
    } else if (typeof value === 'boolean') {
      tokens.push(`--${key}=${value}`);
    } else {
      tokens.push(`--${key}=${String(value)}`);
    }
  }
  return tokens;
}

export const serveHandler = {
  builder: (yargs: Argv) => yargs
    .option('allow-writes', {
      type: 'boolean', default: false,
      describe: 'Expose non-destructive write commands as tools (or POP_MCP_ALLOW_WRITES=1)',
    })
    .option('allow-destructive', {
      type: 'boolean', default: false,
      describe: 'Also expose destructive writes — implies --allow-writes (or POP_MCP_ALLOW_DESTRUCTIVE=1)',
    })
    .example('pop mcp serve', 'Read-only MCP server on stdio — safe default for any integrator')
    .example('POP_MCP_ALLOW_WRITES=1 pop mcp serve', 'Read + non-destructive write tools'),

  handler: async (argv: ArgumentsCamelCase<ServeArgs>) => {
    const readonly = process.env.POP_READONLY === '1';
    const allowDestructive = !readonly && (Boolean(argv.allowDestructive ?? argv['allow-destructive']) || process.env.POP_MCP_ALLOW_DESTRUCTIVE === '1');
    const allowWrites = !readonly && (allowDestructive || Boolean(argv.allowWrites ?? argv['allow-writes']) || process.env.POP_MCP_ALLOW_WRITES === '1');
    const { commands, tools } = buildTools(allowWrites, allowDestructive);
    const byToolName = new Map(commands.map((c) => [toolName(c.name), c]));
    const cliEntry = path.join(__dirname, '..', '..', 'index.js');

    const send = (msg: Record<string, unknown>) => {
      process.stdout.write(JSON.stringify(msg) + '\n');
    };
    const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result });
    const replyError = (id: unknown, code: number, message: string) =>
      send({ jsonrpc: '2.0', id, error: { code, message } });

    const runTool = (name: string, input: unknown): Promise<{ text: string; isError: boolean }> =>
      new Promise((resolve) => {
        if (name === 'pop_manifest') {
          try { checkArguments({}, input); } catch (error: any) { resolve({ text: error.message, isError: true }); return; }
          resolve({ text: JSON.stringify(manifest), isError: false });
          return;
        }
        const command = byToolName.get(name);
        if (!command) {
          resolve({ text: `Unknown tool: ${name}`, isError: true });
          return;
        }
        let args: string[];
        try { args = [cliEntry, ...argvTokens(command, input, allowWrites, allowDestructive), '--json', '--quiet']; }
        catch (error: any) { resolve({ text: error.message, isError: true }); return; }
        // The operator consented to writes by opting the SERVER in; each
        // child still runs the full pre-flight stack before broadcasting.
        if (command.broadcasts || command.destructive) args.push('--yes');
        try { execFile(
          process.execPath,
          args,
          { env: { ...process.env, ...(!allowWrites ? { POP_READONLY: '1' } : {}) }, timeout: CALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
          (error, stdout, stderr) => {
            if (error) {
              const detail = (stderr || stdout || error.message || '').trim();
              resolve({ text: detail.slice(0, 8_000) || 'command failed', isError: true });
            } else {
              resolve({ text: stdout.trim(), isError: false });
            }
          }
        ); } catch { resolve({ text: 'Command could not be started', isError: true }); }
      });

    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      const { id, method, params } = msg;
      // Notifications (no id) are consumed without a response.
      if (id === undefined || id === null) return;

      switch (method) {
        case 'initialize':
          reply(id, {
            protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'pop-mcp', version: String((manifest as any).schemaVersion ?? 1) },
            instructions:
              `POP protocol CLI over MCP. ${tools.length} tools (${allowDestructive ? 'reads + all writes' : allowWrites ? 'reads + non-destructive writes' : 'read-only'}). `
              + 'Call pop_manifest for the full safety classification of every command.',
          });
          return;
        case 'ping':
          reply(id, {});
          return;
        case 'tools/list':
          reply(id, { tools });
          return;
        case 'tools/call': {
          const { name, arguments: input } = params ?? {};
          const { text, isError } = await runTool(String(name), input === undefined ? {} : input);
          reply(id, { content: [{ type: 'text', text }], isError });
          return;
        }
        default:
          replyError(id, -32601, `Method not found: ${method}`);
      }
    });

    process.stderr.write(
      `pop-mcp: serving ${tools.length} tools on stdio (${allowDestructive ? 'destructive writes ENABLED' : allowWrites ? 'writes enabled' : 'read-only'})\n`
    );
    // Keep the process alive until stdin closes.
    await new Promise<void>((resolve) => rl.on('close', resolve));
  },
};

export function registerMcpCommands(yargs: Argv) {
  return yargs
    .command('serve', 'Serve the CLI as an MCP (Model Context Protocol) stdio server', serveHandler.builder, serveHandler.handler)
    .demandCommand(1, 'Please specify an mcp action: serve')
    .epilogue(
      'Tools are generated from the command manifest with least privilege: read-only by default, '
      + '--allow-writes for non-destructive writes, --allow-destructive for everything. '
      + 'POP_READONLY=1 remains the structural backstop.'
    );
}
