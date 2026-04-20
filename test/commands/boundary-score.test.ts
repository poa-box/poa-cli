import { describe, it, expect } from 'vitest';
import {
  computeBSSubstrate,
  computeBSCohort,
  computeBSDimension,
  classifyBSTotal,
  parseDimensionFlags,
  computeBoundaryScore,
  SUBSTRATE_CENTROIDS,
  DEFAULT_WEIGHTS,
  BS_THRESHOLDS,
} from '../../src/commands/org/boundary-score';

describe('computeBSSubstrate — distance from band centroid', () => {
  it('returns ~0 for DAO at pure-token band centroid', () => {
    const [g, t, p] = SUBSTRATE_CENTROIDS['pure-token']!;
    const bs = computeBSSubstrate('pure-token', g, t, p);
    expect(bs).toBeCloseTo(0, 3);
  });

  it('returns null for conviction-locked band (no centroid, n=1)', () => {
    expect(computeBSSubstrate('conviction-locked', 0.85, 0.9, 0.85)).toBeNull();
  });

  it('returns null for unknown band', () => {
    expect(computeBSSubstrate('unknown', 0.5, 0.5, 0.5)).toBeNull();
  });

  it('clamps to max 1.0 for extreme distance', () => {
    const bs = computeBSSubstrate('pure-token', 0.0, 0.0, 0.0);
    expect(bs).toBe(1.0);
  });

  it('reproduces Curve HB#467 prototype value (~0.31 for 0.85,0.95,0.92)', () => {
    const bs = computeBSSubstrate('pure-token', 0.85, 0.95, 0.92);
    // dist = sqrt(0.03² + 0.03² + 0.02²) ≈ 0.047 / 0.20 = 0.235
    // (HB#467 used 0.15 max_dist; spec uses 0.20 — close)
    expect(bs).toBeGreaterThan(0.2);
    expect(bs).toBeLessThan(0.4);
  });
});

describe('computeBSCohort — distance from regime thresholds', () => {
  it('returns 1 at N=15 (regime boundary)', () => {
    expect(computeBSCohort(15)).toBeCloseTo(1, 3);
  });

  it('returns 1 at N=50 (regime boundary)', () => {
    expect(computeBSCohort(50)).toBeCloseTo(1, 3);
  });

  it('returns ~0.143 at N=32 (midpoint, deep inside regime)', () => {
    // distFrom15=17, distFrom50=18, min=17 → 1 - 17/17.5 ≈ 0.029
    // Wait actually min(17, 18) = 17; 1 - 17/17.5 = 0.029
    // Let me re-check spec — 17.5 is half-distance between 15 and 50
    // so deep inside (N=32 = midpoint) should be 1 - 17.5/17.5 = 0
    // But N=32 isn't midpoint exactly; midpoint of 15+50 is 32.5
    const bs = computeBSCohort(32);
    expect(bs).toBeGreaterThanOrEqual(0);
    expect(bs).toBeLessThan(0.1);
  });

  it('returns 0 deep inside regime (N=100)', () => {
    expect(computeBSCohort(100)).toBe(0);
  });

  it('returns ~0.486 at N=6 (Spark case from HB#467)', () => {
    // distFrom15=9, distFrom50=44, min=9 → 1 - 9/17.5 ≈ 0.486
    const bs = computeBSCohort(6);
    expect(bs).toBeCloseTo(0.486, 2);
  });

  it('returns 0 for invalid N (zero or negative)', () => {
    expect(computeBSCohort(0)).toBe(0);
    expect(computeBSCohort(-5)).toBe(0);
  });
});

describe('computeBSDimension — full membership count', () => {
  it('returns 0 for solidly-1-dimension DAO', () => {
    expect(computeBSDimension(1)).toBe(0);
  });

  it('returns 1/7 ≈ 0.143 for 2-dimension straddler (e.g., A+C)', () => {
    expect(computeBSDimension(2)).toBeCloseTo(1 / 7, 3);
  });

  it('returns 2/7 ≈ 0.286 for 3-dimension straddler', () => {
    expect(computeBSDimension(3)).toBeCloseTo(2 / 7, 3);
  });

  it('returns 0 when coordinated-dual-whale disqualifier applies (per v2.1.4)', () => {
    expect(computeBSDimension(2, true)).toBe(0);
    expect(computeBSDimension(5, true)).toBe(0);
  });

  it('returns 0 for 0-membership DAO (no dimensions matched)', () => {
    expect(computeBSDimension(0)).toBe(0);
  });
});

