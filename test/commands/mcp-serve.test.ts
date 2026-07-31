/**
 * pop mcp serve — protocol-level tests against the BUILT server.
 *
 * Talks real newline-delimited JSON-RPC over stdio to `node dist/index.js mcp
 * serve`, exactly as an MCP client would. Only initialize / tools/list /
 * tools/call pop_manifest are exercised — no tool that touches the network,
 * and never a write.
 *
 * The exposure policy is the substance under test:
 *   default                    read-only tools only; no --pin property; no
 *                              always-pinning reads (org publish)
 *   POP_MCP_ALLOW_WRITES=1     + non-destructive writes
 *   POP_MCP_ALLOW_DESTRUCTIVE  + destructive writes too
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import * as path from 'path';

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

interface RpcMsg { jsonrpc: '2.0'; id?: number; result?: any; error?: any }

function mcpSession(env: Record<string, string>, requests: object[]): Promise<RpcMsg[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'mcp', 'serve'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const replies: RpcMsg[] = [];
    const expected = requests.filter((r: any) => r.id !== undefined).length;
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout; got ${replies.length}/${expected} replies`)); }, 30_000);
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        replies.push(JSON.parse(line));
        if (replies.length >= expected) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          resolve(replies);
        }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    for (const req of requests) child.stdin.write(JSON.stringify(req) + '\n');
  });
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

const names = (replies: RpcMsg[]) => new Set(replies.find((r) => r.id === 2)!.result.tools.map((t: any) => t.name));

describe('pop mcp serve', () => {
  it('default: read-only tools only, pin stripped, always-pin reads excluded', async () => {
    const replies = await mcpSession({}, [INIT, INITIALIZED, LIST]);
    const init = replies.find((r) => r.id === 1)!;
    expect(init.result.protocolVersion).toBe('2024-11-05');
    expect(init.result.capabilities.tools).toBeDefined();

    const tools = names(replies);
    expect(tools.has('pop_org_list')).toBe(true);
    expect(tools.has('pop_vote_list')).toBe(true);
    expect(tools.has('pop_manifest')).toBe(true);
    // writes excluded
    expect(tools.has('pop_task_claim')).toBe(false);
    expect(tools.has('pop_vote_announce_all')).toBe(false);
    // destructive excluded
    expect(tools.has('pop_vote_execute')).toBe(false);
    // an always-pinning "read" is a publish — excluded by default
    expect(tools.has('pop_org_publish')).toBe(false);
    // the server must not expose ITSELF (a nested stdio server hangs the
    // call), nor the interactive init wizard (prompts hang without a TTY)
    expect(tools.has('pop_mcp_serve')).toBe(false);
    expect(tools.has('pop_init')).toBe(false);
    // optional-pin read included, but WITHOUT the pin property
    const leaderboard = replies.find((r) => r.id === 2)!.result.tools.find((t: any) => t.name === 'pop_org_leaderboard');
    expect(leaderboard).toBeDefined();
    expect(leaderboard.inputSchema.properties.pin).toBeUndefined();
  }, 60_000);

  it('POP_MCP_ALLOW_WRITES=1 adds writes but not destructive ones', async () => {
    const replies = await mcpSession({ POP_MCP_ALLOW_WRITES: '1' }, [INIT, INITIALIZED, LIST]);
    const tools = names(replies);
    expect(tools.has('pop_task_claim')).toBe(true);
    expect(tools.has('pop_vote_cast')).toBe(true);
    expect(tools.has('pop_vote_execute')).toBe(false);
    expect(tools.has('pop_token_approve')).toBe(false);
  }, 60_000);

  it('POP_MCP_ALLOW_DESTRUCTIVE=1 exposes everything, loudly labelled', async () => {
    const replies = await mcpSession({ POP_MCP_ALLOW_DESTRUCTIVE: '1' }, [INIT, INITIALIZED, LIST]);
    const listed = replies.find((r) => r.id === 2)!.result.tools;
    const tools = names(replies);
    expect(tools.has('pop_vote_execute')).toBe(true);
    const execute = listed.find((t: any) => t.name === 'pop_vote_execute');
    expect(execute.description).toContain('DESTRUCTIVE');
  }, 60_000);

  it('tools/call pop_manifest returns the machine-readable manifest', async () => {
    const CALL = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pop_manifest', arguments: {} } };
    const replies = await mcpSession({}, [INIT, INITIALIZED, CALL]);
    const call = replies.find((r) => r.id === 3)!;
    expect(call.result.isError).toBe(false);
    const manifest = JSON.parse(call.result.content[0].text);
    expect(manifest.package).toBe('@poa/cli');
    const announceAll = manifest.commands.find((c: any) => c.name === 'vote announce-all');
    expect(announceAll.broadcasts, 'the manifest must carry the announce-all trap').toBe(true);
  }, 60_000);

  it('unknown method gets a JSON-RPC error, not silence', async () => {
    const BAD = { jsonrpc: '2.0', id: 9, method: 'resources/list' };
    const replies = await mcpSession({}, [INIT, INITIALIZED, BAD]);
    const bad = replies.find((r) => r.id === 9)!;
    expect(bad.error?.code).toBe(-32601);
  }, 60_000);
});
