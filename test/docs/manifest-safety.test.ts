/**
 * The safety map (scripts/lib/safety-map.ts) is CURATED — this suite is what
 * keeps it honest. It independently derives capability from the source:
 *
 *   broadcast  = the command's file uses executeTx / createWriteContract /
 *                sendSponsored
 *   pin        = the file registers --pin or calls pinJson/pinFile
 *   destructive= the file passes destructive: true to confirmWrite
 *
 * and fails on ANY mismatch with the map, in both directions. A new write
 * command that forgets to register itself fails here — it cannot silently
 * ship as "readOnly" in the manifest that integrators (and pop mcp) trust.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildCliTree, buildTopLevelCommands } from '../../scripts/lib/cli-tree';
import { WRITE_COMMANDS, SIDE_EFFECT_READS, safetyFor } from '../../scripts/lib/safety-map';

const ROOT = path.resolve(__dirname, '..', '..');
const CMD_DIR = path.join(ROOT, 'src', 'commands');

const BROADCAST_TOKENS = /executeTx|createWriteContract|sendSponsored/;
const PIN_TOKENS = /option\('pin'|pinJson|pinFile/;
const DESTRUCTIVE_TOKEN = /destructive:\s*true/;

interface Leaf { name: string; domain: string; tokens: string[] }

function collectLeaves(): Leaf[] {
  const leaves: Leaf[] = [];
  const walk = (domain: string, cmd: any) => {
    const name = String(cmd.fullName).replace(/^pop /, '');
    if (cmd.subcommands?.length) {
      for (const sub of cmd.subcommands) walk(domain, sub);
    } else {
      leaves.push({ name, domain, tokens: name.split(' ') });
    }
  };
  for (const d of buildCliTree()) for (const c of d.commands) walk(d.domain, c);
  for (const t of buildTopLevelCommands()) leaves.push({ name: t.name, domain: '', tokens: [t.name] });
  return leaves;
}

/** Conventional source file for a command, honoring explicit overrides. */
function fileFor(name: string): string | null {
  const override = safetyFor(name)?.file;
  if (override) return path.join(ROOT, override);
  const tokens = name.split(' ');
  if (tokens.length === 1) {
    const p = path.join(CMD_DIR, `${tokens[0]}.ts`);
    return fs.existsSync(p) ? p : null;
  }
  // depth 2: src/commands/<domain>/<action>.ts; depth 3 must use an override
  if (tokens.length === 2) {
    const p = path.join(CMD_DIR, tokens[0], `${tokens[1]}.ts`);
    return fs.existsSync(p) ? p : null;
  }
  const parent = path.join(CMD_DIR, tokens[0], `${tokens[1]}.ts`);
  return fs.existsSync(parent) ? parent : null;
}

const leaves = collectLeaves();
const leafNames = new Set(leaves.map((l) => l.name));
const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('safety map ↔ source drift', () => {
  it('every mapped command exists in the CLI tree (no ghosts)', () => {
    const ghosts = [...Object.keys(WRITE_COMMANDS), ...Object.keys(SIDE_EFFECT_READS)]
      .filter((name) => !leafNames.has(name));
    expect(ghosts, `safety-map entries with no matching command: ${ghosts.join(', ')}`).toEqual([]);
  });

  it('every command marked broadcasts maps to a file that CAN broadcast', () => {
    const wrong: string[] = [];
    for (const name of Object.keys(WRITE_COMMANDS)) {
      const file = fileFor(name);
      if (!file) { wrong.push(`${name} (no source file resolved)`); continue; }
      if (!BROADCAST_TOKENS.test(read(file))) wrong.push(`${name} (${path.relative(ROOT, file)} has no broadcast call)`);
    }
    expect(wrong, wrong.join('; ')).toEqual([]);
  });

  it('every file that CAN broadcast is covered by at least one broadcasts entry', () => {
    const covered = new Set(
      Object.keys(WRITE_COMMANDS).map((name) => fileFor(name)).filter(Boolean) as string[]
    );
    const uncovered: string[] = [];
    for (const domain of fs.readdirSync(CMD_DIR)) {
      const dir = path.join(CMD_DIR, domain);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.ts')) continue;
        const file = path.join(dir, entry);
        if (BROADCAST_TOKENS.test(read(file)) && !covered.has(file)) {
          uncovered.push(path.relative(ROOT, file));
        }
      }
    }
    expect(
      uncovered,
      `files with broadcast capability but NO safety-map entry (a new write command shipped unmapped?): ${uncovered.join(', ')}`
    ).toEqual([]);
  });

  it('unmapped commands (defaulting to readOnly) resolve to files that cannot broadcast', () => {
    const writeFiles = new Set(
      Object.keys(WRITE_COMMANDS).map((name) => fileFor(name)).filter(Boolean) as string[]
    );
    const wrong: string[] = [];
    for (const leaf of leaves) {
      if (safetyFor(leaf.name)) continue; // explicitly classified
      const file = fileFor(leaf.name);
      if (!file || writeFiles.has(file)) continue; // shared read+write file — covered above
      if (BROADCAST_TOKENS.test(read(file))) {
        wrong.push(`${leaf.name} (${path.relative(ROOT, file)})`);
      }
    }
    expect(wrong, `commands defaulting to readOnly whose file can broadcast: ${wrong.join(', ')}`).toEqual([]);
  });

  it('every file that can pin maps to a command declaring an ipfs-pin side effect', () => {
    const pinDeclared = new Set(
      [...Object.entries(WRITE_COMMANDS), ...Object.entries(SIDE_EFFECT_READS)]
        .filter(([, s]) => (s.sideEffects ?? []).some((e) => e.startsWith('ipfs-pin')))
        .map(([name]) => fileFor(name))
        .filter(Boolean) as string[]
    );
    const missing: string[] = [];
    for (const domain of fs.readdirSync(CMD_DIR)) {
      const dir = path.join(CMD_DIR, domain);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.ts')) continue;
        const file = path.join(dir, entry);
        if (PIN_TOKENS.test(read(file)) && !pinDeclared.has(file)) {
          missing.push(path.relative(ROOT, file));
        }
      }
    }
    expect(
      missing,
      `files that can pin with no ipfs-pin side effect declared: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('destructive parity with confirmWrite call sites', () => {
    const destructiveDeclared = new Set(
      [...Object.entries(WRITE_COMMANDS), ...Object.entries(SIDE_EFFECT_READS)]
        .filter(([, s]) => s.destructive)
        .map(([name]) => fileFor(name))
        .filter(Boolean) as string[]
    );
    const missing: string[] = [];
    for (const domain of fs.readdirSync(CMD_DIR)) {
      const dir = path.join(CMD_DIR, domain);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.ts')) continue;
        const file = path.join(dir, entry);
        if (DESTRUCTIVE_TOKEN.test(read(file)) && !destructiveDeclared.has(file)) {
          missing.push(path.relative(ROOT, file));
        }
      }
    }
    expect(missing, `destructive:true call sites with no destructive map entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('the generated manifest agrees with the map (spot: the famous traps)', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src', 'generated', 'cli-manifest.json'), 'utf8')
    );
    const byName = new Map<string, any>(manifest.commands.map((c: any) => [c.name, c]));
    expect(byName.get('vote announce-all')?.broadcasts, 'announce-all reads like inspection but broadcasts').toBe(true);
    expect(byName.get('vote execute')?.destructive).toBe(true);
    expect(byName.get('org leaderboard')?.readOnly).toBe(true);
    expect(byName.get('org leaderboard')?.sideEffects).toContain('ipfs-pin(--pin)');
    expect(byName.get('org list')?.broadcasts).toBe(false);
  });
});
