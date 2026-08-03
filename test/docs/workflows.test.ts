/**
 * GitHub Actions workflow sanity.
 *
 * A malformed workflow does not fail loudly — GitHub just refuses to run it,
 * so the first sign is "the Release button does nothing" during a release.
 * The release workflow already broke this way once in review: an unquoted
 * `no link: may escape` in a step name parsed as a nested mapping.
 *
 * No YAML dependency: this checks the specific, mechanical mistakes that
 * silently disable a workflow, rather than fully parsing it (CI's own
 * `on: push` run is the real parser — a broken file never reaches main
 * because GitHub rejects it there too).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const WORKFLOWS = join(__dirname, '..', '..', '.github', 'workflows');
const files = readdirSync(WORKFLOWS).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

describe('workflow files', () => {
  it('exist (ci + release)', () => {
    expect(files).toContain('ci.yml');
    expect(files).toContain('release.yml');
  });

  for (const file of files) {
    describe(file, () => {
      const src = readFileSync(join(WORKFLOWS, file), 'utf-8');
      const lines = src.split('\n');

      it('has no unquoted colon-space inside a scalar value (breaks the mapping)', () => {
        const offenders: string[] = [];
        lines.forEach((line, i) => {
          // `  - name: something: else`  /  `    description: a: b`
          const m = /^\s*(?:-\s+)?(name|description|summary):\s+(.*)$/.exec(line);
          if (!m) return;
          const value = m[2].trim();
          if (!value || value.startsWith("'") || value.startsWith('"') || value.startsWith('|') || value.startsWith('>')) return;
          if (/:\s/.test(value)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        });
        expect(offenders, `quote these values — ": " makes YAML read them as nested mappings:\n${offenders.join('\n')}`).toEqual([]);
      });

      it('uses tabs nowhere (YAML forbids them for indentation)', () => {
        const tabs = lines.map((l, i) => [l, i] as const).filter(([l]) => /^\s*\t/.test(l));
        expect(tabs.map(([, i]) => i + 1)).toEqual([]);
      });

      it('indents with an even number of spaces', () => {
        const odd = lines
          .map((l, i) => [l, i] as const)
          .filter(([l]) => l.trim() && !l.trimStart().startsWith('#'))
          .filter(([l]) => (l.length - l.trimStart().length) % 2 !== 0);
        expect(odd.map(([l, i]) => `${i + 1}: ${l}`)).toEqual([]);
      });
    });
  }
});

describe('release workflow contract', () => {
  const src = readFileSync(join(WORKFLOWS, 'release.yml'), 'utf-8');

  it('defaults to a dry run — a publish must be chosen deliberately', () => {
    expect(src).toMatch(/dry_run:[\s\S]*?type: boolean[\s\S]*?default: true/);
  });

  it('publishes in dependency order: core → cli → agent', () => {
    const order = [...src.matchAll(/Publish (@poa-box\/\w+)/g)].map(m => m[1]);
    expect(order).toEqual(['@poa-box/core', '@poa-box/cli', '@poa-box/agent']);
  });

  it('gates every publish and the tagging on dry_run', () => {
    const publishSteps = src.split('\n').filter(l => l.includes('npm publish'));
    expect(publishSteps.length).toBe(3);
    // Each publish step is preceded by an `if:` that negates dry_run.
    expect([...src.matchAll(/if: \$\{\{ !inputs\.dry_run/g)].length).toBeGreaterThanOrEqual(6);
  });

  it('runs the preflight before any publish step', () => {
    expect(src.indexOf('release-preflight.mjs')).toBeLessThan(src.indexOf('npm publish'));
  });

  it('serializes releases and can push tags + provenance', () => {
    expect(src).toMatch(/concurrency:\s*\n\s*group: release/);
    expect(src).toMatch(/id-token: write/);
    expect(src).toMatch(/--provenance/);
  });
});
