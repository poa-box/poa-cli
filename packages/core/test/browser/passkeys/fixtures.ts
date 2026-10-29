import { createHash, webcrypto } from 'node:crypto';
import { encodeBase64Url, decodeBase64Url } from '../../../src/browser/passkeys/utils';
export const X = '0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296';
export const Y = '0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';
export const RP = 'poa.box', ORIGIN = 'https://www.poa.box', RAW_ID = encodeBase64Url(new Uint8Array([1, 2, 3, 4]));
export const CRYPTO = webcrypto;
export const hexBytes = (value: string) => new Uint8Array(value.replace(/^0x/, '').match(/../g)!.map(pair => parseInt(pair, 16)));
export function authData(rp = RP, flags = 5): Uint8Array {
  const result = new Uint8Array(37); result.set(createHash('sha256').update(rp).digest()); result[32] = flags; return result;
}
export function registrationAuthData(rp = RP, rawId = RAW_ID) {
  const raw = decodeBase64Url(rawId), cose = hexBytes(`a5010203262001215820${X.slice(2)}225820${Y.slice(2)}`);
  const result = new Uint8Array(55 + raw.length + cose.length); result.set(authData(rp, 0x45)); result[53] = raw.length >> 8; result[54] = raw.length & 255;
  result.set(raw, 55); result.set(cose, 55 + raw.length); return result;
}
export function assertionResponse(options: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return { id: RAW_ID, rawId: RAW_ID, type: 'public-key', response: {
    clientDataJSON: encodeBase64Url(new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: ORIGIN }))),
    authenticatorData: encodeBase64Url(authData(String(options.rpId))), signature: encodeBase64Url(new Uint8Array([0x30, 6, 2, 1, 1, 2, 1, 2])), ...overrides,
  } };
}
export function registrationResponse(options: Record<string, unknown>) {
  return { id: RAW_ID, rawId: RAW_ID, type: 'public-key', response: {
    clientDataJSON: encodeBase64Url(new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: ORIGIN }))),
    authenticatorData: encodeBase64Url(registrationAuthData()), publicKeyAlgorithm: -7,
    publicKey: encodeBase64Url(hexBytes(`3059301306072a8648ce3d020106082a8648ce3d03010703420004${X.slice(2)}${Y.slice(2)}`)),
  } };
}
