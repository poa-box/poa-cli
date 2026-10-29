import { normalizeWalletScope, WalletScope } from '../wallet';
export { createBrowserSubmissionLock } from './submission-lock';
export type { SubmissionLease } from './submission-lock';
export { createPasskeyCredentialStore, pendingEnrollmentKey, enrollmentTarget } from '../passkeys/storage';
export type { CredentialRecord, EnrollmentSource, PendingEnrollment, PublicStoragePort } from '../passkeys/storage';

export type UnsignedJson = null | string | boolean | number | UnsignedJson[] | { [key: string]: UnsignedJson };
export interface JournalEnvelope<T = unknown> { version: 1; scope: WalletScope; revision: number; data: T }
export interface JournalSession<T = unknown> {
  /** Synchronous final-boundary fence, including revocation of the Web Lock. */
  assertActive(): void;
  read(): Promise<JournalEnvelope<T> | null>;
  compareAndSwap(expected: JournalEnvelope<T> | null, data: T): Promise<JournalEnvelope<T>>;
}
export interface BrowserJournal<T = unknown> { withAccountLock<R>(scope: WalletScope, run: (session: JournalSession<T>) => R | Promise<R>): Promise<R> }
export interface BrowserLockManager {
  request<T>(name: string, options: { mode: 'exclusive'; ifAvailable: true }, callback: (lock: unknown | null) => Promise<T>): Promise<T>;
}
const forbidden = new Set(['privatekey', 'mnemonic', 'secret', 'signature', 'rawtransaction', 'signedtransaction', 'rawcredentialid', 'authenticatordata', 'clientdatajson', 'useroperation', 'userop']);
/** The journal stores only unsigned JSON. It never retains WebAuthn assertions,
 * signed operations, wallet keys, or opaque class instances. */
export function unsignedJournalJson<T>(value: T): T {
  const ancestors = new Set<object>();
  const visit = (row: unknown): UnsignedJson => {
    if (row === null || typeof row === 'string' || typeof row === 'boolean') return row;
    if (typeof row === 'number' && Number.isFinite(row)) return row;
    if (!row || typeof row !== 'object' || ancestors.has(row)) throw new Error('UNSIGNED_JSON_REQUIRED');
    ancestors.add(row);
    try {
      if (Array.isArray(row)) return row.map(visit);
      if (Object.getPrototypeOf(row) !== Object.prototype) throw new Error('UNSIGNED_JSON_REQUIRED');
      return Object.fromEntries(Object.keys(row).sort().map(key => {
        if (forbidden.has(key.toLowerCase())) throw new Error('SIGNED_OR_SECRET_DATA_FORBIDDEN');
        return [key, visit((row as Record<string, unknown>)[key])];
      }));
    } finally { ancestors.delete(row); }
  };
  const result = JSON.stringify(visit(value));
  if (result.length > 1_000_000) throw new Error('JOURNAL_DATA_LIMIT');
  return JSON.parse(result) as T;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(unsignedJournalJson(a)) === JSON.stringify(unsignedJournalJson(b));

/** IndexedDB supplies atomic CAS; Web Locks excludes all workflows for one
 * account/chain. No timer or localStorage fallback grants ownership. */
export function createBrowserJournal<T = unknown>({ indexedDB = globalThis.indexedDB,
  locks = globalThis.navigator?.locks as BrowserLockManager | undefined,
  databaseName = 'pop-browser-v1', lockPrefix = 'pop-browser-account:' }: {
    indexedDB?: IDBFactory; locks?: BrowserLockManager; databaseName?: string; lockPrefix?: string;
  } = {}): BrowserJournal<T> {
  if (!indexedDB?.open || !locks?.request) throw new Error('DURABLE_STORAGE_AND_WEB_LOCKS_REQUIRED');
  if (!databaseName || !lockPrefix) throw new Error('JOURNAL_NAMESPACE_REQUIRED');
  const factory = indexedDB, lockManager = locks;
  let opened: Promise<IDBDatabase> | undefined;
  const open = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('accounts'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('JOURNAL_OPEN_FAILED'));
    request.onblocked = () => reject(new Error('JOURNAL_OPEN_BLOCKED'));
  });
  return {
    async withAccountLock(input, run) {
      const scope = normalizeWalletScope(input), key = `${scope.chainId}:${scope.accountAddress}`;
      let active = true;
      const transactions = new Set<IDBTransaction>();
      const assertActive = () => { if (!active) throw new Error('JOURNAL_SESSION_EXPIRED'); };
      const invalidate = () => {
        active = false;
        for (const tx of transactions) { try { tx.abort(); } catch { /* Already complete. */ } }
      };
      try { return await lockManager.request(`${lockPrefix}${key}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw new Error('ACCOUNT_ACTION_IN_PROGRESS');
        assertActive();
        const db = await open();
        assertActive();
        const valid = (result: JournalEnvelope<T>) => {
          if (!equal(result.scope, scope) || result.version !== 1 || !Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error('JOURNAL_SCOPE_MISMATCH');
        };
        const read = (): Promise<JournalEnvelope<T> | null> => {
          assertActive();
          return new Promise((resolve, reject) => {
            const tx = db.transaction('accounts', 'readonly'), request = tx.objectStore('accounts').get(key);
            transactions.add(tx);
            let result: JournalEnvelope<T> | null = null;
            request.onsuccess = () => { result = request.result ?? null; };
            tx.oncomplete = () => {
              transactions.delete(tx);
              try { assertActive(); if (result) valid(result); resolve(result === null ? null : unsignedJournalJson(result)); }
              catch (error) { reject(error); }
            };
            tx.onerror = tx.onabort = () => { transactions.delete(tx); reject(new Error('JOURNAL_READ_FAILED')); };
          });
        };
        const compareAndSwap = (expected: JournalEnvelope<T> | null, data: T): Promise<JournalEnvelope<T>> => {
          assertActive(); expected = expected === null ? null : unsignedJournalJson(expected); data = unsignedJournalJson(data);
          return new Promise((resolve, reject) => {
            const tx = db.transaction('accounts', 'readwrite', { durability: 'strict' });
            if (tx.durability !== 'strict') { tx.abort(); reject(new Error('STRICT_JOURNAL_DURABILITY_REQUIRED')); return; }
            const store = tx.objectStore('accounts'), request = store.get(key);
            transactions.add(tx);
            let next: JournalEnvelope<T>, failure: unknown;
            request.onsuccess = () => {
              try {
                assertActive();
                const current: JournalEnvelope<T> | null = request.result ?? null;
                if (!equal(current, expected)) throw new Error('JOURNAL_COMPARE_AND_SWAP_FAILED');
                if (current) valid(current);
                const revision = current === null ? 0 : current.revision + 1;
                if (!Number.isSafeInteger(revision)) throw new Error('JOURNAL_REVISION_LIMIT');
                next = { version: 1, scope, revision, data }; store.put(next, key);
              } catch (error) { failure = error; tx.abort(); }
            };
            tx.oncomplete = () => { transactions.delete(tx); try { assertActive(); resolve(unsignedJournalJson(next)); } catch (error) { reject(error); } };
            tx.onerror = tx.onabort = () => { transactions.delete(tx); reject(failure || new Error('JOURNAL_WRITE_FAILED')); };
          });
        };
        try { return await run({ assertActive, read, compareAndSwap }); }
        finally { invalidate(); }
      }); } finally {
        // request() can reject because another caller steals the lock while run
        // is still awaiting. Its callback is not cancelled by the browser.
        invalidate();
      }
    },
  };
}
