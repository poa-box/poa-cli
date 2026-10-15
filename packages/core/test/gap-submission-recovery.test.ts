import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSubmissionRecovery, normalizeSubmissionRecovery, transitionSubmissionRecovery, assertSubmissionFence,
  canAbandonSubmissionRecovery, submissionIntentKey, reconcileSubmissionRecovery, evaluateEoaRecoveryCandidate,
  SubmissionRecoveryRecord, SubmissionRecoveryReaders,
} from '../src/execute/recovery';
import { USER_OPERATION_EVENTS } from '../src/execute/outcome';

const A = `0x${'11'.repeat(20)}`, B = `0x${'22'.repeat(20)}`, EP = `0x${'33'.repeat(20)}`;
const H = `0x${'aa'.repeat(32)}`, TX = `0x${'bb'.repeat(32)}`, OTHER = `0x${'cc'.repeat(32)}`;
const call = { to: B, data: '0x1234', value: '9007199254740993123456789' };
const scope = { chainId: 100, accountAddress: A, intentKey: submissionIntentKey([call]), sessionKey: H, contextKey: OTHER };
const step = (record: SubmissionRecoveryRecord, event: any) => transitionSubmissionRecovery(record, record, event);
function pending(kind: 'transaction' | 'user-operation' = 'transaction') {
  let r = createSubmissionRecovery(scope, 'owner-1', 'attempt-1');
  r = step(r, { type: 'signing' });
  r = step(r, kind === 'transaction' ? { type: 'prepare', kind, nonce: '7', callKey: scope.intentKey, fromBlock: '10' }
    : { type: 'prepare', kind, nonce: '9007199254740993123456789', computedHash: H, entryPoint: EP });
  return step(r, { type: 'broadcast' });
}
const transaction = (overrides = {}) => ({ hash: TX, from: A, nonce: 7, to: B, input: call.data, value: call.value, chainId: 100, blockNumber: 11, blockHash: H, ...overrides });
const event = (success = true, overrides = {}) => ({ address: EP,
  ...USER_OPERATION_EVENTS.encodeEventLog('UserOperationEvent', [H, A, B, '9007199254740993123456789', success, 1, 2]), ...overrides });
const receipt = (status: any = 1, logs: any[] = []) => ({ transactionHash: TX, status, logs, blockNumber: 11, blockHash: H });
function readers(overrides: Partial<SubmissionRecoveryReaders> = {}): SubmissionRecoveryReaders {
  return { getChainId: vi.fn(async () => 100), getTransactionReceipt: vi.fn(async () => receipt()),
    getTransaction: vi.fn(async () => transaction()), getBlock: vi.fn(async () => ({ number: 11, hash: H })),
    getUserOperationReceipt: vi.fn(async () => ({ transactionHash: TX })), getBlockNumber: vi.fn(async () => 12),
    getBlockTransactions: vi.fn(async block => block === '11' ? [transaction()] : []), ...overrides };
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network'); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('durable state and fenced ownership', () => {
  it('keeps intent/session/context exact and canonical, with exact large values and no fee component', () => {
    expect(submissionIntentKey([{ ...call, value: BigInt(call.value) }])).toBe(scope.intentKey);
    expect(submissionIntentKey([{ ...call, value: '1' }])).not.toBe(scope.intentKey);
    expect(submissionIntentKey([call, call])).not.toBe(scope.intentKey);
    expect(() => submissionIntentKey([{ ...call, value: Number.MAX_SAFE_INTEGER + 1 }])).toThrow();
    const r = normalizeSubmissionRecovery({ ...pending(), signature: 'SECRET', rpcUrl: 'SECRET', credential: 'SECRET' } as any);
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(r.scope).toEqual(scope);
  });
  it.each(['intent', 'session', 'context', 'chain', 'account', 'owner', 'attempt', 'revision'])('rejects stale %s before changing state', variant => {
    const r = pending(); const fence = { ...r, scope: { ...r.scope } };
    if (variant === 'intent') fence.scope.intentKey = TX;
    if (variant === 'session') fence.scope.sessionKey = TX;
    if (variant === 'context') fence.scope.contextKey = TX;
    if (variant === 'chain') fence.scope.chainId = 42161;
    if (variant === 'account') fence.scope.accountAddress = B;
    if (variant === 'owner') fence.ownerId = 'owner-2';
    if (variant === 'attempt') fence.attemptId = 'attempt-2';
    if (variant === 'revision') fence.revision++;
    expect(() => assertSubmissionFence(r, fence)).toThrow();
    expect(() => transitionSubmissionRecovery(r, fence, { type: 'acknowledge', txHash: TX })).toThrow();
    expect(r.phase).toBe('submitting');
  });
  it('models reload at every boundary and never permits abort after the broadcast marker', () => {
    let r = createSubmissionRecovery(scope, 'owner-1', 'attempt-1');
    for (const event of [{ type: 'signing' }, { type: 'prepare', kind: 'transaction', nonce: '7', callKey: scope.intentKey }, { type: 'broadcast' }, { type: 'acknowledge', txHash: TX }, { type: 'unresolved' }]) {
      r = normalizeSubmissionRecovery(JSON.parse(JSON.stringify(step(r, event))));
      expect(canAbandonSubmissionRecovery(r)).toBe(['signing', 'prepared'].includes(r.phase));
    }
    expect(() => step(r, { type: 'abort' })).toThrow(/Broadcast/);
    expect(() => step(r, { type: 'prepare', kind: 'transaction', nonce: '8', callKey: scope.intentKey })).toThrow();
    r = step(r, { type: 'settle', status: 'succeeded' });
    expect(() => step(r, { type: 'broadcast' })).toThrow(/terminal/);
  });
});

