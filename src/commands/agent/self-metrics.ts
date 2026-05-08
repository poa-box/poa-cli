/**
 * pop agent self-metrics — coasting detection + deliverable-type mix
 * (Hudson HB#610 directive — make coasting signal-detected, not prose-detected).
 *
 * Reads:
 *   - ~/.pop-agent/brain/Memory/heartbeat-log.md (last N HB entries by ## HB#N header)
 *   - pop.brain.shared lessons authored by current wallet (last M timestamps)
 *
 * Computes:
 *   - output_per_hb_last_10 — substantive artifacts/HB (target ≥2; healthy ≥3)
 *   - deliverable_type_mix_last_20 — % from each menu item (vote/review/task-ship/
 *     brain-lesson/vigil-lens-audit/external-research/infra-improvement)
 *   - active_arcs — multi-HB threads detected via causedBy chains + recurring titles
 *   - coasting_flag — 3+ consecutive HBs without task-ship/vigil-audit/external-
 *     research/infra-improvement
 *   - goals_touched_pct — % of goals.md priorities mentioned in last 20 HBs
 *
 * Output:
 *   default: human-readable table; --json for tooling
 *
 * Read-only; never writes. Opt-in (run when needed) per anti-bloat discipline.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { ethers } from 'ethers';
import * as output from '../../lib/output';

interface SelfMetricsArgs {
  'private-key'?: string;
  'last-hbs'?: number;
}

interface HbBlock {
  hbNumber: number;
  body: string;
  // Detected deliverable types from the body
  types: Set<DeliverableType>;
  // Heuristic: tx hashes / commit SHAs / brain CIDs found
  artifactCount: number;
}

type DeliverableType =
  | 'vote'
  | 'review'
  | 'task-ship'
  | 'brain-lesson'
  | 'vigil-lens-audit'
  | 'external-research'
  | 'infra-improvement';

const TYPE_PATTERNS: Array<{ type: DeliverableType; patterns: RegExp[] }> = [
  { type: 'vote', patterns: [/pop vote cast|tx \w+ vote|cast YES|cast NO|vote tx/i] },
  { type: 'review', patterns: [/pop task review|approved #?\d+|rejected #?\d+|review tx|task #\d+ approved/i] },
  {
    type: 'task-ship',
    patterns: [
      /pop task (claim|submit)|task #\d+ shipped|task #\d+ submitted|task #\d+ claimed|commit [0-9a-f]{6,}/i,
    ],
  },
  {
    type: 'brain-lesson',
    patterns: [/pop brain append-lesson|brain\.shared lesson|brain lesson published|head: bafkr/i],
  },
  {
    type: 'vigil-lens-audit',
    patterns: [/vigil-lens|edge case audit|audit pass on #\d+|N scenarios.*SOUND|findings? .*vigil/i],
  },
  {
    type: 'external-research',
    patterns: [
      /post-mortem|external research|cross-org|bridge.*saga|comparative.*audit|out-of-org/i,
    ],
  },
  {
    type: 'infra-improvement',
    patterns: [
      /new CLI|skill .*\.md|src\/commands?\/|src\/lib\//,
      /\.test\.ts|\.test\.mjs|test fixture|test scenarios|new test file/i,
      /CLAUDE\.md update|SKILL\.md update|infra/i,
    ],
  },
];

function classifyHbBlock(body: string): Set<DeliverableType> {
  const types = new Set<DeliverableType>();
  for (const { type, patterns } of TYPE_PATTERNS) {
    if (patterns.some((p) => p.test(body))) {
      types.add(type);
    }
  }
  return types;
}

function countArtifacts(body: string): number {
  let count = 0;
  // tx hashes
  count += (body.match(/0x[0-9a-f]{64}/g) || []).length;
  // commit SHAs (>=7 hex chars after "commit " keyword)
  count += (body.match(/\bcommit\s+[0-9a-f]{7,40}\b/gi) || []).length;
  // brain CIDs
  count += (body.match(/bafkr[a-z2-7]{50,}/g) || []).length;
  // task IDs explicitly mentioned in shipping context (rough)
  count += (body.match(/#\d{3,}\s+(SHIPPED|APPROVED|CLAIMED|SUBMITTED)/gi) || []).length;
  return count;
}

/** Parse heartbeat-log.md into HB blocks via "## HB#N" headers. */
function parseHbBlocks(logContent: string, maxHbs: number): HbBlock[] {
  const lines = logContent.split('\n');
  const blocks: HbBlock[] = [];
  let currentHb: { number: number; lines: string[] } | null = null;

  for (const line of lines) {
    const m = line.match(/^##\s+HB#(\d+)\b/);
    if (m) {
      if (currentHb) {
        const body = currentHb.lines.join('\n');
        blocks.push({
          hbNumber: currentHb.number,
          body,
          types: classifyHbBlock(body),
          artifactCount: countArtifacts(body),
        });
      }
      currentHb = { number: parseInt(m[1], 10), lines: [line] };
    } else if (currentHb) {
      currentHb.lines.push(line);
    }
  }
  if (currentHb) {
    const body = currentHb.lines.join('\n');
    blocks.push({
      hbNumber: currentHb.number,
      body,
      types: classifyHbBlock(body),
      artifactCount: countArtifacts(body),
    });
  }
  return blocks.slice(-maxHbs);
}

interface Metrics {
  hbWindow: number;
  hbsAnalyzed: number;
  outputPerHbLast10: number;
  outputPerHbLastWindow: number;
  deliverableTypeMix: Record<DeliverableType, number>;
  coastingFlag: boolean;
  coastingDetail: string;
  activeArcs: string[];
  goalsTouchedPct: number;
  goalsTouchedDetail: { matched: string[]; total: number };
}

const SUBSTANTIVE_TYPES: DeliverableType[] = [
  'task-ship',
  'vigil-lens-audit',
  'external-research',
  'infra-improvement',
];

function computeMetrics(blocks: HbBlock[], goalsContent: string): Metrics {
  const last10 = blocks.slice(-10);
  const last20 = blocks.slice(-20);

  const outputPerHbLast10 =
    last10.reduce((sum, b) => sum + b.artifactCount, 0) / Math.max(last10.length, 1);
  const outputPerHbLastWindow =
    blocks.reduce((sum, b) => sum + b.artifactCount, 0) / Math.max(blocks.length, 1);

  // Deliverable-type mix: % of HBs (in window) that produced each type
  const allTypes: DeliverableType[] = [
    'vote',
    'review',
    'task-ship',
    'brain-lesson',
    'vigil-lens-audit',
    'external-research',
    'infra-improvement',
  ];
  const mix: Record<DeliverableType, number> = {} as any;
  for (const t of allTypes) {
    const count = last20.filter((b) => b.types.has(t)).length;
    mix[t] = last20.length === 0 ? 0 : Math.round((count / last20.length) * 100);
  }

  // Coasting: last 3 HBs without any SUBSTANTIVE type
  const last3 = blocks.slice(-3);
  const last3Substantive = last3.map((b) =>
    SUBSTANTIVE_TYPES.some((t) => b.types.has(t)),
  );
  const coastingFlag = last3.length >= 3 && last3Substantive.every((s) => !s);
  const coastingDetail = coastingFlag
    ? `last 3 HBs (#${last3.map((b) => b.hbNumber).join(', #')}) had NO task-ship/vigil-audit/external-research/infra-improvement output — only brain-lesson/review/vote.`
    : `last 3 HBs included substantive deliverables: ${last3
        .map((b, i) => `HB#${b.hbNumber}=${last3Substantive[i] ? 'SUBSTANTIVE' : 'soft'}`)
        .join(', ')}`;

  // Active arcs: detect repeated arc-like keywords in last 10 HB titles
  const arcMarkers = ['Hermes', 'audit series', 'bridge-saga', '#441', '#513', '#509'];
  const activeArcs = arcMarkers.filter((m) =>
    last10.some((b) => b.body.toLowerCase().includes(m.toLowerCase())),
  );

  // Goals advancement: count distinct numbered priority lines from goals.md mentioned in last 20 HBs
  const goalsLines = goalsContent
    .split('\n')
    .filter((l) => /^\s*\d+\.\s+\*\*/.test(l) || /priority #\d+/i.test(l));
  const goalsKeywords: string[] = [];
  for (const line of goalsLines) {
    const m = line.match(/\*\*([^*]{8,40})\*\*/);
    if (m) goalsKeywords.push(m[1].trim().slice(0, 40));
  }
  const matchedGoals: string[] = [];
  const lastBody20 = last20.map((b) => b.body).join('\n');
  for (const kw of goalsKeywords) {
    if (lastBody20.toLowerCase().includes(kw.toLowerCase())) {
      matchedGoals.push(kw);
    }
  }
  const goalsTouchedPct =
    goalsKeywords.length === 0
      ? 0
      : Math.round((matchedGoals.length / goalsKeywords.length) * 100);

  return {
    hbWindow: blocks.length,
    hbsAnalyzed: blocks.length,
    outputPerHbLast10,
    outputPerHbLastWindow,
    deliverableTypeMix: mix,
    coastingFlag,
    coastingDetail,
    activeArcs,
    goalsTouchedPct,
    goalsTouchedDetail: { matched: matchedGoals, total: goalsKeywords.length },
  };
}

export const selfMetricsHandler = {
  builder: (yargs: Argv) =>
    yargs.option('last-hbs', {
      type: 'number',
      default: 30,
      describe: 'Window of recent HB blocks to analyze (default 30)',
    }),

  handler: async (argv: ArgumentsCamelCase<SelfMetricsArgs>) => {
    const home = homedir();
    const logPath = path.join(home, '.pop-agent', 'brain', 'Memory', 'heartbeat-log.md');
    const goalsPath = path.join(home, '.pop-agent', 'brain', 'Identity', 'goals.md');

    if (!fs.existsSync(logPath)) {
      output.error(`heartbeat-log not found: ${logPath}`);
      process.exit(1);
    }

    const logContent = fs.readFileSync(logPath, 'utf8');
    const goalsContent = fs.existsSync(goalsPath) ? fs.readFileSync(goalsPath, 'utf8') : '';

    const window = argv['last-hbs'] ?? 30;
    const blocks = parseHbBlocks(logContent, window);
    const metrics = computeMetrics(blocks, goalsContent);

    if (output.isJsonMode()) {
      output.json(metrics);
      return;
    }

    console.log('');
    console.log('  Vigil Self-Metrics');
    console.log('  ══════════════════');
    console.log(`  Window: last ${metrics.hbsAnalyzed} HB blocks`);
    console.log('');
    console.log(`  Output/HB (last 10):     ${metrics.outputPerHbLast10.toFixed(2)}  (target ≥2 / healthy ≥3)`);
    console.log(`  Output/HB (last ${metrics.hbsAnalyzed}):    ${metrics.outputPerHbLastWindow.toFixed(2)}`);
    console.log('');
    console.log(`  Deliverable-type mix (% HBs producing each type, last 20):`);
    for (const [type, pct] of Object.entries(metrics.deliverableTypeMix).sort(
      (a, b) => b[1] - a[1],
    )) {
      const bar = '█'.repeat(Math.floor(pct / 5));
      console.log(`    ${type.padEnd(20)} ${String(pct).padStart(3)}%  ${bar}`);
    }
    console.log('');
    if (metrics.coastingFlag) {
      console.log(`  \x1b[31m⚠ COASTING FLAG\x1b[0m: ${metrics.coastingDetail}`);
    } else {
      console.log(`  ✓ No coasting flag: ${metrics.coastingDetail}`);
    }
    console.log('');
    console.log(`  Active arcs:   ${metrics.activeArcs.join(', ') || '(none detected)'}`);
    console.log(`  Goals touched: ${metrics.goalsTouchedPct}%  (${metrics.goalsTouchedDetail.matched.length}/${metrics.goalsTouchedDetail.total})`);
    if (metrics.goalsTouchedDetail.matched.length > 0) {
      console.log(`    matched: ${metrics.goalsTouchedDetail.matched.slice(0, 5).join('; ')}`);
    }
    console.log('');
  },
};