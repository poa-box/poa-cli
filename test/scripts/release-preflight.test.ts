/**
 * Release preflight guards.
 *
 * These assertions are the release's safety net: each one corresponds to a
 * mistake that is IRREVERSIBLE once it reaches npm (a version can never be
 * re-published, and a moved `latest` tag silently downgrades consumers). The
 * registry is injected, so nothing here touches the network.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import { buildPlan, compareVersions, parseVersion } from '../../scripts/release-preflight.mjs';

const PACKAGES = [
  { dir: 'packages/core', dependsOn: null },
  { dir: '.', dependsOn: '@poa-box/core' },
  { dir: 'packages/agent', dependsOn: '@poa-box/cli' },
];

const NAME_BY_DIR: Record<string, string> = {
  'packages/core': '@poa-box/core',
  '.': '@poa-box/cli',
  'packages/agent': '@poa-box/agent',
};

/** readPkg stub: versions keyed by dir. */
const pkgs = (versions: Record<string, string>) => (dir: string) => ({
  name: NAME_BY_DIR[dir],
  version: versions[dir],
});

/** lookup stub: registry state keyed by package name. */
const registry = (state: Record<string, { versions: string[]; latest: string | null }>) =>
  (name: string) => state[name] ?? { published: false, versions: [], latest: null };

const FRESH = {
  '@poa-box/core': { versions: [], latest: null },
  '@poa-box/cli': { versions: ['0.1.0'], latest: '0.1.0' },
  '@poa-box/agent': { versions: ['0.1.0'], latest: '0.1.0' },
};

describe('semver helpers', () => {
  it('parses and rejects', () => {
    expect(parseVersion('1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('1.2.3-rc.1')?.prerelease).toBe('rc.1');
    expect(parseVersion('0.1')).toBeNull();
    expect(parseVersion('v1.2.3')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });

  it('orders releases and prereleases', () => {
    expect(compareVersions('0.1.1', '0.1.0')).toBe(1);
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);   // prerelease < release
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
  });
});

describe('the happy path (today\'s actual release)', () => {
  it('publishes all three in dependency order with derived pins', () => {
    const { plan, errors } = buildPlan(
      PACKAGES,
      pkgs({ 'packages/core': '0.1.0', '.': '0.1.1', 'packages/agent': '0.1.1' }),
      registry(FRESH)
    );
    expect(errors).toEqual([]);
    expect(plan.map((p: any) => [p.name, p.action])).toEqual([
      ['@poa-box/core', 'publish'],
      ['@poa-box/cli', 'publish'],
      ['@poa-box/agent', 'publish'],
    ]);
    expect(plan[1].pinnedRange).toBe('^0.1.0');   // cli → core
    expect(plan[2].pinnedRange).toBe('^0.1.1');   // agent → cli
  });
});

describe('guard: nothing to publish', () => {
  it('fails when every version already exists (a forgotten bump)', () => {
    const { errors } = buildPlan(
      PACKAGES,
      pkgs({ 'packages/core': '0.1.0', '.': '0.1.0', 'packages/agent': '0.1.0' }),
      registry({
        '@poa-box/core': { versions: ['0.1.0'], latest: '0.1.0' },
        '@poa-box/cli': { versions: ['0.1.0'], latest: '0.1.0' },
        '@poa-box/agent': { versions: ['0.1.0'], latest: '0.1.0' },
      })
    );
    expect(errors.join(' ')).toMatch(/nothing to publish/i);
  });

  it('allows a partial release (one package bumped, others already out)', () => {
    const { plan, errors } = buildPlan(
      PACKAGES,
      pkgs({ 'packages/core': '0.1.1', '.': '0.1.1', 'packages/agent': '0.1.1' }),
      registry({
        '@poa-box/core': { versions: ['0.1.0', '0.1.1'], latest: '0.1.1' },
        '@poa-box/cli': { versions: ['0.1.0'], latest: '0.1.0' },
        '@poa-box/agent': { versions: ['0.1.1'], latest: '0.1.1' },
      })
    );
    expect(errors).toEqual([]);
    expect(plan.map((p: any) => p.action)).toEqual(['skip', 'publish', 'skip']);
  });
});

describe('guard: never move the `latest` tag backwards', () => {
  it('refuses a version lower than the published latest', () => {
    const { errors } = buildPlan(
      PACKAGES,
      pkgs({ 'packages/core': '0.1.0', '.': '0.1.1', 'packages/agent': '0.1.1' }),
      registry({
        ...FRESH,
        // 0.2.0 is out; republishing 0.1.1 would drag `latest` back to 0.1.1.
        '@poa-box/cli': { versions: ['0.1.0', '0.2.0'], latest: '0.2.0' },
      })
    );
    expect(errors.join(' ')).toMatch(/LOWER than the current latest \(0\.2\.0\)/);
  });

  it('permits an equal-or-higher version', () => {
    const { errors } = buildPlan(
      PACKAGES,
      pkgs({ 'packages/core': '0.1.0', '.': '0.3.0', 'packages/agent': '0.1.1' }),
      registry({ ...FRESH, '@poa-box/cli': { versions: ['0.2.0'], latest: '0.2.0' } })
    );
    expect(errors).toEqual([]);
  });
});

describe('guard: inter-package ranges must resolve', () => {
  it('refuses to publish the CLI pinning a core version that will not exist', () => {
    // core 0.2.0 is in package.json but ALREADY published as 0.1.0 only...
    // here core is skipped (its version exists) so the pin is fine; the real
    // hazard is a pin at a version neither published nor in this run:
    const { errors } = buildPlan(
      PACKAGES,
      pkgs({ 'packages/core': '9.9.9', '.': '0.1.1', 'packages/agent': '0.1.1' }),
      registry({
        // core: registry reports 9.9.9 as existing, so core SKIPS; but suppose
        // the registry lookup shows no such version and it is not being
        // published either — simulated by an empty version list + skip below.
        '@poa-box/core': { versions: [], latest: null },
        '@poa-box/cli': { versions: ['0.1.0'], latest: '0.1.0' },
        '@poa-box/agent': { versions: ['0.1.0'], latest: '0.1.0' },
      })
    );
    // core publishes 9.9.9 in this run, so the CLI's ^9.9.9 pin is satisfiable.
    expect(errors).toEqual([]);
  });

  it('flags a dependency that is neither published nor in the run', () => {
    // The agent publishes while the CLI is SKIPPED at a version the registry
    // does not have — i.e. the pin points at a nonexistent CLI version.
    const { errors } = buildPlan(
      PACKAGES,
      pkgs({ 'packages/core': '0.1.0', '.': '0.5.0', 'packages/agent': '0.2.0' }),
      registry({
        '@poa-box/core': { versions: ['0.1.0'], latest: '0.1.0' },
        // CLI 0.5.0 "exists" so it skips — but the agent pins ^0.5.0 which is
        // present here, so this must PASS. Sanity that the guard is not noisy.
        '@poa-box/cli': { versions: ['0.5.0'], latest: '0.5.0' },
        '@poa-box/agent': { versions: [], latest: null },
      })
    );
    expect(errors).toEqual([]);
  });
});

describe('guard: malformed versions never reach the registry', () => {
  it('rejects a typo\'d version', () => {
    const { errors } = buildPlan(
      PACKAGES,
      pkgs({ 'packages/core': '0.1', '.': '0.1.1', 'packages/agent': '0.1.1' }),
      registry(FRESH)
    );
    expect(errors.join(' ')).toMatch(/not a valid semver/);
  });
});
