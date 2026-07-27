import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { CliError } from '../../src/lib/errors';
import { setJsonMode } from '../../src/lib/output';
import {
  isInteractive,
  confirm,
  input,
  select,
  _setStreamsForTest,
} from '../../src/lib/prompt';

function makeStreams(forceTTY = true) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = '';
  stdout.on('data', chunk => { output += chunk.toString(); });
  _setStreamsForTest(stdin, stdout, forceTTY);
  return { stdin, stdout, getOutput: () => output };
}

const savedCi = process.env.CI;

beforeEach(() => {
  delete process.env.CI;
  setJsonMode(false);
});

afterEach(() => {
  _setStreamsForTest();
  if (savedCi === undefined) delete process.env.CI;
  else process.env.CI = savedCi;
  setJsonMode(false);
});

describe('isInteractive', () => {
  it('is true with forced TTY, no CI, no json mode', () => {
    makeStreams(true);
    expect(isInteractive()).toBe(true);
  });

  it('is false when TTY is forced off', () => {
    makeStreams(false);
    expect(isInteractive()).toBe(false);
  });

  it('is false when CI is set', () => {
    makeStreams(true);
    process.env.CI = 'true';
    expect(isInteractive()).toBe(false);
  });

  it('is false in json mode', () => {
    makeStreams(true);
    setJsonMode(true);
    expect(isInteractive()).toBe(false);
  });
});

describe('non-TTY guard', () => {
  it('confirm throws CliError with code 1', async () => {
    makeStreams(false);
    await expect(confirm('Proceed?')).rejects.toMatchObject({
      name: 'CliError',
      code: 1,
      message: 'interactive prompt required but stdin is not a TTY',
    });
  });

  it('input throws CliError', async () => {
    makeStreams(false);
    await expect(input('Name?')).rejects.toBeInstanceOf(CliError);
  });

  it('select throws CliError', async () => {
    makeStreams(false);
    await expect(select('Pick', [{ label: 'A', value: 'a' }])).rejects.toBeInstanceOf(CliError);
  });
});

describe('confirm', () => {
  it('accepts y', async () => {
    const { stdin } = makeStreams();
    const p = confirm('Proceed?');
    stdin.write('y\n');
    await expect(p).resolves.toBe(true);
  });

  it('accepts YES case-insensitively', async () => {
    const { stdin } = makeStreams();
    const p = confirm('Proceed?');
    stdin.write('YES\n');
    await expect(p).resolves.toBe(true);
  });

  it('accepts no', async () => {
    const { stdin } = makeStreams();
    const p = confirm('Proceed?');
    stdin.write('no\n');
    await expect(p).resolves.toBe(false);
  });

  it('empty answer takes default No', async () => {
    const { stdin, getOutput } = makeStreams();
    const p = confirm('Proceed?');
    stdin.write('\n');
    await expect(p).resolves.toBe(false);
    expect(getOutput()).toContain('[y/N]');
  });

  it('empty answer takes default Yes when defaultNo: false', async () => {
    const { stdin, getOutput } = makeStreams();
    const p = confirm('Proceed?', { defaultNo: false });
    stdin.write('\n');
    await expect(p).resolves.toBe(true);
    expect(getOutput()).toContain('[Y/n]');
  });

  it('re-asks on garbage then accepts a valid answer', async () => {
    const { stdin, getOutput } = makeStreams();
    const p = confirm('Proceed?');
    stdin.write('wat\nmaybe\ny\n');
    await expect(p).resolves.toBe(true);
    expect(getOutput()).toContain("Please answer 'y' or 'n'.");
  });

  it('returns the default after 3 garbage answers', async () => {
    const { stdin } = makeStreams();
    const p = confirm('Proceed?');
    stdin.write('a\nb\nc\n');
    await expect(p).resolves.toBe(false);
  });

  it('returns default Yes after 3 garbage answers with defaultNo: false', async () => {
    const { stdin } = makeStreams();
    const p = confirm('Proceed?', { defaultNo: false });
    stdin.write('a\nb\nc\n');
    await expect(p).resolves.toBe(true);
  });
});

describe('input', () => {
  it('returns the typed value', async () => {
    const { stdin } = makeStreams();
    const p = input('Name?');
    stdin.write('argus\n');
    await expect(p).resolves.toBe('argus');
  });

  it('empty answer takes the default', async () => {
    const { stdin, getOutput } = makeStreams();
    const p = input('Name?', { default: 'sentinel' });
    stdin.write('\n');
    await expect(p).resolves.toBe('sentinel');
    expect(getOutput()).toContain('(sentinel)');
  });

  it('re-asks until validate passes and shows the error message', async () => {
    const { stdin, getOutput } = makeStreams();
    const p = input('Name?', {
      validate: s => (s.length >= 3 ? true : 'too short'),
    });
    stdin.write('ab\nabc\n');
    await expect(p).resolves.toBe('abc');
    expect(getOutput()).toContain('too short');
  });

  it('validates the default value too', async () => {
    const { stdin } = makeStreams();
    const p = input('Name?', {
      default: 'ok!',
      validate: s => (s.includes('!') ? true : 'needs a bang'),
    });
    stdin.write('\n');
    await expect(p).resolves.toBe('ok!');
  });

  it('secret mode returns the typed value without echoing it', async () => {
    const { stdin, getOutput } = makeStreams();
    const p = input('Key?', { secret: true });
    stdin.write('hunter2\n');
    await expect(p).resolves.toBe('hunter2');
    expect(getOutput()).toContain('Key?');
    expect(getOutput()).not.toContain('hunter2');
  });
});

describe('select', () => {
  const choices = [
    { label: 'Alpha', value: 'a' },
    { label: 'Beta', value: 'b', hint: 'second one' },
    { label: 'Gamma', value: 'c' },
  ];

  it('returns the value for the chosen number', async () => {
    const { stdin, getOutput } = makeStreams();
    const p = select('Pick one', choices);
    stdin.write('2\n');
    await expect(p).resolves.toBe('b');
    const out = getOutput();
    expect(out).toContain('Pick one');
    expect(out).toContain('1) Alpha');
    expect(out).toContain('2) Beta');
  });

  it('re-asks on non-numeric and out-of-range answers', async () => {
    const { stdin, getOutput } = makeStreams();
    const p = select('Pick one', choices);
    stdin.write('junk\n9\n3\n');
    await expect(p).resolves.toBe('c');
    expect(getOutput()).toContain('Please enter a number between 1 and 3.');
  });

  it('supports non-string values', async () => {
    const { stdin } = makeStreams();
    const p = select('Pick', [
      { label: 'One', value: { id: 1 } },
      { label: 'Two', value: { id: 2 } },
    ]);
    stdin.write('1\n');
    await expect(p).resolves.toEqual({ id: 1 });
  });
});
