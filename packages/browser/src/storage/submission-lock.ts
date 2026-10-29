import { BrowserLockManager } from './index';

export interface SubmissionLease { (): void | Promise<void>; assert(): void }
const serverLocks = new Set<string>();
/** Web Locks own the live lease. Persistent records describe uncertainty and
 * never turn a timeout into permission to sign again. */
export function createBrowserSubmissionLock(name: string, locks?: BrowserLockManager) {
  return {
    async acquire(): Promise<SubmissionLease> {
      const browser = typeof window !== 'undefined', manager: BrowserLockManager | undefined = locks ?? (browser ? globalThis.navigator?.locks as BrowserLockManager | undefined : undefined);
      if (!manager?.request) {
        if (browser) throw new Error('Account actions need browser coordination. Please use a supported browser.');
        if (serverLocks.has(name)) throw new Error('Another action is already in progress for this account.');
        serverLocks.add(name); let active = true;
        const release = Object.assign(() => { active = false; serverLocks.delete(name); }, {
          assert() { if (!active) throw new Error('This signing session is no longer active.'); },
        });
        return release;
      }
      return new Promise<SubmissionLease>((resolve, reject) => {
        let releaseWait!: () => void;
        const wait = new Promise<void>(done => { releaseWait = done; });
        let request: Promise<void>, active = false;
        const invalidate = () => { active = false; releaseWait(); };
        try {
          request = Promise.resolve(manager.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
            if (!lock) { reject(new Error('Another action is already in progress for this account.')); return; }
            active = true;
            const release = Object.assign(() => { invalidate(); return request; }, {
              assert() { if (!active) throw new Error('This signing session is no longer active.'); },
            });
            resolve(release);
            try { await wait; } finally { active = false; }
          })).then(() => { invalidate(); }, error => {
            // A stolen Web Lock rejects request() without cancelling its running
            // callback. Revoke the already-delivered lease and unblock cleanup.
            invalidate(); reject(error);
          });
        } catch (error) { invalidate(); reject(error); request = Promise.resolve(); }
      });
    },
  };
}
