#!/usr/bin/env node
/**
 * HB#643 vigil task #526 — env-gated integration test for post-mortem-batch.mjs.
 *
 * Hits LIVE Gnosis RPC + Snapshot. NOT in default yarn test (RPC cost +
 * flakiness). Run manually when validating cross-validation behavior:
 *
 *   POP_E2E_NETWORK=gnosis node test/scripts/post-mortem-batch-e2e.js
 *
 * Expects: 3 distinct revert clusters across Argus bridge-saga 5-prop set
 * (#41/#44/#49/#50/#52), with all 5 reverts classified as inner-revert-only
 * (outerTxReverted=false). Reproduces the HB#629 empirical sweep finding.
 *
 * Provenance: vigil HB#629 sweep, argus HB#732 cross-agent validation,
 * RULE #25 Layer 3 CI gate (HB#642 covered the underlying trace-walk;
 * HB#643 covers the batch clustering).
 */

import { execSync } from 'node:child_process';

const ENABLED = process.env.POP_E2E_NETWORK === 'gnosis';
if (!ENABLED) {
  console.log('SKIPPED: env-gated. Set POP_E2E_NETWORK=gnosis to run.');
  console.log('  Expected runtime: ~30-90 sec (5 Snapshot/RPC queries).');
  process.exit(0);
}

console.log('Running post-mortem-batch e2e against Argus bridge-saga 5-prop set...');

let raw;
try {
  raw = execSync(
    'node agent/scripts/post-mortem-batch.mjs --proposals 41,44,49,50,52 --reverts-only --json --timeout 90',
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 },
  );
} catch (err) {
  console.error('FAIL: subprocess invocation errored');
  console.error('  stderr:', err.stderr?.toString() || err.message);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  console.error('FAIL: JSON output is not parseable. HB#735 stderr-merge regression?');
  console.error('  raw[0..500]:', raw.slice(0, 500));
  process.exit(1);
}

// Acceptance from task #526:
// - 3 distinct revert clusters surfaced
// - inner-revert-only count = 5 (all 5 props match the execute-internal-revert pattern)
// - expected cluster signatures (LiFi/GasZip/BREAD)

const errs = [];

if (parsed.scanned !== 5) errs.push(`expected scanned=5, got ${parsed.scanned}`);
const revertedCount = parsed.scanned - parsed.successes - parsed.skipped;
if (revertedCount !== 5) {
  errs.push(`expected 5 reverts; got ${revertedCount} (skipped=${parsed.skipped})`);
}
if (!Array.isArray(parsed.clusters) || parsed.clusters.length !== 3) {
  errs.push(`expected 3 clusters, got ${parsed.clusters?.length}`);
}

const expectedSignatures = [
  'depth=6|sel=0x606326ff|err=out of gas', // LiFi #41
  'depth=8|sel=0x6e553f65|err=insufficient balance for transfer', // GasZip #44
  'depth=10|sel=0x23b872dd|err=out of gas', // BREAD #49/#50/#52
];
const gotSignatures = (parsed.clusters || []).map((c) => c.signature);
for (const want of expectedSignatures) {
  if (!gotSignatures.includes(want)) errs.push(`missing expected cluster signature: ${want}`);
}

// All 5 props should be inner-revert-only (outerTxReverted=false)
let totalInnerOnly = 0;
let totalOuterReverted = 0;
for (const c of parsed.clusters || []) {
  totalInnerOnly += c.innerRevertOnlyCount || 0;
  totalOuterReverted += c.outerTxRevertedCount || 0;
}
if (totalInnerOnly !== 5) {
  errs.push(`expected 5 inner-revert-only props (HB#629 finding); got ${totalInnerOnly}`);
}
if (totalOuterReverted !== 0) {
  errs.push(`expected 0 outer-tx-reverted props; got ${totalOuterReverted}`);
}

if (errs.length > 0) {
  console.error('FAIL: e2e acceptance not met');
  for (const e of errs) console.error('  -', e);
  process.exit(1);
}

console.log('PASS: 3 expected clusters with 5/5 inner-revert-only classification');
console.log('  - LiFi (#41) — depth 6 / 0x606326ff / out of gas');
console.log('  - GasZip (#44) — depth 8 / 0x6e553f65 / insufficient balance for transfer');
console.log('  - BREAD (#49/#50/#52) — depth 10 / 0x23b872dd / out of gas (3-prop cluster)');
console.log('  bridge-saga 3-class taxonomy reproduced empirically.');
