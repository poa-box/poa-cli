/**
 * Agent-surface visibility — src/index.ts loadAgentPlugin() + agentDesc().
 *
 * `pop agent` / `pop brain` live in @poa-box/agent and are HIDDEN from the human
 * `pop --help` (yargs description `false`): visible only when POP_AGENT_MODE=1,
 * which the `pop-agent` bin sets before delegating to @poa-box/cli.
 *
 * These tests spawn the BUILT artifacts (dist/index.js and
 * packages/agent/dist/pop-agent.js) with `--help` ONLY. `--help` short-circuits
 * yargs before any handler runs — nothing here touches the network, signs, or
 * broadcasts, and it must stay that way: never add an invocation of an actual
 * command to this file (several write commands broadcast to mainnet with no
 * confirmation prompt).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const AGENT_BIN = path.join(ROOT, 'packages', 'agent', 'dist', 'pop-agent.js');

/** Spawn `node <script> --help`; POP_AGENT_MODE comes only from `env`. */
function runHelp(script: string, env: Record<string, string> = {}) {
  const cleanEnv: Record<string, string | undefined> = { ...process.env, ...env };
  if (!('POP_AGENT_MODE' in env)) delete cleanEnv.POP_AGENT_MODE;
  const res = spawnSync(process.execPath, [script, '--help'], {
    cwd: ROOT,
    env: cleanEnv as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { ...res, combined: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

describe('agent surface visibility (--help only — never runs a real command)', () => {
  it('pop --help hides the agent and brain groups from humans', () => {
    const res = runHelp(CLI);

    expect(res.status).toBe(0);
    // Sanity: this really is the full help screen, not an error dump
    expect(res.combined).toContain('pop task <action>');
    expect(res.combined).toContain('pop config <action>');
    // The hidden groups: registered (they still execute when invoked
    // explicitly) but NOT listed
    expect(res.combined).not.toContain('agent <action>');
    expect(res.combined).not.toContain('brain <action>');
  }, 60_000);

  it('POP_AGENT_MODE=1 reveals both groups in pop --help', () => {
    const res = runHelp(CLI, { POP_AGENT_MODE: '1' });

    expect(res.status).toBe(0);
    expect(res.combined).toContain('pop agent <action>');
    expect(res.combined).toContain('pop brain <action>');
    // The human surface is still all there alongside them
    expect(res.combined).toContain('pop task <action>');
  }, 60_000);

  it('the pop-agent bin lists both groups without the caller setting POP_AGENT_MODE', () => {
    // POP_AGENT_MODE is stripped from the env: the bin must set it itself.
    const res = runHelp(AGENT_BIN);

    expect(res.status).toBe(0);
    expect(res.combined).toContain('pop agent <action>');
    expect(res.combined).toContain('pop brain <action>');
  }, 60_000);
});
