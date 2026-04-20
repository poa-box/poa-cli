#!/usr/bin/env node
// SAIR aggregator — Smart-Account Implementation Registry MVP
//
// Sprint 21 idea-9 (sentinel HB#855/#857 + vigil HB#500 empirical evidence).
// Iterates `pop org audit-proxy-factory --space <X> --json` across a space list,
// parses delegationTarget fields, aggregates into CSV + summary.
//
// Builds on:
// - audit-proxy-factory v1.5 (sentinel HB#853 — EIP-7702 family classifier)
// - extractEip7702Target() v1.5.1 (vigil HB#491 — delegation-target extraction)
// - HB#500 SAIR empirical evidence artifact
//
// Usage:
//   node agent/scripts/sair-aggregate.js space1 space2 space3 ...
//   node agent/scripts/sair-aggregate.js   (uses built-in 10-space default)
//
// Author: vigil_01, HB#501

const { execFileSync } = require('child_process');
const path = require('path');

const DEFAULT_SPACES = [
  'safe.eth',
  'pooltogether.eth',
  'rocketpool-dao.eth',
  'olympusdao.eth',
  'index-coop.eth',
  'curve.eth',
  'uniswapgovernance.eth',
  'balancer.eth',
  'arbitrumfoundation.eth',
  'gitcoindao.eth',
];

function auditSpace(space) {
  const cli = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
  try {
    const out = execFileSync('node', [cli, 'org', 'audit-proxy-factory', '--space', space, '--json'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const text = out.toString('utf8');
    // Output may have banner lines before the JSON payload. Scan lines bottom-up
    // for the last line that starts with `{` and parses as JSON.
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].startsWith('{')) continue;
      try {
        return JSON.parse(lines[i]);
      } catch {
        // keep looking upward
      }
    }
    throw new Error('no parseable JSON line in audit-proxy-factory output');
  } catch (e) {
    return { status: 'error', target: space, message: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

function main() {
  const args = process.argv.slice(2);
  const spaces = args.length > 0 ? args : DEFAULT_SPACES;

  const rows = []; // {space, voter, delegationTarget}
  const targetAgg = new Map(); // target -> { voters:Set, spaces:Set }
  const spaceStatus = []; // {space, voterCount, eip7702Count, status}

  for (const space of spaces) {
    process.stderr.write(`[sair] auditing ${space}...\n`);
    const r = auditSpace(space);
    if (r.status === 'error') {
      spaceStatus.push({ space, status: 'error', message: r.message });
      continue;
    }
    const voters = Array.isArray(r.voters) ? r.voters : [];
    const eip7702 = voters.filter((v) => v.family === 'eip-7702-delegated-eoa');
    spaceStatus.push({
      space,
      status: r.status,
      voterCount: voters.length,
      eip7702Count: eip7702.length,
    });
    for (const v of eip7702) {
      if (!v.delegationTarget) continue;
      const tgt = v.delegationTarget.toLowerCase();
      rows.push({ space, voter: v.address, delegationTarget: tgt });
      if (!targetAgg.has(tgt)) targetAgg.set(tgt, { voters: new Set(), spaces: new Set() });
      const agg = targetAgg.get(tgt);
      agg.voters.add(v.address.toLowerCase());
      agg.spaces.add(space);
    }
  }

  // CSV output
  console.log('space,voter,delegationTarget');
  for (const r of rows) {
    console.log(`${r.space},${r.voter},${r.delegationTarget}`);
  }

  // Summary
  process.stderr.write('\n=== SAIR summary ===\n');
  process.stderr.write(`Spaces audited: ${spaces.length}\n`);
  process.stderr.write(`Spaces with voters: ${spaceStatus.filter((s) => s.status !== 'error').length}\n`);
  process.stderr.write(`Spaces with EIP-7702 voters: ${spaceStatus.filter((s) => s.eip7702Count > 0).length}\n`);
  process.stderr.write(`Total EIP-7702 voter rows: ${rows.length}\n`);
  process.stderr.write(`Distinct impl targets: ${targetAgg.size}\n`);
  process.stderr.write('\nImpl concentration ranking (by distinct-DAO count):\n');
  const ranked = Array.from(targetAgg.entries())
    .sort((a, b) => b[1].spaces.size - a[1].spaces.size || b[1].voters.size - a[1].voters.size);
  for (const [tgt, agg] of ranked) {
    process.stderr.write(`  ${tgt}  (${agg.voters.size} voter${agg.voters.size === 1 ? '' : 's'}, ${agg.spaces.size} DAO${agg.spaces.size === 1 ? '' : 's'}: ${Array.from(agg.spaces).join(', ')})\n`);
  }
  process.stderr.write('\nPer-space status:\n');
  for (const s of spaceStatus) {
    const detail = s.status === 'error' ? `ERROR ${s.message}` : `${s.voterCount} voters, ${s.eip7702Count} EIP-7702`;
    process.stderr.write(`  ${s.space}: ${detail}\n`);
  }
}

main();
