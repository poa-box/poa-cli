import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setJsonMode, setQuietMode, setVerbose } from '../../src/lib/output';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { EXIT } from '../../src/lib/exit-codes';
import { _clearIdempotencyCacheForTest } from '../../src/lib/idempotency';
import {
  confirmWrite,
  finishWrite,
  promptMissing,
  withIdempotency,
  _clearWriteContextCacheForTest,
} from '../../src/lib/command';

const ANSI_RE = /\u001b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function makeStreams(forceTTY = true) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = '';
  stdout.on('data', chunk => { output += chunk.toString(); });
  _setStreamsForTest(stdin, stdout, forceTTY);
  return { stdin, stdout, getOutput: () => output };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function logText(): string {
  return logSpy.mock.calls.map(call => stripAnsi(call.map(String).join(' '))).join('\n');
}

function errText(): string {
  return errSpy.mock.calls.map(call => stripAnsi(call.map(String).join(' '))).join('\n');
}

const savedCi = process.env.CI;
const savedAssumeYes = process.env.POP_ASSUME_YES;

beforeEach(() => {
  delete process.env.CI;
  delete process.env.POP_ASSUME_YES;
  setJsonMode(false);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  _setStreamsForTest();
  _clearWriteContextCacheForTest();
  setJsonMode(false);
  setQuietMode(false);
  setVerbose(false);
  if (savedCi === undefined) delete process.env.CI;
  else process.env.CI = savedCi;
  if (savedAssumeYes === undefined) delete process.env.POP_ASSUME_YES;
  else process.env.POP_ASSUME_YES = savedAssumeYes;
  vi.restoreAllMocks();
});

describe('confirmWrite', () => {
  it('returns immediately when argv.yes is set (even non-TTY destructive)', async () => {
    makeStreams(false);
    await expect(
      confirmWrite({ yes: true }, { task: 12 }, { destructive: true })
    ).resolves.toBeUndefined();
  });

  it('returns immediately when POP_ASSUME_YES=1', async () => {
    makeStreams(false);
    process.env.POP_ASSUME_YES = '1';
    await expect(
      confirmWrite({}, { task: 12 }, { destructive: true })
    ).resolves.toBeUndefined();
  });

  it('does not honor other POP_ASSUME_YES values', async () => {
    makeStreams(false);
    process.env.POP_ASSUME_YES = 'true';
    await expect(
      confirmWrite({}, { task: 12 }, { destructive: true })
    ).rejects.toMatchObject({ name: 'AbortedError' });
  });

  it('returns immediately in JSON mode (even destructive)', async () => {
    makeStreams(false);
    setJsonMode(true);
    await expect(
      confirmWrite({}, { task: 12 }, { destructive: true })
    ).resolves.toBeUndefined();
  });

  it('TTY: shows the summary and resolves on accept', async () => {
    const { stdin, getOutput } = makeStreams(true);
    const pending = confirmWrite({}, { task: 12, payout: '5 PT', skipped: undefined });
    stdin.write('y\n');
    await expect(pending).resolves.toBeUndefined();
    const summary = logText();
    expect(summary).toContain('About to send');
    expect(summary).toContain('task:');
    expect(summary).toContain('payout:');
    expect(summary).not.toContain('skipped');
    expect(getOutput()).toContain('Proceed?');
  });

  it('TTY: uses the custom actionLabel', async () => {
    const { stdin } = makeStreams(true);
    const pending = confirmWrite({}, { proposal: 3 }, { actionLabel: 'About to cancel' });
    stdin.write('y\n');
    await pending;
    expect(logText()).toContain('About to cancel');
  });

  it('TTY: throws AbortedError (code 5) on decline', async () => {
    const { stdin } = makeStreams(true);
    const pending = confirmWrite({}, { task: 12 });
    stdin.write('n\n');
    await expect(pending).rejects.toMatchObject({
      name: 'AbortedError',
      code: EXIT.ABORTED,
      message: 'aborted by user',
    });
  });

  it('TTY: empty answer defaults to No and aborts', async () => {
    const { stdin } = makeStreams(true);
    const pending = confirmWrite({}, { task: 12 });
    stdin.write('\n');
    await expect(pending).rejects.toMatchObject({ name: 'AbortedError' });
  });

  it('non-TTY: resolves for non-destructive writes (agent behavior)', async () => {
    makeStreams(false);
    await expect(confirmWrite({}, { task: 12 })).resolves.toBeUndefined();
  });

  it('non-TTY: throws AbortedError for destructive writes without --yes', async () => {
    makeStreams(false);
    await expect(
      confirmWrite({}, { task: 12 }, { destructive: true })
    ).rejects.toMatchObject({
      name: 'AbortedError',
      code: EXIT.ABORTED,
      message: 'This is a destructive action. Pass --yes to run non-interactively.',
    });
  });
});

