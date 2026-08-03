/**
 * pop task list — deadline enrichment, v7 release churn, decorations, filters.
 *
 * The projects document is served by three tiers (src/queries/task.ts):
 *   0 — v6 deadlines + v7 release fields (Gnosis)
 *   1 — v6 deadlines only (Arbitrum today)
 *   2 — neither; deadlines must then come from the chain via the task lens
 * These tests mock the subgraph + lens + version detection and verify:
 *   - the Deadline/Age columns and status decorations in human output
 *   - tier 1 still counts as "subgraph has deadlines" (no per-task RPC lens)
 *   - --claimable keeps unclaimed + expired-claim rows only, and drops
 *     unclaimed rows whose absolute deadline already passed
 *   - --released keeps rows with releaseCount > 0, and says so when the
 *     chain's subgraph cannot answer the question
 *   - --expiring keeps rows whose governing deadline is inside the window
 *   - --fast and legacy orgs skip enrichment entirely
 *   - JSON output keeps the contracted keys and only ADDS deadline/release
 *     fields, gated on the served tier rather than on truthiness
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryWithFieldFallback: vi.fn(),
  resolveOrgId: vi.fn(),
  resolveNetworkConfig: vi.fn(),
  detectTaskManagerFeatures: vi.fn(),
  enrichTasksWithDeadlines: vi.fn(),
  isJsonMode: vi.fn(() => false),
  table: vi.fn(),
  json: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/lib/subgraph', () => ({
  query: mocks.query,
  queryWithFieldFallback: mocks.queryWithFieldFallback,
}));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgId: mocks.resolveOrgId,
  resolveOrgModules: vi.fn(),
  requireModule: vi.fn(),
}));
vi.mock('../../src/config/networks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/networks')>();
  return { ...actual, resolveNetworkConfig: mocks.resolveNetworkConfig };
});
vi.mock('../../src/lib/version', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/version')>();
  return { ...actual, detectTaskManagerFeatures: mocks.detectTaskManagerFeatures };
});
vi.mock('../../src/lib/task-lens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/task-lens')>();
  // deriveClaimState stays REAL — the tests exercise the actual state
  // classification against the mocked on-chain fixtures.
  return { ...actual, enrichTasksWithDeadlines: mocks.enrichTasksWithDeadlines };
});
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
    warn: mocks.warn,
    info: mocks.info,
    table: mocks.table,
    json: mocks.json,
    isJsonMode: mocks.isJsonMode,
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import { listHandler } from '../../src/commands/task/list';

const TM_ADDR = '0x1111111111111111111111111111111111111111';
const ORG_ID = '0x' + 'ab'.repeat(32);
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const DAY = 86400;

// `unclaim` is v7-only, so both of these older shapes carry it as false.
// Nothing type-checks these literals against TaskManagerFeatures — a missing
// key reads as undefined at the call site rather than failing the build.
const V6_FEATURES = { deadlines: true, batchCreate: true, editMeta: true, folders: true, legacyCreate7: false, unclaim: false };
const LEGACY_FEATURES = { deadlines: false, batchCreate: false, editMeta: false, folders: false, legacyCreate7: true, unclaim: false };

function sgTask(taskId: string, title: string, status: string, overrides: Record<string, any> = {}) {
  return {
    id: `${TM_ADDR}-${taskId}`,
    taskId,
    title,
    status,
    payout: ethers.utils.parseUnits('5', 18).toString(),
    rejectionCount: '0',
    assignee: null,
    assigneeUsername: null,
    createdAt: String(NOW - 2 * HOUR),
    ...overrides,
  };
}

/**
 * Spec fixture: UNCLAIMED, CLAIMED-expired, CLAIMED-on-track, SUBMITTED,
 * plus a COMPLETED task that must never be lens-enriched (terminal).
 */
function subgraphFixture() {
  return {
    organization: {
      taskManager: {
        id: TM_ADDR,
        projects: [{
          id: `${TM_ADDR}-0x01`,
          title: 'Core',
          tasks: [
            sgTask('1', 'Open task', 'Open'),
            sgTask('2', 'Expired claim', 'Assigned', { assignee: '0x' + '22'.repeat(20) }),
            sgTask('3', 'On-track claim', 'Assigned', { assignee: '0x' + '33'.repeat(20) }),
            sgTask('4', 'Submitted task', 'Submitted', { assignee: '0x' + '44'.repeat(20) }),
            sgTask('5', 'Done task', 'Completed', { assignee: '0x' + '55'.repeat(20) }),
          ],
        }],
      },
    },
  };
}

