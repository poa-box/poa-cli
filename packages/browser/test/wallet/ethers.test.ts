import { test, expect } from 'vitest';
import { ethers } from 'ethers';
import { guardedRpcSigner } from '../../src/wallet';
const ACCOUNT = `0x${'11'.repeat(20)}`, TARGET = `0x${'33'.repeat(20)}`, HASH = `0x${'aa'.repeat(32)}`;
const value = '9007199254740993123456789';
function fixture({ initialChange = false } = {}) {
  const state = { listeners: new Map(), trace: [], sends: [], accountsRead: 0 };
  const ethereum = { on(event, listener) { state.listeners.set(event, listener); }, removeListener(event) { state.listeners.delete(event); },
    async request(payload) {
      state.trace.push(payload.method);
      if (payload.method === 'eth_accounts') { if (++state.accountsRead === 1 && initialChange) state.listeners.get('accountsChanged')?.([ACCOUNT]); return [ACCOUNT]; }
      if (payload.method === 'eth_chainId') return '0x64';
      if (payload.method === 'eth_sendTransaction') { state.sends.push(payload.params[0]); return HASH; }
      throw new Error('UNEXPECTED:' + payload.method);
    },
  };
  const signer = new ethers.providers.Web3Provider(ethereum, 'any').getSigner();
  const callbacks = { async beforeSend() { state.trace.push('review'); }, assertCurrent() {}, assertIntent(tx) { expect(ethers.BigNumber.from(tx.value).toString()).toBe(value); }, onDispatch() { state.trace.push('dispatch'); }, onHash(hash) { expect(hash).toBe(HASH); state.trace.push('hash'); } };
  return { state, signer, callbacks };
}
const tx = { from: ACCOUNT, to: TARGET, data: '0x1234', value: ethers.utils.hexValue(ethers.BigNumber.from(value)), chainId: '0x64' };
test('request-local guarded signer retains exact payable wire and real request follows synchronous review guards', async () => {
  const f = fixture(), bridge = await guardedRpcSigner(f.signer, f.callbacks);
  expect(await bridge.signer.provider.send('eth_sendTransaction', [tx])).toBe(HASH);
  expect(f.state.trace.slice(-4)).toEqual(['review', 'dispatch', 'eth_sendTransaction', 'hash']); expect(f.state.sends).toEqual([tx]);
  bridge.dispose(); expect(f.state.listeners.size).toBe(0);
});
test('listeners fence account roundtrip during initial getAddress await', async () => {
  const f = fixture({ initialChange: true });
  await expect(guardedRpcSigner(f.signer, f.callbacks)).rejects.toThrow('account or network changed'); expect(f.state.sends).toHaveLength(0); expect(f.state.listeners.size).toBe(0);
});
test('parallel ethers requests cannot reuse bridge while first final review awaits', async () => {
  const f = fixture(); let reviews = 0;
  const bridge = await guardedRpcSigner(f.signer, { ...f.callbacks, async beforeSend() { reviews++; await Promise.resolve(); } });
  const results = await Promise.allSettled([1, 2].map(() => bridge.signer.provider.send('eth_sendTransaction', [tx])));
  expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1); expect(reviews).toBe(1); expect(f.state.sends).toHaveLength(1); bridge.dispose();
});
test('scope changing in final review prevents actual eth_sendTransaction', async () => {
  const f = fixture(), bridge = await guardedRpcSigner(f.signer, { ...f.callbacks, async beforeSend() { f.state.listeners.get('chainChanged')('0xa4b1'); } });
  await expect(bridge.signer.provider.send('eth_sendTransaction', [tx])).rejects.toThrow('account or network changed'); expect(f.state.sends).toHaveLength(0); bridge.dispose();
});
test('disposing a retained bridge prevents any later dispatch', async () => {
  const f = fixture(), bridge = await guardedRpcSigner(f.signer, f.callbacks);
  bridge.dispose();
  await expect(bridge.signer.provider.send('eth_sendTransaction', [tx])).rejects.toThrow('no longer active');
  expect(f.state.sends).toHaveLength(0);
});
test('disposing while final review awaits prevents dispatch after it resolves', async () => {
  const f = fixture(); let approve, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const bridge = await guardedRpcSigner(f.signer, { ...f.callbacks, async beforeSend() { entered(); await new Promise(resolve => { approve = resolve; }); } });
  const send = bridge.signer.provider.send('eth_sendTransaction', [tx]);
  await started; bridge.dispose(); approve();
  await expect(send).rejects.toThrow('no longer active'); expect(f.state.sends).toHaveLength(0);
});
