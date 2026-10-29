import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import fs from 'fs';
import os from 'os';
import path from 'path';
const state = vi.hoisted(() => ({ mode: 'lost', dispatches: 0, prepared: undefined as any }));
vi.mock('@poa-box/core/execute/sponsored', async original => ({ ...await original<any>(), delegateEOA: async (_key: any, _rpc: any, options: any) => {
  await options.onPrepared(state.prepared); state.dispatches++;
  if (state.mode === 'lost') throw new Error('response lost after dispatch');
  await options.onSubmitted('0x' + '55'.repeat(32)); return '0x' + '55'.repeat(32);
} }));
import { delegateEOA, EOA_DELEGATION } from '../../src/lib/sponsored';
import { loadSubmission, startSubmission, transitionJournal, recoverSubmission } from '../../src/lib/submission-recovery';
import { submissionAuthorizationKey } from '@poa-box/core/execute/recovery';
const KEY = ('0x' + '11'.repeat(32)) as `0x${string}`, ACCOUNT = new ethers.Wallet(KEY).address, TX = '0x' + '55'.repeat(32), BLOCK = '0x' + '66'.repeat(32);
const authorization = { chainId: 100, address: EOA_DELEGATION, nonce: 8, yParity: 1, r: '0x' + '00'.repeat(31) + '01', s: '0x' + '00'.repeat(31) + '02' };
let saved: NodeJS.ProcessEnv, dir: string;
beforeEach(() => {
  saved = { ...process.env }; delete process.env.POP_READONLY; dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-delegation-')); process.env.POP_AGENT_HOME = dir;
  state.mode = 'lost'; state.dispatches = 0; state.prepared = { chainId: 100, account: ACCOUNT, nonce: '7', fromBlock: '100', authorizationList: [authorization] };
  vi.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getNetwork').mockResolvedValue({ chainId: 100, name: 'gnosis' });
  vi.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getBlockNumber').mockResolvedValue(100);
  vi.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getBlock').mockResolvedValue({ number: 100, hash: BLOCK } as any);
  vi.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getTransactionReceipt').mockImplementation(async () => state.mode === 'settled' ? { transactionHash: TX, blockNumber: 100, blockHash: BLOCK, status: 1 } as any : null as any);
  vi.spyOn(ethers.providers.JsonRpcProvider.prototype, 'waitForTransaction').mockRejectedValue(new Error('receipt wait timed out'));
  vi.spyOn(ethers.providers.JsonRpcProvider.prototype, 'send').mockImplementation(async method => method === 'eth_getTransactionByHash'
    ? { hash: TX, from: ACCOUNT, to: ACCOUNT, input: '0x', value: '0x0', nonce: '0x7', chainId: '0x64', blockNumber: '0x64', blockHash: BLOCK, type: '0x4', authorizationList: [{ ...authorization, r: '0x1', s: '0x2' }] }
    : { transactions: [] });
  vi.stubGlobal('fetch', () => { throw new Error('Offline tests prohibit network'); });
});
afterEach(() => { process.env = saved; vi.restoreAllMocks(); vi.unstubAllGlobals(); fs.rmSync(dir, { recursive: true, force: true }); });
describe('durable delegation host', () => {
  it.each(['lost', 'timeout'])('accepted %s outcome blocks a second delegation dispatch', async mode => {
    state.mode = mode;
    await expect(delegateEOA(KEY, 'http://offline.invalid')).rejects.toThrow(/unresolved/);
    expect(loadSubmission(100, ACCOUNT)).toMatchObject({ phase: 'unresolved', nonce: '7', authorizationKey: submissionAuthorizationKey([authorization]) });
    await expect(delegateEOA(KEY, 'http://offline.invalid')).rejects.toThrow(/Unresolved submission/);
    expect(state.dispatches).toBe(1);
  });
  it('a preexisting unresolved treasury submission prevents delegation before dispatch', async () => {
    let record = startSubmission(100, ACCOUNT, { to: EOA_DELEGATION, data: '0x' });
    record = transitionJournal(record, { type: 'prepare', kind: 'transaction', nonce: '7', callKey: record.scope.intentKey });
    transitionJournal(record, { type: 'broadcast' });
    await expect(delegateEOA(KEY, 'http://offline.invalid')).rejects.toThrow(/Unresolved submission/); expect(state.dispatches).toBe(0);
  });
  it('a timed-out wait returns success only after exact authorization and canonical inclusion settle', async () => {
    state.mode = 'settled'; expect(await delegateEOA(KEY, 'http://offline.invalid')).toBe(TX);
    expect(loadSubmission(100, ACCOUNT)?.phase).toBe('succeeded'); expect(state.dispatches).toBe(1);
  });
  it('later read-only recovery uses raw type-4 authorization fields before releasing the account', async () => {
    state.mode = 'timeout'; await expect(delegateEOA(KEY, 'http://offline.invalid')).rejects.toThrow(/unresolved/);
    state.mode = 'settled';
    const result = await recoverSubmission(100, ACCOUNT, new ethers.providers.JsonRpcProvider('http://offline.invalid'));
    expect(result.outcome.status).toBe('succeeded'); expect(state.dispatches).toBe(1);
  });
  it('failed pre-dispatch persistence hooks send nothing and retain no possibly-broadcast identity', async () => {
    await expect(delegateEOA(KEY, 'http://offline.invalid', { onPrepared: () => { throw new Error('policy check failed'); } })).rejects.toThrow('policy check failed');
    expect(state.dispatches).toBe(0); expect(loadSubmission(100, ACCOUNT)?.phase).toBe('aborted');
  });
});
