import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setJsonMode,
  setQuietMode,
  isQuietMode,
  setVerbose,
  isVerbose,
  debug,
  success,
  error,
  info,
  warn,
  spinner,
  keyValueBlock,
  subgraphLagWarning,
} from '../../src/lib/output';

const ANSI_RE = /\u001b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function logLines(): string[] {
  return logSpy.mock.calls.map(call => stripAnsi(call.map(String).join(' ')));
}

function errLines(): string[] {
  return errSpy.mock.calls.map(call => stripAnsi(call.map(String).join(' ')));
}

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setJsonMode(false);
  setQuietMode(false);
  setVerbose(false);
  vi.restoreAllMocks();
});

describe('quiet mode', () => {
  it('setQuietMode/isQuietMode round-trips', () => {
    expect(isQuietMode()).toBe(false);
    setQuietMode(true);
    expect(isQuietMode()).toBe(true);
  });

  it('suppresses info() and warn()', () => {
    setQuietMode(true);
    info('an info line');
    warn('a warn line');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does not suppress error()', () => {
    setQuietMode(true);
    error('boom', { suggestion: 'try again' });
    const lines = errLines();
    expect(lines[0]).toContain('boom');
    expect(lines.join('\n')).toContain('Suggestion: try again');
  });

  it('success() prints only its one line, without data fields', () => {
    setQuietMode(true);
    success('Task created', { taskId: '7', txHash: '0xabc' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logLines()[0];
    expect(line).toContain('Task created');
    expect(line).not.toContain('taskId');
    expect(line).not.toContain('0xabc');
  });

  it('success() still prints data fields when not quiet', () => {
    success('Task created', { taskId: '7' });
    const all = logLines().join('\n');
    expect(all).toContain('Task created');
    expect(all).toContain('taskId:');
    expect(all).toContain('7');
  });

  it('spinner() returns a no-op shim that never writes', () => {
    setQuietMode(true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const spin = spinner('Working...');
    expect(spin.text).toBe('Working...');
    spin.text = 'Still working...'; // .text setter must be usable
    expect(spin.start()).toBe(spin); // chainable
    spin.stop();
    spin.succeed();
    spin.fail();
    spin.warn();
    spin.info();
    spin.clear();
    spin.render();
    expect(spin.isSpinning).toBe(false);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does NOT affect JSON mode output', () => {
    setJsonMode(true);
    setQuietMode(true);
    success('Task created', { taskId: '7' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logLines()[0]);
    expect(payload).toEqual({ status: 'ok', message: 'Task created', taskId: '7' });
  });

  it('does not suppress subgraphLagWarning (only info/warn/spinner/success fields)', () => {
    setQuietMode(true);
    subgraphLagWarning();
    expect(logLines().join('\n')).toContain('subgraph');
  });
});

describe('debug', () => {
  it('is silent when verbose is off', () => {
    debug('hidden');
    expect(errSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('prints a dim [debug] line to stderr when verbose', () => {
    setVerbose(true);
    expect(isVerbose()).toBe(true);
    debug('resolving org');
    expect(logSpy).not.toHaveBeenCalled();
    expect(errLines()[0]).toBe('[debug] resolving org');
  });

  it('is silent in JSON mode even when verbose', () => {
    setVerbose(true);
    setJsonMode(true);
    debug('hidden');
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe('keyValueBlock', () => {
  it('prints the title and aligned key-value lines', () => {
    keyValueBlock('About to send', { task: 12, payout: '5 PT' });
    const lines = logLines();
    expect(lines[0]).toBe('About to send');
    expect(lines[1]).toContain('task:');
    expect(lines[2]).toContain('payout:');
    // Values start at the same column (keys padded to the longest key)
    expect(lines[1].indexOf('12')).toBe(lines[2].indexOf('5 PT'));
  });

  it('skips undefined values', () => {
    keyValueBlock(null, { a: '1', missing: undefined, b: '2' });
    const all = logLines().join('\n');
    expect(all).toContain('a:');
    expect(all).toContain('b:');
    expect(all).not.toContain('missing');
    expect(logSpy).toHaveBeenCalledTimes(2); // no title line, no undefined line
  });

  it('omits the title line when title is null', () => {
    keyValueBlock(null, { key: 'value' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logLines()[0]).toContain('key:');
  });

  it('prints only the title when all fields are undefined', () => {
    keyValueBlock('Empty', { a: undefined });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logLines()[0]).toBe('Empty');
  });

  it('is a no-op in JSON mode', () => {
    setJsonMode(true);
    keyValueBlock('Title', { a: '1' });
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('error() detail keys (additive)', () => {
  it('accepts code/errorName in JSON mode', () => {
    setJsonMode(true);
    error('Reverted: BadStatus', { code: 'TX_REVERTED', errorName: 'BadStatus', suggestion: 'check status' });
    const payload = JSON.parse(errLines()[0]);
    expect(payload).toEqual({
      status: 'error',
      message: 'Reverted: BadStatus',
      code: 'TX_REVERTED',
      errorName: 'BadStatus',
      suggestion: 'check status',
    });
  });

  it('keeps legacy errorCode/error/suggestion behavior byte-compatible', () => {
    setJsonMode(true);
    error('Task creation failed', { error: 'boom', errorCode: 'TX_REVERTED', suggestion: 'retry' });
    const payload = JSON.parse(errLines()[0]);
    expect(payload).toEqual({
      status: 'error',
      message: 'Task creation failed',
      code: 'TX_REVERTED',
      detail: 'boom',
      suggestion: 'retry',
    });
  });

  it('prints errorName as a dim line in human mode', () => {
    error('Reverted', { errorName: 'NotMember' });
    expect(errLines().join('\n')).toContain('Error: NotMember');
  });
});
