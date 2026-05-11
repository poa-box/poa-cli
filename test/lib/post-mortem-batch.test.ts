import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs imported via vitest's TS resolver
import { parseArgs, clusterKey, aggregateResults } from '../../agent/scripts/post-mortem-batch.mjs';

/**
 * HB#643 (vigil) task #526 — hermetic unit tests for post-mortem-batch.mjs
 * clustering + classification logic. CI gate Layer 3 of RULE #25 preventive-
 * infra ship-order for the execute-internal-revert failure class.
 *
 * No live RPC; no subprocess spawn. All tests run against synthetic results
 * shaped like the JSON output of `pop vote post-mortem`. Companion to
 * test/lib/post-mortem.test.ts (HB#642, the underlying trace-walk).
 *
 * Optional env-gated integration test that hits real RPC lives at
 * test/scripts/post-mortem-batch-e2e.js (not in default yarn test run).
 */

// Helper: build a synthetic post-mortem result shaped like the JSON output.
type Result = {
  id: number;
  success: boolean;
  outerTxReverted?: boolean;
  rootCauseDepth?: number | null;
  rootCauseSelector?: string | null;
  rootCauseError?: string | null;
  frames?: any[];
  totalGasUsed?: number;
  error?: string;
};
const makeRevert = (
  id: number,
  depth: number,
  selector: string,
  err: string,
  outerTxReverted = false,
): Result => ({
  id,
  success: false,
  outerTxReverted,
  rootCauseDepth: depth,
  rootCauseSelector: selector,
  rootCauseError: err,
  frames: [{ depth: 0 }, { depth }],
  totalGasUsed: 500000,
});
const makeSuccess = (id: number): Result => ({
  id,
  success: true,
  outerTxReverted: false,
  rootCauseDepth: null,
  rootCauseSelector: null,
  rootCauseError: null,
  frames: [{ depth: 0 }],
  totalGasUsed: 341000,
});
const makeSkip = (id: number, error: string): Result => ({ id, success: false, error });

