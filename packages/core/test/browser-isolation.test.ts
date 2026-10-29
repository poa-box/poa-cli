import { expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import * as kernel from '../src';
import * as browser from '../src/browser';
import * as workflows from '../src/workflows';

const sourceRoot = resolve(__dirname, '../src');
function modules(file: string): string[] {
  const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) found.push(node.argument.literal.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(tree); return found;
}
function localModule(file: string, specifier: string): string {
  const target = resolve(dirname(file), specifier);
  const found = [target + '.ts', join(target, 'index.ts'), target].find(existsSync);
  if (!found) throw new Error(`UNRESOLVED_LOCAL_MODULE: ${relative(sourceRoot, file)} -> ${specifier}`);
  return found;
}
function closure(entry: string): Set<string> {
  const pending = [entry], seen = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!; if (seen.has(file)) continue; seen.add(file);
    for (const specifier of modules(file)) if (specifier.startsWith('.')) pending.push(localModule(file, specifier));
  }
  return seen;
}
const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory()
  ? walk(join(directory, item.name)) : [join(directory, item.name)]);

it('keeps browser and workflow runtime AND type imports outside the plain kernel dependency graph', () => {
  const dependencies = [...closure(join(sourceRoot, 'index.ts'))].map(file => relative(sourceRoot, file));
  expect(dependencies.length).toBeGreaterThan(40);
  expect(dependencies.filter(file => /^(?:browser|workflows)[/\\]/.test(file))).toEqual([]);
  expect(kernel).not.toHaveProperty('browser'); expect(kernel).not.toHaveProperty('workflows');
  expect(kernel).not.toHaveProperty('createRoleWorkflow'); expect(kernel).not.toHaveProperty('createPasskeyClient');
});

it('shares optional workflow implementations without a second core package or self-reference', () => {
  expect(browser.workflows.createRoleWorkflow).toBe(workflows.createRoleWorkflow);
  expect(browser.workflows.createTaskWorkflow).toBe(workflows.createTaskWorkflow);
  const imports = [...walk(join(sourceRoot, 'browser')), ...walk(join(sourceRoot, 'workflows'))]
    .flatMap(file => modules(file).map(specifier => ({ file, specifier })));
  expect(imports.filter(({ specifier }) => /^@poa-box\/(?:core|browser)(?:\/|$)/.test(specifier))).toEqual([]);
  for (const { file, specifier } of imports) if (specifier.startsWith('.'))
    expect(localModule(file, specifier).startsWith(sourceRoot + sep)).toBe(true);
});
