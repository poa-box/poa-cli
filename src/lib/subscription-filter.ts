/**
 * Subscription filter evaluator (Task #513, HB#596).
 *
 * Pure function: given a SubscriptionFilter + a brain lesson, returns
 * true iff all filter keys match. v1 filter language per task #513
 * [CONSTRAINTS]:
 *   - exact-match string fields (lowercased for addresses)
 *   - tags = array intersection (lesson.tags contains ANY filter tag)
 *   - titleContains = case-insensitive substring
 *   - causedByContains = substring on causedBy (string OR array element)
 *   - multiple keys = AND; empty filter = matches all
 *
 * NO regex / negation / OR / body / timestamp in v1.
 *
 * Question-independent layer (vigil HB#596): the matcher is decoupled
 * from how matched events surface in triage output (Q1 priority key,
 * Q4 match-window). Callers decide what to do with matches.
 *
 * HB#636 (vigil HB#605 #513 GAP 2): defensive bounds against adversarial
 * lessons. Brain.shared is a CRDT — any peer can append a lesson with
 * arbitrarily-large title/tags/causedBy and the schema validator only
 * enforces non-empty strings, not maximum sizes. Without bounds in the
 * matcher, every triage cycle would do `huge_title.toLowerCase().includes(...)`
 * against every adversarial lesson — O(N*M) where N=lessons and M=adversarial
 * field size. The caps below truncate at evaluation time so a single
 * gigabyte-title lesson can't slow every agent's heartbeat.
 */

import type { SubscriptionFilter } from './subscriptions';

/**
 * HB#636 GAP 2 defensive limits — caps applied at match time against
 * adversarial lesson fields. Calibrated for human-authored content
 * (titles rarely > 200 chars, tag-lists rarely > 10, causedBy rarely > 5).
 * Tunable if real-world content trips them.
 */
export const MATCH_LIMITS = {
  /** Max chars of lesson.title to scan for substring match. */
  MAX_TITLE_SCAN: 1024,
  /** Max lesson.tags entries to iterate. */
  MAX_TAGS_SCAN: 32,
  /** Max chars of a single lesson tag entry to consider. */
  MAX_TAG_CHARS: 256,
  /** Max lesson.causedBy entries to iterate (when array shape). */
  MAX_CAUSED_BY_SCAN: 32,
  /** Max chars of lesson.causedBy (single string) or each array entry. */
  MAX_CAUSED_BY_CHARS: 256,
} as const;

/**
 * Lesson shape recognized by the matcher. Actual brain.shared lessons
 * have more fields (id, body, timestamp, removed?); the matcher only
 * looks at the fields used by v1 filter keys.
 */
export interface LessonForMatch {
  id?: string;
  author?: string;
  title?: string;
  tags?: string[];
  causedBy?: string | string[];
  delegateTo?: string;
}

/**
 * Returns true iff the lesson matches all keys present in the filter.
 * Empty filter (no keys) returns true for every lesson (matches all).
 */
export function matchesFilter(filter: SubscriptionFilter, lesson: LessonForMatch): boolean {
  if (filter.author !== undefined) {
    const a = lesson.author;
    if (typeof a !== 'string' || a.toLowerCase() !== filter.author) return false;
  }
  if (filter.delegateTo !== undefined) {
    const d = lesson.delegateTo;
    if (typeof d !== 'string' || d.toLowerCase() !== filter.delegateTo) return false;
  }
  if (filter.tags !== undefined && filter.tags.length > 0) {
    const lessonTags = lesson.tags;
    if (!Array.isArray(lessonTags) || lessonTags.length === 0) return false;
    // HB#636 GAP 2: cap scanning of adversarial tag lists.
    const cappedTags = lessonTags.slice(0, MATCH_LIMITS.MAX_TAGS_SCAN);
    const lessonTagsLower = cappedTags.map((t) =>
      typeof t === 'string' ? t.slice(0, MATCH_LIMITS.MAX_TAG_CHARS).toLowerCase() : '',
    );
    const hasIntersection = filter.tags.some((t) => lessonTagsLower.includes(t));
    if (!hasIntersection) return false;
  }
  if (filter.titleContains !== undefined) {
    const title = lesson.title;
    if (typeof title !== 'string') return false;
    // HB#636 GAP 2: cap title scanning. Truncating before lowercasing avoids
    // allocating a huge intermediate string for an adversarial title.
    const titleCapped = title.length > MATCH_LIMITS.MAX_TITLE_SCAN
      ? title.slice(0, MATCH_LIMITS.MAX_TITLE_SCAN)
      : title;
    if (!titleCapped.toLowerCase().includes(filter.titleContains.toLowerCase())) return false;
  }
  if (filter.causedByContains !== undefined) {
    const cb = lesson.causedBy;
    if (cb == null) return false;
    if (typeof cb === 'string') {
      // HB#636 GAP 2: bounded substring scan.
      const cbCapped = cb.length > MATCH_LIMITS.MAX_CAUSED_BY_CHARS
        ? cb.slice(0, MATCH_LIMITS.MAX_CAUSED_BY_CHARS)
        : cb;
      if (!cbCapped.includes(filter.causedByContains)) return false;
    } else if (Array.isArray(cb)) {
      // HB#636 GAP 2: cap array iteration + per-entry char count.
      const cbCapped = cb.slice(0, MATCH_LIMITS.MAX_CAUSED_BY_SCAN);
      const hasMatch = cbCapped.some(
        (c) =>
          typeof c === 'string' &&
          (c.length > MATCH_LIMITS.MAX_CAUSED_BY_CHARS
            ? c.slice(0, MATCH_LIMITS.MAX_CAUSED_BY_CHARS)
            : c
          ).includes(filter.causedByContains as string),
      );
      if (!hasMatch) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Apply a filter to a list of lessons; return matching ones in original
 * order. Convenience wrapper around matchesFilter for the common
 * triage-side use case.
 */
export function filterLessons<T extends LessonForMatch>(filter: SubscriptionFilter, lessons: T[]): T[] {
  return lessons.filter((l) => matchesFilter(filter, l));
}