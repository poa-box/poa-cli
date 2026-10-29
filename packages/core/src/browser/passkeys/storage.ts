/** Public pointers only. These records are untrusted reconnect hints and never
 * establish an authenticated account, permission, or authorization to sign. */
export interface CredentialRecord {
  credentialId?: string; rawCredentialId?: string; accountAddress: string; publicKeyX?: string; publicKeyY?: string; salt?: string;
  savedAt?: number; credentialChainId?: number; chainId?: number; registryAddress?: string; factoryAddress?: string;
  targetAddress?: string; zkEmailInvitesAddress?: string; quickJoinAddress?: string; mode?: string; initiator?: unknown;
  orgId?: string; orgName?: string; flow?: string; username?: string; sourceProvenance?: string; [key: string]: unknown;
}
export type EnrollmentSource = Partial<CredentialRecord>;
export interface PendingEnrollment { credential: CredentialRecord; provenance: 'matched' | 'legacy-qualified' | 'other-source' | 'legacy-unknown'; key: string }
export interface PublicStoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const address = (value: unknown) => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
export function pendingEnrollmentKey(source: EnrollmentSource) {
  const chainId = source?.credentialChainId ?? source?.chainId;
  if (!Number.isSafeInteger(chainId) || chainId! <= 0 || !address(source?.registryAddress) || !address(source?.factoryAddress)) return null;
  return `enrollment:${chainId}:${source.registryAddress!.toLowerCase()}:${source.factoryAddress!.toLowerCase()}`;
}
export function enrollmentTarget(source: EnrollmentSource) {
  return (source.targetAddress || source.zkEmailInvitesAddress || (source.mode === 'solidarity' ? source.registryAddress : source.quickJoinAddress) || source.registryAddress)?.toLowerCase() || null;
}
/** Retains the frontend's historical storage keys and pending enrollment rules.
 * Storage and notification failures propagate on mutations. */
