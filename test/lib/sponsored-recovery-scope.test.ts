import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fixture, operation, operationIdentity, event, voting, HV, OTHER, TX, META } from '../../packages/core/test/fixtures/bundled-operation-provenance';
const state = vi.hoisted(() => ({ identity: undefined as any, receipt: undefined as any }));
vi.mock('@poa-box/core/execute/ethers', async original => ({ ...await original<any>(), executeContractTx: async (_contract: any, _method: string, _args: any[], options: any) => {
  if (options.dryRun) return { success: true, dryRun: true, gasEstimate: '21000' };
  await options.sponsoredSend.onPrepared({ phase: 'submitting', ...state.identity, computedHash: state.identity.userOpHash, chainId: 100 });
  await options.sponsoredSend.onSubmitted({ phase: 'submitted', ...state.identity, computedHash: state.identity.userOpHash, chainId: 100 });
  return { success: false, sponsored: true, txHash: TX, userOpHash: state.identity.userOpHash, error: 'Receipt wait timed out', errorCode: 'NETWORK_ERROR' };
} }));
import { executeTx } from '../../src/lib/tx';
import { loadSubmission } from '../../src/lib/submission-recovery';
let saved: NodeJS.ProcessEnv, dir: string;
const wallet = new ethers.Wallet('0x' + '11'.repeat(32));
beforeEach(() => { saved = { ...process.env }; dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-sponsored-scope-')); process.env.POP_AGENT_HOME = dir; delete process.env.POP_READONLY;
  vi.stubGlobal('fetch', () => { throw new Error('Offline tests prohibit network'); }); });
afterEach(() => { process.env = saved; fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('CLI reconciled sponsored result scope', () => {
  it.each(['valid', 'missing-boundary'])('recovered %s operation exposes only its proven domain events', async mode => {
    const f = fixture(), data = f.txs[TX].data, args = [...voting.parseTransaction({ data }).args];
    const selected = operation(wallet.address, '9', HV, data, true, f.creationLogs);
    const other = operation(OTHER, '10', HV, data, true, [event(voting, HV, 'NewProposal', [999, f.title, META, 2, 1600, 1000])]);
    f.bundle(TX, [other, selected]); f.receipts[TX].gasUsed = ethers.BigNumber.from(7); state.identity = operationIdentity(selected);
    if (mode === 'missing-boundary') { f.receipts[TX].logs.shift(); f.receipts[TX].logs.forEach((log: any, index: number) => { log.logIndex = 120 + index; }); }
    const provider = new ethers.providers.JsonRpcProvider('http://offline.invalid');
    vi.spyOn(provider, 'getNetwork').mockResolvedValue({ chainId: 100, name: 'gnosis' });
    vi.spyOn(provider, 'getTransactionReceipt').mockResolvedValue(f.receipts[TX]);
    vi.spyOn(provider, 'getTransaction').mockResolvedValue(f.txs[TX]);
    vi.spyOn(provider, 'getBlock').mockResolvedValue({ number: 50, hash: f.receipts[TX].blockHash } as any);
    const signer = wallet.connect(provider), contract = new ethers.Contract(HV, voting, signer);
    const result = await executeTx(contract, 'createProposal', args);
    expect(result.success).toBe(true); expect(result.error).toBeUndefined(); expect(loadSubmission(100, wallet.address)?.phase).toBe('succeeded');
    expect(result.outerReceipt).toBe(f.receipts[TX]);
    if (mode === 'valid') {
      expect(result.logScope).toBe('operation'); expect(result.receipt?.logs).toHaveLength(1);
      expect(result.logs?.filter(log => log.name === 'NewProposal').map(log => log.args.id.toString())).toEqual(['7']);
    } else { expect(result.logScope).toBe('unknown'); expect(result.logs).toEqual([]); expect(result.receipt?.logs).toEqual([]); }
  });
});
