#!/usr/bin/env node
/**
 * prepack: pin dependencies["@poa-box/core"] to a caret range derived from
 * packages/core's ACTUAL version, so the published CLI tarball references the
 * registry package while the repo keeps the local link:.
 *
 * A script file, not an inline npm-script one-liner: the $(node -p "...")
 * form silently degraded to "^" under npm's sh quoting (caught by tarball
 * inspection before it shipped — the agent's 0.1.0 shipped a raw link: dep
 * the same way). postpack restores the link via postpack-core-link.mjs.
 * Fails LOUDLY if the version cannot be read — a broken range must never
 * reach a tarball again.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreVersion = JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+/.test(coreVersion)) {
  console.error(`prepack-core-range: bad @poa-box/core version ${JSON.stringify(coreVersion)}`);
  process.exit(1);
}

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.dependencies['@poa-box/core'] = `^${coreVersion}`;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`prepack-core-range: @poa-box/core → ^${coreVersion}`);
