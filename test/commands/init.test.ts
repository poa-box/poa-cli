/**
 * pop init — onboarding wizard.
 *
 * Covers the three contract-critical behaviors:
 *   (a) non-TTY without the required flags is a USAGE error (never prompts),
 *   (b) --generate-key --chain writes a valid env with a fresh key and refuses
 *       to clobber an existing target without --force, and
 *   (c) the interactive import path validates the pasted key (the validate
 *       callback rejects a bad key, accepts a good one) and persists it.
 *
 * envfile + ethers run REAL against a tmp dir. output is mocked (silence +
 * pin isJsonMode false). prompt is mocked so interactive branches are
 * deterministic — the handler's own `validate` callback is still exercised by
 * calling it directly, so real key validation is under test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mocks = vi.hoisted(() => ({
  isInteractive: vi.fn(),
  select: vi.fn(),
  input: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('../../src/lib/output', () => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  json: vi.fn(),
  keyValueBlock: vi.fn(),
  isJsonMode: vi.fn(() => false),
}));
vi.mock('../../src/lib/prompt', () => ({
  isInteractive: mocks.isInteractive,
  select: mocks.select,
  input: mocks.input,
  confirm: mocks.confirm,
}));

import { ethers } from 'ethers';
import { initHandler, validatePrivateKey, resolveTargetFile } from '../../src/commands/init';
import { readEnvFile } from '../../src/lib/envfile';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

let dir: string;
let exitSpy: ReturnType<typeof vi.spyOn>;
const savedKey = process.env.POP_PRIVATE_KEY;

function baseArgv(overrides: Record<string, any> = {}): any {
  return { _: [], $0: 'pop', generateKey: false, global: false, force: false, ...overrides };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pop-init-'));
  delete process.env.POP_PRIVATE_KEY;
  vi.clearAllMocks();
  (output.isJsonMode as any).mockReturnValue(false);
  mocks.isInteractive.mockReturnValue(false); // deterministic non-TTY default
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  exitSpy.mockRestore();
  if (savedKey === undefined) delete process.env.POP_PRIVATE_KEY;
  else process.env.POP_PRIVATE_KEY = savedKey;
});

describe('resolveTargetFile', () => {
  it('prefers --file, then --global (~/.pop/.env), else ./.env', () => {
    expect(resolveTargetFile({ file: '/tmp/x.env' })).toBe('/tmp/x.env');
    expect(resolveTargetFile({ global: true })).toMatch(/\.pop\/\.env$/);
    expect(resolveTargetFile({})).toMatch(/\.env$/);
  });
});

describe('non-TTY guard', () => {
  it('exits USAGE and never writes when --chain / key source are missing', async () => {
    const file = join(dir, '.env');

    await expect(initHandler.handler(baseArgv({ file }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(existsSync(file)).toBe(false);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('needs a TTY'),
      expect.anything()
    );
    // Never prompted.
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.input).not.toHaveBeenCalled();
  });

  it('exits USAGE when --chain is given but there is no key source', async () => {
    const file = join(dir, '.env');
    await expect(initHandler.handler(baseArgv({ file, chain: 100 }))).rejects.toBeInstanceOf(ExitError);
    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(existsSync(file)).toBe(false);
  });
});

describe('--generate-key non-interactive', () => {
  it('writes a fresh, valid key + chain (mode 600) without prompting', async () => {
    const file = join(dir, '.env');

    await initHandler.handler(baseArgv({ file, chain: 100, generateKey: true, org: 'acme' }));

    const vars = readEnvFile(file);
    expect(vars.POP_DEFAULT_CHAIN).toBe('100');
    expect(vars.POP_DEFAULT_ORG).toBe('acme');
    expect(() => new ethers.Wallet(vars.POP_PRIVATE_KEY)).not.toThrow();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(output.success).toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled(); // no confirm in non-TTY
  });

  it('refuses to clobber an existing file without --force', async () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'PRE_EXISTING=1\n');

    await expect(
      initHandler.handler(baseArgv({ file, chain: 100, generateKey: true }))
    ).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('already exists'),
      expect.anything()
    );
    expect(readEnvFile(file)).toEqual({ PRE_EXISTING: '1' });
  });

  it('overwrites an existing file when --force is set', async () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'PRE_EXISTING=1\n');

    await initHandler.handler(baseArgv({ file, chain: 100, generateKey: true, force: true }));

    const vars = readEnvFile(file);
    expect(vars.PRE_EXISTING).toBeUndefined();
    expect(vars.POP_DEFAULT_CHAIN).toBe('100');
    expect(() => new ethers.Wallet(vars.POP_PRIVATE_KEY)).not.toThrow();
  });

  it('rejects an unsupported chain id', async () => {
    const file = join(dir, '.env');

    await expect(
      initHandler.handler(baseArgv({ file, chain: 999999, generateKey: true }))
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(existsSync(file)).toBe(false);
  });
});

describe('non-TTY with POP_PRIVATE_KEY', () => {
  it('uses a valid env key', async () => {
    process.env.POP_PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;
    const file = join(dir, '.env');

    await initHandler.handler(baseArgv({ file, chain: 42161 }));

    const vars = readEnvFile(file);
    expect(vars.POP_PRIVATE_KEY).toBe(process.env.POP_PRIVATE_KEY);
    expect(vars.POP_DEFAULT_CHAIN).toBe('42161');
  });

  it('validates a bad env key (USAGE, no file written)', async () => {
    process.env.POP_PRIVATE_KEY = 'not-a-real-key';
    const file = join(dir, '.env');

    await expect(initHandler.handler(baseArgv({ file, chain: 100 }))).rejects.toBeInstanceOf(ExitError);
    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(existsSync(file)).toBe(false);
  });
});

describe('interactive import path', () => {
  it('validates the pasted key (rejects bad, accepts good) and writes it', async () => {
    const file = join(dir, '.env');
    const goodKey = ethers.Wallet.createRandom().privateKey;

    mocks.isInteractive.mockReturnValue(true);
    // key-choice select → 'import'; org select is not used (org via input).
    mocks.select.mockResolvedValueOnce('import');
    // The import input: capture the validate callback and return the good key.
    let importValidate: ((s: string) => string | true) | undefined;
    mocks.input.mockImplementation(async (_q: string, opts?: any) => {
      if (opts?.secret) {
        importValidate = opts.validate;
        return goodKey; // user pastes a valid key
      }
      return ''; // org prompt → skipped
    });
    mocks.confirm.mockResolvedValue(true);

    await initHandler.handler(baseArgv({ file, chain: 100 }));

    // The handler wired a real validator: bad key rejected, good key accepted.
    expect(importValidate).toBeTypeOf('function');
    expect(importValidate!('deadbeef')).not.toBe(true); // rejected → error string
    expect(importValidate!(goodKey)).toBe(true);

    const vars = readEnvFile(file);
    expect(vars.POP_PRIVATE_KEY).toBe(goodKey);
    expect(vars.POP_DEFAULT_CHAIN).toBe('100');
    expect(vars.POP_DEFAULT_ORG).toBeUndefined();
    expect(output.success).toHaveBeenCalled();
  });

  it('aborts (exit ABORTED) when the confirm is declined', async () => {
    const file = join(dir, '.env');
    mocks.isInteractive.mockReturnValue(true);
    mocks.select.mockResolvedValueOnce('generate');
    mocks.input.mockResolvedValue(''); // org skip
    mocks.confirm.mockResolvedValue(false);

    await expect(initHandler.handler(baseArgv({ file, chain: 100 }))).rejects.toBeInstanceOf(ExitError);
    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.ABORTED);
    expect(existsSync(file)).toBe(false);
  });
});

describe('validatePrivateKey (pure)', () => {
  it('accepts a valid key and normalizes it', () => {
    const wallet = ethers.Wallet.createRandom();
    expect(validatePrivateKey(wallet.privateKey)).toBe(wallet.privateKey);
    expect(validatePrivateKey(`  ${wallet.privateKey}  `)).toBe(wallet.privateKey);
  });

  it('throws on a bad key', () => {
    expect(() => validatePrivateKey('not-a-key')).toThrow();
    expect(() => validatePrivateKey('0x1234')).toThrow();
  });
});