describe('promptMissing', () => {
  it('TTY: fills a missing input value', async () => {
    const { stdin } = makeStreams(true);
    const argv = { name: undefined as string | undefined, payout: 5 };
    const pending = promptMissing(argv, [
      { key: 'name', question: 'Task name?', kind: 'input' },
    ]);
    stdin.write('fix the docs\n');
    const result = await pending;
    expect(result.name).toBe('fix the docs');
    expect(result.payout).toBe(5);
  });

  it('TTY: treats empty string as missing', async () => {
    const { stdin } = makeStreams(true);
    const argv = { name: '' };
    const pending = promptMissing(argv, [
      { key: 'name', question: 'Task name?', kind: 'input' },
    ]);
    stdin.write('renamed\n');
    await expect(pending).resolves.toMatchObject({ name: 'renamed' });
  });

  it('TTY: fills a select value from choices', async () => {
    const { stdin } = makeStreams(true);
    const argv: Record<string, any> = { difficulty: undefined };
    const pending = promptMissing(argv, [
      {
        key: 'difficulty',
        question: 'Difficulty?',
        kind: 'select',
        choices: [
          { label: 'Easy', value: 'easy' },
          { label: 'Hard', value: 'hard' },
        ],
      },
    ]);
    stdin.write('2\n');
    await expect(pending).resolves.toMatchObject({ difficulty: 'hard' });
  });

  it('TTY: coerces number kind and re-asks on garbage', async () => {
    const { stdin, getOutput } = makeStreams(true);
    const argv: Record<string, any> = { payout: undefined };
    const pending = promptMissing(argv, [
      { key: 'payout', question: 'Payout?', kind: 'number' },
    ]);
    stdin.write('lots\n12.5\n');
    const result = await pending;
    expect(result.payout).toBe(12.5);
    expect(getOutput()).toContain('Please enter a number.');
  });

  it('TTY: respects a custom validate on input kind', async () => {
    const { stdin, getOutput } = makeStreams(true);
    const argv: Record<string, any> = { name: undefined };
    const pending = promptMissing(argv, [
      {
        key: 'name',
        question: 'Name?',
        kind: 'input',
        validate: s => (s.length >= 3 ? true : 'too short'),
      },
    ]);
    stdin.write('ab\nabc\n');
    await expect(pending).resolves.toMatchObject({ name: 'abc' });
    expect(getOutput()).toContain('too short');
  });

  it('does not prompt when every key is present', async () => {
    makeStreams(false); // would throw if it tried to prompt
    const argv = { name: 'already set', payout: 0 };
    await expect(
      promptMissing(argv, [
        { key: 'name', question: 'Name?', kind: 'input' },
        { key: 'payout', question: 'Payout?', kind: 'number' },
      ])
    ).resolves.toBe(argv);
  });

  it('non-TTY: throws CliError with EXIT.USAGE naming the first missing key', async () => {
    makeStreams(false);
    await expect(
      promptMissing({ name: undefined }, [
        { key: 'name', question: 'Name?', kind: 'input' },
      ])
    ).rejects.toMatchObject({
      name: 'CliError',
      code: EXIT.USAGE,
      message: 'Missing required argument: --name',
    });
  });
});

