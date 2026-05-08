import { describe, it, expect } from 'vitest';

/**
 * Task #511 + vigil HB#607 follow-up — synthetic test scenarios for the
 * 3-agent-no escalation BLIND-SPOT identified in HB#605 audit.
 *
 * The should-i-claim spec (.claude/skills/should-i-claim/SKILL.md ~line 132)
 * describes the OUTCOME ("if all 3 fleet agents return decision=no over 3
 * consecutive HB cycles, the task is ESCALATED") but no implementation
 * exists for the DETECTION. Per HB#607 proposal, detection is via tagging
 * no-decision lessons with `["should-i-claim:no", "task-<id>"]` then scanning
 * brain.shared for ≥3 such lessons within last 3 HB cycles.
 *
 * These tests fixture the desired DETECTION behavior. Implementation
 * (a ~35-LoC change to .claude/skills/poa-agent-heartbeat/SKILL.md Step 1.6)
 * pending peer-poll resolution per RULE #21. Tests-first: when impl lands,
 * these become the green test for the new behavior.
 *
 * The function under test is currently CONCEPTUAL — encoded here as a
 * pure helper `detect3AgentNoEscalation` that takes a list of brain
 * lessons + task id + current HB number + cycle window + agent count
 * and returns whether escalation should fire.
 */

const TASK_ID = '480';
const HB_CYCLE_SECS = 900; // 15-min cadence
const ARGUS = '0x451563ab9b5b4e8dfaa602f5e7890089edf6bf10';
const VIGIL = '0x7150aee7139cb2ac19c98c33c861b99e998b9a8e';
const SENTINEL = '0xc04c860454e73a9ba524783acbc7f7d6f5767eb6';

interface LessonShape {
  id: string;
  title?: string;
  author: string;
  timestamp: number;
  tags?: string[];
  body?: string;
}

/**
 * Pure-function detector. Caller-supplies lessons (typically from
 * pop.brain.shared) + the task id of the unclaimed-task being evaluated +
 * cycleWindowSecs (typically 3 * 900 = 2700) + agent address set.
 *
 * Returns the lessons matching the no-decision pattern, plus a boolean
 * indicating whether ≥3-of-3 condition is met within the window AND no
 * prior escalation lesson exists for the task.
 *
 * Reference implementation; the actual behavior should live in
 * heartbeat skill Step 1.6 + use `pop brain read --doc pop.brain.shared`
 * as the source of lessons.
 */
function detect3AgentNoEscalation(opts: {
  lessons: LessonShape[];
  taskId: string;
  nowSecs: number;
  cycleWindowSecs: number;
  fleetAddrs: Set<string>;
}): { matchingLessons: LessonShape[]; uniqueAgents: Set<string>; shouldEscalate: boolean; alreadyEscalated: boolean } {
  const { lessons, taskId, nowSecs, cycleWindowSecs, fleetAddrs } = opts;
  const taskTag = `task-${taskId}`;

  // Filter for no-decision lessons within the time window
  const matchingLessons = lessons.filter((l) => {
    if (!l.tags || !Array.isArray(l.tags)) return false;
    if (!l.tags.includes('should-i-claim:no')) return false;
    if (!l.tags.includes(taskTag)) return false;
    if (nowSecs - l.timestamp > cycleWindowSecs) return false;
    if (!fleetAddrs.has(l.author.toLowerCase())) return false;
    return true;
  });

  // Unique agents who said no
  const uniqueAgents = new Set(matchingLessons.map((l) => l.author.toLowerCase()));

  // Check for existing escalation lesson on this task
  const alreadyEscalated = lessons.some(
    (l) =>
      l.tags?.includes('escalation:3-agent-no') &&
      l.tags?.includes(taskTag),
  );

  // Escalate if ≥3 unique fleet agents AND no prior escalation
  const shouldEscalate = uniqueAgents.size >= fleetAddrs.size && !alreadyEscalated;

  return { matchingLessons, uniqueAgents, shouldEscalate, alreadyEscalated };
}

