/**
 * envfile.ts — KEY=value read/write helpers used by `pop init`.
 *
 * Focus: round-trip stability (write → read), upsert that preserves unrelated
 * lines AND comments, file creation on updateEnvVar, and the 0600 mode contract
 * (these files hold private keys). Uses a real tmp dir so the fs behavior and
 * chmod are exercised end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeEnvFile, updateEnvVar, readEnvFile } from '../../src/lib/envfile';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pop-envfile-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeEnvFile', () => {
  it('writes KEY=value lines that readEnvFile round-trips', () => {
    const file = join(dir, '.env');
    const vars = {
      POP_PRIVATE_KEY: '0xabc123',
      POP_DEFAULT_CHAIN: '100',
      POP_DEFAULT_ORG: 'myorg',
    };
    writeEnvFile(file, vars);
    expect(readEnvFile(file)).toEqual(vars);
  });

  it('chmods the file to 0600 by default', () => {
    const file = join(dir, '.env');
    writeEnvFile(file, { A: '1' });
    // Mask to the permission bits; 0600 = owner rw only.
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('honors an explicit mode', () => {
    const file = join(dir, '.env');
    writeEnvFile(file, { A: '1' }, { mode: 0o644 });
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });

  it('creates missing parent directories', () => {
    const file = join(dir, 'nested', 'deep', '.env');
    writeEnvFile(file, { A: '1' });
    expect(existsSync(file)).toBe(true);
    expect(readEnvFile(file)).toEqual({ A: '1' });
  });

  it('ends the file with a trailing newline', () => {
    const file = join(dir, '.env');
    writeEnvFile(file, { A: '1', B: '2' });
    expect(readFileSync(file, 'utf8')).toBe('A=1\nB=2\n');
  });
});

describe('updateEnvVar', () => {
  it('upserts one var while preserving other lines and comments', () => {
    const file = join(dir, '.env');
    writeFileSync(
      file,
      '# top comment\nPOP_DEFAULT_CHAIN=100\n\n# key below\nPOP_DEFAULT_ORG=oldorg\n'
    );

    updateEnvVar(file, 'POP_DEFAULT_ORG', 'neworg');

    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# top comment');
    expect(text).toContain('# key below');
    expect(text).toContain('POP_DEFAULT_CHAIN=100');
    expect(text).toContain('POP_DEFAULT_ORG=neworg');
    expect(text).not.toContain('oldorg');
    // The parsed view reflects only the changed value.
    expect(readEnvFile(file)).toEqual({
      POP_DEFAULT_CHAIN: '100',
      POP_DEFAULT_ORG: 'neworg',
    });
  });

  it('appends the key when absent, keeping existing content', () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'POP_DEFAULT_CHAIN=100\n');
    updateEnvVar(file, 'POP_PRIVATE_KEY', '0xdead');
    expect(readEnvFile(file)).toEqual({
      POP_DEFAULT_CHAIN: '100',
      POP_PRIVATE_KEY: '0xdead',
    });
  });

  it('creates the file (0600) when it does not exist', () => {
    const file = join(dir, '.env');
    updateEnvVar(file, 'POP_DEFAULT_CHAIN', '42161');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readEnvFile(file)).toEqual({ POP_DEFAULT_CHAIN: '42161' });
  });

  it('does not touch a commented-out line with the same key — it appends instead', () => {
    const file = join(dir, '.env');
    writeFileSync(file, '# POP_DEFAULT_ORG=disabled\n');
    updateEnvVar(file, 'POP_DEFAULT_ORG', 'live');
    const text = readFileSync(file, 'utf8');
    // The comment is preserved verbatim; the active setting is appended.
    expect(text).toContain('# POP_DEFAULT_ORG=disabled');
    expect(readEnvFile(file)).toEqual({ POP_DEFAULT_ORG: 'live' });
  });

  it('rewrites only the first occurrence of a duplicated key', () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'K=first\nK=second\n');
    updateEnvVar(file, 'K', 'updated');
    expect(readFileSync(file, 'utf8')).toBe('K=updated\nK=second\n');
  });
});

describe('readEnvFile', () => {
  it('returns {} for a missing file', () => {
    expect(readEnvFile(join(dir, 'nope.env'))).toEqual({});
  });

  it('skips blank lines and comments, and strips surrounding quotes', () => {
    const file = join(dir, '.env');
    writeFileSync(file, '\n# comment\nA="quoted"\nB=\'single\'\nC=bare\n   \n');
    expect(readEnvFile(file)).toEqual({ A: 'quoted', B: 'single', C: 'bare' });
  });

  it('keeps = signs that appear in the value', () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'URL=https://example.com/path?a=1&b=2\n');
    expect(readEnvFile(file)).toEqual({ URL: 'https://example.com/path?a=1&b=2' });
  });
});