/**
 * subgraphFixture plus the indexed v6 deadline fields — what tiers 0 and 1
 * actually return. #2's claim has expired, #3's is comfortably on track.
 */
function indexedFixture() {
  const fixture = subgraphFixture();
  const tasks = fixture.organization.taskManager.projects[0].tasks as any[];
  tasks[1].claimDeadline = String(NOW - HOUR);
  tasks[1].completionWindow = '3600';
  tasks[2].claimDeadline = String(NOW + 30 * HOUR);
  tasks[2].completionWindow = '3600';
  return fixture;
}

/**
 * Tier 0 (Gnosis, subgraph #201). `releaseCount` is `Int!` in the schema, so
 * it is present and 0 on every unreleased row — the case that has to stay
 * distinguishable from a tier that does not serve the field at all.
 */
function tier0Fixture(releases: Record<string, { count: number; at?: number }> = {}) {
  const fixture = indexedFixture();
  for (const task of fixture.organization.taskManager.projects[0].tasks as any[]) {
    const r = releases[task.taskId];
    task.releaseCount = r?.count ?? 0;
    task.lastReleasedAt = r?.at != null ? String(r.at) : null;
  }
  return fixture;
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

/**
 * Stand-in for queryWithFieldFallback over the projects tiers. Each entry is
 * either that tier's data or an Error it rejects with; only a rejection the
 * real matcher would classify as schema drift falls through to the next tier,
 * exactly as the production walker behaves.
 */
function mockProjectsTiers(responses: Array<any>) {
  mocks.queryWithFieldFallback.mockImplementation(async () => {
    for (let tierIndex = 0; tierIndex < responses.length; tierIndex++) {
      const response = responses[tierIndex];
      if (!(response instanceof Error)) return { data: response, tierIndex };
      if (!UNKNOWN_FIELD_PATTERNS.some(p => p.test(response.message))) throw response;
    }
    throw new Error('every tier rejected');
  });
}

/** The exact wording poa-arb-v-1 returns for the v7 release fields. */
function arbitrumRejection() {
  return new Error('Type `Task` has no field `releaseCount`');
}

function onChainTask(status: number, absoluteDeadline: number, completionWindow: number, claimDeadline: number) {
  return {
    projectId: '0x' + '01'.repeat(32),
    payout: ethers.utils.parseUnits('5', 18),
    claimer: ethers.constants.AddressZero,
    bountyPayout: ethers.constants.Zero,
    requiresApplication: false,
    status,
    bountyToken: ethers.constants.AddressZero,
    absoluteDeadline,
    completionWindow,
    claimDeadline,
  };
}

/** Default lens fixture matching the subgraph statuses above. */
function lensFixture() {
  return {
    tasks: new Map<string, any>([
      ['1', onChainTask(0, NOW + 2 * HOUR, 0, 0)],          // UNCLAIMED, abs deadline in 2h
      ['2', onChainTask(1, 0, 2 * DAY, NOW - HOUR)],        // CLAIMED, claim expired 1h ago
      ['3', onChainTask(1, 0, 2 * DAY, NOW + 30 * DAY)],    // CLAIMED, on track (30d)
      ['4', onChainTask(2, NOW + 2 * HOUR, 0, NOW + 2 * HOUR)], // SUBMITTED
    ]),
    errors: [],
  };
}

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    chain: 100,
    sortBy: 'id',
    fast: false,
    ...overrides,
  };
}

/** Rendered table rows, keyed positionally per the emitted headers. */
function renderedRows(): { headers: string[]; rows: string[][] } {
  expect(mocks.table).toHaveBeenCalledTimes(1);
  const [headers, rows] = mocks.table.mock.calls[0];
  return { headers, rows };
}

