import { describe, it, expect } from 'vitest';
import { computeGini } from '../../src/lib/stats';

describe('computeGini', () => {
  it('returns 0 for empty input', () => {
    expect(computeGini([])).toBe(0);
  });

  it('returns 0 for a single value', () => {
    expect(computeGini([42])).toBe(0);
  });

  it('returns 0 for a uniform distribution', () => {
    expect(computeGini([5, 5, 5, 5])).toBe(0);
    expect(computeGini([1, 1, 1, 1, 1, 1])).toBe(0);
  });

  it('returns 0 when all values are zero', () => {
    expect(computeGini([0, 0, 0])).toBe(0);
  });

  it('computes [1,2,3,4,5] → 0.2667', () => {
    expect(computeGini([1, 2, 3, 4, 5])).toBeCloseTo(0.2667, 3);
  });

  it('computes single-holder [0,0,0,0,100] → 0.8', () => {
    expect(computeGini([0, 0, 0, 0, 100])).toBeCloseTo(0.8, 10);
  });

  it('is order-independent', () => {
    expect(computeGini([5, 1, 3, 2, 4])).toBeCloseTo(computeGini([1, 2, 3, 4, 5]), 12);
  });
});
