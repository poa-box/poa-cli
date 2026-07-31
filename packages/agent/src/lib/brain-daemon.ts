/**
 * Brain daemon — persistent libp2p process that keeps gossipsub alive between
 * agent CLI invocations and periodically re-broadcasts the local manifest's
 * head CIDs so peers coming online can catch up.
 *
 * ## Why
 *
 * The brain layer's HB#322 dogfood finding: three consecutive vigil_01 brain
 * writes were invisible to argus_prime because agent sessions run in separate
 * 15-min cron slots and never overlap in wall-clock time. Gossipsub is
 * broadcast-only (no store-and-forward), so announcements published while a
 * peer is offline vanish permanently. Every agent ended up with a per-agent
 * append-only journal, not a shared substrate.
 *
 * Hudson's HB#322 directive: fix it properly with a long-running daemon. No
 * shortcuts. Model it on the go-ds-crdt reference architecture
 * (github.com/ipfs/go-ds-crdt, examples/globaldb/globaldb.go).
 *
 * ## Design (mapped from go-ds-crdt)
 *
 *   go-ds-crdt                  |  This module
 *   -----------------------------|--------------------------------------
 *   Datastore (long-lived)       |  runDaemon() — single process per agent
 *   Broadcaster (PubSub)         |  existing publishBrainHead / subscribeBrainTopic
 *   DAGSyncer (DAGService)       |  existing Helia blockstore + Bitswap
 *   RebroadcastInterval = 1m     |  REBROADCAST_INTERVAL_MS = 60_000
 *   keepalive netTopic (20s)     |  KEEPALIVE_TOPIC + 20s interval
 *   seenHeads map                |  DEFERRED — v1 rebroadcasts unconditionally
 *   RepairInterval = 1h          |  DEFERRED — MVP envelope is snapshot-per-write
 *                                |  so there's no DAG to walk
 *   signal handling              |  SIGTERM / SIGINT / SIGHUP
 *   PutHook / DeleteHook         |  DEFERRED — v2 adds IPC routing so existing
 *                                |  commands become clients
 *
 * ## Process model
 *
 *   pop brain daemon start        parent spawns a detached child running
 *                                 `node dist/index.js brain daemon __run`;
 *                                 parent writes PID file and exits
 *   pop brain daemon __run        the child entrypoint, calls runDaemon()
 *   pop brain daemon stop         reads PID, sends SIGTERM, waits cleanup
 *   pop brain daemon status       reads PID, checks liveness, opens Unix
 *                                 socket, sends {method: "status"}, prints
 *   pop brain daemon logs         tails daemon.log
 *
 *   ${POP_BRAIN_HOME}/daemon.pid  parent-written PID file
 *   ${POP_BRAIN_HOME}/daemon.sock Unix socket for IPC (mode 0600)
 *   ${POP_BRAIN_HOME}/daemon.log  append-only log
 *
 * ## IPC protocol
 *
 * Newline-delimited JSON over Unix socket. Each request is one line:
 *
 *   {"id": "1", "method": "status"}
 *
 * Each response is one line:
 *
 *   {"id": "1", "result": {...}}
 *   {"id": "1", "error": "..."}
 *
 * First-ship methods: status. Second-ship methods: appendLesson, readDoc,
 * snapshot — those let existing CLI commands route through a running daemon
 * instead of spinning up their own libp2p.
 */

import net from 'net';
import { join } from 'path';
import { homedir } from 'os';
import {
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  createWriteStream,
  chmodSync,
} from 'fs';
import { ethers } from 'ethers';
import {
  getBrainHome,
  initBrainNode,
  stopBrainNode,
  subscribeBrainTopic,
  publishBrainHead,
  fetchAndMergeRemoteHead,
  listBrainDocs,
  topicForDoc,
} from './brain';

