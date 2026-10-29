import { test, expect } from 'vitest';
import { createBrowserJournal, createBrowserSubmissionLock } from '../../src/storage';
import { browserStorageFixture } from './browser-storage-fixture';
const scope = { chainId: 100, accountAddress: `0x${'11'.repeat(20)}` };
const deferred = () => {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
};
function revocableLocks() {
  const revocation = deferred(); let callback;
  return { revoke() { revocation.reject(new DOMException('Lock stolen', 'AbortError')); }, get callback() { return callback; },
    request(_name, _options, run) { callback = Promise.resolve(run({ name: 'account' })); return Promise.race([callback, revocation.promise]); },
  };
}
test('stolen submission lock immediately revokes delivered lease and release still fulfills', async () => {
  const locks = revocableLocks(), lease = await createBrowserSubmissionLock('revoked-account', locks).acquire(); lease.assert();
  locks.revoke(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(() => lease.assert()).toThrow('no longer active');
  await expect(lease()).resolves.toBeUndefined(); await expect(locks.callback).resolves.toBeUndefined();
});
test('normal submission release invalidates lease and settles without rejecting', async () => {
  const fixture = browserStorageFixture(), lock = createBrowserSubmissionLock('normal-release', fixture.locks), lease = await lock.acquire();
  lease.assert(); await expect(lease()).resolves.toBeUndefined(); expect(() => lease.assert()).toThrow('no longer active');
  const next = await lock.acquire(); next.assert(); await next();
});
test('journal lock loss revokes session while original callback is still awaiting', async () => {
  const fixture = browserStorageFixture(), locks = revocableLocks(), entered = deferred(), resume = deferred(); let captured;
  const journal = createBrowserJournal({ indexedDB: fixture.indexedDB, locks });
  const work = journal.withAccountLock(scope, async session => {
    captured = session; entered.resolve(); await resume.promise;
    return session.compareAndSwap(null, { stage: 'after-revocation' });
  });
  await entered.promise; captured.assertActive(); locks.revoke();
  await expect(work).rejects.toMatchObject({ name: 'AbortError' }); expect(() => captured.assertActive()).toThrow('SESSION_EXPIRED');
  resume.resolve(); await expect(locks.callback).rejects.toThrow('SESSION_EXPIRED'); expect(fixture.rows.size).toBe(0);
});
test('journal revocation aborts any currently pending IndexedDB transactions', async () => {
  const locks = revocableLocks(), entered = deferred(), resume = deferred(); let aborts = 0, pending;
  const indexedDB = { open() {
    const request = {};
    queueMicrotask(() => { request.result = { transaction() {
      const tx = { durability: 'strict', objectStore() { return { get() { return {}; }, put() { throw new Error('must not commit'); } }; },
        abort() { aborts++; queueMicrotask(() => tx.onabort?.()); },
      }; return tx;
    } }; request.onsuccess(); }); return request;
  } };
  const journal = createBrowserJournal({ indexedDB, locks });
  const work = journal.withAccountLock(scope, async session => {
    pending = session.compareAndSwap(null, { stage: 'submitting' }).catch(error => error);
    entered.resolve(); await resume.promise; return pending;
  });
  await entered.promise; locks.revoke(); await expect(work).rejects.toMatchObject({ name: 'AbortError' });
  expect(aborts).toBe(1); expect((await pending).message).toBe('JOURNAL_WRITE_FAILED'); resume.resolve(); await locks.callback;
});
test('request revocation while opening cannot later reactivate a journal callback', async () => {
  const locks = revocableLocks(), request = {}, entered = deferred(); let runs = 0;
  const indexedDB = { open() { entered.resolve(); return request; } };
  const journal = createBrowserJournal({ indexedDB, locks });
  const work = journal.withAccountLock(scope, async () => { runs++; }); await entered.promise;
  locks.revoke(); await expect(work).rejects.toMatchObject({ name: 'AbortError' });
  request.result = {}; request.onsuccess(); await expect(locks.callback).rejects.toThrow('SESSION_EXPIRED'); expect(runs).toBe(0);
});
