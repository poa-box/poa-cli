#!/usr/bin/env node
/**
 * Shared-genesis cross-agent propagation test (tasks #350 + #352).
 *
 * History:
 *   1. HB#333 dogfood discovered that fetchAndMergeRemoteHead silently
 *      dropped remote content across disjoint Automerge histories.
 *   2. HB#335 shipped task #350 stopgap: detect disjoint + refuse with
 *      a clear error rather than silently losing data. At that point
 *      this test asserted the REFUSE behavior.
 *   3. HB#337 shipped task #352 real fix: canonical genesis.bin files
 *      in agent/brain/Knowledge/ that every agent loads on first write,
 *      ensuring all docs share a common root so the disjoint case is
 *      UNREACHABLE. This test now asserts the POSITIVE behavior:
 *      content propagates cleanly from A to B.
 *
 * Scenario:
 *   1. Populate daemon A's brain home with a single lesson (first write
 *      loads from pop.brain.shared.genesis.bin → shared root).
 *   2. Populate daemon B's brain home with its own single lesson (ALSO
 *      loads from the same genesis bytes → SAME root as A).
 *   3. Start both daemons, wire via POP_BRAIN_PEERS.
 *   4. Write a SECOND lesson on A. A's daemon publishes to gossipsub;
 *      B's daemon receives and merges (successfully, because both sides
 *      share the genesis root).
 *   5. Assert B's doc contains ALL THREE lessons:
 *      - B's own pre-seed
 *      - A's pre-seed (propagated when B caught up)
 *      - A's second lesson (propagated from this run)
 *      AND daemon B's log shows an "action=merge" line.
 *
 * This is the Sprint 11 priority #4 unblock for "first operator
 * outside the 3-agent core": a fresh agent cloning the repo now
 * shares a root with existing agents, so their first cross-agent
 * merge just works.
 */

const { spawn, spawnSync } = require('child_process');
const { mkdirSync, rmSync, existsSync, readFileSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const REPO = join(__dirname, '..', '..');
const CLI = join(REPO, 'dist', 'index.js');
const HOME_A = '/tmp/pop-brain-disjoint-a';
const HOME_B = '/tmp/pop-brain-disjoint-b';

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

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function cliSync(env, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForSocket(home, timeoutMs = 15000) {
  const sockPath = join(home, 'daemon.sock');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(sockPath)) return;
    await sleep(200);
  }
  throw new Error(`socket never appeared at ${sockPath}`);
}

