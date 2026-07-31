/**
 * Unit test for task #358: `pop brain migrate --merge` dedup helper.
 *
 * The helper `computeMergeDelta` extracts the merge-mode dedup logic
 * out of the command handler so it can be tested independently of the
 * Automerge doc / brain daemon layer. The live end-to-end verification
 * (39 added, 20 skipped against argus's real replica + the committed
 * 59-entry generated.md) is covered in the task submission; this file
 * pins the pure logic so future edits to merge semantics stay correct.
 */

import { describe, it, expect } from 'vitest';
import { computeMergeDelta } from '../../src/commands/brain/migrate';

describe('computeMergeDelta — task #358 merge dedup', () => {
  it('returns all parsed entries when existing is empty', () => {
    const existing: Array<{ id: string }> = [];
    const parsed = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const delta = computeMergeDelta(existing, parsed);
    expect(delta.toAdd).toHaveLength(3);
    expect(delta.skippedCount).toBe(0);
  });

  it('returns empty toAdd when all parsed ids already exist', () => {
    const existing = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const parsed = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const delta = computeMergeDelta(existing, parsed);
    expect(delta.toAdd).toHaveLength(0);
    expect(delta.skippedCount).toBe(3);
  });

  it('partial overlap: adds only the new ids', () => {
    const existing = [{ id: 'a' }, { id: 'b' }];
    const parsed = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const delta = computeMergeDelta(existing, parsed);
    expect(delta.toAdd.map(e => (e as any).id)).toEqual(['c', 'd']);
    expect(delta.skippedCount).toBe(2);
  });

  it('preserves non-id fields on the entries it returns', () => {
    const existing = [{ id: 'a', body: 'old' }];
    const parsed = [
      { id: 'a', body: 'new-body-would-be-skipped' },
      { id: 'b', body: 'new-b' },
    ];
    const delta = computeMergeDelta(existing, parsed);
    expect(delta.toAdd).toHaveLength(1);
    expect((delta.toAdd[0] as any).id).toBe('b');
    expect((delta.toAdd[0] as any).body).toBe('new-b');
    // The 'a' entry's new body is dropped — dedup is id-only, we don't
    // reconcile content diffs for existing ids.
    expect(delta.skippedCount).toBe(1);
  });

  it('entries without an id are always added (cannot dedup what has no key)', () => {
    const existing = [{ id: 'a' }];
    const parsed = [
      { id: undefined as any, body: 'keyless-1' } as any,
      { id: 'a' },
      { id: undefined as any, body: 'keyless-2' } as any,
    ];
    const delta = computeMergeDelta(existing, parsed);
    // The 'a' entry is skipped; both keyless entries are added.
    expect(delta.toAdd).toHaveLength(2);
    expect(delta.skippedCount).toBe(1);
  });

  it('idempotent: running the delta twice after applying it adds zero', () => {
    // Simulates the real merge flow: compute delta, apply toAdd into
    // existing, then re-compute. The second pass should find nothing new.
    const existing: Array<{ id: string }> = [{ id: 'a' }];
    const parsed = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

    const first = computeMergeDelta(existing, parsed);
    expect(first.toAdd).toHaveLength(2);

    const afterFirst = [...existing, ...first.toAdd];
    const second = computeMergeDelta(afterFirst, parsed);
    expect(second.toAdd).toHaveLength(0);
    expect(second.skippedCount).toBe(3);
  });

  it('realistic #358 acceptance shape: 20-overlap + 39-new = 59 parsed', () => {
    // Mirrors the real HB#359 scenario: argus had 20 lessons locally, the
    // committed generated.md had 59, overlap was 20, new content was 39.
    const existing = Array.from({ length: 20 }, (_, i) => ({ id: `shared-${i}` }));
    const parsed = [
      // The 20 shared ids are a subset of parsed.
      ...Array.from({ length: 20 }, (_, i) => ({ id: `shared-${i}` })),
      // 39 brand-new ids.
      ...Array.from({ length: 39 }, (_, i) => ({ id: `new-${i}` })),
    ];
    const delta = computeMergeDelta(existing, parsed);
    expect(delta.toAdd).toHaveLength(39);
    expect(delta.skippedCount).toBe(20);
  });
});
