import { ethers } from 'ethers';
import { credentialIdDigest } from '@poa-box/core/accounts/codecs';

export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
export const bytesHex = (bytes: Uint8Array) => ethers.utils.hexlify(bytes);
export const bytes32 = (value: bigint) => ethers.utils.hexZeroPad(ethers.BigNumber.from(value.toString()).toHexString(), 32);
export function encodeBase64Url(bytes: Uint8Array): string { return ethers.utils.base64.encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export function decodeBase64Url(value: string): Uint8Array {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('INVALID_BASE64URL');
  const result = ethers.utils.base64.decode(value.replace(/-/g, '+').replace(/_/g, '/'));
  if (encodeBase64Url(result) !== value) throw new Error('NONCANONICAL_BASE64URL');
  return result;
}
export function computeCredentialId(rawCredentialId: string): string { return credentialIdDigest(decodeBase64Url(rawCredentialId)); }
export function validateP256Coordinates(x: string, y: string): void {
  if (!/^0x[\da-f]{64}$/i.test(x) || !/^0x[\da-f]{64}$/i.test(y)) throw new Error('INVALID_P256_PUBLIC_KEY');
  const px = BigInt(x), py = BigInt(y), mod = (n: bigint) => (n % P256_P + P256_P) % P256_P;
  if (px >= P256_P || py >= P256_P || mod(py * py) !== mod(px * px * px - 3n * px + P256_B)) throw new Error('INVALID_P256_PUBLIC_KEY');
}
export function parseDERSignature(der: Uint8Array): { r: bigint; s: bigint } {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2 || (der[1] & 0x80)) throw new Error('Invalid passkey DER signature.');
  let offset = 2;
  const integer = () => {
    if (der[offset++] !== 2) throw new Error('Invalid passkey DER integer.');
    const length = der[offset++];
    if (!length || length > 33 || offset + length > der.length) throw new Error('Invalid passkey DER integer length.');
    const bytes = der.slice(offset, offset + length); offset += length;
    if ((bytes[0] & 0x80) || (length > 1 && bytes[0] === 0 && !(bytes[1] & 0x80))) throw new Error('Noncanonical passkey DER integer.');
    const value = BigInt(bytesHex(bytes));
    if (value <= 0n || value >= P256_N) throw new Error('Invalid passkey signature coordinate.');
    return value;
  };
  const r = integer(); let s = integer();
  if (offset !== der.length) throw new Error('Trailing passkey DER signature bytes.');
  if (s > P256_N / 2n) s = P256_N - s;
  return { r, s };
}

/** Bounded definite-length CBOR parser for the WebAuthn attestation envelope and
 * COSE public key. Byte scanning can mistake credential bytes for COSE fields. */
export function readCbor(bytes: Uint8Array, start = 0): { value: unknown; offset: number } {
  let offset = start, items = 0;
  const take = (count: number) => {
    if (!Number.isSafeInteger(count) || count < 0 || offset + count > bytes.length) throw new Error('INVALID_CBOR');
    const result = bytes.slice(offset, offset + count); offset += count; return result;
  };
  const read = (depth: number): unknown => {
    if (depth > 12 || ++items > 512) throw new Error('INVALID_CBOR');
    const head = take(1)[0], major = head >> 5, ai = head & 31;
    let length: number;
    if (ai < 24) length = ai;
    else if (ai === 24) { length = take(1)[0]; if (length < 24) throw new Error('INVALID_CBOR'); }
    else if (ai === 25) { const b = take(2); length = b[0] * 256 + b[1]; if (length < 256) throw new Error('INVALID_CBOR'); }
    else if (ai === 26) { const b = take(4); length = b[0] * 0x1000000 + b[1] * 65536 + b[2] * 256 + b[3]; if (length < 65536) throw new Error('INVALID_CBOR'); }
    else throw new Error('INVALID_CBOR');
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2) return take(length);
    if (major === 3) return new TextDecoder('utf-8', { fatal: true }).decode(take(length));
    if (major === 4) { if (length > 512) throw new Error('INVALID_CBOR'); return Array.from({ length }, () => read(depth + 1)); }
    if (major === 5) {
      if (length > 256) throw new Error('INVALID_CBOR');
      const map = new Map<unknown, unknown>();
      for (let i = 0; i < length; i++) { const key = read(depth + 1); if (!['number', 'string'].includes(typeof key) || map.has(key)) throw new Error('INVALID_CBOR'); map.set(key, read(depth + 1)); }
      return map;
    }
    if (major === 7 && ai === 20) return false;
    if (major === 7 && ai === 21) return true;
    if (major === 7 && ai === 22) return null;
    throw new Error('INVALID_CBOR');
  };
  return { value: read(0), offset };
}
const SPKI_HEADER = '0x3059301306072a8648ce3d020106082a8648ce3d03010703420004';
export function extractP256PublicKey(publicKey: string): { publicKeyX: string; publicKeyY: string } {
  const bytes = decodeBase64Url(publicKey);
  if (bytes.length !== 91 || bytesHex(bytes.slice(0, 27)) !== SPKI_HEADER) throw new Error('INVALID_P256_SPKI');
  const publicKeyX = bytesHex(bytes.slice(27, 59)), publicKeyY = bytesHex(bytes.slice(59));
  validateP256Coordinates(publicKeyX, publicKeyY); return { publicKeyX, publicKeyY };
}
export function attestationAuthenticatorData(attestation: string): Uint8Array {
  const bytes = decodeBase64Url(attestation), decoded = readCbor(bytes);
  if (decoded.offset !== bytes.length || !(decoded.value instanceof Map) || !(decoded.value.get('authData') instanceof Uint8Array)) throw new Error('INVALID_ATTESTATION');
  return decoded.value.get('authData') as Uint8Array;
}
export function credentialPublicKey(authData: Uint8Array, rawCredentialId: string) {
  if (authData.length < 55 || !(authData[32] & 0x40)) throw new Error('INVALID_ATTESTED_CREDENTIAL');
  const length = authData[53] * 256 + authData[54], start = 55 + length;
  if (!length || start >= authData.length || encodeBase64Url(authData.slice(55, start)) !== rawCredentialId) throw new Error('ATTESTED_CREDENTIAL_MISMATCH');
  const decoded = readCbor(authData, start), key = decoded.value;
  if (!(key instanceof Map) || key.get(1) !== 2 || key.get(3) !== -7 || key.get(-1) !== 1 || !(key.get(-2) instanceof Uint8Array) || !(key.get(-3) instanceof Uint8Array)) throw new Error('INVALID_P256_COSE_KEY');
  if (!(authData[32] & 0x80) && decoded.offset !== authData.length) throw new Error('TRAILING_ATTESTATION_DATA');
  if (authData[32] & 0x80) { const extensions = readCbor(authData, decoded.offset); if (extensions.offset !== authData.length || !(extensions.value instanceof Map)) throw new Error('INVALID_AUTHENTICATOR_EXTENSIONS'); }
  const publicKeyX = bytesHex(key.get(-2) as Uint8Array), publicKeyY = bytesHex(key.get(-3) as Uint8Array);
  validateP256Coordinates(publicKeyX, publicKeyY); return { publicKeyX, publicKeyY };
}
