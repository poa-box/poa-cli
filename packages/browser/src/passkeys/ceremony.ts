import { derivePasskeySalt } from '@poa-box/core/accounts/codecs';
import { attestationAuthenticatorData, bytesHex, computeCredentialId, credentialPublicKey, decodeBase64Url, encodeBase64Url, extractP256PublicKey, parseDERSignature, readCbor } from './utils';

export interface CeremonyResponse {
  id?: string; rawId: string; type?: string;
  response: { clientDataJSON: string; authenticatorData?: string; signature?: string; publicKey?: string; publicKeyAlgorithm?: number; attestationObject?: string; userHandle?: string | null };
}
export interface CeremonyRequest { optionsJSON: Record<string, unknown>; signal?: AbortSignal; isCurrent?: () => boolean }
export interface PasskeyCeremonyAdapter {
  startRegistration(request: CeremonyRequest): Promise<CeremonyResponse>;
  startAuthentication(request: CeremonyRequest): Promise<CeremonyResponse>;
}
export interface CredentialPort { create(options: CredentialCreationOptions): Promise<Credential | null>; get(options: CredentialRequestOptions): Promise<Credential | null> }
export interface BrowserCryptoPort { getRandomValues<T extends ArrayBufferView>(array: T): T; subtle: { digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer> } }
export interface PasskeyConfig {
  rpId: string; origin?: string; rpName?: string; hostname?: string; timeout?: number;
  adapter?: Partial<PasskeyCeremonyAdapter>; credentials?: CredentialPort; crypto?: BrowserCryptoPort; signal?: AbortSignal;
  /** Bind prompts and returned proofs to the caller's current account/session
   * and journal ownership. Omitted for existing frontend integrations. */
  isCurrent?: () => boolean;
}
export interface PasskeyCredential { credentialId: string; publicKeyX: string; publicKeyY: string; rawCredentialId: string; salt: bigint }
export interface VerifiedPasskeyAssertion {
  authenticatorData: Uint8Array; clientDataJSON: Uint8Array; challengeIndex: number; typeIndex: number; r: bigint; s: bigint; rawId: string;
}
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Passkey ceremony cancelled.', 'AbortError'); };
const active = (options: { signal?: AbortSignal; isCurrent?: () => boolean }) => {
  cancelled(options.signal);
  if (options.isCurrent !== undefined && (typeof options.isCurrent !== 'function' || options.isCurrent() !== true))
    throw new Error('PASSKEY_SCOPE_CHANGED');
};
const locationOrigin = () => globalThis.location?.origin;
function config(input: PasskeyConfig) {
  const origin = input.origin ?? locationOrigin();
  if (!origin || new URL(origin).origin !== origin || !/^https?:\/\//.test(origin)) throw new Error('PASSKEY_ORIGIN_REQUIRED');
  const originURL = new URL(origin);
  if (originURL.protocol !== 'https:' && originURL.hostname !== 'localhost' && originURL.hostname !== '127.0.0.1') throw new Error('SECURE_PASSKEY_ORIGIN_REQUIRED');
  if (typeof input.rpId !== 'string' || !/^[a-z0-9.-]+$/i.test(input.rpId) || input.rpId.startsWith('.') || input.rpId.endsWith('.')) throw new Error('PASSKEY_RP_ID_REQUIRED');
  if (input.hostname && input.hostname !== originURL.hostname) throw new Error('PASSKEY_HOSTNAME_MISMATCH');
  const timeout = input.timeout ?? 120000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 600000) throw new Error('INVALID_PASSKEY_TIMEOUT');
  const crypto = input.crypto ?? globalThis.crypto;
  if (!crypto?.getRandomValues || !crypto?.subtle?.digest) throw new Error('BROWSER_CRYPTO_REQUIRED');
  const adapter = input.adapter ?? createNativePasskeyAdapter(input.credentials);
  return { ...input, origin, hostname: originURL.hostname, timeout, crypto, adapter };
}
function nativeJson(credential: Credential | null, create: boolean): CeremonyResponse {
  if (!credential || credential.type !== 'public-key') throw new Error('PUBLIC_KEY_CREDENTIAL_REQUIRED');
  const key = credential as PublicKeyCredential, response = key.response;
  const result: CeremonyResponse = { id: key.id, rawId: encodeBase64Url(new Uint8Array(key.rawId)), type: key.type,
    response: { clientDataJSON: encodeBase64Url(new Uint8Array(response.clientDataJSON)) } };
  if (create) {
    const registration = response as AuthenticatorAttestationResponse;
    result.response.attestationObject = encodeBase64Url(new Uint8Array(registration.attestationObject));
    const publicKey = registration.getPublicKey?.();
    if (publicKey) result.response.publicKey = encodeBase64Url(new Uint8Array(publicKey));
    if (registration.getPublicKeyAlgorithm) result.response.publicKeyAlgorithm = registration.getPublicKeyAlgorithm();
    if (registration.getAuthenticatorData) result.response.authenticatorData = encodeBase64Url(new Uint8Array(registration.getAuthenticatorData()));
  } else {
    const assertion = response as AuthenticatorAssertionResponse;
    result.response.authenticatorData = encodeBase64Url(new Uint8Array(assertion.authenticatorData));
    result.response.signature = encodeBase64Url(new Uint8Array(assertion.signature));
    result.response.userHandle = assertion.userHandle ? encodeBase64Url(new Uint8Array(assertion.userHandle)) : null;
  }
  return result;
}
/** Native credentials port. No SimpleWebAuthn, UI, transport or runtime config dependency. */
export function createNativePasskeyAdapter(credentials?: CredentialPort): PasskeyCeremonyAdapter {
  const port = () => { const result = credentials ?? globalThis.navigator?.credentials; if (!result?.create || !result?.get) throw new Error('WEBAUTHN_UNAVAILABLE'); return result; };
  return {
    async startRegistration({ optionsJSON, signal, isCurrent }) {
      const action = { signal, isCurrent }; active(action);
      const user = optionsJSON.user as Record<string, unknown>;
      const publicKey = { ...optionsJSON, challenge: decodeBase64Url(String(optionsJSON.challenge)), user: { ...user, id: decodeBase64Url(String(user.id)) } } as unknown as PublicKeyCredentialCreationOptions;
      const credentials = port(); active(action);
      const result = await credentials.create({ publicKey, signal }); active(action);
      const response = nativeJson(result, true); active(action); return response;
    },
    async startAuthentication({ optionsJSON, signal, isCurrent }) {
      const action = { signal, isCurrent }; active(action);
      const allow = optionsJSON.allowCredentials as { id: string; type: 'public-key' }[];
      const publicKey = { ...optionsJSON, challenge: decodeBase64Url(String(optionsJSON.challenge)), allowCredentials: allow?.map(row => ({ ...row, id: decodeBase64Url(row.id) })) } as unknown as PublicKeyCredentialRequestOptions;
      const credentials = port(); active(action);
      const result = await credentials.get({ publicKey, signal }); active(action);
      const response = nativeJson(result, false); active(action); return response;
    },
  };
}
async function authenticationForRp(optionsForRp: (rpId: string) => CeremonyRequest, primaryRpId: string,
  options: { hostname: string; adapter: Pick<PasskeyCeremonyAdapter, 'startAuthentication'>; signal?: AbortSignal; isCurrent?: () => boolean }) {
  const prompt = async (rpId: string) => {
    active(options); const request = optionsForRp(rpId);
    const action = { signal: options.signal ?? request.signal, isCurrent: () => { active(options); active(request); return true; } };
    active(action);
    let response: CeremonyResponse;
    try { response = await options.adapter.startAuthentication({ ...request, ...action }); }
    catch (error) { active(action); throw error; }
    active(action); return response;
  };
  active(options);
  try {
    const response = await prompt(primaryRpId);
    active(options); return { response, rpId: primaryRpId };
  } catch (error) {
    active(options);
    const failure = error as { code?: string; cause?: { name?: string } }, fallback = options.hostname;
    const suffix = fallback === primaryRpId || fallback.endsWith(`.${primaryRpId}`);
    if (suffix || failure?.code !== 'ERROR_INVALID_RP_ID' || failure.cause?.name !== 'SecurityError') throw error;
    const response = await prompt(fallback);
    active(options); return { response, rpId: fallback };
  }
}
/** A dismissed/aborted ceremony is final. Only an explicit unrelated RP-ID
 * rejection permits the hostname compatibility path. */
