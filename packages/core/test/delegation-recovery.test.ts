import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
const state = vi.hoisted(() => ({ chain: 100, sent: vi.fn(), signed: vi.fn() }));
vi.mock('viem', async original => ({ ...await original<any>(),
  createPublicClient: () => ({ getChainId: async () => state.chain, getTransactionCount: async () => 7, getBlockNumber: async () => 100n }),
  createWalletClient: () => ({ signAuthorization: async (input: any) => { state.signed(input); return { address: input.contractAddress, chainId: input.chainId, nonce: input.nonce, yParity: 1, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) }; },
    sendTransaction: state.sent }),
}));
vi.mock('viem/accounts', () => ({ privateKeyToAccount: () => ({ address: '0x' + '33'.repeat(20) }) }));
import { delegateEOA, EOA_DELEGATION } from '../src/execute/sponsored';
import { createSubmissionRecovery, transitionSubmissionRecovery, submissionIntentKey, submissionAuthorizationKey, evaluateEoaRecoveryCandidate, normalizeSubmissionRecovery, reconcileSubmissionRecovery } from '../src/execute/recovery';
const ACCOUNT = '0x' + '33'.repeat(20), HASH = '0x' + '44'.repeat(32), TX = '0x' + '55'.repeat(32);
const authorization = { chainId: 100, address: EOA_DELEGATION, nonce: 8, yParity: 1, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) };
beforeEach(() => { state.chain = 100; state.sent.mockReset().mockResolvedValue(TX); state.signed.mockReset(); });
describe('EIP-7702 delegation submission identity', () => {
  it('pins outer nonce and signed authorization before dispatch and acknowledges before returning', async () => {
    const prepared = vi.fn((identity: any) => { expect(state.sent).not.toHaveBeenCalled(); expect(identity).toMatchObject({ chainId: 100, account: ACCOUNT, nonce: '7', fromBlock: '100', authorizationList: [authorization] }); });
    const submitted = vi.fn();
    expect(await delegateEOA(('0x' + '66'.repeat(32)) as any, 'http://offline.invalid', { onPrepared: prepared, onSubmitted: submitted })).toBe(TX);
    expect(state.signed).toHaveBeenCalledWith({ contractAddress: EOA_DELEGATION, chainId: 100, nonce: 8, executor: 'self' });
    expect(state.sent).toHaveBeenCalledWith(expect.objectContaining({ nonce: 7, to: ACCOUNT, data: '0x', value: 0n })); expect(submitted).toHaveBeenCalledWith(TX);
  });
  it('failed persistence or a different RPC chain causes zero dispatches', async () => {
    await expect(delegateEOA(('0x' + '66'.repeat(32)) as any, undefined, { onPrepared: () => { throw new Error('disk unavailable'); } })).rejects.toThrow('disk unavailable');
    expect(state.sent).not.toHaveBeenCalled(); state.chain = 42161;
    await expect(delegateEOA(('0x' + '66'.repeat(32)) as any)).rejects.toThrow('chain mismatch'); expect(state.sent).not.toHaveBeenCalled();
  });
  it('canonical recovery accepts equivalent padded and quantity signature encodings but rejects another signature', async () => {
    const padded = { ...authorization, r: '0x' + '00'.repeat(31) + '01', s: '0x' + '00'.repeat(31) + '02' };
    const quantity = { ...padded, r: '0x1', s: '0x02' };
    expect(submissionAuthorizationKey([quantity])).toBe(submissionAuthorizationKey([padded]));
    const callKey = submissionIntentKey([{ to: ACCOUNT, data: '0x' }]);
    let record = createSubmissionRecovery({ chainId: 100, accountAddress: ACCOUNT, intentKey: callKey, sessionKey: HASH, contextKey: HASH }, 'owner', 'attempt');
    record = transitionSubmissionRecovery(record, record, { type: 'prepare', kind: 'transaction', nonce: '7', callKey, authorizationKey: submissionAuthorizationKey([padded]) });
    record = transitionSubmissionRecovery(record, record, { type: 'broadcast' });
    record = transitionSubmissionRecovery(record, record, { type: 'acknowledge', txHash: TX });
    const tx = { hash: TX, from: ACCOUNT, to: ACCOUNT, input: '0x', value: '0', nonce: 7, chainId: 100, blockNumber: 100, blockHash: HASH, authorizationList: [quantity] };
    const receipt = { transactionHash: TX, status: 1, blockNumber: 100, blockHash: HASH };
    const readers = { getChainId: async () => 100, getTransaction: async () => tx, getTransactionReceipt: async () => receipt, getBlock: async () => ({ number: 100, hash: HASH }) };
    expect((await reconcileSubmissionRecovery(record, readers)).outcome.status).toBe('succeeded');
    tx.authorizationList = [{ ...quantity, s: '0x3' }];
    expect((await reconcileSubmissionRecovery(record, readers)).outcome.status).toBe('replaced');
    for (const invalid of ['0x', '0x0', '0x' + 'ff'.repeat(32), '0x1' + '00'.repeat(32)]) {
      expect(() => submissionAuthorizationKey([{ ...padded, r: invalid }])).toThrow('signature scalar');
    }
  });
  it('canonical recovery distinguishes exact authorization from an identical self-call carrying another permission', () => {
    const callKey = submissionIntentKey([{ to: ACCOUNT, data: '0x' }]);
    let record = createSubmissionRecovery({ chainId: 100, accountAddress: ACCOUNT, intentKey: callKey, sessionKey: HASH, contextKey: HASH }, 'owner', 'attempt');
    record = transitionSubmissionRecovery(record, record, { type: 'prepare', kind: 'transaction', nonce: '7', callKey, authorizationKey: submissionAuthorizationKey([authorization]) });
    record = transitionSubmissionRecovery(record, record, { type: 'broadcast' });
    const tx = { hash: TX, from: ACCOUNT, to: ACCOUNT, input: '0x', value: '0', nonce: 7, chainId: 100, blockNumber: 100, blockHash: HASH, authorizationList: [authorization] };
    const receipt = { transactionHash: TX, status: 1, blockNumber: 100, blockHash: HASH };
    expect(evaluateEoaRecoveryCandidate(record, tx, receipt).status).toBe('succeeded');
    expect(evaluateEoaRecoveryCandidate(record, { ...tx, authorizationList: [{ ...authorization, address: ACCOUNT }] }, receipt).status).toBe('replaced');
    expect(evaluateEoaRecoveryCandidate(record, { ...tx, authorizationList: undefined }, receipt)).toMatchObject({ status: 'unknown', code: 'TRANSACTION_AUTHORIZATION_UNAVAILABLE' });
    const serialized = JSON.stringify(normalizeSubmissionRecovery({ ...record, authorizationList: [authorization] } as any));
    expect(serialized).not.toContain(authorization.r); expect(serialized).not.toContain(authorization.s);
    expect(submissionAuthorizationKey([{ ...authorization, chainId: '0x64', nonce: '0x8', yParity: '0x1' }])).toBe(record.authorizationKey);
  });
});
