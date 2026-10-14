import { RawUintInput, requireRawUint } from '../amounts';

/** Graph Int encodes uint32.max as signed -1. This is an indexed-cap exception only. */
export function decodeIndexedAuthorityCap(value: RawUintInput): string {
  return value === -1 || value === '-1' || value === -1n ? '4294967295' : requireRawUint(value, 32);
}
