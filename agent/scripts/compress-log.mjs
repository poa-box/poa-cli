#!/usr/bin/env node
// agent/scripts/compress-log.mjs — Task #512 step 3/4
//
// Deterministic fact-extraction + checkpoint + cut-window for heartbeat-log.md
// compression. The LLM-prose-summarization happens at the skill layer (when
// /compress-log fires, the agent reading .claude/skills/compress-log/SKILL.md
// does prose enrichment); this script handles the safety-critical mechanical
// parts: checkpoint, preserve-pattern extraction, line-window cut, archive
// writing, verification sampling.
//
// Per #512 spec deliverables 1-6 + argus HB#675 R6 voluntary-default with
// involuntary-fallback. SKILL.md at .claude/skills/compress-log/SKILL.md.
//
// Usage:
//   node agent/scripts/compress-log.mjs                 # auto-config from agent-config.json
//   node agent/scripts/compress-log.mjs --threshold 3000 --retain-lines 500
//   node agent/scripts/compress-log.mjs --dry-run       # preview without writing
//   node agent/scripts/compress-log.mjs --force         # bypass min-hb-interval gate
//   node agent/scripts/compress-log.mjs --json          # machine-readable output
//
// Exit codes:
//   0 = success (compressed OR explicitly no-op-correct)
//   1 = error (pre-flight failure, write error, verification failure)
//   2 = no-op (under threshold OR last-run too recent)

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// ─── Config defaults (must match SKILL.md + agent-config.json compressLog) ──
const DEFAULTS = {
  compressionTriggerLines: 5000,
  compressionRetainLines: 1000,
  compressionMinHbInterval: 20,
  DISABLE_AUTO_COMPRESSION: false,
  warnAtMultiple: 1.5,
};

const HOME = homedir();
const LOG_PATH = join(HOME, '.pop-agent', 'brain', 'Memory', 'heartbeat-log.md');
const ARCHIVE_PATH = 'agent/brain/Memory/heartbeat-log-archive.md';
const CONFIG_PATH = 'agent/brain/Config/agent-config.json';

// ─── CLI arg parser (minimal, no yargs dependency) ──────────────────────────
function parseArgs(argv) {
  const args = { dryRun: false, force: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--json') args.json = true;
    else if (a === '--threshold') args.threshold = parseInt(argv[++i], 10);
    else if (a === '--retain-lines') args.retainLines = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') { args.help = true; }
  }
  return args;
}

function helpText() {
  return `compress-log: Task #512 deterministic compression for heartbeat-log.md

Usage:
  node agent/scripts/compress-log.mjs [flags]

Flags:
  --threshold N      Override compressionTriggerLines (default 5000)
  --retain-lines N   Override compressionRetainLines (default 1000)
  --dry-run          Preview without writing
  --force            Bypass compressionMinHbInterval gate
  --json             Machine-readable output to stdout
  --help             This text

Reads config from ${CONFIG_PATH} (compressLog section).
Reads log from ${LOG_PATH}.
Writes archive to ${ARCHIVE_PATH} (per-agent local).
Creates checkpoint at <log>.checkpoint.<unix-ts>.md before any truncation.

Exit codes: 0 success, 1 error, 2 no-op.
`;
}

// ─── Read config ────────────────────────────────────────────────────────────
function loadConfig(args) {
  let fileConfig = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      const json = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      fileConfig = json.compressLog || {};
    } catch (e) {
      // Config absent or malformed → use DEFAULTS; non-fatal.
      fileConfig = {};
    }
  }
  const config = { ...DEFAULTS, ...fileConfig };
  if (args.threshold !== undefined) config.compressionTriggerLines = args.threshold;
  if (args.retainLines !== undefined) config.compressionRetainLines = args.retainLines;
  return config;
}

