/**
 * check-output-contracts — the --json OUTPUT contract, made enforceable.
 *
 * The CLI's whole value as a compatibility layer is that consumers (frontend,
 * agents, org brains) parse `--json` output and NEVER have to track protocol
 * or subgraph churn. That only holds if the output shapes are frozen by a
 * check, not a convention. This script freezes them:
 *
 *   yarn contracts:check            run the contracted read-only commands
 *                                   LIVE and fail if any promised key is
 *                                   missing from the output (extra keys are
 *                                   fine — the contract is additive-only)
 *   yarn contracts:check --update   re-capture the observed shapes into
 *                                   docs/reference/cli/output-contracts.json
 *                                   (review the diff! removals = breaking)
 *
 * Runs against the live default org/chain from your env, so it belongs in
 * the RELEASE flow (see docs/RELEASING.md), not CI. The CI-safe half —
 * "every contracted command exists and is read-only" — lives in
 * test/docs/output-contracts.test.ts.
 *
 * Key notation: top-level object keys as-is; for array payloads (or array
 * fields), the first element's keys as "field[].key". An empty live array
 * cannot be captured — those entries are kept from the previous contract and
 * reported as unverifiable rather than silently dropped.
 */

import { execFileSync } from 'child_process';
import { unobservableItemKeys } from './lib/output-contract';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const CONTRACT_PATH = path.join(ROOT, 'docs', 'reference', 'cli', 'output-contracts.json');
const CLI = path.join(ROOT, 'dist', 'index.js');

/**
 * The contracted surface: read-only, runnable with just POP_DEFAULT_ORG /
 * POP_DEFAULT_CHAIN configured. Add a command here when a consumer starts
 * depending on it.
 */
const CONTRACTED: Array<{ name: string; argv: string[] }> = [
  { name: 'org list', argv: ['org', 'list'] },
  { name: 'org status', argv: ['org', 'status'] },
  { name: 'org roles', argv: ['org', 'roles'] },
  { name: 'task list', argv: ['task', 'list'] },
  { name: 'vote list', argv: ['vote', 'list'] },
  { name: 'user whoami', argv: ['user', 'whoami'] },
  { name: 'token balance', argv: ['token', 'balance'] },
  { name: 'treasury distributions', argv: ['treasury', 'distributions'] },
  { name: 'paymaster status', argv: ['paymaster', 'status'] },
  { name: 'education list', argv: ['education', 'list'] },
  { name: 'zkemail claims', argv: ['zkemail', 'claims'] },
  { name: 'config show', argv: ['config', 'show'] },
];

function keyPaths(value: unknown): string[] {
  const paths = new Set<string>();
  if (Array.isArray(value)) {
    if (value.length > 0 && value[0] && typeof value[0] === 'object') {
      for (const k of Object.keys(value[0] as object)) paths.add(`[].${k}`);
    }
    return [...paths].sort();
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as object)) {
      paths.add(k);
      if (Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object') {
        for (const ik of Object.keys(v[0] as object)) paths.add(`${k}[].${ik}`);
      }
    }
  }
  return [...paths].sort();
}

function run(argv: string[]): unknown {
  const stdout = execFileSync(process.execPath, [CLI, ...argv, '--json', '--quiet'], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, POP_READONLY: '1' }, // structural: this script can never write
  });
  return JSON.parse(stdout);
}

function main(): void {
  const update = process.argv.includes('--update');
  const previous: Record<string, string[]> = fs.existsSync(CONTRACT_PATH)
    ? JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8')).contracts
    : {};

  const observed: Record<string, string[]> = {};
  const failures: string[] = [];
  const unverifiable: string[] = [];

  for (const { name, argv } of CONTRACTED) {
    let paths: string[];
    try {
      const value = run(argv);
      paths = keyPaths(value);
      const carried = unobservableItemKeys(value, previous[name] ?? []);
      if (carried.length && paths.length) {
        paths = [...new Set([...paths, ...carried])].sort();
        unverifiable.push(name);
      }
    } catch (e: any) {
      failures.push(`${name}: command failed — ${String(e.message).slice(0, 200)}`);
      continue;
    }
    if (paths.length === 0) {
      // Empty array live (e.g. no claims yet) — carry the old promise forward.
      unverifiable.push(name);
      observed[name] = previous[name] ?? [];
      continue;
    }
    observed[name] = paths;

    if (!update) {
      const promised = previous[name];
      if (!promised) {
        failures.push(`${name}: no recorded contract — run with --update first`);
        continue;
      }
      const missing = promised.filter((k) => !paths.includes(k));
      if (missing.length > 0) {
        failures.push(`${name}: BREAKING — promised keys missing from live output: ${missing.join(', ')}`);
      }
    }
  }

  if (update) {
    const doc = {
      _comment:
        'The --json output contract. Keys listed here are PROMISED to consumers: removing or renaming one is a breaking change (major version). Adding keys is always safe. Regenerate with `yarn contracts:check --update` and REVIEW THE DIFF — a removal must be deliberate.',
      schemaVersion: 1,
      contracts: observed,
    };
    fs.writeFileSync(CONTRACT_PATH, JSON.stringify(doc, null, 2) + '\n');
    console.log(`wrote ${path.relative(ROOT, CONTRACT_PATH)} (${Object.keys(observed).length} commands)`);
    if (unverifiable.length) console.log(`  unverifiable (empty live data, carried forward): ${unverifiable.join(', ')}`);
    return;
  }

  for (const u of unverifiable) console.log(`  ~ ${u}: empty live data, contract carried but unverified`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`output contracts OK (${CONTRACTED.length - unverifiable.length} verified live, ${unverifiable.length} carried)`);
}

main();
