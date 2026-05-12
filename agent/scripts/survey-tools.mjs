#!/usr/bin/env node
/**
 * agent/scripts/survey-tools.mjs — companion script for /self-survey-tools skill (Task #542)
 *
 * Deterministic phase: enumerate pop CLI flags + cross-reference against
 * recent agent activity (heartbeat-log.md + brain.shared lessons) to detect
 * unused capabilities. Outputs surveyOutput.json for LLM enrichment phase.
 *
 * Usage:
 *   node agent/scripts/survey-tools.mjs [--scan-window-hbs N] [--log-path P] [--json]
 *
 * Exit codes:
 *   0 — all enumerated flags have >0 usage in scan window
 *   2 — ≥1 capability with usage_count=0 (unused-flag detected)
 *
 * Per Task #542 acceptance: must surface lockstep-analyzer --pattern-mode
 * weighted as unused HB#798-#812 (rediscovered HB#813).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TOOLING_VERSION = 'self-survey-tools-v0.1';
const DEFAULT_SCAN_WINDOW_HBS = 50;
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const POP_CLI = path.join(REPO_ROOT, 'dist', 'index.js');

// Argv parsing (lightweight; no yargs dep)
const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  return argv[i + 1];
}
const SCAN_WINDOW_HBS = Number(flag('--scan-window-hbs', DEFAULT_SCAN_WINDOW_HBS));
const LOG_PATH = flag('--log-path', path.join(process.env.HOME, '.pop-agent', 'brain', 'Memory', 'heartbeat-log.md'));
const JSON_OUTPUT = argv.includes('--json');

// Domains to enumerate
const DOMAINS = ['org', 'agent', 'vote', 'treasury', 'task', 'brain', 'project', 'paymaster'];

function runHelp(...args) {
  try {
    const res = spawnSync('node', [POP_CLI, ...args, '--help'], { encoding: 'utf8', timeout: 10000 });
    return (res.stdout || '') + '\n' + (res.stderr || '');
  } catch {
    return '';
  }
}

// Extract subcommand names from a domain's --help output
function parseSubcommands(helpText) {
  const subs = new Set();
  const lines = helpText.split('\n');
  let inCommands = false;
  for (const line of lines) {
    if (/^Commands:|^Subcommands:/i.test(line.trim())) {
      inCommands = true;
      continue;
    }
    if (inCommands) {
      // Match patterns like "  pop org audit-snapshot    Audit governance..."
      const m = line.match(/^\s+(?:pop\s+\w+\s+|)([\w-]+)\s{2,}/);
      if (m && m[1] !== 'help' && m[1] !== 'completion') subs.add(m[1]);
      if (/^Options:/i.test(line.trim()) && subs.size > 0) inCommands = false;
    }
  }
  return [...subs];
}

// Extract --<flag> patterns from a subcommand's --help output
function parseFlags(helpText) {
  const flags = new Map(); // flag -> first-line-of-help-text
  const lines = helpText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s+(--[\w-]+)(?:\s+(?:<[^>]+>|\[[^\]]+\]))?\s*(.*)/);
    if (m) {
      const flagName = m[1];
      if (['--help', '--version', '--json', '--yes', '--dry-run', '--rpc', '--chain', '--org', '--private-key'].includes(flagName)) continue;
      let hint = m[2].trim();
      // continuation lines indented further
      while (i + 1 < lines.length && /^\s{20,}/.test(lines[i + 1]) && !lines[i + 1].includes('--')) {
        hint += ' ' + lines[++i].trim();
      }
      flags.set(flagName, hint.slice(0, 100));
    }
  }
  return flags;
}

// Read heartbeat-log.md (and optionally brain.shared) for recent usage
function readLogTail(scanWindowHBs) {
  if (!fs.existsSync(LOG_PATH)) {
    console.error(`[survey-tools] log not found: ${LOG_PATH}`);
    return '';
  }
  const full = fs.readFileSync(LOG_PATH, 'utf8');
  // Extract last N HB blocks (HB markers = "^## HB#NNN")
  const blocks = full.split(/(?=^## HB#)/m);
  // Each block starts with "## HB#NNN ..."; take last N
  const tail = blocks.slice(-scanWindowHBs - 1); // +1 for safety
  return tail.join('');
}

function buildCapabilityMap() {
  console.error('[survey-tools] enumerating capabilities...');
  const caps = [];
  // Pass A: pop CLI domains
  for (const domain of DOMAINS) {
    const domainHelp = runHelp(domain);
    const subs = parseSubcommands(domainHelp);
    if (subs.length === 0) continue;
    for (const sub of subs) {
      const subHelp = runHelp(domain, sub);
      const flags = parseFlags(subHelp);
      for (const [f, hint] of flags) {
        caps.push({ tool: domain, subcommand: sub, flag: f, hint });
      }
    }
  }
  // Pass B: agent/scripts/*.{mjs,js} node scripts (HB#827 extension)
  // These don't have --help; we scan source for argv-parser blocks
  // matching `args[i] === '--<flag>'` OR `argv.includes('--<flag>')`.
  const scriptsDir = path.join(REPO_ROOT, 'agent', 'scripts');
  if (fs.existsSync(scriptsDir)) {
    const scriptFiles = fs.readdirSync(scriptsDir).filter(f => /\.(mjs|js)$/.test(f));
    for (const sf of scriptFiles) {
      const src = fs.readFileSync(path.join(scriptsDir, sf), 'utf8');
      const flagsFound = new Set();
      // Pattern 1: args[i] === '--flag-name'
      for (const m of src.matchAll(/args\[[\w+\d]+\]\s*===\s*['"](--[\w-]+)['"]/g)) {
        flagsFound.add(m[1]);
      }
      // Pattern 2: argv.includes('--flag-name')
      for (const m of src.matchAll(/argv\.includes\(\s*['"](--[\w-]+)['"]\s*\)/g)) {
        flagsFound.add(m[1]);
      }
      // Pattern 3: --pattern-mode <value> style (positional value flags)
      //   args[i] === '--<flag>' && args[i + 1] — same as Pattern 1
      // Pattern 4: --flag=value style
      for (const m of src.matchAll(/['"](--[\w-]+)=/g)) {
        flagsFound.add(m[1]);
      }
      for (const flag of flagsFound) {
        if (['--help', '--version'].includes(flag)) continue;
        caps.push({ tool: 'agent/scripts', subcommand: sf, flag, hint: '(script source-scan)' });
      }
    }
    console.error(`[survey-tools] script enumeration: ${scriptFiles.length} files scanned`);
  }
  console.error(`[survey-tools] enumerated ${caps.length} total capabilities (pop CLI + scripts)`);
  return caps;
}

function crossReferenceUsage(caps, logTail, scanWindowHBs) {
  // For each capability, search logTail for `pop <tool> <sub>` followed eventually by the flag.
  // Heuristic: match command-line patterns like "pop org allocation-distance --hub-detection"
  // OR "node dist/index.js org allocation-distance --hub-detection"
  // Also match flag standalone occurrences as fallback (lower confidence).
  const hbMatches = logTail.match(/^## HB#(\d+)/gm) || [];
  const latestHb = hbMatches.length > 0 ? Number(hbMatches[hbMatches.length - 1].match(/\d+/)[0]) : 0;
  for (const cap of caps) {
    // Full-pattern match — two variants:
    // (a) pop CLI: "pop <tool> <subcommand> ... --flag" or "dist/index.js <tool> <subcommand> ... --flag"
    // (b) Node script: "node agent/scripts/<subcommand> ... --flag" (when tool==='agent/scripts')
    const fullPattern = cap.tool === 'agent/scripts'
      ? new RegExp(`node\\s+(?:[\\w./]+/)?${cap.subcommand.replace(/\./g, '\\.')}(?:\\s+[\\w-./=]+)*\\s+${cap.flag}\\b`, 'g')
      : new RegExp(`(?:pop|dist/index\\.js)\\s+${cap.tool}\\s+${cap.subcommand}(?:\\s+[\\w-./=]+)*\\s+${cap.flag.replace(/-/g, '-')}`, 'g');
    // Standalone flag (lower confidence; require subcommand mention within same paragraph)
    const standalonePattern = new RegExp(`${cap.flag}\\b`, 'g');
    const fullMatches = logTail.match(fullPattern) || [];
    const flagMentions = logTail.match(standalonePattern) || [];
    cap.usage_count = fullMatches.length;
    cap.flag_mentions = flagMentions.length;
    // Find HB# of most recent occurrence
    let lastHb = null;
    if (fullMatches.length > 0) {
      const lastIdx = logTail.lastIndexOf(fullMatches[fullMatches.length - 1]);
      const before = logTail.slice(0, lastIdx);
      const hbMatch = before.match(/^## HB#(\d+)[\s\S]*$/m);
      lastHb = hbMatch ? Number(hbMatch[1]) : null;
    }
    cap.last_observed_use = lastHb;
    cap.age_in_HBs = lastHb ? latestHb - lastHb : null;
  }
  return caps;
}

function buildReport(caps, scanWindowHBs) {
  const unused = caps.filter(c => c.usage_count === 0);
  const rarely = caps.filter(c => c.usage_count >= 1 && c.usage_count < 3);
  const summary = `${unused.length} flags unused; ${rarely.length} used <3 times; ${caps.length - unused.length - rarely.length} active`;
  return {
    survey_hb: 'current',
    tooling_version: TOOLING_VERSION,
    filters: { scanWindowHBs, log_path: LOG_PATH },
    total_capabilities: caps.length,
    unused_count: unused.length,
    rarely_used_count: rarely.length,
    summary,
    capabilities: caps,
  };
}

const caps = buildCapabilityMap();
const logTail = readLogTail(SCAN_WINDOW_HBS);
const cappedWithUsage = crossReferenceUsage(caps, logTail, SCAN_WINDOW_HBS);
const report = buildReport(cappedWithUsage, SCAN_WINDOW_HBS);

if (JSON_OUTPUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\nSelf-survey-tools v0.1 — scan window: ${SCAN_WINDOW_HBS} HBs`);
  console.log(`Total capabilities: ${report.total_capabilities}`);
  console.log(`Unused (0 usage): ${report.unused_count}`);
  console.log(`Rarely used (<3): ${report.rarely_used_count}`);
  console.log(`\nUnused-flag candidates (top 5):`);
  const unused = report.capabilities.filter(c => c.usage_count === 0).slice(0, 5);
  for (const u of unused) {
    console.log(`  ${u.tool} ${u.subcommand} ${u.flag}  ${u.hint.slice(0, 60)}`);
  }
}

process.exit(report.unused_count > 0 ? 2 : 0);
