import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { executeContractTx } from '../src/execute/ethers';
import { isolateUserOperationReceiptLogs } from '../src/reads/provenance';
import { ENTRY_POINT } from '../src/accounts/constants';
import { fixture, operation, operationIdentity, event, account, voting, HV, OTHER, TX, ORG, META } from './fixtures/bundled-operation-provenance';
const signer = new ethers.Wallet('0x' + '11'.repeat(32));
const configuration = { privateKey: signer.privateKey as `0x${string}`, orgId: ORG as `0x${string}`, hatId: 1n };
function bundle(position = 1, value = '0') {
  const f = fixture();
  const data = f.txs[TX].data, args = [...voting.parseTransaction({ data }).args];
  const selected = operation(signer.address, '9', HV, data, true, [event(voting, OTHER, 'NewProposal', [666, f.title, META, 2, 1600, 1000]), ...f.creationLogs]);
  selected.userOp.callData = account.encodeFunctionData('execute', [HV, value, data]);
  const other = (nonce: string) => operation(signer.address, nonce, HV, data, true, [event(voting, HV, 'NewProposal', [999, f.title, META, 2, 1600, 1000])]);
  const operations = [other('10'), other('11')]; operations.splice(position, 0, selected);
  f.bundle(TX, operations, [event(voting, HV, 'NewProposal', [888, f.title, META, 2, 1600, 1000])], [event(voting, HV, 'NewProposal', [777, f.title, META, 2, 1600, 1000])]);
  f.receipts[TX].gasUsed = ethers.BigNumber.from(7);
  const send = vi.fn(async () => ({ txHash: TX as `0x${string}`, userOpHash: operationIdentity(selected).userOpHash as `0x${string}` }));
  const direct = vi.fn();
  const provider = { getNetwork: async () => ({ chainId: 100 }), getTransaction: async () => f.txs[TX], getTransactionReceipt: async () => f.receipts[TX] };
  const contract = { address: HV, interface: voting, provider, signer: { getAddress: async () => signer.address },
    estimateGas: { createProposal: async () => ethers.BigNumber.from(21000) }, createProposal: direct } as unknown as ethers.Contract;
  const adapter = { entryPoint: ENTRY_POINT as `0x${string}`, isDelegated: async () => true, sendSponsored: send };
  return { f, selected, contract, adapter, args, direct, send };
}
beforeEach(() => vi.stubGlobal('fetch', () => { throw new Error('Offline tests prohibit network'); }));
afterEach(() => vi.unstubAllGlobals());
describe('sponsored account binding and event isolation', () => {
  it('rejects a different configured wallet before loading or using a sponsored adapter', async () => {
    const f = bundle(), loader = vi.fn(async () => f.adapter);
    const result = await executeContractTx(f.contract, 'createProposal', f.args, { sponsored: { ...configuration, privateKey: ('0x' + '22'.repeat(32)) as `0x${string}` }, sponsoredAdapterLoader: loader });
    expect(result).toMatchObject({ success: false, errorCode: 'USER_REJECTED' });
    expect(result.error).toContain('does not match'); expect(loader).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.direct).not.toHaveBeenCalled();
  });
  it('an injected adapter cannot report another account under the expected operation hash', async () => {
    const f = bundle(), identity = operationIdentity(f.selected);
    const terminal = f.f.receipts[TX].logs.find((log: any) => log.topics[1] === identity.userOpHash);
    terminal.topics[2] = ethers.utils.hexZeroPad(OTHER, 32);
    const result = await executeContractTx(f.contract, 'createProposal', f.args, { sponsored: configuration, sponsoredAdapter: f.adapter });
    expect(result.success).toBe(false); expect(result.outcome).toMatchObject({ status: 'unknown', code: 'TARGET_IDENTITY_MISMATCH' });
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.direct).not.toHaveBeenCalled(); expect(result.logs).toBeUndefined();
  });
  it.each([0, 1, 2])('returns only the selected create ID at bundle position %i and preserves explicit outer evidence', async position => {
    const f = bundle(position), result = await executeContractTx(f.contract, 'createProposal', f.args, { sponsored: configuration, sponsoredAdapter: f.adapter });
    expect(result.success).toBe(true); expect(result.logScope).toBe('operation');
    expect(result.logs?.filter(log => log.name === 'NewProposal').map(log => log.args.id.toString())).toEqual(['7']);
    expect(result.receipt?.logs).toHaveLength(2); expect(result.outerReceipt).toBe(f.f.receipts[TX]);
    expect(result.outerReceipt!.logs.length).toBeGreaterThan(result.receipt!.logs.length);
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.direct).not.toHaveBeenCalled();
  });
  it('isolates valid nonzero native call value without relaxing strict governance provenance', async () => {
    const f = bundle(1, '9007199254740993');
    const logs = isolateUserOperationReceiptLogs({ transaction: f.f.txs[TX], receipt: f.f.receipts[TX], chainId: 100, expected: { ...operationIdentity(f.selected), target: HV } });
    expect(logs).toHaveLength(2);
  });
  it.each(['missing-before', 'duplicate-event', 'missing-transaction', 'foreign-event'])('unknown %s boundaries never yield inferred created IDs', async mode => {
    const f = bundle();
    if (mode === 'missing-before') f.f.receipts[TX].logs.splice(1, 1);
    if (mode === 'duplicate-event') f.f.receipts[TX].logs.splice(2, 0, { ...f.f.receipts[TX].logs[2] });
    if (mode === 'foreign-event') f.f.receipts[TX].logs.find((log: any) => log.topics[0] === '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f').address = OTHER;
    if (mode === 'missing-transaction') (f.contract.provider as any).getTransaction = async () => null;
    const result = await executeContractTx(f.contract, 'createProposal', f.args, { sponsored: configuration, sponsoredAdapter: f.adapter });
    expect(result.success).toBe(true); expect(result.logScope).toBe('unknown'); expect(result.logs).toEqual([]); expect(result.receipt?.logs).toEqual([]);
    expect(result.outerReceipt).toBe(f.f.receipts[TX]);
  });
});
