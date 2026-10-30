import { test, expect } from 'vitest';
import { ethers } from 'ethers';
import { hashUserOperationV07 } from '../../../src/accounts/userop-v07';
import { createSponsoredExecutionAdapter } from '../../../src/browser/wallet';
const ACCOUNT = `0x${'11'.repeat(20)}`, OTHER = `0x${'22'.repeat(20)}`, TARGET = `0x${'33'.repeat(20)}`, ENTRY = `0x${'44'.repeat(20)}`;
const scope = { chainId: 100, accountAddress: ACCOUNT }, call = { to: TARGET, data: '0x1234', value: '9007199254740993123456789' };
const iface = new ethers.utils.Interface(['function execute(address to,uint256 value,bytes data)']);
const encodeCall = value => iface.encodeFunctionData('execute', [value.to, value.value, value.data]);
const action = { isCurrent: () => true, beforeSign() {} };
function fixture() {
  const state = { scope: { ...scope }, nonce: '7', sends: [], trace: [], refusal: false, returnedHash: null, changed: null, duringSign: null };
  const original = { sender: ACCOUNT, nonce: '7', callData: encodeCall(call), callGasLimit: '100000', verificationGasLimit: '100000', preVerificationGas: '10000', maxFeePerGas: '10', maxPriorityFeePerGas: '1' };
  const ports = {
    async getIdentity() { state.trace.push('identity'); return state.scope; },
    async getNonce() { state.trace.push('nonce'); return state.nonce; }, encodeCall,
    async prepareOperation() { state.trace.push('sponsor'); return { operation: original, entryPoint: ENTRY, fromBlock: '40' }; },
    async signHash(hash) { state.trace.push('sign'); await state.duringSign?.(); return '0x1234'; },
    async dispatchSignedOperation(operation, entryPoint) { state.trace.push('dispatch'); state.sends.push({ operation, entryPoint }); if (state.refusal) throw new Error('RESPONSE_LOST'); return state.returnedHash ?? hashUserOperationV07(operation, entryPoint, scope.chainId); },
    recoveryReaders: { getChainId: async () => 100, getTransactionReceipt: async () => null, getUserOperationReceipt: async () => null },
    subscribeScopeChange(changed) { state.changed = changed; return () => { state.changed = null; }; },
  };
  return { state, original, ports, wallet: createSponsoredExecutionAdapter(ports) };
}
test('explicit sponsored seam preserves exact payable call, hashes immutable operation and dispatches only after final callback', async () => {
  const f = fixture(), prepared = await f.wallet.prepare({ scope, call, ...action });
  f.original.callData = '0x'; f.original.nonce = '99';
  const result = await f.wallet.send(prepared, { ...action, beforeSign() { f.state.trace.push('sign-review'); }, async beforeSend() { f.state.trace.push('review'); } });
  expect(f.state.trace.slice(-2)).toEqual(['review', 'dispatch']); expect(result.userOpHash).toBe(prepared.computedHash);
  expect(f.state.trace.filter(row => row === 'sign-review')).toHaveLength(1); expect(f.state.trace.filter(row => row === 'review')).toHaveLength(1);
  const op = f.state.sends[0].operation; expect(Object.isFrozen(op)).toBe(true); expect(op.nonce).toBe('7');
  expect(iface.decodeFunctionData('execute', op.callData).value.toString()).toBe(call.value);
  expect(JSON.stringify(prepared)).not.toContain('signature'); expect(op.signature).toBe('0x1234');
  await expect(f.wallet.send(prepared, { ...action, beforeSend() {} })).rejects.toMatchObject({ dispatched: false }); expect(f.state.sends).toHaveLength(1);
});
test.each(['account', 'chain', 'event', 'nonce', 'expired', 'cancel', 'storage'])('sponsored %s change refuses before actual handoff', async reason => {
  const f = fixture(), prepared = await f.wallet.prepare({ scope, call, ...action }), controller = new AbortController();
  if (reason === 'account') f.state.scope.accountAddress = OTHER;
  if (reason === 'chain') f.state.scope.chainId = 42161;
  if (reason === 'event') f.state.changed();
  if (reason === 'nonce') f.state.nonce = '8';
  if (reason === 'cancel') controller.abort();
  await expect(f.wallet.send(prepared, { ...action, signal: controller.signal, beforeSend() { if (reason === 'expired' || reason === 'storage') throw new Error(reason); } })).rejects.toMatchObject({ dispatched: false });
  expect(f.state.sends).toHaveLength(0);
});
test('sponsored preparation never signs; identity switch during later biometric signing discards dispatch', async () => {
  const f = fixture(); f.state.duringSign = async () => { f.state.scope.accountAddress = OTHER; };
  const prepared = await f.wallet.prepare({ scope, call, ...action }); expect(f.state.trace).not.toContain('sign');
  await expect(f.wallet.send(prepared, { ...action, beforeSign() {}, beforeSend() {} })).rejects.toMatchObject({ dispatched: false, cause: { message: 'WALLET_SCOPE_CHANGED' } }); expect(f.state.sends).toHaveLength(0);
});
test('signing policy fence runs after unsigned preparation and prevents a signature on refusal', async () => {
  const f = fixture(), prepared = await f.wallet.prepare({ scope, call, ...action }); expect(f.state.trace).not.toContain('sign');
  await expect(f.wallet.send(prepared, { ...action, beforeSign() { throw new Error('POLICY_CHANGED'); }, beforeSend() {} })).rejects.toMatchObject({ dispatched: false });
  expect(f.state.trace).not.toContain('sign'); expect(f.state.sends).toHaveLength(0);
});
test('sponsored direct callers must supply a distinct signing fence; the final send hook is never reused', async () => {
  const f = fixture(), prepared = await f.wallet.prepare({ scope, call, ...action }); let finalHooks = 0;
  await expect(f.wallet.send(prepared, { isCurrent: action.isCurrent, beforeSend() { finalHooks++; } } as never)).rejects.toMatchObject({ dispatched: false, cause: { message: 'SIGNING_REVIEW_REQUIRED' } });
  expect(finalHooks).toBe(0); expect(f.state.trace).not.toContain('sign'); expect(f.state.sends).toHaveLength(0);
});
test.each(['event', 'account'])('sponsored %s revocation during preparation prevents the signing prompt', async reason => {
  const f = fixture();
  f.ports.prepareOperation = async () => {
    if (reason === 'event') f.state.changed(); else f.state.scope.accountAddress = OTHER;
    return { operation: f.original, entryPoint: ENTRY, fromBlock: '40' };
  };
  await expect(f.wallet.prepare({ scope, call, ...action })).rejects.toThrow('SCOPE_CHANGED');
  expect(f.state.trace).not.toContain('sign'); expect(f.state.sends).toHaveLength(0);
});
test('sponsor cannot silently change reviewed payable call data or sender', async () => {
  const f = fixture(); f.original.callData = encodeCall({ ...call, value: '1' });
  await expect(f.wallet.prepare({ scope, call, ...action })).rejects.toThrow('CALL_MISMATCH'); expect(f.state.trace).not.toContain('sign');
});
test.each(['lost', 'hash'])('sponsored %s response keeps computed hash identity and never retries', async mode => {
  const f = fixture(), prepared = await f.wallet.prepare({ scope, call, ...action });
  if (mode === 'lost') f.state.refusal = true; else f.state.returnedHash = `0x${'ff'.repeat(32)}`;
  await expect(f.wallet.send(prepared, { ...action, beforeSend() {} })).rejects.toMatchObject({ dispatched: true, submission: { phase: 'submitting', computedHash: prepared.computedHash, nonce: '7', entryPoint: ENTRY } });
  await expect(f.wallet.send(prepared, { ...action, beforeSend() {} })).rejects.toMatchObject({ dispatched: false }); expect(f.state.sends).toHaveLength(1);
});
test('parallel sponsored sends and changes within final callback cannot double-dispatch', async () => {
  const f = fixture(), prepared = await f.wallet.prepare({ scope, call, ...action }); let reviews = 0;
  const results = await Promise.allSettled([1, 2].map(() => f.wallet.send(prepared, { ...action, async beforeSend() { reviews++; await Promise.resolve(); f.state.changed(); } })));
  expect(results.every(row => row.status === 'rejected')).toBe(true); expect(reviews).toBe(1); expect(f.state.sends).toHaveLength(0);
  f.wallet.dispose(); expect(f.state.changed).toBeNull();
});