export const REBROADCAST_INTERVAL_MS = 60_000;
// T1 (task #429): anti-entropy tuning knobs.
// Jitter randomizes each interval by ±(JITTER*100)% so a 3-agent fleet
// does not lockstep-rebroadcast. Grace suppresses re-publishing a head we
// just received from a peer — avoids amplification when all agents hold
// identical state.
export const REBROADCAST_JITTER = 0.3;
export const REBROADCAST_GRACE_MS = 5_000;
export const KEEPALIVE_INTERVAL_MS = 20_000;
// HB#365: default peer redial interval. Daemon periodically checks each
// POP_BRAIN_PEERS entry and re-dials any that are not currently in the
// active connection set. Fixes the "peer drops after one side reboots"
// fragility: without redial, the cross-device setup becomes manual-restart
// after any transient disconnect. 30s is a conservative default that's
// short enough to recover from a reboot within one heartbeat cycle.
// Override with POP_BRAIN_REDIAL_INTERVAL_MS.
export const REDIAL_INTERVAL_MS = 30_000;
export const KEEPALIVE_TOPIC = 'pop/brain/net/v1';

/**
 * Canonical brain docs every daemon subscribes to at startup regardless
 * of local manifest state. A fresh brain home has an empty manifest, so
 * without this list the daemon would not subscribe to any doc topics
 * and could never receive remote head announcements for
 * `pop.brain.shared` / `pop.brain.projects` until after its first
 * local write.
 *
 * Adding a new canonical doc here makes every daemon pick it up on
 * next restart. To experiment with a non-canonical doc, just perform a
 * local write via `pop brain append-lesson --doc <id>` — the write
 * path adds the doc to the manifest, and the next daemon loop iteration
 * picks it up via listBrainDocs().
 */
export const CANONICAL_BRAIN_DOCS: string[] = [
  'pop.brain.shared',
  'pop.brain.projects',
];

export function getDaemonPidPath(): string {
  return join(getBrainHome(), 'daemon.pid');
}

export function getDaemonSockPath(): string {
  return join(getBrainHome(), 'daemon.sock');
}

export function getDaemonLogPath(): string {
  return join(getBrainHome(), 'daemon.log');
}

/**
 * Check if a daemon appears to be running for this brain home.
 * Returns the PID if alive, null otherwise. Cleans up stale PID files.
 */
export function getRunningDaemonPid(): number | null {
  const p = getDaemonPidPath();
  if (!existsSync(p)) return null;
  let pid: number;
  try {
    pid = parseInt(readFileSync(p, 'utf8').trim(), 10);
  } catch {
    return null;
  }
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    // Signal 0 probes for process existence without actually signaling.
    process.kill(pid, 0);
    return pid;
  } catch (err: any) {
    if (err.code === 'ESRCH') {
      // Stale PID file — process is gone. Clean up.
      try { unlinkSync(p); } catch {}
      const sp = getDaemonSockPath();
      if (existsSync(sp)) {
        try { unlinkSync(sp); } catch {}
      }
      return null;
    }
    // EPERM or other — process exists but we can't signal it.
    return pid;
  }
}

interface DaemonStats {
  startedAt: number;
  rebroadcastCount: number;
  rebroadcastsSuppressedBySeen: number;
  keepaliveCount: number;
  lastRebroadcastAt: number | null;
  lastKeepaliveAt: number | null;
  incomingAnnouncements: number;
  incomingMerges: number;
  incomingRejects: number;
}

/**
 * Run the daemon event loop. Blocks until a termination signal arrives.
 * This is the __run entrypoint invoked by the detached child process.
 *
 * NEVER call this from the parent CLI path — it will never return.
 */
