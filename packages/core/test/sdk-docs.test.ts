import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import * as intents from '../src/tx/intent';

const readme = readFileSync(resolve(__dirname, '../README.md'), 'utf8');
function snippet(markdown: string, id: string): string {
  const match = markdown.match(new RegExp('<!-- sdk-test:' + id + ' -->\\s*```js\\n([\\s\\S]*?)```'));
  if (!match) throw new Error('MISSING_EXECUTABLE_SNIPPET:' + id);
  return match[1];
}
function wallets(source = snippet(readme, 'wallets')) {
  const sponsored = vi.fn(async (...args: unknown[]) => args);
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', output)((name: string) => {
    if (name === '@poa-box/core/tx/intent') return intents;
    if (name === '@poa-box/core/execute/sponsored') return { sendSponsored: sponsored };
    throw new Error('UNEXPECTED_DOC_IMPORT:' + name);
  }, module, module.exports);
  return { api: module.exports, sponsored };
}
const intent = (value: string) => ({ to: '0x' + '12'.repeat(20), abi: ['function pay() payable'], method: 'pay', args: [], value,
  meta: { domain: 'test', action: 'pay', summary: { value: 'do not forward', gasLimit: 'do not forward' } } });
async function captures(source: string, value: string) {
  const { api, sponsored } = wallets(source), tx = intent(value), encoded = intents.encodeIntent(tx);
  const sendTransaction = vi.fn(async (call: any) => call), writeContract = vi.fn(async (call: any) => call);
  const createTransaction = vi.fn(async (call: any) => call), execute = vi.fn(async (request: any, options: any) => ({ request, options }));
  const eoa = await api.sendWithEthers(tx, { sendTransaction });
  const viem = await api.sendWithViem(tx, { sendTransaction });
  const wagmi = await api.sendWithWagmi(tx, writeContract);
  const safe = await api.sendWithSafe(tx, { createTransaction });
  const options = { bundlerUrl: 'https://bundler.invalid', value: 0n };
  await api.sendWithSponsored(tx, 'test-only-key', 'test-org', 7n, options);
  const hostOptions = { gasLimit: '12345' };
  const host = await api.sendWithHost(tx, hostOptions, { isCurrent: () => true, execute });
  return { eoa, viem, wagmi, safe, sponsored: sponsored.mock.calls[0], host, hostOptions, encoded };
}
describe('executable native-value documentation', () => {
  it.each(['1', '9007199254740993'])('preserves exactly %s wei through every documented alternative', async value => {
    const c = await captures(snippet(readme, 'wallets'), value);
    expect(c.eoa).toEqual(c.encoded);
    expect(c.viem).toEqual({ ...c.encoded, value: BigInt(value) });
    expect(c.wagmi).toEqual({ address: intent(value).to, abi: intent(value).abi, functionName: 'pay', args: [], value: BigInt(value) });
    expect(c.safe).toEqual({ transactions: [c.encoded] });
    expect(c.sponsored).toEqual(['test-only-key', c.encoded.to, c.encoded.data, 'test-org', 7n, { bundlerUrl: 'https://bundler.invalid', value: BigInt(value) }]);
    expect(c.host).toEqual({ status: 'current', result: { request: { to: intent(value).to, abi: intent(value).abi, method: 'pay', args: [], value }, options: c.hostOptions } });
  });
  it('refuses value-incapable transport before sending and permits explicit capability', async () => {
    const { api } = wallets(), send = vi.fn(async (call: unknown) => call);
    await expect(api.sendWithValueCapability(intent('1'), { send })).rejects.toThrow('NATIVE_VALUE_TRANSPORT_UNSUPPORTED');
    expect(send).not.toHaveBeenCalled();
    expect(await api.sendWithValueCapability(intent('0'), { send })).toEqual(intents.encodeIntent(intent('0')));
    expect(await api.sendWithValueCapability(intent('9007199254740993'), { supportsNativeValue: true, send })).toEqual(intents.encodeIntent(intent('9007199254740993')));
  });
  it('detects removed payable forwarding rather than only checking example text', async () => {
    const mutated = snippet(readme, 'wallets').replace('return signer.sendTransaction({ to, data, value });', 'return signer.sendTransaction({ to, data });');
    const captured = await captures(mutated, '9007199254740993');
    expect(captured.eoa).not.toEqual(captured.encoded);
  });
  it('keeps host execution options separate and suppresses stale handoff', async () => {
    const { api } = wallets(), execute = vi.fn();
    expect(await api.sendWithHost(intent('1'), {}, { isCurrent: () => false, execute })).toEqual({ status: 'stale' });
    expect(execute).not.toHaveBeenCalled();
  });
});
