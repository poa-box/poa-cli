#!/usr/bin/env node
// agent/scripts/wire-check.mjs — orphan-tool detector
//
// HB#717 hygiene script per the n=4 orphan-tool pattern surfaced this session arc:
// - HB#670 (argus): pop vote simulate orphan
// - HB#613 (vigil): pop vote post-mortem orphan
// - HB#614 (vigil): pop agent explain + vote discuss + vote conflicts orphan x3 (10-file backlog)
// - HB#714 (argus): self-metrics import accidentally clobbered by HB#609 TDD commit
// - HB#716 (argus): pop agent explain duplicate-claim with vigil HB#614
//
// All instances: src/commands/<domain>/<tool>.ts file exists as committed implementation
// but never registered (or registration was lost) in src/commands/<domain>/index.ts.
// CLI surface returns help-page fallback when invoked. capabilities.md may falsely claim shipped.
//
// This script scans every src/commands/<domain>/*.ts file and verifies it's imported by
// the corresponding domain's index.ts. Flags unwired files. Optionally fails CI with --strict.
//
// Usage:
//   node agent/scripts/wire-check.mjs                    # report only (exit 0 always)
//   node agent/scripts/wire-check.mjs --strict           # exit 1 if any unwired files found
//   node agent/scripts/wire-check.mjs --json             # machine-readable output
//
// Should be added as a CI check + run periodically as a brain-lesson trigger.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = 'src/commands';

// Skip these — they're domain index files or shared helpers, not commands themselves.
const SKIP_FILES = new Set([
  'index.ts',
  'helpers.ts',
]);

// Some files use suffix-renamed exports (e.g. session-start exports sessionStartHandler_export).
// We just look for any reference to the file's path or its likely-exported handler name in index.ts
// to allow flexibility. False-positives are caught by the lookup-string strategy below.

function parseArgs(argv) {
  return {
    strict: argv.includes('--strict'),
    json: argv.includes('--json'),
  };
}

// Detect domains: each directory under src/commands/ is a domain (vote, task, agent, etc).
function listDomains() {
  const entries = readdirSync(ROOT, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function tsFilesIn(domainPath) {
  return readdirSync(domainPath)
    .filter((f) => f.endsWith('.ts') && !SKIP_FILES.has(f));
}

function checkDomain(domain) {
  const domainPath = join(ROOT, domain);
  const indexPath = join(domainPath, 'index.ts');
  if (!existsSync(indexPath)) {
    return { domain, indexExists: false, unwired: [], wired: [], total: 0 };
  }

  const indexBody = readFileSync(indexPath, 'utf8');
  const tsFiles = tsFilesIn(domainPath);

  const unwired = [];
  const wired = [];

  for (const file of tsFiles) {
    const baseName = file.replace(/\.ts$/, ''); // e.g. "post-mortem"
    // Strategy: index.ts must mention the bare filename (without .ts) somewhere in
    // an import statement. We look for `from './<baseName>'` or `from "./<baseName>"`.
    // This handles all canonical import patterns; misses unusual aliasing (rare).
    const importRegex = new RegExp(`from\\s+['"]\\./${baseName.replace(/[-/\\^$*+?.()|[\\]{}]/g, '\\$&')}['"]`);
    if (importRegex.test(indexBody)) {
      wired.push(file);
    } else {
      // Also check if the file contains a yargs builder/handler — some files might
      // be helper modules that don't NEED to be wired. We use a lightweight heuristic:
      // files exporting `Handler` (e.g. `export const fooHandler = {...}`) are CLI commands.
      const fileBody = readFileSync(join(domainPath, file), 'utf8');
      const looksLikeCommand = /export\s+(const|function)\s+\w+Handler\b/.test(fileBody);
      if (looksLikeCommand) {
        unwired.push(file);
      }
      // If it doesn't export a Handler, treat as helper module (silent skip).
    }
  }

  return { domain, indexExists: true, unwired, wired, total: tsFiles.length };
}

// HB#986: dangling-import check (tracked-imports-untracked-source pattern).
//
// Counterpart to the orphan-tool check above. Catches the inverse failure mode
// where a committed .ts file imports from a relative path whose target exists
// on disk but was never `git add`-ed. Local builds pass; fresh clones fail with
// TS2307 module-not-found. Pattern documented in HB#985 brain.shared lesson.
function checkDanglingImports() {
  const tracked = execSync('git ls-files src/', { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
  const trackedSet = new Set(tracked);
  const importRegex = /from\s+['"](\.\.?\/[^'"]+)['"]/g;
  const violations = [];

  for (const f of tracked) {
    if (!f.endsWith('.ts')) continue;
    let body;
    try { body = readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of body.matchAll(importRegex)) {
      const imp = m[1];
      const baseDir = dirname(f);
      const resolvedBase = normalize(join(baseDir, imp));
      const candidates = [resolvedBase, resolvedBase + '.ts', resolvedBase + '/index.ts'];
      const isTracked = candidates.some((c) => trackedSet.has(c));
      if (isTracked) continue;
      const existingOnDisk = candidates.find((c) => existsSync(c));
      if (existingOnDisk) {
        violations.push({ source: f, importPath: imp, resolvedTo: existingOnDisk });
      }
    }
  }
  return violations;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const domains = listDomains();
  const results = domains.map(checkDomain);

  const totalUnwired = results.reduce((sum, r) => sum + r.unwired.length, 0);
  const totalWired = results.reduce((sum, r) => sum + r.wired.length, 0);

  const danglingImports = checkDanglingImports();

  if (args.json) {
    console.log(JSON.stringify({
      summary: { totalUnwired, totalWired, totalDanglingImports: danglingImports.length, domains: domains.length },
      results,
      danglingImports,
    }, null, 2));
  } else {
    console.log(`\n  wire-check: ${totalWired} CLI handlers wired across ${domains.length} domains`);
    console.log(`  ${totalUnwired === 0 ? '✓ NO unwired CLI handlers' : `⚠️  ${totalUnwired} UNWIRED handlers found:`}`);
    for (const r of results) {
      if (r.unwired.length > 0) {
        console.log(`  src/commands/${r.domain}/`);
        for (const f of r.unwired) {
          console.log(`    ⚠️  ${f}  (handler exported but not imported in index.ts)`);
        }
      }
    }
    console.log(`  ${danglingImports.length === 0 ? '✓ NO dangling imports' : `⚠️  ${danglingImports.length} DANGLING imports (committed code → untracked source):`}`);
    for (const v of danglingImports) {
      console.log(`    ⚠️  ${v.source} → '${v.importPath}' (file exists at ${v.resolvedTo} but is not git-tracked)`);
    }
    console.log();
    if (totalUnwired === 0 && danglingImports.length === 0) {
      console.log('  All CLI handlers are wired and all relative imports resolve to tracked files. Repo is clean.\n');
    } else {
      if (totalUnwired > 0) {
        console.log(`  Fix unwired: import the handler in src/commands/<domain>/index.ts + add a .command() registration.`);
        console.log(`  Pattern n=4 across HB#670/#613/#614/#714/#716 demonstrates this is a recurring class.`);
      }
      if (danglingImports.length > 0) {
        console.log(`  Fix dangling: \`git add\` the listed files. Pattern n=2 surfaced HB#985 (vote/simulate.ts, lib/x402.ts).`);
      }
      console.log(`  Reference: brain.shared HB#717 (wire-check) + HB#985 (dangling-imports).\n`);
    }
  }

  const hasErrors = totalUnwired > 0 || danglingImports.length > 0;
  process.exit(args.strict && hasErrors ? 1 : 0);
}

main();
