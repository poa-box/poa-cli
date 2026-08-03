#!/usr/bin/env node
/** postpack: restore the local link: for @poa-box/cli after packing. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgPath = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.dependencies['@poa-box/cli'] = 'link:../..';
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('postpack-cli-link: @poa-box/cli → link:../..');
