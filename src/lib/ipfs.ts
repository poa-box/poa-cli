/**
 * IPFS Client
 * Pin and fetch via The Graph's IPFS endpoint.
 * Uses direct HTTP (FormData) to match frontend behavior.
 */

import { bytes32ToIpfsCid, ipfsCidToBytes32 } from './encoding';
import { IpfsError } from './errors';

const DEFAULT_IPFS_API = 'https://api.thegraph.com/ipfs/api/v0';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/** Public gateways tried in order after the (optional) env override. */
const PUBLIC_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://dweb.link/ipfs/',
];

/** Per-gateway fetch timeout before cascading to the next gateway. */
const GATEWAY_TIMEOUT_MS = 5000;

function getIpfsApiUrl(): string {
  return process.env.POP_IPFS_API_URL || DEFAULT_IPFS_API;
}

/**
 * Gateway cascade order: POP_IPFS_GATEWAY_URL (if set) first, then the
 * public gateways (deduplicated against the env value).
 */
function getGatewayUrls(): string[] {
  const urls: string[] = [];
  const envUrl = process.env.POP_IPFS_GATEWAY_URL;
  if (envUrl) urls.push(envUrl);
  for (const gateway of PUBLIC_GATEWAYS) {
    if (!urls.includes(gateway)) urls.push(gateway);
  }
  return urls;
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = MAX_RETRIES, baseDelay = BASE_DELAY_MS): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Pin JSON content to IPFS via The Graph's endpoint.
 * Uses FormData POST to match frontend behavior exactly.
 * Returns CIDv0 (Qm...) string.
 */
function assertNotReadonly(): void {
  // Pinning publishes content publicly and irreversibly. Read commands can
  // reach here via --pin (org audit-*, leaderboard, portfolio), so this is a
  // genuine external side effect the read-only mode must refuse.
  if (process.env.POP_READONLY === '1') {
    throw new IpfsError(
      'POP_READONLY=1 — refusing to pin: pinning publishes to IPFS publicly and irreversibly.'
    );
  }
}

export async function pinJson(content: string): Promise<string> {
  assertNotReadonly();
  const apiUrl = getIpfsApiUrl();

  const result = await withRetry(async () => {
    // Node 18+ has FormData and Blob globally
    const formData = new FormData();
    formData.append('file', new Blob([content], { type: 'application/octet-stream' }));

    const response = await fetch(`${apiUrl}/add`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`IPFS upload to ${apiUrl}/add failed: ${response.status} ${response.statusText} (pinning endpoint override: POP_IPFS_API_URL)`);
    }

    const data = await response.json();
    return data.Hash as string;
  });

  if (!result.startsWith('Qm')) {
    throw new Error(`Unexpected IPFS CID format: ${result}`);
  }

  return result;
}

/**
 * Pin a file (binary) to IPFS.
 */
export async function pinFile(content: Buffer): Promise<string> {
  assertNotReadonly();
  const apiUrl = getIpfsApiUrl();

  const result = await withRetry(async () => {
    const formData = new FormData();
    formData.append('file', new Blob([content] as any));

    const response = await fetch(`${apiUrl}/add`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`IPFS upload to ${apiUrl}/add failed: ${response.status} ${response.statusText} (pinning endpoint override: POP_IPFS_API_URL)`);
    }

    const data = await response.json();
    return data.Hash as string;
  });

  return result;
}

/**
 * Fetch JSON content from IPFS.
 * Accepts CIDv0 (Qm...) or bytes32 (0x...) hash.
 */
export async function fetchJson<T = any>(hashOrCid: string): Promise<T | null> {
  if (!hashOrCid) return null;

  // Handle zero hashes
  if (hashOrCid.startsWith('0x') && /^0x0+$/.test(hashOrCid)) return null;

  // Convert bytes32 to CID if needed
  let cid = hashOrCid;
  if (hashOrCid.startsWith('0x')) {
    const converted = bytes32ToIpfsCid(hashOrCid);
    if (!converted) return null;
    cid = converted;
  }

  // Two attempts (1 retry) around the FULL gateway cascade
  const result = await withRetry(() => fetchJsonViaGatewayCascade<T>(cid), 2);

  return result;
}

/**
 * Fetch a single CID from one gateway with a hard timeout.
 * Aborts (and cascades) after GATEWAY_TIMEOUT_MS.
 */
async function fetchFromGateway<T>(gatewayUrl: string, cid: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
  try {
    const response = await fetch(`${gatewayUrl}${cid}`, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`IPFS fetch failed: ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    if (text.length > 10 * 1024 * 1024) {
      throw new Error('IPFS response too large (>10MB)');
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Invalid JSON from IPFS (CID: ${cid}). Response starts with: ${text.slice(0, 100)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try each gateway in order, cascading to the next on any failure
 * (HTTP error, timeout/abort, oversized or non-JSON body).
 * Throws IpfsError once every gateway has failed.
 */
async function fetchJsonViaGatewayCascade<T>(cid: string): Promise<T> {
  const gateways = getGatewayUrls();
  const failures: string[] = [];

  for (const gatewayUrl of gateways) {
    try {
      return await fetchFromGateway<T>(gatewayUrl, cid);
    } catch (error: any) {
      const reason = error?.name === 'AbortError'
        ? `timed out after ${GATEWAY_TIMEOUT_MS}ms`
        : (error?.message || String(error));
      failures.push(`${gatewayUrl}: ${reason}`);
    }
  }

  throw new IpfsError(`All ${gateways.length} gateways failed for CID ${cid}. ${failures.join('; ')}`);
}

/** Re-export encoding helpers for convenience */
export { bytes32ToIpfsCid, ipfsCidToBytes32 };
