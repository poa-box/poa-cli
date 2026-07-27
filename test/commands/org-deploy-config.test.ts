/**
 * pop org deploy-config — local file generation + overwrite guard.
 *
 * Writing a FRESH file is non-destructive (non-TTY agents keep their
 * silent-pass contract); overwriting an EXISTING file is destructive and
 * refuses in non-TTY sessions without --yes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/output', () => ({
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), text: '' })),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  json: vi.fn(),
  table: vi.fn(),
  keyValueBlock: vi.fn(),
  isJsonMode: vi.fn(() => false),
  isQuietMode: vi.fn(() => false),
  subgraphLagWarning: vi.fn(),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deployConfigHandler } from '../../src/commands/org/deploy-config';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

describe('pop org deploy-config — overwrite guard', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let outPath: string;

  function baseArgv(overrides: Record<string, any> = {}): any {
    return {
      _: [],
      $0: 'pop',
      name: 'Test Org',
      username: 'tester',
      description: '',
      output: outPath,
      template: 'standard',
      yes: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _setStreamsForTest(undefined, undefined, false); // deterministic non-TTY
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-deploy-config-test-'));
    outPath = path.join(tmpDir, 'org-deploy-config.json');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    _setStreamsForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fresh file, non-TTY, no --yes: writes silently (non-destructive path)', async () => {
    await deployConfigHandler.handler(baseArgv());

    const written = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(written.orgName).toBe('Test Org');
    expect(written.deployerUsername).toBe('tester');
    expect(written.roles.length).toBeGreaterThan(0);
    expect(output.error).not.toHaveBeenCalled();
  });

  it('existing file, non-TTY, no --yes: refuses with EXIT.ABORTED and leaves the file untouched', async () => {
    fs.writeFileSync(outPath, '{"orgName":"KEEP ME"}\n');

    await expect(deployConfigHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.ABORTED);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('destructive'),
      expect.anything(),
    );
    expect(fs.readFileSync(outPath, 'utf-8')).toContain('KEEP ME');
  });

  it('existing file + --yes: overwrites', async () => {
    fs.writeFileSync(outPath, '{"orgName":"KEEP ME"}\n');

    await deployConfigHandler.handler(baseArgv({ yes: true }));

    const written = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(written.orgName).toBe('Test Org');
  });

  it('minimal template writes a single-role config', async () => {
    await deployConfigHandler.handler(baseArgv({ template: 'minimal' }));

    const written = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(written.roles).toHaveLength(1);
    expect(written.paymaster).toBeUndefined();
  });
});
