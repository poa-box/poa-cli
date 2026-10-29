import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import * as browser from '../../src/browser';

const root = path.resolve(__dirname, '../..');
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');
const pkg = JSON.parse(read('package.json'));
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)]);

describe('single-package integration contract', () => {
  it('has no second protocol package and exposes only supported integration entry points', () => {
    expect(pkg.name).toBe('@poa-box/core');
    expect(Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).filter(name => name === '@poa-box/core' || name === '@poa-box/browser')).toEqual([]);
    expect(pkg.exports['./browser/*']).toBeNull(); expect(pkg.exports['./workflows/*']).toBeNull();
    for (const key of ['browser', ...Object.keys(browser).map(key => key === 'workflows' ? key : 'browser/' + key)]) {
      expect(pkg.exports['./' + key]).toEqual({ types: './dist/' + key + '/index.d.ts', default: './dist/' + key + '/index.js' });
      expect(pkg.typesVersions['*'][key]).toEqual(['dist/' + key + '/index.d.ts']);
    }
    // New private boundaries do not remove any previously published wildcard.
    expect(pkg.exports['./*']).toEqual({ types: './dist/*.d.ts', default: './dist/*.js' });
  });
  it('keeps structured recipes on the one package version and real public exports', () => {
    const catalog = JSON.parse(read('docs/browser-features.v1.json'));
    expect(catalog.package).toBe(pkg.name); expect(catalog.packageVersion).toBe(pkg.version);
    expect(catalog.coreVersion).toBeUndefined(); expect(catalog.authorization).toBe(false);
    expect(new Set(catalog.features.map((item: { id: string }) => item.id)).size).toBe(catalog.features.length);
    const schema = JSON.parse(read('docs/browser-features.schema.json'));
    expect(schema.properties.authorization.const).toBe(false); expect(catalog.$schema).toBe('./browser-features.schema.json');
    for (const item of catalog.features) {
      expect(schema.properties.features.items.properties.support.enum).toContain(item.support);
      if (['external-service', 'unsupported'].includes(item.support)) { expect(item.importPath).toBeNull(); expect(item.export).toBeNull(); }
      else {
        const leaf = item.importPath.replace('@poa-box/core/', '');
        const namespace = leaf === 'workflows' ? leaf : leaf.replace('browser/', '') as keyof typeof browser;
        expect(pkg.exports['./' + leaf]).toBeDefined();
        expect(typeof (browser[namespace as keyof typeof browser] as Record<string, unknown>)[item.export]).toBe('function');
      }
    }
  });
  it('integration modules use relative core imports with no implicit server/framework dependencies', () => {
    const failures: string[] = [];
    for (const file of ['browser', 'workflows'].flatMap(dir => walk(path.join(root, 'src', dir))).filter(file => file.endsWith('.ts'))) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          const target = node.moduleSpecifier;
          if (target && ts.isStringLiteral(target)) {
            const value = target.text;
            if (!value.startsWith('.') && value !== 'ethers') failures.push(value);
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
