/**
 * pop task view — v6 Deadlines section, v7 release history, applicant lens.
 *
 * `task view` reads deadline data straight from the chain (getTaskOnChain)
 * because the deployed subgraph does not index it. These tests verify:
 *   - v6 orgs get a Deadlines section with countdowns and a derived-state
 *     sentence (expired claim → takeover hint; on-track → submission due)
 *   - pre-v6 orgs (no deadline fields in the lens tuple) omit the section
 *   - the Releases section renders self- vs force-releases, and keeps
 *     rendering on a released task (whose assignee is null by then)
 *   - the release-history round-trip only fires when releaseCount > 0
 *   - a chain whose subgraph lacks the release fields falls through cleanly
 *   - JSON output only ADDS fields (absoluteDeadline, completionWindow,
 *     claimDeadline, claimState, applicants, release keys) — legacy unchanged
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryWithFieldFallback: vi.fn(),
  resolveOrgId: vi.fn(),
  resolveOrgModules: vi.fn(),
  resolveNetworkConfig: vi.fn(),
  getTaskOnChain: vi.fn(),
  getTaskApplicants: vi.fn(),
  fetchJson: vi.fn(),
  isJsonMode: vi.fn(() => false),
  json: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/lib/subgraph', () => ({
  query: mocks.query,
  queryWithFieldFallback: mocks.queryWithFieldFallback,
}));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgId: mocks.resolveOrgId,
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: vi.fn(),
}));
vi.mock('../../src/config/networks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/networks')>();
  return { ...actual, resolveNetworkConfig: mocks.resolveNetworkConfig };
});
vi.mock('../../src/lib/task-lens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/task-lens')>();
  // deriveClaimState + TASK_STATUS stay REAL; only the RPC readers are mocked.
  return {
    ...actual,
    getTaskOnChain: mocks.getTaskOnChain,
    getTaskApplicants: mocks.getTaskApplicants,
  };
});
vi.mock('../../src/lib/ipfs', () => ({ fetchJson: mocks.fetchJson }));
vi.mock('../../src/lib/output', () => {
  const makeSpinner = () => {
    const s: any = { text: '' };
    s.start = () => s;
    s.stop = () => s;
    s.succeed = () => s;
    s.fail = () => s;
    return s;
  };
  return {
    spinner: vi.fn(makeSpinner),
    success: vi.fn(),
    error: mocks.error,
    warn: vi.fn(),
    info: vi.fn(),
    table: vi.fn(),
    json: mocks.json,
    isJsonMode: mocks.isJsonMode,
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import { viewHandler } from '../../src/commands/task/view';
import { formatDeadline } from '../../src/lib/encoding';

const TM_ADDR = '0x1111111111111111111111111111111111111111';
const ORG_ID = '0x' + 'ab'.repeat(32);
const APPLICANT_1 = '0x' + 'a1'.repeat(20);
const APPLICANT_2 = '0x' + 'b2'.repeat(20);
const WORKER = '0x' + '22'.repeat(20);
const SLACKER = '0x' + 'c3'.repeat(20);
const PM = '0x' + 'd4'.repeat(20);
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const DAY = 86400;

function sgTask(overrides: Record<string, any> = {}) {
  return {
    id: `${TM_ADDR}-7`,
    taskId: '7',
    title: 'Fix the relayer',
    status: 'Assigned',
    payout: ethers.utils.parseUnits('10', 18).toString(),
    bountyToken: ethers.constants.AddressZero,
    bountyPayout: '0',
    assignee: WORKER,
    assigneeUsername: 'worker',
    assignedAt: String(NOW - 12 * HOUR),
    rejectionCount: '0',
    rejections: [],
    applications: [],
    requiresApplication: false,
    metadata: { name: 'Fix the relayer', description: 'It is broken' },
    createdAt: String(NOW - DAY),
    ...overrides,
  };
}

function subgraphFixture(task = sgTask()) {
  return {
    organization: {
      taskManager: {
        id: TM_ADDR,
        projects: [{ id: `${TM_ADDR}-0x01`, title: 'Core', tasks: [task] }],
      },
    },
  };
}

function sgRelease(overrides: Record<string, any> = {}) {
  return {
    id: `${TM_ADDR}-7-0`,
    previousClaimer: WORKER,
    previousClaimerUsername: 'worker',
    caller: WORKER,
    callerUsername: 'worker',
    selfRelease: true,
    releasedAt: String(NOW - 2 * HOUR),
    releasedAtBlock: '1000',
    transactionHash: '0x' + 'ee'.repeat(32),
    ...overrides,
  };
}

/**
 * Mirrors the UNEXPORTED isUnknownFieldError in src/lib/subgraph.ts. Duplicated
 * on purpose: it is what makes a fixture whose wording does NOT trip the real
 * matcher fail loudly here instead of quietly skipping the fallback the test
 * was written to prove.
 */
