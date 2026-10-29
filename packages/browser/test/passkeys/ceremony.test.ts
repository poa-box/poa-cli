import { test, expect } from 'vitest';
import { unpackPasskeySignature } from '@poa-box/core/accounts/codecs';
import { createPasskeyCredential, discoverPasskeyCredential, getWebAuthnAssertion, authenticateWithRpFallback, createNativePasskeyAdapter } from '../../src/passkeys/ceremony';
import { signUserOpHash, signRegistrationChallenge } from '../../src/passkeys/sign';
import { computeCredentialId, decodeBase64Url, encodeBase64Url, extractP256PublicKey, parseDERSignature, validateP256Coordinates, P256_N } from '../../src/passkeys/utils';
import { assertionResponse, authData, registrationResponse, CRYPTO, ORIGIN, RAW_ID, RP, X, Y } from './fixtures';
const HASH = `0x${'a1'.repeat(32)}`;
const base = { rpId: RP, origin: ORIGIN, crypto: CRYPTO };
const authenticate = async ({ optionsJSON }) => assertionResponse(optionsJSON);
test('create verifies signed client data, RP hash, attested credential, matching SPKI and valid curve point', async () => {
  const credential = await createPasskeyCredential('member', { ...base, rpName: 'Poa', adapter: { startRegistration: async ({ optionsJSON }) => registrationResponse(optionsJSON) } });
  expect(credential).toMatchObject({ rawCredentialId: RAW_ID, credentialId: computeCredentialId(RAW_ID), publicKeyX: X, publicKeyY: Y });
  expect(typeof credential.salt).toBe('bigint');
});
test('sign preserves UTF8 byte offsets and packs the verified fields with exact credential digest', async () => {
  const adapter = { startAuthentication: async ({ optionsJSON }) => {
    const response = assertionResponse(optionsJSON);
    response.response.clientDataJSON = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ comment: 'member 🌱', type: 'webauthn.get', challenge: optionsJSON.challenge, origin: ORIGIN, crossOrigin: true })));
    return response;
  } };
  const auth = await getWebAuthnAssertion(HASH, RAW_ID, { ...base, adapter }), text = new TextDecoder().decode(auth.clientDataJSON);
  expect(new TextDecoder().decode(auth.clientDataJSON.slice(auth.typeIndex))).toMatch(/^webauthn.get/);
  expect(new TextDecoder().decode(auth.clientDataJSON.slice(auth.challengeIndex))).toMatch(new RegExp(`^${encodeBase64Url(new Uint8Array(32).fill(0xa1))}`));
  expect(auth.challengeIndex).toBeGreaterThan(text.indexOf('"challenge":"') + 13);
  const signed = await signUserOpHash(HASH, RAW_ID, { ...base, adapter });
  expect(unpackPasskeySignature(signed).credentialId).toBe(computeCredentialId(RAW_ID));
  expect((await signRegistrationChallenge(HASH, RAW_ID, { ...base, adapter })).r).toBe(`0x${'0'.repeat(63)}1`);
});
test.each(['NotAllowedError', 'AbortError', 'SecurityError'])('%s never triggers a second ceremony', async name => {
  let calls = 0; const failure = Object.assign(new Error(name), { name });
  await expect(authenticateWithRpFallback(rpId => ({ optionsJSON: { rpId } }), RP, { hostname: 'custom.example', adapter: { async startAuthentication() { calls++; throw failure; } } })).rejects.toBe(failure);
  expect(calls).toBe(1);
});
test('only explicit RP mismatch on unrelated host permits one verified hostname fallback', async () => {
  const seen = [];
  const response = await getWebAuthnAssertion(HASH, RAW_ID, { ...base, origin: 'https://custom.example', adapter: { async startAuthentication({ optionsJSON }) {
    seen.push(optionsJSON.rpId);
    if (seen.length === 1) throw Object.assign(new Error('invalid RP'), { code: 'ERROR_INVALID_RP_ID', cause: { name: 'SecurityError' } });
    const response = assertionResponse(optionsJSON);
    response.response.clientDataJSON = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: optionsJSON.challenge, origin: 'https://custom.example' })));
    return response;
  } } });
  expect(response.rawId).toBe(RAW_ID); expect(seen).toEqual([RP, 'custom.example']);
});
test.each(['challenge', 'origin', 'type', 'duplicate', 'credential', 'rp', 'up', 'uv', 'der', 'extensions'])('malformed %s fails closed', async failure => {
  await expect(getWebAuthnAssertion(HASH, RAW_ID, { ...base, adapter: { async startAuthentication({ optionsJSON }) {
    const response = assertionResponse(optionsJSON);
    if (['challenge', 'origin', 'type'].includes(failure)) {
      const data = JSON.parse(new TextDecoder().decode(decodeBase64Url(response.response.clientDataJSON))); data[failure] = 'wrong'; response.response.clientDataJSON = encodeBase64Url(new TextEncoder().encode(JSON.stringify(data)));
    }
    if (failure === 'duplicate') response.response.clientDataJSON = encodeBase64Url(new TextEncoder().encode(`{"type":"webauthn.get","challenge":"wrong","challenge":"${optionsJSON.challenge}","origin":"${ORIGIN}"}`));
    if (failure === 'credential') { response.rawId = 'AQ'; response.id = 'AQ'; }
    if (failure === 'rp') response.response.authenticatorData = encodeBase64Url(authData('wrong.example'));
    if (failure === 'up') response.response.authenticatorData = encodeBase64Url(authData(RP, 4));
    if (failure === 'uv') response.response.authenticatorData = encodeBase64Url(authData(RP, 1));
    if (failure === 'extensions') response.response.authenticatorData = encodeBase64Url(new Uint8Array([...authData(RP, 0x85), 0]));
    if (failure === 'der') response.response.signature = encodeBase64Url(new Uint8Array([0x30, 6, 2, 1, 0x80, 2, 1, 2]));
    return response;
  } } })).rejects.toThrow();
});
test('cancelled delayed assertion cannot authorize identity lookup or signing', async () => {
  const controller = new AbortController(); let lookups = 0;
  await expect(discoverPasskeyCredential({ ...base, signal: controller.signal, adapter: { async startAuthentication({ optionsJSON }) { controller.abort(); return assertionResponse(optionsJSON); } }, lookupAccount: async () => { lookups++; return { accountAddress: 'untrusted' }; } })).rejects.toMatchObject({ name: 'AbortError' });
  expect(lookups).toBe(0);
});
test('discovery lookup outage is not no-account and pending pointers never override ceremony identity', async () => {
  const failure = new Error('outage'), adapter = { startAuthentication: authenticate };
  await expect(discoverPasskeyCredential({ ...base, adapter, lookupAccount: async () => { throw failure; } })).rejects.toBe(failure);
  const found = await discoverPasskeyCredential({ ...base, adapter, lookupAccount: async () => null, findPendingCredentialByCredentialId: () => ({ credentialId: 'forged', rawCredentialId: 'forged', accountAddress: 'saved-hint' }) });
  expect(found.credentialId).toBe(computeCredentialId(RAW_ID)); expect(found.rawCredentialId).toBe(RAW_ID);
});
test('native adapter converts exact challenge and allowed ID bytes, forwards abort signal', async () => {
  const controller = new AbortController(); let seen;
  const adapter = createNativePasskeyAdapter({ async create() { return null; }, async get(options) {
    seen = options; return { type: 'public-key', id: RAW_ID, rawId: decodeBase64Url(RAW_ID).buffer, response: {
      clientDataJSON: new Uint8Array([1]).buffer, authenticatorData: authData().buffer, signature: new Uint8Array([2]).buffer, userHandle: null,
    } };
  } });
  const result = await adapter.startAuthentication({ optionsJSON: { challenge: RAW_ID, allowCredentials: [{ id: RAW_ID, type: 'public-key' }] }, signal: controller.signal });
  expect(seen.signal).toBe(controller.signal); expect(new Uint8Array(seen.publicKey.challenge)).toEqual(decodeBase64Url(RAW_ID)); expect(result.rawId).toBe(RAW_ID);
});
test('P256/SPKI and DER parsing reject noncanonical and offcurve data; low-s normalizes', () => {
  expect(() => validateP256Coordinates(X, Y)).not.toThrow();
  expect(() => validateP256Coordinates(`0x${'ff'.repeat(32)}`, Y)).toThrow();
  const valid = registrationResponse({ challenge: RAW_ID }).response.publicKey;
  expect(extractP256PublicKey(valid)).toEqual({ publicKeyX: X, publicKeyY: Y });
  const bytes = decodeBase64Url(valid); bytes[4] ^= 1; expect(() => extractP256PublicKey(encodeBase64Url(bytes))).toThrow();
  expect(() => parseDERSignature(new Uint8Array([0x30, 7, 2, 2, 0, 1, 2, 1, 2]))).toThrow('Noncanonical');
  const s = (P256_N - 2n).toString(16).match(/../g).map(x => parseInt(x, 16));
  const der = new Uint8Array([0x30, 38, 2, 1, 1, 2, 33, 0, ...s]); expect(parseDERSignature(der).s).toBe(2n);
});
test.each(['create', 'assert', 'discover', 'fallback'] as const)('a stale initial scope permits zero injected %s prompts', async operation => {
  let prompts = 0;
  const adapter = { async startRegistration({ optionsJSON }) { prompts++; return registrationResponse(optionsJSON); },
    async startAuthentication({ optionsJSON }) { prompts++; return assertionResponse(optionsJSON); } };
  const options = { ...base, adapter, isCurrent: () => false };
  const action = operation === 'create' ? createPasskeyCredential('member', options)
    : operation === 'assert' ? getWebAuthnAssertion(HASH, RAW_ID, options)
    : operation === 'discover' ? discoverPasskeyCredential(options)
    : authenticateWithRpFallback(rpId => ({ optionsJSON: { rpId } }), RP, { adapter, hostname: 'custom.example', isCurrent: options.isCurrent });
  await expect(action).rejects.toThrow('PASSKEY_SCOPE_CHANGED'); expect(prompts).toBe(0);
});
test.each(['create', 'get'] as const)('native %s checks scope before prompting and discards a response after ownership loss', async operation => {
  let current = false, prompts = 0;
  const native = createNativePasskeyAdapter({
    async create() { prompts++; current = false; return null; },
    async get() { prompts++; current = false; return null; },
  });
  const request = { optionsJSON: { challenge: RAW_ID, user: { id: RAW_ID } }, isCurrent: () => current };
  const action = () => operation === 'create' ? native.startRegistration(request) : native.startAuthentication(request);
  await expect(action()).rejects.toThrow('PASSKEY_SCOPE_CHANGED'); expect(prompts).toBe(0);
  current = true; await expect(action()).rejects.toThrow('PASSKEY_SCOPE_CHANGED'); expect(prompts).toBe(1);
});
test.each(['identity', 'lock', 'cancellation'] as const)('%s loss while awaiting RP rejection prevents a second prompt', async change => {
  let current = true, prompts = 0; const controller = new AbortController();
  const options = { ...base, origin: 'https://custom.example', isCurrent: () => current, signal: controller.signal,
    adapter: { async startAuthentication() {
      prompts++; await Promise.resolve();
      if (change === 'cancellation') controller.abort(); else current = false;
      throw Object.assign(new Error('invalid RP'), { code: 'ERROR_INVALID_RP_ID', cause: { name: 'SecurityError' } });
    } } };
  await expect(getWebAuthnAssertion(HASH, RAW_ID, options)).rejects.toThrow(change === 'cancellation' ? 'cancelled' : 'PASSKEY_SCOPE_CHANGED');
  expect(prompts).toBe(1);
});
test('an options-level guard cannot override a request-specific ownership guard during fallback', async () => {
  let current = true, prompts = 0;
  await expect(authenticateWithRpFallback(rpId => ({ optionsJSON: { rpId }, isCurrent: () => current }), RP,
    { hostname: 'custom.example', isCurrent: () => true, adapter: { async startAuthentication() {
      prompts++; await Promise.resolve(); current = false;
      throw Object.assign(new Error('invalid RP'), { code: 'ERROR_INVALID_RP_ID', cause: { name: 'SecurityError' } });
    } } })).rejects.toThrow('PASSKEY_SCOPE_CHANGED');
  expect(prompts).toBe(1);
});
test.each(['create', 'assert', 'discover'] as const)('%s discards proof after scope loss during asynchronous RP-hash verification', async operation => {
  let current = true, prompts = 0, lookups = 0;
  const crypto = { getRandomValues: CRYPTO.getRandomValues.bind(CRYPTO), subtle: { async digest(algorithm, bytes) {
    const result = await CRYPTO.subtle.digest(algorithm, bytes); current = false; return result;
  } } };
  const options = { ...base, crypto, isCurrent: () => current, adapter: {
    async startRegistration({ optionsJSON }) { prompts++; return registrationResponse(optionsJSON); },
    async startAuthentication({ optionsJSON }) { prompts++; return assertionResponse(optionsJSON); },
  } };
  const action = operation === 'create' ? createPasskeyCredential('member', options) : operation === 'assert'
    ? getWebAuthnAssertion(HASH, RAW_ID, options) : discoverPasskeyCredential({ ...options, async lookupAccount() { lookups++; return {}; } });
  await expect(action).rejects.toThrow('PASSKEY_SCOPE_CHANGED'); expect(prompts).toBe(1); expect(lookups).toBe(0);
});
test('scope changes during asynchronous discovery lookup prevent returning identity or querying pending hints', async () => {
  let current = true, pending = 0;
  await expect(discoverPasskeyCredential({ ...base, isCurrent: () => current, adapter: { startAuthentication: authenticate },
    async lookupAccount() { await Promise.resolve(); current = false; return { accountAddress: 'stale' }; },
    findPendingCredentialByCredentialId() { pending++; return {}; },
  })).rejects.toThrow('PASSKEY_SCOPE_CHANGED'); expect(pending).toBe(0);
});