async function main() {
  // Clean prior state.
  for (const home of [HOME_A, HOME_B]) {
    if (existsSync(home)) rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
  }

  if (!process.env.POP_PRIVATE_KEY) {
    throw new Error('POP_PRIVATE_KEY required');
  }

  let failed = false;
  try {
    // Step 1: pre-seed both brain homes with independent writes BEFORE
    // starting daemons. These writes initialize disjoint Automerge docs.
    log('A', 'pre-seeding with one lesson (disjoint history)');
    const seedA = cliSync(
      { POP_BRAIN_HOME: HOME_A },
      ['brain', 'append-lesson', '--doc', 'pop.brain.shared',
       '--title', 'disjoint-test A seed', '--body', 'A body']
    );
    if (seedA.status !== 0) throw new Error(`A seed failed: ${seedA.stderr}`);

    log('B', 'pre-seeding with one lesson (disjoint history)');
    const seedB = cliSync(
      { POP_BRAIN_HOME: HOME_B },
      ['brain', 'append-lesson', '--doc', 'pop.brain.shared',
       '--title', 'disjoint-test B seed', '--body', 'B body']
    );
    if (seedB.status !== 0) throw new Error(`B seed failed: ${seedB.stderr}`);

    // Step 2: start daemon B (listener).
    log('B', 'starting daemon');
    const startB = cliSync({ POP_BRAIN_HOME: HOME_B }, ['brain', 'daemon', 'start']);
    if (startB.status !== 0) throw new Error(`B start failed: ${startB.stderr}`);
    await waitForSocket(HOME_B);

    // Read daemon B's loopback multiaddr from status.
    const statusB = cliSync({ POP_BRAIN_HOME: HOME_B }, ['brain', 'daemon', 'status', '--json']);
    if (statusB.status !== 0) throw new Error(`B status failed: ${statusB.stderr}`);
    const sB = JSON.parse(statusB.stdout);
    const loopback = (sB.listenAddrs || [])
      .filter(a => a.startsWith('/ip4/127.0.0.1/') || a.startsWith('/ip4/0.0.0.0/'))
      .map(a => a.replace('/ip4/0.0.0.0/', '/ip4/127.0.0.1/'));
    if (loopback.length === 0) throw new Error('no loopback multiaddr for B');
    log('wire', `B multiaddr: ${loopback[0]}`);

    // Step 3: start daemon A with POP_BRAIN_PEERS pointing at B.
    log('A', `starting daemon with POP_BRAIN_PEERS=${loopback[0]}`);
    const startA = cliSync(
      { POP_BRAIN_HOME: HOME_A, POP_BRAIN_PEERS: loopback[0] },
      ['brain', 'daemon', 'start']
    );
    if (startA.status !== 0) throw new Error(`A start failed: ${startA.stderr}`);
    await waitForSocket(HOME_A);
    await sleep(3000); // mesh formation

    // Step 4: write a second lesson on A via routedDispatch through
    // the daemon. This triggers A's daemon to publish a head CID;
    // B's daemon should receive + attempt merge + refuse via the
    // new disjoint-history guard.
    log('A', 'writing second lesson through daemon IPC');
    const write = cliSync(
      { POP_BRAIN_HOME: HOME_A },
      ['brain', 'append-lesson', '--doc', 'pop.brain.shared',
       '--title', 'disjoint-test A second', '--body', 'this should NOT propagate to B']
    );
    if (write.status !== 0) throw new Error(`A write failed: ${write.stderr}`);

    // Wait for the gossipsub announcement + merge attempt on B.
    await sleep(4000);

    // Step 5: assertions.
    // After task #352, both A and B loaded from the same shared genesis
    // bytes on their first write, so their Automerge histories share
    // a common root. B's doc should now contain:
    //   - B's own pre-seed lesson
    //   - A's pre-seed lesson (propagated via the first merge)
    //   - A's second lesson (the one written during this test run)
    const readB = cliSync({ POP_BRAIN_HOME: HOME_B }, ['brain', 'read', '--doc', 'pop.brain.shared']);
    if (readB.status !== 0) throw new Error(`B read failed: ${readB.stderr}`);
    const jsonMatch = /\{[\s\S]*\}/.exec(readB.stdout);
    const bDoc = JSON.parse(jsonMatch[0]);
    const bLessons = (bDoc.lessons || []).filter(l => !l.removed);
    log('assert', `B has ${bLessons.length} lesson(s) after merge`);

    const titles = bLessons.map(l => l.title || '').filter(Boolean);
    const hasBSeed = titles.some(t => t.includes('B seed'));
    const hasASeed = titles.some(t => t.includes('A seed'));
    const hasASecond = titles.some(t => t.includes('A second'));

    if (bLessons.length !== 3) {
      failed = true;
      log('FAIL', `expected B to have exactly 3 lessons after shared-genesis merge, got ${bLessons.length}`);
      log('FAIL', `  lesson ids: ${bLessons.map(l => l.id).join(', ')}`);
    } else if (!hasBSeed || !hasASeed || !hasASecond) {
      failed = true;
      log('FAIL', `expected B to have B's seed + A's seed + A's second lesson`);
      log('FAIL', `  titles: ${titles.join(' | ')}`);
      log('FAIL', `  hasBSeed=${hasBSeed} hasASeed=${hasASeed} hasASecond=${hasASecond}`);
    } else {
      log('PASS', 'B has all 3 lessons: its own seed + A\'s seed + A\'s second lesson');
      log('PASS', '  shared-genesis bootstrap lets disjoint-looking writes merge cleanly');
    }

    // (b) Check B's daemon log for the successful merge line.
    const logB = cliSync({ POP_BRAIN_HOME: HOME_B }, ['brain', 'daemon', 'logs', '--tail', '40']);
    const logText = logB.stdout;
    if (logText.includes('action=merge')) {
      log('PASS', 'B daemon log contains action=merge (post-#352: shared-genesis enables real merge)');
    } else {
      failed = true;
      log('FAIL', 'B daemon log does NOT contain action=merge — merge path may not have fired');
      log('FAIL', `log tail:\n${logText}`);
    }
  } catch (err) {
    failed = true;
    log('ERROR', err.message);
    if (err.stack) console.error(err.stack);
  } finally {
    // Cleanup.
    try { cliSync({ POP_BRAIN_HOME: HOME_A }, ['brain', 'daemon', 'stop']); } catch {}
    try { cliSync({ POP_BRAIN_HOME: HOME_B }, ['brain', 'daemon', 'stop']); } catch {}
    if (!failed) {
      for (const home of [HOME_A, HOME_B]) {
        try { rmSync(home, { recursive: true, force: true }); } catch {}
      }
    } else {
      log('INFO', `brain homes left at ${HOME_A} and ${HOME_B} for post-mortem`);
    }
  }

  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('unhandled:', err);
  process.exit(1);
});
