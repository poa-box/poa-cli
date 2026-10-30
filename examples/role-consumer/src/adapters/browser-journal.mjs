/** Copyable host storage: IndexedDB supplies atomic CAS; Web Locks excludes all
 * workflows for one account/chain. No timer or localStorage fallback grants ownership. */
const scopeOf = scope => {
  if (!Number.isSafeInteger(scope?.chainId) || scope.chainId <= 0 || !/^0x[\da-f]{40}$/i.test(scope.accountAddress) || /^0x0{40}$/i.test(scope.accountAddress)) throw new Error('INVALID_JOURNAL_SCOPE');
  return { chainId: scope.chainId, accountAddress: scope.accountAddress.toLowerCase() };
};
const forbidden = new Set(['privatekey', 'mnemonic', 'secret', 'signature', 'rawtransaction', 'signedtransaction', 'rawcredentialid', 'authenticatordata', 'clientdatajson', 'useroperation', 'userop']);
function json(value) {
  const visit = value => {
    if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(visit);
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('UNSIGNED_JSON_REQUIRED');
    return Object.fromEntries(Object.keys(value).sort().map(key => {
      if (forbidden.has(key.toLowerCase())) throw new Error('SIGNED_OR_SECRET_DATA_FORBIDDEN');
      return [key, visit(value[key])];
    }));
  };
  const result = JSON.stringify(visit(value));
  if (result.length > 1_000_000) throw new Error('JOURNAL_DATA_LIMIT');
  return JSON.parse(result);
}
const equal = (a, b) => JSON.stringify(json(a)) === JSON.stringify(json(b));

export function createBrowserJournal({ indexedDB = globalThis.indexedDB, locks = globalThis.navigator?.locks,
  databaseName = 'pop-role-consumer-v1' } = {}) {
  if (!indexedDB?.open || !locks?.request) throw new Error('DURABLE_STORAGE_AND_WEB_LOCKS_REQUIRED');
  let opened;
  const open = () => opened ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('accounts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('JOURNAL_OPEN_FAILED'));
    request.onblocked = () => reject(new Error('JOURNAL_OPEN_BLOCKED'));
  });
  return {
    async withAccountLock(input, run) {
      const scope = scopeOf(input), key = `${scope.chainId}:${scope.accountAddress}`;
      return locks.request(`pop-role-account:${key}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw new Error('ACCOUNT_ACTION_IN_PROGRESS');
        const db = await open();
        let active = true;
        const transactions = new Set();
        const assertActive = () => { if (!active) throw new Error('JOURNAL_SESSION_EXPIRED'); };
        const read = () => {
          assertActive();
          return new Promise((resolve, reject) => {
            const tx = db.transaction('accounts', 'readonly'), request = tx.objectStore('accounts').get(key);
            transactions.add(tx);
            let result;
            request.onsuccess = () => { result = request.result ?? null; };
            tx.oncomplete = () => {
              transactions.delete(tx);
              try { assertActive(); if (result && (!equal(result.scope, scope) || result.version !== 1 || !Number.isSafeInteger(result.revision) || result.revision < 0)) throw new Error('JOURNAL_SCOPE_MISMATCH'); resolve(result == null ? null : json(result)); }
              catch (error) { reject(error); }
            };
            tx.onerror = tx.onabort = () => { transactions.delete(tx); reject(new Error('JOURNAL_READ_FAILED')); };
          });
        };
        const compareAndSwap = (expected, data) => {
          assertActive();
          expected = expected == null ? null : json(expected); data = json(data);
          return new Promise((resolve, reject) => {
            const tx = db.transaction('accounts', 'readwrite', { durability: 'strict' });
            if (tx.durability !== 'strict') { tx.abort(); reject(new Error('STRICT_JOURNAL_DURABILITY_REQUIRED')); return; }
            const store = tx.objectStore('accounts'), request = store.get(key);
            transactions.add(tx);
            let next, failure;
            request.onsuccess = () => {
              try {
                assertActive();
                const current = request.result ?? null;
                if (!equal(current, expected)) throw new Error('JOURNAL_COMPARE_AND_SWAP_FAILED');
                if (current && (!equal(current.scope, scope) || current.version !== 1 || !Number.isSafeInteger(current.revision) || current.revision < 0)) throw new Error('JOURNAL_SCOPE_MISMATCH');
                const revision = current == null ? 0 : current.revision + 1;
                if (!Number.isSafeInteger(revision)) throw new Error('JOURNAL_REVISION_LIMIT');
                next = { version: 1, scope, revision, data };
                store.put(next, key);
              } catch (error) { failure = error; tx.abort(); }
            };
            tx.oncomplete = () => { transactions.delete(tx); try { assertActive(); resolve(json(next)); } catch (error) { reject(error); } };
            tx.onerror = tx.onabort = () => { transactions.delete(tx); reject(failure || new Error('JOURNAL_WRITE_FAILED')); };
          });
        };
        try { return await run({ read, compareAndSwap }); }
        finally { active = false; for (const tx of transactions) { try { tx.abort(); } catch { /* Already complete. */ } } }
      });
    },
  };
}
