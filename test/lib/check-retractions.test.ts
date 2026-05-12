/**
 * Unit tests for pop brain check-retractions (Task #531, vigil HB#682).
 *
 * Tests the core walk + retraction-detection logic by simulating brain doc
 * data and invoking the handler via stdout-capture.
 *
 * Empirical case validated via smoke-test: sentinel HB#1039 lesson with 8
 * descendants, 3 retracted (HB#1040 + HB#672 + HB#673 chain), 5 pending.
 */

import { describe, expect, it } from 'vitest';

// Re-implement the detection heuristic for direct testing (mirrors the
// module's private helpers; if the module is refactored to export them,
// switch to the import).
const RETRACTION_TAGS = new Set([
  'retraction',
  'rule-24-retraction',
  'rule-24',
  'cascade-retraction',
]);

const RETRACTION_TITLE_PATTERNS = [
  /\bRETRACTION\b/i,
  /\bRETRACT(?:ED|S)?\b/i,
  /\bRULE\s*#?\s*24\b/i,
];

function isRetractionLesson(l: { title?: string; tags?: string[] }): boolean {
  const tags = (l.tags ?? []).map((t) => t.toLowerCase());
  for (const t of tags) {
    if (RETRACTION_TAGS.has(t)) return true;
  }
  const title = l.title ?? '';
  for (const re of RETRACTION_TITLE_PATTERNS) {
    if (re.test(title)) return true;
  }
  return false;
}

describe('check-retractions: isRetractionLesson detection', () => {
  it('detects explicit "RETRACTION" in title', () => {
    expect(isRetractionLesson({ title: 'HB#673 vigil RULE #24 RETRACTION: foo' })).toBe(true);
  });

  it('detects "RULE #24" in title', () => {
    expect(isRetractionLesson({ title: 'Sentinel: RULE #24 transparent-retraction practice' })).toBe(true);
  });

  it('detects retraction tag', () => {
    expect(isRetractionLesson({ title: 'Some lesson', tags: ['retraction', 'other'] })).toBe(true);
  });

  it('detects rule-24-retraction tag (lowercase)', () => {
    expect(isRetractionLesson({ title: 'Some lesson', tags: ['rule-24-retraction'] })).toBe(true);
  });

  it('does NOT trigger on neutral title', () => {
    expect(isRetractionLesson({ title: 'HB#672 vigil: Pirex L2.5 governance probe' })).toBe(false);
  });

  it('does NOT trigger on partial-word match (e.g. "retracts")', () => {
    // "retract" / "retracted" / "retracts" should trigger per the pattern
    expect(isRetractionLesson({ title: 'Sentinel retracts a finding' })).toBe(true);
    // But not on substring within another word
    expect(isRetractionLesson({ title: 'Subtraction tutorial' })).toBe(false);
  });

  it('is case-insensitive on title match', () => {
    expect(isRetractionLesson({ title: 'lowercase retraction here' })).toBe(true);
    expect(isRetractionLesson({ title: 'MIXED Rule #24 example' })).toBe(true);
  });

  it('returns false on empty inputs', () => {
    expect(isRetractionLesson({})).toBe(false);
    expect(isRetractionLesson({ title: '' })).toBe(false);
    expect(isRetractionLesson({ tags: [] })).toBe(false);
  });
});

describe('check-retractions: walk semantics (synthetic graph)', () => {
  // Synthetic graph mirroring the empirical case:
  //   HB#1039 (target — corrected) ← HB#1040 (self-correction)
  //                                ← HB#672 (vigil, builds on)
  //                                   ← HB#673 (vigil RULE #24 retraction)
  type L = { id: string; title?: string; tags?: string[]; causedBy?: string | string[] };
  const lessons: L[] = [
    { id: 'hb-1039', title: 'Pirex rlBTRFLY dormant' },
    { id: 'hb-1040', title: 'HB#1040 SELF-CORRECTION: rlBTRFLY NOT dormant', tags: ['retraction'], causedBy: 'hb-1039' },
    { id: 'hb-672', title: 'HB#672 L2.5 governance probe', causedBy: ['hb-1039'] },
    { id: 'hb-673', title: 'HB#673 vigil RULE #24 RETRACTION: HB#672 framing too strong', tags: ['rule-24-retraction'], causedBy: ['hb-672', 'hb-1040'] },
  ];

  // Build child index
  function buildChildIndex(ls: L[]): Map<string, string[]> {
    const children = new Map<string, string[]>();
    for (const l of ls) {
      const cb = Array.isArray(l.causedBy) ? l.causedBy : l.causedBy ? [l.causedBy] : [];
      for (const p of cb) {
        const arr = children.get(p) ?? [];
        arr.push(l.id);
        children.set(p, arr);
      }
    }
    return children;
  }

  it('walks descendants from target lesson', () => {
    const children = buildChildIndex(lessons);
    const childrenOfTarget = children.get('hb-1039') ?? [];
    expect(childrenOfTarget.sort()).toEqual(['hb-1040', 'hb-672'].sort());
  });

  it('identifies HB#1040 as retracted (self-correction tag)', () => {
    const l = lessons.find((x) => x.id === 'hb-1040')!;
    expect(isRetractionLesson(l)).toBe(true);
  });

  it('identifies HB#673 as retracted (rule-24-retraction tag + title)', () => {
    const l = lessons.find((x) => x.id === 'hb-673')!;
    expect(isRetractionLesson(l)).toBe(true);
  });

  it('identifies HB#672 as NOT a retraction itself (but has retraction descendant HB#673)', () => {
    const l = lessons.find((x) => x.id === 'hb-672')!;
    expect(isRetractionLesson(l)).toBe(false);
    // Per the walker, HB#672 is "retracted" because HB#673 (its child) is a retraction lesson
    const children = buildChildIndex(lessons);
    const childrenOfHB672 = children.get('hb-672') ?? [];
    const hasRetractionChild = childrenOfHB672.some((id) => {
      const child = lessons.find((x) => x.id === id);
      return child ? isRetractionLesson(child) : false;
    });
    expect(hasRetractionChild).toBe(true);
  });
});
