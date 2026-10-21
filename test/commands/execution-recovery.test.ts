import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yargs from 'yargs/yargs';
const mocks = vi.hoisted(() => ({ json: vi.fn(), error: vi.fn() }));
vi.mock('../../src/lib/output', () => ({ json: mocks.json, error: mocks.error, isJsonMode: () => true, info: vi.fn() }));
import { registerExecutionCommands } from '../../src/commands/execution';
import { startSubmission, transitionJournal, loadSubmission } from '../../src/lib/submission-recovery';
const ACCOUNT = '0x' + '11'.repeat(20), TARGET = '0x' + '22'.repeat(20), TX = '0x' + '33'.repeat(32), BLOCK = '0x' + '44'.repeat(32);
let saved: NodeJS.ProcessEnv, dir: string, rpcChain: number;
const run = (action: string, chain: string, rpc?: string) => registerExecutionCommands(yargs().exitProcess(false).option('chain', { type: 'number' }).option('rpc', { type: 'string' }))
  .parseAsync([action, '--address', ACCOUNT, '--chain', chain, ...(rpc ? ['--rpc', rpc] : []), ...(action === 'recover' ? ['--candidate-tx', TX] : [])]);
function pending(chainId: number) {
  let record = startSubmission(chainId, ACCOUNT, { to: TARGET, data: '0x1234' });
  record = transitionJournal(record, { type: 'prepare', kind: 'transaction', nonce: '7', callKey: record.scope.intentKey, fromBlock: '100' });
  transitionJournal(record, { type: 'broadcast' });
}
beforeEach(() => {
  saved = { ...process.env }; dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-custom-')); process.env.POP_AGENT_HOME = dir; rpcChain = 424242; process.exitCode = undefined; vi.clearAllMocks();
  vi.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getNetwork').mockImplementation(async () => ({ chainId: rpcChain, name: 'fixture' }));
  vi.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getTransactionReceipt').mockResolvedValue({ transactionHash: TX, blockNumber: 100, blockHash: BLOCK, status: 1 } as any);
  vi.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getTransaction').mockImplementation(async () => ({ hash: TX, from: ACCOUNT, to: TARGET, nonce: 7, chainId: rpcChain, data: '0x1234', value: ethers.constants.Zero, blockNumber: 100, blockHash: BLOCK } as any));
  vi.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getBlock').mockResolvedValue({ number: 100, hash: BLOCK } as any);
  vi.stubGlobal('fetch', () => { throw new Error('Offline test prohibits network'); });
});
afterEach(() => { process.env = saved; vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = undefined; fs.rmSync(dir, { recursive: true, force: true }); });
describe('explicit-chain journal commands', () => {
  it('inspects an explicit custom-chain journal without a network configuration or RPC', async () => {
    pending(424242); await run('status', '424242'); expect(mocks.json.mock.calls[0][0].record.scope.chainId).toBe(424242);
    expect(ethers.providers.JsonRpcProvider.prototype.getNetwork).not.toHaveBeenCalled();
  });
  it('recovers a custom-chain cashout journal with an explicit chain-checked RPC', async () => {
    pending(424242); await run('recover', '424242', 'http://cashout-recovery.invalid');
    expect(mocks.json.mock.calls[0][0].outcome.status).toBe('succeeded'); expect(loadSubmission(424242, ACCOUNT)?.phase).toBe('succeeded');
  });
  it('honors a supported-chain RPC override through the recovery reader', async () => {
    rpcChain = 100; pending(100);
    const getReceipt = vi.mocked(ethers.providers.JsonRpcProvider.prototype.getTransactionReceipt);
    await run('recover', '100', 'http://selected-recovery.invalid');
    expect((getReceipt.mock.instances[0] as ethers.providers.JsonRpcProvider).connection.url).toBe('http://selected-recovery.invalid');
    expect(loadSubmission(100, ACCOUNT)?.phase).toBe('succeeded');
  });
  it('wrong-chain RPC and missing custom-chain RPC preserve the unresolved journal', async () => {
    pending(424242); rpcChain = 100; await run('recover', '424242', 'http://wrong-chain.invalid');
    expect(mocks.error).toHaveBeenLastCalledWith('RPC_CHAIN_MISMATCH'); expect(loadSubmission(424242, ACCOUNT)?.phase).toBe('submitting');
    await run('recover', '424242'); expect(mocks.error.mock.calls.at(-1)![0]).toContain('--rpc');
  });
  it.each(['0', '-1', '1.5', '9007199254740992'])('rejects invalid explicit chain %s', async chain => {
    await run('status', chain); expect(mocks.error.mock.calls[0][0]).toContain('positive safe integer');
  });
});
