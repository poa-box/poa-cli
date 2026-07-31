#!/usr/bin/env node
/**
 * Same-machine two-daemon acceptance test (HB#324 ship-2).
 *
 * Spawns two brain daemons on the same machine with DIFFERENT
 * POP_BRAIN_HOMEs (so they have separate blockstores, peer keys,
 * manifests, etc.). Each daemon runs its own libp2p instance on a
 * random loopback TCP port. mDNS discovers them over the local
 * network interface; loopback may not propagate mDNS on all
 * platforms, so as a fallback the test reads daemon B's PeerId +
 * multiaddrs from its log and explicitly dials from daemon A.
 *
 * Test flow:
 *
 *   1. Start daemon A (POP_BRAIN_HOME = /tmp/pop-brain-test-a)
 *   2. Start daemon B (POP_BRAIN_HOME = /tmp/pop-brain-test-b)
 *   3. Wait up to 20s for A and B to see each other as gossipsub peers
 *      on pop/brain/shared/v1 (via rebroadcast + mDNS/explicit dial)
 *   4. Append a lesson to A's brain via routedDispatch (which talks to
 *      daemon A's IPC)
 *   5. Within 90s (enough for A to publish + B to receive via rebroadcast),
 *      verify the lesson shows up in B's local replica via routedDispatch
 *      (which talks to daemon B's IPC → daemon B calls readBrainDoc and
 *      returns the current state; for this test we read via the filesystem
 *      manifest + block fetch because readDoc over IPC is ship-3)
 *
 * Exit codes:
 *   0  — success: lesson propagated A → B
 *   1  — failure: spawn error, timeout, or lesson missing from B
 *
 * Env hooks:
 *   POP_PRIVATE_KEY     required — used by both daemons as the author
 *   POP_DEFAULT_ORG     required — brain-membership.ts falls back to this
 *   POP_DEFAULT_CHAIN   required — subgraph chain id
 *   WAIT_MS             optional — override the propagation wait (default 90000)
 *
 * Cleanup: the two POP_BRAIN_HOME directories are removed on success and on
 * failure so re-runs start clean. Daemons are stopped via SIGTERM in a
 * try/finally so nothing is leaked.
 */

const { spawn, spawnSync } = require('child_process');
const { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const REPO = join(__dirname, '..', '..');
const CLI = join(REPO, 'dist', 'index.js');

// Load env the same way the CLI does: ~/.pop-agent/.env first, then .env
// in repo root. Each line is KEY=VALUE; lines starting with # are comments.
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
    // Strip surrounding quotes if present.
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}
loadDotEnv(join(homedir(), '.pop-agent', '.env'));
loadDotEnv(join(REPO, '.env'));

const HOME_A = '/tmp/pop-brain-test-a';
const HOME_B = '/tmp/pop-brain-test-b';
const WAIT_MS = parseInt(process.env.WAIT_MS || '90000', 10);

function log(tag, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function cliSync(env, args, opts = {}) {
  const res = spawnSync(
    process.execPath,
    [CLI, ...args],
    {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      ...opts,
    },
  );
  return res;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForDaemonSocket(home, timeoutMs = 15_000) {
  const sockPath = join(home, 'daemon.sock');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(sockPath)) return true;
    await sleep(200);
  }
  throw new Error(`Daemon socket never appeared at ${sockPath} within ${timeoutMs}ms`);
}

async function daemonStart(home, label, extraEnv = {}) {
  mkdirSync(home, { recursive: true });
  const env = { POP_BRAIN_HOME: home, ...extraEnv };
  const peers = extraEnv.POP_BRAIN_PEERS;
  log(label, `starting daemon with POP_BRAIN_HOME=${home}` + (peers ? ` POP_BRAIN_PEERS=${peers}` : ''));
  const res = cliSync(env, ['brain', 'daemon', 'start']);
  if (res.status !== 0) {
    throw new Error(`daemon start failed: ${res.stdout}\n${res.stderr}`);
  }
  await waitForDaemonSocket(home);
  log(label, `socket live at ${home}/daemon.sock`);
}

