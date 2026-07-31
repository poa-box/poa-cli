#!/usr/bin/env node
/**
 * Cross-machine brain smoke test — parameterized by ROLE env var.
 *
 * Run this on both sides of a cross-machine test. Machine A runs with
 * ROLE=subscribe; machine B runs with ROLE=publish and (optionally)
 * SUBSCRIBER_ADDR=<A's multiaddr>. After the publish run, either side
 * can run ROLE=verify to check whether the known-value lesson landed.
 *
 * Env vars:
 *   ROLE              subscribe | publish | verify        (required)
 *   POP_BRAIN_HOME    brain state directory                (default: /tmp/brain-xmachine)
 *   POP_PRIVATE_KEY   wallet private key for signing       (required for publish)
 *   SUBSCRIBER_ADDR   /ip4/.../tcp/.../p2p/<peerId>        (optional for publish — skip to use bootstrap-mediated discovery)
 *   XMACHINE_DOC      brain doc id                         (default: test.xmachine)
 *   XMACHINE_TAG      expected tag string to match in verify (default: xmachine-*)
 *
 * Exit codes:
 *   0 — success (subscribe runs until Ctrl-C; publish completes; verify finds the lesson)
 *   1 — failure (bad role, no subscriber found, verify couldn't locate the lesson)
 *
 * This script is part of the PR #9 cross-machine blocker #5 smoke test
 * kit. It does NOT guarantee WAN sync works — it's the instrument that
 * TELLS you whether sync works. The plumbing (persistent PeerId +
 * public bootstrap + Circuit Relay v2 + AutoNAT) is in place via
 * sprint-3 commit 386e034; this script exercises it end-to-end.
 */

const os = require('os');

const ROLE = process.env.ROLE;
const DOC = process.env.XMACHINE_DOC || 'test.xmachine';
const HOME = process.env.POP_BRAIN_HOME;
const HOSTNAME = os.hostname();

