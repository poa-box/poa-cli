import { describe, it, expect } from 'vitest';
import { PERM_BITS, parsePermList, formatMask, describeMask } from '../../src/lib/perms';
import { CliError } from '../../src/lib/errors';

describe('PERM_BITS', () => {
  it('covers all 8 TaskPerm bits', () => {
    const bits = Object.values(PERM_BITS);
    expect(bits).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);
  });
});

describe('parsePermList', () => {
  it('parses single names', () => {
    expect(parsePermList('create')).toBe(1);
    expect(parsePermList('claim')).toBe(2);
    expect(parsePermList('edit-full')).toBe(128);
  });

  it('parses comma-separated lists', () => {
    expect(parsePermList('create,claim')).toBe(3);
    expect(parsePermList('create,claim,review,assign')).toBe(15);
    expect(parsePermList('self-review,budget,edit-meta')).toBe(16 + 32 + 64);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(parsePermList(' Create , CLAIM ')).toBe(3);
    expect(parsePermList('EDIT-FULL')).toBe(128);
  });

  it('returns 0 for empty string and "none"', () => {
    expect(parsePermList('')).toBe(0);
    expect(parsePermList('none')).toBe(0);
    expect(parsePermList('  ')).toBe(0);
  });

  it('throws CliError listing valid names on unknown permission', () => {
    expect(() => parsePermList('create,frobnicate')).toThrow(CliError);
    expect(() => parsePermList('frobnicate')).toThrow(/frobnicate/);
    expect(() => parsePermList('frobnicate')).toThrow(/create, claim, review, assign, self-review, budget, edit-meta, edit-full/);
  });
});

describe('formatMask', () => {
  it('formats known masks', () => {
    expect(formatMask(3)).toBe('create,claim');
    expect(formatMask(128)).toBe('edit-full');
    expect(formatMask(255)).toBe('create,claim,review,assign,self-review,budget,edit-meta,edit-full');
  });

  it('formats 0 as none', () => {
    expect(formatMask(0)).toBe('none');
  });

  it('renders unknown high bits as bitN', () => {
    expect(formatMask(256)).toBe('bit8');
    expect(formatMask(1 | 512)).toBe('create,bit9');
  });
});

describe('round-trips', () => {
  it('parsePermList(formatMask(m)) === m for known masks', () => {
    for (const m of [0, 1, 3, 7, 15, 16, 42, 100, 128, 255]) {
      expect(parsePermList(formatMask(m))).toBe(m);
    }
  });

  it('formatMask(parsePermList(s)) === s for canonical lists', () => {
    for (const s of ['create,claim', 'edit-full', 'none', 'review,budget']) {
      expect(formatMask(parsePermList(s))).toBe(s);
    }
  });
});

describe('describeMask', () => {
  it('describes each set bit in order', () => {
    expect(describeMask(3)).toEqual(['create tasks', 'claim tasks']);
    expect(describeMask(255)).toEqual([
      'create tasks',
      'claim tasks',
      'review submissions',
      'assign tasks to others',
      'review own submissions',
      'edit project budgets',
      'edit task metadata post-claim',
      'edit all task fields post-claim',
    ]);
  });

  it('returns empty array for 0', () => {
    expect(describeMask(0)).toEqual([]);
  });

  it('flags unknown bits', () => {
    expect(describeMask(256)).toEqual(['unknown permission (bit8)']);
  });
});
