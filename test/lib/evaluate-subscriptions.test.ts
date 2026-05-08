import { describe, it, expect } from 'vitest';
import { evaluateSubscriptions, type SubscriptionsFile } from '../../src/lib/subscriptions';

/**
 * Task #513 (HB#600 vigil_01) — pure-function evaluateSubscriptions
 * tests per argus HB#702-correction finding 3.
 *
 * The function lives in src/lib/subscriptions.ts; processSubscriptions
 * in src/commands/agent/triage.ts is the I/O wrapper. These tests
 * exercise the pure logic against synthetic doc fixtures.
 *
 * 7 test cases per argus's enumeration:
 *  (a) absent / empty subscriptions → 0 actions
 *  (b) single subscription with matching filter → PRIORITY_0 action
 *  (c) only-new gate skips already-matched lessons
 *  (d) all-matches=true bypasses the only-new gate
 *  (e) Drift detection emits INFO when ageSecs > driftThreshold * cycleSecs
 *  (f) Per-subscription throw doesn't break loop (best-effort isolation)
 *  (g) Mutation tracking: matched subs return mutated=true; unmatched return false
 */

const ARGUS = '0x451563ab9b5b4e8dfaa602f5e7890089edf6bf10';
const VIGIL = '0x7150aee7139cb2ac19c98c33c861b99e998b9a8e';

function makeFile(subs: any[]): SubscriptionsFile {
  return { version: 1, subscriptions: subs };
}

function makeLesson(id: string, opts: any = {}) {
  return {
    id,
    author: opts.author ?? ARGUS,
    title: opts.title ?? `Lesson ${id}`,
    body: opts.body ?? '',
    timestamp: opts.timestamp ?? 1778250000,
    tags: opts.tags,
    causedBy: opts.causedBy,
    delegateTo: opts.delegateTo,
    removed: opts.removed,
  };
}

