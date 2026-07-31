#!/usr/bin/env node
/**
 * probe-diff — diff two `pop org probe-access --json` outputs.
 *
 * Usage:
 *   node agent/scripts/probe-diff.mjs <upstream.json> <fork.json>
 *
 * Emits a divergence table: for each function probed on both sides,
 * show the classification pair and flag the rows that differ. The
 * interesting signal is a function that is gated on upstream but
 * passed on the fork (or vice versa) — that's a fork behavior delta
 * detectable without reading source.
 *
 * Shipped in HB#165 after HB#164 found 5 diverging functions between
 * Compound Governor Bravo (upstream) and Uniswap Governor Bravo (fork)
 * on Ethereum mainnet using the same Sourcify-fetched Compound ABI.
 *
 * Future: promote to `pop org probe-diff --upstream X --fork Y --abi Z`
 * CLI command once the shape settles. For now a standalone script keeps
 * the iteration cheap.
 */

import { readFileSync } from 'node:fs';

function load(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[probe-diff] failed to load ${path}: ${err.message}`);
    process.exit(1);
  }
}

function indexByName(results) {
  const out = new Map();
  for (const r of results) out.set(r.name, r);
  return out;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n - 1) + '…' : s + ' '.repeat(n - s.length);
}

const [upstreamPath, forkPath] = process.argv.slice(2);
if (!upstreamPath || !forkPath) {
  console.error('Usage: node agent/scripts/probe-diff.mjs <upstream.json> <fork.json>');
  process.exit(2);
}

const upstream = load(upstreamPath);
const fork = load(forkPath);

const uIdx = indexByName(upstream.results || []);
const fIdx = indexByName(fork.results || []);

const allNames = new Set([...uIdx.keys(), ...fIdx.keys()]);
const rows = [];
let diffs = 0;
let same = 0;

for (const name of [...allNames].sort()) {
  const u = uIdx.get(name);
  const f = fIdx.get(name);
  const uStat = u ? u.status : 'MISSING';
  const fStat = f ? f.status : 'MISSING';
  const differ = uStat !== fStat;
  if (differ) diffs++;
  else same++;
  rows.push({ name, uStat, fStat, differ });
}

console.log('');
console.log(`upstream: ${upstreamPath}  (${upstream.address} on chain ${upstream.chainId})`);
console.log(`    fork: ${forkPath}  (${fork.address} on chain ${fork.chainId})`);
console.log(`  probed: ${upstream.functionsProbed} / ${fork.functionsProbed} functions`);
console.log(`  result: ${diffs} diverging, ${same} matching`);
console.log('');
console.log(pad('function', 40) + pad('upstream', 12) + pad('fork', 12) + 'diff');
console.log('-'.repeat(68));
for (const r of rows) {
  const marker = r.differ ? '<<<' : '';
  console.log(pad(r.name, 40) + pad(r.uStat, 12) + pad(r.fStat, 12) + marker);
}
console.log('');
if (diffs > 0) {
  console.log('Diverging functions (upstream → fork):');
  for (const r of rows.filter(r => r.differ)) {
    console.log(`  ${r.name}: ${r.uStat} → ${r.fStat}`);
  }
  console.log('');
}

// Exit 0 even when divergences exist — divergence is informational,
// not an error. Exit 1 only on malformed inputs (handled above).
process.exit(0);
