#!/usr/bin/env node
/** postpack: restore the local link: for @poa-box/core after packing. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.dependencies['@poa-box/core'] = 'link:./packages/core';
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('postpack-core-link: @poa-box/core → link:./packages/core');
