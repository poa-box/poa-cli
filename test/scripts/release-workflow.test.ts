import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const workflow = readFileSync(resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8');
const temporary: string[] = [];

// Run the actual workflow shell, with expressions resolved against a simulated
// Actions context and git/npm replaced by local stubs; no registry or remote access.
function resolveExpressions(source: string, context: any): string {
  return source.replace(/\$\{\{\s*([\w.]+)\s*\}\}/g, (_, expression: string) => {
    const value = expression.split('.').reduce((obj, key) => obj?.[key], context);
    if (value === undefined) throw new Error(`Unavailable Actions expression: ${expression}`);
    return String(value);
  });
}

function stepScript(name: string): string {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  if (start < 0) throw new Error(`Missing step ${name}`);
  const next = workflow.indexOf('\n      - name:', start + 1);
  const block = workflow.slice(start, next < 0 ? undefined : next);
  const script = block.split('        run: |\n')[1];
  if (!script) throw new Error(`Missing shell for ${name}`);
  return script.split('\n').filter(line => line.startsWith('          ') || !line.trim())
    .map(line => line.slice(10)).join('\n');
}

function fixture(outcomes: string[], failPush = '') {
  const dir = mkdtempSync(join(tmpdir(), 'pop-release-workflow-'));
  temporary.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls');
  writeFileSync(log, '');
  writeFileSync(join(bin, 'git'), '#!/bin/sh\n[ "$1" = rev-parse ] && exit 1\nprintf "%s\\n" "$*" >> "$RELEASE_TEST_CALLS"\n[ "$*" = "$RELEASE_TEST_FAIL_PUSH" ] && exit 2\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RELEASE_TEST_CALLS"\nexit 99\n', { mode: 0o755 });
  const outputs = Object.fromEntries(['core', 'cli', 'agent'].flatMap(pkg => [
    [`${pkg}_action`, 'publish'], [`${pkg}_version`, '1.0.0'],
  ]));
  const context = { needs: { plan: { outputs } }, steps: Object.fromEntries(
    ['core', 'cli', 'agent'].map((pkg, index) => [`publish_${pkg}`, { outcome: outcomes[index] }]),
  ) };
  const run = (name: string) => execFileSync('bash', ['-e', '-c', resolveExpressions(stepScript(name), context)], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      RELEASE_TEST_CALLS: log, RELEASE_TEST_FAIL_PUSH: failPush, GITHUB_STEP_SUMMARY: join(dir, 'summary') },
  });
  return { run, calls: () => readFileSync(log, 'utf8') };
}

afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('release workflow output and partial-publish guards', () => {
  it('exports the producing preflight step so a nonempty plan can start publishing', () => {
    const preflight = { has_work: 'true', core_action: 'publish', cli_action: 'publish', agent_action: 'publish',
      core_version: '1.0.0', cli_version: '1.0.0', agent_version: '1.0.0' };
    const block = workflow.split('    outputs:\n')[1].split('    steps:\n')[0];
    const rendered = resolveExpressions(block, { steps: { preflight: { outputs: preflight } }, needs: {} });
    for (const [key, value] of Object.entries(preflight)) expect(rendered).toContain(`${key}: ${value}`);
    expect(workflow).toContain("if: ${{ needs.plan.outputs.has_work == 'true' }}");
  });

  it.each([
    [['success', 'failure', 'skipped'], ['core']],
    [['failure', 'skipped', 'skipped'], []],
    [['success', 'success', 'success'], ['core', 'cli', 'agent']],
    [['skipped', 'success', 'success'], ['cli', 'agent']],
  ])('tags only successful uploads after outcomes %j', (outcomes, expected) => {
    const f = fixture(outcomes);
    f.run('Tag the published versions');
    const tagged = [...f.calls().matchAll(/^tag -a (\w+)-v1\.0\.0 /gm)].map(match => match[1]);
    expect(tagged).toEqual(expected);
  });

  it('does not verify or announce failed/skipped uploads as published', () => {
    const f = fixture(['failure', 'skipped', 'skipped']);
    f.run('Verify the registry');
    expect(f.calls()).toBe('');
  });

  it('attempts all successful upload tags and fails visibly when the first push fails', () => {
    const f = fixture(['success', 'success', 'success'], 'push origin core-v1.0.0');
    expect(() => f.run('Tag the published versions')).toThrow();
    const pushed = [...f.calls().matchAll(/^push origin (\w+)-v1\.0\.0$/gm)].map(match => match[1]);
    expect(pushed).toEqual(['core', 'cli', 'agent']);
  });
});
