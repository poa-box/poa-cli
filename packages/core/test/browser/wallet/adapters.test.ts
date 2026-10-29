import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { createSubmissionRecovery, transitionSubmissionRecovery, reconcileSubmissionRecovery, submissionIntentKey } from '../../../src/execute/recovery';
import { createEthersWalletAdapter } from '../../../src/browser/wallet';
import { createBrowserJournal } from '../../../src/browser/storage';
import { browserStorageFixture } from '../storage/browser-storage-fixture';

const ACCOUNT = `0x${'11'.repeat(20)}`, OTHER = `0x${'22'.repeat(20)}`, TARGET = `0x${'33'.repeat(20)}`;
const HASH = `0x${'aa'.repeat(32)}`, BLOCK = `0x${'bb'.repeat(32)}`;
const scope = { chainId: 100, accountAddress: ACCOUNT };
const call = { to: TARGET, data: '0x12345678', value: '9007199254740993123456789' };
const current = () => true;
function walletFixture() {
  const state = { chainId: 100, account: ACCOUNT, nonce: 7, sends: [], order: [], delayIdentity: null, mined: false, sendError: null };
  const transaction = () => ({ hash: HASH, from: ACCOUNT, to: TARGET, data: call.data, value: ethers.BigNumber.from(call.value), nonce: 7, chainId: 100, blockNumber: 41, blockHash: BLOCK });
  const provider = {
    async getNetwork() { state.order.push('chain'); return { chainId: state.chainId }; },
    async getBlockNumber() { return state.mined ? 41 : 40; },
    async getTransactionReceipt() { return state.mined ? { transactionHash: HASH, status: 1, blockNumber: 41, blockHash: BLOCK } : null; },
    async getTransaction() { return state.mined ? transaction() : null; },
    async getBlock(number) { return { number, hash: BLOCK }; },
    async getBlockWithTransactions(number) { return { transactions: state.mined && number === 41 ? [transaction()] : [] }; },
  };
  const signer = { provider,
    async getAddress() { state.order.push('account'); await state.delayIdentity?.(); return state.account; },
    async getTransactionCount() { state.order.push('nonce'); return state.nonce; },
    async estimateGas() { state.order.push('estimate'); return ethers.BigNumber.from(100000); },
    async sendTransaction(tx) { state.order.push('send'); state.sends.push(tx); if (state.sendError) throw state.sendError; return { hash: HASH }; },
  };
  return { state, signer, provider, wallet: createEthersWalletAdapter({ signer, provider, dispatchPopulatedTransaction: tx => signer.sendTransaction(tx) }) };
}

function bridgeFixture(onEstimate = () => {}) {
  const state = { listeners: new Map(), trace: [], sends: [] };
  const ethereum = {
    on(name, listener) { state.listeners.set(name, listener); },
    removeListener(name) { state.listeners.delete(name); },
    async request({ method, params }) {
      state.trace.push(method);
      if (method === 'eth_estimateGas') { await onEstimate(state); return '0x186a0'; }
      if (method === 'eth_sendTransaction') { state.sends.push(params[0]); return HASH; }
      const responses = { eth_chainId: '0x64', eth_accounts: [ACCOUNT], eth_getTransactionCount: '0x7', eth_blockNumber: '0x28' };
      if (!(method in responses)) throw new Error('UNEXPECTED_WALLET_REQUEST:' + method);
      return responses[method];
    },
  };
  return { state, wallet: createEthersWalletAdapter({ ethereum }) };
}

test('injected wallet preserves exact reviewed calldata, native wei and nonce with final callback last', async () => {
  const f = walletFixture(), input = { ...call };
  const prepared = await f.wallet.prepare({ scope, call: input, isCurrent: current });
  input.value = '1'; input.data = '0x';
  assert(Object.isFrozen(prepared)); assert(Object.isFrozen(prepared.call));
  f.state.order.length = 0;
  const result = await f.wallet.send(prepared, { isCurrent: current, beforeSend: async () => { f.state.order.push('review'); } });
  assert.deepEqual(result, { txHash: HASH });
  assert.deepEqual(f.state.sends, [{ ...call, from: ACCOUNT, chainId: 100, nonce: '7', gasLimit: '100000' }]);
  assert.deepEqual(f.state.order.slice(-2), ['review', 'send']);
  await assert.rejects(f.wallet.send(prepared, { isCurrent: current, beforeSend() {} }), error => error.dispatched === false);
  assert.equal(f.state.sends.length, 1);
});

