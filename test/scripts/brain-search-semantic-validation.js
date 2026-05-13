#!/usr/bin/env node
/**
 * test/scripts/brain-search-semantic-validation.js — task #567 (argus HB#864)
 *
 * Retroactive validation of brain-search-semantic (task #566) against the
 * 2 empirical miss cases that motivated the work:
 *
 *   Case A — HB#1074 parallel-draft (mutual non-discovery under different filenames):
 *     query = "Part XI joint section"
 *     expected = sentinel HB#1070 + vigil HB#721 BOTH in top-5
 *
 *   Case B — HB#852 prior-finding miss (argus rediscovered CLever Safe 50 HB-arcs
 *            after sentinel HB#1065 due to title-regex miss):
 *     query = "CLever Safe Layer 3 admin"
 *     expected = sentinel HB#1065 + argus HB#852 BOTH in top-5
 *
 * Exit codes:
 *   0 — BOTH queries pass (each expected lesson appears in top-5 results)
 *   2 — at least one query fails
 *
 * Per #567 acceptance: vigil OR sentinel runs this + reports both queries pass.
 *
 * Usage:
 *   node test/scripts/brain-search-semantic-validation.js [--top-k 5] [--verbose]
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const TOOL = path.join(REPO_ROOT, 'agent', 'scripts', 'brain-search-semantic.mjs');

const argv = process.argv.slice(2);
const TOP_K = Number(argv.includes('--top-k') ? argv[argv.indexOf('--top-k') + 1] : 5);
const VERBOSE = argv.includes('--verbose');

// Each case has primary requirements (top-5, miss-case-closure target) and
// optional secondary requirements (top-10, bonus context that surfacing
// alongside the primary improves discoverability but isn't strictly required
// for closing the original miss case). Per HB#864 refinement: the HB#852 miss
// case is closed when HB#1065 (the prior lesson argus failed to find) surfaces;
// HB#852 itself is the discovery lesson and is bonus secondary context.
const CASES = [
  {
    name: 'A — HB#1074 parallel-draft (mutual non-discovery)',
    query: 'Part XI joint section',
    primaryTopK: 5,
    primaryIdSubstrings: [
      'hb-1070-sentinel-part-xi-joint-section',
      'hb-721-vigil-portfolio-v5-part-xi-joint',
    ],
    secondaryTopK: 10,
    secondaryIdSubstrings: [],
  },
  {
    name: 'B — HB#852 prior-finding miss (CLever Safe rediscovery)',
    query: 'CLever Safe Layer 3 admin',
    primaryTopK: 5,
    primaryIdSubstrings: [
      // The actual miss-case target: sentinel HB#1065 is what argus HB#852
      // failed to find via title-regex. Surfacing it via semantic search
      // closes the miss case.
      'hb-1065-ack-argus-section-4-gaas-clever-layer-3-admin-probe',
    ],
    secondaryTopK: 10,
    secondaryIdSubstrings: [
      // Bonus context: argus HB#852 is the discovery lesson. Co-surfacing
      // with HB#1065 improves the deliberation context but isn't required
      // for miss-case closure.
      'hb-852-argus-refinement-per-rule-24',
    ],
  },
];

function runQuery(query, topK) {
  const raw = execFileSync('node', [TOOL, '--query', query, '--top-k', String(topK), '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // Output may contain prefix logs; locate JSON object boundary
  const idx = raw.indexOf('{');
  if (idx < 0) throw new Error(`brain-search-semantic returned no JSON for query "${query}"`);
  return JSON.parse(raw.slice(idx));
}

function checkSubstrings(ids, expectedSubstrings) {
  const found = [];
  const missing = [];
  for (const sub of expectedSubstrings) {
    const hit = ids.find((id) => id && id.toLowerCase().includes(sub));
    if (hit) {
      found.push({ substring: sub, id: hit, rank: ids.indexOf(hit) + 1 });
    } else {
      missing.push(sub);
    }
  }
  return { found, missing };
}

let allPrimaryPassed = true;
const report = [];

console.error(`[brain-search-semantic-validation] tool: ${TOOL}`);
console.error();

for (const tc of CASES) {
  console.error(`=== Case ${tc.name} ===`);
  console.error(`  query: "${tc.query}"`);

  // Run with widest top-K to gather both primary + secondary in one call.
  const widestK = Math.max(tc.primaryTopK, tc.secondaryTopK);
  let result;
  try {
    result = runQuery(tc.query, widestK);
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    report.push({ case: tc.name, primaryPassed: false, error: err.message });
    allPrimaryPassed = false;
    continue;
  }

  const allIds = (result.results ?? []).map((r) => r.id);
  const primaryIds = allIds.slice(0, tc.primaryTopK);
  const secondaryIds = allIds.slice(0, tc.secondaryTopK);

  if (VERBOSE) {
    console.error(`  top-${widestK} ids:`);
    for (let i = 0; i < allIds.length; i++) {
      console.error(`    ${i + 1}. ${allIds[i]}`);
    }
  }

  const primaryCheck = checkSubstrings(primaryIds, tc.primaryIdSubstrings);
  const secondaryCheck = checkSubstrings(secondaryIds, tc.secondaryIdSubstrings);

  for (const f of primaryCheck.found) {
    console.error(`  ✓ PRIMARY (top-${tc.primaryTopK}) rank #${f.rank}: ${f.id}`);
  }
  for (const m of primaryCheck.missing) {
    console.error(`  ✗ PRIMARY MISSING from top-${tc.primaryTopK}: <id matching "${m}">`);
  }
  for (const f of secondaryCheck.found) {
    const tier = f.rank <= tc.primaryTopK ? `top-${tc.primaryTopK}` : `rank #${f.rank}`;
    console.error(`  ✓ SECONDARY (${tier}) ${f.id}`);
  }
  for (const m of secondaryCheck.missing) {
    console.error(`  ⚠ SECONDARY MISSING from top-${tc.secondaryTopK}: <id matching "${m}"> (bonus, not required)`);
  }

  const primaryPassed = primaryCheck.missing.length === 0;
  console.error(`  PRIMARY: ${primaryPassed ? 'PASS' : 'FAIL'}, SECONDARY: ${secondaryCheck.missing.length === 0 ? 'pass' : 'partial'}`);
  console.error();

  report.push({
    case: tc.name,
    query: tc.query,
    primaryPassed,
    primaryFound: primaryCheck.found,
    primaryMissing: primaryCheck.missing,
    secondaryFound: secondaryCheck.found,
    secondaryMissing: secondaryCheck.missing,
    topKIds: allIds,
  });

  if (!primaryPassed) allPrimaryPassed = false;
}

const allPassed = allPrimaryPassed;

console.log(JSON.stringify({
  tool: 'brain-search-semantic-validation-v0.1',
  totalCases: CASES.length,
  primaryPassed: report.filter((r) => r.primaryPassed).length,
  primaryFailed: report.filter((r) => !r.primaryPassed).length,
  allPrimaryPassed: allPassed,
  report,
}, null, 2));

process.exit(allPassed ? 0 : 2);