export async function authenticateWithRpFallback(optionsForRp: (rpId: string) => CeremonyRequest, primaryRpId: string,
  options: { hostname?: string; adapter?: Pick<PasskeyCeremonyAdapter, 'startAuthentication'>; signal?: AbortSignal; isCurrent?: () => boolean } = {}) {
  active(options);
  const hostname = options.hostname ?? globalThis.location?.hostname;
  if (!hostname) throw new Error('PASSKEY_HOSTNAME_REQUIRED');
  const result = await authenticationForRp(optionsForRp, primaryRpId, { ...options, hostname, adapter: options.adapter ?? createNativePasskeyAdapter() });
  active(options); return result.response;
}
function validResponse(response: CeremonyResponse, expectedRawId?: string): string {
  const raw = response?.rawId; computeCredentialId(raw);
  if ((response.id !== undefined && response.id !== raw) || (response.type !== undefined && response.type !== 'public-key') || (expectedRawId !== undefined && raw !== expectedRawId)) throw new Error('The selected passkey does not match this account. Please sign in again.');
  return raw;
}
function clientData(encoded: string, challenge: string, origin: string, type: 'webauthn.create' | 'webauthn.get') {
  const bytes = decodeBase64Url(encoded), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.type !== type || data.challenge !== challenge || data.origin !== origin) throw new Error('The passkey response does not match this request. Please try again.');
  const index = (key: string, expected: string) => {
    // Only unescaped standard WebAuthn fields are accepted for contract offsets.
    const matches = [...text.matchAll(new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*)"`, 'g'))];
    const keys = [...text.matchAll(new RegExp(`"${key}"\\s*:`, 'g'))];
    if (matches.length !== 1 || keys.length !== 1 || matches[0][1] !== expected) throw new Error('AMBIGUOUS_PASSKEY_CLIENT_DATA');
    const match = matches[0], valueOffset = match[0].lastIndexOf('"') - expected.length;
    return new TextEncoder().encode(text.slice(0, match.index! + valueOffset)).length;
  };
  const challengeIndex = index('challenge', challenge), typeIndex = index('type', type); index('origin', origin);
  if ([...text.matchAll(/"crossOrigin"\s*:/g)].length > 1) throw new Error('AMBIGUOUS_PASSKEY_CLIENT_DATA');
  return { bytes, challengeIndex, typeIndex };
}
async function authenticatorData(encoded: string | Uint8Array | undefined, rpId: string, crypto: BrowserCryptoPort): Promise<Uint8Array> {
  const bytes = typeof encoded === 'string' ? decodeBase64Url(encoded) : encoded;
  if (!bytes || bytes.length < 37 || (bytes[32] & 5) !== 5) throw new Error('PASSKEY_USER_VERIFICATION_REQUIRED');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
  if (bytesHex(bytes.slice(0, 32)) !== bytesHex(digest)) throw new Error('PASSKEY_RP_ID_HASH_MISMATCH');
  return bytes;
}
export async function createPasskeyCredential(username: string, input: PasskeyConfig): Promise<PasskeyCredential> {
  const options = config(input); active(options);
  if (typeof username !== 'string' || !username.trim()) throw new Error('PASSKEY_USERNAME_REQUIRED');
  if (!options.adapter.startRegistration) throw new Error('PASSKEY_REGISTRATION_ADAPTER_REQUIRED');
  const challenge = encodeBase64Url(options.crypto.getRandomValues(new Uint8Array(32))), userId = encodeBase64Url(options.crypto.getRandomValues(new Uint8Array(16)));
  active(options);
  const response = await options.adapter.startRegistration({ signal: options.signal, isCurrent: options.isCurrent, optionsJSON: {
    rp: { name: options.rpName ?? 'Poa', id: options.rpId }, user: { id: userId, name: username, displayName: username }, challenge,
    pubKeyCredParams: [{ alg: -7, type: 'public-key' }], authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' }, timeout: options.timeout, attestation: 'none',
  } });
  active(options);
  const rawCredentialId = validResponse(response);
  clientData(response.response.clientDataJSON, challenge, options.origin, 'webauthn.create');
  const auth = await authenticatorData(response.response.authenticatorData ?? (response.response.attestationObject ? attestationAuthenticatorData(response.response.attestationObject) : undefined), options.rpId, options.crypto);
  active(options);
  const key = credentialPublicKey(auth, rawCredentialId);
  if (response.response.publicKeyAlgorithm !== undefined && response.response.publicKeyAlgorithm !== -7) throw new Error('INVALID_P256_PUBLIC_KEY');
  if (response.response.publicKey) {
    const spki = extractP256PublicKey(response.response.publicKey);
    if (spki.publicKeyX !== key.publicKeyX || spki.publicKeyY !== key.publicKeyY) throw new Error('PASSKEY_PUBLIC_KEY_MISMATCH');
  }
  const credentialId = computeCredentialId(rawCredentialId);
  active(options);
  return { credentialId, ...key, rawCredentialId, salt: BigInt(derivePasskeySalt(credentialId)) };
}
async function assertion(challenge: string, rawCredentialId: string | undefined, input: PasskeyConfig) {
  const options = config(input); active(options);
  if (rawCredentialId !== undefined) computeCredentialId(rawCredentialId);
  if (!options.adapter.startAuthentication) throw new Error('PASSKEY_AUTHENTICATION_ADAPTER_REQUIRED');
  const { response, rpId } = await authenticationForRp(rpId => ({ signal: options.signal, isCurrent: options.isCurrent, optionsJSON: {
    challenge, rpId, allowCredentials: rawCredentialId === undefined ? [] : [{ id: rawCredentialId, type: 'public-key', transports: ['internal'] }], userVerification: 'required', timeout: options.timeout,
  } }), options.rpId, { hostname: options.hostname, adapter: options.adapter as PasskeyCeremonyAdapter, signal: options.signal, isCurrent: options.isCurrent });
  validResponse(response, rawCredentialId);
  const client = clientData(response.response.clientDataJSON, challenge, options.origin, 'webauthn.get');
  const auth = await authenticatorData(response.response.authenticatorData, rpId, options.crypto);
  active(options);
  if (auth[32] & 0x40) throw new Error('UNEXPECTED_ATTESTED_CREDENTIAL');
  if (!(auth[32] & 0x80) && auth.length !== 37) throw new Error('TRAILING_AUTHENTICATOR_DATA');
  if (auth[32] & 0x80) { const extensions = readCbor(auth, 37); if (extensions.offset !== auth.length || !(extensions.value instanceof Map)) throw new Error('INVALID_AUTHENTICATOR_EXTENSIONS'); }
  if (!response.response.signature) throw new Error('PASSKEY_SIGNATURE_REQUIRED');
  const signature = parseDERSignature(decodeBase64Url(response.response.signature));
  active(options);
  return { authenticatorData: auth, clientDataJSON: client.bytes, challengeIndex: client.challengeIndex, typeIndex: client.typeIndex, ...signature, rawId: response.rawId };
}
export async function getWebAuthnAssertion(challengeHash: string, rawCredentialId: string, input: PasskeyConfig): Promise<VerifiedPasskeyAssertion> {
  if (typeof challengeHash !== 'string' || !/^0x[\da-f]{64}$/i.test(challengeHash)) throw new Error('Invalid passkey challenge.');
  const bytes = new Uint8Array(challengeHash.slice(2).match(/../g)!.map(value => parseInt(value, 16)));
  return assertion(encodeBase64Url(bytes), rawCredentialId, input);
}
export async function discoverPasskeyCredential<T extends Record<string, unknown> = Record<string, unknown>>(input: PasskeyConfig & {
  lookupAccount?: (credentialId: string) => Promise<T | null>;
  findPendingCredentialByCredentialId?: (credentialId: string) => T | null | Promise<T | null>;
}) {
  const options = config(input); active(options);
  const challenge = encodeBase64Url(options.crypto.getRandomValues(new Uint8Array(32)));
  const response = await assertion(challenge, undefined, options); active(options);
  const rawCredentialId = response.rawId, credentialId = computeCredentialId(rawCredentialId), salt = BigInt(derivePasskeySalt(credentialId)).toString();
  if (!input.lookupAccount) return { credentialId, rawCredentialId, salt };
  let account: T | null = null, lookupError: unknown;
  try { account = await input.lookupAccount(credentialId); } catch (error) { lookupError = error; }
  active(options);
  if (account) return { ...account, credentialId, rawCredentialId, salt };
  const pending = await input.findPendingCredentialByCredentialId?.(credentialId);
  active(options);
  if (pending) return { ...pending, credentialId, rawCredentialId, salt };
  if (lookupError) throw lookupError;
  throw new Error('No account found for this passkey. You may need to create an account first.');
}
