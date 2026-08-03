/**
 * Text Similarity Utilities
 * Tokenization + Jaccard similarity used for duplicate detection
 * (e.g. `pop task create` warns when a similar task title exists).
 */

/**
 * Default stopwords: English filler + common CLI/governance scaffolding words
 * that carry no signal when comparing task titles.
 */
export const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'that', 'this',
  'task', 'tasks', 'create', 'build', 'make', 'add', 'new', 'fix',
  'command', 'commands', 'update', 'updates', 'support', 'test',
  'cli', 'pop', 'org', 'orgs', 'run', 'use', 'using', 'via', 'like',
  'proposal', 'proposals', 'vote', 'votes', 'write', 'generate',
]);

/**
 * Tokenize a string into a set of meaningful lowercase words.
 * Splits on non-alphanumerics, drops words shorter than `minLen`
 * (default 4), and filters out stopwords (default STOPWORDS).
 */
export function tokenize(
  s: string,
  opts?: { minLen?: number; stopwords?: Set<string> }
): Set<string> {
  const minLen = opts?.minLen ?? 4;
  const stopwords = opts?.stopwords ?? STOPWORDS;
  const words = (s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= minLen);
  return new Set(words.filter(w => !stopwords.has(w)));
}

/**
 * Jaccard similarity between two token sets: |intersection| / |union|.
 * Returns 0 when the union is empty.
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  let shared = 0;
  for (const w of a) {
    if (b.has(w)) shared++;
  }
  return shared / union.size;
}

/**
 * Rank `items` by Jaccard similarity of their text against `queryText`.
 * Returns matches with score >= threshold (default 0, exclusive of
 * zero-score items), sorted descending, capped at topN (default all).
 */
export function bestMatches<T>(
  queryText: string,
  items: T[],
  getText: (t: T) => string,
  opts?: { threshold?: number; topN?: number }
): Array<{ item: T; score: number }> {
  const threshold = opts?.threshold ?? 0;
  const topN = opts?.topN ?? items.length;
  const queryTokens = tokenize(queryText);
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const score = jaccard(queryTokens, tokenize(getText(item)));
    if (score > 0 && score >= threshold) {
      scored.push({ item, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}
