/** Exact raw units. No pricing, rounding, symbol rewriting or ambient chain. */
export type RawUintInput = string | bigint | number;

/** Validate a Solidity uint and return its canonical decimal representation. */
export function requireRawUint(value: RawUintInput, bits = 256): string {
  if (!Number.isInteger(bits) || bits < 1 || bits > 256) throw new Error('Invalid uint width');
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0))) {
    throw new Error('Raw uint Number must be a nonnegative safe integer');
  }
  if (typeof value !== 'string' && typeof value !== 'bigint' && typeof value !== 'number') {
    throw new Error('Raw uint must be a decimal string, bigint or safe integer');
  }
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error('Raw uint must contain decimal digits only');
  const raw = BigInt(text);
  if (raw >= (1n << BigInt(bits))) throw new Error(`Raw uint exceeds uint${bits}`);
  return raw.toString();
}

export function requireAssetDecimals(decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Invalid asset decimals');
  return decimals;
}

/** Decimal text is literal: whitespace, sign, exponent and overprecision fail. */
export function parseDecimalAmountToRaw(value: string, decimals: number): string {
  requireAssetDecimals(decimals);
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid decimal amount');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error('Amount exceeds asset decimals');
  return requireRawUint(whole + fraction.padEnd(decimals, '0'));
}

export interface AssetRef {
  chainId: number;
  /** Address syntax is checked; chain/token metadata and checksum are host inputs. */
  address: string;
  decimals: number;
}

export interface RawAssetAmount {
  asset: AssetRef;
  rawAmount: string;
}

export function requireAssetRef(asset: AssetRef): AssetRef {
  if (!Number.isSafeInteger(asset.chainId) || asset.chainId <= 0) throw new Error('Invalid asset chain');
  if (typeof asset.address !== 'string' || !/^0x[\da-fA-F]{40}$/.test(asset.address)) throw new Error('Invalid asset address');
  requireAssetDecimals(asset.decimals);
  return asset;
}

/** Group only by chain + address + decimals. Native aliases stay distinct. */
export function sumRawAssetAmounts(amounts: readonly RawAssetAmount[]): RawAssetAmount[] {
  const sums = new Map<string, RawAssetAmount>();
  for (const amount of amounts) {
    const asset = requireAssetRef(amount.asset);
    const key = `${asset.chainId}:${asset.address.toLowerCase()}:${asset.decimals}`;
    const raw = BigInt(requireRawUint(amount.rawAmount));
    const existing = sums.get(key);
    sums.set(key, {
      asset: existing?.asset ?? { ...asset },
      rawAmount: requireRawUint(raw + BigInt(existing?.rawAmount ?? '0')),
    });
  }
  return [...sums.values()];
}

/** Only the explicitly supplied aliases normalize, on the same chain/decimals. */
export function normalizeNativeAsset(asset: AssetRef, native: AssetRef, aliases: readonly string[]): AssetRef {
  requireAssetRef(asset);
  requireAssetRef(native);
  for (const address of aliases) requireAssetRef({ ...native, address });
  const matches = asset.address.toLowerCase() === native.address.toLowerCase()
    || aliases.some(address => address.toLowerCase() === asset.address.toLowerCase());
  if (asset.chainId !== native.chainId || !matches) return { ...asset };
  if (asset.decimals !== native.decimals) throw new Error('Native alias decimals mismatch');
  return { ...native };
}
