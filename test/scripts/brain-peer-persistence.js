#!/usr/bin/env node
/**
 * Brain layer — persistent PeerId regression guard (Task #317).
 *
 * Verifies that the libp2p PeerId persists across CLI invocations against
 * the same POP_BRAIN_HOME, that fresh boots correctly report 'freshly-
 * generated', that subsequent boots correctly report 'persisted' with the
 * SAME peerId, that a missing peer-key.json file falls through to fresh
 * generation, and that a corrupt peer-key.json file ALSO falls through to
 * fresh generation (instead of crashing the node).
 *
 * Why a standalone node script instead of vitest:
 *   brain.ts uses `new Function('s','return import(s)')` to bridge CJS →
 *   ESM-only deps (helia, libp2p, blockstore-fs). Vitest's VM isolation
 *   refuses to resolve that dynamic import (ERR_VM_DYNAMIC_IMPORT_CALLBACK_
 *   MISSING). Plain node against dist/ resolves it natively. Lesson learned
 *   on #295 — same plumbing used here.
 *
 * Run:  node test/scripts/brain-peer-persistence.js
 * Or:   yarn test:peer-persistence
 */

'use strict';

const { execSync } = require('child_process');
const {
  mkdtempSync,
  rmSync,
  existsSync,
  unlinkSync,
  writeFileSync,
} = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

let failures = 0;

function pass(label) { console.log(`  ✓ ${label}`); }
function fail(label, detail) {
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`     ${detail}`);
  failures += 1;
}

function statusJson(brainHome) {
  const out = execSync(
    `node dist/index.js brain status --json`,
    { env: { ...process.env, POP_BRAIN_HOME: brainHome }, encoding: 'utf8' },
  );
  // brain status may print spinner / log lines before the JSON; take the last line.
  const lines = out.trim().split('\n').filter(l => l.trim().startsWith('{'));
  if (lines.length === 0) {
    throw new Error(`no JSON line in status output:\n${out}`);
  }
  return JSON.parse(lines[lines.length - 1]);
}

async function main() {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'pop-brain-peer-'));
  try {
    console.log(`[brain-peer-persistence] tmpRoot=${tmpRoot}`);

    // 1. First run — fresh generate.
    console.log('\n[1] first boot (no key file) — expect freshly-generated');
    const r1 = statusJson(tmpRoot);
    if (r1.peerIdSource === 'freshly-generated') pass('peerIdSource=freshly-generated on first boot');
    else fail('peerIdSource=freshly-generated on first boot', `got ${r1.peerIdSource}`);
    if (r1.peerId && r1.peerId.startsWith('12D3KooW')) pass('peerId is a valid Ed25519 libp2p PeerId');
    else fail('peerId is a valid Ed25519 libp2p PeerId', `got ${r1.peerId}`);
    const keyFilePath = join(tmpRoot, 'peer-key.json');
    if (existsSync(keyFilePath)) pass('peer-key.json was written to POP_BRAIN_HOME');
    else fail('peer-key.json was written to POP_BRAIN_HOME', `expected at ${keyFilePath}`);

    // 2. Second run — should reuse.
    console.log('\n[2] second boot (key file present) — expect persisted with SAME peerId');
    const r2 = statusJson(tmpRoot);
    if (r2.peerIdSource === 'persisted') pass('peerIdSource=persisted on second boot');
    else fail('peerIdSource=persisted on second boot', `got ${r2.peerIdSource}`);
    if (r2.peerId === r1.peerId) pass('peerId matches first boot (persistence works)');
    else fail('peerId matches first boot', `got ${r2.peerId} expected ${r1.peerId}`);

    // 3. Delete key file — should re-generate fresh.
    console.log('\n[3] third boot after deleting key file — expect freshly-generated again');
    unlinkSync(keyFilePath);
    const r3 = statusJson(tmpRoot);
    if (r3.peerIdSource === 'freshly-generated') pass('peerIdSource=freshly-generated after key deletion');
    else fail('peerIdSource=freshly-generated after key deletion', `got ${r3.peerIdSource}`);
    if (r3.peerId !== r1.peerId) pass('new peerId differs from original (fresh key)');
    else fail('new peerId differs from original', 'still got the same peerId — key did not regenerate');
    if (existsSync(keyFilePath)) pass('peer-key.json regenerated on disk');
    else fail('peer-key.json regenerated on disk');

    // 4. Corrupt the key file — should fall through to fresh generation.
    console.log('\n[4] fourth boot after corrupting key file — expect graceful fresh fallback');
    writeFileSync(keyFilePath, '{not valid json');
    const r4 = statusJson(tmpRoot);
    if (r4.peerIdSource === 'freshly-generated') pass('peerIdSource=freshly-generated on corrupt key (graceful fallback)');
    else fail('peerIdSource=freshly-generated on corrupt key', `got ${r4.peerIdSource} — node may have crashed instead of falling back`);
    if (r4.peerId !== r3.peerId) pass('corrupt-fallback peerId is fresh (differs from r3)');
    else fail('corrupt-fallback peerId is fresh', 'got the same peerId as r3 somehow');
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }

  if (failures === 0) {
    console.log('\n✅ brain-peer-persistence: ALL ASSERTIONS PASSED');
    process.exit(0);
  } else {
    console.log(`\n❌ brain-peer-persistence: ${failures} FAILURE(S)`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\n❌ brain-peer-persistence: SCRIPT ERROR');
  console.error(err && err.stack || err);
  process.exit(1);
});