export async function runDaemon(): Promise<void> {
  const home = getBrainHome();
  const pidPath = getDaemonPidPath();
  const sockPath = getDaemonSockPath();
  const logPath = getDaemonLogPath();

  // Guard against double-start. The parent already checked via
  // getRunningDaemonPid(), but this is a second line of defense for
  // direct __run invocations.
  const existingPid = getRunningDaemonPid();
  if (existingPid !== null && existingPid !== process.pid) {
    throw new Error(
      `Brain daemon already running with PID ${existingPid} for ${home}`,
    );
  }

  // Author address is derived from POP_PRIVATE_KEY, same as applyBrainChange.
  // Used only for the rebroadcast envelope — the head CID itself is the
  // authenticated payload, so the announcement "author" is metadata.
  let authorAddress: string;
  try {
    const key = process.env.POP_PRIVATE_KEY;
    if (!key) throw new Error('POP_PRIVATE_KEY not set');
    authorAddress = new ethers.Wallet(key).address.toLowerCase();
  } catch (err: any) {
    throw new Error(
      `Brain daemon cannot start: ${err.message}. Set POP_PRIVATE_KEY in your env.`,
    );
  }

  const logStream = createWriteStream(logPath, { flags: 'a' });
  const log = (msg: string) => {
    const line = `${new Date().toISOString()} [${process.pid}] ${msg}\n`;
    logStream.write(line);
  };

  log(`daemon starting — home=${home} author=${authorAddress}`);

  // HB#324: do NOT write the PID file yet. A fast-following CLI command
  // that sees the PID file will try to open the IPC socket, which may
  // not yet exist. The startup race has to be closed by writing the PID
  // file AFTER the IPC server is listening. See the end of this function
  // for the actual PID file write.

  // Initialize libp2p once for the whole daemon lifetime. All CLI
  // commands invoked while the daemon is up will (eventually) route
  // through IPC instead of spinning up their own node.
  const node = await initBrainNode();
  log(`libp2p up — peer=${node.libp2p.peerId.toString()}`);

  const stats: DaemonStats = {
    startedAt: Date.now(),
    rebroadcastCount: 0,
    rebroadcastsSuppressedBySeen: 0,
    keepaliveCount: 0,
    lastRebroadcastAt: null,
    lastKeepaliveAt: null,
    incomingAnnouncements: 0,
    incomingMerges: 0,
    incomingRejects: 0,
  };

  // T1 (task #429): seen-heads tracking for anti-entropy suppression.
  // When an announcement arrives from a peer, record (docId, cid, receivedAt).
  // The rebroadcast loop checks this map before publishing: if a head was
  // received from any peer less than GRACE_MS ago, suppress the rebroadcast —
  // another agent already did the work, no need to amplify. Keyed by
  // "docId|cid" for O(1) lookup.
  const seenHeads = new Map<string, number>();
  const seenKey = (docId: string, cid: string) => `${docId}|${cid}`;

  // Anti-entropy tuning — read from env, fall back to module defaults.
  // Setting POP_BRAIN_REBROADCAST_INTERVAL_MS=0 disables the loop entirely
  // (useful for unit tests that want deterministic write-path behavior).
  const rebroadcastIntervalMs = (() => {
    const raw = process.env.POP_BRAIN_REBROADCAST_INTERVAL_MS;
    if (raw === undefined) return REBROADCAST_INTERVAL_MS;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : REBROADCAST_INTERVAL_MS;
  })();
  const rebroadcastJitter = (() => {
    const raw = process.env.POP_BRAIN_REBROADCAST_JITTER;
    if (raw === undefined) return REBROADCAST_JITTER;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n >= 0 && n < 1 ? n : REBROADCAST_JITTER;
  })();
  const rebroadcastGraceMs = (() => {
    const raw = process.env.POP_BRAIN_REBROADCAST_GRACE_MS;
    if (raw === undefined) return REBROADCAST_GRACE_MS;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : REBROADCAST_GRACE_MS;
  })();
  const nextInterval = () => {
    if (rebroadcastJitter <= 0) return rebroadcastIntervalMs;
    const delta = rebroadcastIntervalMs * rebroadcastJitter;
    return Math.max(
      0,
      Math.round(rebroadcastIntervalMs + (Math.random() * 2 - 1) * delta),
    );
  };

  // --- Subscribe to the keepalive net topic ---
  //
  // The globaldb example publishes "hi!" on a separate netTopic every 20s
  // so that the libp2p ConnManager tags participating peers with a "keep"
  // priority and refuses to evict them. We port that verbatim.
  const pubsub = node.libp2p.services.pubsub;
  pubsub.subscribe(KEEPALIVE_TOPIC);
  log(`subscribed keepalive topic ${KEEPALIVE_TOPIC}`);

  // Tag peers who publish on the keepalive topic (a rough port of
  // h.ConnManager().TagPeer(msg.ReceivedFrom, "keep", 100)). libp2p-js
  // exposes this via node.libp2p.peerStore.merge(peerId, {tags: {...}}).
  const keepaliveListener = async (evt: any) => {
    const msg = evt.detail;
    if (!msg || msg.topic !== KEEPALIVE_TOPIC) return;
    const from = msg.from;
    if (!from) return;
    try {
      await node.libp2p.peerStore.merge(from, {
        tags: { 'pop-brain-keep': { value: 50 } },
      });
    } catch (err: any) {
      // Non-fatal; peerStore.merge errors on some libp2p versions if the
      // peer isn't in the store yet. Log and move on.
      log(`keepalive tag err ${from}: ${err.message}`);
    }
  };
  pubsub.addEventListener('message', keepaliveListener);

  // --- Subscribe to every doc topic in the local manifest ---
  //
  // The daemon process keeps these subscriptions alive across CLI
  // invocations. Incoming head-CID announcements fire fetchAndMergeRemoteHead
  // immediately — no more "the CLI exited before the announcement arrived".
  const subscribedDocs = new Set<string>();
  const unsubscribes: Array<() => void> = [];

  async function subscribeDoc(docId: string): Promise<void> {
    if (subscribedDocs.has(docId)) return;
    subscribedDocs.add(docId);
    const unsub = await subscribeBrainTopic(docId, (ann, from) => {
      stats.incomingAnnouncements += 1;
      // T1: record the (docId, cid) we just heard so the rebroadcast loop
      // can skip re-publishing it during the grace window.
      seenHeads.set(seenKey(docId, ann.cid), Date.now());
      log(`recv doc=${docId} cid=${ann.cid} from=${from} author=${ann.author}`);
      // Fire-and-forget the block fetch + merge. Errors are logged.
      fetchAndMergeRemoteHead(ann.docId, ann.cid)
        .then(result => {
          // Task #373: only count actions where content actually landed.
          // 'adopt' = fast-forward or first head, 'merge' = CRDT merge.
          // 'skip' = already at head, 'reject' = auth/fetch/disjoint fail.
          if (result.action === 'adopt' || result.action === 'merge') {
            stats.incomingMerges += 1;
          } else if (result.action === 'reject') {
            stats.incomingRejects += 1;
          }
          log(`merge doc=${docId} cid=${ann.cid} action=${result.action} reason=${result.reason}`);
        })
        .catch(err => {
          log(`merge err doc=${docId} cid=${ann.cid}: ${err.message}`);
        });
    });
    unsubscribes.push(unsub);
    log(`subscribed doc ${docId}`);
  }

  // Bootstrap subscription: always subscribe to the canonical well-known
  // doc topics AND every doc currently in the manifest. A fresh brain
  // home will have an empty manifest but still needs to be listening
  // for pop.brain.shared and pop.brain.projects announcements so it
  // can catch up on first contact with a peer.
  const docsToSubscribe = new Set<string>([
    ...CANONICAL_BRAIN_DOCS,
    ...listBrainDocs().map(d => d.docId),
  ]);
  for (const docId of docsToSubscribe) {
    try {
      await subscribeDoc(docId);
    } catch (err: any) {
      log(`subscribe err ${docId}: ${err.message}`);
    }
  }

  // --- Rebroadcast loop (T1, task #429) ---
  //
  // go-ds-crdt default: every 60s ±30% jitter, re-publish current heads so
  // peers that came online after the last write can catch up. Suppresses
  // re-publishing a head we received from a peer within the grace window —
  // avoids amplification when fleet state is already converged.
  //
  // Disabled entirely if POP_BRAIN_REBROADCAST_INTERVAL_MS=0.
  // Implemented as setTimeout-self-rescheduling instead of setInterval so
  // each tick picks a fresh jittered delay.
  let rebroadcastTimer: NodeJS.Timeout | null = null;
  async function rebroadcastTick(): Promise<void> {
    const docs = listBrainDocs();
    for (const { docId, headCid } of docs) {
      // If the manifest picked up a new doc since startup, make sure we
      // are also subscribed to its topic.
      if (!subscribedDocs.has(docId)) {
        try { await subscribeDoc(docId); } catch {}
      }
      // Suppress rebroadcast of heads seen from peers within the grace
      // window — another agent already published it; we'd just amplify.
      const seenAt = seenHeads.get(seenKey(docId, headCid));
      if (seenAt !== undefined && Date.now() - seenAt < rebroadcastGraceMs) {
        stats.rebroadcastsSuppressedBySeen += 1;
        continue;
      }
      try {
        await publishBrainHead(docId, headCid, authorAddress);
        stats.rebroadcastCount += 1;
        stats.lastRebroadcastAt = Date.now();
      } catch (err: any) {
        log(`rebroadcast err doc=${docId}: ${err.message}`);
      }
    }
    // Prune seenHeads entries older than the grace window — bounded memory.
    const cutoff = Date.now() - rebroadcastGraceMs;
    for (const [key, ts] of seenHeads) {
      if (ts < cutoff) seenHeads.delete(key);
    }
  }
  function scheduleRebroadcast(): void {
    if (rebroadcastIntervalMs === 0) return;
    rebroadcastTimer = setTimeout(async () => {
      try { await rebroadcastTick(); } catch (err: any) {
        log(`rebroadcast tick err: ${err.message}`);
      }
      scheduleRebroadcast();
    }, nextInterval());
  }
  scheduleRebroadcast();

  // --- Keepalive loop ---
  //
  // Publish "alive" to the net topic every 20s. This both tags peers and
  // keeps pubsub mesh connections from going idle.
  const keepaliveTimer = setInterval(async () => {
    try {
      await pubsub.publish(
        KEEPALIVE_TOPIC,
        new TextEncoder().encode(`alive ${Date.now()}`),
      );
      stats.keepaliveCount += 1;
      stats.lastKeepaliveAt = Date.now();
    } catch (err: any) {
      log(`keepalive err: ${err.message}`);
    }
  }, KEEPALIVE_INTERVAL_MS);

  // --- IPC server ---
  //
  // Unix socket, newline-delimited JSON-RPC. First-ship methods: status.
  // Second-ship will add appendLesson/readDoc/snapshot.
  if (existsSync(sockPath)) {
    try { unlinkSync(sockPath); } catch {}
  }

  const server = net.createServer(socket => {
    let buf = '';
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleIpcLine(line, socket).catch(err => {
          log(`ipc handler err: ${err.message}`);
        });
      }
    });
    socket.on('error', err => {
      log(`ipc socket err: ${err.message}`);
    });
  });

  async function handleIpcLine(line: string, socket: net.Socket): Promise<void> {
    if (!line.trim()) return;
    let req: any;
    try {
      req = JSON.parse(line);
    } catch (err: any) {
      socket.write(JSON.stringify({ error: `bad json: ${err.message}` }) + '\n');
      return;
    }
    const id = req.id ?? null;
    try {
      const result = await dispatchIpc(req.method, req.params);
      socket.write(JSON.stringify({ id, result }) + '\n');
    } catch (err: any) {
      socket.write(JSON.stringify({ id, error: err.message }) + '\n');
    }
  }

  async function dispatchIpc(method: string, _params: any): Promise<any> {
    switch (method) {
      case 'status': {
        const topics = pubsub.getTopics?.() ?? [];
        const peers = node.libp2p.getPeers().map((p: any) => p.toString());
        const connections = node.libp2p.getConnections().length;
        // Return the full /p2p/<peerId> multiaddrs so operators and test
        // fixtures can dial this daemon from another process when automatic
        // discovery (mDNS, bootstrap) isn't finding it.
        const peerIdStr = node.libp2p.peerId.toString();
        const listenAddrs: string[] = [];
        try {
          for (const ma of node.libp2p.getMultiaddrs()) {
            const s = ma.toString();
            listenAddrs.push(s.includes('/p2p/') ? s : `${s}/p2p/${peerIdStr}`);
          }
        } catch {}
        return {
          peerId: peerIdStr,
          listenAddrs,
          uptime: Math.floor((Date.now() - stats.startedAt) / 1000),
          connections,
          knownPeerCount: peers.length,
          topics,
          subscribedDocs: Array.from(subscribedDocs),
          rebroadcastCount: stats.rebroadcastCount,
          rebroadcastsSuppressedBySeen: stats.rebroadcastsSuppressedBySeen,
          rebroadcastIntervalMs,
          rebroadcastJitter,
          rebroadcastGraceMs,
          lastRebroadcastAt: stats.lastRebroadcastAt,
          keepaliveCount: stats.keepaliveCount,
          lastKeepaliveAt: stats.lastKeepaliveAt,
          incomingAnnouncements: stats.incomingAnnouncements,
          incomingMerges: stats.incomingMerges,
          incomingRejects: stats.incomingRejects,
          brainHome: home,
          pidPath,
          sockPath,
          logPath,
        };
      }
      case 'dial': {
        // Operator/test escape hatch for bringing peers together when
        // automatic discovery fails. Accepts a `/ip4/.../p2p/<peerId>`
        // multiaddr and asks libp2p to open a connection.
        //
        // Expected params: {multiaddr: string}
        // Returns: {dialed: string, peerId: string}
        const addr = _params?.multiaddr;
        if (!addr || typeof addr !== 'string') {
          throw new Error('dial: multiaddr (string) is required');
        }
        // Lazy import so we don't pull multiaddr into the module namespace
        // unless someone actually uses this path.
        const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
        const { multiaddr: makeMultiaddr } = await esmImport('@multiformats/multiaddr');
        const ma = makeMultiaddr(addr);
        await node.libp2p.dial(ma);
        log(`dial via IPC: ${addr}`);
        return { dialed: addr, peerId: node.libp2p.peerId.toString() };
      }
      case 'ping': {
        return { pong: true, ts: Date.now() };
      }
      case 'applyOp': {
        // HB#324 ship-2: unified write dispatch. The CLI serialized a
        // BrainOp into _params.op; we run it through the same dispatchOp
        // function the CLI would use if no daemon were running. This
        // keeps the local and routed code paths byte-identical — only
        // the transport differs.
        //
        // Lazy import to avoid a module-level cycle: brain-ops imports
        // from brain-daemon (getRunningDaemonPid, sendIpcRequest), and
        // brain-daemon needs to import dispatchOp from brain-ops here.
        // Defer the require until the first applyOp lands.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { dispatchOp } = require('./brain-ops');
        const result = await dispatchOp(_params?.op);
        // If the op touched a doc we weren't subscribed to, add it to
        // our live subscription set so incoming announcements for that
        // doc get handled going forward.
        const docId = _params?.op?.docId;
        if (docId && !subscribedDocs.has(docId)) {
          try { await subscribeDoc(docId); } catch {}
        }
        log(
          `applyOp doc=${docId} type=${_params?.op?.type} head=${result.headCid} ` +
          `author=${result.envelopeAuthor}`,
        );
        // dispatchOp returns routedViaDaemon=false because it ran in the
        // local (daemon) process. The CLI's routedDispatch will override
        // this flag to true because it was sent via IPC.
        return {
          headCid: result.headCid,
          envelopeAuthor: result.envelopeAuthor,
        };
      }
      default:
        throw new Error(`Unknown IPC method: ${method}`);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.listen(sockPath, () => resolve());
    server.on('error', reject);
  });
  try {
    chmodSync(sockPath, 0o600);
  } catch {}
  log(`IPC listening on ${sockPath}`);

  // HB#324: NOW write the PID file, after the IPC socket is listening.
  // A CLI command that sees the PID file will immediately try to IPC
  // and that connection must succeed on the first try. Writing the PID
  // before the server was listening was a startup race bug in ship-1.
  writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
  log(`PID file written — daemon is now discoverable`);

  // HB#333 (task #349): auto-dial peers listed in POP_BRAIN_PEERS.
  // Format: comma-separated /ip4/.../p2p/<peerId> multiaddrs.
  // Example (3-agent local setup):
  //   POP_BRAIN_PEERS=/ip4/127.0.0.1/tcp/50126/p2p/12D3...,/ip4/127.0.0.1/tcp/50134/p2p/12D3...
  //
  // HB#365 (task tbd): periodic redial on disconnect.
  // Before this, POP_BRAIN_PEERS was fire-once at startup — any
  // disconnect (peer reboot, network blip, macOS sleep) left the daemon
  // stuck at connections=0 until manual restart. Now a periodic timer
  // re-evaluates the list every REDIAL_INTERVAL_MS and dials any peer
  // that is not currently in the active connection set. Override the
  // interval via POP_BRAIN_REDIAL_INTERVAL_MS.
  //
  // Semantics:
  //   - Unset or empty POP_BRAIN_PEERS → no-op, no timer
  //   - Parse each entry, empty segments dropped silently
  //   - Initial dial at startup is still best-effort parallel
  //   - Every interval tick: for each configured peer, extract the peerId
  //     suffix, check libp2p.getPeers() membership. If not connected,
  //     dial. If connected, skip (no duplicate dials).
  //   - Individual failures logged but never block the timer loop
  //   - Timer is cleared in shutdown() alongside rebroadcast/keepalive
  const peersEnv = process.env.POP_BRAIN_PEERS;
  const parsedPeerAddrs: string[] =
    peersEnv && peersEnv.trim() !== ''
      ? peersEnv.split(',').map(s => s.trim()).filter(Boolean)
      : [];

  const esmImportPeers = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
  let makeMultiaddrLocal: any = null;
  if (parsedPeerAddrs.length > 0) {
    const mod = await esmImportPeers('@multiformats/multiaddr');
    makeMultiaddrLocal = mod.multiaddr;
  }

  // Extract target peerId from /p2p/<id> suffix so we can test
  // connection membership without re-parsing on every tick.
  function peerIdOfMultiaddr(addr: string): string | null {
    const m = /\/p2p\/([^/]+)$/.exec(addr);
    return m ? m[1] : null;
  }

  async function dialIfDisconnected(addr: string, reason: 'startup' | 'redial'): Promise<void> {
    try {
      const targetPeerId = peerIdOfMultiaddr(addr);
      if (targetPeerId) {
        const connected = node.libp2p.getPeers().some((p: any) => p.toString() === targetPeerId);
        if (connected) {
          // Already connected — no-op. Quiet in redial loop to avoid log spam.
          if (reason === 'startup') log(`auto-dial skip (already connected): ${addr}`);
          return;
        }
      }
      const ma = makeMultiaddrLocal(addr);
      await node.libp2p.dial(ma);
      log(`${reason === 'startup' ? 'auto-dial' : 'redial'} success: ${addr}`);
    } catch (err: any) {
      log(`${reason === 'startup' ? 'auto-dial' : 'redial'} failed: ${addr} — ${err?.message ?? err}`);
    }
  }

  if (parsedPeerAddrs.length > 0) {
    log(`auto-dial: POP_BRAIN_PEERS has ${parsedPeerAddrs.length} entry(ies)`);
    // Fire all dials in parallel at startup — independent best-effort.
    await Promise.all(parsedPeerAddrs.map(a => dialIfDisconnected(a, 'startup')));
  }

  // HB#365: periodic redial timer. Handles peer reboots, transient
  // disconnects, and cross-device sessions where the remote side is
  // occasionally offline. Only runs when POP_BRAIN_PEERS is set.
  const redialInterval = (() => {
    const raw = process.env.POP_BRAIN_REDIAL_INTERVAL_MS;
    if (!raw) return REDIAL_INTERVAL_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 5_000 ? n : REDIAL_INTERVAL_MS;
  })();
  const redialTimer: NodeJS.Timeout | null =
    parsedPeerAddrs.length > 0
      ? setInterval(async () => {
          for (const addr of parsedPeerAddrs) {
            await dialIfDisconnected(addr, 'redial');
          }
        }, redialInterval)
      : null;

  // --- Graceful shutdown ---
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutdown signal ${sig}`);
    if (rebroadcastTimer !== null) clearTimeout(rebroadcastTimer);
    clearInterval(keepaliveTimer);
    if (redialTimer) clearInterval(redialTimer);
    try { pubsub.removeEventListener('message', keepaliveListener); } catch {}
    for (const u of unsubscribes) {
      try { u(); } catch {}
    }
    await new Promise<void>(res => server.close(() => res()));
    if (existsSync(sockPath)) { try { unlinkSync(sockPath); } catch {} }
    if (existsSync(pidPath)) { try { unlinkSync(pidPath); } catch {} }
    try { await stopBrainNode(); } catch (err: any) { log(`stop err: ${err.message}`); }
    log(`shutdown complete`);
    logStream.end();
    // Give the log stream a tick to flush, then exit.
    setTimeout(() => process.exit(0), 50);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('uncaughtException', err => {
    log(`uncaught: ${err.stack ?? err.message}`);
    shutdown('uncaughtException');
  });

  log(
    `daemon ready — rebroadcast=${rebroadcastIntervalMs === 0 ? 'disabled' : `${rebroadcastIntervalMs}ms±${Math.round(rebroadcastJitter*100)}% grace=${rebroadcastGraceMs}ms`} ` +
    `keepalive=${KEEPALIVE_INTERVAL_MS}ms ` +
    (redialTimer ? `redial=${redialInterval}ms ` : '') +
    `subscribed=${subscribedDocs.size} docs`,
  );

  // Park forever. The timers and the IPC server keep the event loop alive.
  // Shutdown only happens via signal handler.
  await new Promise(() => {});
}

/**
 * Typed IPC error. Attaches a `.code` for the caller to branch on.
 *
 *   phase = 'pre-connect'  The connection was never established (socket
 *                          missing, ECONNREFUSED). Safe to fall back to a
 *                          local execution path — the write did not land
 *                          in the daemon's process.
 *   phase = 'post-connect' The connection was established and the request
 *                          was sent, but a response did not come back. The
 *                          write may or may not have landed. NOT safe to
 *                          fall back — see routedDispatch() in brain-ops.ts.
 */
export class BrainIpcError extends Error {
  code: string;
  phase: 'pre-connect' | 'post-connect';
  constructor(message: string, code: string, phase: 'pre-connect' | 'post-connect') {
    super(message);
    this.name = 'BrainIpcError';
    this.code = code;
    this.phase = phase;
  }
}

/**
 * IPC client helper: send a request to the running daemon.
 *
 * Throws a BrainIpcError whose `.phase` indicates whether the failure is
 * safe to recover from by falling back to a local code path. Pre-connect
 * failures (ECONNREFUSED, ENOENT, daemon not running) are safe. Post-connect
 * failures (timeout, ECONNRESET, EPIPE) leave the write in an unknown state.
 */
export async function sendIpcRequest(
  method: string,
  params: any = {},
  timeoutMs = 5000,
): Promise<any> {
  const sockPath = getDaemonSockPath();
  if (!existsSync(sockPath)) {
    throw new BrainIpcError(
      `No brain daemon socket at ${sockPath}. Run "pop brain daemon start".`,
      'ENOENT',
      'pre-connect',
    );
  }
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    let buf = '';
    let connected = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new BrainIpcError(
        `IPC timeout after ${timeoutMs}ms`,
        'ETIMEDOUT',
        connected ? 'post-connect' : 'pre-connect',
      ));
    }, timeoutMs);
    socket.on('connect', () => {
      connected = true;
      // Now that we have a live connection, write the request. Doing this
      // in the connect handler (instead of immediately after createConnection)
      // closes a subtle phase-classification race on fast local sockets.
      socket.write(JSON.stringify({ id: Date.now().toString(), method, params }) + '\n');
    });
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        const line = buf.slice(0, nl);
        try {
          const res = JSON.parse(line);
          socket.end();
          if (res.error) {
            // Response-level error (daemon rejected the request). This is
            // post-connect; the write did not land.
            reject(new BrainIpcError(res.error, 'EHANDLER', 'post-connect'));
          } else {
            resolve(res.result);
          }
        } catch (err: any) {
          reject(new BrainIpcError(
            `bad ipc response: ${err.message}`,
            'EPROTO',
            'post-connect',
          ));
        }
      }
    });
    socket.on('error', err => {
      clearTimeout(timer);
      const code = (err as any).code ?? 'EIPC';
      const phase = connected ? 'post-connect' : 'pre-connect';
      reject(new BrainIpcError(err.message, code, phase));
    });
  });
}
