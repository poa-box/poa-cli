#!/usr/bin/env node
/**
 * agent/scripts/post-mortem-batch.mjs
 *
 * Iterates `pop vote post-mortem --proposal N` across a range of proposals
 * + emits a cluster-classification table. Codifies vigil's HB#618 manual
 * cross-validation workflow that distinguished the bridge-saga retry
 * cluster (#49/#50/#52 identical signature) from the precursor (#41
 * different signature).
 *
 * Empirical use: detect failure-class clusters by aligning rootCauseDepth +
 * rootCauseSelector + rootCauseError across multiple finalized proposals.
 * Same signature across N props = same failure class = same fix scope.
 *
 * Usage:
 *   node agent/scripts/post-mortem-batch.mjs --range 41-66
 *   node agent/scripts/post-mortem-batch.mjs --proposals 41,49,50,52,60
 *   node agent/scripts/post-mortem-batch.mjs --range 41-66 --json
 *   node agent/scripts/post-mortem-batch.mjs --range 41-66 --reverts-only
 *
 * Output: human-readable table (default) or JSON. Reverts grouped by signature
 * (rootCauseDepth + rootCauseSelector + rootCauseError) to surface clusters.
 *
 * Exit codes:
 *   0 success (some proposals may be unfinalized; those are reported as skipped)
 *   1 error (post-mortem CLI invocation failed; check stderr)
 */

import { execSync } from 'node:child_process';

