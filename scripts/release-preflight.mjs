#!/usr/bin/env node
/**
 * Release preflight: decide — and validate — what this release would publish.
 *
 * Versions live in the checked-in package.json files (bumped in a PR, reviewed
 * like any other change). This script turns them into a publish PLAN and
 * refuses the release if the plan is unsafe. Run it locally before a release,
 * or let the Release workflow run it.
 *
 *   node scripts/release-preflight.mjs           human-readable plan
 *   node scripts/release-preflight.mjs --json    machine plan (CI)
 *
 * What it guards against — every one of these has a real failure mode:
 *
 *  1. NOTHING TO PUBLISH. All three versions already on the registry means
 *     someone forgot to bump. Silently "succeeding" would make a release run
 *     look green while shipping nothing.
 *  2. MOVING `latest` BACKWARDS. npm points `latest` at whatever you publish
 *     MOST RECENTLY, not at the highest version — publishing 0.1.0 while
 *     0.2.0 exists silently downgrades every `npm i @poa-box/cli` consumer.
 *  3. DANGLING INTER-PACKAGE RANGES. prepack pins the CLI to ^<core version>
 *     and the agent to ^<cli version>. If that dependency version is neither
 *     already published nor part of this run, the published tarball points at
 *     a version that does not exist.
 *  4. MALFORMED VERSIONS. A typo'd version reaches the registry permanently —
 *     npm does not allow re-publishing a version, ever.
 *
 * Exit 0 = safe to publish (plan on stdout). Exit 1 = do not publish.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

/**
 * Publish order is dependency order. `dependsOn` names the sibling whose
 * version this package's prepack pins as `^<version>` (see
 * scripts/prepack-core-range.mjs and packages/agent/scripts/prepack-cli-range.mjs).
 */
const PACKAGES = [
  { dir: 'packages/core', dependsOn: null },
  { dir: '.', dependsOn: '@poa-box/core' },
  { dir: 'packages/agent', dependsOn: '@poa-box/cli' },
];

// --- tiny semver (avoids a runtime dependency in a release-critical script) --

/** Parse `1.2.3` / `1.2.3-rc.1`. Returns null when not valid semver. */
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v ?? ''));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] ?? null };
}

/** -1 | 0 | 1, with a prerelease sorting BELOW its release (1.0.0-rc < 1.0.0). */
export function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`cannot compare versions: ${a} / ${b}`);
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1;   // release > prerelease
  if (pb.prerelease === null) return -1;
  return pa.prerelease < pb.prerelease ? -1 : 1;
}

// --- registry ---------------------------------------------------------------

/**
 * Registry facts for a package, or `{ published: false }` when the name has
 * never been published. A network/auth failure THROWS — an unreachable
 * registry must abort the release, never look like "unpublished" (which would
 * skip the backwards-`latest` guard entirely).
 */
function registryInfo(name) {
  try {
    const out = execFileSync('npm', ['view', name, 'versions', 'dist-tags', '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const data = JSON.parse(out);
    const versions = Array.isArray(data.versions) ? data.versions : [data.versions].filter(Boolean);
    return { published: true, versions, latest: data['dist-tags']?.latest ?? null };
  } catch (err) {
    const stderr = String(err.stderr ?? '');
    if (/E404|404 Not Found/.test(stderr)) return { published: false, versions: [], latest: null };
    throw new Error(`npm view ${name} failed (registry unreachable or unauthorized):\n${stderr.trim() || err.message}`);
  }
}

// --- plan -------------------------------------------------------------------

export function buildPlan(packages, readPkg, lookup) {
  const plan = [];
  const errors = [];
  const willPublish = new Map(); // name -> version

  for (const { dir, dependsOn } of packages) {
    const pkg = readPkg(dir);
    const { name, version } = pkg;

    if (!parseVersion(version)) {
      errors.push(`${name}: "${version}" is not a valid semver version`);
      continue;
    }

    const info = lookup(name);
    const alreadyPublished = info.versions.includes(version);
    const action = alreadyPublished ? 'skip' : 'publish';

    // Guard 2: never move `latest` backwards.
    if (action === 'publish' && info.latest && compareVersions(version, info.latest) < 0) {
      errors.push(
        `${name}: refusing to publish ${version} — it is LOWER than the current latest (${info.latest}), `
        + `and npm would move the "latest" tag backwards, silently downgrading consumers. `
        + `Bump past ${info.latest}, or publish with an explicit --tag.`
      );
    }

    // Guard 3: the range prepack will pin must resolve to a real version.
    if (dependsOn) {
      const depVersion = willPublish.get(dependsOn) ?? null;
      const depInfo = lookup(dependsOn);
      const depWillExist = depVersion !== null || depInfo.versions.length > 0;
      const depPinned = plan.find(p => p.name === dependsOn)?.version;
      if (action === 'publish') {
        if (!depWillExist) {
          errors.push(`${name}: pins ^${depPinned} of ${dependsOn}, which is not published and not part of this run`);
        } else if (depPinned && !depInfo.versions.includes(depPinned) && !willPublish.has(dependsOn)) {
          errors.push(
            `${name}: prepack will pin ^${depPinned} of ${dependsOn}, but that version is neither on the `
            + `registry nor being published in this run — the tarball would reference a nonexistent version`
          );
        }
      }
    }

    if (action === 'publish') willPublish.set(name, version);
    plan.push({
      name, dir, version, action,
      registryLatest: info.latest,
      dependsOn,
      pinnedRange: dependsOn ? `^${plan.find(p => p.name === dependsOn)?.version ?? '?'}` : null,
    });
  }

  // Guard 1: a release that publishes nothing is a mistake, not a no-op.
  if (errors.length === 0 && plan.every(p => p.action === 'skip')) {
    errors.push(
      'nothing to publish: every version already exists on the registry. '
      + 'Bump the version(s) you mean to release (npm version patch) and re-run.'
    );
  }

  return { plan, errors };
}

// --- main -------------------------------------------------------------------

function readPkg(dir) {
  return JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
}

const cache = new Map();
function lookup(name) {
  if (!cache.has(name)) cache.set(name, registryInfo(name));
  return cache.get(name);
}

// Importable for tests without running the registry queries.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let result;
  try {
    result = buildPlan(PACKAGES, readPkg, lookup);
  } catch (err) {
    console.error(`release-preflight: ${err.message}`);
    process.exit(1);
  }

  const { plan, errors } = result;

  if (asJson) {
    console.log(JSON.stringify({ plan, errors, ok: errors.length === 0 }, null, 2));
  } else {
    console.log('\nRelease plan\n');
    for (const p of plan) {
      const verb = p.action === 'publish' ? 'PUBLISH' : 'skip   ';
      const tail = p.action === 'skip'
        ? '(already on the registry)'
        : p.registryLatest ? `(registry latest: ${p.registryLatest})` : '(new package)';
      const pin = p.pinnedRange ? `  pins ${p.dependsOn}@${p.pinnedRange}` : '';
      console.log(`  ${verb}  ${p.name.padEnd(16)} ${p.version.padEnd(10)} ${tail}${pin}`);
    }
    console.log('');
    if (errors.length) {
      console.error('BLOCKED:\n');
      for (const e of errors) console.error(`  ✗ ${e}\n`);
    } else {
      const n = plan.filter(p => p.action === 'publish').length;
      console.log(`OK — ${n} package(s) will publish, in the order shown.\n`);
    }
  }

  process.exit(errors.length ? 1 : 0);
}
