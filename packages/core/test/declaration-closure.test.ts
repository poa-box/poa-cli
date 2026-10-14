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
import ts from 'typescript';

const DIST = resolve(__dirname, '..', 'dist');

/** Transitive closure of relative imports/re-exports in built declarations. */
function declarationClosure(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    if (!existsSync(file)) throw new Error(`Missing public declaration: ${file}`);
    const src = readFileSync(file, 'utf-8');
    seen.set(file, src);
    for (const specifier of moduleSpecifiers(src)) {
      if (!specifier.startsWith('.')) continue;
      let p = join(dirname(file), specifier);
      if (!p.endsWith('.d.ts')) {
        p = existsSync(p + '.d.ts') ? p + '.d.ts' : join(p, 'index.d.ts');
      }
      queue.push(p);
    }
  }
  return seen;
}

/** Includes import types and import-equals, which a `from` regex misses. */
function moduleSpecifiers(src: string): string[] {
  const out: string[] = [];
  const file = ts.createSourceFile('fixture.d.ts', src, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) out.push(node.argument.literal.text);
    if (ts.isExternalModuleReference(node) && node.expression && ts.isStringLiteral(node.expression)) out.push(node.expression.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return out;
}

function externalOffenders(closure: Map<string, string>, forbidden: RegExp): string[] {
  const offenders: string[] = [];
  for (const [file, src] of closure) {
    if (moduleSpecifiers(src).some(spec => forbidden.test(spec))) offenders.push(file.slice(DIST.length + 1));
  }
  return offenders;
}

const VIEM_RE = /^(?:viem|permissionless)(?:\/|$)/;

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
    expect(moduleSpecifiers(sponsored).some(spec => VIEM_RE.test(spec))).toBe(true);
  });

  it('detects optional imports in nested import types and import-equals', () => {
    const specifiers = moduleSpecifiers(`export type Client = import('viem').Client;
      import accounts = require('permissionless/accounts');
      export type Local = import('./local').Local;
      // import('viem/comment') is not a declaration dependency`);
    expect(specifiers.filter(spec => VIEM_RE.test(spec))).toEqual(['viem', 'permissionless/accounts']);
    expect(specifiers).toContain('./local');
  });
});
