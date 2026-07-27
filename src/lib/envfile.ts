/**
 * .env File Read/Write Helpers
 * Pure fs helpers for creating and upserting KEY=value lines in dotenv-style
 * files. Used by `pop init` (and available to any command that needs to
 * persist config). Deliberately NOT a dotenv wrapper — env-load.ts owns
 * LOADING; this module owns WRITING.
 *
 * Format contract:
 *   - one `KEY=value` per line, values written verbatim (no quoting) so a
 *     round-trip through readEnvFile is byte-stable for simple values
 *   - files are chmod 0600 by default (they hold private keys); the parent
 *     directory is created if missing
 *   - updateEnvVar preserves every other line INCLUDING comments and blanks,
 *     touching only the target key (or appending it when absent)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { dirname } from 'path';

/** Default permission for env files — they routinely hold POP_PRIVATE_KEY. */
const DEFAULT_MODE = 0o600;

/**
 * Write `vars` as KEY=value lines to `filePath`, creating the parent directory
 * if needed and chmod-ing the file to `opts.mode` (default 0600). Overwrites
 * any existing file — callers that must not clobber should check existence
 * first (see `pop init`'s --force gate).
 */
export function writeEnvFile(
  filePath: string,
  vars: Record<string, string>,
  opts?: { mode?: number }
): void {
  const mode = opts?.mode ?? DEFAULT_MODE;
  const dir = dirname(filePath);
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const body = Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  // Trailing newline: POSIX text-file convention + keeps appends clean.
  writeFileSync(filePath, body + '\n', { mode });
  // writeFileSync's mode only applies on creation; chmod unconditionally so an
  // existing file with looser perms is tightened too.
  chmodSync(filePath, mode);
}

/**
 * Upsert a single `key=value` pair in `filePath`, preserving every other line
 * (comments and blanks included). Creates the file (chmod 0600) with just this
 * one line when it does not exist. Only the FIRST occurrence of the key is
 * rewritten; the value is written verbatim.
 */
export function updateEnvVar(filePath: string, key: string, value: string): void {
  const newLine = `${key}=${value}`;

  if (!existsSync(filePath)) {
    writeEnvFile(filePath, { [key]: value });
    return;
  }

  const raw = readFileSync(filePath, 'utf8');
  // Preserve the file's original trailing-newline shape: split on \n and, if
  // the file ended with a newline, the final split element is '' — we rebuild
  // with the same join so we don't gratuitously add/remove a blank line.
  const lines = raw.split('\n');
  const keyPrefix = `${key}=`;
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    // Match "KEY=" at the start of the line, ignoring leading whitespace but
    // NOT commented-out lines (a leading # means it's not the active setting).
    const line = lines[i];
    const trimmedStart = line.replace(/^\s+/, '');
    if (!trimmedStart.startsWith('#') && trimmedStart.startsWith(keyPrefix)) {
      lines[i] = newLine;
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    // Append after the last non-empty line so we don't leave a dangling blank
    // between existing content and the new key.
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines[lines.length - 1] = newLine;
      lines.push('');
    } else {
      lines.push(newLine);
    }
  }

  writeFileSync(filePath, lines.join('\n'));
}

/**
 * Parse `filePath` into a plain object of KEY→value. Blank lines and comment
 * lines (leading #) are skipped; the value is everything after the first `=`,
 * with a single layer of surrounding single/double quotes stripped so files
 * written by other tools still read cleanly. Returns {} when the file is
 * absent.
 */
export function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf8');
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === '') continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
