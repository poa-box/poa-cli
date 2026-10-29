import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ethers } from 'ethers';
import { USER_OPERATION_EVENTS } from '@poa-box/core/execute/outcome';
import { executeTx } from '../../src/lib/tx';
import { acquireSubmissionLock, startSubmission, transitionJournal, loadSubmission, recoverSubmission, recoveryDirectory } from '../../src/lib/submission-recovery';

const ACCOUNT = '0x1111111111111111111111111111111111111111', TARGET = '0x2222222222222222222222222222222222222222';
const TX = '0x' + 'ab'.repeat(32), BLOCK = '0x' + 'cd'.repeat(32);
const iface = new ethers.utils.Interface(['function action()', 'event NewProposal(uint256 id)']);
let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  env = { ...process.env }; home = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-recovery-'));
  process.env.POP_AGENT_HOME = home;
  for (const key of ['POP_PRIVATE_KEY', 'POP_ORG_ID', 'POP_HAT_ID', 'POP_READONLY', 'PIMLICO_API_KEY', 'POP_BUNDLER_URL']) delete process.env[key];
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Offline tests prohibit network'); }));
});
afterEach(() => { process.env = env; vi.unstubAllGlobals(); vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });
function fixture(mode: 'success' | 'lost' | 'timeout' = 'success') {
  const data = iface.encodeFunctionData('action');
  const receipt: any = { transactionHash: TX, blockHash: BLOCK, blockNumber: 100, status: 1, gasUsed: ethers.BigNumber.from(7), logs: [] };
  const tx: any = { hash: TX, from: ACCOUNT, to: TARGET, nonce: 7, chainId: 100, data, value: ethers.BigNumber.from(0), blockNumber: 100, blockHash: BLOCK,
    wait: async () => { if (mode === 'timeout') throw new Error('receipt response lost'); return receipt; } };
  const provider = new ethers.providers.JsonRpcProvider('http://offline.invalid');
  vi.spyOn(provider, 'getNetwork').mockResolvedValue({ chainId: 100, name: 'gnosis' });
  vi.spyOn(provider, 'estimateGas').mockResolvedValue(ethers.BigNumber.from(21000));
  vi.spyOn(provider, 'resolveName').mockImplementation(async name => name);
  vi.spyOn(provider, 'getBlockNumber').mockResolvedValue(100);
  vi.spyOn(provider, 'getBlock').mockResolvedValue({ number: 100, hash: BLOCK, timestamp: 1234 } as any);
  vi.spyOn(provider, 'getTransactionReceipt').mockImplementation(async () => mode === 'success' ? receipt : null as any);
  vi.spyOn(provider, 'getTransaction').mockResolvedValue(tx);
  vi.spyOn(provider, 'getBlockWithTransactions').mockResolvedValue({ number: 100, hash: BLOCK, transactions: [] } as any);
  const send = vi.fn(async (_request: any) => { if (mode === 'lost') throw new Error('response lost after possible send'); return tx; });
  class OfflineSigner extends ethers.Signer {
    constructor() { super(); ethers.utils.defineReadOnly(this, 'provider', provider); }
    getAddress() { return Promise.resolve(ACCOUNT); }
    signMessage(): Promise<string> { throw new Error('No test signing'); }
    signTransaction(): Promise<string> { throw new Error('No test signing'); }
    connect() { return this; }
    async populateTransaction(request: any) { return { ...await ethers.utils.resolveProperties(request), nonce: 7, chainId: 100 }; }
    sendTransaction(request: any) { return send(request); }
  }
  return { contract: new ethers.Contract(TARGET, iface, new OfflineSigner()), provider, send, receipt, tx };
}
describe('durable CLI submission host', () => {
  it('persists before an ambiguous EOA send and blocks every later action for that account', async () => {
    const f = fixture('lost');
    f.send.mockImplementationOnce(async () => {
      expect(loadSubmission(100, ACCOUNT)).toMatchObject({ phase: 'submitting', nonce: '7', fromBlock: '100', kind: 'transaction' });
      throw new Error('Response lost');
    });
    const result = await executeTx(f.contract, 'action', []);
    expect(result.success).toBe(false); expect(result.recovery).toMatchObject({ account: ACCOUNT, phase: 'unresolved', nonce: '7' });
    expect(loadSubmission(100, ACCOUNT)?.phase).toBe('unresolved');
    await executeTx(f.contract, 'action', []);
    expect(f.send).toHaveBeenCalledTimes(1);
    const serialized = fs.readFileSync(path.join(recoveryDirectory(), `100-${ACCOUNT}.json`), 'utf8');
    expect(serialized).not.toContain('\"method\"'); expect(serialized).not.toContain('offline.invalid'); expect(serialized).not.toContain(iface.encodeFunctionData('action'));
  });
  it('retains an acknowledged hash after a receipt timeout and never retries automatically', async () => {
    const f = fixture('timeout'), result = await executeTx(f.contract, 'action', []);
    expect(result).toMatchObject({ success: false, txHash: TX });
    expect(loadSubmission(100, ACCOUNT)).toMatchObject({ phase: 'unresolved', txHash: TX });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('settles a matching canonical EOA transaction before permitting another send', async () => {
    const f = fixture(), result = await executeTx(f.contract, 'action', []);
    expect(result.success).toBe(true); expect(loadSubmission(100, ACCOUNT)?.phase).toBe('succeeded');
    await executeTx(f.contract, 'action', []); expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('reports success and receipt events when a receipt-wait timeout is settled as a canonical success', async () => {
    const f = fixture('timeout');
    f.receipt.logs = [{ address: TARGET, ...iface.encodeEventLog('NewProposal', [7]) }];
    vi.mocked(f.provider.getTransactionReceipt).mockResolvedValue(f.receipt);
    const result = await executeTx(f.contract, 'action', []);
    expect(result).toMatchObject({ success: true, txHash: TX, blockNumber: 100, gasUsed: '7' });
    expect(result.logs?.[0].name).toBe('NewProposal'); expect(result.logs?.[0].args.id.toString()).toBe('7');
    expect(result.error).toBeUndefined(); expect(result.errorCode).toBeUndefined();
    expect(loadSubmission(100, ACCOUNT)?.phase).toBe('succeeded');
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('an orphaned sponsored success receipt retains the durable account barrier', async () => {
    const f = fixture(), entryPoint = '0x' + '33'.repeat(20), operationHash = '0x' + '44'.repeat(32);
    let record = startSubmission(100, ACCOUNT, { to: TARGET, data: iface.encodeFunctionData('action') });
    record = transitionJournal(record, { type: 'prepare', kind: 'user-operation', nonce: '9', computedHash: operationHash, entryPoint });
    record = transitionJournal(record, { type: 'broadcast' });
    transitionJournal(record, { type: 'acknowledge', txHash: TX });
    f.receipt.logs = [{ address: entryPoint, ...USER_OPERATION_EVENTS.encodeEventLog('UserOperationEvent', [operationHash, ACCOUNT, TARGET, '9', true, 1, 2]) }];
    vi.mocked(f.provider.getTransactionReceipt).mockResolvedValue(f.receipt);
    vi.mocked(f.provider.getBlock).mockResolvedValue({ number: 100, hash: '0x' + '55'.repeat(32) } as any);
    const result = await recoverSubmission(100, ACCOUNT, f.provider);
    expect(result.outcome).toMatchObject({ status: 'unknown', code: 'NONCANONICAL_TRANSACTION_INCLUSION' });
    expect(loadSubmission(100, ACCOUNT)?.phase).toBe('submitted');
    expect(() => startSubmission(100, ACCOUNT, { to: TARGET, data: '0x1234' })).toThrow(/Unresolved submission/);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('journal persistence failure prevents the transport from running', async () => {
    const f = fixture(); fs.writeFileSync(path.join(home, 'submissions'), 'storage is unavailable');
    expect((await executeTx(f.contract, 'action', [])).success).toBe(false); expect(f.send).not.toHaveBeenCalled();
  });
  it('dry runs and structural read-only mode never create a send journal', async () => {
    process.env.POP_READONLY = '1';
    const f = fixture(); expect((await executeTx(f.contract, 'action', [], { dryRun: true })).dryRun).toBe(true);
    expect(await executeTx(f.contract, 'action', [])).toMatchObject({ success: false, errorCode: 'USER_REJECTED' });
    expect(f.provider.estimateGas).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled(); expect(loadSubmission(100, ACCOUNT)).toBeUndefined();
  });
  it('serializes concurrent processes without a lease expiry', () => {
    const release = acquireSubmissionLock(100, ACCOUNT);
    expect(() => acquireSubmissionLock(100, ACCOUNT)).toThrow(/running process/);
    release(); const again = acquireSubmissionLock(100, ACCOUNT); again();
  });
  it('only explicitly abandons pre-broadcast records under the account lock', async () => {
    const f = fixture(); let record = startSubmission(100, ACCOUNT, { to: TARGET, data: iface.encodeFunctionData('action') });
    await recoverSubmission(100, ACCOUNT, f.provider, { abandon: true }); expect(loadSubmission(100, ACCOUNT)?.phase).toBe('aborted');
    record = startSubmission(100, ACCOUNT, { to: TARGET, data: iface.encodeFunctionData('action') });
    record = transitionJournal(record, { type: 'prepare', kind: 'transaction', nonce: '7', callKey: record.scope.intentKey, fromBlock: '100' });
    transitionJournal(record, { type: 'broadcast' });
    await expect(recoverSubmission(100, ACCOUNT, f.provider, { abandon: true })).rejects.toThrow(/Broadcast may/);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('recovers an explicit later candidate by canonical exact nonce and call without signing', async () => {
    const f = fixture(); let record = startSubmission(100, ACCOUNT, { to: TARGET, data: iface.encodeFunctionData('action') });
    record = transitionJournal(record, { type: 'prepare', kind: 'transaction', nonce: '7', callKey: record.scope.intentKey, fromBlock: '1' });
    transitionJournal(record, { type: 'broadcast' });
    const result = await recoverSubmission(100, ACCOUNT, f.provider, { candidateTxHash: TX });
    expect(result.outcome.status).toBe('succeeded'); expect(loadSubmission(100, ACCOUNT)?.phase).toBe('succeeded'); expect(f.send).not.toHaveBeenCalled();
  });
});
