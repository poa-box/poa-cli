import { describe, it, expect } from 'vitest';
import {
  FETCH_ZKEMAIL_MODULE,
  FETCH_ZKEMAIL_MODULE_LEGACY,
  FETCH_ZKEMAIL_MODULE_TIERS,
} from '../../src/queries/zkemail';

/**
 * The modern tier requests fields that only exist after subgraph-pop #197 (module wiring +
 * the DKIM registry). A GraphQL document validates as a whole, so against a deployment that
 * predates it the ENTIRE query fails — every `pop zkemail` command would break.
 *
 * FETCH_ZKEMAIL_MODULE_LEGACY is derived from the modern query by deletion so the two cannot
 * drift, but that derivation is line-based: reformat the selection onto one line and it
 * silently stops stripping anything, leaving the "fallback" identical to the tier it is
 * supposed to rescue. These assertions make that failure loud.
 */
const POST_197_FIELDS = [
  'executor',
  'domainVerifier',
  'emailVerifier',
  'accountRegistry',
  'universalFactory',
  'claimCount',
];

const onOwnLine = (doc: string, field: string) =>
  (doc.match(new RegExp(`^\\s*${field}\\s*$`, 'gm')) || []).length;

describe('zkemail query tiers', () => {
  it('the modern tier requests every post-#197 field, each on its own line', () => {
    // If a field stops being on its own line the derivation below silently no-ops.
    for (const f of POST_197_FIELDS) {
      expect(onOwnLine(FETCH_ZKEMAIL_MODULE, f), `${f} must be on its own line`).toBeGreaterThan(0);
    }
    expect(FETCH_ZKEMAIL_MODULE).toContain('dkimRegistry {');
  });

  it('the legacy tier contains none of them', () => {
    for (const f of POST_197_FIELDS) {
      expect(onOwnLine(FETCH_ZKEMAIL_MODULE_LEGACY, f), `${f} must be stripped`).toBe(0);
    }
    expect(FETCH_ZKEMAIL_MODULE_LEGACY).not.toContain('dkimRegistry');
    // The nested key selection must go with it, not be left orphaned.
    expect(FETCH_ZKEMAIL_MODULE_LEGACY).not.toContain('keyHash');
    expect(FETCH_ZKEMAIL_MODULE_LEGACY).not.toContain('validUntil');
  });

  it('keeps the allowlist selection the legacy shape still serves', () => {
    for (const f of ['activeRoot', 'activeAllowlistCid', 'identifierHash', 'hatIds']) {
      expect(FETCH_ZKEMAIL_MODULE_LEGACY).toContain(f);
    }
  });

  it('is genuinely different from, and shorter than, the modern tier', () => {
    expect(FETCH_ZKEMAIL_MODULE_LEGACY).not.toBe(FETCH_ZKEMAIL_MODULE);
    expect(FETCH_ZKEMAIL_MODULE_LEGACY.length).toBeLessThan(FETCH_ZKEMAIL_MODULE.length);
  });

  it('both tiers are brace-balanced with no empty selection set', () => {
    for (const [name, doc] of [['modern', FETCH_ZKEMAIL_MODULE], ['legacy', FETCH_ZKEMAIL_MODULE_LEGACY]] as const) {
      expect((doc.match(/\{/g) || []).length, `${name} brace balance`).toBe((doc.match(/\}/g) || []).length);
      // Stripping a block must not leave `foo { }`, which is invalid GraphQL.
      expect(doc, `${name} has an empty selection set`).not.toMatch(/\{\s*\}/);
    }
  });

  it('orders tiers modern-first so the richer shape wins once #197 is live', () => {
    expect(FETCH_ZKEMAIL_MODULE_TIERS).toEqual([FETCH_ZKEMAIL_MODULE, FETCH_ZKEMAIL_MODULE_LEGACY]);
  });
});
