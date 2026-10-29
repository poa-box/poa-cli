import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import yargsParser from 'yargs-parser';
const mocks = vi.hoisted(() => ({ exec: vi.fn(), readline: vi.fn() }));
vi.mock('child_process', () => ({ execFile: mocks.exec }));
vi.mock('readline', () => ({ createInterface: mocks.readline }));
import { argvTokens, buildTools, serveHandler, type ManifestCommand } from '../../src/commands/mcp/serve';
let frames: any[], stdout: ReturnType<typeof vi.spyOn>, stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks(); frames = [];
  for (const name of ['POP_MCP_ALLOW_WRITES', 'POP_MCP_ALLOW_DESTRUCTIVE', 'POP_READONLY']) vi.stubEnv(name, '0');
  mocks.exec.mockImplementation((_binary, _args, _options, done) => done(null, '{"ok":true}', ''));
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => { try { frames.push(JSON.parse(String(chunk))); } catch {} return true; }) as any);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as any);
});
afterEach(() => { stdout.mockRestore(); stderr.mockRestore(); vi.unstubAllEnvs(); });
async function rpc(requests: object[], argv: object = {}) {
  const lines = new EventEmitter(); mocks.readline.mockReturnValue(lines);
  const running = serveHandler.handler(argv as any);
  try {
    requests.forEach(request => lines.emit('line', JSON.stringify(request)));
    await vi.waitFor(() => expect(frames).toHaveLength(requests.length));
    return frames;
  } finally { lines.emit('close'); await running; }
}
const call = (arguments_: unknown, name = 'pop_zkemail_build_allowlist', id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } });
const readonlyCommand = (): ManifestCommand => buildTools(false, false).commands.find(command => command.name === 'zkemail build-allowlist')!;
describe('structural MCP read-only capability enforcement', () => {
  it('rejects hidden pin/out flags, equals-syntax keys, aliases and arbitrary globals before spawning any child', async () => {
    const keys = ['pin', 'pin=true', '--pin', 'no-pin', 'out', 'yes', 'y', 'json', 'quiet', 'private-key', 'allow-writes', 'POP_READONLY', 'constructor', '__proto__'];
    const replies = await rpc(keys.map((key, i) => call(Object.assign(Object.create(null), { domain: ['example.invalid'], hat: ['1'], [key]: true }), undefined, i + 1)));
    expect(replies.every(reply => reply.result.isError)).toBe(true);
    expect(mocks.exec).not.toHaveBeenCalled();
    const tool = buildTools(false, false).tools.find(tool => tool.name === 'pop_zkemail_build_allowlist')!;
    expect(tool.inputSchema).toMatchObject({ additionalProperties: false, properties: { domain: { type: 'array' }, hat: { type: 'array' } } });
    expect(tool.inputSchema.properties).not.toHaveProperty('pin'); expect(tool.inputSchema.properties).not.toHaveProperty('out');
    expect(tool.annotations.readOnlyHint).toBe(true);
  });
  it('rejects write commands, destructive username release and unconditional local effects under read-only or non-destructive policy', async () => {
    const reads = buildTools(false, false).tools.map(tool => tool.name), writes = buildTools(true, false).tools.map(tool => tool.name);
    expect(reads).not.toContain('pop_vote_execute'); expect(reads).not.toContain('pop_vote_announce_all');
    expect(reads).not.toContain('pop_org_publish'); expect(reads).not.toContain('pop_treasury_compute_merkle'); expect(reads).not.toContain('pop_execution_recover');
    expect(writes).not.toContain('pop_user_update_profile');
    expect(buildTools(true, true).tools.map(tool => tool.name)).toContain('pop_user_update_profile');
    const replies = await rpc([call({}, 'pop_vote_execute', 1), call({}, 'pop_org_publish', 2), call({}, 'pop_treasury_compute_merkle', 3)]);
    expect(replies.every(reply => reply.result.isError)).toBe(true); expect(mocks.exec).not.toHaveBeenCalled();
  });
  it('forces POP_READONLY in default children and preserves safe explicit global flags', async () => {
    const replies = await rpc([call({ chain: 100, org: 'Example', address: '0x' + '11'.repeat(20) }, 'pop_vote_capabilities')]);
    expect(replies[0].result.isError).toBe(false);
    expect(mocks.exec.mock.calls[0][2].env.POP_READONLY).toBe('1');
    const args = mocks.exec.mock.calls[0][1];
    expect(args).toContain('--chain=100'); expect(args).toContain('--org=Example'); expect(args).not.toContain('--yes');
  });
  it('lets POP_READONLY override all opt-ins and labels write-enabled conditional effects honestly', async () => {
    vi.stubEnv('POP_READONLY', '1'); vi.stubEnv('POP_MCP_ALLOW_DESTRUCTIVE', '1');
    const replies = await rpc([call({}, 'pop_vote_execute', 1), call({}, 'pop_vote_capabilities', 2)], { allowWrites: true, allowDestructive: true });
    expect(replies[0].result.isError).toBe(true); expect(replies[1].result.isError).toBe(false);
    expect(mocks.exec).toHaveBeenCalledTimes(1); expect(mocks.exec.mock.calls[0][2].env.POP_READONLY).toBe('1');
    const writable = buildTools(true, false).tools.find(tool => tool.name === 'pop_zkemail_build_allowlist')!;
    expect(writable.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(writable.description).toContain('ipfs-pin(--pin)'); expect(writable.description).toContain('local-file(--out)');
  });
  it('rejects option-like positionals, type confusion, objects, null, duplicate-key prototype tricks and invalid required arguments', async () => {
    const check = buildTools(false, false).commands.find(command => command.name === 'zkemail check')!;
    expect(() => argvTokens(check, { identifier: '--pin=true' })).toThrow('Option-like positional');
    expect(() => argvTokens(check, { identifier: '--', pin: true })).toThrow();
    const command = readonlyCommand();
    for (const input of [null, [], { domain: { toString: 'pin' } }, { domain: ['example.invalid', true] }, { chain: '100' }, { pin: 'true' }, { domain: ['\0'] }]) {
      expect(() => argvTokens(command, input)).toThrow();
    }
    expect(() => argvTokens(check, {})).toThrow('Missing required');
    const tokens = argvTokens(command, { domain: ['--pin=true'], hat: ['1'], org: '--yes=true' });
    const parsed = yargsParser(tokens.slice(2), { array: ['domain', 'hat'], string: ['domain', 'hat', 'org'] });
    expect(parsed.pin).toBeUndefined(); expect(parsed.yes).toBeUndefined(); expect(parsed.domain).toEqual(['--pin=true']); expect(parsed.org).toBe('--yes=true');
  });
});
