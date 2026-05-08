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
 */

import type { SubscriptionFilter } from './subscriptions';

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
    const lessonTagsLower = lessonTags.map((t) => (typeof t === 'string' ? t.toLowerCase() : ''));
    const hasIntersection = filter.tags.some((t) => lessonTagsLower.includes(t));
    if (!hasIntersection) return false;
  }
  if (filter.titleContains !== undefined) {
    const title = lesson.title;
    if (typeof title !== 'string') return false;
    if (!title.toLowerCase().includes(filter.titleContains.toLowerCase())) return false;
  }
  if (filter.causedByContains !== undefined) {
    const cb = lesson.causedBy;
    if (cb == null) return false;
    if (typeof cb === 'string') {
      if (!cb.includes(filter.causedByContains)) return false;
    } else if (Array.isArray(cb)) {
      const hasMatch = cb.some(
        (c) => typeof c === 'string' && c.includes(filter.causedByContains as string),
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