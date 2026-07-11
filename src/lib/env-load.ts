/**
 * Environment File Loading
 * Loads .env files in precedence order. dotenv never overrides variables
 * that are already set, so EARLIER files win:
 *
 *   1. ./.env            (cwd — project-local config wins)
 *   2. ~/.pop/.env       (per-user CLI config)
 *   3. ~/.pop-agent/.env (agent runtime config)
 *
 * This deliberately reverses the pre-Phase-1 behavior where ~/.pop-agent/.env
 * beat the cwd .env: a human running the CLI inside a project directory now
 * gets that project's config, while agents (which run outside project dirs
 * and set HOME to their own agent home) still resolve ~/.pop-agent/.env.
 */

import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

let loadedFiles: string[] = [];

/**
 * Load every existing env file in precedence order (see module header).
 * Returns the absolute paths that were loaded, first = highest precedence.
 */
export function loadEnvFiles(): { loaded: string[] } {
  const candidates = [
    resolve(process.cwd(), '.env'),
    join(homedir(), '.pop', '.env'),
    join(homedir(), '.pop-agent', '.env'),
  ];

  const loaded: string[] = [];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    dotenvConfig({ path }); // does not override already-set vars — earlier files win
    loaded.push(path);
  }

  loadedFiles = loaded;
  return { loaded };
}

/** Paths loaded by the last loadEnvFiles() call (for diagnostics, e.g. pop config show). */
export function getLoadedEnvFiles(): string[] {
  return [...loadedFiles];
}
