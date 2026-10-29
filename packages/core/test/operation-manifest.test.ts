import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
const root = resolve(__dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'docs/operation-manifest.v1.json'), 'utf8'));
const schema = JSON.parse(readFileSync(resolve(root, 'docs/operation-manifest.schema.json'), 'utf8'));
// Test-only evaluator for the complete vocabulary used by this deliberately small
// schema. Reject unsupported schema keywords so additions cannot silently pass.
function validate(value: any, rule: any, path = '$'): void {
  for (const key of Object.keys(rule)) if (!['$schema', '$id', 'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'const', 'enum'].includes(key)) throw new Error('UNSUPPORTED_SCHEMA_KEY:' + key);
  if ('const' in rule && JSON.stringify(value) !== JSON.stringify(rule.const)) throw new Error(path + ':const');
  if (rule.enum && !rule.enum.some((v: any) => JSON.stringify(v) === JSON.stringify(value))) throw new Error(path + ':enum');
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(path + ':object');
    for (const key of rule.required ?? []) if (!(key in value)) throw new Error(path + ':required:' + key);
    for (const key of Object.keys(value)) {
      if (!(key in rule.properties) && rule.additionalProperties === false) throw new Error(path + ':unexpected:' + key);
      if (key in rule.properties) validate(value[key], rule.properties[key], path + '.' + key);
    }
  } else if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < (rule.minItems ?? 0) || value.length > (rule.maxItems ?? Infinity)) throw new Error(path + ':array');
    value.forEach((v, i) => validate(v, rule.items, path + '[' + i + ']'));
  } else if (rule.type && typeof value !== rule.type) throw new Error(path + ':type');
  if (rule.minLength && value.length < rule.minLength) throw new Error(path + ':minLength');
}
function exportsOf(file: string) {
  const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, skipLibCheck: true });
  const checker = program.getTypeChecker(), source = program.getSourceFile(file)!;
  return checker.getExportsOfModule(checker.getSymbolAtLocation(source)!).map(s => s.name);
}
describe('static role operation catalog v1', () => {
  it('validates its entire schema and rejects misleading or missing fields', () => {
    validate(manifest, schema);
    for (const mutate of [(m: any) => delete m.operations[0].sideEffects, (m: any) => m.operations[0].async = false, (m: any) => m.extra = true, (m: any) => m.schemaVersion = 2]) {
      const copy = structuredClone(manifest); mutate(copy); expect(() => validate(copy, schema)).toThrow();
    }
  });
  it('lists exactly the five ROOT-selected imports with precise publication/sending semantics', () => {
    expect(manifest.operations.map((o: any) => o.id)).toEqual(['readRoleOperationEvidence', 'reviewRoleOperation', 'prepareRoleOperation', 'readRoleOperationStatus', 'revalidatePreparedRoleOperation']);
    expect(manifest.packageVersion).toBe(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version);
    for (const op of manifest.operations) {
      expect(op.sideEffects.signs).toBe(false); expect(op.sideEffects.broadcasts).toBe(false); expect(op.sideEffects.persists).toBe(false);
      expect(op.sideEffects.publishes).toBe(op.id === 'prepareRoleOperation');
      expect(op.states).toEqual(['ready', 'blocked', 'unknown']);
      expect(op.retry).toMatch(/never|Never/);
    }
    expect(manifest.units.value).toMatch(/wei decimal string/);
    expect(manifest.units.now).toMatch(/seconds/); expect(manifest.units.createdAt).toMatch(/milliseconds/);
    expect(manifest.trust.join(' ')).toMatch(/not JSON-replayable/);
  });
  it('matches the implemented five async public function names without loading operation code', () => {
    const file = resolve(root, 'src/governance/role-operations.ts');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const functions = source.statements.filter(ts.isFunctionDeclaration);
    for (const op of manifest.operations) {
      const declaration = functions.find(f => f.name?.text === op.id);
      expect(declaration, op.id).toBeDefined();
      expect(declaration!.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword), op.id).toBe(true);
      expect(declaration!.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword), op.id).toBe(true);
    }
  });
  it('references existing real APIs without inventing a runtime catalog namespace', () => {
    for (const reference of manifest.references) {
      const file = resolve(root, 'src', reference.import.replace('@poa-box/core/', '') + '.ts');
      expect(existsSync(file), reference.import).toBe(true);
      const exports = exportsOf(file);
      for (const name of reference.exports) expect(exports, reference.import).toContain(name);
    }
  });
});
