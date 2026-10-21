/** Validated copies: callers retain ownership of their input arrays. */
export interface ValidatedVoteVector {
  weights: readonly number[];
  optionIndices?: readonly number[];
}

/**
 * Strict protocol validation, independent of wallet/UI and legacy tx builders.
 * Weights are integer percentages totaling 100. Supplied option indices must
 * pair one-to-one with weights and be unique nonnegative safe integers.
 * Hosts own member-facing error copy and proposal-specific option bounds.
 */
export function requireValidVoteWeights(weights: readonly number[], optionIndices?: readonly number[]): ValidatedVoteVector {
  if (!Array.isArray(weights) || weights.length === 0) throw new Error('Vote weights must be a nonempty array');
  let total = 0;
  for (const weight of weights) {
    if (!Number.isInteger(weight) || weight < 0 || weight > 100) throw new Error('Vote weights must be finite integer numbers in 0..100');
    total += weight;
  }
  if (total !== 100) throw new Error(`Vote weights must total 100 (got ${total})`);
  if (optionIndices === undefined) return { weights: [...weights] };
  if (!Array.isArray(optionIndices) || optionIndices.length !== weights.length) throw new Error('Option indices must match vote weights');
  const seen = new Set<number>();
  for (const index of optionIndices) {
    if (!Number.isSafeInteger(index) || index < 0 || seen.has(index)) throw new Error('Option indices must be unique nonnegative safe integers');
    seen.add(index);
  }
  return { weights: [...weights], optionIndices: [...optionIndices] };
}