async function loadBrain() {
  // Import the compiled brain module from dist/. Assumes the script
  // runs from the repo root (package.json peer) so the relative path
  // resolves.
  const path = require('path');
  const brainPath = path.resolve(__dirname, '..', '..', 'dist', 'lib', 'brain.js');
  return require(brainPath);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function tagFor(unix) {
  return `xmachine-${unix}-${HOSTNAME}`;
}

async function runSubscribe() {
  const brain = await loadBrain();
  console.log(`[subscribe] role=subscribe doc=${DOC} home=${HOME || '(default)'}`);
  const node = await brain.initBrainNode();
  console.log(`[subscribe] local peer: ${node.libp2p.peerId.toString()}`);
  console.log('');
  console.log('[subscribe] listening multiaddrs — copy the one the peer should dial:');
  for (const addr of node.libp2p.getMultiaddrs()) {
    console.log(`  ${addr.toString()}`);
  }
  console.log('');
  console.log(`[subscribe] subscribing to brain topic for "${DOC}" — waiting for announcements...`);
  console.log('[subscribe] Ctrl-C to exit');
  console.log('');

  await brain.subscribeBrainTopic(DOC, (ann, from) => {
    const when = new Date(ann.timestamp * 1000).toISOString();
    console.log(`[${when}] head ${ann.cid}  from ${from}`);
  });

  // Keep the process alive. Graceful shutdown on SIGINT.
  const shutdown = async () => {
    console.log('\n[subscribe] shutting down...');
    await brain.stopBrainNode();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
}

async function runPublish() {
  if (!process.env.POP_PRIVATE_KEY) {
    console.error('[publish] POP_PRIVATE_KEY is required — set it to a hex key that the envelope will be signed with.');
    process.exit(1);
  }

  const brain = await loadBrain();
  const unix = nowSeconds();
  const tag = tagFor(unix);
  console.log(`[publish] role=publish doc=${DOC} home=${HOME || '(default)'} tag=${tag}`);

  const node = await brain.initBrainNode();
  console.log(`[publish] local peer: ${node.libp2p.peerId.toString()}`);

  if (process.env.SUBSCRIBER_ADDR) {
    console.log(`[publish] explicit dial to ${process.env.SUBSCRIBER_ADDR}`);
    try {
      const { multiaddr } = await import('@multiformats/multiaddr');
      await node.libp2p.dial(multiaddr(process.env.SUBSCRIBER_ADDR));
      console.log('[publish] dial succeeded');
    } catch (err) {
      console.error(`[publish] explicit dial failed: ${err.message}`);
      console.error('[publish] continuing anyway — bootstrap-mediated discovery may still find the peer');
    }
  } else {
    console.log('[publish] no SUBSCRIBER_ADDR — relying on bootstrap DHT + Circuit Relay v2 for discovery');
    // Wait up to 30s for bootstrap peers to populate the peer store,
    // with progress prints every 3s so the operator can see something
    // is happening.
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const connCount = node.libp2p.getConnections().length;
      console.log(`[publish] t+${(i + 1) * 3}s connected peers: ${connCount}`);
      if (connCount > 0) break;
    }
  }

  console.log(`[publish] subscribing to ${DOC} topic to form the gossipsub mesh...`);
  node.libp2p.services.pubsub.subscribe(`pop/brain/${DOC}/v1`);
  // Give gossipsub one heartbeat for subscription propagation.
  await new Promise(r => setTimeout(r, 2000));

  const iso = new Date(unix * 1000).toISOString();
  const body = `smoke test from ${HOSTNAME} at ${iso}`;
  console.log(`[publish] applying brain change: title=${tag}`);
  const result = await brain.applyBrainChange(DOC, (doc) => {
    if (!Array.isArray(doc.lessons)) doc.lessons = [];
    doc.lessons.push({
      id: tag,
      title: tag,
      body,
      author: HOSTNAME,
      timestamp: unix,
    });
  });
  console.log(`[publish] new head CID: ${result.headCid}`);
  console.log(`[publish] envelope signer: ${result.author}`);

  // Record the tag where ROLE=verify can pick it up without the
  // operator having to copy-paste. Lives next to the blockstore.
  try {
    const fs = require('fs');
    const pathMod = require('path');
    const tagPath = pathMod.join(HOME || process.env.HOME || '/tmp', 'last-publish-tag');
    fs.writeFileSync(tagPath, tag + '\n');
  } catch {}

  console.log('[publish] lingering 15s for bitswap delivery...');
  await new Promise(r => setTimeout(r, 15000));

  await brain.stopBrainNode();
  console.log('');
  console.log('[publish] DONE.');
  console.log(`[publish] Expected lesson tag: ${tag}`);
  console.log(`[publish] Run ROLE=verify XMACHINE_TAG=${tag} node test/scripts/brain-cross-machine-smoke.js on the other machine to confirm.`);
}

async function runVerify() {
  const brain = await loadBrain();
  console.log(`[verify] role=verify doc=${DOC} home=${HOME || '(default)'}`);

  const { doc, headCid } = await brain.readBrainDoc(DOC);
  console.log(`[verify] local head CID: ${headCid ?? '(none)'}`);

  const lessons = Array.isArray(doc.lessons) ? doc.lessons : [];
  console.log(`[verify] ${lessons.length} lessons in doc`);

  // Prefer an explicit XMACHINE_TAG env var; fall back to the tag the
  // publish role wrote to $POP_BRAIN_HOME/last-publish-tag so the
  // publish-then-verify npm script works without plumbing the tag
  // through env vars manually.
  let tagPattern = process.env.XMACHINE_TAG;
  if (!tagPattern) {
    try {
      const fs = require('fs');
      const pathMod = require('path');
      const tagPath = pathMod.join(HOME || process.env.HOME || '/tmp', 'last-publish-tag');
      if (fs.existsSync(tagPath)) {
        tagPattern = fs.readFileSync(tagPath, 'utf8').trim();
      }
    } catch {}
  }
  if (!tagPattern) tagPattern = 'xmachine-';
  const matches = lessons.filter((l) => typeof l.title === 'string' && l.title.includes(tagPattern));
  console.log(`[verify] lessons matching "${tagPattern}": ${matches.length}`);
  for (const m of matches) {
    console.log(`  id=${m.id}  author=${m.author}  ts=${m.timestamp}`);
    if (m.body) console.log(`    body: ${String(m.body).slice(0, 120)}`);
  }

  await brain.stopBrainNode();

  if (matches.length === 0) {
    console.error('[verify] FAIL — no matching lesson found');
    console.error('[verify] diagnostics to collect: pop brain status --json, pop brain list, tcpdump on libp2p ports');
    process.exit(1);
  }
  console.log('[verify] PASS — cross-machine lesson propagated');
}

async function main() {
  switch (ROLE) {
    case 'subscribe':
      return runSubscribe();
    case 'publish':
      return runPublish();
    case 'verify':
      return runVerify();
    default:
      console.error('');
      console.error('Usage: ROLE=subscribe|publish|verify node test/scripts/brain-cross-machine-smoke.js');
      console.error('');
      console.error('  ROLE=subscribe    — start a listener, print multiaddrs, wait for announcements');
      console.error('  ROLE=publish      — apply a brain change with a known tag, linger for delivery');
      console.error('  ROLE=verify       — read the local doc and check whether the tag appears');
      console.error('');
      console.error('See docs/brain-cross-machine-smoke.md for full runbook.');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err.message);
  if (process.env.POP_BRAIN_DEBUG) console.error(err.stack);
  process.exit(1);
});