export function createPasskeyCredentialStore({ storage, onEnrollment = () => {}, now = () => Date.now(), randomUUID = () => globalThis.crypto.randomUUID() }: {
  storage: PublicStoragePort; onEnrollment?: () => void; now?: () => number; randomUUID?: () => string;
}) {
  const STORAGE_KEY = 'poa-passkey-credentials', PENDING_STORAGE_KEY = 'poa-passkey-pending';
  const RECOVERY_STORAGE_KEY = 'poa-passkey-enrollment-recovery:v1', RESTART_STORAGE_KEY = 'poa-passkey-enrollment-restarts:v1';
  const getAllCredentials = (): Record<string, CredentialRecord> => {
    try {
      const all: unknown = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
      if (!all || typeof all !== 'object' || Array.isArray(all) || Object.values(all).some(row => !row || typeof row !== 'object' || Array.isArray(row))) return {};
      return all as Record<string, CredentialRecord>;
    } catch { return {}; }
  };
  const getAllPendingCredentials = (strict = false): Record<string, CredentialRecord> => {
    try {
      const all: unknown = JSON.parse(storage.getItem(PENDING_STORAGE_KEY) || '{}');
      if (!all || typeof all !== 'object' || Array.isArray(all) || Object.values(all).some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Invalid saved account setup.');
      return all as Record<string, CredentialRecord>;
    } catch {
      if (strict) throw new Error('Your earlier account setup could not be read. Check it before creating another account.');
      return {};
    }
  };
  const readPendingEnrollment = (source: EnrollmentSource): PendingEnrollment | null => {
    const key = pendingEnrollmentKey(source), all = getAllPendingCredentials(true), rows = Object.entries(all);
    if (!rows.length) return null;
    const matched = rows.find(([storedKey, row]) => key && storedKey === key && pendingEnrollmentKey(row) === key) || rows.find(([, row]) => key && pendingEnrollmentKey(row) === key);
    const [storedKey, credential] = matched || rows[0];
    const provenance = matched ? (storedKey === key ? 'matched' : 'legacy-qualified') : pendingEnrollmentKey(credential) ? 'other-source' : 'legacy-unknown';
    return { credential, provenance, key: storedKey };
  };
  return {
    getAllCredentials,
    savePasskeyCredential(data: CredentialRecord) {
      const existing = getAllCredentials(); existing[data.accountAddress.toLowerCase()] = { ...data, savedAt: now() };
      storage.setItem(STORAGE_KEY, JSON.stringify(existing));
    },
    getLastUsedCredential(): CredentialRecord | null { return Object.values(getAllCredentials()).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))[0] || null; },
    removeCredential(accountAddress: string) { const existing = getAllCredentials(); delete existing[accountAddress.toLowerCase()]; storage.setItem(STORAGE_KEY, JSON.stringify(existing)); },
    clearAllCredentials() { storage.removeItem(STORAGE_KEY); },
    hasStoredCredentials() { return Object.keys(getAllCredentials()).length > 0; },
    pendingEnrollmentKey, enrollmentTarget, readPendingEnrollment,
    requirePendingEnrollment(source: EnrollmentSource, { flow, username }: { flow?: string; username?: string } = {}) {
      const pending = readPendingEnrollment(source); if (!pending) return null;
      if (!['matched', 'legacy-qualified'].includes(pending.provenance)
        || (source.initiator && JSON.stringify(pending.credential.initiator) !== JSON.stringify(source.initiator))
        || (source.orgId?.toLowerCase() ?? null) !== (pending.credential.orgId?.toLowerCase() ?? null)
        || pending.credential.targetAddress?.toLowerCase() !== enrollmentTarget(source)
        || (flow && pending.credential.flow !== flow) || (username && pending.credential.username !== username)) throw new Error('Finish or check your earlier account setup before creating another account.');
      return pending.credential;
    },
    savePendingCredential(data: CredentialRecord) {
      const existing = getAllPendingCredentials(true), key = pendingEnrollmentKey(data), legacyKey = String(data.orgName || data.orgId || '').toLowerCase();
      if (!key && !legacyKey) throw new Error('The account setup source is unavailable.');
      const previous = Object.entries(existing).find(([, row]) => row.credentialId === data.credentialId && row.accountAddress?.toLowerCase() === data.accountAddress?.toLowerCase());
      if (previous && previous[0] !== (key || legacyKey)) delete existing[previous[0]];
      existing[key || legacyKey] = { ...data, sourceProvenance: key ? 'observed' : 'legacy-unknown', savedAt: now() };
      storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(existing)); onEnrollment();
    },
    getPendingCredentialForOrg(orgName: string) {
      if (!orgName) return null; const key = orgName.toLowerCase(), all = getAllPendingCredentials();
      return all[key] || Object.values(all).find(row => row.orgId?.toLowerCase() === key || row.orgName?.toLowerCase() === key) || null;
    },
    findPendingCredentialByCredentialId(credentialId: string) {
      if (!credentialId) return null;
      return Object.values(getAllPendingCredentials()).find(row => row.credentialId?.toLowerCase() === credentialId.toLowerCase()) || null;
    },
    removePendingCredential(accountAddress: string, source?: EnrollmentSource, expectedPending?: Pick<PendingEnrollment, 'key' | 'credential'>) {
      if (!accountAddress) return; const existing = getAllPendingCredentials(true);
      if (expectedPending && JSON.stringify(existing[expectedPending.key]) !== JSON.stringify(expectedPending.credential)) throw new Error('Your saved account setup changed. Check it again.');
      for (const key of Object.keys(existing)) if (existing[key].accountAddress?.toLowerCase() === accountAddress.toLowerCase() && (!source || pendingEnrollmentKey(existing[key]) === pendingEnrollmentKey(source))) delete existing[key];
      storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(existing)); onEnrollment();
    },
    readEnrollmentMigration(recoveryId: string): unknown { return JSON.parse(storage.getItem(RECOVERY_STORAGE_KEY) || '{}')[recoveryId]; },
    saveEnrollmentMigration(record: { authorization: string; activationAllowed: boolean; audit: { legacyRecordId: string; recoveryId: string }; [key: string]: unknown }, expectedPending: Pick<PendingEnrollment, 'key' | 'credential'>) {
      const rowsByKey = getAllPendingCredentials(true), current = rowsByKey[expectedPending.key] && { key: expectedPending.key, credential: rowsByKey[expectedPending.key] };
      if (!current || current.key !== expectedPending.key || JSON.stringify(current.credential) !== JSON.stringify(expectedPending.credential)
        || record.authorization !== 'recovery-only' || record.activationAllowed !== false || record.audit.legacyRecordId !== expectedPending.key) throw new Error('Your saved account setup changed. Check it again.');
      const rows = JSON.parse(storage.getItem(RECOVERY_STORAGE_KEY) || '{}'), previous = rows[record.audit.recoveryId];
      if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error('Your saved recovery changed. Check it again.');
      rows[record.audit.recoveryId] = record; storage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(rows));
    },
    saveEnrollmentRestart({ pending, accountAddress, source }: { pending: Pick<PendingEnrollment, 'key' | 'credential'>; accountAddress: string; source: EnrollmentSource }) {
      const current = readPendingEnrollment(source);
      if (!current || current.key !== pending.key || JSON.stringify(current.credential) !== JSON.stringify(pending.credential)) throw new Error('Your saved account setup changed. Check it again.');
      const rows = JSON.parse(storage.getItem(RESTART_STORAGE_KEY) || '{}'), id = randomUUID();
      rows[id] = { legacyRecordId: pending.key, legacyCredentialId: pending.credential.credentialId, accountAddress: accountAddress.toLowerCase(), sourceKey: pendingEnrollmentKey(source), orgId: source.orgId, targetAddress: enrollmentTarget(source), action: 'claim-with-existing-account', retainedLegacy: true };
      storage.setItem(RESTART_STORAGE_KEY, JSON.stringify(rows)); return id;
    },
  };
}
