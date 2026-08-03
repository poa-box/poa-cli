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

  it('rejects versions npm would normalize or collide', () => {
    expect(parseVersion('01.2.3')).toBeNull();      // npm normalizes → not the reviewed version
    expect(parseVersion('1.2.3+build')).toBeNull(); // build metadata collides on republish
    expect(parseVersion('1.2.3-')).toBeNull();
    expect(parseVersion('1.2.3-rc.01')).toBeNull(); // padded numeric identifier
  });

  it('orders releases and prereleases', () => {
    expect(compareVersions('0.1.1', '0.1.0')).toBe(1);
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);   // prerelease < release
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
  });

  it('orders prerelease identifiers per semver, not by string compare', () => {
    // The bug this pins: 'rc.10' < 'rc.2' as strings, so a string compare
    // would call rc.10 an older version and let it move `latest` backwards.
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1); // prefix loses
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);       // numeric < alphanumeric
    expect(compareVersions('1.0.0-alpha.beta', '1.0.0-alpha.1')).toBe(1);
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
  it('accepts a pin on a sibling being published in the same run', () => {
    const { errors, plan } = buildPlan(
      PACKAGES,
      pkgs({ 'packages/core': '9.9.9', '.': '0.1.1', 'packages/agent': '0.1.1' }),
      registry({
        '@poa-box/core': { versions: [], latest: null },   // publishes 9.9.9 now
        '@poa-box/cli': { versions: ['0.1.0'], latest: '0.1.0' },
        '@poa-box/agent': { versions: ['0.1.0'], latest: '0.1.0' },
      })
    );
    expect(errors).toEqual([]);
    expect(plan[1].pinnedRange).toBe('^9.9.9');
  });

  it('accepts a pin on a sibling already on the registry', () => {
    const { errors } = buildPlan(
      PACKAGES,
      pkgs({ 'packages/core': '0.1.0', '.': '0.5.0', 'packages/agent': '0.2.0' }),
      registry({
        '@poa-box/core': { versions: ['0.1.0'], latest: '0.1.0' },
        '@poa-box/cli': { versions: ['0.5.0'], latest: '0.5.0' },  // skips; pin resolvable
        '@poa-box/agent': { versions: [], latest: null },
      })
    );
    expect(errors).toEqual([]);
  });

  it('BLOCKS a pin on a sibling version that will not exist after this run', () => {
    // The classic trap: someone bumps the CLI's version but does not release
    // it, then releases only the agent. The agent would publish a dependency
    // on @poa-box/cli@^0.9.0 — a version nobody can install.
    const { errors, plan } = buildPlan(
      PACKAGES,
      pkgs({ 'packages/core': '0.1.0', '.': '0.9.0', 'packages/agent': '0.2.0' }),
      registry({
        '@poa-box/core': { versions: ['0.1.0'], latest: '0.1.0' },
        // CLI 0.9.0 is NOT on the registry, and its own publish is blocked
        // below (simulated: it will publish, so we make the agent the only
        // failure by leaving the CLI unpublished AND unpublishable).
        '@poa-box/cli': { versions: ['0.1.0'], latest: '0.9.5' },  // latest > 0.9.0 → CLI blocked
        '@poa-box/agent': { versions: [], latest: null },
      })
    );
    // The CLI is blocked (backwards latest) AND the agent's pin is dangling.
    // The CLI is blocked (backwards latest), so the agent's pin on it dangles:
    // a blocked sibling must NOT count as "will exist".
    expect(errors.join(' | ')).toMatch(/@poa-box\/cli: refusing to publish 0\.9\.0/);
    expect(errors.join(' | ')).toMatch(/@poa-box\/agent: would publish a dependency on @poa-box\/cli@\^0\.9\.0.*itself blocked/);
    expect(plan.find((p: any) => p.name === '@poa-box/agent')?.pinnedRange).toBe('^0.9.0');
  });
});

describe('guard: a prerelease must not land on `latest`', () => {
  it('blocks an rc when the dist-tag is latest', () => {
    const { errors } = buildPlan(
      PACKAGES,
      pkgs({ 'packages/core': '0.2.0-rc.1', '.': '0.2.0-rc.1', 'packages/agent': '0.2.0-rc.1' }),
      registry(FRESH)
    );
    expect(errors.join(' ')).toMatch(/PRERELEASE and would be published to the "latest" dist-tag/);
  });

  it('allows the same rc under an explicit tag', () => {
    const { errors } = buildPlan(
      PACKAGES,
      pkgs({ 'packages/core': '0.2.0-rc.1', '.': '0.2.0-rc.1', 'packages/agent': '0.2.0-rc.1' }),
      registry(FRESH),
      { distTag: 'next' }
    );
    expect(errors).toEqual([]);
  });
});

describe('guard: latest falls back to the highest version', () => {
  it('still blocks a backwards publish when dist-tags has no latest', () => {
    const { errors } = buildPlan(
      PACKAGES,
      pkgs({ 'packages/core': '0.1.0', '.': '0.1.1', 'packages/agent': '0.1.1' }),
      registry({
        ...FRESH,
        '@poa-box/cli': { versions: ['0.1.0', '0.3.0'], latest: null },
      })
    );
    expect(errors.join(' ')).toMatch(/LOWER than the current latest \(0\.3\.0\)/);
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
