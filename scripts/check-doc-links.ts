/**
 * check-doc-links — two guards against documentation rot:
 *
 *   (a) relative markdown links: every [text](path) in README.md, ABOUT.md,
 *       CONTRIBUTING.md, docs/**\/*.md and reports/README.md must resolve to a
 *       file or directory on disk (http/https/mailto/#anchor links ignored).
 *
 *   (b) doc-path couplings in code: string literals matching
 *       (docs|reports)/...*.md inside src/**\/*.ts, .claude/skills/**\/*.md and
 *       agent/scripts/*.mjs must exist on disk. This guards the agent-fleet
 *       path couplings (skills and scripts hardcode report/doc paths).
 *
 * Exit 0 when clean, exit 1 with a report listing every broken reference.
 * Run via `yarn docs:check`.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

/** Paths created at runtime by agent tooling — referenced before they exist. */
const RUNTIME_GENERATED = new Set<string>([
  'reports/distribution/post-history.md', // append-log created by agent/scripts/post-x-thread.mjs on first --post
]);

/**
 * Targets known to be missing, warned instead of failed. Empty since the
 * cross-chain-agent-deployment links were removed from brain-layer-setup.md
 * (the doc only ever existed on agent/sprint-3); keep the mechanism for the
 * next restructure.
 */
const KNOWN_MISSING_LINK_TARGETS = new Set<string>([]);

/** Generated/historical data that must not gate CI (mirror of the spec's exclude list). */
const SCAN_EXCLUDES: RegExp[] = [
  /^agent\/scripts\/[^/]+\.json$/,
  /^agent\/brain\/Knowledge\/[^/]+\.generated\.md$/,
  /^agent\/artifacts\//,
];

interface Problem {
  file: string;
  line: number;
  detail: string;
}

function walk(dir: string, ext: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, out);
    else if (entry.isFile() && entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return path.relative(ROOT, file);
}

function isExcluded(relPath: string): boolean {
  return SCAN_EXCLUDES.some((re) => re.test(relPath));
}

// ---------------------------------------------------------------------------
// (a) relative markdown links
// ---------------------------------------------------------------------------

const LINK_RE = /!?\[[^\]]*\]\(([^)]*)\)/g;

function extractTarget(raw: string): string {
  let target = raw.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  // Drop optional link title: [x](path "title")
  const firstSpace = target.search(/\s/);
  if (firstSpace !== -1) target = target.slice(0, firstSpace);
  return target;
}

function checkMarkdownLinks(files: string[], warnings: Problem[]): Problem[] {
  const problems: Problem[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const scannable = line.replace(/`[^`]*`/g, '``'); // ignore inline code spans
      for (const match of scannable.matchAll(LINK_RE)) {
        const target = extractTarget(match[1]);
        if (target === '' || target.startsWith('#')) continue;
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue; // http:, https:, mailto:, ipfs:, ...
        const clean = target.split('#')[0].split('?')[0];
        if (clean === '') continue;
        const resolved = clean.startsWith('/')
          ? path.join(ROOT, clean)
          : path.resolve(path.dirname(file), clean);
        if (!fs.existsSync(resolved)) {
          const problem = { file: rel(file), line: i + 1, detail: `broken link: (${target})` };
          if (KNOWN_MISSING_LINK_TARGETS.has(rel(resolved))) warnings.push(problem);
          else problems.push(problem);
        }
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// (b) doc-path string literals in code
// ---------------------------------------------------------------------------

const DOC_PATH_RE = /(?:^|[^A-Za-z0-9_/.@-])((?:docs|reports)\/[A-Za-z0-9_./-]+\.md)/g;

function checkDocPathReferences(files: string[]): Problem[] {
  const problems: Problem[] = [];
  for (const file of files) {
    if (isExcluded(rel(file))) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const match of lines[i].matchAll(DOC_PATH_RE)) {
        const docPath = match[1];
        if (RUNTIME_GENERATED.has(docPath)) continue;
        // Guide files linked ahead of landing (D4/D5 docs wave): command
        // epilogues point at docs/guides/*.md before those files exist. The
        // same allowlist already softens markdown links (part a) — honor it
        // here so `pop <domain> --help` can cite the guide pre-emptively.
        if (KNOWN_MISSING_LINK_TARGETS.has(docPath)) continue;
        if (!fs.existsSync(path.join(ROOT, docPath))) {
          problems.push({ file: rel(file), line: i + 1, detail: `missing doc path: ${docPath}` });
        }
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const mdFiles: string[] = [];
  for (const name of [
    'README.md', 'ABOUT.md', 'CONTRIBUTING.md', 'AGENTS.md',
    path.join('reports', 'README.md'),
    path.join('packages', 'agent', 'README.md'),
    path.join('packages', 'agent', 'CLAUDE.md'),
  ]) {
    const full = path.join(ROOT, name);
    if (fs.existsSync(full)) mdFiles.push(full);
  }
  mdFiles.push(...walk(path.join(ROOT, 'docs'), '.md'));
  // The agent package's docs moved here in the @poa-box/cli / @poa-box/agent split —
  // they broke silently because this scan did not follow them.
  mdFiles.push(...walk(path.join(ROOT, 'packages', 'agent', 'docs'), '.md'));

  const codeFiles: string[] = [
    ...walk(path.join(ROOT, 'src'), '.ts'),
    ...walk(path.join(ROOT, '.claude', 'skills'), '.md'),
  ];
  const agentScripts = path.join(ROOT, 'agent', 'scripts');
  if (fs.existsSync(agentScripts)) {
    for (const entry of fs.readdirSync(agentScripts)) {
      if (entry.endsWith('.mjs')) codeFiles.push(path.join(agentScripts, entry));
    }
  }

  const warnings: Problem[] = [];
  const linkProblems = checkMarkdownLinks(mdFiles, warnings);
  const pathProblems = checkDocPathReferences(codeFiles);
  const problems = [...linkProblems, ...pathProblems];

  for (const w of warnings) {
    console.warn(`  WARN ${w.file}:${w.line}  ${w.detail} (known-missing, see KNOWN_MISSING_LINK_TARGETS)`);
  }
  if (problems.length > 0) {
    console.error(`check-doc-links: ${problems.length} broken reference(s)\n`);
    for (const p of problems) {
      console.error(`  ${p.file}:${p.line}  ${p.detail}`);
    }
    process.exit(1);
  }
  console.log(
    `check-doc-links OK (${mdFiles.length} markdown files, ${codeFiles.length} code files scanned)`,
  );
}

main();
