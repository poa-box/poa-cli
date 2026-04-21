#!/usr/bin/env node
/**
 * HB#572 Task (goals.md priority #3): automates RULE #16 indirect-dark-peer-detection.
 *
 * Queries pop.brain.shared for each known fleet agent's latest lesson
 * timestamp; flags agents whose brain.shared is silent >24h as potential
 * dark-peer candidates. Per RULE #16 (argus HB#578 + vigil HB#542) + RULE
 * #17 (HB#554 channel-independence), this does NOT cross-reference git
 * activity — a separate check. On-chain + git channels can be active while
 * brain CRDT is dark.
 *
 * Usage:
 *   node agent/scripts/fleet-health.js
 *   node agent/scripts/fleet-health.js --threshold-hours 24
 *   node agent/scripts/fleet-health.js --json
 *
 * Exit code: 0 if all agents fresh, 1 if any agent is dark-peer.
 *
 * Example output (human):
 *   Fleet health — 2026-04-21T06:40:00Z
 *   vigil_01     (0x7150aee7...):    0.5h fresh
 *   argus_prime  (0x451563ab...):    0.7h fresh
 *   sentinel_01  (0xc04c8604...):  110.2h  🚨 DARK-PEER (>24h)
 *
 * Per RULE #17: this tool does NOT assert anything about non-brain channels.
 * A dark-peer flag says ONLY that brain CRDT from that agent is silent;
 * on-chain + git may still be active (verify via separate checks).
 */

const { execSync } = require('child_process');

const KNOWN_AGENTS = [
  { name: 'vigil_01', address: '0x7150aee7139cb2ac19c98c33c861b99e998b9a8e' },
  { name: 'argus_prime', address: '0x451563ab9b5b4e8dfaa602f5e7890089edf6bf10' },
  { name: 'sentinel_01', address: '0xc04c860454e73a9ba524783acbc7f7d6f5767eb6' },
];

function parseArgs(argv) {
  const args = { thresholdHours: 24, json: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--threshold-hours' && argv[i + 1]) {
      args.thresholdHours = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--json') {
      args.json = true;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node agent/scripts/fleet-health.js [--threshold-hours N] [--json]');
      process.exit(0);
    }
  }
  return args;
}

function fetchBrainSharedDoc() {
  // Uses pop CLI already in $PATH (assumes cwd is repo root or PATH set).
  // Per RULE #17: pop brain read requires daemon running; if daemon down, this
  // returns empty lessons — the fleet-health tool itself reports "UNKNOWN" for
  // all agents (caller should investigate separately).
  const out = execSync('pop brain read --doc pop.brain.shared --json', {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function computeLatestPerAuthor(doc) {
  const lessons = (doc && doc.doc && doc.doc.lessons) || [];
  const latestByAuthor = new Map();
  for (const l of lessons) {
    const author = (l.author || '').toLowerCase();
    const ts = Number(l.timestamp || 0);
    if (!author || !ts) continue;
    const prev = latestByAuthor.get(author) || 0;
    if (ts > prev) latestByAuthor.set(author, ts);
  }
  return latestByAuthor;
}

function formatHoursAgo(hoursAgo) {
  if (hoursAgo < 1) return `${(hoursAgo * 60).toFixed(0)}m`;
  return `${hoursAgo.toFixed(1)}h`;
}

function main() {
  const args = parseArgs(process.argv);
  let doc;
  try {
    doc = fetchBrainSharedDoc();
  } catch (e) {
    console.error(`fleet-health: failed to read pop.brain.shared: ${e.message}`);
    console.error('  (daemon may be down; restart with `pop brain daemon start`)');
    process.exit(2);
  }
  const latestByAuthor = computeLatestPerAuthor(doc);
  const now = Math.floor(Date.now() / 1000);
  const report = KNOWN_AGENTS.map(agent => {
    const ts = latestByAuthor.get(agent.address.toLowerCase()) || 0;
    const hoursAgo = ts > 0 ? (now - ts) / 3600 : Infinity;
    const darkPeer = hoursAgo > args.thresholdHours;
    return {
      name: agent.name,
      address: agent.address,
      lastBrainLessonTimestamp: ts || null,
      lastBrainLessonIso: ts > 0 ? new Date(ts * 1000).toISOString() : null,
      hoursAgo: isFinite(hoursAgo) ? Number(hoursAgo.toFixed(2)) : null,
      darkPeer,
    };
  });

  const anyDark = report.some(r => r.darkPeer);

  if (args.json) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      thresholdHours: args.thresholdHours,
      agents: report,
      anyDarkPeer: anyDark,
    }, null, 2));
  } else {
    console.log(`Fleet health — ${new Date().toISOString()}`);
    console.log(`Threshold: ${args.thresholdHours}h (per RULE #16)`);
    console.log();
    for (const r of report) {
      const age = r.hoursAgo === null ? 'NEVER' : formatHoursAgo(r.hoursAgo);
      const flag = r.darkPeer ? ' 🚨 DARK-PEER' : ' fresh';
      console.log(`  ${r.name.padEnd(14)} (${r.address.slice(0, 10)}...): ${age.padStart(7)}${flag}`);
    }
    if (anyDark) {
      console.log();
      console.log('Per RULE #17 channel-independence: darkPeer flag indicates BRAIN CRDT silence');
      console.log('ONLY. On-chain + git channels may still be active for that agent. Verify via');
      console.log('`git log --since=24h` or on-chain task activity before inferring agent down.');
    }
  }

  process.exit(anyDark ? 1 : 0);
}

main();
