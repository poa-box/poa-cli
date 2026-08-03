/**
 * IPFS Client — CLI wrapper over @poa/core/ipfs.
 *
 * Pin/fetch (Graph IPFS endpoint, gateway cascade, retries, CIDv0 guard) live
 * in core, environment-free. The CLI binds the historical env vars per call:
 * POP_IPFS_API_URL, POP_IPFS_GATEWAY_URL, and POP_READONLY=1 (which refuses
 * pinning — publishing to IPFS is public and irreversible).
 */

import {
  pinJson as corePinJson,
  pinFile as corePinFile,
  fetchJson as coreFetchJson,
  ipfsOptionsFromEnv,
  bytes32ToIpfsCid,
  ipfsCidToBytes32,
} from '@poa/core/ipfs';
import type { IpfsOptions } from '@poa/core/ipfs';

export { bytes32ToIpfsCid, ipfsCidToBytes32, ipfsOptionsFromEnv };
export type { IpfsOptions };

function envOpts(): IpfsOptions {
  return ipfsOptionsFromEnv(process.env);
}

/**
 * Pin JSON content to IPFS via The Graph's endpoint.
 * Uses FormData POST to match frontend behavior exactly.
 * Returns CIDv0 (Qm...) string.
 */
export async function pinJson(content: string): Promise<string> {
  return corePinJson(content, envOpts());
}

/** Pin a file (binary) to IPFS. */
export async function pinFile(content: Buffer): Promise<string> {
  return corePinFile(content, envOpts());
}

/**
 * Fetch JSON content from IPFS.
 * Accepts CIDv0 (Qm...) or bytes32 (0x...) hash.
 */
export async function fetchJson<T = any>(hashOrCid: string): Promise<T | null> {
  return coreFetchJson<T>(hashOrCid, envOpts());
}
