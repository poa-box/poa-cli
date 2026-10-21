/** CIDv0 digest codec: bs58 only, no ethers, ABI registry, executor or globals. */
import bs58 from 'bs58';

export interface CidCodecOptions {
  /** False is for the existing tolerant encoding exports, never new planners. */
  strict?: boolean;
}

function assertNonzeroDigest(hex: string): void {
  if (!/^0x[\da-fA-F]{64}$/.test(hex) || /^0x0{64}$/.test(hex)) throw new Error('Expected a nonzero bytes32 digest');
}

export function cidV0ToBytes32(cid: string, options: CidCodecOptions = {}): string {
  if (typeof cid !== 'string' || (options.strict !== false && !cid.startsWith('Qm'))) throw new Error('Expected CIDv0');
  const bytes = bs58.decode(cid);
  if (bytes.length !== 34) throw new Error(`Invalid CIDv0 length: expected 34 bytes, got ${bytes.length}`);
  if (options.strict !== false && (bytes[0] !== 0x12 || bytes[1] !== 0x20)) throw new Error('Expected sha2-256 CIDv0 multihash');
  const digest = '0x' + Array.from(bytes.slice(2), byte => byte.toString(16).padStart(2, '0')).join('');
  if (options.strict !== false) assertNonzeroDigest(digest);
  return digest;
}

export function bytes32ToCidV0(digest: string, options: CidCodecOptions = {}): string {
  if (options.strict !== false) assertNonzeroDigest(digest);
  if (typeof digest !== 'string' || !/^0x(?:[\da-fA-F]{2})*$/.test(digest)) throw new Error('Invalid hex bytes');
  const bytes = new Uint8Array(2 + (digest.length - 2) / 2);
  bytes.set([0x12, 0x20]);
  for (let i = 2; i < bytes.length; i++) bytes[i] = parseInt(digest.slice(2 + (i - 2) * 2, 4 + (i - 2) * 2), 16);
  return bs58.encode(bytes);
}

/** Strict metadata pointer: a CIDv0 digest or literal nonzero bytes32, never a text hash. */
export function metadataPointerToBytes32(pointer: string): string {
  if (typeof pointer === 'string' && pointer.startsWith('0x')) {
    assertNonzeroDigest(pointer);
    return pointer;
  }
  return cidV0ToBytes32(pointer);
}