describe('should-i-claim 3-agent-no escalation detection (HB#607 proposal; vigil TDD test fixture)', () => {
  const fleetAddrs = new Set([ARGUS, VIGIL, SENTINEL]);
  const NOW = 1778258000;

  it('Scenario 1: 3-of-3 over 3 HBs → shouldEscalate=true', () => {
    const lessons: LessonShape[] = [
      {
        id: 'hb-A-vigil-no',
        author: VIGIL,
        timestamp: NOW - 2700, // 3 HBs ago
        tags: ['should-i-claim:no', `task-${TASK_ID}`],
      },
      {
        id: 'hb-A1-argus-no',
        author: ARGUS,
        timestamp: NOW - 1800, // 2 HBs ago
        tags: ['should-i-claim:no', `task-${TASK_ID}`],
      },
      {
        id: 'hb-A2-sentinel-no',
        author: SENTINEL,
        timestamp: NOW - 900, // 1 HB ago
        tags: ['should-i-claim:no', `task-${TASK_ID}`],
      },
    ];
    const r = detect3AgentNoEscalation({
      lessons,
      taskId: TASK_ID,
      nowSecs: NOW,
      cycleWindowSecs: 2700,
      fleetAddrs,
    });
    expect(r.uniqueAgents.size).toBe(3);
    expect(r.shouldEscalate).toBe(true);
    expect(r.alreadyEscalated).toBe(false);
  });

  it('Scenario 2: 2-of-3 → shouldEscalate=false (3rd agent should-i-claim runs normally)', () => {
    const lessons: LessonShape[] = [
      {
        id: 'hb-A-vigil-no',
        author: VIGIL,
        timestamp: NOW - 1800,
        tags: ['should-i-claim:no', `task-${TASK_ID}`],
      },
      {
        id: 'hb-A1-argus-no',
        author: ARGUS,
        timestamp: NOW - 900,
        tags: ['should-i-claim:no', `task-${TASK_ID}`],
      },
    ];
    const r = detect3AgentNoEscalation({
      lessons,
      taskId: TASK_ID,
      nowSecs: NOW,
      cycleWindowSecs: 2700,
      fleetAddrs,
    });
    expect(r.uniqueAgents.size).toBe(2);
    expect(r.shouldEscalate).toBe(false);
  });

  it('Scenario 3: same agent twice does not count toward 3-of-3', () => {
    const lessons: LessonShape[] = [
      {
        id: 'hb-A-vigil-no',
        author: VIGIL,
        timestamp: NOW - 1800,
        tags: ['should-i-claim:no', `task-${TASK_ID}`],
      },
      {
        id: 'hb-A1-vigil-no-again',
        author: VIGIL, // SAME agent
        timestamp: NOW - 900,
        tags: ['should-i-claim:no', `task-${TASK_ID}`],
      },
    ];
    const r = detect3AgentNoEscalation({
      lessons,
      taskId: TASK_ID,
      nowSecs: NOW,
      cycleWindowSecs: 2700,
      fleetAddrs,
    });
    expect(r.uniqueAgents.size).toBe(1);
    expect(r.shouldEscalate).toBe(false);
  });

  it('Scenario 4: different task ids do not cross-contaminate', () => {
    const lessons: LessonShape[] = [
      {
        id: 'hb-A-vigil-no-481',
        author: VIGIL,
        timestamp: NOW - 1800,
        tags: ['should-i-claim:no', 'task-481'], // different task!
      },
      {
        id: 'hb-A-argus-no-480',
        author: ARGUS,
        timestamp: NOW - 1800,
        tags: ['should-i-claim:no', `task-${TASK_ID}`],
      },
    ];
    const r = detect3AgentNoEscalation({
      lessons,
      taskId: TASK_ID,
      nowSecs: NOW,
      cycleWindowSecs: 2700,
      fleetAddrs,
    });
    // Only argus's lesson matches task 480; vigil's was for task 481
    expect(r.uniqueAgents.size).toBe(1);
    expect(r.uniqueAgents.has(ARGUS)).toBe(true);
    expect(r.shouldEscalate).toBe(false);
  });

  it('Scenario 5: stale lessons (outside cycle window) do not count', () => {
    const lessons: LessonShape[] = [
      // 4 HBs ago — outside 3-cycle window
      {
        id: 'hb-old-vigil-no',
        author: VIGIL,
        timestamp: NOW - 4 * 900,
        tags: ['should-i-claim:no', `task-${TASK_ID}`],
      },
      {
        id: 'hb-A-argus-no',
        author: ARGUS,
        timestamp: NOW - 1800,
        tags: ['should-i-claim:no', `task-${TASK_ID}`],
      },
      {
        id: 'hb-A1-sentinel-no',
        author: SENTINEL,
        timestamp: NOW - 900,
        tags: ['should-i-claim:no', `task-${TASK_ID}`],
      },
    ];
    const r = detect3AgentNoEscalation({
      lessons,
      taskId: TASK_ID,
      nowSecs: NOW,
      cycleWindowSecs: 2700,
      fleetAddrs,
    });
    // vigil's lesson is too old; only argus + sentinel inside window
    expect(r.uniqueAgents.size).toBe(2);
    expect(r.shouldEscalate).toBe(false);
  });

  it('Scenario 6: existing escalation lesson suppresses re-escalation (anti-spam)', () => {
    const lessons: LessonShape[] = [
      {
        id: 'hb-A-vigil-no',
        author: VIGIL,
        timestamp: NOW - 2700,
        tags: ['should-i-claim:no', `task-${TASK_ID}`],
      },
      {
        id: 'hb-A1-argus-no',
        author: ARGUS,
        timestamp: NOW - 1800,
        tags: ['should-i-claim:no', `task-${TASK_ID}`],
      },
      {
        id: 'hb-A2-sentinel-no',
        author: SENTINEL,
        timestamp: NOW - 900,
        tags: ['should-i-claim:no', `task-${TASK_ID}`],
      },
      {
        // Already-fired escalation
        id: 'hb-A2-escalation',
        author: SENTINEL,
        timestamp: NOW - 800,
        tags: ['escalation:3-agent-no', `task-${TASK_ID}`],
      },
    ];
    const r = detect3AgentNoEscalation({
      lessons,
      taskId: TASK_ID,
      nowSecs: NOW,
      cycleWindowSecs: 2700,
      fleetAddrs,
    });
    expect(r.uniqueAgents.size).toBe(3);
    expect(r.alreadyEscalated).toBe(true);
    expect(r.shouldEscalate).toBe(false); // suppressed by alreadyEscalated
  });

  it('Scenario 7: non-fleet author no-lesson does not count', () => {
    const lessons: LessonShape[] = [
      {
        id: 'hb-A-stranger',
        author: '0x1234567890abcdef1234567890abcdef12345678',
        timestamp: NOW - 1800,
        tags: ['should-i-claim:no', `task-${TASK_ID}`],
      },
      {
        id: 'hb-A-argus-no',
        author: ARGUS,
        timestamp: NOW - 900,
        tags: ['should-i-claim:no', `task-${TASK_ID}`],
      },
    ];
    const r = detect3AgentNoEscalation({
      lessons,
      taskId: TASK_ID,
      nowSecs: NOW,
      cycleWindowSecs: 2700,
      fleetAddrs,
    });
    // Stranger's lesson filtered out
    expect(r.uniqueAgents.size).toBe(1);
    expect(r.uniqueAgents.has(ARGUS)).toBe(true);
    expect(r.shouldEscalate).toBe(false);
  });
});