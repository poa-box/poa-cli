/**
 * Statistics Utilities
 * Shared numeric helpers for org analytics commands (audit, health-score).
 */

/**
 * Gini coefficient of a distribution (0 = perfect equality, → 1 = one
 * holder owns everything). Uses the sorted mean-difference formula:
 *   G = Σ (2i - n - 1) * x_i / (n * Σ x_i)   with 1-based i over sorted x.
 * Returns 0 for empty input or when all values sum to 0.
 */
export function computeGini(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  let numerator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (2 * (i + 1) - n - 1) * sorted[i];
  }
  return numerator / (n * total);
}
