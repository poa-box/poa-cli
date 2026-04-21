import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task #498: tests for boundary-score v0.2 --space auto-fetch.
// Mock snapshotGraphQL via vi.mock before importing the SUT.
// Note: snapshotGraphQL already unwraps .data per src/lib/snapshot.ts,
// so the mocked return values are the inner data object directly.

vi.mock('../../src/lib/snapshot', () => ({
  snapshotGraphQL: vi.fn(),
}));

import { autoFetchMetricsFromSnapshot } from '../../src/commands/org/boundary-score';
import { snapshotGraphQL } from '../../src/lib/snapshot';

const mockedSnapshot = snapshotGraphQL as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedSnapshot.mockReset();
});

describe('autoFetchMetricsFromSnapshot — Task #498 v0.2', () => {
  it('computes Gini, top5pct, passRate, N from real-shape Snapshot response', async () => {
    mockedSnapshot
      .mockResolvedValueOnce({
        proposals: [
          { id: 'p1', state: 'closed', scores: [100, 20] },
          { id: 'p2', state: 'closed', scores: [50, 80] },
          { id: 'p3', state: 'closed', scores: [200, 30] },
        ],
      })
      .mockResolvedValueOnce({
        votes: [
          { voter: '0xAAA', vp: 100 },
          { voter: '0xBBB', vp: 80 },
          { voter: '0xCCC', vp: 60 },
          { voter: '0xDDD', vp: 40 },
          { voter: '0xEEE', vp: 20 },
          { voter: '0xFFF', vp: 10 },
        ],
      });

    const m = await autoFetchMetricsFromSnapshot('test.eth');

    expect(m.N).toBe(6);
    expect(m.proposalsAnalyzed).toBe(3);
    expect(m.passRate).toBeCloseTo(0.667, 2);
    expect(m.top5pct).toBeCloseTo(0.968, 2);
    expect(m.gini).toBeGreaterThan(0);
    expect(m.gini).toBeLessThan(1);
  });

  it('throws on empty closed-proposal set', async () => {
    mockedSnapshot.mockResolvedValueOnce({ proposals: [] });
    await expect(autoFetchMetricsFromSnapshot('empty.eth')).rejects.toThrow(/No closed proposals/);
  });

  it('throws on zero votes across proposals', async () => {
    mockedSnapshot
      .mockResolvedValueOnce({ proposals: [{ id: 'p1', state: 'closed', scores: [100, 50] }] })
      .mockResolvedValueOnce({ votes: [] });
    await expect(autoFetchMetricsFromSnapshot('empty-voters.eth')).rejects.toThrow(/No votes found/);
  });

  it('computes 0 Gini for perfectly equal voter VP distribution', async () => {
    mockedSnapshot
      .mockResolvedValueOnce({ proposals: [{ id: 'p1', state: 'closed', scores: [100, 50] }] })
      .mockResolvedValueOnce({
        votes: [
          { voter: '0xAAA', vp: 100 },
          { voter: '0xBBB', vp: 100 },
          { voter: '0xCCC', vp: 100 },
        ],
      });
    const m = await autoFetchMetricsFromSnapshot('equal.eth');
    expect(m.gini).toBe(0);
    expect(m.top5pct).toBe(1);
  });

  it('handles most-recent-first proposal ordering', async () => {
    mockedSnapshot
      .mockResolvedValueOnce({
        proposals: [
          { id: 'recent', state: 'closed', scores: [200, 100] },
          { id: 'old', state: 'closed', scores: [50, 80] },
        ],
      })
      .mockResolvedValueOnce({
        votes: [
          { voter: '0xWHALE', vp: 5000 },
          { voter: '0xSMALL', vp: 100 },
        ],
      });
    const m = await autoFetchMetricsFromSnapshot('order.eth');
    expect(m.N).toBe(2);
    expect(m.passRate).toBe(0.5);
  });

  it('throws on zero-vp votes (null totalVP case)', async () => {
    mockedSnapshot
      .mockResolvedValueOnce({ proposals: [{ id: 'p1', state: 'closed', scores: [10, 5] }] })
      .mockResolvedValueOnce({
        votes: [
          { voter: '0xAAA', vp: 0 },
          { voter: '0xBBB', vp: 0 },
        ],
      });
    await expect(autoFetchMetricsFromSnapshot('zero-vp.eth')).rejects.toThrow(/No votes found/);
  });
});
