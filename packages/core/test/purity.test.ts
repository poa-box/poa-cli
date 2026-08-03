/**
 * Browser-purity gate.
 *
 * @poa/core's whole reason to exist is that frontends and integrators can
 * depend on it without Node. This test fails the build if any module under
 * src/ (except the scripts/ dir, which runs at build time) references a Node
 * built-in, a terminal library, or process.env.
 *
 * Static, not runtime: a static scan catches imports that only execute on
 * rare paths, which a smoke-import would miss.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** import/require of Node built-ins or terminal-only packages. */
const FORBIDDEN_MODULES = /(?:from\s+|require\()\s*['"](?:node:)?(fs|path|os|child_process|worker_threads|cluster|net|tls|http|https|readline|tty|v8|vm|dgram|dns|zlib|stream|crypto|chalk|ora|cli-table3|dotenv|graphql-request|graphql)['"]/;

/** Direct process usage (env, exit, stdio). `process` in comments is fine. */
const FORBIDDEN_PROCESS = /(?<!\.)\bprocess\s*\.\s*(env|exit|stdout|stderr|argv|cwd)\b/;

describe('browser purity', () => {
  const files = walk(SRC);

  it('scans a sane number of modules', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    it(`src/${rel} is browser-pure`, () => {
      const src = readFileSync(file, 'utf-8');
      const noComments = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

      const badImport = noComments.match(FORBIDDEN_MODULES);
      expect(badImport, badImport ? `forbidden module '${badImport[1]}' in src/${rel}` : undefined).toBeNull();

      const badProcess = noComments.match(FORBIDDEN_PROCESS);
      expect(badProcess, badProcess ? `direct process.${badProcess[1]} in src/${rel} — inject via EnvSource/options` : undefined).toBeNull();
    });
  }
});
