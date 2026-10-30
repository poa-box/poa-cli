import { test, expect } from 'vitest';
import { createAccountSession } from '../../../src/browser/session';

const scope = { chainId: 100, accountAddress: `0x${'11'.repeat(20)}` };
test('unresolved identity and saved hints cannot create a signing session', () => {
  const session = createAccountSession();
  expect(() => session.capture()).toThrow('RESOLVED_ACCOUNT_REQUIRED');
  expect(session.scope).toBeNull();
});
test('account/chain switching invalidates old guards including round trips', () => {
  const session = createAccountSession({ initialScope: scope }), first = session.capture();
  session.update({ ...scope }); expect(first.isCurrent()).toBe(true);
  session.update({ ...scope, chainId: 42161 }); session.update(scope);
  expect(first.signal.aborted).toBe(true); expect(first.isCurrent()).toBe(false);
  expect(() => first.guard()).toThrow('ACCOUNT_SESSION_CHANGED');
  const next = session.capture(); next.guard(); session.clear();
  expect(next.isCurrent()).toBe(false); expect(next.signal.aborted).toBe(true);
});
