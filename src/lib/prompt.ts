/**
 * Interactive Prompts
 * Hand-rolled on node:readline — no external prompt dependency.
 * Callers should check isInteractive() before calling confirm/input/select;
 * calling them without a TTY throws a CliError.
 */

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import chalk from 'chalk';
import { CliError } from './errors';
import { isJsonMode } from './output';

let testStdin: NodeJS.ReadableStream | undefined;
let testStdout: NodeJS.WritableStream | undefined;
let testForceTTY: boolean | undefined;

/** Test hook: inject streams and TTY-ness. Call with no args to reset. */
export function _setStreamsForTest(
  stdin?: NodeJS.ReadableStream,
  stdout?: NodeJS.WritableStream,
  forceTTY?: boolean
): void {
  testStdin = stdin;
  testStdout = stdout;
  testForceTTY = forceTTY;
}

function getStdin(): NodeJS.ReadableStream {
  return testStdin ?? process.stdin;
}

function getStdout(): NodeJS.WritableStream {
  return testStdout ?? process.stdout;
}

function isTty(): boolean {
  if (testForceTTY !== undefined) return testForceTTY;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** True iff we can safely prompt: real TTY, not CI, not --json mode. */
export function isInteractive(): boolean {
  return isTty() && !process.env.CI && !isJsonMode();
}

function requireTty(): void {
  if (!isTty()) {
    throw new CliError('interactive prompt required but stdin is not a TTY', 1);
  }
}

/**
 * Wrap a readline interface with a line buffer so answers typed (or piped)
 * ahead of the prompt are not dropped between consecutive questions.
 */
function makeReader(output: NodeJS.WritableStream, terminal?: boolean) {
  const rl = createInterface({ input: getStdin(), output, terminal });
  const buffered: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  rl.on('line', line => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else buffered.push(line);
  });
  return {
    question(prompt: string): Promise<string> {
      rl.setPrompt(prompt);
      rl.prompt();
      const line = buffered.shift();
      if (line !== undefined) return Promise.resolve(line);
      return new Promise(resolve => waiters.push(resolve));
    },
    close(): void {
      rl.close();
    },
  };
}

/**
 * Yes/no confirmation. Empty answer takes the default (No unless
 * defaultNo: false). Re-asks on unrecognized input, max 3 attempts
 * then returns the default.
 */
export async function confirm(question: string, opts: { defaultNo?: boolean } = {}): Promise<boolean> {
  requireTty();
  const defaultNo = opts.defaultNo !== false;
  const suffix = defaultNo ? '[y/N]' : '[Y/n]';
  const out = getStdout();
  const reader = makeReader(out);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = (await reader.question(`${question} ${suffix} `)).trim().toLowerCase();
      if (answer === '') return !defaultNo;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      out.write("Please answer 'y' or 'n'.\n");
    }
    return !defaultNo;
  } finally {
    reader.close();
  }
}

/**
 * Free-text input. validate returns true or an error message (which is
 * displayed before re-asking). secret: true suppresses echo via a muted
 * output stream (the standard readline trick).
 */
export async function input(
  question: string,
  opts: { validate?: (s: string) => string | true; default?: string; secret?: boolean } = {}
): Promise<string> {
  requireTty();
  const out = getStdout();
  const mute = { active: false };
  const output = opts.secret
    ? new Writable({
        write(chunk, _encoding, callback) {
          if (!mute.active) out.write(chunk);
          callback();
        },
      })
    : out;
  const reader = makeReader(output, opts.secret ? true : undefined);
  try {
    for (;;) {
      const prompt = opts.default !== undefined && !opts.secret
        ? `${question} (${opts.default}) `
        : `${question} `;
      let answer: string;
      if (opts.secret) {
        const pending = reader.question(prompt); // prompt is written synchronously, before muting
        mute.active = true;
        answer = await pending;
        mute.active = false;
        out.write('\n');
      } else {
        answer = await reader.question(prompt);
      }
      if (answer === '' && opts.default !== undefined) answer = opts.default;
      if (opts.validate) {
        const result = opts.validate(answer);
        if (result !== true) {
          out.write(chalk.red(result) + '\n');
          continue;
        }
      }
      return answer;
    }
  } finally {
    reader.close();
  }
}

/** Numbered-list selection; re-asks until a valid number is entered. */
export async function select<T>(
  question: string,
  choices: Array<{ label: string; value: T; hint?: string }>
): Promise<T> {
  requireTty();
  const out = getStdout();
  const reader = makeReader(out);
  try {
    out.write(question + '\n');
    choices.forEach((choice, i) => {
      const hint = choice.hint ? chalk.dim(` — ${choice.hint}`) : '';
      out.write(`  ${i + 1}) ${choice.label}${hint}\n`);
    });
    for (;;) {
      const answer = (await reader.question(`Enter a number (1-${choices.length}): `)).trim();
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
        return choices[n - 1].value;
      }
      out.write(`Please enter a number between 1 and ${choices.length}.\n`);
    }
  } finally {
    reader.close();
  }
}
