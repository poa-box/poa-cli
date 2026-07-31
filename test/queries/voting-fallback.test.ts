import { describe, it, expect } from 'vitest';
import { FETCH_VOTING_DATA, FETCH_VOTING_DATA_LEGACY } from '../../src/queries/voting';

/**
 * FETCH_VOTING_DATA_LEGACY is derived from FETCH_VOTING_DATA by deleting the subgraph #195
 * attribution fields, so the two cannot drift apart. But the derivation is a line-anchored
 * regex: it only matches a field sitting alone on its own line. Compact the selection onto one
 * line — the formatting convention used elsewhere in this repo — and the filter matches nothing,
 * the "legacy" tier becomes byte-identical to the modern one, and queryWithFieldFallback retries
 * the same failing document.
 *
 * That failure is silent and it disables the fallback for `pop vote announce-all`, a WRITE that
 * announces winners. These assertions make it loud.
 */
const ATTRIBUTION_FIELDS = [
  'proposer',
  'proposerUsername',
  'creatorUsername',
  'classesVersion',
  'classVersion',
];

const onOwnLine = (doc: string, field: string) =>
  (doc.match(new RegExp(`^\\s*${field}\\s*$`, 'gm')) || []).length;

describe('FETCH_VOTING_DATA_LEGACY — fallback tier integrity', () => {
  it('the modern query actually requests every attribution field, each on its own line', () => {
    // If this fails, the derivation regex has nothing to strip and the legacy tier is a no-op.
    for (const field of ATTRIBUTION_FIELDS) {
      expect(onOwnLine(FETCH_VOTING_DATA, field), `${field} must appear on its own line`).toBeGreaterThan(0);
    }
  });

  it('the legacy query contains none of them', () => {
    for (const field of ATTRIBUTION_FIELDS) {
      expect(onOwnLine(FETCH_VOTING_DATA_LEGACY, field), `${field} must be stripped`).toBe(0);
    }
  });

  it('is genuinely different from — and strictly shorter than — the modern query', () => {
    expect(FETCH_VOTING_DATA_LEGACY).not.toBe(FETCH_VOTING_DATA);
    expect(FETCH_VOTING_DATA_LEGACY.length).toBeLessThan(FETCH_VOTING_DATA.length);
  });

  it('drops only those fields — everything else survives', () => {
    const stripped = (l: string) => ATTRIBUTION_FIELDS.includes(l.trim());
    const expected = FETCH_VOTING_DATA.split('\n').filter((l) => !stripped(l)).join('\n');
    expect(FETCH_VOTING_DATA_LEGACY).toBe(expected);
  });

  it('both tiers are still syntactically balanced GraphQL', () => {
    for (const [name, doc] of [['modern', FETCH_VOTING_DATA], ['legacy', FETCH_VOTING_DATA_LEGACY]] as const) {
      const open = (doc.match(/\{/g) || []).length;
      const close = (doc.match(/\}/g) || []).length;
      expect(open, `${name} brace balance`).toBe(close);
      // A stripped field must never leave an empty selection set, which is invalid GraphQL.
      expect(doc, `${name} has an empty selection set`).not.toMatch(/\{\s*\}/);
    }
  });
});
