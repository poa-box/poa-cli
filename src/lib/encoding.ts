/**
 * Encoding Utilities
 * Direct port of frontend encoding.js for byte-identical behavior.
 * Uses ethers v5 + bs58 v6 to match frontend exactly.
 */

import { ethers } from 'ethers';
import bs58 from 'bs58';
import { CliError } from './errors';

export function stringToBytes(str: string): Uint8Array {
  return ethers.utils.toUtf8Bytes(str);
}

export function bytesToString(bytes: Uint8Array): string {
  return ethers.utils.toUtf8String(bytes);
}

export function stringToBytes32(str: string): string {
  if (!str) return ethers.constants.HashZero;
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(str));
}

/**
 * Encode IPFS CIDv0 (Qm...) to bytes32.
 * CIDv0 = base58(0x1220 + 32-byte-sha256-hash)
 * We store just the 32-byte hash portion.
 */
export function ipfsCidToBytes32(cid: string): string {
  if (!cid || cid === '') {
    return ethers.constants.HashZero;
  }

  if (!cid.startsWith('Qm')) {
    if (cid.startsWith('0x') && cid.length === 66) {
      return cid;
    }
    return stringToBytes32(cid);
  }

  try {
    const decoded = bs58.decode(cid);
    if (decoded.length !== 34) {
      console.error(`Invalid CIDv0 length: expected 34 bytes, got ${decoded.length}`);
      return ethers.constants.HashZero;
    }
    const hashBytes = decoded.slice(2);
    return ethers.utils.hexlify(hashBytes);
  } catch (error) {
    console.error('Failed to encode IPFS CID to bytes32:', error);
    return ethers.constants.HashZero;
  }
}

/**
 * Decode bytes32 back to IPFS CIDv0.
 */
export function bytes32ToIpfsCid(bytes32Hash: string): string | null {
  if (!bytes32Hash || bytes32Hash === ethers.constants.HashZero) return null;

  try {
    const hashBytes = ethers.utils.arrayify(bytes32Hash);
    const withPrefix = new Uint8Array([0x12, 0x20, ...hashBytes]);
    return bs58.encode(withPrefix);
  } catch (error) {
    console.warn('Failed to decode bytes32 to IPFS CID:', error);
    return null;
  }
}

/**
 * Parse a task ID from subgraph format.
 * Subgraph returns IDs like "contractAddress-taskId", contract expects numeric taskId.
 */
export function parseTaskId(taskId: string | number): string {
  const taskIdStr = taskId.toString();
  const result = taskIdStr.includes('-') ? taskIdStr.split('-')[1] : taskIdStr;
  if (!result) {
    throw new Error(`Invalid task ID format: "${taskId}"`);
  }
  return result;
}

export function parseModuleId(moduleId: string | number): string {
  const moduleIdStr = moduleId.toString();
  const result = moduleIdStr.includes('-') ? moduleIdStr.split('-')[1] : moduleIdStr;
  if (!result) {
    throw new Error(`Invalid module ID format: "${moduleId}"`);
  }
  return result;
}

/**
 * Parse a project ID from subgraph format.
 * Subgraph: "{contractAddress}-{projectId}" where projectId is bytes32 hex.
 */
export function parseProjectId(projectId: string): string {
  if (!projectId) {
    return ethers.constants.HashZero;
  }

  if (projectId.startsWith('0x') && projectId.length === 66) {
    return projectId;
  }

  const subgraphPattern = /^0x[a-fA-F0-9]{40}-(.+)$/;
  const match = projectId.match(subgraphPattern);

  if (match) {
    const extractedId = match[1];
    if (extractedId.startsWith('0x') && extractedId.length === 66) {
      return extractedId;
    }
    if (/^[a-fA-F0-9]+$/.test(extractedId)) {
      return ethers.utils.hexZeroPad('0x' + extractedId, 32);
    }
  }

  return stringToBytes32(projectId);
}

