/**
 * Dual-mode Output
 * Human-readable (tables, colors, spinners) vs --json (structured stdout).
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import ora, { Ora } from 'ora';

let jsonMode = false;
let quietMode = false;
let verboseMode = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/**
 * Quiet mode (--quiet/-q) suppresses non-essential human output: info(),
 * warn(), spinners, and the data fields under success(). Errors and the
 * one-line success message always print. JSON mode output is NEVER
 * affected by quiet — machine consumers get the full payload.
 */
export function setQuietMode(enabled: boolean): void {
  quietMode = enabled;
}

export function isQuietMode(): boolean {
  return quietMode;
}

/** Verbose mode (--verbose/-v) enables debug() lines on stderr. */
export function setVerbose(enabled: boolean): void {
  verboseMode = enabled;
}

export function isVerbose(): boolean {
  return verboseMode;
}

/** Dim '[debug] …' line to stderr; only when verbose and not in JSON mode. */
export function debug(message: string): void {
  if (!verboseMode || jsonMode) return;
  console.error(chalk.dim('[debug] ' + message));
}

export function success(message: string, data?: any): void {
  if (jsonMode) {
    console.log(JSON.stringify({ status: 'ok', message, ...data }));
  } else {
    console.log(chalk.green('✓') + ' ' + message);
    if (data && !quietMode) {
      for (const [key, value] of Object.entries(data)) {
        if (value === undefined || value === null) continue;
        // Render explorer links as clickable
        if (key === 'explorerUrl') {
          console.log(`  ${chalk.dim('view:')} ${chalk.underline(String(value))}`);
        } else {
          console.log(`  ${chalk.dim(key + ':')} ${value}`);
        }
      }
    }
  }
}

export function error(message: string, details?: any): void {
  if (jsonMode) {
    const payload: any = { status: 'error', message };
    const code = details?.code ?? details?.errorCode;
    if (code) payload.code = code;
    if (details?.errorName) payload.errorName = details.errorName;
    if (details?.error) payload.detail = details.error;
    if (details?.suggestion) payload.suggestion = details.suggestion;
    console.error(JSON.stringify(payload));
  } else {
    console.error(chalk.red('✗') + ' ' + message);
    if (details?.errorName) {
      console.error(chalk.dim('  Error: ' + details.errorName));
    }
    if (details?.suggestion) {
      console.error(chalk.dim('  Suggestion: ' + details.suggestion));
    }
  }
}

export function info(message: string): void {
  if (jsonMode || quietMode) return; // suppressed in json + quiet modes
  console.log(chalk.blue('ℹ') + ' ' + message);
}

export function warn(message: string): void {
  if (jsonMode || quietMode) return;
  console.log(chalk.yellow('⚠') + ' ' + message);
}

/** Remind user that subgraph data lags behind on-chain state after writes */
export function subgraphLagWarning(): void {
  if (jsonMode) return;
  console.log(chalk.dim('  Note: subgraph may take a few seconds to index this transaction'));
}

export function table(headers: string[], rows: string[][]): void {
  if (jsonMode) {
    const objects = rows.map(row => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
    console.log(JSON.stringify(objects));
    return;
  }

  const t = new Table({
    head: headers.map(h => chalk.cyan(h)),
    style: { head: [], border: [] },
  });

  for (const row of rows) {
    t.push(row);
  }

  console.log(t.toString());
}

export function json(data: any): void {
  console.log(JSON.stringify(data, null, jsonMode ? undefined : 2));
}

export function spinner(message: string): Ora {
  if (jsonMode || quietMode) {
    // Return a chainable no-op spinner in JSON/quiet modes
    const noOp: any = { text: message };
    noOp.start = () => noOp;
    noOp.stop = () => noOp;
    noOp.succeed = () => noOp;
    noOp.fail = () => noOp;
    noOp.warn = () => noOp;
    noOp.info = () => noOp;
    noOp.clear = () => noOp;
    noOp.render = () => noOp;
    noOp.isSpinning = false;
    return noOp as Ora;
  }
  return ora(message);
}

/**
 * Print an aligned "Key:  value" block, e.g. a pre-send transaction summary.
 * Keys are padded to the longest key so values line up; undefined values are
 * skipped. No-op in JSON mode (callers emit structured payloads separately).
 */
export function keyValueBlock(title: string | null, fields: Record<string, string | number | undefined>): void {
  if (jsonMode) return;
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (title) console.log(chalk.bold(title));
  if (entries.length === 0) return;
  const width = Math.max(...entries.map(([key]) => key.length)) + 1; // +1 for ':'
  for (const [key, value] of entries) {
    console.log(`  ${chalk.dim((key + ':').padEnd(width))}  ${value}`);
  }
}
