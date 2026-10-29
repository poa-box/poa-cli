import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import * as browser from '../src';

const root = path.resolve(__dirname, '..');
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');
const pkg = JSON.parse(read('package.json'));
const catalog = JSON.parse(read('docs/features.v1.json'));
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)]);

describe('distributed integration contract', () => {
  it('pins the published protocol and exposes only supported entry points', () => {
    expect(pkg.dependencies).toEqual({ '@poa-box/core': '2.1.0' });
    expect(pkg.exports['./*']).toBeUndefined();
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './package.json', ...Object.keys(browser).map(key => './' + key)].sort());
    for (const key of Object.keys(browser)) {
      expect(pkg.exports['./' + key]).toEqual({ types: './dist/' + key + '/index.d.ts', default: './dist/' + key + '/index.js' });
      expect(pkg.typesVersions['*'][key]).toEqual(['dist/' + key + '/index.d.ts']);
    }
  });
  it('keeps structured agent recipes bound to real exported functionality', () => {
    expect(catalog.package).toBe(pkg.name);
    expect(catalog.packageVersion).toBe(pkg.version);
    expect(catalog.coreVersion).toBe(pkg.dependencies['@poa-box/core']);
    expect(catalog.authorization).toBe(false);
    expect(new Set(catalog.features.map((item: { id: string }) => item.id)).size).toBe(catalog.features.length);
    const schema = JSON.parse(read('docs/features.schema.json'));
    expect(schema.properties.authorization.const).toBe(false);
    expect(catalog.$schema).toBe('./features.schema.json');
    for (const item of catalog.features) {
      expect(schema.properties.features.items.properties.support.enum).toContain(item.support);
      if (['external-service', 'unsupported'].includes(item.support)) {
        expect(item.importPath).toBeNull(); expect(item.export).toBeNull();
      } else {
        const namespace = item.importPath.replace('@poa-box/browser/', '') as keyof typeof browser;
        expect(pkg.exports['./' + namespace]).toBeDefined();
        expect(typeof (browser[namespace] as Record<string, unknown>)[item.export]).toBe('function');
      }
    }
  });
  it('has no server, framework, frontend-source or implicit environment dependency', () => {
    const failures: string[] = [];
    for (const file of walk(path.join(root, 'src')).filter(file => file.endsWith('.ts'))) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          const target = node.moduleSpecifier;
          if (target && ts.isStringLiteral(target)) {
            const value = target.text;
            if (!value.startsWith('.') && value !== 'ethers' && !value.startsWith('@poa-box/core')) failures.push(value);
            if (value.startsWith('.') && !path.resolve(path.dirname(file), value).startsWith(path.join(root, 'src') + path.sep)) failures.push(value);
          }
        }
        if (ts.isIdentifier(node) && ['process', 'Buffer', 'require', '__dirname', '__filename'].includes(node.text)) failures.push(node.text + ':' + path.basename(file));
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(failures).toEqual([]);
  });
});