async function daemonStop(home, label) {
  const env = { POP_BRAIN_HOME: home };
  log(label, `stopping daemon`);
  const res = cliSync(env, ['brain', 'daemon', 'stop']);
  if (res.status !== 0 && !/not running/i.test(res.stdout + res.stderr)) {
    log(label, `stop returned exit ${res.status}: ${res.stdout} ${res.stderr}`);
  }
}

async function daemonStatus(home) {
  const env = { POP_BRAIN_HOME: home };
  const res = cliSync(env, ['brain', 'daemon', 'status', '--json']);
  if (res.status !== 0) {
    throw new Error(`status failed: ${res.stdout} ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

/**
 * Send a raw IPC request to a daemon by connecting directly to its
 * Unix socket. Used for methods like `dial` that don't (yet) have a
 * dedicated CLI surface.
 */
async function sendIpc(home, method, params = {}) {
  const net = require('net');
  const sockPath = join(home, 'daemon.sock');
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`IPC timeout talking to ${sockPath}`));
    }, 10_000);
    let connected = false;
    socket.on('connect', () => {
      connected = true;
      socket.write(JSON.stringify({ id: Date.now().toString(), method, params }) + '\n');
    });
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        try {
          const res = JSON.parse(buf.slice(0, nl));
          socket.end();
          if (res.error) reject(new Error(res.error));
          else resolve(res.result);
        } catch (err) {
          reject(err);
        }
      }
    });
    socket.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function appendLesson(home, label, title, body) {
  const env = { POP_BRAIN_HOME: home };
  log(label, `appending lesson "${title}" via routedDispatch`);
  const res = cliSync(env, [
    'brain', 'append-lesson',
    '--doc', 'pop.brain.shared',
    '--title', title,
    '--body', body,
    '--json',
  ]);
  if (res.status !== 0) {
    throw new Error(`append-lesson failed: ${res.stdout} ${res.stderr}`);
  }
  const parsed = JSON.parse(res.stdout);
  log(label, `lesson id=${parsed.lessonId} head=${parsed.headCid} routed=${parsed.routedViaDaemon}`);
  return parsed;
}

async function readLessons(home, label) {
  const env = { POP_BRAIN_HOME: home };
  const res = cliSync(env, ['brain', 'read', '--doc', 'pop.brain.shared']);
  if (res.status !== 0) {
    // Might be "no local head yet" which is a valid empty-state.
    if (/no local head|not-found/i.test(res.stdout + res.stderr)) return { lessons: [] };
    throw new Error(`brain read failed: ${res.stdout} ${res.stderr}`);
  }
  // Output is pretty-printed with a banner then JSON. Extract the JSON.
  const m = /\{[\s\S]*\}/.exec(res.stdout);
  if (!m) {
    return { lessons: [] };
  }
  return JSON.parse(m[0]);
}

async function main() {
  // Clean any prior test state.
  for (const home of [HOME_A, HOME_B]) {
    if (existsSync(home)) {
      log('setup', `cleaning ${home}`);
      rmSync(home, { recursive: true, force: true });
    }
  }

  if (!process.env.POP_PRIVATE_KEY) {
    throw new Error('POP_PRIVATE_KEY must be set for this test');
  }

  // Allowlist both daemons' authors. Since both use the same
  // POP_PRIVATE_KEY, the author is the same; we just need to seed the
  // static allowlist in each brain home so each daemon will accept
  // writes from the shared key. The static allowlist lives under the
  // REPO's agent/brain/Config/brain-allowlist.json — NOT per-home — so
  // as long as the CLI runs from the repo root (which we do via env),
  // both daemons will pick up the existing allowlist.

  let failed = false;
  try {
    // 1. Start daemon B first (no peers yet — it's the listener).
    await daemonStart(HOME_B, 'B');

    // 2. Read daemon B's listen addrs so we can pass them to daemon A
    //    via POP_BRAIN_PEERS (task #349 ship). No more manual dial IPC.
    await sleep(2_000); // small wait for listenAddrs to be populated
    const statusB0 = await daemonStatus(HOME_B);
    log('B', `peerId=${statusB0.peerId}`);
    log('B', `listenAddrs=${(statusB0.listenAddrs || []).join(', ')}`);
    const loopbackAddrs = (statusB0.listenAddrs || [])
      .filter(a => a.startsWith('/ip4/127.0.0.1/') || a.startsWith('/ip4/0.0.0.0/'))
      .map(a => a.replace('/ip4/0.0.0.0/', '/ip4/127.0.0.1/'));
    if (loopbackAddrs.length === 0) {
      throw new Error(`Daemon B has no loopback multiaddrs: ${(statusB0.listenAddrs || []).join(', ')}`);
    }

    // 3. Start daemon A with POP_BRAIN_PEERS set. Auto-dial runs inside
    //    daemon startup — no manual dial IPC call needed.
    log('wire', `daemon A starts with POP_BRAIN_PEERS=${loopbackAddrs[0]}`);
    await daemonStart(HOME_A, 'A', { POP_BRAIN_PEERS: loopbackAddrs[0] });
    const statusA0 = await daemonStatus(HOME_A);
    log('A', `peerId=${statusA0.peerId}`);
    log('A', `listenAddrs=${(statusA0.listenAddrs || []).join(', ')}`);

    // Give the gossipsub mesh a moment to form after auto-dial.
    await sleep(3_000);

    const statusA1 = await daemonStatus(HOME_A);
    const statusB1 = await daemonStatus(HOME_B);
    log('A', `after auto-dial: connections=${statusA1.connections} knownPeers=${statusA1.knownPeerCount}`);
    log('B', `after auto-dial: connections=${statusB1.connections} knownPeers=${statusB1.knownPeerCount}`);

    // 3. Append a lesson via daemon A.
    const title = `two-daemon test ${Date.now()}`;
    const body = `This lesson was written via daemon A's IPC and should propagate to daemon B within ${WAIT_MS}ms via gossipsub + rebroadcast.`;
    const written = await appendLesson(HOME_A, 'A', title, body);

    // 4. Poll daemon B's brain read every 5s for up to WAIT_MS. Expect
    //    to find the new lesson with the same id.
    const deadline = Date.now() + WAIT_MS;
    let found = null;
    while (Date.now() < deadline) {
      const doc = await readLessons(HOME_B, 'B');
      const hit = (doc.lessons || []).find(l => l && l.id === written.lessonId);
      if (hit) {
        found = hit;
        break;
      }
      const active = (doc.lessons || []).filter(l => !l.removed).length;
      log('B', `waiting… ${active} lessons visible, target id=${written.lessonId} not yet here`);
      await sleep(5_000);
    }

    if (!found) {
      failed = true;
      log('FAIL', `lesson ${written.lessonId} did NOT propagate from A → B within ${WAIT_MS}ms`);
      log('FAIL', 'dumping daemon stats:');
      const statusA = await daemonStatus(HOME_A);
      const statusB = await daemonStatus(HOME_B);
      console.log('A status:', JSON.stringify(statusA, null, 2));
      console.log('B status:', JSON.stringify(statusB, null, 2));
    } else {
      log('PASS', `lesson ${written.lessonId} propagated A → B successfully`);
      log('PASS', `  title="${found.title}"`);
      log('PASS', `  author=${found.author}`);
      log('PASS', `  timestamp=${found.timestamp}`);
    }
  } catch (err) {
    failed = true;
    log('ERROR', err.message);
    if (err.stack) console.error(err.stack);
  } finally {
    // Best-effort cleanup.
    try { await daemonStop(HOME_A, 'A'); } catch {}
    try { await daemonStop(HOME_B, 'B'); } catch {}
    // Leave the brain homes on failure for post-mortem; remove on success.
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
  console.error('unhandled error:', err);
  process.exit(1);
});
