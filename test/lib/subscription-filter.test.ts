import { describe, it, expect } from 'vitest';
import { matchesFilter, filterLessons, MATCH_LIMITS } from '../../src/lib/subscription-filter';

/**
 * Task #513 (HB#596 vigil_01) — pure-function filter evaluator.
 * Question-independent: the matcher decides "does this lesson match this
 * filter?"; callers decide what to do with matches (priority key, surfacing
 * window, drift detection — all separate concerns).
 */

const argusAddr = '0x451563ab9b5b4e8dfaa602f5e7890089edf6bf10';
const vigilAddr = '0x7150aee7139cb2ac19c98c33c861b99e998b9a8e';
const sentinelAddr = '0xc04c860454e73a9ba524783acbc7f7d6f5767eb6';

describe('matchesFilter — Task #513 v1 filter language', () => {
  it('empty filter matches every lesson', () => {
    expect(matchesFilter({}, { id: 'a', author: argusAddr, title: 'X' })).toBe(true);
    expect(matchesFilter({}, {})).toBe(true);
  });

  it('author matches exact (case-insensitive)', () => {
    const lesson = { author: '0x451563aB9b5b4E8DfaA602f5e7890089EDF6bf10', title: 'X' };
    expect(matchesFilter({ author: argusAddr }, lesson)).toBe(true);
    expect(matchesFilter({ author: vigilAddr }, lesson)).toBe(false);
  });

  it('author returns false when lesson has no author', () => {
    expect(matchesFilter({ author: argusAddr }, { title: 'X' })).toBe(false);
  });

  it('delegateTo matches exact (case-insensitive)', () => {
    const lesson = { author: argusAddr, delegateTo: '0x451563aB9b5b4E8DfaA602f5e7890089EDF6bf10' };
    expect(matchesFilter({ delegateTo: argusAddr }, lesson)).toBe(true);
    expect(matchesFilter({ delegateTo: vigilAddr }, lesson)).toBe(false);
  });

  it('tags matches array intersection (any tag in filter is in lesson)', () => {
    const lesson = { author: argusAddr, tags: ['paymaster', 'sprint20'] };
    expect(matchesFilter({ tags: ['paymaster'] }, lesson)).toBe(true);
    expect(matchesFilter({ tags: ['paymaster', 'governance'] }, lesson)).toBe(true);
    expect(matchesFilter({ tags: ['governance'] }, lesson)).toBe(false);
  });

  it('tags is case-insensitive', () => {
    const lesson = { author: argusAddr, tags: ['Paymaster', 'Sprint20'] };
    expect(matchesFilter({ tags: ['paymaster'] }, lesson)).toBe(true);
  });

  it('tags returns false when lesson has no tags', () => {
    expect(matchesFilter({ tags: ['x'] }, { author: argusAddr })).toBe(false);
    expect(matchesFilter({ tags: ['x'] }, { author: argusAddr, tags: [] })).toBe(false);
  });

  it('titleContains is case-insensitive substring', () => {
    const lesson = { author: argusAddr, title: 'HB#697 vigil HB#593 ACK' };
    expect(matchesFilter({ titleContains: 'vigil' }, lesson)).toBe(true);
    expect(matchesFilter({ titleContains: 'VIGIL' }, lesson)).toBe(true);
    expect(matchesFilter({ titleContains: 'sentinel' }, lesson)).toBe(false);
  });

  it('titleContains returns false when lesson has no title', () => {
    expect(matchesFilter({ titleContains: 'x' }, { author: argusAddr })).toBe(false);
  });

  it('causedByContains matches single-string causedBy', () => {
    const lesson = { author: argusAddr, causedBy: 'hb-593-vigil-catch-up-...-1778249078' };
    expect(matchesFilter({ causedByContains: 'hb-593' }, lesson)).toBe(true);
    expect(matchesFilter({ causedByContains: 'hb-590' }, lesson)).toBe(false);
  });

  it('causedByContains matches array causedBy (any element)', () => {
    const lesson = {
      author: argusAddr,
      causedBy: ['hb-690-...', 'hb-964-...', 'hb-592-...'],
    };
    expect(matchesFilter({ causedByContains: 'hb-964' }, lesson)).toBe(true);
    expect(matchesFilter({ causedByContains: 'hb-592' }, lesson)).toBe(true);
    expect(matchesFilter({ causedByContains: 'hb-101' }, lesson)).toBe(false);
  });

  it('causedByContains returns false when lesson has no causedBy', () => {
    expect(matchesFilter({ causedByContains: 'hb-1' }, { author: argusAddr })).toBe(false);
  });

  it('multiple keys = AND (all must match)', () => {
    const lesson = {
      author: argusAddr,
      title: 'HB#697 vigil HB#593 ACK',
      tags: ['governance'],
    };
    // both match
    expect(matchesFilter({ author: argusAddr, titleContains: 'vigil' }, lesson)).toBe(true);
    // author matches, title doesn't
    expect(matchesFilter({ author: argusAddr, titleContains: 'sentinel' }, lesson)).toBe(false);
    // title matches, author doesn't
    expect(matchesFilter({ author: vigilAddr, titleContains: 'vigil' }, lesson)).toBe(false);
    // all three match
    expect(
      matchesFilter(
        { author: argusAddr, titleContains: 'vigil', tags: ['governance'] },
        lesson,
      ),
    ).toBe(true);
    // tags miss
    expect(
      matchesFilter(
        { author: argusAddr, titleContains: 'vigil', tags: ['paymaster'] },
        lesson,
      ),
    ).toBe(false);
  });

  it('handles a real-shape lesson (HB#697 from the live brain)', () => {
    const lesson = {
      id: 'hb-697-vigil-hb-593-ack-512-step-2-4-shipped-rule-21-now-3-of-1778249252',
      author: argusAddr,
      title:
        'HB#697 vigil HB#593 ACK + #512 step 2/4 SHIPPED — RULE #21 now 3-of-3 endorsed',
      causedBy: 'hb-593-vigil-catch-up-hermes-bundle-post-hoc-validation-2-of-1778249078',
    };
    // vigil watching argus's responses to vigil lessons
    expect(
      matchesFilter(
        { author: argusAddr, causedByContains: 'hb-593-vigil' },
        lesson,
      ),
    ).toBe(true);
  });
});

