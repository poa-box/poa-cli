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
 *   default                       read-only commands only; --pin stripped, and
 *                                 always-pinning reads (org publish) excluded
 *   --allow-writes /              adds non-destructive writes; --yes is
 *   POP_MCP_ALLOW_WRITES=1        appended (the operator consented by opting in)
 *   --allow-destructive /         adds destructive writes too (vote execute,
 *   POP_MCP_ALLOW_DESTRUCTIVE=1   token approve, …); implies allow-writes
 *
 * POP_READONLY=1 in the environment remains the structural backstop: children
 * inherit it, so even a misconfigured server cannot sign or pin.
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

interface ManifestCommand {
  name: string;
  kind: string;
  description: string;
  readOnly: boolean;
  broadcasts: boolean;
  destructive: boolean;
  sideEffects: string[];
  positionals: Array<{ name: string; type?: string; description?: string; required?: boolean }>;
  options: Record<string, { type?: string; description?: string; default?: unknown; choices?: string[]; required?: boolean }>;
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

function buildTools(allowWrites: boolean, allowDestructive: boolean) {
  const commands = (manifest.commands as unknown as ManifestCommand[]).filter((c) => {
    if (c.kind !== 'command') return false;
    // Never expose the server itself (calling pop_mcp_serve spawns a nested
    // stdio server that blocks until the child timeout) or the interactive
    // init wizard (prompts hang a TTY-less child).
    if (c.name === 'init' || c.name === 'mcp serve' || c.name.startsWith('mcp ')) return false;
    if (c.destructive) return allowDestructive;
    if (c.broadcasts) return allowWrites;
    // Read-only, but an ALWAYS-pinning read publishes irreversibly — treat it
    // like a write for exposure purposes. Optional --pin reads are included;
    // the pin flag itself is stripped below unless writes are allowed.
    if ((c.sideEffects ?? []).includes('ipfs-pin')) return allowWrites;
    return true;
  });

  const tools = commands.map((c) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const p of c.positionals ?? []) {
      properties[p.name] = { ...jsonSchemaType(p.type), description: p.description ?? `positional <${p.name}>` };
      if (p.required) required.push(p.name);
    }
    for (const [name, spec] of Object.entries(c.options ?? {})) {
      if (name === 'pin' && !allowWrites) continue; // publishing needs the write opt-in
      if (name === 'json' || name === 'yes' || name === 'quiet' || name === 'verbose') continue; // server-managed
      properties[name] = {
        ...jsonSchemaType(spec.type),
        ...(spec.description ? { description: spec.description } : {}),
        ...(spec.default !== undefined ? { default: spec.default } : {}),
        ...(spec.choices ? { enum: spec.choices } : {}),
      };
      if (spec.required) required.push(name);
    }
    const marker = c.destructive ? ' [DESTRUCTIVE WRITE]' : c.broadcasts ? ' [WRITE — broadcasts a transaction]' : '';
    return {
      name: toolName(c.name),
      description: `${c.description}${marker}`,
      inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    };
  });

  // The manifest itself, so an integrator can fetch the machine-readable
  // command spec (readOnly/destructive/sideEffects per command) through MCP.
  tools.push({
    name: 'pop_manifest',
    description: 'The @poa-box/cli machine-readable command manifest: every command with readOnly, broadcasts, destructive, and sideEffects classifications.',
    inputSchema: { type: 'object', properties: {} },
  });

  return { commands, tools };
}

function argvTokens(command: ManifestCommand, input: Record<string, unknown>): string[] {
  const tokens = command.name.split(' ');
  for (const p of command.positionals ?? []) {
    const v = input?.[p.name];
    if (v !== undefined && v !== null) tokens.push(String(v));
  }
  for (const [key, value] of Object.entries(input ?? {})) {
    if ((command.positionals ?? []).some((p) => p.name === key)) continue;
    if (value === undefined || value === null) continue;
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
    const allowDestructive = Boolean(argv['allow-destructive']) || process.env.POP_MCP_ALLOW_DESTRUCTIVE === '1';
    const allowWrites = allowDestructive || Boolean(argv['allow-writes']) || process.env.POP_MCP_ALLOW_WRITES === '1';
    const { commands, tools } = buildTools(allowWrites, allowDestructive);
    const byToolName = new Map(commands.map((c) => [toolName(c.name), c]));
    const cliEntry = path.join(__dirname, '..', '..', 'index.js');

    const send = (msg: Record<string, unknown>) => {
      process.stdout.write(JSON.stringify(msg) + '\n');
    };
    const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result });
    const replyError = (id: unknown, code: number, message: string) =>
      send({ jsonrpc: '2.0', id, error: { code, message } });

    const runTool = (name: string, input: Record<string, unknown>): Promise<{ text: string; isError: boolean }> =>
      new Promise((resolve) => {
        if (name === 'pop_manifest') {
          resolve({ text: JSON.stringify(manifest), isError: false });
          return;
        }
        const command = byToolName.get(name);
        if (!command) {
          resolve({ text: `Unknown tool: ${name}`, isError: true });
          return;
        }
        const args = [cliEntry, ...argvTokens(command, input), '--json', '--quiet'];
        // The operator consented to writes by opting the SERVER in; each
        // child still runs the full pre-flight stack before broadcasting.
        if (command.broadcasts || command.destructive) args.push('--yes');
        execFile(
          process.execPath,
          args,
          { env: process.env, timeout: CALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
          (error, stdout, stderr) => {
            if (error) {
              const detail = (stderr || stdout || error.message || '').trim();
              resolve({ text: detail.slice(0, 8_000) || 'command failed', isError: true });
            } else {
              resolve({ text: stdout.trim(), isError: false });
            }
          }
        );
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
          const { text, isError } = await runTool(String(name), input ?? {});
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