const UNKNOWN_FIELD_PATTERNS = [
  /cannot query field/i,
  /has no field/i,
  /unknown field/i,
  /unknown argument/i,
  /undefined field/i,
];

/** The exact wording poa-arb-v-1 returns for the v7 release fields. */
function arbitrumRejection() {
  return new Error('Type `Task` has no field `releaseCount`');
}

/** `task view` issues two tiered reads; only one of them is the history read. */
function isReleaseHistoryRead(tiers: any[]): boolean {
  return /FetchTaskReleaseHistory/.test(tiers[0].query);
}

function releaseHistoryCalls() {
  return mocks.queryWithFieldFallback.mock.calls.filter(c => isReleaseHistoryRead(c[0]));
}

/**
 * Point both tiered reads at fixtures. `tiers` is the per-tier response for the
 * shared projects document — an Error entry rejects that tier, and only a
 * rejection the real matcher would classify as schema drift falls through,
 * exactly as the production walker behaves.
 */
function mockSubgraph(opts: { task?: any; tiers?: any[]; releases?: any[] } = {}) {
  const tiers = opts.tiers ?? [subgraphFixture(opts.task ?? sgTask())];
  mocks.queryWithFieldFallback.mockImplementation(async (requested: any[]) => {
    if (isReleaseHistoryRead(requested)) {
      return { data: { task: { releases: opts.releases ?? [] } }, tierIndex: 0 };
    }
    for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
      const response = tiers[tierIndex];
      if (!(response instanceof Error)) return { data: response, tierIndex };
      if (!UNKNOWN_FIELD_PATTERNS.some(p => p.test(response.message))) throw response;
    }
    throw new Error('every tier rejected');
  });
}

function onChainTask(overrides: Record<string, any> = {}) {
  return {
    projectId: '0x' + '01'.repeat(32),
    payout: ethers.utils.parseUnits('10', 18),
    claimer: WORKER,
    bountyPayout: ethers.constants.Zero,
    requiresApplication: false,
    status: 1, // CLAIMED
    bountyToken: ethers.constants.AddressZero,
    ...overrides,
  };
}

/** v6 lens fixture: CLAIMED with an expired claim deadline. */
function v6ExpiredClaim() {
  return onChainTask({ absoluteDeadline: NOW + 7 * DAY, completionWindow: 2 * DAY, claimDeadline: NOW - HOUR });
}

/** Pre-v6 lens fixture: the deadline words are absent from the tuple. */
function legacyOnChain() {
  return onChainTask(); // no absoluteDeadline/completionWindow/claimDeadline
}

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return { _: [], $0: 'pop', org: 'testorg', task: '7', chain: 100, ...overrides };
}

function loggedText(logSpy: ReturnType<typeof vi.spyOn>): string {
  return logSpy.mock.calls.map(c => c.join(' ')).join('\n');
}

