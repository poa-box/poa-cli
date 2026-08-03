/**
 * Contract Utilities
 * ABI lookup from the generated registry (no fs — browser-pure) and
 * ethers Contract construction helpers.
 */

import { ethers } from 'ethers';
import { ALL_ABIS, EXTERNAL_ABIS } from './abis';

/**
 * Look up an ABI by its historical abi/ file base name (e.g. 'TaskManagerNew').
 * Searches first-party POP ABIs, then the third-party probe-target ABIs.
 *
 * Returns a mutable-typed array (the registry consts are readonly) so ethers v5
 * Interface construction typechecks.
 */
export function getAbi(name: string): any[] {
  const abi = ALL_ABIS[name] ?? EXTERNAL_ABIS[name];
  if (!abi) {
    throw new Error(`ABI not found: ${name}. Check that packages/core/src/abis exports it (yarn gen-abis).`);
  }
  return abi as any[];
}

/** Back-compat alias — the CLI's fs-based loader was named loadAbi. */
export const loadAbi = getAbi;

/**
 * Create a read-only contract instance.
 */
export function createReadContract(
  address: string,
  abiName: string,
  provider: ethers.providers.Provider
): ethers.Contract {
  return new ethers.Contract(address, getAbi(abiName), provider);
}

/**
 * Create a writable contract instance (with signer).
 */
export function createWriteContract(
  address: string,
  abiName: string,
  signer: ethers.Signer
): ethers.Contract {
  return new ethers.Contract(address, getAbi(abiName), signer);
}
