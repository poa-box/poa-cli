/**
 * pop task view — v6 Deadlines section + applicant lens fallback.
 *
 * `task view` reads deadline data straight from the chain (getTaskOnChain)
 * because the deployed subgraph does not index it. These tests verify:
 *   - v6 orgs get a Deadlines section with countdowns and a derived-state
 *     sentence (expired claim → takeover hint; on-track → submission due)
 *   - pre-v6 orgs (no deadline fields in the lens tuple) omit the section
 *   - application-gated tasks fall back to getTaskApplicants when the
 *     subgraph has not indexed applications yet
 *   - JSON output only ADDS fields (absoluteDeadline, completionWindow,
 *     claimDeadline, claimState, applicants) — legacy fields unchanged
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
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

vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
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
    assignee: '0x' + '22'.repeat(20),
    assigneeUsername: 'worker',
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

function onChainTask(overrides: Record<string, any> = {}) {
  return {
    projectId: '0x' + '01'.repeat(32),
    payout: ethers.utils.parseUnits('10', 18),
    claimer: '0x' + '22'.repeat(20),
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
    mocks.query.mockResolvedValue(subgraphFixture());
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
    mocks.query.mockResolvedValue(subgraphFixture(sgTask({ requiresApplication: true, applications: [] })));
    mocks.getTaskApplicants.mockResolvedValue([APPLICANT_1, APPLICANT_2]);

    await viewHandler.handler(baseArgv());

    expect(mocks.getTaskApplicants).toHaveBeenCalledWith(expect.anything(), TM_ADDR, '7');
    const text = loggedText(logSpy);
    expect(text).toContain('Applicants:  2');
    expect(text).toContain(APPLICANT_1);
    expect(text).toContain(APPLICANT_2);
  });

  it('subgraph already has applications: lens fallback is not called', async () => {
    mocks.query.mockResolvedValue(subgraphFixture(sgTask({
      requiresApplication: true,
      applications: [{ applicant: APPLICANT_1, applicantUsername: 'alice', approved: false }],
    })));

    await viewHandler.handler(baseArgv());

    expect(mocks.getTaskApplicants).not.toHaveBeenCalled();
    expect(loggedText(logSpy)).toContain('Applications: 1');
  });

  it('JSON mode: additive v6 + applicant fields alongside untouched legacy fields', async () => {
    mocks.isJsonMode.mockReturnValue(true);
    mocks.query.mockResolvedValue(subgraphFixture(sgTask({ requiresApplication: true, applications: [] })));
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
});