describe('evaluateSubscriptions — Task #513 pure-function logic (HB#600 per argus HB#702-correction)', () => {
  it('(a) returns 0 actions when subscriptions array is empty', () => {
    const file = makeFile([]);
    const docs = new Map<string, any>();
    const { actions, mutated } = evaluateSubscriptions(file, docs);
    expect(actions).toEqual([]);
    expect(mutated).toBe(false);
  });

  it('(a-2) returns 0 actions when subscriptions exist but no docs are cached', () => {
    const file = makeFile([
      { id: 'sub1', docId: 'pop.brain.shared', filter: { author: ARGUS }, matchCount: 0, lastMatchAt: null, lastMatchedLessonId: null },
    ]);
    const docs = new Map<string, any>(); // empty cache
    const { actions, mutated } = evaluateSubscriptions(file, docs);
    expect(actions).toEqual([]);
    expect(mutated).toBe(false);
  });

  it('(b) single matching subscription returns 1 PRIORITY_0 subscription-match action', () => {
    const file = makeFile([
      { id: 'sub1', docId: 'pop.brain.shared', filter: { author: ARGUS }, matchCount: 0, lastMatchAt: null, lastMatchedLessonId: null },
    ]);
    const docs = new Map<string, any>([
      [
        'pop.brain.shared',
        {
          lessons: [
            makeLesson('l1', { author: ARGUS, title: 'A', timestamp: 100 }),
            makeLesson('l2', { author: VIGIL, title: 'B', timestamp: 200 }),
            makeLesson('l3', { author: ARGUS, title: 'C', timestamp: 300 }),
          ],
        },
      ],
    ]);
    const { actions, mutated } = evaluateSubscriptions(file, docs);
    expect(actions).toHaveLength(1);
    expect(actions[0].priority).toBe('PRIORITY_0');
    expect(actions[0].type).toBe('subscription-match');
    expect(actions[0].data.lessonIds).toEqual(['l1', 'l3']);
    expect(actions[0].detail).toContain('matched 2 lesson(s)');
    expect(actions[0].detail).toContain('A; C');
    expect(mutated).toBe(true);
    // State updated to most recent matched lesson
    expect(file.subscriptions[0].lastMatchedLessonId).toBe('l3');
    expect(file.subscriptions[0].lastMatchAt).toBe(300);
    expect(file.subscriptions[0].matchCount).toBe(2);
  });

  it('(c) only-new gate skips lessons already at-or-before lastMatchedLessonId', () => {
    const file = makeFile([
      {
        id: 'sub1',
        docId: 'pop.brain.shared',
        filter: { author: ARGUS },
        matchCount: 1,
        lastMatchAt: 100,
        lastMatchedLessonId: 'l1', // already saw l1
      },
    ]);
    const docs = new Map<string, any>([
      [
        'pop.brain.shared',
        {
          lessons: [
            makeLesson('l1', { author: ARGUS, timestamp: 100 }),
            makeLesson('l2', { author: VIGIL, timestamp: 200 }),
            makeLesson('l3', { author: ARGUS, timestamp: 300 }),
          ],
        },
      ],
    ]);
    const { actions, mutated } = evaluateSubscriptions(file, docs);
    expect(actions).toHaveLength(1);
    expect(actions[0].data.lessonIds).toEqual(['l3']); // only l3 is new
    expect(file.subscriptions[0].lastMatchedLessonId).toBe('l3');
    expect(file.subscriptions[0].matchCount).toBe(2); // 1 prior + 1 new
    expect(mutated).toBe(true);
  });

  it('(c-2) only-new gate emits 0 actions when no lessons are newer than lastMatchedLessonId', () => {
    const file = makeFile([
      {
        id: 'sub1',
        docId: 'pop.brain.shared',
        filter: { author: ARGUS },
        matchCount: 1,
        lastMatchAt: 300,
        lastMatchedLessonId: 'l3',
      },
    ]);
    const docs = new Map<string, any>([
      [
        'pop.brain.shared',
        {
          lessons: [
            makeLesson('l1', { author: ARGUS, timestamp: 100 }),
            makeLesson('l3', { author: ARGUS, timestamp: 300 }),
          ],
        },
      ],
    ]);
    const { actions, mutated } = evaluateSubscriptions(file, docs);
    expect(actions).toEqual([]);
    expect(mutated).toBe(false);
  });

  it('(d) allMatches=true bypasses the only-new gate', () => {
    const file = makeFile([
      {
        id: 'sub1',
        docId: 'pop.brain.shared',
        filter: { author: ARGUS },
        matchCount: 0,
        lastMatchAt: 100,
        lastMatchedLessonId: 'l1', // would normally suppress l1
      },
    ]);
    const docs = new Map<string, any>([
      [
        'pop.brain.shared',
        {
          lessons: [
            makeLesson('l1', { author: ARGUS, timestamp: 100 }),
            makeLesson('l2', { author: ARGUS, timestamp: 200 }),
          ],
        },
      ],
    ]);
    const { actions } = evaluateSubscriptions(file, docs, { allMatches: true });
    expect(actions).toHaveLength(1);
    expect(actions[0].data.lessonIds).toEqual(['l1', 'l2']);
  });

  it('(e) drift detection emits INFO when ageSecs/cycleSecs >= driftThreshold', () => {
    const NOW = 1778250000;
    const file = makeFile([
      {
        id: 'sub1',
        docId: 'pop.brain.shared',
        filter: { author: ARGUS },
        matchCount: 5,
        lastMatchAt: NOW - 60 * 60 * 24, // 24h ago = 96 cycles at 15-min cadence
        lastMatchedLessonId: 'l-old',
        driftThreshold: 50, // 50 cycles ≈ 12.5h
      },
    ]);
    const docs = new Map<string, any>([
      ['pop.brain.shared', { lessons: [makeLesson('l-old', { author: VIGIL, timestamp: 1 })] }], // no current match for this filter
    ]);
    const { actions, mutated } = evaluateSubscriptions(file, docs, { nowSecs: NOW });
    expect(actions).toHaveLength(1);
    expect(actions[0].priority).toBe('INFO');
    expect(actions[0].type).toBe('subscription-drift');
    expect(actions[0].detail).toContain('96 HB cycles');
    expect(actions[0].detail).toContain('threshold: 50');
    expect(mutated).toBe(false);
  });

  it('(e-2) drift detection respects custom heartbeatIntervalMinutes', () => {
    const NOW = 1778250000;
    const file = makeFile([
      {
        id: 'sub1',
        docId: 'pop.brain.shared',
        filter: { author: ARGUS },
        matchCount: 5,
        lastMatchAt: NOW - 60 * 60, // 1h ago. At 5-min cadence = 12 cycles. At 15-min = 4 cycles.
        lastMatchedLessonId: 'l-old',
        driftThreshold: 10,
      },
    ]);
    const docs = new Map<string, any>([
      ['pop.brain.shared', { lessons: [makeLesson('l-old', { author: VIGIL, timestamp: 1 })] }],
    ]);
    // At 5-min cadence (12 cycles), threshold 10 → drift triggered
    const r1 = evaluateSubscriptions(file, docs, { nowSecs: NOW, heartbeatIntervalMinutes: 5 });
    expect(r1.actions).toHaveLength(1);
    expect(r1.actions[0].type).toBe('subscription-drift');
    expect(r1.actions[0].detail).toContain('12 HB cycles');
    // At 15-min cadence (4 cycles), threshold 10 → NO drift
    const r2 = evaluateSubscriptions(file, docs, { nowSecs: NOW, heartbeatIntervalMinutes: 15 });
    expect(r2.actions).toEqual([]);
  });

  it('(f) per-subscription bad-shape lesson does NOT break the loop (best-effort isolation)', () => {
    const file = makeFile([
      { id: 'sub1', docId: 'pop.brain.shared', filter: { author: ARGUS }, matchCount: 0, lastMatchAt: null, lastMatchedLessonId: null },
      { id: 'sub2', docId: 'pop.brain.shared', filter: { author: VIGIL }, matchCount: 0, lastMatchAt: null, lastMatchedLessonId: null },
    ]);
    const docs = new Map<string, any>([
      [
        'pop.brain.shared',
        {
          lessons: [
            makeLesson('l1', { author: ARGUS, timestamp: 100 }),
            null, // bad-shape entry
            makeLesson('l2', { author: VIGIL, timestamp: 200 }),
            makeLesson('l3', { author: ARGUS, removed: true }), // filtered out by removed flag
          ],
        },
      ],
    ]);
    const { actions } = evaluateSubscriptions(file, docs);
    // Both subscriptions should produce actions; bad lesson is skipped by !l.removed && l.id filter
    expect(actions).toHaveLength(2);
    const sub1 = actions.find((a: any) => a.data.subscriptionId === 'sub1');
    const sub2 = actions.find((a: any) => a.data.subscriptionId === 'sub2');
    expect(sub1?.data.lessonIds).toEqual(['l1']);
    expect(sub2?.data.lessonIds).toEqual(['l2']);
  });

  it('(g) mutation tracking: matched subs → mutated=true; unmatched-only → mutated=false', () => {
    const NOW = 1778250000;
    // Case 1: matched + new ⇒ mutated=true
    const file1 = makeFile([
      { id: 'sub1', docId: 'pop.brain.shared', filter: { author: ARGUS }, matchCount: 0, lastMatchAt: null, lastMatchedLessonId: null },
    ]);
    const docs1 = new Map<string, any>([
      ['pop.brain.shared', { lessons: [makeLesson('l1', { author: ARGUS, timestamp: 100 })] }],
    ]);
    const r1 = evaluateSubscriptions(file1, docs1, { nowSecs: NOW });
    expect(r1.mutated).toBe(true);
    expect(file1.subscriptions[0].matchCount).toBe(1);

    // Case 2: matched but no new (lastMatchedLessonId == latest) ⇒ mutated=false
    const file2 = makeFile([
      {
        id: 'sub2',
        docId: 'pop.brain.shared',
        filter: { author: ARGUS },
        matchCount: 1,
        lastMatchAt: 100,
        lastMatchedLessonId: 'l1',
      },
    ]);
    const r2 = evaluateSubscriptions(file2, docs1, { nowSecs: NOW });
    expect(r2.mutated).toBe(false);
    expect(file2.subscriptions[0].matchCount).toBe(1); // unchanged

    // Case 3: drift-only (no matches; ageSecs > threshold) ⇒ mutated=false (drift WARN doesn't mutate state)
    const file3 = makeFile([
      {
        id: 'sub3',
        docId: 'pop.brain.shared',
        filter: { author: VIGIL },
        matchCount: 0,
        lastMatchAt: NOW - 86400, // 24h ago
        lastMatchedLessonId: null,
        driftThreshold: 1,
      },
    ]);
    const docs3 = new Map<string, any>([
      ['pop.brain.shared', { lessons: [makeLesson('l1', { author: ARGUS })] }], // no VIGIL lessons
    ]);
    const r3 = evaluateSubscriptions(file3, docs3, { nowSecs: NOW });
    expect(r3.mutated).toBe(false);
    expect(r3.actions).toHaveLength(1);
    expect(r3.actions[0].type).toBe('subscription-drift');
  });
});