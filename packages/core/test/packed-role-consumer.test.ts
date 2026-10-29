import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArguments, assertInside, validatePackage, verifyBrowserBundle } from '../scripts/verify-packed-consumer.mjs';

const repo = resolve(__dirname, '../../..');
const diagnostics = join(repo, '.context/registry-integration');
mkdirSync(diagnostics, { recursive: true });
const fixture = mkdtempSync(join(diagnostics, 'verifier-contract-'));
const archive = join(fixture, 'candidate.tgz'); writeFileSync(archive, 'synthetic non-archive');
describe('packed verifier boundaries without installing, building or packing', () => {
  const completedStory = "globalThis.fixtureResult = Promise.resolve({ configuration: { outcome: { data: { next: 'complete' } } } });";
  it('runs guarded browser fallback code with no Node globals, network, or module fallback', async () => {
    await expect(verifyBrowserBundle("if (typeof process === 'object' && process.env) throw new Error('NODE_BRANCH');" + completedStory)).resolves.toMatchObject({ configuration: { outcome: { data: { next: 'complete' } } } });
    await expect(verifyBrowserBundle("fetch('https://network.invalid');" + completedStory)).rejects.toThrow('REAL_NETWORK_FORBIDDEN');
  });
  it('rejects unguarded Node globals, explicit builtins, injected shims and incomplete stories', async () => {
    for (const code of ["process.env.DEBUG;", "Buffer.from('x');", "require('fs');"]) await expect(verifyBrowserBundle(code + completedStory)).rejects.toThrow();
    for (const name of ['process', 'Buffer', 'require']) await expect(verifyBrowserBundle(`globalThis.${name} = {};` + completedStory)).rejects.toThrow('BROWSER_NODE_GLOBAL_INJECTED');
    await expect(verifyBrowserBundle('globalThis.fixtureResult = Promise.resolve({});')).rejects.toThrow('BROWSER_FIXTURE_FAILED');
  });
  it('requires exactly one explicit candidate path and supports absolute or relative paths', () => {
    expect(parseArguments([archive]).archive).toBe(archive);
    expect(parseArguments(['candidate.tgz'], fixture).archive).toBe(archive);
    expect(() => parseArguments([])).toThrow('USAGE');
    expect(() => parseArguments(['--build'])).toThrow('USAGE');
    expect(() => parseArguments([fixture])).toThrow('EXPLICIT_CORE_TARBALL_REQUIRED');
  });
  it('refuses resolution outside the isolated node_modules and source/workspace dependencies', () => {
    const stage = join(fixture, 'stage'); mkdirSync(stage); const inside = join(stage, 'module.js'); writeFileSync(inside, '');
    expect(() => assertInside(inside, stage)).not.toThrow();
    expect(() => assertInside(archive, stage)).toThrow('ISOLATION_RESOLUTION_OUTSIDE_STAGE');
    const pkg = { name: '@poa-box/core', version: '2.0.0', exports: { './*': {} }, dependencies: { ethers: '^5.7.0' } };
    expect(() => validatePackage(pkg)).not.toThrow();
    for (const spec of ['link:../core', 'workspace:*', 'file:../source']) expect(() => validatePackage({ ...pkg, dependencies: { core: spec } })).toThrow('NONARCHIVE_DEPENDENCY');
  });
  it('ships an independent archive dependency and preserves source-alias-free public imports', () => {
    const pkg = JSON.parse(readFileSync(join(repo, 'examples/role-consumer/package.json'), 'utf8'));
    expect(pkg.dependencies).toEqual({ '@poa-box/core': 'file:./core.tgz', ethers: '5.7.2' });
    const source = readFileSync(join(repo, 'examples/role-consumer/src/consumer.mjs'), 'utf8');
    expect(source).toContain("from '@poa-box/core/governance/role-operations'");
    expect(source).not.toMatch(/poa-app|packages\/core\/src|planRoleCreation|planExistingRoleConfiguration|NODE_PATH/);
  });
});
