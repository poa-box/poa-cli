import { ethers } from 'ethers';
import { decodeContractError, DecodedContractError } from '../error-catalog';

export interface RevertEvidence { data: string | null; path: readonly string[]; code?: string }
export interface ErrorEnvelopeBounds { maxDepth?: number; maxNodes?: number; maxBodyBytes?: number }
function revertBytes(value: unknown): value is string { return typeof value === 'string' && /^0x(?:[\da-fA-F]{2})*$/.test(value); }

/** Follow ONLY diagnostic error slots; no messages, transaction/request calldata or arbitrary object scan. */
export function extractRevertEvidence(error: unknown, bounds: ErrorEnvelopeBounds = {}): RevertEvidence {
  const maxDepth = bounds.maxDepth ?? 12, maxNodes = bounds.maxNodes ?? 128, maxBodyBytes = bounds.maxBodyBytes ?? 65536;
  if (![maxDepth, maxNodes, maxBodyBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid envelope bounds');
  const seen = new Set<object>();
  let nodes = 0, bounded = false;
  function walk(value: unknown, path: string[], depth: number, allowBytes: boolean): RevertEvidence | null {
    if (++nodes > maxNodes || depth > maxDepth) { bounded = true; return null; }
    if (allowBytes && revertBytes(value)) return { data: value, path };
    if (!value || typeof value !== 'object') return null;
    if (seen.has(value)) { bounded = true; return null; }
    seen.add(value);
    const obj = value as Record<string, unknown>;
    for (const key of ['data', 'originalError', 'cause', 'error']) {
      const result = walk(obj[key], [...path, key], depth + 1, key === 'data');
      if (result) return result;
    }
    if (typeof obj.body === 'string') {
      if (obj.body.length > maxBodyBytes) bounded = true;
      else try {
        const body = JSON.parse(obj.body);
        const result = walk(body?.error, [...path, 'body', 'error'], depth + 1, false);
        if (result) return result;
      } catch { /* Not a JSON-RPC error body. */ }
    }
    return null;
  }
  return walk(error, [], 0, typeof error === 'string') ?? { data: null, path: [], code: bounded ? 'ENVELOPE_BOUNDED' : 'NO_REVERT_DATA' };
}

export interface RevertTree {
  kind: 'custom' | 'string' | 'panic' | 'empty' | 'unknown' | 'malformed' | 'bounded';
  data: string;
  name?: string;
  args: readonly unknown[];
  decoded?: DecodedContractError;
  /** Decimal zero-based index. Hosts choose localized one-based action copy. */
  callIndex?: string;
  inner?: RevertTree;
  compatibility?: boolean;
}
export interface DecodeRevertTreeOptions {
  iface?: ethers.utils.Interface;
  /** Explicit historical/third-party scope, used only after the current catalog. */
  compatibilityInterfaces?: readonly ethers.utils.Interface[];
  compatibilityNames?: Readonly<Record<string, string>>;
  maxDepth?: number;
}
export function decodeRevertTree(data: string, options: DecodeRevertTreeOptions = {}): RevertTree {
  const maxDepth = options.maxDepth ?? 8;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new Error('Invalid revert depth');
  function decode(raw: string, depth: number): RevertTree {
    const base = { data: raw, args: [] };
    if (depth > maxDepth) return { ...base, kind: 'bounded' };
    if (!revertBytes(raw)) return { ...base, kind: 'malformed' };
    if (raw === '0x') return { ...base, kind: 'empty' };
    const selector = raw.slice(0, 10).toLowerCase();
    if (selector === '0x08c379a0' || selector === '0x4e487b71') {
      try {
        const panic = selector === '0x4e487b71';
        const [value] = ethers.utils.defaultAbiCoder.decode([panic ? 'uint256' : 'string'], '0x' + raw.slice(10));
        return { ...base, kind: panic ? 'panic' : 'string', name: panic ? 'Panic' : 'Error', args: [panic ? value.toString() : value] };
      } catch { return { ...base, kind: 'malformed' }; }
    }
    let decoded = decodeContractError({ data: raw }, options.iface);
    let compatibility = false;
    if (!decoded || decoded.name.startsWith('UnknownCustomError(')) {
      for (const iface of options.compatibilityInterfaces ?? []) {
        try {
          const parsed = iface.parseError(raw);
          decoded = { name: options.compatibilityNames?.[selector] ?? parsed.name, args: Array.from(parsed.args), human: `Contract reverted with custom error ${parsed.name}` };
          compatibility = true;
          break;
        } catch { /* Another compatibility domain. */ }
      }
    }
    if (!decoded || decoded.name.startsWith('UnknownCustomError(')) return { ...base, kind: 'unknown', name: decoded?.name };
    const tree: RevertTree = { data: raw, kind: 'custom', name: decoded.name, args: decoded.args, decoded, ...(compatibility ? { compatibility } : {}) };
    if (decoded.name === 'CallFailed' && decoded.args.length === 2 && revertBytes(decoded.args[1])) {
      tree.callIndex = ethers.BigNumber.from(decoded.args[0]).toString();
      tree.inner = decode(decoded.args[1], depth + 1);
    }
    return tree;
  }
  return decode(data, 1);
}