describe('filterLessons — Task #513 convenience wrapper', () => {
  it('returns matching lessons in original order', () => {
    const lessons = [
      { id: '1', author: argusAddr, title: 'A' },
      { id: '2', author: vigilAddr, title: 'B' },
      { id: '3', author: argusAddr, title: 'C' },
      { id: '4', author: sentinelAddr, title: 'D' },
    ];
    const matched = filterLessons({ author: argusAddr }, lessons);
    expect(matched.map((l) => l.id)).toEqual(['1', '3']);
  });

  it('returns empty array when nothing matches', () => {
    const lessons = [{ id: '1', author: argusAddr, title: 'A' }];
    expect(filterLessons({ author: vigilAddr }, lessons)).toEqual([]);
  });

  it('returns all lessons on empty filter', () => {
    const lessons = [
      { id: '1', author: argusAddr, title: 'A' },
      { id: '2', author: vigilAddr, title: 'B' },
    ];
    expect(filterLessons({}, lessons)).toHaveLength(2);
  });
});

describe('matchesFilter — HB#636 GAP 2 defensive bounds against adversarial lessons', () => {
  it('truncates adversarially-large lesson.title for substring scan', () => {
    // Adversarial title 10x the cap. The substring "needle" is planted past
    // the cap so a correct truncating matcher returns false; a naive matcher
    // would slow-search the entire title and return true.
    const filler = 'x'.repeat(MATCH_LIMITS.MAX_TITLE_SCAN);
    const lesson = { id: '1', author: argusAddr, title: filler + 'needle' };
    expect(matchesFilter({ titleContains: 'needle' }, lesson)).toBe(false);

    // Sanity: when needle is in the first MAX_TITLE_SCAN chars, match.
    const lessonOK = { id: '2', author: argusAddr, title: 'needle' + filler };
    expect(matchesFilter({ titleContains: 'needle' }, lessonOK)).toBe(true);
  });

  it('caps lesson.tags iteration at MAX_TAGS_SCAN entries', () => {
    // Build a tag list past the cap with the matching tag at the END.
    const filler: string[] = [];
    for (let i = 0; i < MATCH_LIMITS.MAX_TAGS_SCAN; i++) filler.push(`junk-${i}`);
    filler.push('targeted-tag');
    const lesson = { id: '1', author: argusAddr, title: 'A', tags: filler };
    expect(matchesFilter({ tags: ['targeted-tag'] }, lesson)).toBe(false);

    // Sanity: when the targeted-tag is within the first MAX_TAGS_SCAN, match.
    const lessonOK = { id: '2', author: argusAddr, title: 'B', tags: ['targeted-tag', ...filler] };
    expect(matchesFilter({ tags: ['targeted-tag'] }, lessonOK)).toBe(true);
  });

  it('truncates oversized individual tag entry to MAX_TAG_CHARS', () => {
    // Tag is too long to fit MAX_TAG_CHARS — gets sliced. Filter looking
    // for the truncated prefix MATCHES; filter for chars-past-the-cap MISSES.
    const tagBase = 'a'.repeat(MATCH_LIMITS.MAX_TAG_CHARS);
    const oversized = tagBase + 'TAIL';
    const lesson = { id: '1', author: argusAddr, title: 'X', tags: [oversized] };

    expect(matchesFilter({ tags: [tagBase.toLowerCase()] }, lesson)).toBe(true);
    expect(matchesFilter({ tags: ['tail'] }, lesson)).toBe(false);
  });

  it('caps causedBy array scan at MAX_CAUSED_BY_SCAN', () => {
    const filler: string[] = [];
    for (let i = 0; i < MATCH_LIMITS.MAX_CAUSED_BY_SCAN; i++) filler.push(`junk-${i}`);
    filler.push('lesson-NEEDLE-1234567890');
    const lesson = { id: '1', author: argusAddr, title: 'X', causedBy: filler };
    expect(matchesFilter({ causedByContains: 'NEEDLE' }, lesson)).toBe(false);

    const lessonOK = {
      id: '2',
      author: argusAddr,
      title: 'X',
      causedBy: ['lesson-NEEDLE-1234567890', ...filler],
    };
    expect(matchesFilter({ causedByContains: 'NEEDLE' }, lessonOK)).toBe(true);
  });

  it('truncates oversized single-string causedBy past MAX_CAUSED_BY_CHARS', () => {
    const filler = 'x'.repeat(MATCH_LIMITS.MAX_CAUSED_BY_CHARS);
    const lessonHidden = { id: '1', author: argusAddr, title: 'X', causedBy: filler + 'NEEDLE' };
    expect(matchesFilter({ causedByContains: 'NEEDLE' }, lessonHidden)).toBe(false);

    const lessonVisible = { id: '2', author: argusAddr, title: 'X', causedBy: 'NEEDLE' + filler };
    expect(matchesFilter({ causedByContains: 'NEEDLE' }, lessonVisible)).toBe(true);
  });

  it('runs in bounded time against pathological adversarial lesson', () => {
    // Lesson with 1MB title + 1000-entry tag list + 1000-entry causedBy.
    // Before HB#636 caps, this would take milliseconds per match call;
    // post-caps it stays under a small constant.
    const adversarial = {
      id: '1',
      author: argusAddr,
      title: 'z'.repeat(1024 * 1024),
      tags: Array(1000).fill('y'.repeat(2048)),
      causedBy: Array(1000).fill('w'.repeat(2048)),
    };
    const filter = {
      titleContains: 'needle',
      tags: ['targeted'],
      causedByContains: 'lesson-x',
    };
    const start = Date.now();
    const result = matchesFilter(filter, adversarial);
    const elapsed = Date.now() - start;
    expect(result).toBe(false); // none of the filters match
    expect(elapsed).toBeLessThan(50); // O(constant), not O(adversarial size)
  });
});