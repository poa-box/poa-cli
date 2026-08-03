/**
 * Swapping local `link:` dependencies for real semver ranges at publish time.
 *
 * ## Why this exists OUTSIDE npm's lifecycle hooks
 *
 * `npm publish` reads the manifest it uploads to the registry BEFORE it runs
 * `prepack`. Proven empirically against a capture-only local registry: with a
 * prepack that rewrites `link:../..` → `^0.1.1`, the packed TARBALL contained
 * `^0.1.1` while the registry PUT body still contained `link:../..`. That is
 * exactly how `@poa-box/agent@0.1.0` shipped uninstallable — and why
 * inspecting the tarball (which was always correct) never caught it.
 *
 * So the swap has to happen on disk BEFORE `npm publish` is invoked. The
 * prepack/postpack hooks stay as a second line of defence for direct
 * `npm pack` paths; this module is what makes the REGISTRY metadata right.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Packages whose published manifest must not contain a `link:` dependency.
 * `dir` is relative to the repo root; `dep` is the dependency to rewrite;
 * `versionFrom` is the package.json whose version supplies the caret range.
 */
export const LINKED_PACKAGES = [
  { dir: '.', dep: '@poa-box/core', versionFrom: 'packages/core', local: 'link:./packages/core' },
  { dir: 'packages/agent', dep: '@poa-box/cli', versionFrom: '.', local: 'link:../..' },
];

const pkgPath = (dir) => join(ROOT, dir, 'package.json');
const readPkg = (dir) => JSON.parse(readFileSync(pkgPath(dir), 'utf8'));

function writePkg(dir, pkg) {
  writeFileSync(pkgPath(dir), JSON.stringify(pkg, null, 2) + '\n');
}

/** The caret range a package should publish for its linked dependency. */
export function rangeFor(entry) {
  const version = readPkg(entry.versionFrom).version;
  if (!/^\d+\.\d+\.\d+/.test(String(version))) {
    throw new Error(`cannot derive a range for ${entry.dep}: ${entry.versionFrom} has version ${JSON.stringify(version)}`);
  }
  return `^${version}`;
}

/** Rewrite the linked dependency to its published range. Returns the range. */
export function applyRange(entry) {
  const range = rangeFor(entry);
  const pkg = readPkg(entry.dir);
  if (!pkg.dependencies?.[entry.dep]) {
    throw new Error(`${entry.dir}/package.json has no dependency ${entry.dep}`);
  }
  pkg.dependencies[entry.dep] = range;
  writePkg(entry.dir, pkg);
  return range;
}

/** Restore the local link: form, so the working tree keeps building locally. */
export function restoreLink(entry) {
  const pkg = readPkg(entry.dir);
  pkg.dependencies[entry.dep] = entry.local;
  writePkg(entry.dir, pkg);
  return entry.local;
}

/** Current on-disk value (for assertions and reporting). */
export function currentRange(entry) {
  return readPkg(entry.dir).dependencies?.[entry.dep] ?? '<absent>';
}

export function entryForDir(dir) {
  return LINKED_PACKAGES.find(e => e.dir === dir) ?? null;
}

/**
 * Run `fn` with the linked dependency swapped to its published range,
 * restoring the link: form afterwards WHETHER OR NOT `fn` throws. A failed
 * publish must never leave the working tree pinned to an unpublished range.
 */
export async function withPublishRanges(dir, fn) {
  const entry = entryForDir(dir);
  if (!entry) return fn(null);
  const range = applyRange(entry);
  // A `finally` does not run when the process is killed (CI timeout, Ctrl-C),
  // which would leave the working tree pinned to a range that may not exist.
  // Restore on the fatal signals too, then re-raise with the default handler.
  const onSignal = (sig) => {
    try { restoreLink(entry); } catch { /* best effort */ }
    process.off(sig, onSignal);
    process.kill(process.pid, sig);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, onSignal);
  try {
    return await fn(range);
  } finally {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(sig, onSignal);
    restoreLink(entry);
  }
}
