/**
 * Browser-purity gate.
 *
 * @poa-box/core's whole reason to exist is that frontends and integrators can
 * depend on it without Node. This test fails the build if any module under
 * src/ (except the scripts/ dir, which runs at build time) references a Node
 * built-in, a terminal library, or process.env.
 *
 * Static, not runtime: a static scan catches imports that only execute on
 * rare paths, which a smoke-import would miss.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { builtinModules } from 'module';
import ts from 'typescript';

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

const nodeModules = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
function importedModules(src: string): string[] {
  const out: string[] = [];
  const file = ts.createSourceFile('fixture.ts', src, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) out.push(node.argument.literal.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) out.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return out;
}

describe('browser purity', () => {
  const files = walk(SRC);

  it('scans a sane number of modules', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('recognizes dynamic, reexported and subpath Node dependencies', () => {
    const modules = importedModules(`const a = import('node:fs/promises');
      export { createServer } from 'http';
      const b = require('timers/promises');
      // import('node:crypto') is only a comment
      const c = "require('node:path')";`);
    expect(modules).toEqual(['node:fs/promises', 'http', 'timers/promises']);
    expect(modules.every(name => nodeModules.has(name.replace(/^node:/, '')))).toBe(true);
  });

  it('role operations have no implicit browser/network/clock/signing capability or optional executor import', () => {
    const pending = [join(SRC, 'governance/role-operations.ts')], seen = new Set<string>(), external = new Set<string>();
    while (pending.length) {
      const file = pending.pop()!; if (seen.has(file)) continue; seen.add(file);
      expect(file).not.toMatch(/\/execute\/(?:sponsored|ethers)\.ts$/);
      const src = readFileSync(file, 'utf8');
      for (const module of importedModules(src)) {
        if (!module.startsWith('.')) { external.add(module); continue; }
        const target = resolve(dirname(file), module);
        pending.push(existsSync(target + '.ts') ? target + '.ts' : join(target, 'index.ts'));
      }
    }
    expect([...external].filter(name => /^(?:react|wagmi|@apollo|viem|permissionless)(?:\/|$)/.test(name))).toEqual([]);
    for (const name of ['role-operations.ts', 'role-operation-observer.ts', 'role-operation-types.ts']) {
      const source = readFileSync(join(SRC, 'governance', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(source).not.toMatch(/\b(?:window|localStorage|sessionStorage|fetch|Date)\s*(?:\.|\()/);
      expect(source).not.toMatch(/new\s+(?:ethers\.)?(?:Contract|JsonRpcProvider|Wallet)\b|\.(?:sendTransaction|signTransaction|signMessage|getLogs)\s*\(/);
    }
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
      expect(importedModules(src).filter(name => name.startsWith('node:') || nodeModules.has(name)), `Node import in src/${rel}`).toEqual([]);

      const badProcess = noComments.match(FORBIDDEN_PROCESS);
      expect(badProcess, badProcess ? `direct process.${badProcess[1]} in src/${rel} — inject via EnvSource/options` : undefined).toBeNull();
    });
  }
});