describe('receipt-only recovery, with bounded exact nonce evidence', () => {
  it.each([1, 0])('recovers a send accepted with a lost EOA hash, status %s', async status => {
    const r = readers({ getTransactionReceipt: vi.fn(async () => receipt(status)) });
    const result = await reconcileSubmissionRecovery(pending(), r);
    expect(result.outcome.status).toBe(status ? 'succeeded' : 'failed');
    expect(r.getBlockTransactions).toHaveBeenCalledTimes(2);
    expect(r.getTransactionReceipt).toHaveBeenCalledWith(TX);
  });
  it('settles a mined different action as replaced; a fee-only replacement preserves success', async () => {
    const r = pending();
    expect(evaluateEoaRecoveryCandidate(r, transaction(), receipt()).status).toBe('succeeded');
    expect(evaluateEoaRecoveryCandidate(r, transaction({ input: '0x5678' }), receipt()).status).toBe('replaced');
    expect(evaluateEoaRecoveryCandidate(r, transaction({ from: B }), receipt()).status).toBe('unknown');
    expect(evaluateEoaRecoveryCandidate(r, transaction({ nonce: 8 }), receipt()).status).toBe('unknown');
    expect(evaluateEoaRecoveryCandidate(r, transaction(), { ...receipt(), transactionHash: OTHER }).status).toBe('unknown');
    const result = await reconcileSubmissionRecovery(r, readers({ getBlockTransactions: async () => [transaction({ to: null, input: '0x' })], getTransaction: async () => transaction({ to: null, input: '0x' }) }));
    expect(result.outcome.status).toBe('replaced');
  });
  it('does not treat pending/dropped/nonces as failure, and stops at the finite bound', async () => {
    const r = readers({ getBlockNumber: async () => 1000000, getBlockTransactions: vi.fn(async () => []) });
    const result = await reconcileSubmissionRecovery(pending(), r, { maxBlocks: 3 });
    expect(result.outcome).toMatchObject({ status: 'unknown', code: 'RECOVERY_WINDOW_EXCEEDED' });
    expect(r.getBlockTransactions).toHaveBeenCalledTimes(3);
    expect(r.getTransactionReceipt).not.toHaveBeenCalled();
    expect((await reconcileSubmissionRecovery(pending(), readers({ getBlockTransactions: async () => [] }))).outcome.code).toBe('NONCE_NOT_MINED');
  });
  it('can recover an original known hash replaced by a mined nonce within the captured window', async () => {
    const record = step(pending(), { type: 'acknowledge', txHash: OTHER });
    const result = await reconcileSubmissionRecovery(record, readers({ getTransactionReceipt: async hash => hash === OTHER ? null : receipt() }));
    expect(result.outcome).toMatchObject({ status: 'succeeded', txHash: TX });
  });
  it.each([
    { from: B }, { nonce: 8 }, { chainId: 42161 }, { chainId: undefined }, { hash: OTHER },
    { blockHash: OTHER }, { blockHash: null }, { blockNumber: 12 }, { blockNumber: null },
    { input: undefined }, { data: '0x5678' }, { input: '0x123' }, { to: undefined }, { value: -1 },
  ])('never settles a known hash with foreign, incomplete or inconsistent identity %j', async overrides => {
    const record = step(pending(), { type: 'acknowledge', txHash: TX });
    const r = readers({ getTransaction: vi.fn(async () => transaction(overrides)) });
    expect((await reconcileSubmissionRecovery(record, r)).outcome.status).toBe('unknown');
    expect(r.getTransaction).toHaveBeenCalledWith(TX);
    expect(r.getBlockTransactions).not.toHaveBeenCalled();
    expect(record.phase).toBe('submitted');
  });
  it.each([1, 0])('binds known hashes to exact call and canonical inclusion, status %s', async status => {
    const record = step(pending(), { type: 'acknowledge', txHash: TX });
    const r = readers({ getTransactionReceipt: vi.fn(async () => receipt(status)) });
    expect((await reconcileSubmissionRecovery(record, r)).outcome.status).toBe(status ? 'succeeded' : 'failed');
    expect(r.getBlock).toHaveBeenNthCalledWith(1, '11');
    expect(r.getBlock).toHaveBeenNthCalledWith(2, '11');
    expect(r.getTransactionReceipt).toHaveBeenCalledTimes(2);
  });
  it.each([{ input: '0x5678' }, { to: A }, { value: '1' }])('classifies exact mined nonce with another call as replaced %j', async overrides => {
    const record = step(pending(), { type: 'acknowledge', txHash: TX });
    expect((await reconcileSubmissionRecovery(record, readers({ getTransaction: async () => transaction(overrides) }))).outcome.status).toBe('replaced');
  });
  it.each(['missing-transaction', 'missing-reader', 'missing-block-reader', 'orphan', 'wrong-block-number', 'reorg', 'receipt-changed', 'chain-changed'])('retains barrier on %s', async variant => {
    const r = readers();
    if (variant === 'missing-transaction') r.getTransaction = async () => null;
    if (variant === 'missing-reader') delete r.getTransaction;
    if (variant === 'missing-block-reader') delete r.getBlock;
    if (variant === 'orphan') r.getBlock = async () => ({ number: 11, hash: OTHER });
    if (variant === 'wrong-block-number') r.getBlock = async () => ({ number: 12, hash: H });
    if (variant === 'reorg') r.getBlock = vi.fn().mockResolvedValueOnce({ number: 11, hash: H }).mockResolvedValueOnce({ number: 11, hash: OTHER });
    if (variant === 'receipt-changed') r.getTransactionReceipt = vi.fn().mockResolvedValueOnce(receipt()).mockResolvedValueOnce(receipt(0));
    if (variant === 'chain-changed') r.getChainId = vi.fn().mockResolvedValueOnce(100).mockResolvedValueOnce(42161);
    const record = step(pending(), { type: 'acknowledge', txHash: TX });
    const saved = JSON.stringify(record);
    expect((await reconcileSubmissionRecovery(record, r)).outcome.status).toBe('unknown');
    expect(JSON.stringify(record)).toBe(saved);
  });
  it('recovers an exact manually supplied hash beyond the bounded prefix without scans or saved identity mutation', async () => {
    const record = pending();
    const r = readers({ getBlockNumber: async () => 1000000, getTransaction: async () => transaction({ blockNumber: 999999 }),
      getTransactionReceipt: async () => ({ ...receipt(), blockNumber: 999999 }), getBlock: async () => ({ number: 999999, hash: H }) });
    const result = await reconcileSubmissionRecovery(record, r, { candidateTxHash: TX });
    expect(result.outcome).toMatchObject({ status: 'succeeded', txHash: TX });
    expect(r.getBlockTransactions).not.toHaveBeenCalled();
    expect(result.record).toEqual(record);
    expect(record.txHash).toBeUndefined();
  });
  it.each(['foreign', 'unmined', 'wrong-receipt'])('keeps a manual %s candidate unresolved without fallback scan', async variant => {
    const r = readers();
    if (variant === 'foreign') r.getTransaction = async () => transaction({ from: B });
    if (variant === 'unmined') r.getTransactionReceipt = async () => null;
    if (variant === 'wrong-receipt') r.getTransactionReceipt = async () => ({ ...receipt(), transactionHash: OTHER });
    expect((await reconcileSubmissionRecovery(pending(), r, { candidateTxHash: TX })).outcome.status).toBe('unknown');
    expect(r.getBlockTransactions).not.toHaveBeenCalled();
  });
  it('rejects invalid manual candidates and never applies the EOA escape hatch to UserOperations', async () => {
    await expect(reconcileSubmissionRecovery(pending(), readers(), { candidateTxHash: 'invalid' })).rejects.toThrow();
    await expect(reconcileSubmissionRecovery(pending('user-operation'), readers(), { candidateTxHash: TX })).rejects.toThrow();
  });
  it.each(['wrong-chain', 'wrong-hash', 'invalid-status', 'missing-provider', 'read-error'])('retains %s as unknown without transport writes', async variant => {
    const record = pending(); const r = readers();
    if (variant === 'wrong-chain') r.getChainId = async () => 42161;
    if (variant === 'wrong-hash') r.getTransactionReceipt = async () => ({ ...receipt(), transactionHash: OTHER });
    if (variant === 'invalid-status') r.getTransactionReceipt = async () => receipt(2);
    if (variant === 'missing-provider') delete r.getBlockTransactions;
    if (variant === 'read-error') r.getBlockTransactions = async () => { throw new Error('offline'); };
    expect((await reconcileSubmissionRecovery(record, r)).outcome.status).toBe('unknown');
  });
  it.each([true, false])('recovers only the exact deterministic operation hash/sender/nonce, success %s', async success => {
    const r = readers({ getTransactionReceipt: async () => receipt(1, [event(success)]) });
    const result = await reconcileSubmissionRecovery(pending('user-operation'), r);
    expect(result.outcome).toMatchObject({ status: success ? 'succeeded' : 'failed', sender: A, nonce: '9007199254740993123456789', userOpHash: H });
    expect(r.getUserOperationReceipt).toHaveBeenCalledWith(H);
    expect(r.getBlockTransactions).not.toHaveBeenCalled();
  });
  it.each(['dropped', 'replaced', 'wrong-sender', 'outer-revert-no-event'])('keeps UserOp %s unresolved rather than inventing success or permitting retry', async variant => {
    const r = readers({ getTransactionReceipt: async () => receipt(variant === 'outer-revert-no-event' ? 0 : 1,
      variant === 'wrong-sender' ? [event(true, USER_OPERATION_EVENTS.encodeEventLog('UserOperationEvent', [H, B, B, '9007199254740993123456789', true, 1, 2]))]
        : variant === 'replaced' ? [event(true, { topics: [USER_OPERATION_EVENTS.getEventTopic('UserOperationEvent'), OTHER] })] : []) });
    if (variant === 'dropped') r.getUserOperationReceipt = async () => null;
    expect((await reconcileSubmissionRecovery(pending('user-operation'), r)).outcome.status).toBe('unknown');
  });
});