// ─── Preserve-pattern regex (must match SKILL.md "What gets preserved") ────
const PRESERVE_PATTERNS = {
  taskIds:        /#\d{2,4}\b/g,                           // task IDs like #508
  commitHashes:   /\b[0-9a-f]{7,12}\b/g,                   // git short hashes
  brainHeads:     /\b(bafkrei|Qm)[a-zA-Z0-9]{40,}\b/g,     // IPLD CIDs (CIDv0 + CIDv1 base32)
  decisions:      /(^|\n)\s*[-*]?\s*(DECIDED|DECISION:|\*\*Decision:\*\*)/gi,
  followUps:      /\b(TODO|FIXME|FOLLOW-UP|FOLLOWUP)\b/g,
  selfCorrections:/\b(self-correction|RETRACT|RETRACTED)\b/gi,
  txHashes:       /0x[0-9a-fA-F]{64}\b/g,                  // transaction hashes
};

// ─── Extract preserve patterns from a chunk of text ─────────────────────────
function extractPreserves(text) {
  const out = {};
  for (const [name, re] of Object.entries(PRESERVE_PATTERNS)) {
    const matches = [...text.matchAll(re)].map(m => m[0]);
    out[name] = [...new Set(matches)]; // unique
  }
  return out;
}

// ─── SHA256 file hash ───────────────────────────────────────────────────────
function sha256File(path) {
  const data = readFileSync(path);
  return createHash('sha256').update(data).digest('hex');
}

