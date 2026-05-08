import { describe, it, expect } from 'vitest';
import { validateBrainDocShape } from '../../src/lib/brain-schemas';

/**
 * Task #510 (HB#965 sentinel_01) — schema acceptance for the optional
 * delegateTo field. Single ethereum address (0x-prefixed 40-hex), validated
 * for shape; case-insensitive but normalized to lowercase at write time
 * (the writer handles normalization, the schema accepts both).
 */
describe('validateBrainDocShape — Task #510 delegateTo field', () => {
  const baseLesson = {
    id: 'l-1',
    author: '0xabc',
    title: 'Base lesson',
    body: 'Body content.',
    timestamp: 1778229000,
  };

  it('accepts a lesson without delegateTo (backward-compat)', () => {
    const doc = { lessons: [baseLesson] };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a valid lowercase address', () => {
    const doc = {
      lessons: [{ ...baseLesson, delegateTo: '0x451563ab9b5b4e8dfaa602f5e7890089edf6bf10' }],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a valid checksummed address', () => {
    const doc = {
      lessons: [{ ...baseLesson, delegateTo: '0x451563aB9b5b4E8DfaA602f5e7890089EDF6bf10' }],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects an address without 0x prefix', () => {
    const doc = {
      lessons: [{ ...baseLesson, delegateTo: '451563ab9b5b4e8dfaa602f5e7890089edf6bf10' }],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/delegateTo must be a 0x-prefixed 40-hex-char ethereum address/);
  });

  it('rejects an address with wrong length', () => {
    const doc = {
      lessons: [{ ...baseLesson, delegateTo: '0x451563ab' }],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/delegateTo must be a 0x-prefixed 40-hex-char/);
  });

  it('rejects an address with invalid hex chars', () => {
    const doc = {
      lessons: [{ ...baseLesson, delegateTo: '0xZZZ563ab9b5b4e8dfaa602f5e7890089edf6bf10' }],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/delegateTo must be a 0x-prefixed 40-hex-char/);
  });

  it('rejects a number delegateTo', () => {
    const doc = {
      lessons: [{ ...baseLesson, delegateTo: 12345 as any }],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/delegateTo must be a string/);
  });

  it('rejects an object delegateTo', () => {
    const doc = {
      lessons: [{ ...baseLesson, delegateTo: { address: '0x...' } as any }],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/delegateTo must be a string/);
  });

  it('co-exists with causedBy on the same lesson', () => {
    const doc = {
      lessons: [
        {
          ...baseLesson,
          causedBy: 'parent-1',
          delegateTo: '0x451563ab9b5b4e8dfaa602f5e7890089edf6bf10',
        },
      ],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
