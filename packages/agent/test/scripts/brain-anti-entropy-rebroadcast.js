#!/usr/bin/env node
/**
 * Brain layer — T1 anti-entropy rebroadcast integration test (task #429).
 *
 * Demonstrates that the rebroadcast loop recovers the HB#322 "offline peer
 * misses the announcement" failure mode. Based on the two-daemon test
 * pattern from brain-daemon-two-instances.js.
 *
 * SCENARIO (per task #429 acceptance criteria):
 *   1. Start daemon A (isolated POP_BRAIN_HOME_A).
 *   2. Append a lesson via daemon A. A publishes the head announcement.
 *   3. Stop daemon A. The head is in A's blockstore but the gossipsub
 *      announcement has no live receivers — the announcement is gone.
 *   4. Start daemon B (isolated POP_BRAIN_HOME_B, empty manifest).
 *      Demonstrates the pre-T1 failure: B has no way to learn about A's
 *      lesson because gossipsub missed it.
 *   5. Restart daemon A with a short POP_BRAIN_REBROADCAST_INTERVAL_MS
 *      (3000 in this test for speed; production default is 60000).
 *   6. Within WAIT_MS, A's rebroadcast tick re-publishes the head and B
 *      receives + merges it. `pop brain read` on B now shows the lesson.
 *
 * Exit codes:
 *   0  — success: lesson propagated A → B via rebroadcast after restart
 *   1  — failure: lesson still missing from B after WAIT_MS
 *
 * Env hooks:
 *   POP_PRIVATE_KEY     required — author key (both daemons use the same)
 *   POP_DEFAULT_ORG     required — subgraph membership resolution
 *   POP_DEFAULT_CHAIN   required
 *   WAIT_MS             optional — override propagation wait (default 45000)
 *
 * Cleanup: both brain homes and their daemons are torn down in a
 * try/finally so re-runs start clean regardless of pass/fail.
 *
 * Run:  node test/scripts/brain-anti-entropy-rebroadcast.js
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const { mkdirSync, rmSync, existsSync, readFileSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const REPO = join(__dirname, '..', '..');
const CLI = join(REPO, 'dist', 'index.js');

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(join(homedir(), '.pop-agent', '.env'));
loadDotEnv(join(REPO, '.env'));

const HOME_A = '/tmp/pop-brain-t1-a';
const HOME_B = '/tmp/pop-brain-t1-b';
const WAIT_MS = parseInt(process.env.WAIT_MS || '45000', 10);
const SHORT_INTERVAL_MS = 3000;  // Speed up rebroadcast for the test.

function log(tag, msg) {
  console.error(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function resetHome(path) {
  if (existsSync(path)) {
    try { rmSync(path, { recursive: true, force: true }); } catch {}
  }
  mkdirSync(path, { recursive: true });
}

function daemonEnv(home) {
  return {
    ...process.env,
    POP_BRAIN_HOME: home,
    POP_BRAIN_REBROADCAST_INTERVAL_MS: String(SHORT_INTERVAL_MS),
    POP_BRAIN_REBROADCAST_JITTER: '0.2',
    POP_BRAIN_REBROADCAST_GRACE_MS: '1000',
  };
}

function spawnDaemon(tag, home) {
  log(tag, `starting daemon (home=${home})`);
  const child = spawn(process.execPath, [CLI, 'brain', 'daemon', '__run'], {
    env: daemonEnv(home),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  child.stdout.on('data', d => {});
  child.stderr.on('data', d => {});
  return child;
}

async function waitForLessonInHome(home, title, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const out = spawnSync(process.execPath, [CLI, 'brain', 'read', '--doc', 'pop.brain.shared', '--json'], {
      env: { ...process.env, POP_BRAIN_HOME: home },
      encoding: 'utf8',
    });
    if (out.status === 0 && out.stdout.includes(title)) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

function stopDaemon(child, tag) {
  if (!child || child.killed) return;
  log(tag, 'sending SIGTERM');
  try { child.kill('SIGTERM'); } catch {}
}

async function main() {
  if (!process.env.POP_PRIVATE_KEY) {
    log('setup', 'POP_PRIVATE_KEY missing — skipping');
    process.exit(0);
  }

  resetHome(HOME_A);
  resetHome(HOME_B);

  let daemonA = null;
  let daemonB = null;

  try {
    // --- Phase 1: daemon A alone writes a lesson ---
    daemonA = spawnDaemon('A', HOME_A);
    await new Promise(r => setTimeout(r, 4000));

    const title = `t1-anti-entropy-test-${Date.now()}`;
    log('A', `appending lesson "${title}"`);
    const append = spawnSync(
      process.execPath,
      [CLI, 'brain', 'append-lesson', '--doc', 'pop.brain.shared',
       '--title', title, '--body', 'integration test lesson body'],
      { env: { ...process.env, POP_BRAIN_HOME: HOME_A }, encoding: 'utf8' },
    );
    if (append.status !== 0) {
      log('A', `append failed: ${append.stderr}`);
      process.exit(1);
    }

    await new Promise(r => setTimeout(r, 2000));

    // --- Phase 2: stop A; start B in isolation ---
    stopDaemon(daemonA, 'A');
    await new Promise(r => setTimeout(r, 3000));
    daemonA = null;

    daemonB = spawnDaemon('B', HOME_B);
    await new Promise(r => setTimeout(r, 4000));

    // Confirm B does NOT have the lesson (B was started after A stopped —
    // classic offline-during-write failure mode).
    const bHasBeforeRestart = await waitForLessonInHome(HOME_B, title, 3000);
    if (bHasBeforeRestart) {
      log('B', 'UNEXPECTED: lesson visible to B before A restart — test premise broken');
      process.exit(1);
    }
    log('B', 'confirmed B does NOT see lesson (pre-T1 failure mode)');

    // --- Phase 3: restart A; rebroadcast should deliver within WAIT_MS ---
    daemonA = spawnDaemon('A', HOME_A);
    log('test', `awaiting rebroadcast delivery (interval=${SHORT_INTERVAL_MS}ms, budget=${WAIT_MS}ms)`);
    const landed = await waitForLessonInHome(HOME_B, title, WAIT_MS);
    if (!landed) {
      log('FAIL', `lesson did not reach B within ${WAIT_MS}ms — rebroadcast not working`);
      process.exit(1);
    }
    log('PASS', 'lesson reached B after A restart via rebroadcast ✓');
    process.exit(0);
  } finally {
    stopDaemon(daemonA, 'A-cleanup');
    stopDaemon(daemonB, 'B-cleanup');
    await new Promise(r => setTimeout(r, 500));
    try { rmSync(HOME_A, { recursive: true, force: true }); } catch {}
    try { rmSync(HOME_B, { recursive: true, force: true }); } catch {}
  }
}

main().catch(err => {
  log('CRASH', err.stack || err.message);
  process.exit(1);
});
