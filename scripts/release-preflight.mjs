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
/** Dist-tag the release will publish under (`--tag next` for prereleases). */
const distTag = (() => {
  const i = process.argv.indexOf('--tag');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'latest';
})();
/** Treat "no version changed" as a clean no-op (automatic runs on every merge). */
const allowEmpty = process.argv.includes('--allow-empty');

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

/**
 * Parse `1.2.3` / `1.2.3-rc.1`. Returns null when not valid semver.
 * Leading zeros are rejected (npm normalizes `01.2.3`, so the version that
 * reaches the registry would differ from the one reviewed) and build metadata
 * is rejected outright (npm ignores it for equality, so `1.2.3+a` and
 * `1.2.3+b` collide and the second publish fails mid-chain).
 */
export function parseVersion(v) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v ?? ''));
  if (!m) return null;
  const prerelease = m[4] ?? null;
  // Prerelease identifiers: dot-separated, non-empty, numeric ones unpadded.
  if (prerelease !== null) {
    const ids = prerelease.split('.');
    if (ids.some(id => id === '' || /^0\d+$/.test(id))) return null;
  }
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease };
}

/**
 * Compare prerelease identifier lists per semver §11.4: numeric identifiers
 * compare NUMERICALLY (so rc.2 < rc.10 — a plain string compare gets this
 * backwards), numeric always sorts below alphanumeric, and when one list is a
 * prefix of the other the longer list wins.
 */
function comparePrereleaseIds(a, b) {
  const ia = a.split('.'), ib = b.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    if (ia[i] === undefined) return -1;
    if (ib[i] === undefined) return 1;
    const na = /^\d+$/.test(ia[i]), nb = /^\d+$/.test(ib[i]);
    if (na && nb) {
      if (+ia[i] !== +ib[i]) return +ia[i] < +ib[i] ? -1 : 1;
    } else if (na !== nb) {
      return na ? -1 : 1;              // numeric < alphanumeric
    } else if (ia[i] !== ib[i]) {
      return ia[i] < ib[i] ? -1 : 1;   // ASCII order
    }
  }
  return 0;
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
  return comparePrereleaseIds(pa.prerelease, pb.prerelease);
}

// --- registry ---------------------------------------------------------------

/**
 * Registry facts for a package, or `{ published: false }` ONLY when the name is
 * confirmed absent.
 *
 * Two ways this has failed open, both of which tried to republish an existing
 * version (npm rejects that, so the release died mid-chain):
 *
 *  1. npm 12 changed `npm view --json` to wrap a single result in an ARRAY —
 *     `[{versions,dist-tags}]` instead of `{versions,dist-tags}` — so reading
 *     `.versions` off the parsed value yielded undefined and every package
 *     looked brand new. Both shapes are handled now.
 *  2. For a SCOPED package the registry answers 404 to an unauthorized read,
 *     so a credential problem is indistinguishable from "never published".
 *
 * Therefore an empty or 404 read is never trusted on its own: it is confirmed
 * with an anonymous registry GET, and a contradiction aborts the release.
 */
async function fetchRegistryInfo(name) {
  let raw;
  try {
    raw = execFileSync('npm', ['view', name, 'versions', 'dist-tags', '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = String(err.stderr ?? '');
    if (/E404|404 Not Found/.test(stderr)) {
      await assertGenuinelyAbsent(name, 'npm view reported 404');
      return { published: false, versions: [], latest: null };
    }
    throw new Error(`npm view ${name} failed (registry unreachable or unauthorized):\n${stderr.trim() || err.message}`);
  }

  const parsed = raw.trim() ? JSON.parse(raw) : null;
  // npm >= 12 wraps single-spec results in an array; npm <= 11 does not.
  const data = (Array.isArray(parsed) ? parsed[0] : parsed) ?? {};
  const versions = Array.isArray(data.versions)
    ? data.versions
    : data.versions ? [data.versions] : [];

  if (!versions.length) {
    await assertGenuinelyAbsent(name, 'npm view returned no versions');
    return { published: false, versions: [], latest: null };
  }
  return { published: true, versions, latest: data['dist-tags']?.latest ?? null };
}

/**
 * Confirm — anonymously, without the npm CLI — that a package really has no
 * published versions. Throws if the registry disagrees, because concluding
 * "new package" about an existing one makes the release attempt an
 * impossible republish.
 */
async function assertGenuinelyAbsent(name, why) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new Error(`${name}: ${why}, and the registry could not be reached to confirm (${err.message}). Refusing to guess.`);
  }
  if (res.status === 404) return;   // genuinely new
  throw new Error(
    `${name}: ${why}, but the registry answers HTTP ${res.status} for it — the package EXISTS. `
    + `Refusing to treat it as new (this is an npm CLI output-shape or credential problem, `
    + `not a new package). npm --version: ${safeNpmVersion()}`
  );
}

