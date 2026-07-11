/**
 * TaskManager Permission Bitmask Utilities
 * Parse, format, and describe TaskPerm bitmasks used by the
 * TaskManager contract's per-member permission system.
 */

import { CliError } from './errors';

export const PERM_BITS = {
  create: 1,
  claim: 2,
  review: 4,
  assign: 8,
  'self-review': 16,
  budget: 32,
  'edit-meta': 64,
  'edit-full': 128,
} as const;

export type PermName = keyof typeof PERM_BITS;

const PERM_DESCRIPTIONS: Record<PermName, string> = {
  create: 'create tasks',
  claim: 'claim tasks',
  review: 'review submissions',
  assign: 'assign tasks to others',
  'self-review': 'review own submissions',
  budget: 'edit project budgets',
  'edit-meta': 'edit task metadata post-claim',
  'edit-full': 'edit all task fields post-claim',
};

/**
 * Parse a comma-separated list of permission names into a bitmask.
 * Case-insensitive, whitespace-tolerant. Empty string or 'none' → 0.
 * Throws CliError listing valid names on an unknown permission.
 */
export function parsePermList(input: string): number {
  const trimmed = (input || '').trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'none') return 0;

  let mask = 0;
  for (const part of trimmed.split(',')) {
    const name = part.trim().toLowerCase();
    if (name === '') continue;
    const bit = PERM_BITS[name as PermName];
    if (bit === undefined) {
      throw new CliError(
        `Unknown permission "${name}". Valid permissions: ${Object.keys(PERM_BITS).join(', ')}`
      );
    }
    mask |= bit;
  }
  return mask;
}

/**
 * Format a bitmask as a comma-separated list of permission names.
 * 0 → 'none'. Unrecognized high bits render as 'bitN' (N = bit index).
 */
export function formatMask(mask: number): string {
  if (mask === 0) return 'none';

  const names: string[] = [];
  let known = 0;
  for (const [name, bit] of Object.entries(PERM_BITS)) {
    if (mask & bit) {
      names.push(name);
      known |= bit;
    }
  }
  let remaining = mask & ~known;
  for (let i = 0; remaining !== 0 && i < 32; i++) {
    if (remaining & (1 << i)) {
      names.push(`bit${i}`);
      remaining &= ~(1 << i);
    }
  }
  return names.join(',');
}

/**
 * Describe each set bit of a bitmask as a human-readable sentence.
 * Unknown bits render as 'unknown permission (bitN)'.
 */
export function describeMask(mask: number): string[] {
  const sentences: string[] = [];
  let known = 0;
  for (const [name, bit] of Object.entries(PERM_BITS)) {
    if (mask & bit) {
      sentences.push(PERM_DESCRIPTIONS[name as PermName]);
      known |= bit;
    }
  }
  let remaining = mask & ~known;
  for (let i = 0; remaining !== 0 && i < 32; i++) {
    if (remaining & (1 << i)) {
      sentences.push(`unknown permission (bit${i})`);
      remaining &= ~(1 << i);
    }
  }
  return sentences;
}
