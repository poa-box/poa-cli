import { beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { executableSnippet, validateWorkflowRecipes, verifyUnsignedRecipes } from '../scripts/workflow-recipe-checks.mjs';

const root = resolve(__dirname, '..'), repo = resolve(root, '../..');
const catalog = JSON.parse(readFileSync(resolve(root, 'docs/workflow-recipes.v1.json'), 'utf8'));
const schema = JSON.parse(readFileSync(resolve(root, 'docs/workflow-recipes.schema.json'), 'utf8'));
// Fast source contract tests require no separate example install. The explicit
// packed verifier executes the SAME document checks against its isolated archive
// and records distributed-package evidence with no source/workspace fallback.
const sourceModules = import.meta.glob('../src/**/*.ts');
const apis = new Map<string, any>([['ethers', { ethers }]]);
beforeAll(async () => {
  const names = new Set(catalog.recipes.flatMap((recipe: any) => recipe.apis.map((api: any) => api.module)));
  for (const name of names) {
    const loader = sourceModules['../src/' + String(name).replace('@poa-box/core/', '') + '.ts'];
    if (!loader) throw new Error('MISSING_RECIPE_SOURCE:' + name);
    apis.set(String(name), await loader());
  }
});
const loadApi = (name: string) => {
  if (!apis.has(name)) throw new Error('UNEXPECTED_RECIPE_IMPORT:' + name);
  return apis.get(name);
};

describe('task recipe source contracts (distributed execution belongs to the archive verifier)', () => {
  it('validates schema, exact public API exports, effects and unique recipe IDs', () => {
    validateWorkflowRecipes(catalog, schema, loadApi);
    expect(catalog.recipes.map((r: any) => r.id)).toEqual(['read-organization', 'prepare-task', 'prepare-poll', 'prepare-vote', 'review-role', 'recover-submission']);
    for (const mutate of [(c: any) => delete c.recipes[0].inputs, (c: any) => c.recipes[0].effects.signs = true,
      (c: any) => c.recipes.push(c.recipes[0]), (c: any) => c.recipes[0].apis[0].exports = ['inventedFunction'],
      (c: any) => c.recipes[0].steps[0].calls[0].export = 'inventedFunction',
      (c: any) => c.recipes[0].steps.push(c.recipes[0].steps[0]),
      (c: any) => c.recipes[0].extra = true]) {
      const copy = structuredClone(catalog); mutate(copy);
      expect(() => validateWorkflowRecipes(copy, schema, loadApi)).toThrow();
    }
  });

  it('executes the exact documentation snippets with raw amounts, large IDs, DD lane and malformed-vector refusal', () => {
    const cache = new Map<string, any>();
    for (const recipe of catalog.recipes) {
      const { document, marker, export: name } = recipe.example;
      const key = document + ':' + marker;
      if (!cache.has(key)) cache.set(key, executableSnippet(readFileSync(resolve(root, document), 'utf8'), marker, ts, loadApi));
      expect(typeof cache.get(key)[name], recipe.id).toBe('function');
    }
    verifyUnsignedRecipes(cache.get('docs/getting-started.md:task-recipes'), loadApi);
  });
});