describe('finishWrite', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  it('dry-run: prints DRY RUN line with method/to/gasEstimate, no lag warning, no onSuccess', () => {
    const onSuccess = vi.fn();
    finishWrite(
      {
        success: true,
        dryRun: true,
        method: 'createTask',
        to: '0xTaskManager',
        gasEstimate: '21000',
        calldata: '0xdeadbeef',
        txHash: undefined,
      },
      { successMsg: 'Task created', onSuccess }
    );
    const out = logText();
    expect(out).toContain('DRY RUN — transaction not sent');
    expect(out).toContain('createTask');
    expect(out).toContain('0xTaskManager');
    expect(out).toContain('21000');
    expect(out).not.toContain('subgraph');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('success: prints fields + txHash/explorerUrl, calls onSuccess, warns about subgraph lag', () => {
    const onSuccess = vi.fn();
    finishWrite(
      {
        success: true,
        txHash: '0xhash123',
        explorerUrl: 'https://gnosisscan.io/tx/0xhash123',
        blockNumber: 42,
      },
      { successMsg: 'Task created', fields: { taskId: '7' }, onSuccess }
    );
    const out = logText();
    expect(out).toContain('Task created');
    expect(out).toContain('taskId:');
    expect(out).toContain('0xhash123');
    expect(out).toContain('https://gnosisscan.io/tx/0xhash123');
    expect(out).toContain('subgraph');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('success in JSON mode: emits a single machine-readable payload', () => {
    setJsonMode(true);
    finishWrite(
      { success: true, txHash: '0xhash123', explorerUrl: 'https://x/tx/0xhash123' },
      { successMsg: 'Task created', fields: { taskId: '7' } }
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logText());
    expect(payload).toEqual({
      status: 'ok',
      message: 'Task created',
      taskId: '7',
      txHash: '0xhash123',
      explorerUrl: 'https://x/tx/0xhash123',
    });
  });

  it('failure: prints decoded error details and exits EXIT.TX_FAILED', () => {
    finishWrite(
      {
        success: false,
        error: 'Task is not in the required status',
        errorCode: 'TX_REVERTED',
        errorName: 'BadStatus',
        suggestion: 'inspect the task with pop task view',
      },
      { successMsg: 'Task created' }
    );
    const err = errText();
    expect(err).toContain('Task is not in the required status');
    expect(err).toContain('BadStatus');
    expect(err).toContain('inspect the task with pop task view');
    expect(exitSpy).toHaveBeenCalledWith(EXIT.TX_FAILED);
  });

  it('failure in JSON mode: emits code/errorName/suggestion', () => {
    setJsonMode(true);
    finishWrite(
      { success: false, error: 'nope', errorCode: 'TX_REVERTED', errorName: 'NotMember', suggestion: 'join first' },
      { successMsg: 'unused' }
    );
    const payload = JSON.parse(errText());
    expect(payload).toEqual({
      status: 'error',
      message: 'nope',
      code: 'TX_REVERTED',
      errorName: 'NotMember',
      suggestion: 'join first',
    });
    expect(exitSpy).toHaveBeenCalledWith(EXIT.TX_FAILED);
  });
});

describe('withIdempotency', () => {
  const TMP_HOME = path.join(os.tmpdir(), `pop-agent-command-test-${Date.now()}`);

  beforeEach(() => {
    process.env.POP_AGENT_HOME = TMP_HOME;
    fs.mkdirSync(TMP_HOME, { recursive: true });
    _clearIdempotencyCacheForTest();
  });

  afterEach(() => {
    delete process.env.POP_AGENT_HOME;
    try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('runs once, then serves the cached result on retry without re-running', async () => {
    const run = vi.fn().mockResolvedValue({ taskId: '9', txHash: '0xabc' });
    const argv = { name: 'same task', payout: 5 };

    await withIdempotency(argv, '0xorg', 'task.create', run);
    expect(run).toHaveBeenCalledTimes(1);

    await withIdempotency(argv, '0xorg', 'task.create', run);
    expect(run).toHaveBeenCalledTimes(1); // cache hit — not re-run
    const out = logText();
    expect(out).toContain('idempotency cache hit');
    expect(out).toContain('0xabc');
  });

  it('honors --no-idempotency by always running', async () => {
    const run = vi.fn().mockResolvedValue({ txHash: '0x1' });
    const argv = { name: 'same task', noIdempotency: true };

    await withIdempotency(argv, '0xorg', 'task.create', run);
    await withIdempotency(argv, '0xorg', 'task.create', run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('uses the explicit --idempotency-key over the argv hash', async () => {
    const run = vi.fn().mockResolvedValue({ txHash: '0x2' });

    await withIdempotency({ name: 'a', idempotencyKey: 'shared' }, '0xorg', 'task.create', run);
    await withIdempotency({ name: 'totally different', idempotencyKey: 'shared' }, '0xorg', 'task.create', run);
    expect(run).toHaveBeenCalledTimes(1); // same explicit key → cache hit
  });

  it('does not record the result when run() throws', async () => {
    const run = vi.fn().mockRejectedValue(new Error('tx failed'));
    const argv = { name: 'failing task' };

    await expect(withIdempotency(argv, '0xorg', 'task.create', run)).rejects.toThrow('tx failed');

    run.mockResolvedValue({ txHash: '0x3' });
    await withIdempotency(argv, '0xorg', 'task.create', run);
    expect(run).toHaveBeenCalledTimes(2); // failure was not cached
  });

  it('honors argv idempotency-ttl (seconds) when recording', async () => {
    const run = vi.fn().mockResolvedValue({ txHash: '0x4' });
    await withIdempotency({ name: 'ttl task', idempotencyTtl: 3600 }, '0xorg', 'task.create', run);

    const cachePath = path.join(TMP_HOME, 'idempotency-cache.json');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const entries = Object.values(cache.entries) as any[];
    expect(entries).toHaveLength(1);
    expect(entries[0].ttlSeconds).toBe(3600);
  });
});
