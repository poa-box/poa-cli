/**
 * Optional-peer isolation at the TYPE level.
 *
 * viem and permissionless are optional peers: a consumer that only reads (or
 * only uses the plain-EOA executor) may not have them installed. With
 * skipLibCheck:false, ANY `from 'viem'` in the .d.ts closure of an entry
 * point is a TS2307 for that consumer — so the closures of the root barrel
 * and of execute/ethers must never reference them. Only execute/sponsored
 * (and the execute barrel that includes it) may.
 *
 * Runs against dist/, so `yarn build` must precede `yarn test` when
 * declarations changed (build regenerates them; CI runs build first).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

const DIST = resolve(__dirname, '..', 'dist');

/** Transitive closure of relative imports/re-exports in built declarations. */
function declarationClosure(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    const src = readFileSync(file, 'utf-8');
    seen.set(file, src);
    for (const m of src.matchAll(/from ['"](\.[^'"]+)['"]/g)) {
      let p = join(dirname(file), m[1]);
      if (!p.endsWith('.d.ts')) {
        p = existsSync(p + '.d.ts') ? p + '.d.ts' : join(p, 'index.d.ts');
      }
      queue.push(p);
    }
  }
  return seen;
}

function externalOffenders(closure: Map<string, string>, forbidden: RegExp): string[] {
  const offenders: string[] = [];
  for (const [file, src] of closure) {
    if (forbidden.test(src)) offenders.push(file.slice(DIST.length + 1));
  }
  return offenders;
}

const VIEM_RE = /from ['"](?:viem|permissionless)(?:\/[^'"]*)?['"]/;

describe('viem/permissionless never enter dependency-free declaration closures', () => {
  it('root barrel (index.d.ts)', () => {
    const offenders = externalOffenders(declarationClosure(join(DIST, 'index.d.ts')), VIEM_RE);
    expect(offenders, `viem-typed declarations reachable from the root barrel: ${offenders.join(', ')}`).toEqual([]);
  });

  it('plain-EOA executor (execute/ethers.d.ts)', () => {
    const offenders = externalOffenders(declarationClosure(join(DIST, 'execute', 'ethers.d.ts')), VIEM_RE);
    expect(offenders, `viem-typed declarations reachable from execute/ethers: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the sponsored path itself still uses real viem types (sanity: the regex works)', () => {
    const sponsored = readFileSync(join(DIST, 'execute', 'sponsored.d.ts'), 'utf-8');
    expect(VIEM_RE.test(sponsored)).toBe(true);
  });
});
