import { test, expect } from 'vitest';
import { createPasskeyCredentialStore } from '../../../src/browser/storage';
import { createAccountSession } from '../../../src/browser/session';
const ACCOUNT = `0x${'11'.repeat(20)}`, OTHER = `0x${'22'.repeat(20)}`, REGISTRY = `0x${'33'.repeat(20)}`, FACTORY = `0x${'44'.repeat(20)}`;
function fixture() {
  const rows = new Map(), state = { fail: false, events: 0 };
  const storage = { getItem: key => rows.get(key) ?? null, setItem(key, value) { if (state.fail) throw new Error('QUOTA'); rows.set(key, value); }, removeItem(key) { rows.delete(key); } };
  const store = createPasskeyCredentialStore({ storage, onEnrollment() { state.events++; }, now: () => 123, randomUUID: () => 'restart-id' });
  return { rows, state, storage, store };
}
const source = { credentialChainId: 100, registryAddress: REGISTRY, factoryAddress: FACTORY, targetAddress: REGISTRY, orgId: 'org', mode: 'solidarity' };
const data = { ...source, credentialId: 'public-credential-digest', accountAddress: ACCOUNT, flow: 'vouch', username: 'member' };
test('historical credentials are public hints and cannot resolve session identity', () => {
  const f = fixture(); f.store.savePasskeyCredential(data);
  expect(f.rows.has('poa-passkey-credentials')).toBe(true); expect(f.store.getLastUsedCredential()).toMatchObject({ ...data, savedAt: 123 });
  const unresolved = createAccountSession(); expect(() => unresolved.capture()).toThrow('RESOLVED_ACCOUNT_REQUIRED');
  f.store.clearAllCredentials(); expect(f.store.getLastUsedCredential()).toBeNull();
});
test('pending source qualification, exact compare, and recovery retain the original pointers', () => {
  const f = fixture(); f.store.savePendingCredential(data); const pending = f.store.readPendingEnrollment(source)!;
  expect(pending.provenance).toBe('matched'); expect(f.state.events).toBe(1);
  expect(f.store.requirePendingEnrollment(source, { flow: 'vouch', username: 'member' })).toEqual(pending.credential);
  expect(() => f.store.requirePendingEnrollment({ ...source, factoryAddress: OTHER })).toThrow('earlier account');
  const record = { authorization: 'recovery-only', activationAllowed: false, audit: { legacyRecordId: pending.key, recoveryId: 'recovery-id' } };
  f.store.saveEnrollmentMigration(record, pending); expect(f.store.readEnrollmentMigration('recovery-id')).toEqual(record);
  expect(f.store.saveEnrollmentRestart({ pending, accountAddress: OTHER, source })).toBe('restart-id');
  expect(f.store.readPendingEnrollment(source)).toEqual(pending);
  f.store.savePendingCredential({ ...data, username: 'changed' });
  expect(() => f.store.removePendingCredential(ACCOUNT, source, pending)).toThrow('changed');
  expect(() => f.store.saveEnrollmentMigration(record, pending)).toThrow('changed');
});
test('corruption and unavailable pending persistence block new credential creation records', () => {
  const f = fixture(); f.rows.set('poa-passkey-pending', '{');
  expect(() => f.store.readPendingEnrollment(source)).toThrow('could not be read');
  expect(() => f.store.savePendingCredential(data)).toThrow('could not be read');
  f.rows.clear(); f.state.fail = true;
  expect(() => f.store.savePendingCredential(data)).toThrow('QUOTA'); expect(f.state.events).toBe(0); expect(f.rows.size).toBe(0);
});
test('unknown historical enrollment blocks another flow without invented source authority', () => {
  const f = fixture(); f.rows.set('poa-passkey-pending', JSON.stringify({ oldName: { accountAddress: ACCOUNT, orgName: 'oldName' } }));
  expect(f.store.readPendingEnrollment(source).provenance).toBe('legacy-unknown');
  expect(() => f.store.requirePendingEnrollment(source)).toThrow('earlier account');
});