export function formatAddress(address: string, chars = 4): string {
  if (!address) return '';
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

export function isValidAddress(address: string): boolean {
  return ethers.utils.isAddress(address);
}

export function toChecksumAddress(address: string): string {
  return ethers.utils.getAddress(address);
}

/** Contracts store deadlines as uint48. */
const UINT48_MAX = 2 ** 48 - 1;
/** Contracts store durations as uint32. */
const UINT32_MAX = 2 ** 32 - 1;

const DURATION_MULTIPLIERS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/**
 * Parse a deadline expression into unix seconds.
 *
 * Accepted forms:
 *   - ''or '0'            → 0 (no deadline)
 *   - relative            → '7d', '48h', '90m', '3600s' (added to `now`)
 *   - unix seconds        → bare digits >= 10^9, e.g. '1790000000'
 *   - ISO date            → '2026-08-01' (treated as UTC midnight)
 *   - ISO datetime        → '2026-08-01T12:30:00' or '...Z' / '...+02:00'
 *                           (no timezone suffix → treated as UTC)
 *
 * Throws CliError when the input is unparseable, exceeds the uint48
 * range, or resolves to a timestamp at/before `now`.
 */
export function parseDeadline(input: string, now?: number): number {
  const nowSecs = now ?? Math.floor(Date.now() / 1000);
  const trimmed = (input || '').trim();
  if (trimmed === '' || trimmed === '0') return 0;

  let result: number;

  const relative = trimmed.match(/^(\d+)([smhd])$/i);
  if (relative) {
    result = nowSecs + parseInt(relative[1], 10) * DURATION_MULTIPLIERS[relative[2].toLowerCase()];
  } else if (/^\d+$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    if (num < 1e9) {
      throw new CliError(
        `Ambiguous deadline "${input}": bare numbers must be unix-second timestamps (>= 1000000000).`,
        1,
        'Use a relative deadline like "7d" or "48h", an ISO date like "2026-08-01", or a full unix timestamp.'
      );
    }
    result = num;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const ms = Date.parse(`${trimmed}T00:00:00Z`);
    if (Number.isNaN(ms)) {
      throw new CliError(`Invalid date "${input}".`, 1, 'Use an ISO date like "2026-08-01".');
    }
    result = Math.floor(ms / 1000);
  } else if (/^\d{4}-\d{2}-\d{2}[T ]/.test(trimmed)) {
    const normalized = trimmed.replace(' ', 'T');
    // No timezone suffix → treat as UTC for deterministic behavior
    const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
    const ms = Date.parse(hasTz ? normalized : `${normalized}Z`);
    if (Number.isNaN(ms)) {
      throw new CliError(`Invalid datetime "${input}".`, 1, 'Use ISO format like "2026-08-01T12:30:00Z".');
    }
    result = Math.floor(ms / 1000);
  } else {
    throw new CliError(
      `Unparseable deadline "${input}".`,
      1,
      'Use a relative deadline ("7d", "48h", "90m", "3600s"), an ISO date ("2026-08-01"), a unix timestamp, or "0" for no deadline.'
    );
  }

  if (result > UINT48_MAX) {
    throw new CliError(`Deadline "${input}" exceeds the uint48 range (max ${UINT48_MAX}).`);
  }
  if (result <= nowSecs) {
    throw new CliError(
      `Deadline "${input}" is in the past (resolved to ${formatDeadline(result)}).`,
      1,
      'Pick a future date, or pass "0" for no deadline.'
    );
  }
  return result;
}

/**
 * Parse a duration expression into seconds.
 * Accepts bare seconds ('3600') or s/m/h/d suffixes ('48h', '7d').
 * '0' → 0. Throws CliError when unparseable or above the uint32 max.
 */
export function parseDurationSeconds(input: string): number {
  const trimmed = (input || '').trim();
  if (trimmed === '0') return 0;

  let seconds: number;
  const relative = trimmed.match(/^(\d+)([smhd])$/i);
  if (relative) {
    seconds = parseInt(relative[1], 10) * DURATION_MULTIPLIERS[relative[2].toLowerCase()];
  } else if (/^\d+$/.test(trimmed)) {
    seconds = parseInt(trimmed, 10);
  } else {
    throw new CliError(
      `Unparseable duration "${input}".`,
      1,
      'Use bare seconds ("3600") or a suffix: "3600s", "90m", "48h", "7d".'
    );
  }

  if (seconds > UINT32_MAX) {
    throw new CliError(`Duration "${input}" exceeds the uint32 range (max ${UINT32_MAX} seconds).`);
  }
  return seconds;
}

/**
 * Format a unix-second deadline as 'YYYY-MM-DD HH:mm UTC'.
 * 0 (no deadline) → 'none'.
 */
export function formatDeadline(unixSecs: number): string {
  if (!unixSecs) return 'none';
  const d = new Date(unixSecs * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
