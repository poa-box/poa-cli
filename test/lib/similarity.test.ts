import { describe, it, expect } from 'vitest';
import { STOPWORDS, tokenize, jaccard, bestMatches } from '../../src/lib/similarity';

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, drops short words', () => {
    expect(tokenize('Implement Merkle-Distribution Engine v2')).toEqual(
      new Set(['implement', 'merkle', 'distribution', 'engine'])
    );
  });

  it('filters default stopwords', () => {
    expect(STOPWORDS.has('task')).toBe(true);
    expect(tokenize('create task proposal vote')).toEqual(new Set());
  });

  it('drops words shorter than default minLen 4', () => {
    expect(tokenize('gas fee abi sync')).toEqual(new Set(['sync']));
  });

  it('respects custom minLen and stopwords', () => {
    expect(tokenize('gas fee', { minLen: 3, stopwords: new Set() })).toEqual(
      new Set(['gas', 'fee'])
    );
    expect(tokenize('merkle engine', { stopwords: new Set(['merkle']) })).toEqual(
      new Set(['engine'])
    );
  });

  it('handles empty/nullish input', () => {
    expect(tokenize('')).toEqual(new Set());
    expect(tokenize(undefined as any)).toEqual(new Set());
  });
});

describe('jaccard', () => {
  it('returns 1 for identical non-empty sets', () => {
    const a = new Set(['merkle', 'distribution', 'engine']);
    expect(jaccard(a, new Set(a))).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(jaccard(new Set(['alpha']), new Set(['beta']))).toBe(0);
  });

  it('returns 0 when both sets are empty', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it('computes overlap / union', () => {
    // shared=2, union=4 → 0.5
    expect(jaccard(new Set(['a1', 'b2', 'c3']), new Set(['a1', 'b2', 'd4']))).toBe(0.5);
  });
});

describe('duplicate-detection heuristic parity (task create)', () => {
  // Mirrors src/commands/task/create.ts: flag when >= 3 shared meaningful
  // words AND jaccard >= 0.5.
  const isDuplicate = (a: string, b: string): boolean => {
    const newWords = tokenize(a);
    if (newWords.size < 3) return false;
    const existingWords = tokenize(b);
    if (existingWords.size === 0) return false;
    const shared = [...newWords].filter(w => existingWords.has(w));
    if (shared.length < 3) return false;
    return jaccard(newWords, existingWords) >= 0.5;
  };

  it('flags identical titles (jaccard = 1)', () => {
    expect(isDuplicate(
      'Implement merkle distribution claiming engine',
      'Implement merkle distribution claiming engine'
    )).toBe(true);
  });

  it('does not flag disjoint titles (jaccard = 0)', () => {
    expect(isDuplicate(
      'Implement merkle distribution claiming engine',
      'Refactor treasury balance monitoring dashboard'
    )).toBe(false);
  });

  it('does not flag below the 3-shared-word floor even at high jaccard', () => {
    // shared = ['merkle', 'distribution'] (2 words), jaccard = 1
    expect(isDuplicate('merkle distribution', 'merkle distribution')).toBe(false);
  });

  it('does not flag when jaccard is below 0.5 despite 3 shared words', () => {
    // shared = 3, union = 7 → jaccard ≈ 0.43
    expect(isDuplicate(
      'merkle distribution engine claiming payout',
      'merkle distribution engine dashboard rollout monitoring'
    )).toBe(false);
  });

  it('flags at exactly jaccard = 0.5 with 3 shared words', () => {
    // shared = 3, union = 6 → jaccard = 0.5
    expect(isDuplicate(
      'merkle distribution engine claiming payout',
      'merkle distribution engine claiming payout dashboard'
    )).toBe(true);
  });
});

describe('bestMatches', () => {
  const items = [
    { id: 1, title: 'Implement merkle distribution claiming engine' },
    { id: 2, title: 'Merkle distribution engine hardening' },
    { id: 3, title: 'Refactor treasury balance monitoring dashboard' },
  ];

  it('ranks by descending jaccard score and excludes zero scores', () => {
    const matches = bestMatches(
      'Implement merkle distribution claiming engine',
      items,
      t => t.title
    );
    expect(matches.map(m => m.item.id)).toEqual([1, 2]);
    expect(matches[0].score).toBe(1);
    expect(matches[1].score).toBeGreaterThan(0);
    expect(matches[1].score).toBeLessThan(1);
  });

  it('applies threshold', () => {
    const matches = bestMatches(
      'Implement merkle distribution claiming engine',
      items,
      t => t.title,
      { threshold: 0.9 }
    );
    expect(matches.map(m => m.item.id)).toEqual([1]);
  });

  it('applies topN', () => {
    const matches = bestMatches(
      'Implement merkle distribution claiming engine',
      items,
      t => t.title,
      { topN: 1 }
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].item.id).toBe(1);
  });

  it('returns empty for empty query or no items', () => {
    expect(bestMatches('', items, t => t.title)).toEqual([]);
    expect(bestMatches('merkle engine', [], (t: any) => t.title)).toEqual([]);
  });
});