describe('parseArgs — flag parsing', () => {
  it('defaults: no flags', () => {
    const a = parseArgs([]);
    expect(a.json).toBe(false);
    expect(a.revertsOnly).toBe(false);
    expect(a.timeoutMs).toBe(60000);
    expect(a.range).toBeUndefined();
    expect(a.proposals).toBeUndefined();
  });

  it('--range N-M parses two-end range', () => {
    const a = parseArgs(['--range', '41-52']);
    expect(a.range).toEqual([41, 52]);
  });

  it('--range rejects malformed values', () => {
    expect(() => parseArgs(['--range', 'foo'])).toThrow(/--range/);
    expect(() => parseArgs(['--range', '41'])).toThrow(/--range/);
  });

  it('--proposals parses comma-separated', () => {
    const a = parseArgs(['--proposals', '41,44,49']);
    expect(a.proposals).toEqual([41, 44, 49]);
  });

  it('--timeout S converts to ms', () => {
    const a = parseArgs(['--timeout', '90']);
    expect(a.timeoutMs).toBe(90000);
  });

  it('--timeout rejects non-positive', () => {
    expect(() => parseArgs(['--timeout', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--timeout', 'abc'])).toThrow(/positive integer/);
  });

  it('--json + --reverts-only flags', () => {
    const a = parseArgs(['--json', '--reverts-only']);
    expect(a.json).toBe(true);
    expect(a.revertsOnly).toBe(true);
  });

  it('--help short form', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });
});

describe('clusterKey — signature deterministic + null for successes', () => {
  it('returns null for successes', () => {
    expect(clusterKey(makeSuccess(1))).toBeNull();
  });

  it('builds deterministic signature from depth + selector + error', () => {
    const r = makeRevert(1, 10, '0x23b872dd', 'out of gas');
    expect(clusterKey(r)).toBe('depth=10|sel=0x23b872dd|err=out of gas');
  });

  it('different rootCauseError → different signature', () => {
    expect(clusterKey(makeRevert(1, 10, '0x23b872dd', 'out of gas'))).not.toBe(
      clusterKey(makeRevert(2, 10, '0x23b872dd', 'insufficient balance for transfer')),
    );
  });

  it('different depth → different signature even if selector matches', () => {
    expect(clusterKey(makeRevert(1, 8, '0x6e553f65', 'foo'))).not.toBe(
      clusterKey(makeRevert(2, 10, '0x6e553f65', 'foo')),
    );
  });
});

describe('aggregateResults — clustering + partitioning logic', () => {
  it('groups 3 props with identical signature into single cluster of 3 (bridge-saga #49/#50/#52 pattern)', () => {
    const results = [
      makeRevert(49, 10, '0x23b872dd', 'out of gas'),
      makeRevert(50, 10, '0x23b872dd', 'out of gas'),
      makeRevert(52, 10, '0x23b872dd', 'out of gas'),
    ];
    const { clusters, successes, skipped } = aggregateResults(results);
    expect(clusters.size).toBe(1);
    expect(successes).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    const [[sig, items]] = [...clusters.entries()];
    expect(sig).toBe('depth=10|sel=0x23b872dd|err=out of gas');
    expect(items.map((i: any) => i.id)).toEqual([49, 50, 52]);
  });

  it('separates 3 props with 3 different signatures into 3 clusters (bridge-saga full taxonomy)', () => {
    const results = [
      makeRevert(41, 6, '0x606326ff', 'out of gas'), // LiFi
      makeRevert(44, 8, '0x6e553f65', 'insufficient balance for transfer'), // GasZip
      makeRevert(49, 10, '0x23b872dd', 'out of gas'), // BREAD transferFrom
    ];
    const { clusters } = aggregateResults(results);
    expect(clusters.size).toBe(3);
    const sigs = [...clusters.keys()];
    expect(sigs).toContain('depth=6|sel=0x606326ff|err=out of gas');
    expect(sigs).toContain('depth=8|sel=0x6e553f65|err=insufficient balance for transfer');
    expect(sigs).toContain('depth=10|sel=0x23b872dd|err=out of gas');
  });

  it('partitions successes + reverts + skipped correctly', () => {
    const results = [
      makeSuccess(60),
      makeRevert(44, 8, '0x6e553f65', 'insufficient balance for transfer'),
      makeSkip(99, 'No Winner event yet'),
      makeSuccess(62),
    ];
    const { clusters, successes, skipped } = aggregateResults(results);
    expect(successes.map((s: any) => s.id)).toEqual([60, 62]);
    expect(skipped.map((s: any) => s.id)).toEqual([99]);
    expect(clusters.size).toBe(1);
  });

  it('handles outerTxReverted=true and =false within same cluster (mixed kind)', () => {
    // Synthetic mixed cluster — same signature but one outer-tx-reverted, one inner-only
    const results = [
      makeRevert(70, 5, '0xabcdef00', 'out of gas', true), // outer-tx reverted
      makeRevert(71, 5, '0xabcdef00', 'out of gas', false), // inner-revert only
      makeRevert(72, 5, '0xabcdef00', 'out of gas', false),
    ];
    const { clusters } = aggregateResults(results);
    expect(clusters.size).toBe(1);
    const items = [...clusters.values()][0];
    const outerCount = items.filter((i: any) => i.outerTxReverted === true).length;
    const innerCount = items.filter((i: any) => i.outerTxReverted === false).length;
    expect(outerCount).toBe(1);
    expect(innerCount).toBe(2);
  });

  it('all-success input: 0 clusters, all in successes', () => {
    const results = [makeSuccess(60), makeSuccess(62), makeSuccess(66)];
    const { clusters, successes, skipped } = aggregateResults(results);
    expect(clusters.size).toBe(0);
    expect(successes).toHaveLength(3);
    expect(skipped).toHaveLength(0);
  });

  it('all-skipped input (non-finalized props): 0 clusters, 0 successes, all in skipped', () => {
    const results = [
      makeSkip(100, 'No Winner event yet'),
      makeSkip(101, 'No Winner event yet'),
    ];
    const { clusters, successes, skipped } = aggregateResults(results);
    expect(clusters.size).toBe(0);
    expect(successes).toHaveLength(0);
    expect(skipped).toHaveLength(2);
  });

  it('empty input: empty all', () => {
    const { clusters, successes, skipped } = aggregateResults([]);
    expect(clusters.size).toBe(0);
    expect(successes).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });
});

describe('integration — bridge-saga 3-class taxonomy via aggregation', () => {
  it('reproduces empirical HB#629 sweep findings from synthetic results', () => {
    // Full bridge-saga 5-prop set as synthetic data
    const results = [
      makeRevert(41, 6, '0x606326ff', 'out of gas'), // LiFi cluster (1×)
      makeRevert(44, 8, '0x6e553f65', 'insufficient balance for transfer'), // GasZip cluster (1×)
      makeRevert(49, 10, '0x23b872dd', 'out of gas'), // BREAD cluster (3×)
      makeRevert(50, 10, '0x23b872dd', 'out of gas'),
      makeRevert(52, 10, '0x23b872dd', 'out of gas'),
    ];
    const { clusters, successes, skipped } = aggregateResults(results);

    expect(clusters.size).toBe(3); // 3-class taxonomy
    expect(successes).toHaveLength(0);
    expect(skipped).toHaveLength(0);

    // BREAD cluster has 3 proposals
    const breadCluster = clusters.get('depth=10|sel=0x23b872dd|err=out of gas');
    expect(breadCluster).toBeDefined();
    expect(breadCluster!.map((r: any) => r.id)).toEqual([49, 50, 52]);

    // All 5 are inner-revert-only (outerTxReverted=false by default)
    const allItems = [...clusters.values()].flat();
    const innerOnlyCount = allItems.filter((i: any) => i.outerTxReverted === false).length;
    expect(innerOnlyCount).toBe(5);
  });

  it('outerRevertedCount/innerRevertOnlyCount partition matches JSON-mode output schema', () => {
    // Synthesizes the per-cluster breakdown used in main()'s JSON output
    const results = [
      makeRevert(80, 5, '0xaabb', 'reverted', true), // outer-tx reverted
      makeRevert(81, 5, '0xaabb', 'reverted', true),
      makeRevert(82, 5, '0xaabb', 'reverted', false), // inner-only
    ];
    const { clusters } = aggregateResults(results);
    const items = [...clusters.values()][0];
    const outerTxRevertedCount = items.filter((i: any) => i.outerTxReverted === true).length;
    const innerRevertOnlyCount = items.filter((i: any) => i.outerTxReverted === false).length;
    expect(outerTxRevertedCount).toBe(2);
    expect(innerRevertOnlyCount).toBe(1);
  });
});