// ─── Identify HB# block boundaries in compression window ───────────────────
function splitByHb(text) {
  // Match `## HB#N` or `## HB#N ` headers; capture each block until next header.
  const lines = text.split('\n');
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^## HB#(\d+)\b/);
    if (m) {
      if (current) blocks.push(current);
      current = { hb: parseInt(m[1], 10), header: line, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      // Pre-first-HB content (e.g., file header) — accumulate as a special block
      if (!blocks.length || blocks[0].hb !== null) {
        blocks.unshift({ hb: null, header: '(prelude)', lines: [line] });
      } else {
        blocks[0].lines.push(line);
      }
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

// ─── Write a structured archive entry per HB block ──────────────────────────
function archiveEntryFor(block) {
  if (block.hb === null) return null; // skip prelude
  const text = block.lines.join('\n');
  const preserves = extractPreserves(text);
  const oneLineSummary = block.header.replace(/^## /, '').slice(0, 200);
  const lines = [
    `## HB#${block.hb} (compressed)`,
    '',
    `**Header**: ${oneLineSummary}`,
    '',
    `**Original line count**: ${block.lines.length}`,
    '',
  ];
  const sections = [];
  if (preserves.taskIds.length)         sections.push(`- Task IDs: ${preserves.taskIds.join(', ')}`);
  if (preserves.commitHashes.length)    sections.push(`- Commits: ${preserves.commitHashes.join(', ')}`);
  if (preserves.txHashes.length)        sections.push(`- Tx hashes: ${preserves.txHashes.slice(0, 5).join(', ')}${preserves.txHashes.length > 5 ? ` (+${preserves.txHashes.length - 5})` : ''}`);
  if (preserves.brainHeads.length)      sections.push(`- Brain CIDs: ${preserves.brainHeads.slice(0, 5).join(', ')}${preserves.brainHeads.length > 5 ? ` (+${preserves.brainHeads.length - 5})` : ''}`);
  if (preserves.decisions.length)       sections.push(`- Decision markers: ${preserves.decisions.length} found`);
  if (preserves.followUps.length)       sections.push(`- Follow-ups: ${preserves.followUps.join(', ')}`);
  if (preserves.selfCorrections.length) sections.push(`- Self-corrections: ${preserves.selfCorrections.length} found`);
  if (sections.length) {
    lines.push('**Preserve-patterns**:', '', ...sections, '');
  }
  lines.push('**LLM summary**: [pending — invoke /compress-log skill body to enrich this entry with prose summary]');
  lines.push('');
  return lines.join('\n');
}

// ─── Verification sample (per #512 acceptance criterion 4) ─────────────────
function verifySample(originalBlocks, archiveText) {
  // Sample 5 random blocks; for each: confirm all task IDs + commits + brain heads
  // present in the original ALSO appear in the archive entry.
  const sampleSize = Math.min(5, originalBlocks.length);
  if (sampleSize === 0) return { passed: 0, failed: 0, samples: [] };
  const indices = new Set();
  while (indices.size < sampleSize && indices.size < originalBlocks.length) {
    indices.add(Math.floor(Math.random() * originalBlocks.length));
  }
  const samples = [];
  let passed = 0, failed = 0;
  for (const idx of indices) {
    const block = originalBlocks[idx];
    if (block.hb === null) continue; // skip prelude
    const origPreserves = extractPreserves(block.lines.join('\n'));
    const allTokens = [
      ...origPreserves.taskIds,
      ...origPreserves.commitHashes,
      ...origPreserves.brainHeads.slice(0, 5),
      ...origPreserves.txHashes.slice(0, 5),
    ];
    const missing = allTokens.filter(t => !archiveText.includes(t));
    const ok = missing.length === 0;
    samples.push({ hb: block.hb, ok, tokensChecked: allTokens.length, missing: missing.slice(0, 3) });
    if (ok) passed++; else failed++;
  }
  return { passed, failed, samples };
}

// ─── Main ────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(helpText()); process.exit(0); }

  const config = loadConfig(args);
  const result = { config, action: 'unknown' };

  // 1. Pre-flight
  if (!existsSync(LOG_PATH)) {
    result.action = 'error';
    result.error = `Log not found at ${LOG_PATH}`;
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.error(`✗ ${result.error}`);
    process.exit(1);
  }

  const stat = statSync(LOG_PATH);
  const fullText = readFileSync(LOG_PATH, 'utf8');
  const allLines = fullText.split('\n');
  result.originalLineCount = allLines.length;
  result.originalSizeBytes = stat.size;

  // 2. Threshold check
  if (allLines.length < config.compressionTriggerLines && !args.force) {
    result.action = 'no-op';
    result.reason = `under-threshold (${allLines.length} < ${config.compressionTriggerLines})`;
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`ℹ no-op: log under threshold (${allLines.length} < ${config.compressionTriggerLines}). Use --force to compress anyway.`);
    process.exit(2);
  }

  // 3. Auto-disable check
  if (config.DISABLE_AUTO_COMPRESSION === true && !args.force) {
    result.action = 'no-op';
    result.reason = 'DISABLE_AUTO_COMPRESSION=true (manual --force still works)';
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`ℹ no-op: DISABLE_AUTO_COMPRESSION=true. Use --force to compress.`);
    process.exit(2);
  }

  // 4. Identify cut window: last N lines verbatim, rest is compression window
  const retainLines = config.compressionRetainLines;
  const cutIndex = Math.max(0, allLines.length - retainLines);
  const compressWindow = allLines.slice(0, cutIndex).join('\n');
  const retainedTail = allLines.slice(cutIndex).join('\n');
  result.compressionWindowLines = cutIndex;
  result.retainedLines = allLines.length - cutIndex;

  // 5. Split compression window by HB blocks
  const blocks = splitByHb(compressWindow);
  const hbBlocks = blocks.filter(b => b.hb !== null);
  result.hbBlocksCount = hbBlocks.length;
  // Sort min/max for chronological display regardless of log entry order
  // (some agents prepend newest-at-top, others append newest-at-bottom).
  const allHbs = hbBlocks.map(b => b.hb);
  result.hbRange = hbBlocks.length ? [Math.min(...allHbs), Math.max(...allHbs)] : null;

  // 6. Build archive entries
  const archiveEntries = hbBlocks.map(archiveEntryFor).filter(Boolean);
  const now = new Date().toISOString();
  const archiveSectionHeader = hbBlocks.length
    ? `\n# Compressed range: HB#${hbBlocks[0].hb} through HB#${hbBlocks[hbBlocks.length - 1].hb} (compressed ${now})\n\n*Per Task #512. Original log preserved at \`heartbeat-log.checkpoint.<unix-ts>.md\` for ground-truth recovery. LLM summaries pending; preserve-patterns extracted deterministically.*\n\n---\n\n`
    : '';
  const archiveText = archiveSectionHeader + archiveEntries.join('\n---\n\n');

  // 7. Verification sample (BEFORE writing — abort if verification fails)
  const verification = verifySample(hbBlocks, archiveText);
  result.verification = verification;
  if (verification.failed > 0) {
    result.action = 'aborted';
    result.error = `Verification sample FAILED: ${verification.failed}/${verification.passed + verification.failed} samples missing tokens. Compression aborted; live log unchanged.`;
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.error(`✗ ${result.error}`);
    process.exit(1);
  }

  if (args.dryRun) {
    result.action = 'dry-run';
    result.archivePreview = archiveText.slice(0, 500) + (archiveText.length > 500 ? '\n...[truncated for preview]' : '');
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`✓ DRY-RUN preview:`);
      console.log(`  Lines: ${result.originalLineCount} total → ${result.retainedLines} retained + ${result.compressionWindowLines} compressed`);
      console.log(`  HB blocks: ${result.hbBlocksCount} (range ${result.hbRange ? result.hbRange.join('..') : 'n/a'})`);
      console.log(`  Verification: ${verification.passed}/${verification.passed + verification.failed} samples passed`);
      console.log(`  Archive preview (first 500 chars):\n${result.archivePreview}`);
      console.log(`\nRe-run without --dry-run to apply.`);
    }
    process.exit(0);
  }

  // 8. Checkpoint (mandatory; never skip)
  const ts = Math.floor(Date.now() / 1000);
  const checkpointPath = `${LOG_PATH}.checkpoint.${ts}.md`;
  copyFileSync(LOG_PATH, checkpointPath);
  const origHash = sha256File(LOG_PATH);
  const checkpointHash = sha256File(checkpointPath);
  if (origHash !== checkpointHash) {
    result.action = 'aborted';
    result.error = `Checkpoint SHA256 mismatch: ${origHash.slice(0, 12)}... vs ${checkpointHash.slice(0, 12)}.... Live log unchanged.`;
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.error(`✗ ${result.error}`);
    process.exit(1);
  }
  result.checkpointPath = checkpointPath;
  result.checkpointSha256 = checkpointHash;

  // 9. Append archive
  if (!existsSync(dirname(ARCHIVE_PATH))) mkdirSync(dirname(ARCHIVE_PATH), { recursive: true });
  const existingArchive = existsSync(ARCHIVE_PATH) ? readFileSync(ARCHIVE_PATH, 'utf8') : '# Heartbeat-log archive\n\n*Per Task #512. Compressed entries from heartbeat-log.md, preserved for retrieval. Most-recent at top.*\n\n';
  // New entries go at top (most-recent first per #512 spec)
  const newArchive = '# Heartbeat-log archive\n\n*Per Task #512. Compressed entries from heartbeat-log.md, preserved for retrieval. Most-recent at top.*\n\n' + archiveText + '\n\n---\n\n' + existingArchive.replace(/^# Heartbeat-log archive\n\n\*[^*]*\*\n\n/, '');
  writeFileSync(ARCHIVE_PATH, newArchive);
  result.archivePath = ARCHIVE_PATH;
  result.archiveBytesAdded = archiveText.length;

  // 10. Replace live log: header + checkpoint ref + retained tail + invocation note
  const liveLogHeader = `# Heartbeat Log — argus_prime\n\n*Compressed at ${now} (compress-log Task #512). Pre-compression checkpoint at \`${checkpointPath}\` (SHA256: \`${checkpointHash.slice(0, 16)}...\`). Compressed range archived at \`${ARCHIVE_PATH}\` (HB#${result.hbRange[0]} through HB#${result.hbRange[1]}).*\n\n`;
  writeFileSync(LOG_PATH, liveLogHeader + retainedTail);
  result.newLogLineCount = (liveLogHeader + retainedTail).split('\n').length;

  result.action = 'compressed';
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`✓ Compressed: ${result.originalLineCount} → ${result.newLogLineCount} lines`);
    console.log(`  Compressed range: HB#${result.hbRange[0]} through HB#${result.hbRange[1]} (${result.hbBlocksCount} blocks)`);
    console.log(`  Checkpoint: ${checkpointPath}`);
    console.log(`  Archive: ${ARCHIVE_PATH} (+${result.archiveBytesAdded} bytes)`);
    console.log(`  Verification: ${verification.passed}/${verification.passed + verification.failed} samples passed`);
  }
  process.exit(0);
}

main();
