/**
 * Tests for fuzzy --proposal resolution (src/commands/vote/helpers.ts
 * resolveProposalId), the path shared by vote cast/results/execute/announce
 * and vote classes show.
 *
 * Resolution contract:
 *   - numeric input → passthrough, zero network traffic
 *   - fuzzy title  → subgraph recent-proposal titles scored with
 *     bestMatches(threshold 0.5):
 *       one match   → resolved + info line
 *       many, non-TTY → CliError (exit USAGE=1) listing the candidates
 *       zero        → CliError listing the 5 most recent proposals
 *   - preferActive: several matches but exactly one Active → that one wins
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queryMock, infoMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  infoMock: vi.fn(),
}));

vi.mock('../../src/lib/subgraph', () => ({
  query: queryMock,
}));

vi.mock('../../src/lib/output', () => ({
  info: infoMock,
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  debug: vi.fn(),
  isJsonMode: vi.fn(() => false),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), text: '' })),
}));

import { resolveProposalId, fetchRecentProposals } from '../../src/commands/vote/helpers';
import { CliError } from '../../src/lib/errors';
import { EXIT } from '../../src/lib/exit-codes';
import { _setStreamsForTest } from '../../src/lib/prompt';

const VOTING_ADDR = '0xAbC1111111111111111111111111111111111111';

function hybridProposals(proposals: any[]): any {
  return {
    hybridVotingContract: { id: VOTING_ADDR.toLowerCase(), proposals },
    directDemocracyVotingContract: null,
  };
}

async function expectCliError(promise: Promise<any>): Promise<CliError> {
  try {
    await promise;
  } catch (err: any) {
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error('expected a CliError, but the promise resolved');
}

describe('resolveProposalId — fuzzy --proposal resolution', () => {
  beforeEach(() => {
    queryMock.mockReset();
    infoMock.mockReset();
    // Force non-TTY so the ambiguous branch deterministically errors
    // instead of trying to prompt.
    _setStreamsForTest(undefined, undefined, false);
  });

  afterEach(() => {
    _setStreamsForTest();
  });

  it('numeric input passes through without any subgraph traffic', async () => {
    await expect(resolveProposalId('7', VOTING_ADDR)).resolves.toBe(7);
    await expect(resolveProposalId('  12  ', VOTING_ADDR)).resolves.toBe(12);
    await expect(resolveProposalId('0', VOTING_ADDR)).resolves.toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('a single fuzzy match resolves with an info line', async () => {
    queryMock.mockResolvedValue(hybridProposals([
      { proposalId: '4', title: 'Treasury bridge retry', status: 'Active', endTimestamp: '1000' },
      { proposalId: '3', title: 'Quarterly budget review', status: 'Ended', endTimestamp: '900' },
    ]));

    const id = await resolveProposalId('treasury bridge retry', VOTING_ADDR);
    expect(id).toBe(4);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(infoMock).toHaveBeenCalledTimes(1);
    expect(String(infoMock.mock.calls[0][0])).toMatch(/Resolved 'treasury bridge retry' → proposal #4/);
  });

  it('multiple matches in a non-TTY session raise a CliError (exit 1) listing the candidates', async () => {
    queryMock.mockResolvedValue(hybridProposals([
      { proposalId: '5', title: 'Treasury bridge retry attempt alpha', status: 'Ended', endTimestamp: '1000' },
      { proposalId: '6', title: 'Treasury bridge retry attempt beta', status: 'Ended', endTimestamp: '1100' },
    ]));

    const err = await expectCliError(resolveProposalId('treasury bridge retry attempt', VOTING_ADDR));
    expect(err.code).toBe(EXIT.USAGE);
    expect(err.message).toMatch(/ambiguous/);
    expect(err.message).toContain("#5 'Treasury bridge retry attempt alpha'");
    expect(err.message).toContain("#6 'Treasury bridge retry attempt beta'");
    expect(err.suggestion).toMatch(/--proposal \d/);
  });

  it('preferActive breaks a tie when exactly one match is still Active', async () => {
    queryMock.mockResolvedValue(hybridProposals([
      { proposalId: '9', title: 'Treasury bridge retry', status: 'Active', endTimestamp: '2000' },
      { proposalId: '8', title: 'Treasury bridge retry', status: 'Ended', endTimestamp: '1000' },
    ]));

    const id = await resolveProposalId('treasury bridge retry', VOTING_ADDR, undefined, { preferActive: true });
    expect(id).toBe(9);
    expect(String(infoMock.mock.calls[0][0])).toMatch(/#9/);
  });

  it('zero matches raise a CliError listing the 5 most recent proposals', async () => {
    queryMock.mockResolvedValue(hybridProposals([
      { proposalId: '20', title: 'Onboarding funnel improvements', status: 'Active' },
      { proposalId: '19', title: 'Website redesign budget', status: 'Ended' },
      { proposalId: '18', title: 'Moderator elections round three', status: 'Ended' },
      { proposalId: '17', title: 'Grant program renewal', status: 'Executed' },
      { proposalId: '16', title: 'Logo refresh contest', status: 'Executed' },
      { proposalId: '15', title: 'Sticker shipment reimbursement', status: 'Executed' },
    ]));

    const err = await expectCliError(resolveProposalId('zebra quantum blockchain', VOTING_ADDR));
    expect(err.code).toBe(EXIT.USAGE);
    expect(err.message).toMatch(/No proposal title matches 'zebra quantum blockchain'/);
    // Exactly the 5 most recent are listed; the 6th is not.
    for (const id of ['20', '19', '18', '17', '16']) {
      expect(err.message).toContain(`#${id}`);
    }
    expect(err.message).not.toContain('#15');
    expect(err.suggestion).toMatch(/vote list/);
  });

  it('an org with no indexed proposals raises an actionable CliError', async () => {
    queryMock.mockResolvedValue({ hybridVotingContract: null, directDemocracyVotingContract: null });

    const err = await expectCliError(resolveProposalId('anything at all here', VOTING_ADDR));
    expect(err.code).toBe(EXIT.USAGE);
    expect(err.message).toMatch(/no proposals are indexed/);
  });

  it('fetchRecentProposals consumes DD ddvProposals too (dual-entity query)', async () => {
    queryMock.mockResolvedValue({
      hybridVotingContract: null,
      directDemocracyVotingContract: {
        id: VOTING_ADDR.toLowerCase(),
        ddvProposals: [
          { proposalId: '2', title: 'Emergency multisig rotation', status: 'Active', endTimestamp: '5' },
        ],
      },
    });

    const candidates = await fetchRecentProposals(VOTING_ADDR);
    expect(candidates).toEqual([
      { proposalId: '2', title: 'Emergency multisig rotation', status: 'Active', endTimestamp: '5' },
    ]);
    // Address is lowercased into the entity ID lookup.
    expect(queryMock.mock.calls[0][1]).toMatchObject({ votingId: VOTING_ADDR.toLowerCase() });

    const id = await resolveProposalId('emergency multisig rotation', VOTING_ADDR);
    expect(id).toBe(2);
  });
});