describe('pop task view — v6 deadlines section + applicants', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    mocks.isJsonMode.mockReturnValue(false);
    mocks.resolveOrgId.mockResolvedValue(ORG_ID);
    // Default to tier 0 (Gnosis): release fields served, but zero on this task.
    mockSubgraph();
    mocks.resolveNetworkConfig.mockReturnValue({ chainId: 100, resolvedRpc: 'http://127.0.0.1:1', resolvedSubgraph: 'http://127.0.0.1:2' });
    mocks.getTaskOnChain.mockResolvedValue(v6ExpiredClaim());
    mocks.getTaskApplicants.mockResolvedValue([]);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('v6 org: renders the Deadlines section with countdowns and takeover sentence', async () => {
    await viewHandler.handler(baseArgv());

    expect(mocks.getTaskOnChain).toHaveBeenCalledWith(expect.anything(), TM_ADDR, '7');
    const text = loggedText(logSpy);
    expect(text).toContain('Deadlines');
    expect(text).toContain(`Absolute deadline:  ${formatDeadline(NOW + 7 * DAY)}`);
    expect(text).toContain('Completion window:  2d');
    expect(text).toContain('Claim deadline:');
    expect(text).toMatch(/expired .* ago/);
    expect(text).toContain('claim expired — anyone with CLAIM permission can take over');
  });

  it('v6 org, on-track claim: sentence says when the submission is due', async () => {
    mocks.getTaskOnChain.mockResolvedValue(
      onChainTask({ absoluteDeadline: 0, completionWindow: 2 * DAY, claimDeadline: NOW + 3 * HOUR })
    );

    await viewHandler.handler(baseArgv());

    const text = loggedText(logSpy);
    expect(text).toContain(`submission due ${formatDeadline(NOW + 3 * HOUR)}`);
    expect(text).not.toContain('can take over');
  });

  it('legacy org: no deadline fields in the lens tuple → section omitted', async () => {
    mocks.getTaskOnChain.mockResolvedValue(legacyOnChain());

    await viewHandler.handler(baseArgv());

    const text = loggedText(logSpy);
    expect(text).toContain('Task #7');
    expect(text).not.toContain('Deadlines');
    expect(text).not.toContain('Completion window');
  });

  it('lens RPC failure degrades gracefully: view renders without the section', async () => {
    mocks.getTaskOnChain.mockRejectedValue(new Error('rpc down'));

    await viewHandler.handler(baseArgv());

    const text = loggedText(logSpy);
    expect(text).toContain('Task #7');
    expect(text).not.toContain('Deadlines');
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('requiresApplication + empty subgraph applications: lens applicants fallback renders', async () => {
    mockSubgraph({ task: sgTask({ requiresApplication: true, applications: [] }) });
    mocks.getTaskApplicants.mockResolvedValue([APPLICANT_1, APPLICANT_2]);

    await viewHandler.handler(baseArgv());

    expect(mocks.getTaskApplicants).toHaveBeenCalledWith(expect.anything(), TM_ADDR, '7');
    const text = loggedText(logSpy);
    expect(text).toContain('Applicants:  2');
    expect(text).toContain(APPLICANT_1);
    expect(text).toContain(APPLICANT_2);
  });

  it('subgraph already has applications: lens fallback is not called', async () => {
    mockSubgraph({ task: sgTask({
      requiresApplication: true,
      applications: [{ applicant: APPLICANT_1, applicantUsername: 'alice', approved: false }],
    }) });

    await viewHandler.handler(baseArgv());

    expect(mocks.getTaskApplicants).not.toHaveBeenCalled();
    expect(loggedText(logSpy)).toContain('Applications: 1');
  });

  it('JSON mode: additive v6 + applicant fields alongside untouched legacy fields', async () => {
    mocks.isJsonMode.mockReturnValue(true);
    mockSubgraph({ task: sgTask({ requiresApplication: true, applications: [] }) });
    mocks.getTaskApplicants.mockResolvedValue([APPLICANT_1]);

    await viewHandler.handler(baseArgv());

    expect(mocks.json).toHaveBeenCalledTimes(1);
    const payload = mocks.json.mock.calls[0][0];
    // Legacy fields unchanged
    expect(payload.taskId).toBe('7');
    expect(payload.status).toBe('Assigned');
    expect(payload.payout).toBe('10.0 PT');
    // Additive v6 deadline fields
    expect(payload).toMatchObject({
      absoluteDeadline: NOW + 7 * DAY,
      completionWindow: 2 * DAY,
      claimDeadline: NOW - HOUR,
      claimState: 'expired-claimable',
      applicants: [APPLICANT_1],
      applicantCount: 1,
    });
  });

  it('JSON mode on a legacy org: no deadline keys added', async () => {
    mocks.isJsonMode.mockReturnValue(true);
    mocks.getTaskOnChain.mockResolvedValue(legacyOnChain());

    await viewHandler.handler(baseArgv());

    const payload = mocks.json.mock.calls[0][0];
    expect(payload.taskId).toBe('7');
    expect(payload).not.toHaveProperty('absoluteDeadline');
    expect(payload).not.toHaveProperty('claimState');
    expect(payload).not.toHaveProperty('applicants');
  });

  // -------------------------------------------------------------------------
  // v7 release history (TaskManager unclaimTask + subgraph #201, Gnosis only)
  // -------------------------------------------------------------------------

  it('tier 0: renders the Releases section, distinguishing self- from force-releases', async () => {
    mockSubgraph({
      task: sgTask({ releaseCount: 2, lastReleasedAt: String(NOW - 2 * HOUR) }),
      releases: [
        sgRelease(),
        sgRelease({
          id: `${TM_ADDR}-7-1`,
          previousClaimer: SLACKER,
          previousClaimerUsername: 'slacker',
          caller: PM,
          callerUsername: 'pm',
          selfRelease: false,
          releasedAt: String(NOW - DAY),
        }),
      ],
    });

    await viewHandler.handler(baseArgv());

    const text = loggedText(logSpy);
    expect(text).toContain('Releases:    2');
    expect(text).toContain('(last 2h ago)');
    expect(text).toContain('worker self-released');
    // A third party can only force-release an ALREADY-EXPIRED claim, and the
    // caller is the only record of who did it.
    expect(text).toContain('slacker force-released by pm');
  });

  it('tier 0, never released: the Releases section is omitted', async () => {
    await viewHandler.handler(baseArgv());

    expect(loggedText(logSpy)).not.toContain('Releases:');
  });

  it('tier 0, never released: --json still reports releaseCount 0', async () => {
    // 0 means "indexed, never released" and has to stay distinguishable from
    // the key being absent, which means "this chain does not index releases".
    mocks.isJsonMode.mockReturnValue(true);

    await viewHandler.handler(baseArgv());

    const payload = mocks.json.mock.calls[0][0];
    expect(payload).toHaveProperty('releaseCount', 0);
    expect(payload).toHaveProperty('lastReleasedAt', null);
    expect(payload.releases).toEqual([]);
  });

  it('the release-history round-trip only fires when releaseCount > 0', async () => {
    await viewHandler.handler(baseArgv());
    expect(releaseHistoryCalls()).toHaveLength(0);

    vi.clearAllMocks();
    mocks.resolveOrgId.mockResolvedValue(ORG_ID);
    mocks.getTaskOnChain.mockResolvedValue(v6ExpiredClaim());
    mockSubgraph({ task: sgTask({ releaseCount: 1, lastReleasedAt: String(NOW - HOUR) }), releases: [sgRelease()] });

    await viewHandler.handler(baseArgv());

    expect(releaseHistoryCalls()).toHaveLength(1);
    // The history read is keyed by the Task ENTITY id, not the numeric task id.
    expect(releaseHistoryCalls()[0][0][0].variables).toMatchObject({ taskId: `${TM_ADDR.toLowerCase()}-7` });
  });

  it('a released task still renders the Releases section once its assignee is gone', async () => {
    // handleTaskUnclaimed nulls assignee/assigneeUsername/assignedAt and puts
    // the task back to Open, so nesting this section inside the existing
    // `if (found.assignee)` branch would hide it for exactly the tasks that
    // have release history — releaseCount is then the ONLY surviving evidence
    // the task was ever claimed.
    mockSubgraph({
      task: sgTask({
        status: 'Open',
        assignee: null,
        assigneeUsername: null,
        assignedAt: null,
        releaseCount: 1,
        lastReleasedAt: String(NOW - HOUR),
      }),
      releases: [sgRelease({ releasedAt: String(NOW - HOUR) })],
    });
    mocks.getTaskOnChain.mockResolvedValue(
      onChainTask({ status: 0, claimer: ethers.constants.AddressZero, absoluteDeadline: NOW + 7 * DAY, completionWindow: 2 * DAY, claimDeadline: 0 })
    );

    await viewHandler.handler(baseArgv());

    const text = loggedText(logSpy);
    expect(text).not.toContain('Assignee:');
    expect(text).toContain('Releases:    1');
    expect(text).toContain('worker self-released');
  });

  it('a released task exposes releaseCount in --json even with a null assignee', async () => {
    mocks.isJsonMode.mockReturnValue(true);
    mockSubgraph({
      task: sgTask({ status: 'Open', assignee: null, assigneeUsername: null, assignedAt: null, releaseCount: 1, lastReleasedAt: String(NOW - HOUR) }),
      releases: [sgRelease({ releasedAt: String(NOW - HOUR) })],
    });

    await viewHandler.handler(baseArgv());

    const payload = mocks.json.mock.calls[0][0];
    expect(payload.assignee).toBeNull();
    expect(payload.assignedAt).toBeNull();
    expect(payload.releaseCount).toBe(1);
    expect(payload.releases).toEqual([
      expect.objectContaining({ previousClaimer: 'worker', caller: 'worker', selfRelease: true }),
    ]);
  });

  it('tier 1 (Arbitrum): the release tier drops cleanly and adds no release keys', async () => {
    mocks.isJsonMode.mockReturnValue(true);
    mockSubgraph({ tiers: [arbitrumRejection(), subgraphFixture()] });

    await viewHandler.handler(baseArgv());

    const payload = mocks.json.mock.calls[0][0];
    expect(payload).not.toHaveProperty('releaseCount');
    expect(payload).not.toHaveProperty('lastReleasedAt');
    expect(payload).not.toHaveProperty('releases');
    // Everything that existed before the release tier is untouched.
    expect(payload).toMatchObject({
      taskId: '7',
      status: 'Assigned',
      payout: '10.0 PT',
      assignee: WORKER,
      assigneeUsername: 'worker',
      claimState: 'expired-claimable',
    });
    expect(releaseHistoryCalls()).toHaveLength(0);
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