test('parallel sends reserve the prepared handle before the first identity await', async () => {
  const f = walletFixture(), prepared = await f.wallet.prepare({ scope, call, isCurrent: current });
  let reviews = 0;
  const results = await Promise.allSettled([1, 2].map(() => f.wallet.send(prepared, { isCurrent: current, beforeSend: async () => { reviews++; } })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const refused = results.find(result => result.status === 'rejected');
  assert.equal(refused.reason.dispatched, false);
  assert.equal(reviews, 1); assert.equal(f.state.sends.length, 1);
});

test('refused prepared handles also cannot be reused for another review or dispatch', async () => {
  const f = walletFixture(), prepared = await f.wallet.prepare({ scope, call, isCurrent: current });
  let reviews = 0;
  const options = { isCurrent: current, beforeSend: async () => { reviews++; throw new Error('USER_DECLINED'); } };
  await assert.rejects(f.wallet.send(prepared, options));
  await assert.rejects(f.wallet.send(prepared, options));
  assert.equal(reviews, 1); assert.equal(f.state.sends.length, 0);
});

test('actual ethers browser bridge populates exact wire transaction before final review, then directly requests one send', async () => {
  const f = bridgeFixture(), prepared = await f.wallet.prepare({ scope, call, isCurrent: current });
  await f.wallet.send(prepared, { isCurrent: current, beforeSend: async () => { f.state.trace.push('FINAL_REVIEW'); } });
  const final = f.state.trace.indexOf('FINAL_REVIEW');
  assert(f.state.trace.indexOf('eth_estimateGas') < final);
  assert.equal(f.state.trace[final + 1], 'eth_sendTransaction');
  assert.deepEqual(f.state.sends, [{ to: TARGET, from: ACCOUNT, data: call.data, value: ethers.utils.hexValue(ethers.BigNumber.from(call.value)),
    chainId: '0x64', nonce: '0x7', gas: '0x186a0' }]);
  f.wallet.dispose();
});

for (const failure of ['expired', 'abort', 'scope', 'account-event']) test(`actual ethers estimate ${failure} cannot bypass the final wallet guard`, async () => {
  let now = 1000, valid = true, reviews = 0;
  const controller = new AbortController();
  const f = bridgeFixture(async state => {
    await Promise.resolve(); now += 40;
    if (failure === 'abort') controller.abort();
    if (failure === 'scope') valid = false;
    if (failure === 'account-event') state.listeners.get('accountsChanged')([OTHER]);
  });
  const prepared = await f.wallet.prepare({ scope, call, isCurrent: () => valid });
  await assert.rejects(f.wallet.send(prepared, { signal: controller.signal, isCurrent: () => valid, beforeSend: async () => {
    reviews++; if (now > 1030) throw new Error('REVIEW_EXPIRED');
  } }), error => error.dispatched === false);
  assert.equal(reviews, failure === 'expired' ? 1 : 0);
  assert.equal(f.state.sends.length, 0);
  assert(!f.state.trace.includes('eth_sendTransaction'));
  f.wallet.dispose();
});

for (const change of ['account', 'chain', 'nonce']) test(`fresh ${change} mismatch refuses before final review and dispatch`, async () => {
  const f = walletFixture(), prepared = await f.wallet.prepare({ scope, call, isCurrent: current });
  if (change === 'account') f.state.account = OTHER;
  if (change === 'chain') f.state.chainId = 42161;
  if (change === 'nonce') f.state.nonce++;
  let reviews = 0;
  await assert.rejects(f.wallet.send(prepared, { isCurrent: current, beforeSend() { reviews++; } }), error => error.dispatched === false);
  assert.equal(reviews, 0); assert.equal(f.state.sends.length, 0);
});

test('delayed identity reads happen before final review and cannot bridge its freshness window', async () => {
  const f = walletFixture(), prepared = await f.wallet.prepare({ scope, call, isCurrent: current });
  let now = 1000;
  f.state.delayIdentity = async () => { await Promise.resolve(); now += 40; };
  await assert.rejects(f.wallet.send(prepared, { isCurrent: current, beforeSend() { if (now > 1030) throw new Error('REVIEW_EXPIRED'); } }), error => error.dispatched === false);
  assert.equal(f.state.sends.length, 0);
});

test('scope changing while final nonce lookup awaits is rechecked before the final callback', async () => {
  const f = walletFixture(), prepared = await f.wallet.prepare({ scope, call, isCurrent: current });
  f.signer.getTransactionCount = async () => { await Promise.resolve(); f.state.chainId = 42161; return 7; };
  let reviewed = false;
  await assert.rejects(f.wallet.send(prepared, { isCurrent: current, beforeSend() { reviewed = true; } }), error => error.dispatched === false);
  assert.equal(reviewed, false); assert.equal(f.state.sends.length, 0);
});

for (const event of ['accountsChanged', 'chainChanged']) test(`actual ethers EIP-1193 bridge fences ${event} during the final callback`, async () => {
  const listeners = new Map(), requests = [];
  const ethereum = {
    on(name, listener) { listeners.set(name, listener); },
    removeListener(name) { listeners.delete(name); },
    async request({ method }) {
      requests.push(method);
      const responses = { eth_chainId: '0x64', eth_accounts: [ACCOUNT], eth_getTransactionCount: '0x7', eth_blockNumber: '0x28', eth_estimateGas: '0x186a0' };
      if (!(method in responses)) throw new Error('UNEXPECTED_WALLET_REQUEST:' + method);
      return responses[method];
    },
  };
  const wallet = createEthersWalletAdapter({ ethereum }), prepared = await wallet.prepare({ scope, call, isCurrent: current });
  await assert.rejects(wallet.send(prepared, { isCurrent: current, beforeSend() { listeners.get(event)(event === 'accountsChanged' ? [OTHER] : '0xa4b1'); } }), error => error.dispatched === false);
  assert(!requests.includes('eth_sendTransaction'));
  wallet.dispose(); assert.equal(listeners.size, 0);
});

for (const mode of ['consent', 'abort', 'scope']) test(`${mode} refusal during final handoff never dispatches`, async () => {
  const f = walletFixture(), prepared = await f.wallet.prepare({ scope, call, isCurrent: current });
  const controller = new AbortController(); let valid = true;
  await assert.rejects(f.wallet.send(prepared, { signal: controller.signal, isCurrent: () => valid, beforeSend: async () => {
    await Promise.resolve();
    if (mode === 'consent') throw new Error('USER_DECLINED');
    if (mode === 'abort') controller.abort(); else valid = false;
  } }), error => error.dispatched === false);
  assert.equal(f.state.sends.length, 0);
});

test('missing wallet/current-scope capabilities and unsafe native values fail closed', async () => {
  assert.throws(() => createEthersWalletAdapter(), /INJECTED_WALLET/);
  const f = walletFixture();
  assert.throws(() => createEthersWalletAdapter({ signer: f.signer, provider: f.provider }), /EXPLICIT_WALLET_DISPATCH/);
  await assert.rejects(f.wallet.prepare({ scope, call }), /SCOPE_CHANGED/);
  for (const value of [1, '1e18', '-1', '0x01']) await assert.rejects(f.wallet.prepare({ scope, call: { ...call, value }, isCurrent: current }));
  assert.equal(f.state.sends.length, 0);
});

test('IndexedDB CAS commits whole account envelopes and rejects stale writers and expired sessions', async () => {
  const f = browserStorageFixture(), journal = createBrowserJournal(f);
  let saved, expired;
  await journal.withAccountLock(scope, async session => {
    expired = session;
    assert.equal(await session.read(), null);
    saved = await session.compareAndSwap(null, { workflows: { original: { stage: 'creation' } } });
    assert.equal(saved.revision, 0);
    const next = await session.compareAndSwap(saved, { workflows: { original: { stage: 'configuration' } } });
    assert.equal(next.revision, 1);
    await assert.rejects(session.compareAndSwap(saved, { workflows: {} }), /COMPARE_AND_SWAP/);
    assert.deepEqual(await session.read(), next);
  });
  assert.throws(() => expired.read(), /EXPIRED/);
  assert.throws(() => expired.compareAndSwap(saved, {}), /EXPIRED/);
  await createBrowserJournal(f).withAccountLock(scope, async session => assert.equal((await session.read()).data.workflows.original.stage, 'configuration'));
});

test('independent writers cannot own the same account; other account lock is independent', async () => {
  const f = browserStorageFixture(), a = createBrowserJournal(f), b = createBrowserJournal(f);
  let unlock, reached;
  const gate = new Promise(resolve => { unlock = resolve; }), ready = new Promise(resolve => { reached = resolve; });
  const first = a.withAccountLock(scope, async () => { reached(); await gate; });
  await ready;
  await assert.rejects(b.withAccountLock(scope, async () => assert.fail('second owner entered')), /IN_PROGRESS/);
  await b.withAccountLock({ ...scope, accountAddress: OTHER }, async session => assert.equal(await session.read(), null));
  unlock(); await first; assert.equal(f.held.size, 0);
});

test('atomic CAS itself rejects parallel stale updates, rather than depending on a storage read then write', async () => {
  const f = browserStorageFixture();
  await createBrowserJournal(f).withAccountLock(scope, async session => {
    const outcomes = await Promise.allSettled([session.compareAndSwap(null, { workflows: { first: {} } }), session.compareAndSwap(null, { workflows: { second: {} } })]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
    assert.deepEqual((await session.read()).data, { workflows: { first: {} } });
  });
});

test('an unfinished transaction cannot commit after its exclusive session exits', async () => {
  const f = browserStorageFixture(); let unfinished;
  await createBrowserJournal(f).withAccountLock(scope, session => {
    unfinished = session.compareAndSwap(null, { workflows: { old: {} } }).catch(error => error);
  });
  assert.match((await unfinished).message, /WRITE_FAILED/);
  assert.equal(f.rows.size, 0);
});

test('missing browser capabilities, unavailable persistence and signed payloads fail closed', async () => {
  assert.throws(() => createBrowserJournal({ indexedDB: {}, locks: {} }), /DURABLE_STORAGE/);
  const f = browserStorageFixture(); f.faults.write = true;
  await createBrowserJournal(f).withAccountLock(scope, async session => {
    await assert.rejects(session.compareAndSwap(null, { workflows: {} }), /WRITE_FAILED/);
    assert.equal(await session.read(), null);
    for (const key of ['privateKey', 'signature', 'rawCredentialId', 'userOperation']) assert.throws(() => session.compareAndSwap(null, { workflows: { original: { [key]: 'forbidden' } } }), /FORBIDDEN/);
  });
});

test('a browser without strict IndexedDB durability cannot authorize a send barrier', async () => {
  const f = browserStorageFixture(); f.faults.relaxed = true;
  await createBrowserJournal(f).withAccountLock(scope, async session => {
    await assert.rejects(session.compareAndSwap(null, { workflows: {} }), /STRICT_JOURNAL_DURABILITY/);
  });
  assert.equal(f.rows.size, 0);
});

test('failed durable broadcast marker prevents the wallet call', async () => {
  const f = walletFixture(), browser = browserStorageFixture();
  const prepared = await f.wallet.prepare({ scope, call, isCurrent: current });
  browser.faults.write = true;
  await createBrowserJournal(browser).withAccountLock(scope, async session => {
    await assert.rejects(f.wallet.send(prepared, { isCurrent: current, beforeSend: () => session.compareAndSwap(null, { workflows: { original: { stage: 'creation' } } }) }), error => error.dispatched === false);
  });
  assert.equal(f.state.sends.length, 0); assert.equal(browser.rows.size, 0);
});

for (const code of ['RESPONSE_LOST', 'ACTION_REJECTED']) test(`${code} after wallet handoff retains the original durable stage across reload; recovery never resends`, async () => {
  const f = walletFixture(), browser = browserStorageFixture(), key = submissionIntentKey([call]);
  const prepared = await f.wallet.prepare({ scope, call, isCurrent: current });
  let record = createSubmissionRecovery({ ...scope, intentKey: key, sessionKey: key, contextKey: key }, 'owner', 'original');
  record = transitionSubmissionRecovery(record, record, { type: 'prepare', kind: 'transaction', nonce: prepared.nonce, fromBlock: prepared.fromBlock, callKey: key });
  f.state.sendError = Object.assign(new Error('injected wallet refusal or lost response'), { code });
  await createBrowserJournal(browser).withAccountLock(scope, async session => {
    let saved = await session.compareAndSwap(null, { workflows: { original: { stage: 'creation', submission: record, publicationLedger: [{ key: 'proposal', status: 'published', cid: 'synthetic-pointer' }] } } });
    await assert.rejects(f.wallet.send(prepared, { isCurrent: current, beforeSend: async () => {
      record = transitionSubmissionRecovery(record, record, { type: 'broadcast' });
      saved = await session.compareAndSwap(saved, { workflows: { original: { ...saved.data.workflows.original, submission: record } } });
    } }), error => error.dispatched === true);
  });
  const reloadedWallet = walletFixture();
  await createBrowserJournal(browser).withAccountLock(scope, async session => {
    const saved = await session.read(), original = saved.data.workflows.original;
    assert.equal(original.stage, 'creation'); assert.equal(original.submission.phase, 'submitting');
    assert.equal(original.publicationLedger.length, 1);
    assert.equal((await reconcileSubmissionRecovery(original.submission, f.wallet.recoveryReaders)).outcome.status, 'unknown');
    assert.deepEqual(await session.read(), saved);
    f.state.mined = true;
    assert.equal((await reconcileSubmissionRecovery(original.submission, f.wallet.recoveryReaders)).outcome.status, 'succeeded');
    // Only the controller may atomically settle after core's result; the adapter never clears it.
    assert.deepEqual(await session.read(), saved);
  });
  assert.equal(f.state.sends.length, 1); assert.equal(reloadedWallet.state.sends.length, 0);
  assert(!JSON.stringify([...browser.rows.values()]).includes('privateKey'));
});