function parseArgs(argv) {
  const args = { json: false, revertsOnly: false, timeoutMs: 60000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--reverts-only') args.revertsOnly = true;
    else if (a === '--range') {
      const v = argv[++i];
      const m = v.match(/^(\d+)-(\d+)$/);
      if (!m) throw new Error(`--range expects N-M form, got ${v}`);
      args.range = [parseInt(m[1]), parseInt(m[2])];
    } else if (a === '--proposals') {
      args.proposals = argv[++i].split(',').map((s) => parseInt(s.trim()));
    } else if (a === '--timeout') {
      const v = argv[++i];
      const seconds = parseInt(v);
      if (isNaN(seconds) || seconds < 1) {
        throw new Error(`--timeout expects a positive integer (seconds), got ${v}`);
      }
      args.timeoutMs = seconds * 1000;
    } else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function helpText() {
  return `post-mortem-batch: iterate pop vote post-mortem across proposals

Usage:
  node agent/scripts/post-mortem-batch.mjs --range N-M [--json] [--reverts-only] [--timeout S]
  node agent/scripts/post-mortem-batch.mjs --proposals N,N,N [--json] [--reverts-only] [--timeout S]

Flags:
  --range N-M       proposal id range (inclusive)
  --proposals N,N,N comma-separated list of specific proposal ids
  --reverts-only    suppress proposals that succeeded (status=true)
  --timeout S       per-call timeout in seconds (default 60). Bump for slow
                    chains (Gnosis 60-90s recommended; faster chains 30s OK).
                    HB#727 found Argus #49 needs ~45s on Gnosis.
  --json            machine-readable output
  --help            this text

Codifies vigil HB#618 cross-validation workflow: groups reverts by
(rootCauseDepth + rootCauseSelector + rootCauseError) signature to
surface failure-class clusters.
`;
}

function runPostMortem(proposalId, timeoutMs = 60000) {
  try {
    const out = execSync(
      `pop vote post-mortem --proposal ${proposalId} --json`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs },
    );
    return JSON.parse(out);
  } catch (err) {
    // Either non-finalized proposal (no Winner event) or RPC error
    const msg = err.stderr?.toString() || err.message || '';
    return { proposalId, error: msg.split('\n')[0].slice(0, 200) };
  }
}

function clusterKey(r) {
  if (r.success) return null; // successes don't cluster
  return `depth=${r.rootCauseDepth}|sel=${r.rootCauseSelector}|err=${r.rootCauseError}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.range && !args.proposals)) {
    console.log(helpText());
    process.exit(0);
  }

  const ids = args.proposals ?? [];
  if (args.range) {
    for (let i = args.range[0]; i <= args.range[1]; i++) ids.push(i);
  }

  const results = [];
  for (const id of ids) {
    if (!args.json) process.stderr.write(`  scanning prop #${id}... `);
    const r = runPostMortem(id, args.timeoutMs);
    results.push({ id, ...r });
    if (!args.json) {
      if (r.error) process.stderr.write(`skip (${r.error.slice(0, 50)})\n`);
      else process.stderr.write(`${r.success ? 'OK' : 'REVERT'} gas=${r.totalGasUsed}\n`);
    }
  }

  // Cluster reverts by signature
  const clusters = new Map();
  const successes = [];
  const skipped = [];
  for (const r of results) {
    if (r.error) {
      skipped.push(r);
      continue;
    }
    if (r.success) {
      successes.push(r);
      continue;
    }
    const key = clusterKey(r);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(r);
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          scanned: results.length,
          successes: successes.length,
          reverts: results.length - successes.length - skipped.length,
          skipped: skipped.length,
          clusters: [...clusters.entries()].map(([sig, items]) => ({
            signature: sig,
            count: items.length,
            proposalIds: items.map((i) => i.id),
            // HB#627 vigil: per-cluster outerTxReverted breakdown distinguishes
            // execute-internal-revert pattern (outer announce-tx succeeded but
            // inner Executor.execute() reverted) from true outer-tx reverts.
            // All bridge-saga props (#41/#44/#49/#50/#52) are inner-revert
            // pattern; receipt-status alerting alone misses them.
            outerTxRevertedCount: items.filter((i) => i.outerTxReverted === true).length,
            innerRevertOnlyCount: items.filter((i) => i.outerTxReverted === false).length,
            example: {
              rootCauseDepth: items[0].rootCauseDepth,
              rootCauseSelector: items[0].rootCauseSelector,
              rootCauseError: items[0].rootCauseError,
              outerTxReverted: items[0].outerTxReverted,
              frames: items[0].frames?.length,
              totalGasUsed: items[0].totalGasUsed,
            },
          })),
          skippedDetail: skipped.map((s) => ({ id: s.id, error: s.error })),
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  console.log('');
  console.log(`  post-mortem-batch summary: ${results.length} proposals scanned`);
  console.log(
    `    ${successes.length} succeeded · ${results.length - successes.length - skipped.length} reverted · ${skipped.length} skipped (no Winner event yet)`,
  );
  console.log('');

  if (!args.revertsOnly && successes.length > 0) {
    console.log(`  Successes (${successes.length}):`);
    for (const s of successes) {
      console.log(`    ✓ Prop #${s.id}  gas=${s.totalGasUsed}  frames=${s.frames?.length ?? '?'}`);
    }
    console.log('');
  }

  if (clusters.size > 0) {
    console.log(`  Revert clusters (${clusters.size}):`);
    for (const [sig, items] of clusters.entries()) {
      const ex = items[0];
      const outerCnt = items.filter((i) => i.outerTxReverted === true).length;
      const innerCnt = items.filter((i) => i.outerTxReverted === false).length;
      // HB#627: outer-tx vs inner-frame revert breakdown per cluster
      const revertKind =
        outerCnt > 0 && innerCnt > 0
          ? `mixed (outer=${outerCnt} inner-only=${innerCnt})`
          : outerCnt > 0
            ? `outer-tx-reverted`
            : `inner-frame-only (receipt.status=1)`;
      console.log(
        `    🔴 cluster (${items.length}× signature): props [${items.map((i) => '#' + i.id).join(', ')}]`,
      );
      console.log(
        `       depth=${ex.rootCauseDepth} selector=${ex.rootCauseSelector} error="${ex.rootCauseError}" frames=${ex.frames?.length}`,
      );
      console.log(`       revert-kind: ${revertKind}`);
    }
    console.log('');
  }

  if (skipped.length > 0 && !args.revertsOnly) {
    console.log(`  Skipped (${skipped.length}): ${skipped.map((s) => '#' + s.id).join(', ')}`);
    console.log('');
  }
}

main();