describe('pop task list — v6 deadline enrichment + filters', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);

    mocks.isJsonMode.mockReturnValue(false);
    mocks.resolveOrgId.mockResolvedValue(ORG_ID);
    mocks.query.mockResolvedValue(subgraphFixture());
    // Default to the LEGACY tier (index 2 since the v7 release tier was prepended):
    // a subgraph that predates the v6 deadline fields, which is what forces the
    // on-chain lens path these tests exercise.
    mocks.queryWithFieldFallback.mockImplementation(async () => ({
      data: subgraphFixture(),
      tierIndex: 2,
    }));
    mocks.resolveNetworkConfig.mockReturnValue({ chainId: 100, resolvedRpc: 'http://127.0.0.1:1', resolvedSubgraph: 'http://127.0.0.1:2' });
    mocks.detectTaskManagerFeatures.mockResolvedValue(V6_FEATURES);
    mocks.enrichTasksWithDeadlines.mockResolvedValue(lensFixture());
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('indexed deadlines (subgraph-pop #192) are used directly, with NO on-chain lens call', async () => {
    // The modern tier serves absoluteDeadline/claimDeadline/completionWindow per task, so the
    // per-task multicall this command used to make on its hottest path must not run at all.
    mocks.queryWithFieldFallback.mockImplementation(async () => {
      const fixture = subgraphFixture();
      const tasks = fixture.organization.taskManager.projects[0].tasks;
      // #2 is a CLAIMED task whose claim deadline has already passed.
      tasks[1].claimDeadline = String(NOW - HOUR);
      tasks[1].absoluteDeadline = String(NOW - HOUR);
      tasks[1].completionWindow = '3600';
      // #3 is a CLAIMED task still comfortably on track.
      tasks[2].claimDeadline = String(NOW + 30 * HOUR);
      tasks[2].absoluteDeadline = String(NOW + 30 * HOUR);
      tasks[2].completionWindow = '3600';
      return { data: fixture, tierIndex: 0 };
    });

    await listHandler.handler(baseArgv());

    expect(mocks.enrichTasksWithDeadlines).not.toHaveBeenCalled();

    const [headers] = mocks.table.mock.calls[0];
    expect(headers).toContain('Deadline');
  });

  it('an expired indexed claim still satisfies --claimable without any RPC', async () => {
    mocks.queryWithFieldFallback.mockImplementation(async () => {
      const fixture = subgraphFixture();
      const tasks = fixture.organization.taskManager.projects[0].tasks;
      tasks[1].claimDeadline = String(NOW - HOUR); // expired -> takeover-able
      tasks[2].claimDeadline = String(NOW + 30 * HOUR); // on track -> excluded
      return { data: fixture, tierIndex: 0 };
    });

    await listHandler.handler({ ...baseArgv(), claimable: true } as any);

    expect(mocks.enrichTasksWithDeadlines).not.toHaveBeenCalled();
    const [, rows] = mocks.table.mock.calls[0];
    const ids = rows.map((r: string[]) => r[0]);
    expect(ids).toContain('1'); // UNCLAIMED
    expect(ids).toContain('2'); // CLAIMED but expired
    expect(ids).not.toContain('3'); // CLAIMED, on track
  });

  it('v6 org: enriches non-terminal tasks only and renders Deadline + Age columns', async () => {
    await listHandler.handler(baseArgv());

    // Enrichment targets exclude the COMPLETED task (terminal)
    expect(mocks.enrichTasksWithDeadlines).toHaveBeenCalledTimes(1);
    const ids = mocks.enrichTasksWithDeadlines.mock.calls[0][2];
    expect(ids).toEqual(['1', '2', '3', '4']);

    const { headers, rows } = renderedRows();
    expect(headers).toEqual(['ID', 'Name', 'Status', 'Deadline', 'Assignee', 'Payout', 'Project', 'Age']);
    expect(rows).toHaveLength(5);

    const dlCol = headers.indexOf('Deadline');
    const statusCol = headers.indexOf('Status');
    const ageCol = headers.indexOf('Age');
    const byId = Object.fromEntries(rows.map((r: string[]) => [r[0], r]));

    // UNCLAIMED: countdown from absoluteDeadline
    expect(byId['1'][dlCol]).toMatch(/left$/);
    // CLAIMED-expired: countdown says expired, status decorated as claimable
    expect(byId['2'][dlCol]).toMatch(/^expired .* ago$/);
    expect(byId['2'][statusCol]).toContain('Claimed (expired — claimable)');
    // CLAIMED-on-track: plain status, future countdown
    expect(byId['3'][statusCol]).not.toContain('claimable');
    expect(byId['3'][statusCol]).not.toContain('⚠');
    expect(byId['3'][dlCol]).toMatch(/left$/);
    // COMPLETED: no deadline data → em-dash
    expect(byId['5'][dlCol]).toBe('—');
    // Age column from subgraph createdAt
    expect(byId['1'][ageCol]).toBe('2h ago');
  });

  it('CLAIMED task expiring within 24h gets the ⚠ marker', async () => {
    const lens = lensFixture();
    lens.tasks.set('3', onChainTask(1, 0, 2 * DAY, NOW + 2 * HOUR)); // expiring-soon
    mocks.enrichTasksWithDeadlines.mockResolvedValue(lens);

    await listHandler.handler(baseArgv());

    const { headers, rows } = renderedRows();
    const statusCol = headers.indexOf('Status');
    const row3 = rows.find((r: string[]) => r[0] === '3')!;
    expect(row3[statusCol]).toContain('⚠');
  });

  it('--claimable keeps only UNCLAIMED and expired-claim CLAIMED rows', async () => {
    await listHandler.handler(baseArgv({ claimable: true }));

    const { rows } = renderedRows();
    expect(rows.map((r: string[]) => r[0])).toEqual(['1', '2']);
  });

  it('--expiring 24h keeps rows whose governing deadline is inside the window', async () => {
    await listHandler.handler(baseArgv({ expiring: '24h' }));

    const { rows } = renderedRows();
    // 1: abs deadline in 2h; 4: abs deadline in 2h (SUBMITTED governs by abs).
    // 2 is already expired (claimable, not expiring); 3 is 30d out.
    expect(rows.map((r: string[]) => r[0])).toEqual(['1', '4']);
  });

  it('unparseable --expiring fails before any network work', async () => {
    await expect(listHandler.handler(baseArgv({ expiring: 'soonish' }))).rejects.toBeInstanceOf(ExitError);

    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('Unparseable duration'));
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.enrichTasksWithDeadlines).not.toHaveBeenCalled();
  });

  it('--fast skips enrichment entirely and notes the skip', async () => {
    await listHandler.handler(baseArgv({ fast: true }));

    expect(mocks.detectTaskManagerFeatures).not.toHaveBeenCalled();
    expect(mocks.enrichTasksWithDeadlines).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('--fast'));

    const { headers } = renderedRows();
    expect(headers).not.toContain('Deadline');
    expect(headers).toContain('Age');
  });

  it('legacy org (no deadlines feature): lens never called, no Deadline column', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue(LEGACY_FEATURES);

    await listHandler.handler(baseArgv());

    expect(mocks.enrichTasksWithDeadlines).not.toHaveBeenCalled();
    const { headers } = renderedRows();
    expect(headers).not.toContain('Deadline');
  });

  it('JSON mode keeps legacy keys and adds deadline fields only on enriched rows', async () => {
    mocks.isJsonMode.mockReturnValue(true);

    await listHandler.handler(baseArgv());

    expect(mocks.table).not.toHaveBeenCalled();
    expect(mocks.json).toHaveBeenCalledTimes(1);
    const payload = mocks.json.mock.calls[0][0];
    expect(payload).toHaveLength(5);

    const byId = Object.fromEntries(payload.map((r: any) => [r.ID, r]));
    // Legacy keys preserved verbatim
    for (const key of ['ID', 'Name', 'Status', 'Assignee', 'Payout', 'Project']) {
      expect(byId['2']).toHaveProperty(key);
    }
    // Status field stays the raw subgraph value in JSON (no decoration)
    expect(byId['2'].Status).toBe('Assigned');
    // Additive v6 fields on enriched rows
    expect(byId['2']).toMatchObject({
      absoluteDeadline: 0,
      completionWindow: 2 * DAY,
      claimDeadline: NOW - HOUR,
      claimState: 'expired-claimable',
    });
    expect(byId['1'].claimState).toBe('none');
    // Terminal row was not enriched → no additive fields
    expect(byId['5']).not.toHaveProperty('absoluteDeadline');
    expect(byId['5']).not.toHaveProperty('claimState');
  });

  it('lens RPC failure degrades gracefully: table still renders without Deadline column', async () => {
    mocks.detectTaskManagerFeatures.mockRejectedValue(new Error('rpc down'));

    await listHandler.handler(baseArgv());

    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('deadline data unavailable'));
    const { headers, rows } = renderedRows();
    expect(headers).not.toContain('Deadline');
    expect(rows).toHaveLength(5);
  });

  // -------------------------------------------------------------------------
  // v7 release churn (TaskManager unclaimTask + subgraph #201, Gnosis only)
  // -------------------------------------------------------------------------

  it('tier 0: release churn folds into the status cell as ↺N', async () => {
    mockProjectsTiers([tier0Fixture({ '2': { count: 2, at: NOW - DAY } })]);

    await listHandler.handler(baseArgv());

    const { headers, rows } = renderedRows();
    const statusCol = headers.indexOf('Status');
    const byId = Object.fromEntries(rows.map((r: string[]) => [r[0], r]));
    expect(byId['2'][statusCol]).toContain('↺2');
    // A never-released row must stay undecorated — the suffix is signal, not chrome.
    expect(byId['3'][statusCol]).not.toContain('↺');
  });

  it('tier 0 --json: releaseCount/lastReleasedAt are appended after the deadline block', async () => {
    mocks.isJsonMode.mockReturnValue(true);
    mockProjectsTiers([tier0Fixture({ '2': { count: 2, at: NOW - DAY } })]);

    await listHandler.handler(baseArgv());

    const byId = Object.fromEntries(mocks.json.mock.calls[0][0].map((r: any) => [r.ID, r]));
    expect(byId['2']).toMatchObject({ releaseCount: 2, lastReleasedAt: NOW - DAY });
    // Additive keys go at the END — agents parse this shape positionally-ish.
    expect(Object.keys(byId['2']).slice(-2)).toEqual(['releaseCount', 'lastReleasedAt']);
  });

  it('tier 1 (Arbitrum): the release tier drops cleanly and no release keys appear', async () => {
    mocks.isJsonMode.mockReturnValue(true);
    mockProjectsTiers([arbitrumRejection(), indexedFixture()]);

    await listHandler.handler(baseArgv());

    const byId = Object.fromEntries(mocks.json.mock.calls[0][0].map((r: any) => [r.ID, r]));
    expect(byId['2']).not.toHaveProperty('releaseCount');
    expect(byId['2']).not.toHaveProperty('lastReleasedAt');
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('tier 1 still counts as "subgraph has deadlines" — no per-task RPC lens', async () => {
    // The guard for `tierIndex <= 1`. Reverting that to `=== 0` sends every
    // Arbitrum org down the feature-probe + per-task multicall path on the
    // CLI's hottest command, and NOTHING in the rendered output reveals it.
    mocks.isJsonMode.mockReturnValue(true);
    mockProjectsTiers([arbitrumRejection(), indexedFixture()]);

    await listHandler.handler(baseArgv());

    expect(mocks.detectTaskManagerFeatures).not.toHaveBeenCalled();
    expect(mocks.enrichTasksWithDeadlines).not.toHaveBeenCalled();

    const byId = Object.fromEntries(mocks.json.mock.calls[0][0].map((r: any) => [r.ID, r]));
    expect(byId['2']).toMatchObject({
      claimDeadline: NOW - HOUR,
      completionWindow: HOUR,
      claimState: 'expired-claimable',
    });
  });

  it('releaseCount 0 (indexed, never released) is reported; absent (not indexed) is omitted', async () => {
    mocks.isJsonMode.mockReturnValue(true);
    mockProjectsTiers([tier0Fixture()]);

    await listHandler.handler(baseArgv());
    const indexed = Object.fromEntries(mocks.json.mock.calls[0][0].map((r: any) => [r.ID, r]));
    expect(indexed['1']).toHaveProperty('releaseCount', 0);

    mocks.json.mockClear();
    mockProjectsTiers([arbitrumRejection(), indexedFixture()]);

    await listHandler.handler(baseArgv());
    const notIndexed = Object.fromEntries(mocks.json.mock.calls[0][0].map((r: any) => [r.ID, r]));
    expect(notIndexed['1']).not.toHaveProperty('releaseCount');
  });

  it('--released keeps only rows with releaseCount > 0', async () => {
    mockProjectsTiers([tier0Fixture({ '1': { count: 1, at: NOW - HOUR }, '3': { count: 3, at: NOW - DAY } })]);

    await listHandler.handler(baseArgv({ released: true }));

    const { rows } = renderedRows();
    expect(rows.map((r: string[]) => r[0])).toEqual(['1', '3']);
  });

  it('--released on tier 1 matches nothing and says why', async () => {
    mockProjectsTiers([arbitrumRejection(), indexedFixture()]);

    await listHandler.handler(baseArgv({ released: true }));

    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('--released needs release data'));
    expect(mocks.info).toHaveBeenCalledWith('No tasks found matching filters');
    expect(mocks.table).not.toHaveBeenCalled();
  });

  it('a zero-row result still emits [] under --json, never empty stdout', async () => {
    // output.info is a no-op under --json, so the zero-row branch used to return
    // having printed NOTHING: exit 0 with completely empty stdout, which is not
    // parseable JSON. `--released` on a chain without release indexing makes that
    // the normal case, but it was always reachable via any filter that matched
    // nothing.
    mocks.isJsonMode.mockReturnValue(true);
    mockProjectsTiers([arbitrumRejection(), indexedFixture()]);

    await listHandler.handler(baseArgv({ released: true }));

    expect(mocks.json).toHaveBeenCalledWith([]);
  });

  it('under --json the degradation note goes to stderr so it is not silently lost', async () => {
    // stdout is contractually a bare array, so the note has nowhere to go in the
    // payload — but dropping it entirely makes a degraded result look identical
    // to a genuinely empty one.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.isJsonMode.mockReturnValue(true);
    mockProjectsTiers([arbitrumRejection(), indexedFixture()]);

    await listHandler.handler(baseArgv({ released: true }));

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('--released needs release data'));
    errSpy.mockRestore();
  });

  it('the contracted JSON keys survive on every tier, including a released task', async () => {
    // A release nulls assignee/assigneeUsername in the subgraph, and `Assignee`
    // is a promised key — it must still be emitted (empty is fine), not dropped.
    const CONTRACTED = ['ID', 'Name', 'Status', 'Assignee', 'Payout', 'Project', 'createdAt'];
    const tiers: Array<[string, any[]]> = [
      ['tier 0', [tier0Fixture({ '1': { count: 1, at: NOW - HOUR } })]],
      ['tier 1', [arbitrumRejection(), indexedFixture()]],
      ['tier 2', [arbitrumRejection(), arbitrumRejection(), subgraphFixture()]],
    ];

    for (const [label, responses] of tiers) {
      mocks.json.mockClear();
      mocks.isJsonMode.mockReturnValue(true);
      mockProjectsTiers(responses);

      await listHandler.handler(baseArgv());

      const byId = Object.fromEntries(mocks.json.mock.calls[0][0].map((r: any) => [r.ID, r]));
      expect(Object.keys(byId['1']).slice(0, CONTRACTED.length), label).toEqual(CONTRACTED);
      expect(byId['1'].Assignee, label).toBe('');
    }
  });

  it('a released task with no absolute deadline is still --claimable', async () => {
    // Post-release the subgraph nulls assignee/assignedAt/claimDeadline and the
    // status goes back to Open, so releaseCount is the only surviving evidence.
    const fixture = tier0Fixture({ '1': { count: 1, at: NOW - HOUR } });
    Object.assign(fixture.organization.taskManager.projects[0].tasks[0], {
      status: 'Open', assignee: null, assigneeUsername: null, assignedAt: null, claimDeadline: null,
    });
    mockProjectsTiers([fixture]);

    await listHandler.handler(baseArgv({ claimable: true }));

    expect(renderedRows().rows.map((r: string[]) => r[0])).toContain('1');
  });

  it('a released task whose absolute deadline is still in the future is --claimable', async () => {
    const fixture = tier0Fixture({ '1': { count: 1, at: NOW - HOUR } });
    Object.assign(fixture.organization.taskManager.projects[0].tasks[0], {
      status: 'Open', assignee: null, assigneeUsername: null, assignedAt: null,
      claimDeadline: null, absoluteDeadline: String(NOW + DAY),
    });
    mockProjectsTiers([fixture]);

    await listHandler.handler(baseArgv({ claimable: true }));

    expect(renderedRows().rows.map((r: string[]) => r[0])).toContain('1');
  });

  it('--claimable KEEPS a released Open task whose absolute deadline already passed', async () => {
    // Verified against TaskManager v7 source: claimTask checks only the CLAIM
    // permission, requiresApplication and status — `_claimExpired` (the sole
    // reader of absoluteDeadline) is consulted only on the CLAIMED takeover
    // branch — and submitTask checks no deadline at all. So this task really is
    // claimable and submittable; the resulting claim is merely takeover-able
    // immediately. Filtering it out would hide genuinely available work, which
    // v7 makes common: unclaimTask returns a task to Open without resetting
    // absoluteDeadline.
    const fixture = tier0Fixture({ '1': { count: 1, at: NOW - HOUR } });
    Object.assign(fixture.organization.taskManager.projects[0].tasks[0], {
      status: 'Open', assignee: null, claimDeadline: null, absoluteDeadline: String(NOW - HOUR),
    });
    mockProjectsTiers([fixture]);

    await listHandler.handler(baseArgv({ claimable: true }));

    expect(renderedRows().rows.map((r: string[]) => r[0])).toContain('1');
  });
});
