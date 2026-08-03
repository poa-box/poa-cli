#!/usr/bin/env node
/**
 * prepack: pin dependencies["@poa-box/cli"] to a caret range derived from the
 * ROOT package's actual version, so the published agent tarball references the
 * registry package while the repo keeps the local link:.
 *
 * Derived, not hardcoded: the shipped @poa-box/agent@0.1.0 carried a raw
 * `link:../..` because its prepack `npm pkg set` targeted a stale key name and
 * silently no-opped, and the replacement hardcoded `^0.1.0` would have gone
 * stale the moment the CLI reached 0.2.0. Fails LOUDLY rather than writing a
 * range it cannot derive.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliVersion = JSON.parse(readFileSync(join(pkgRoot, '..', '..', 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+/.test(cliVersion)) {
  console.error(`prepack-cli-range: bad @poa-box/cli version ${JSON.stringify(cliVersion)}`);
  process.exit(1);
}

const pkgPath = join(pkgRoot, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.dependencies['@poa-box/cli'] = `^${cliVersion}`;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`prepack-cli-range: @poa-box/cli → ^${cliVersion}`);
