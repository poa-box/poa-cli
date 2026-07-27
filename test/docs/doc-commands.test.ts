/**
 * doc-commands — drift harness between documented CLI invocations and the
 * actual yargs command tree.
 *
 * Extracts fenced bash blocks from README.md + docs/**\/*.md, finds lines that
 * invoke `pop <domain> <action>` (or `node dist/index.js <domain> <action>`),
 * and asserts that:
 *   - the domain + action (+ nested subcommand) exist in buildCliTree()
 *   - every `--flag` token is a known flag for that command
 *     (command options ∪ inherited parent options ∪ GLOBAL_FLAGS)
 *
 * Fence opt-out: annotate the info string with `doc-test=skip`
 * (e.g. ```bash doc-test=skip) for aspirational/pseudocode blocks.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildCliTree, buildTopLevelCommands, GLOBAL_FLAGS, CliCommand } from '../../scripts/lib/cli-tree';

const ROOT = path.resolve(__dirname, '..', '..');

// TODO(D4/D5): these legacy guides predate the current CLI surface and are
// scheduled for a rewrite — until then their violations are console.warn'd
// instead of failing the suite. The D4/D5 rewrite flips them to enforced by
// deleting entries from this set.
const WARN_ONLY = new Set<string>([
  // agent-ops docs document sprint-3-only commands (agent apply/story); enforced
  // once that branch merges. Human-facing docs are all enforced.
  'docs/agents/brain-layer-setup.md',
]);

const BASH_INFO = /^(bash|sh|shell|zsh|console)\b/;

interface DocCommandLine {
  file: string;
  line: number;
  raw: string;
  tokens: string[];
}

interface Violation {
  file: string;
  line: number;
  message: string;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function listDocFiles(): string[] {
  const files = [path.join(ROOT, 'README.md')];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
    }
  };
  walk(path.join(ROOT, 'docs'));
  return files;
}

/** Fenced blocks whose info string is bash-ish and not marked doc-test=skip. */
function extractBashBlocks(content: string): Array<{ startLine: number; lines: string[] }> {
  const blocks: Array<{ startLine: number; lines: string[] }> = [];
  const lines = content.split('\n');
  let current: { startLine: number; lines: string[] } | null = null;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(```+|~~~+)(.*)$/.exec(lines[i]);
    if (match && current === null) {
      fenceMarker = match[1];
      const info = match[2].trim();
      if (BASH_INFO.test(info) && !info.includes('doc-test=skip')) {
        current = { startLine: i + 2, lines: [] }; // content starts on next line (1-indexed)
      } else {
        current = { startLine: -1, lines: [] }; // non-bash block — consume but ignore
      }
      continue;
    }
    if (match && current !== null && match[1][0] === fenceMarker[0] && match[2].trim() === '') {
      if (current.startLine !== -1) blocks.push(current);
      current = null;
      continue;
    }
    if (current !== null) current.lines.push(lines[i]);
  }
  return blocks;
}

/** Split a shell line on unquoted && || ; | into separate command segments. */
function splitSegments(line: string): string[] {
  const segments: string[] = [];
  let buf = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '#' && /\s/.test(line[i - 1] ?? ' ')) break; // trailing comment
    if ((ch === '&' && line[i + 1] === '&') || (ch === '|' && line[i + 1] === '|')) {
      segments.push(buf);
      buf = '';
      i++;
      continue;
    }
    if (ch === '|' || ch === ';') {
      segments.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  segments.push(buf);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** Quote-aware whitespace tokenizer (keeps quoted values as one token). */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  let quote: string | null = null;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf) tokens.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf) tokens.push(buf);
  return tokens;
}

const HEREDOC_RE = /<<-?\s*'?"?([A-Za-z_][A-Za-z0-9_]*)'?"?/;
const REDIRECT_TOKENS = new Set(['>', '>>', '<', '2>', '2>>', '&>', 'jq', 'tee', 'xargs', 'grep']);

function collectDocCommands(file: string, topLevelNames: Set<string>): DocCommandLine[] {
  const relFile = path.relative(ROOT, file);
  const out: DocCommandLine[] = [];
  const content = fs.readFileSync(file, 'utf8');
  for (const block of extractBashBlocks(content)) {
    let heredocEnd: string | null = null;
    for (let i = 0; i < block.lines.length; i++) {
      let raw = block.lines[i];
      const lineNo = block.startLine + i;
      if (heredocEnd) {
        if (raw.trim() === heredocEnd) heredocEnd = null;
        continue; // heredoc body is data, not commands
      }
      if (/^\s*#/.test(raw)) continue;
      // Join line continuations
      let joined = raw;
      while (/\\\s*$/.test(joined) && i + 1 < block.lines.length) {
        joined = joined.replace(/\\\s*$/, ' ') + block.lines[++i];
      }
      const heredoc = HEREDOC_RE.exec(joined);
      if (heredoc) heredocEnd = heredoc[1];

      for (const segment of splitSegments(joined)) {
        const queue: string[][] = [tokenize(segment.replace(/^\$\s+/, ''))];
        while (queue.length > 0) {
          let tokens = queue.shift()!;
          // A `$(...)` mid-command starts a nested command: split it off so its
          // flags are validated against the inner command, not the outer one.
          for (let j = 1; j < tokens.length; j++) {
            if (tokens[j].startsWith('$(')) {
              queue.push([tokens[j].slice(2), ...tokens.slice(j + 1)].filter(Boolean));
              tokens = tokens.slice(0, j);
              break;
            }
          }
          // Strip leading env-var assignments; VAR=$(pop ... unwraps the subshell.
          while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
            const value = tokens[0].replace(/^[A-Za-z_][A-Za-z0-9_]*=/, '');
            if (value.startsWith('$(')) {
              tokens[0] = value.slice(2);
              break;
            }
            tokens = tokens.slice(1);
          }
          // Trailing `)` artifacts from closed subshells
          tokens = tokens.map((t) => t.replace(/\)+$/, '')).filter(Boolean);

          if (tokens[0] === 'node' && tokens[1] === 'dist/index.js') tokens = tokens.slice(2);
          else if (tokens[0] === 'pop') tokens = tokens.slice(1);
          else continue;

          if (tokens.length < 1 || tokens[0].startsWith('-')) continue;
          // Top-level command (`pop init`): one plain word, flags may follow.
          if (topLevelNames.has(tokens[0])) {
            out.push({ file: relFile, line: lineNo, raw: segment.trim(), tokens });
            continue;
          }
          // Otherwise need `<domain> <action>` — both plain words.
          if (tokens.length < 2) continue;
          if (tokens[1].startsWith('-')) continue;
          if (REDIRECT_TOKENS.has(tokens[0]) || REDIRECT_TOKENS.has(tokens[1])) continue;
          out.push({ file: relFile, line: lineNo, raw: segment.trim(), tokens });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation against the CLI tree
// ---------------------------------------------------------------------------

function flagNames(spec: { aliases?: string[] }, name: string): string[] {
  return [name, ...(spec.aliases ?? [])];
}

function allowedFlagsFor(commandChain: CliCommand[]): Set<string> {
  const allowed = new Set<string>();
  for (const [name, spec] of Object.entries(GLOBAL_FLAGS)) {
    for (const n of flagNames(spec, name)) allowed.add(n);
  }
  // yargs built-ins available on every command
  allowed.add('help');
  allowed.add('version');
  for (const command of commandChain) {
    for (const [name, spec] of Object.entries(command.options)) {
      for (const n of flagNames(spec, name)) allowed.add(n);
    }
  }
  return allowed;
}

function checkFlags(cmd: DocCommandLine, chain: CliCommand[], startIndex: number): string[] {
  const allowed = allowedFlagsFor(chain);
  const problems: string[] = [];
  for (let i = startIndex; i < cmd.tokens.length; i++) {
    const token = cmd.tokens[i];
    if (token === '--') break;
    if (!token.startsWith('-')) continue;
    if (/^-\d/.test(token)) continue; // negative number value
    let name = token.replace(/^--?/, '').split('=')[0];
    if (name === '') continue;
    const isLong = token.startsWith('--');
    if (!isLong && name.length > 1) {
      // combined short flags: -vq
      for (const ch of name) {
        if (!allowed.has(ch)) problems.push(`unknown flag '-${ch}' in '${token}'`);
      }
      continue;
    }
    if (allowed.has(name)) continue;
    // --no-<flag> boolean negation
    if (name.startsWith('no-') && allowed.has(name.slice(3))) continue;
    problems.push(`unknown flag '--${name}'`);
  }
  return problems;
}

function validate(
  cmd: DocCommandLine,
  domains: Map<string, { description: string; commands: Map<string, CliCommand> }>,
  topLevel: Map<string, CliCommand>,
): string[] {
  const [domainName, actionName, ...rest] = cmd.tokens;
  // Top-level command (`pop init`): flags checked against its own options.
  const top = topLevel.get(domainName);
  if (top) return checkFlags(cmd, [top], 1);
  const domain = domains.get(domainName);
  if (!domain) return [`unknown domain 'pop ${domainName}'`];
  const command = domain.commands.get(actionName);
  if (!command) return [`unknown command 'pop ${domainName} ${actionName}'`];

  const chain: CliCommand[] = [command];
  let flagStart = 2;
  if (command.subcommands && rest.length > 0 && !rest[0].startsWith('-')) {
    const sub = command.subcommands.find((s) => s.name === rest[0]);
    if (sub) {
      chain.push(sub);
      flagStart = 3;
    } else if (command.positionals.length === 0) {
      return [`unknown subcommand 'pop ${domainName} ${actionName} ${rest[0]}'`];
    }
  }
  return checkFlags(cmd, chain, flagStart);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('doc-commands: documented CLI invocations match the command tree', () => {
  const tree = buildCliTree();
  const domains = new Map(
    tree.map((d) => [
      d.domain,
      { description: d.description, commands: new Map(d.commands.map((c) => [c.name, c])) },
    ]),
  );
  const topLevel = new Map(buildTopLevelCommands().map((c) => [c.name, c]));
  const topLevelNames = new Set(topLevel.keys());

  it('buildCliTree() produces the expected shape', () => {
    expect(tree).toHaveLength(14);
    expect(domains.get('task')?.commands.has('create')).toBe(true);
    expect(GLOBAL_FLAGS.org).toBeDefined();
    const retro = domains.get('brain')?.commands.get('retro');
    expect(retro?.subcommands?.some((s) => s.name === 'show')).toBe(true);
    // Top-level commands are modeled too (pop init).
    expect(topLevel.has('init')).toBe(true);
  });

  const docFiles = listDocFiles();

  it('every documented pop invocation resolves to a real command + known flags', () => {
    const enforced: Violation[] = [];
    const warned: Violation[] = [];
    let checked = 0;
    for (const file of docFiles) {
      const relFile = path.relative(ROOT, file);
      if (relFile.startsWith(path.join('docs', 'reference', 'cli'))) continue; // generated from the tree itself
      const commands = collectDocCommands(file, topLevelNames);
      checked += commands.length;
      if (process.env.DOC_TEST_DEBUG) {
        console.log(`doc-commands DEBUG ${relFile}: ${commands.length} invocations`);
      }
      for (const cmd of commands) {
        for (const message of validate(cmd, domains, topLevel)) {
          const violation = { file: cmd.file, line: cmd.line, message: `${message} — "${cmd.raw}"` };
          if (WARN_ONLY.has(relFile)) warned.push(violation);
          else enforced.push(violation);
        }
      }
    }

    for (const v of warned) {
      console.warn(`doc-commands WARN (pending D4/D5 rewrite) ${v.file}:${v.line} ${v.message}`);
    }
    // Self-check: if extraction ever breaks, the suite should not silently pass.
    expect(checked).toBeGreaterThan(50);
    const report = enforced.map((v) => `${v.file}:${v.line} ${v.message}`).join('\n');
    expect(enforced, `documented commands drifted from the CLI tree:\n${report}`).toEqual([]);
  });
});