function safeNpmVersion() {
  try {
    return execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
}

// --- plan -------------------------------------------------------------------

export function buildPlan(packages, readPkg, lookup, options = {}) {
  const distTag = options.distTag ?? 'latest';
  const plan = [];
  const errors = [];
  const willPublish = new Map(); // name -> version (only packages clear to publish)
  const blocked = new Set();     // names whose own publish is refused

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
    const parsed = parseVersion(version);
    const errorsBefore = errors.length;

    // Guard 2: never move `latest` backwards.
    // `info.latest` can be absent while versions exist (a package whose
    // dist-tags were manipulated), so fall back to the highest known version
    // rather than skipping the guard entirely.
    const effectiveLatest = info.latest
      ?? (info.versions.length ? [...info.versions].sort(compareVersions).pop() : null);
    if (action === 'publish' && effectiveLatest && compareVersions(version, effectiveLatest) < 0) {
      errors.push(
        `${name}: refusing to publish ${version} — it is LOWER than the current latest (${effectiveLatest}), `
        + `and npm would move the "latest" tag backwards, silently downgrading consumers. `
        + `Bump past ${effectiveLatest}, or release it under a different dist-tag.`
      );
    }

    // Guard 2b: a prerelease must never land on `latest`. npm points `latest`
    // at whatever was published most recently, so an rc published without an
    // explicit tag becomes the default install for every consumer.
    if (action === 'publish' && parsed.prerelease !== null && distTag === 'latest') {
      errors.push(
        `${name}: ${version} is a PRERELEASE and would be published to the "latest" dist-tag, `
        + `making it the default install for every consumer. Re-run with a dist tag such as "next".`
      );
    }

    // Guard 3: the range this package will publish for its sibling must
    // resolve to a version that exists after this run. `dependsOn` is pinned
    // as ^<sibling's local version> (scripts/lib/link-swap.mjs), so the check
    // is: will that exact version be on the registry when this publishes?
    if (dependsOn && action === 'publish') {
      const depEntry = plan.find(p => p.name === dependsOn);
      const depVersion = depEntry?.version;
      const depInfo = lookup(dependsOn);
      if (!depVersion) {
        errors.push(`${name}: depends on ${dependsOn}, which is not part of the release plan — cannot derive a range`);
      } else {
        const depPublishedAlready = depInfo.versions.includes(depVersion);
        // willPublish only contains dependencies that are actually CLEAR to
        // publish — a sibling whose own publish was refused does not count,
        // or a blocked core would silently "satisfy" the CLI's pin.
        const depPublishingNow = willPublish.get(dependsOn) === depVersion;
        if (!depPublishedAlready && !depPublishingNow) {
          const why = blocked.has(dependsOn)
            ? `${dependsOn}@${depVersion} is itself blocked above`
            : `that version is neither on the registry nor being published in this run (${dependsOn} is ${depEntry.action})`;
          errors.push(
            `${name}: would publish a dependency on ${dependsOn}@^${depVersion}, but ${why} — `
            + `consumers could not install ${name}@${version}`
          );
        }
      }
    }

    const cleanToPublish = errors.length === errorsBefore;
    if (!cleanToPublish) blocked.add(name);
    if (action === 'publish' && cleanToPublish) willPublish.set(name, version);
    plan.push({
      name, dir, version, action,
      registryLatest: info.latest,
      dependsOn,
      distTag,
      pinnedRange: dependsOn ? `^${plan.find(p => p.name === dependsOn)?.version ?? '?'}` : null,
    });
  }

  // Guard 1: for a release someone ASKED for, publishing nothing is a mistake
  // (a forgotten version bump) and must fail loudly. For an automatic run on
  // every merge, it is the normal case — most merges change no version — so
  // `allowEmpty` turns it into a clean no-op instead.
  const nothingToPublish = plan.length > 0 && plan.every(p => p.action === 'skip');
  if (errors.length === 0 && nothingToPublish && !options.allowEmpty) {
    errors.push(
      'nothing to publish: every version already exists on the registry. '
      + 'Bump the version(s) you mean to release (npm version patch) and re-run.'
    );
  }

  return { plan, errors, nothingToPublish };
}

// --- main -------------------------------------------------------------------

function readPkg(dir) {
  return JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
}

const cache = new Map();
function lookup(name) {
  const hit = cache.get(name);
  if (!hit) throw new Error(`registry info for ${name} was not prefetched`);
  return hit;
}

/** Read every package's registry state up front (async: see fetchRegistryInfo). */
async function prefetchRegistry(packages) {
  for (const { dir } of packages) {
    const { name } = readPkg(dir);
    if (!cache.has(name)) cache.set(name, await fetchRegistryInfo(name));
  }
}

// Importable for tests without running the registry queries.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let result;
  try {
    await prefetchRegistry(PACKAGES);
    result = buildPlan(PACKAGES, readPkg, lookup, { distTag, allowEmpty });
  } catch (err) {
    console.error(`release-preflight: ${err.message}`);
    process.exit(1);
  }

  const { plan, errors } = result;

  if (asJson) {
    console.log(JSON.stringify({
      plan, errors, ok: errors.length === 0,
      hasWork: !result.nothingToPublish && errors.length === 0,
    }, null, 2));
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
    } else if (result.nothingToPublish) {
      console.log('Nothing to publish — every version is already on the registry.\n');
    } else {
      const n = plan.filter(p => p.action === 'publish').length;
      console.log(`OK — ${n} package(s) will publish, in the order shown.\n`);
    }
  }

  process.exit(errors.length ? 1 : 0);
}