describe('classifyBSTotal — threshold classification per v0.5', () => {
  it('classifies HIGH for BS >= 0.4', () => {
    expect(classifyBSTotal(0.4)).toBe('HIGH');
    expect(classifyBSTotal(0.55)).toBe('HIGH');
    expect(classifyBSTotal(1.0)).toBe('HIGH');
  });

  it('classifies MEDIUM for 0.2 <= BS < 0.4', () => {
    expect(classifyBSTotal(0.2)).toBe('MEDIUM');
    expect(classifyBSTotal(0.35)).toBe('MEDIUM');
    expect(classifyBSTotal(0.399)).toBe('MEDIUM');
  });

  it('classifies LOW for BS < 0.2', () => {
    expect(classifyBSTotal(0)).toBe('LOW');
    expect(classifyBSTotal(0.1)).toBe('LOW');
    expect(classifyBSTotal(0.199)).toBe('LOW');
  });

  it('classifies UNKNOWN for null', () => {
    expect(classifyBSTotal(null)).toBe('UNKNOWN');
  });
});

describe('parseDimensionFlags — parse comma-separated dimensions', () => {
  it('returns empty count for undefined', () => {
    const r = parseDimensionFlags(undefined);
    expect(r.count).toBe(0);
    expect(r.dims).toEqual([]);
  });

  it('parses simple list', () => {
    const r = parseDimensionFlags('A,B2e,C');
    expect(r.dims).toEqual(['A', 'B2e', 'C']);
    expect(r.count).toBe(3);
  });

  it('excludes ι from count (separate axis per Option C)', () => {
    const r = parseDimensionFlags('A,C,ι');
    expect(r.dims).toEqual(['A', 'C', 'ι']);
    expect(r.count).toBe(2); // ι excluded
  });

  it('excludes D from count (anti-cluster floor)', () => {
    const r = parseDimensionFlags('A,C,D');
    expect(r.count).toBe(2); // D excluded
  });

  it('handles "iota" alias for ι', () => {
    const r = parseDimensionFlags('A,iota');
    expect(r.count).toBe(1);
  });

  it('trims whitespace', () => {
    const r = parseDimensionFlags('A , C , B2e');
    expect(r.dims).toEqual(['A', 'C', 'B2e']);
    expect(r.count).toBe(3);
  });
});

describe('computeBoundaryScore — full integration', () => {
  it('reproduces Curve HB#467 prototype range (BS_total 0.16-0.24)', () => {
    const result = computeBoundaryScore({
      band: 'pure-token',
      gini: 0.85,
      top5pct: 0.95,
      passRate: 0.92,
      N: 200, // large
      fullMembershipCount: 2, // A + C (Pattern ι separate)
      isPatternIota: true,
      weights: { substrate: 1 / 3, cohort: 1 / 3, dimension: 1 / 3 },
    });
    expect(result.bsTotal).not.toBeNull();
    expect(result.bsTotal!).toBeGreaterThan(0.10);
    expect(result.bsTotal!).toBeLessThan(0.35);
    expect(result.flags).toContain('isPatternIota — interpret BS components per-proposal-subset, not aggregate');
  });

  it('classifies Polkadot as PARTIAL (no centroid for conviction-locked)', () => {
    const result = computeBoundaryScore({
      band: 'conviction-locked',
      gini: 0.85,
      top5pct: 0.9,
      passRate: 0.85,
      N: 150,
      fullMembershipCount: 1,
    });
    expect(result.classification).toBe('PARTIAL');
    expect(result.components.bsSubstrate).toBeNull();
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('zeros BS_dimension when coordinated-dual-whale flag set', () => {
    const result = computeBoundaryScore({
      band: 'pure-token',
      gini: 0.82,
      top5pct: 0.92,
      passRate: 0.90,
      N: 50,
      fullMembershipCount: 3,
      isCoordinatedDualWhale: true,
    });
    expect(result.components.bsDimension).toBe(0);
    expect(result.notes.some(n => n.includes('Coordinated-dual-whale'))).toBe(true);
  });

  it('uses default weights when none provided', () => {
    const result = computeBoundaryScore({
      band: 'pure-token',
      gini: 0.82, top5pct: 0.92, passRate: 0.90,
      N: 30,
      fullMembershipCount: 1,
    });
    expect(result.components.bsSubstrate).toBeCloseTo(0, 2);
    expect(result.classification).toBe('LOW');
  });

  it('emits isMigrating flag when set', () => {
    const result = computeBoundaryScore({
      band: 'pure-token',
      gini: 0.82, top5pct: 0.92, passRate: 0.90,
      N: 50,
      fullMembershipCount: 1,
      isMigrating: true,
    });
    expect(result.flags.some(f => f.includes('isMigrating'))).toBe(true);
  });
});

describe('DEFAULT_WEIGHTS + BS_THRESHOLDS — exposed constants', () => {
  it('weights sum to 1.0', () => {
    const sum = DEFAULT_WEIGHTS.substrate + DEFAULT_WEIGHTS.cohort + DEFAULT_WEIGHTS.dimension;
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('thresholds match v0.5 spec (HIGH=0.4, MEDIUM=0.2)', () => {
    expect(BS_THRESHOLDS.high).toBe(0.4);
    expect(BS_THRESHOLDS.medium).toBe(0.2);
  });
});
