/** Historical frontend pointer compatibility. New writes should use encoding/cid. */
import { arrayify, hexlify, type BytesLike, type Hexable } from '@ethersproject/bytes';
import { keccak256 } from '@ethersproject/keccak256';
import { toUtf8Bytes } from '@ethersproject/strings';
import { cidV0ToBytes32, bytes32ToCidV0 } from './cid';

const ZERO_HASH = '0x' + '0'.repeat(64);

/**
 * Preserves empty sentinels, unchecked 66-character 0x strings, tolerant
 * CIDv0 digests and UTF-8 text hashing. CIDv1 text is HASHED, never converted
 * to its content digest. Malformed Qm inputs return zero; malformed UTF-16
 * still throws. Hosts own logging and migration policy.
 */
export function legacyPointerToBytes32(pointer: string | null | undefined): string {
  if (!pointer) return ZERO_HASH;
  if (!pointer.startsWith('Qm')) {
    if (pointer.startsWith('0x') && pointer.length === 66) return pointer;
    return keccak256(toUtf8Bytes(pointer));
  }
  try { return cidV0ToBytes32(pointer, { strict: false }); }
  catch { return ZERO_HASH; }
}

/**
 * Historical permissive decoding: byte arrays and short/even empty digests
 * acquire the sha2-256 multihash prefix without length validation. Only the
 * literal zero-hash string is absent; a zero-filled byte array is encoded.
 * This is compatibility behavior, not validation of a content-addressed CID.
 */
export function legacyBytes32ToIpfsCid(digest: BytesLike | Hexable | number | null | undefined): string | null {
  if (!digest || digest === ZERO_HASH) return null;
  try { return bytes32ToCidV0(hexlify(arrayify(digest)), { strict: false }); }
  catch { return null; }
}
