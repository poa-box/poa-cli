#!/usr/bin/env node
/**
 * API-surface tripwire for @poa/core.
 *
 * The exported surface IS the stability contract other teams depend on
 * (same policy as the CLI's docs/reference/cli/output-contracts.json for
 * --json keys): within a major version, adding exports is fine; renaming,
 * removing, or moving them is a break.
 *
 * `node scripts/check-api-surface.mjs`            diff built dist/ against api-surface.json
 * `node scripts/check-api-surface.mjs --update`   regenerate api-surface.json (the diff
 *                                                 then shows up in code review)
 *
 * The surface is extracted from dist/**\/*.d.ts declarations: first-level
 * `export` declarations plus re-export directives. It is a tripwire, not a
 * full type diff — signature changes inside a kept name are reviewed via the
 * .d.ts files themselves.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = join(pkgRoot, 'dist');
const surfacePath = join(pkgRoot, 'api-surface.json');
const update = process.argv.includes('--update');

if (!existsSync(distDir)) {
  console.error('api-surface: dist/ not found — run `yarn build` first.');
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const EXPORT_DECL = /^export (?:declare )?(?:abstract )?(?:async )?(?:function|const|let|class|interface|type|enum) ([A-Za-z0-9_$]+)/;
const EXPORT_LIST = /^export (?:type )?\{([^}]*)\}/;
const EXPORT_STAR = /^export \* (?:as ([A-Za-z0-9_$]+) )?from ['"]([^'"]+)['"]/;

function extractSurface(file) {
  const names = new Set();
  const src = readFileSync(file, 'utf-8');
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    const decl = line.match(EXPORT_DECL);
    if (decl) { names.add(decl[1]); continue; }
    const list = line.match(EXPORT_LIST);
    if (list) {
      for (const piece of list[1].split(',')) {
        const name = piece.split(' as ').pop().trim();
        if (name) names.add(name);
      }
      continue;
    }
    const star = line.match(EXPORT_STAR);
    if (star) names.add(star[1] ? `* as ${star[1]} (${star[2]})` : `* (${star[2]})`);
  }
  return [...names].sort();
}

const surface = {};
for (const file of walk(distDir).sort()) {
  const mod = relative(distDir, file).replace(/\.d\.ts$/, '');
  if (mod.startsWith('abis/') && mod !== 'abis/index') continue; // generated; index registry is the contract
  const names = extractSurface(file);
  if (names.length) surface[mod] = names;
}

if (update) {
  writeFileSync(surfacePath, JSON.stringify(surface, null, 2) + '\n');
  console.log(`api-surface: wrote ${surfacePath} (${Object.keys(surface).length} modules)`);
  process.exit(0);
}

if (!existsSync(surfacePath)) {
  console.error('api-surface: api-surface.json missing — run with --update to create it.');
  process.exit(1);
}

const expected = JSON.parse(readFileSync(surfacePath, 'utf-8'));
const problems = [];
for (const [mod, names] of Object.entries(expected)) {
  const actual = new Set(surface[mod] ?? []);
  if (!surface[mod]) {
    problems.push(`module REMOVED: ${mod} (exported: ${names.join(', ')})`);
    continue;
  }
  for (const name of names) {
    if (!actual.has(name)) problems.push(`export REMOVED: ${mod} → ${name}`);
  }
}

if (problems.length) {
  console.error('api-surface: BREAKING — the published surface lost exports:\n');
  for (const p of problems) console.error('  ' + p);
  console.error('\nIf this break is intentional, bump the major version and run --update.');
  process.exit(1);
}

// Additions are allowed but should be recorded so the next diff is clean.
const additions = [];
for (const [mod, names] of Object.entries(surface)) {
  const known = new Set(expected[mod] ?? []);
  for (const name of names) if (!known.has(name)) additions.push(`${mod} → ${name}`);
}
if (additions.length) {
  console.log(`api-surface: OK (${additions.length} new export(s) not yet recorded — run --update to record):`);
  for (const a of additions.slice(0, 20)) console.log('  + ' + a);
} else {
  console.log('api-surface: OK — surface matches api-surface.json exactly.');
}
