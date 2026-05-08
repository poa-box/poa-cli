import { describe, it, expect } from 'vitest';
import { validateBrainDocShape } from '../../src/lib/brain-schemas';

/**
 * Task #509 (HB#963 sentinel_01) — schema acceptance for the optional
 * causedBy field. Locks the contract for the field's accepted shapes
 * and the backward-compat guarantee.
 *
 * The pop brain thread CLI walker is exercised end-to-end against live
 * brain.shared lessons in HB#961 + HB#962 commit messages; not unit-tested
 * here because the walker reads the live CRDT (would need a full doc
 * fixture). The schema is the contract that matters across versions.
 */
describe('validateBrainDocShape — Task #509 causedBy field', () => {
  const baseLesson = {
    id: 'l-1',
    author: '0xabc',
    title: 'Base lesson',
    body: 'Body content.',
    timestamp: 1778210000,
  };

  it('accepts a lesson without causedBy (backward-compat)', () => {
    const doc = { lessons: [baseLesson] };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a single-parent causedBy as a string', () => {
    const doc = {
      lessons: [{ ...baseLesson, causedBy: 'parent-lesson-1' }],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a multi-parent causedBy as a string array', () => {
    const doc = {
      lessons: [
        {
          ...baseLesson,
          causedBy: ['parent-1', 'parent-2', 'parent-3'],
        },
      ],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects an empty-string causedBy', () => {
    const doc = {
      lessons: [{ ...baseLesson, causedBy: '' }],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/causedBy must be a non-empty string id/);
  });

  it('rejects a multi-parent array containing an empty string', () => {
    const doc = {
      lessons: [{ ...baseLesson, causedBy: ['ok-1', ''] }],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/causedBy\[1\] must be a non-empty string id/);
  });

  it('rejects a multi-parent array containing a non-string', () => {
    const doc = {
      lessons: [{ ...baseLesson, causedBy: ['ok', 42] as any }],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/causedBy\[1\] must be a non-empty string id/);
  });

  it('rejects a number causedBy', () => {
    const doc = {
      lessons: [{ ...baseLesson, causedBy: 123 as any }],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/causedBy must be a string or array of strings/);
  });

  it('rejects an object causedBy', () => {
    const doc = {
      lessons: [{ ...baseLesson, causedBy: { parent: 'x' } as any }],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/causedBy must be a string or array of strings/);
  });
});
