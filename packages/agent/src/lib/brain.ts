/**
 * Brain layer — peer-to-peer CRDT substrate for shared agent thinking.
 *
 * Replaces the git-tracked markdown files (shared.md, projects.md,
 * discussions.json, goals.md) with Automerge documents synced over
 * libp2p-gossipsub + Bitswap via an embedded Helia node. No Argus-operated
 * service in the hot path; peer-to-peer only.
 *
 * This file intentionally isolates the ESM import boundary. Helia and its
 * libp2p dependencies are pure ESM, while the rest of the project compiles
 * to CommonJS. Dynamic `await import()` is the clean way to bridge the gap
 * without touching every other source file's module system.
 *
 * Plan: /Users/hudsonheadley/.claude/plans/cheeky-nibbling-raven.md
 *
 * Current status: MVP step 1 — initialize a Helia node, report peer info.
 * CRDT/Automerge/gossipsub layers come in subsequent steps.
 */

import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import {
  signBrainChange,
  verifyBrainChange,
  isAllowedAuthor,
  isAuthorizedAuthor,
  unwrapAutomergeBytes,
  type BrainChangeEnvelope,
} from './brain-signing';

/**
 * Where the brain layer persists its blocks and state.
 * One directory per agent. Survives heartbeat cycles, not in git.
 */
export function getBrainHome(): string {
  const home = process.env.POP_BRAIN_HOME || join(homedir(), '.pop-agent', 'brain');
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  return home;
}

export interface BrainNodeInfo {
  peerId: string;
  peerIdSource: 'persisted' | 'freshly-generated';
  listeningAddrs: string[];
  connectedPeers: number;
  bootstrapPeerCount: number;
  heliaVersion: string;
  blockstorePath: string;
  peerKeyPath: string;
  subscribedTopics: string[];
  topicPeerCounts: Record<string, number>;
}

/**
 * Canonical public IPFS bootstrap peers. These are the Protocol Labs
 * public bootstrap nodes, used by `go-ipfs`, `kubo`, and every default
 * Helia install. They're multi-operator, censorship-resistant at the
 * substrate level, and free to use.
 *
 * Brain peers join the DHT via these + use Circuit Relay v2 to punch
 * through NAT when both sides are behind firewalls. On a fresh machine
 * with no static peer list, these are the only way to be discoverable
 * from another agent running anywhere on the internet.
 */
const DEFAULT_BOOTSTRAP_PEERS: string[] = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
];

/**
 * Path to the persistent libp2p PeerId private key. Lives alongside the
 * blockstore under <brain-home>/peer-key.json. Format:
 *   { keyType: "Ed25519", privateKey: "0x<hex>" }
 *
 * Generated once per brain home on first boot; reused on every
 * subsequent boot so the PeerId is stable across restarts. Without
 * this, every process gets a random PeerId and any static peer list
 * (or reputation-tracking peer) goes stale instantly.
 *
 * Security note: this file sits next to POP_PRIVATE_KEY in the same
 * filesystem under the same threat model — anyone who can read one
 * can read the other. No encryption; no passphrase. Operators who
 * want to rotate their PeerId delete the file manually.
 */
function getPeerKeyPath(): string {
  return join(getBrainHome(), 'peer-key.json');
}

/**
 * Load the persisted libp2p private key, or generate + persist a new
 * one if none exists. Returns the private key object that libp2p@2.x
 * expects for its `privateKey` createLibp2p option, plus a flag
 * indicating whether the key was loaded or freshly generated (for
 * operator-visible status output).
 *
 * Corrupt or unreadable key files fall back to fresh generation with
 * a warning — never crash the node over a half-written JSON file.
 */
async function getOrCreatePeerPrivateKey(): Promise<{ privateKey: any; source: 'persisted' | 'freshly-generated' }> {
  const path = getPeerKeyPath();
  const {
    generateKeyPair,
    privateKeyFromProtobuf,
    privateKeyToProtobuf,
  } = await esmImport<any>('@libp2p/crypto/keys');

  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof raw?.privateKey === 'string' && raw.privateKey.startsWith('0x')) {
        const bytes = Uint8Array.from(Buffer.from(raw.privateKey.slice(2), 'hex'));
        // Stored as a protobuf-framed private key (keyType discriminator
        // + key material — libp2p's canonical on-disk format). The hex
        // contains the output of privateKeyToProtobuf, not .raw bytes.
        const privateKey = privateKeyFromProtobuf(bytes);
        return { privateKey, source: 'persisted' };
      }
      throw new Error('malformed peer-key.json — missing hex privateKey');
    } catch (err: any) {
      if (process.env.POP_BRAIN_DEBUG) {
        console.error(`[brain] peer-key.json unreadable (${err.message}) — regenerating`);
      }
      // Fall through to fresh generation.
    }
  }

  // Ed25519 is the default for libp2p PeerIds — small, fast, ubiquitous.
  const privateKey = await generateKeyPair('Ed25519');
  // Serialize via privateKeyToProtobuf so the on-disk format is the
  // canonical libp2p wire format. The earlier version of this code
  // stored privateKey.raw (32 raw Ed25519 bytes) which does NOT
  // round-trip through privateKeyFromProtobuf — that path expects the
  // protobuf envelope with the keyType discriminator. Without it the
  // load silently fails and we regenerate a new PeerId on every boot.
  const protobufBytes: Uint8Array = privateKeyToProtobuf(privateKey);
  const hex = '0x' + Buffer.from(protobufBytes).toString('hex');
  writeFileSync(
    path,
    JSON.stringify({ keyType: 'Ed25519', privateKey: hex }, null, 2),
  );
  return { privateKey, source: 'freshly-generated' };
}

/**
 * Track whether the currently-cached node was booted with a persisted
 * or freshly-generated PeerId. Surfaced in getBrainNodeInfo so status
 * output can tell the operator which path was taken.
 */
let cachedPeerIdSource: 'persisted' | 'freshly-generated' | null = null;

/**
 * Gossipsub topic name for a brain doc. Versioned so we can bump the
 * wire format later without silently crossing streams with old peers.
 */
export function topicForDoc(docId: string): string {
  return `pop/brain/${docId}/v1`;
}

/**
 * Head-CID announcement payload. Broadcast on the doc's gossipsub topic
 * after every successful applyBrainChange. The announcement is ONLY a
 * pointer — the actual block is fetched via Bitswap in step 6. For step
 * 5 subscribers just log the announcement.
 *
 * Note: the payload is NOT signature-verified at the subscribe layer.
 * "Auth at read, permissionless at sync" — any peer can gossip any CID,
 * and readers enforce the allowlist when they actually load the doc
 * (openBrainDoc verifies the signed envelope before returning the doc).
 */
export interface BrainHeadAnnouncement {
  v: 1;
  docId: string;
  cid: string;
  author: string;    // informational only; not trusted
  timestamp: number;
}

let cachedNode: any = null;

/**
 * Initialize (or return cached) embedded Helia node.
 *
 * Uses a NodeFS blockstore at <brain-home>/helia-blocks so state
 * persists across CLI invocations — important because every `pop`
 * invocation is a fresh process but the brain state must be durable.
 *
 * Returns the live Helia instance. Caller is responsible for calling
 * `stopBrainNode()` before exit if they care about a clean shutdown.
 */
// TypeScript's `commonjs` module target compiles `await import('x')` to
// `require('x')`. That works for dual-format packages (like helia@5+) but
// fails for ESM-only packages (like blockstore-fs) with "No exports main
// defined." The Function constructor is opaque to TypeScript, so this
// performs a *real* Node dynamic import at runtime.
const esmImport: <T = any>(specifier: string) => Promise<T> =
  new Function('s', 'return import(s)') as any;

export async function initBrainNode(): Promise<any> {
  if (cachedNode) return cachedNode;

  // Dynamic ESM imports — Helia and its sibling libraries are pure ESM;
  // this file compiles to CJS.
  const { createHelia } = await esmImport<any>('helia');
  const { FsBlockstore } = await esmImport<any>('blockstore-fs');
  const { createLibp2p } = await esmImport<any>('libp2p');
  const { tcp } = await esmImport<any>('@libp2p/tcp');
  const { mdns } = await esmImport<any>('@libp2p/mdns');
  const { bootstrap } = await esmImport<any>('@libp2p/bootstrap');
  const { noise } = await esmImport<any>('@chainsafe/libp2p-noise');
  const { yamux } = await esmImport<any>('@chainsafe/libp2p-yamux');
  const { identify } = await esmImport<any>('@libp2p/identify');
  const { gossipsub } = await esmImport<any>('@chainsafe/libp2p-gossipsub');
  const { circuitRelayTransport } = await esmImport<any>('@libp2p/circuit-relay-v2');
  const { autoNAT } = await esmImport<any>('@libp2p/autonat');

  const brainHome = getBrainHome();
  const blockstorePath = join(brainHome, 'helia-blocks');
  if (!existsSync(blockstorePath)) mkdirSync(blockstorePath, { recursive: true });

  // Persistent blockstore — CRDT blocks survive across CLI invocations.
  // The `as any` coercion bypasses a TypeScript version-skew between
  // blockstore-fs@2's bundled `interface-*` packages and Helia's top-level
  // copy. Runtime shape is correct; types can't see through duplicated
  // class declarations.
  const blockstore = new FsBlockstore(blockstorePath) as any;

  // Persistent libp2p PeerId. Without this, every process gets a random
  // PeerId and any static peer list / reputation tracking goes stale
  // immediately. Generated once per brain home on first boot; reused on
  // every subsequent boot. File format documented in getOrCreatePeerPrivateKey.
  const { privateKey, source } = await getOrCreatePeerPrivateKey();
  cachedPeerIdSource = source;

  // libp2p config: now wired for cross-machine sync.
  //
  // Peer discovery: mdns (same-LAN), bootstrap (public IPFS bootstrap
  // peers for WAN discovery). The bootstrap list is the canonical
  // Protocol Labs list — multi-operator, censorship-resistant, free.
  //
  // Transports: tcp for direct dial AND circuitRelayTransport for NAT
  // traversal via public Circuit Relay v2 nodes. When this peer is behind
  // NAT and can't be reached directly, AutoNAT detects it and libp2p
  // arranges to be reachable via a public relay.
  //
  // Services: identify (protocol handshake), pubsub (gossipsub for head
  // announcements), autoNAT (reachability detection).
  //
  // gossipsub is configured with allowPublishToZeroTopicPeers so that a
  // publisher whose local topic has no subscribers yet doesn't throw —
  // the write has already persisted locally and the announcement is
  // best-effort. `emitSelf: false` because we don't want local subscribers
  // echoing back our own publishes.
  // HB#364: optional fixed listen port via POP_BRAIN_LISTEN_PORT.
  // When set, the daemon binds TCP to a predictable port so committed
  // static peer lists (brain-peers.json) remain valid across restarts.
  // When unset, fall back to random port (libp2p tcp/0) for ephemeral
  // CLI invocations that don't need to be addressable. Cross-device
  // onboarding is gated on this being set on at least one side.
  const rawListenPort = process.env.POP_BRAIN_LISTEN_PORT?.trim();
  const listenPort = rawListenPort && /^\d+$/.test(rawListenPort) ? Number(rawListenPort) : 0;
  const listenAddrs = [`/ip4/0.0.0.0/tcp/${listenPort}`];

  const libp2p = await createLibp2p({
    privateKey,
    addresses: { listen: listenAddrs },
    transports: [tcp(), circuitRelayTransport()],
    streamMuxers: [yamux()],
    connectionEncrypters: [noise()],
    peerDiscovery: [
      mdns(),
      bootstrap({ list: DEFAULT_BOOTSTRAP_PEERS }),
    ],
    services: {
      identify: identify(),
      autonat: autoNAT(),
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        emitSelf: false,
      }),
    },
  });

  cachedNode = await createHelia({ blockstore, libp2p });

  // Auto-subscribe to all doc topics we already know about. Gossipsub's
  // mesh formation is gated on topic membership being propagated over the
  // pubsub control plane (one heartbeat interval, ~1s). Subscribing at
  // init time — rather than lazily inside publishBrainHead — means that
  // by the first write, any already-connected peer has had time to learn
  // we're part of the same topic, so the publish actually reaches them.
  try {
    const pubsub = libp2p.services?.pubsub;
    if (pubsub) {
      const knownDocs = Object.keys(loadHeadsManifest());
      for (const docId of knownDocs) {
        pubsub.subscribe(topicForDoc(docId));
      }
    }
  } catch (err: any) {
    if (process.env.POP_BRAIN_DEBUG) {
      console.error(`[brain] auto-subscribe failed: ${err.message}`);
    }
  }

  return cachedNode;
}

/**
 * Gather a human-readable summary of the local brain node state.
 */
export async function getBrainNodeInfo(): Promise<BrainNodeInfo> {
  const helia = await initBrainNode();
  const libp2p = helia.libp2p;

  const peerId = libp2p.peerId.toString();
  const listeningAddrs = libp2p.getMultiaddrs().map((ma: any) => ma.toString());
  const connectedPeers = libp2p.getConnections().length;

  // Helia version — package.json isn't trivially readable from dist/,
  // so we probe the runtime module for a version marker and fall back.
  let heliaVersion = 'unknown';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    heliaVersion = require('helia/package.json').version;
  } catch {
    // package.json may not be exported; fall back to unknown
  }

  // Pubsub may not be present in very old libp2p configs; guard the lookup.
  const pubsub = libp2p.services?.pubsub;
  const subscribedTopics: string[] = pubsub?.getTopics?.() ?? [];
  const topicPeerCounts: Record<string, number> = {};
  for (const t of subscribedTopics) {
    try {
      topicPeerCounts[t] = pubsub.getSubscribers(t)?.length ?? 0;
    } catch {
      topicPeerCounts[t] = 0;
    }
  }

  // Bootstrap peer count: how many of the canonical Protocol Labs
  // bootstrap peers (from DEFAULT_BOOTSTRAP_PEERS) are currently listed
  // in libp2p's peer store. This is NOT the same as "connected peers"
  // (bootstrap discovery populates the peer store even before a
  // connection is established), but it's a useful reachability proxy:
  // if this number is 0, the bootstrap DNS lookup failed or the DNS
  // addresses haven't resolved yet.
  let bootstrapPeerCount = 0;
  try {
    const bootstrapPeerIds = new Set(
      DEFAULT_BOOTSTRAP_PEERS
        .map(addr => addr.split('/p2p/')[1])
        .filter(Boolean),
    );
    const peers = await libp2p.peerStore.all();
    bootstrapPeerCount = peers.filter((p: any) =>
      bootstrapPeerIds.has(p.id?.toString?.()),
    ).length;
  } catch {
    // Peer store lookup failures are not worth crashing status output.
  }

  return {
    peerId,
    peerIdSource: cachedPeerIdSource ?? 'freshly-generated',
    listeningAddrs,
    connectedPeers,
    bootstrapPeerCount,
    heliaVersion,
    blockstorePath: join(getBrainHome(), 'helia-blocks'),
    peerKeyPath: getPeerKeyPath(),
    subscribedTopics,
    topicPeerCounts,
  };
}

/**
 * Publish a head-CID announcement on a doc's gossipsub topic.
 * Best-effort: if there are no peers yet (common at cold start) the
 * publish is a no-op thanks to allowPublishToZeroTopicPeers. A thrown
 * error is caught and logged — the local write has already succeeded,
 * and missed announcements recover at next peer reconnect.
 *
 * Subscribes to the topic before publishing so that future inbound
 * announcements on the same doc are received. Gossipsub requires a
 * subscription on a topic before it will publish to it meaningfully.
 */
// Tracks topics we subscribed to this process so we can wait one
// gossipsub heartbeat after a FRESH subscribe before first publish —
// otherwise the peer hasn't been told we're in the topic yet and the
// message goes nowhere. Only a cold-start cost; subsequent writes on
// the same topic are instant.
const freshlySubscribedTopics = new Set<string>();

export async function publishBrainHead(
  docId: string,
  cid: string,
  author: string,
): Promise<void> {
  const helia = await initBrainNode();
  const pubsub = helia.libp2p.services?.pubsub;
  if (!pubsub) return;
  const topic = topicForDoc(docId);
  try {
    // Subscribe if we haven't already — idempotent in gossipsub.
    let justSubscribed = false;
    if (!pubsub.getTopics().includes(topic)) {
      pubsub.subscribe(topic);
      justSubscribed = true;
      freshlySubscribedTopics.add(topic);
    }

    // Gossipsub mesh forms on a heartbeat (~1s default). If we JUST
    // subscribed and there are connected peers, wait one heartbeat so
    // the peer learns we're in the topic before we try to publish.
    // Without this, the very first publish from a fresh process
    // reliably goes nowhere.
    if (justSubscribed && helia.libp2p.getConnections().length > 0) {
      await new Promise(r => setTimeout(r, 1500));
    }
    const announcement: BrainHeadAnnouncement = {
      v: 1,
      docId,
      cid,
      author,
      timestamp: Math.floor(Date.now() / 1000),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(announcement));
    await pubsub.publish(topic, bytes);
  } catch (err: any) {
    // Best-effort; local write already persisted. Don't fail the caller.
    // Log to stderr so operators can see sync hiccups without crashing.
    if (process.env.POP_BRAIN_DEBUG) {
      console.error(`[brain] publish to ${topic} failed: ${err.message}`);
    }
  }
}

/**
 * Subscribe to a doc's gossipsub topic and invoke `onAnnouncement` for
 * every incoming head-CID announcement. Malformed payloads are logged
 * and skipped — the sync layer is permissionless, so a subscriber must
 * not crash on bad input from a misbehaving peer.
 *
 * Returns an unsubscribe function that removes the handler and the
 * topic subscription.
 */
export async function subscribeBrainTopic(
  docId: string,
  onAnnouncement: (ann: BrainHeadAnnouncement, from: string) => void,
): Promise<() => void> {
  const helia = await initBrainNode();
  const pubsub = helia.libp2p.services?.pubsub;
  if (!pubsub) {
    throw new Error('libp2p pubsub service not configured on this node');
  }
  const topic = topicForDoc(docId);

  const listener = (evt: any) => {
    const msg = evt.detail;
    if (!msg || msg.topic !== topic) return;
    try {
      const text = new TextDecoder().decode(msg.data);
      const ann = JSON.parse(text) as BrainHeadAnnouncement;
      if (ann.v !== 1 || !ann.docId || !ann.cid) {
        throw new Error('malformed announcement: missing v/docId/cid');
      }
      const from = msg.from?.toString?.() || 'unknown';
      onAnnouncement(ann, from);
    } catch (err: any) {
      if (process.env.POP_BRAIN_DEBUG) {
        console.error(`[brain] bad announcement on ${topic}: ${err.message}`);
      }
    }
  };

  pubsub.addEventListener('message', listener);
  pubsub.subscribe(topic);

  return () => {
    try {
      pubsub.removeEventListener('message', listener);
      pubsub.unsubscribe(topic);
    } catch {
      // Already gone — nothing to do.
    }
  };
}

/**
 * Clean shutdown. Call before exiting a long-lived process.
 * Safe to call when no node was initialized.
 */
export async function stopBrainNode(): Promise<void> {
  if (!cachedNode) return;
  try {
    await cachedNode.stop();
  } finally {
    cachedNode = null;
  }
}

// ---------------------------------------------------------------------------
// Automerge doc layer — MVP step 3
// ---------------------------------------------------------------------------
//
// Each brain document (pop.brain.shared, pop.brain.projects, etc.) lives as
// an Automerge doc. On write: apply change, Automerge.save() → full-state
// bytes, write to Helia blockstore → CID, update the local "heads manifest"
// mapping docId → CID. On read: look up CID in manifest, fetch bytes from
// blockstore, Automerge.load() → doc.
//
// This is the simplest possible model: snapshot-per-write, local-only,
// no sync yet. Delta propagation (via gossipsub) + cross-peer block fetch
// (via Bitswap) are subsequent steps. The current implementation is
// correct-and-boring on purpose — proves the storage + serialization layer
// before adding network complexity.

let automergeModule: any = null;
async function getAutomerge(): Promise<any> {
  if (!automergeModule) {
    automergeModule = await esmImport('@automerge/automerge');
  }
  return automergeModule;
}

/**
 * Path to the heads manifest — a small JSON file mapping brain doc IDs to
 * the CID of their most recent full-state snapshot. Lives alongside the
 * blockstore because heads are local state (each peer tracks its own view
 * of what it has seen) while the blocks themselves are shared.
 */
function getHeadsManifestPath(): string {
  return join(getBrainHome(), 'doc-heads.json');
}

function loadHeadsManifest(): Record<string, string> {
  const p = getHeadsManifestPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function saveHeadsManifest(manifest: Record<string, string>): void {
  // HB#324: atomic write-tmp-then-rename. The brain daemon and short-lived
  // CLI processes can both touch this file (daemon on incoming-merge from
  // gossipsub, CLI on local append when no daemon is running). A plain
  // writeFileSync has a window during which a concurrent reader would see
  // a truncated JSON and throw. POSIX rename() is atomic on the same fs,
  // so a reader always sees either the previous complete file or the new
  // complete file — never a half-written one.
  const finalPath = getHeadsManifestPath();
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(manifest, null, 2));
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('fs').renameSync(tmpPath, finalPath);
  } catch (err) {
    // Best-effort cleanup if the rename failed.
    try { require('fs').unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

/**
 * Load the genesis bytes for a canonical brain doc if a
 * `<docId>.genesis.bin` file exists in the repo's
 * `agent/brain/Knowledge/` directory.
 *
 * Task #352 (HB#337): genesis files are tiny (~150 bytes) binary
 * Automerge snapshots of the empty canonical doc shape. When every
 * agent loads from the same genesis bytes before their first write,
 * all subsequent cross-agent writes share a common root and
 * `Automerge.merge` correctly combines them. Without the shared
 * genesis, independent initialization creates disjoint histories
 * that silently drop content at merge time — see task #350 for the
 * disjoint-history stopgap and the `retroactive-verification-finds-
 * what-forward-tests-miss` brain lesson for the full context.
 *
 * Returns the raw bytes if the file exists, or null if not
 * (falls through to `Automerge.init()` for non-canonical docs or
 * for agents without the genesis files available).
 */
function loadGenesisBytes(docId: string): Uint8Array | null {
  const genesisPath = join(process.cwd(), 'agent', 'brain', 'Knowledge', `${docId}.genesis.bin`);
  if (!existsSync(genesisPath)) return null;
  try {
    const bytes = readFileSync(genesisPath);
    return Uint8Array.from(bytes);
  } catch {
    return null;
  }
}

/**
 * Open an Automerge document by ID. If the manifest has a head CID for
 * this ID, loads the state from the blockstore. Otherwise returns a fresh
 * empty doc — seeded from the canonical genesis file if one exists for
 * this docId (task #352), or a plain `Automerge.init()` as a last resort.
 *
 * Returns the doc plus its current head CID (null for new docs) so the
 * caller can tell whether this was a load or an init.
 */
export async function openBrainDoc<T = any>(docId: string): Promise<{ doc: any; headCid: string | null }> {
  const helia = await initBrainNode();
  const Automerge = await getAutomerge();
  const manifest = loadHeadsManifest();
  const headCidStr = manifest[docId];

  if (!headCidStr) {
    // Task #352: shared-genesis bootstrap. If the repo has a canonical
    // `<docId>.genesis.bin` file, load from it so every agent's first
    // write builds on the same root doc. Without this, independent
    // `Automerge.init()` calls produce disjoint histories that silently
    // drop content at merge time.
    const genesisBytes = loadGenesisBytes(docId);
    if (genesisBytes) {
      try {
        const doc = Automerge.load(genesisBytes);
        return { doc, headCid: null };
      } catch (err: any) {
        // Genesis file corrupt or incompatible — fall through to init().
        if (process.env.POP_BRAIN_DEBUG) {
          console.error(`[brain] failed to load genesis for ${docId}: ${err.message}`);
        }
      }
    }
    return { doc: Automerge.init(), headCid: null };
  }

  // Parse the CID via multiformats and read the block via blockstore-fs
  // (helia.blockstore.get has a version-skew issue through the typed
  // wrapper; going directly through FsBlockstore is the stable path).
  const { CID } = await esmImport<any>('multiformats/cid');
  const { FsBlockstore } = await esmImport<any>('blockstore-fs');
  const bs = new FsBlockstore(join(getBrainHome(), 'helia-blocks'));
  await bs.open();
  try {
    const cid = CID.parse(headCidStr);
    const envelopeBytes = await bs.get(cid);
    // Step 4: block is now a signed envelope, not raw Automerge bytes.
    // Unwrap, verify, check allowlist, then load the inner Automerge.
    const envelope = JSON.parse(new TextDecoder().decode(envelopeBytes)) as BrainChangeEnvelope;
    const author = verifyBrainChange(envelope);
    const authz = await isAuthorizedAuthor(author);
    if (!authz.allowed) {
      throw new Error(
        `Brain doc "${docId}" head is signed by ${author}, not authorized. ` +
        `${authz.fallbackReason}. ` +
        `Either vouch this address into the Argus member hat, or add it to ` +
        `agent/brain/Config/brain-allowlist.json for an emergency override.`
      );
    }
    if (authz.mode === 'static-fallback' && authz.fallbackReason) {
      // Surface the fallback path so operators can see when dynamic is down.
      console.error(`[brain] ${authz.fallbackReason}`);
    }
    const automergeBytes = unwrapAutomergeBytes(envelope);
    const doc = Automerge.load(automergeBytes);
    return { doc, headCid: headCidStr };
  } finally {
    await bs.close();
  }
}

/**
 * Apply a change function to a brain doc and persist the new state.
 *
 * Writes the new full-state snapshot as a raw IPLD block, computes its
 * CID, updates the heads manifest. Returns the new CID.
 *
 * Snapshot-per-write is simpler than delta-based persistence for MVP;
 * the tradeoff is that Automerge.save() produces the full state each
 * time. For the shared.md / projects.md scale (KB-range docs) this is
 * fine. When docs grow, switch to saving incremental changes via
 * Automerge.getChanges() and a linked-list of block CIDs.
 */
export async function applyBrainChange<T = any>(
  docId: string,
  changeFn: (doc: T) => void,
  options?: { allowInvalidShape?: boolean },
): Promise<{ headCid: string; doc: any; author: string }> {
  const { doc: oldDoc } = await openBrainDoc<T>(docId);
  const Automerge = await getAutomerge();
  const newDoc = Automerge.change(oldDoc, changeFn);

  // Task #346 (HB#168): write-time schema validation.
  // Validate pre-change and post-change. Only reject regressions —
  // valid → invalid transitions. If the doc was already invalid before
  // this change, the bad state was inherited (historical, pre-enforcement
  // write), and this write is allowed through so existing docs remain
  // usable. This preserves the task constraint "existing 30 lessons
  // must not be retroactively rejected."
  if (!options?.allowInvalidShape) {
    const { validateBrainDocShape } = await import('./brain-schemas');
    const preResult = validateBrainDocShape(docId, oldDoc);
    const postResult = validateBrainDocShape(docId, newDoc);
    if (preResult.ok && !postResult.ok) {
      throw new Error(
        `Brain write rejected: schema validation failed for ${docId}\n` +
          postResult.errors.map((e) => `  - ${e}`).join('\n') +
          `\n\nPre-change doc was valid; this change introduces invalid shape(s). ` +
          `Fix the CLI call OR pass --allow-invalid-shape to bypass (strongly discouraged).`,
      );
    }
    // If post is still invalid but pre was also invalid, log a warning
    // and allow through. If pre invalid and post valid, the write is a
    // partial fix — also allow.
    if (!preResult.ok && !postResult.ok) {
      // Silent — inherited bad state, not this write's fault.
    }
  }

  const automergeBytes: Uint8Array = Automerge.save(newDoc);

  // Step 4: wrap the snapshot in a signed envelope before persisting.
  // The envelope is what becomes the IPLD block; CID is over the
  // envelope (not the raw Automerge), so sig + data are content-addressed
  // together and can't be separated.
  const envelope = await signBrainChange(automergeBytes);
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));

  const { CID } = await esmImport<any>('multiformats/cid');
  const { sha256 } = await esmImport<any>('multiformats/hashes/sha2');
  const { FsBlockstore } = await esmImport<any>('blockstore-fs');
  const hash = await sha256.digest(envelopeBytes);
  const cid = CID.createV1(0x55, hash);
  const bs = new FsBlockstore(join(getBrainHome(), 'helia-blocks'));
  await bs.open();
  try {
    await bs.put(cid, envelopeBytes);
  } finally {
    await bs.close();
  }

  const manifest = loadHeadsManifest();
  manifest[docId] = cid.toString();
  saveHeadsManifest(manifest);

  // Step 5: broadcast the new head CID on the doc's gossipsub topic.
  // Best-effort — if there are no peers or publish fails, the local
  // write has already persisted and missed announcements recover at
  // next peer reconnect via delta fetch. We do NOT await errors here
  // because the caller's contract is "change was persisted locally."
  try {
    await publishBrainHead(docId, cid.toString(), envelope.author);
  } catch {
    // publishBrainHead already swallows errors; belt-and-suspenders.
  }

  return { headCid: cid.toString(), doc: newDoc, author: envelope.author };
}

/**
 * Import a raw Automerge snapshot as the new local head for a brain doc.
 *
 * Task #353 (HB#348): the post-HB#352 follow-up for migrating the 3 existing
 * Argus agents off their pre-genesis disjoint Automerge state. The HB#341
 * export step pinned argus's current state for all 3 canonical docs to IPFS
 * (Qm...). This function is the receive side: load those bytes into vigil_01
 * or sentinel_01's brain home as the new shared head so their subsequent
 * writes build on argus's root instead of their own disjoint root.
 *
 * ## Semantics
 *
 * - Load the bytes via `Automerge.load()` to validate structural integrity.
 *   Throws if the bytes are corrupt or not an Automerge snapshot.
 * - Run the standard write-time schema validator (#346) unless
 *   `opts.allowInvalidShape` is set.
 * - Sign a new envelope via `signBrainChange` — the importing agent becomes
 *   the envelope author for the new head, even though the Automerge content
 *   is preserved from the source.
 * - Write the envelope as a new IPLD block, update the manifest, publish the
 *   head CID via gossipsub (same as applyBrainChange's persist+publish flow).
 *
 * ## Safety
 *
 * This function REPLACES the local head. If the local brain home already
 * has content for this docId, that state becomes orphaned (the old envelope
 * stays in the blockstore, but the manifest no longer points at it). Callers
 * must decide whether to preserve local-only content before calling:
 *
 *   1. `pop brain read --doc <id> --json` to snapshot local state
 *   2. `pop brain import-snapshot --doc <id> --file <canonical-bytes>`
 *   3. Replay local-only lessons via `pop brain append-lesson` calls on the
 *      new shared baseline
 *
 * The CLI wrapper (`pop brain import-snapshot`) enforces a `--force` flag
 * requirement when a local head exists, so there are no accidental replaces.
 */
export async function importBrainDoc(
  docId: string,
  automergeBytes: Uint8Array,
  opts?: { allowInvalidShape?: boolean },
): Promise<{ headCid: string; doc: any; author: string }> {
  // Ensure helia is initialized (same as applyBrainChange — this is a
  // write path that needs the libp2p publish hook).
  await initBrainNode();
  const Automerge = await getAutomerge();

  // Validate by loading. Throws if bytes are corrupt or not a valid
  // Automerge snapshot.
  const doc = Automerge.load(automergeBytes);

  // Schema validation (same pipeline as applyBrainChange post-#346).
  if (!opts?.allowInvalidShape) {
    const { validateBrainDocShape } = await import('./brain-schemas');
    const result = validateBrainDocShape(docId, doc);
    if (!result.ok) {
      throw new Error(
        `Imported snapshot fails schema validation for ${docId}:\n` +
        result.errors.map((e: string) => `  - ${e}`).join('\n') +
        `\n\nPass --allow-invalid-shape to bypass (strongly discouraged).`,
      );
    }
  }

  // Sign a NEW envelope with the imported bytes. The envelope author is
  // the importing agent (from POP_PRIVATE_KEY), not the source agent.
  // That's correct: the importer is vouching for the import, and the
  // Automerge content carries the history of whoever wrote it.
  const envelope = await signBrainChange(automergeBytes);
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));

  // Persist + publish — same flow as applyBrainChange.
  const { CID } = await esmImport<any>('multiformats/cid');
  const { sha256 } = await esmImport<any>('multiformats/hashes/sha2');
  const { FsBlockstore } = await esmImport<any>('blockstore-fs');
  const hash = await sha256.digest(envelopeBytes);
  const cid = CID.createV1(0x55, hash);
  const bs = new FsBlockstore(join(getBrainHome(), 'helia-blocks'));
  await bs.open();
  try {
    await bs.put(cid, envelopeBytes);
  } finally {
    await bs.close();
  }
  const manifest = loadHeadsManifest();
  manifest[docId] = cid.toString();
  saveHeadsManifest(manifest);

  // Publish the new head via gossipsub. Best-effort — local write has
  // already persisted, and missed announcements recover at next peer
  // reconnect via the usual rebroadcast loop.
  try {
    await publishBrainHead(docId, cid.toString(), envelope.author);
  } catch {
    // publishBrainHead already swallows errors; belt-and-suspenders.
  }

  return { headCid: cid.toString(), doc, author: envelope.author };
}

/**
 * List all known brain doc IDs + their current head CIDs.
 * Reads the manifest file directly — doesn't require Helia to be running.
 */
export function listBrainDocs(): Array<{ docId: string; headCid: string }> {
  const manifest = loadHeadsManifest();
  return Object.entries(manifest).map(([docId, headCid]) => ({ docId, headCid }));
}

// ---------------------------------------------------------------------------
// Step 6 — Bitswap block fetch + CRDT merge
// ---------------------------------------------------------------------------
//
// When a subscriber receives a head-CID announcement (step 5), the block
// for that CID may not be in its local blockstore yet. Step 6 closes the
// loop: fetch the block via helia.blockstore.get (which uses Bitswap under
// the hood), verify the signed envelope (step 4), load the Automerge
// snapshot, merge it with the local doc, and update the heads manifest.
//
// The merge is CRDT-clean: Automerge.merge(local, remote) converges on
// concurrent edits. The only auth boundary is the allowlist check in
// brain-signing.ts — "auth at read, permissionless at sync" is preserved.
// Sync layer still never filters; the reader rejects anything outside
// the allowlist BEFORE updating the manifest.

export type BrainSyncResult =
  | { action: 'skip'; reason: string; headCid: string }
  | { action: 'adopt'; reason: string; headCid: string }
  | { action: 'merge'; reason: string; headCid: string }
  | { action: 'reject'; reason: string };

/**
 * Given a remote head-CID announcement, fetch the block (via Bitswap if
 * not already local), verify it, merge with the local doc, and update
 * the manifest. Returns the action taken.
 *
 * Does NOT re-publish after merging. The next local write (via
 * applyBrainChange) will publish from the merged state. This avoids
 * gossip ping-pong where two peers would keep producing "merge heads"
 * and broadcasting them at each other.
 */
export async function fetchAndMergeRemoteHead(
  docId: string,
  remoteCidStr: string,
): Promise<BrainSyncResult> {
  // Cheap dedup: we already track this exact CID, nothing to do.
  const manifest = loadHeadsManifest();
  if (manifest[docId] === remoteCidStr) {
    return { action: 'skip', reason: 'already at this head', headCid: remoteCidStr };
  }

  const helia = await initBrainNode();
  const Automerge = await getAutomerge();
  const { CID } = await esmImport<any>('multiformats/cid');
  const { sha256 } = await esmImport<any>('multiformats/hashes/sha2');
  const { FsBlockstore } = await esmImport<any>('blockstore-fs');

  const remoteCid = CID.parse(remoteCidStr);

  // Fetch the block. helia.blockstore.get transparently goes to Bitswap
  // if the block isn't already local. With a small session timeout so
  // we don't hang forever on a bad announcement.
  let envelopeBytes: any;
  try {
    // helia 5.x: blockstore.get(cid) returns Promise<Uint8Array>.
    // helia 6.x: blockstore.get(cid) returns AsyncGenerator<Uint8Array>.
    // Handle both shapes defensively.
    const result: any = await helia.blockstore.get(remoteCid);
    if (process.env.POP_BRAIN_DEBUG) {
      const util = await esmImport<any>('util');
      console.error('[brain] blockstore.get returned:', util.inspect(result, { depth: 1, maxArrayLength: 4 }));
    }
    if (result instanceof Uint8Array) {
      envelopeBytes = result;
    } else if (result && typeof result[Symbol.asyncIterator] === 'function') {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of result) {
        chunks.push(chunk);
        total += chunk.byteLength;
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      envelopeBytes = merged;
    } else if (result && typeof result.slice === 'function') {
      // Uint8ArrayList path.
      envelopeBytes = result.slice();
    } else {
      envelopeBytes = result;
    }
    if (process.env.POP_BRAIN_DEBUG) {
      const util = await esmImport<any>('util');
      console.error('[brain] blockstore.get returned:', util.inspect(envelopeBytes, { depth: 2, maxArrayLength: 8 }));
    }
  } catch (err: any) {
    return {
      action: 'reject',
      reason: `bitswap fetch failed for ${remoteCidStr}: ${err.message}`,
    };
  }

  // Parse + verify envelope + allowlist check. Any failure => reject.
  // helia.blockstore.get may return a Uint8ArrayList (from the
  // `uint8arraylist` package) which is NOT a Uint8Array and which
  // .subarray() returns the first chunk only. Use .slice() to
  // materialize a contiguous Uint8Array covering the full payload.
  let remoteEnvelope: BrainChangeEnvelope;
  try {
    let plain: Uint8Array;
    if (envelopeBytes instanceof Uint8Array) {
      plain = envelopeBytes;
    } else if (typeof (envelopeBytes as any).slice === 'function') {
      // Uint8ArrayList.slice() returns a contiguous Uint8Array of the full list.
      plain = (envelopeBytes as any).slice();
    } else {
      plain = Uint8Array.from(envelopeBytes as any);
    }
    remoteEnvelope = JSON.parse(new TextDecoder().decode(plain)) as BrainChangeEnvelope;
  } catch (err: any) {
    return { action: 'reject', reason: `envelope parse failed: ${err.message}` };
  }
  let author: string;
  try {
    author = verifyBrainChange(remoteEnvelope);
  } catch (err: any) {
    return { action: 'reject', reason: `signature verify failed: ${err.message}` };
  }
  const authz = await isAuthorizedAuthor(author);
  if (!authz.allowed) {
    return {
      action: 'reject',
      reason: `author ${author} not authorized (${authz.fallbackReason}) — block stored but manifest NOT updated`,
    };
  }
  if (authz.mode === 'static-fallback' && authz.fallbackReason) {
    console.error(`[brain] ${authz.fallbackReason}`);
  }

  const remoteAutomergeBytes = unwrapAutomergeBytes(remoteEnvelope);
  const remoteDoc = Automerge.load(remoteAutomergeBytes);

  // Case A: we have no local head for this doc — just adopt remote.
  // The block is already in our blockstore thanks to Bitswap's side
  // effect, so we only need to update the manifest.
  if (!manifest[docId]) {
    manifest[docId] = remoteCidStr;
    saveHeadsManifest(manifest);
    return {
      action: 'adopt',
      reason: 'no local head — adopting remote directly',
      headCid: remoteCidStr,
    };
  }

  // Case B: we have a local head, load it and merge.
  const { doc: localDoc } = await openBrainDoc(docId);

  // Task #350 (HB#335): detect disjoint Automerge histories before
  // attempting the merge. Automerge.merge() and Automerge.applyChanges()
  // BOTH silently drop remote content when the two docs don't share a
  // common fork ancestor — verified empirically in HB#335 dogfood. This
  // is a fundamental property of Automerge: docs must share a root
  // initialized via the same from()/init() call for cross-doc operations
  // to work. The detection here refuses the merge with a clear error
  // and leaves the local manifest unchanged. The block stays in the
  // blockstore for post-mortem inspection.
  //
  // Detection: if local and remote both have changes and zero change
  // hashes overlap, they have disjoint histories.
  try {
    const localChanges = Automerge.getAllChanges(localDoc);
    const remoteChanges = Automerge.getAllChanges(remoteDoc);
    if (localChanges.length > 0 && remoteChanges.length > 0) {
      // Automerge change objects have a .hash field in dev builds, but
      // the binary serialized form also carries it. The canonical way
      // to extract hashes is via Automerge.decodeChange.
      const localHashes = new Set<string>();
      for (const c of localChanges) {
        const decoded = Automerge.decodeChange(c);
        localHashes.add(decoded.hash);
      }
      let overlap = false;
      for (const c of remoteChanges) {
        const decoded = Automerge.decodeChange(c);
        if (localHashes.has(decoded.hash)) {
          overlap = true;
          break;
        }
      }
      if (!overlap) {
        if (process.env.POP_BRAIN_DEBUG) {
          console.error(
            `[brain] disjoint-history detected for doc="${docId}" — ` +
            `local has ${localChanges.length} changes, remote has ${remoteChanges.length} changes, ` +
            `zero overlap. Refusing merge to prevent silent data loss (task #350).`,
          );
        }
        return {
          action: 'reject',
          reason:
            `disjoint Automerge histories (local ${localChanges.length} changes, remote ${remoteChanges.length} changes, zero overlap) — ` +
            `both docs were independently initialized. Automerge requires shared-root docs for cross-doc merge; the remote block is stored but the manifest is unchanged to prevent silent data loss. ` +
            `Workaround: bootstrap the other agent's brain home from the committed agent/brain/Knowledge/${docId}.generated.md via \`pop brain migrate\` before their first write. See task #350 for the shared-genesis fix.`,
        };
      }
    }
  } catch (err: any) {
    // If the disjoint-history detection itself fails (e.g. Automerge API
    // change), log and fall through to the merge attempt. Better to
    // possibly-drop than to definitely-fail.
    if (process.env.POP_BRAIN_DEBUG) {
      console.error(`[brain] disjoint-history check failed: ${err?.message ?? err}`);
    }
  }

  const mergedDoc = Automerge.merge(localDoc, remoteDoc);

  // Decide what to do with the merge. Compare Automerge heads rather
  // than raw bytes — snapshots of equivalent state can serialize to
  // different bytes because Automerge preserves per-actor change log.
  const localHeads: string[] = Automerge.getHeads(localDoc).sort();
  const remoteHeads: string[] = Automerge.getHeads(remoteDoc).sort();
  const mergedHeads: string[] = Automerge.getHeads(mergedDoc).sort();

  const sameArray = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  // Merged == local: remote was a strict ancestor (or empty). Nothing to do.
  if (sameArray(mergedHeads, localHeads)) {
    return {
      action: 'skip',
      reason: 'local doc is ahead of remote (remote is an ancestor)',
      headCid: manifest[docId],
    };
  }

  // Merged == remote: local was a strict ancestor. Adopt remote CID.
  if (sameArray(mergedHeads, remoteHeads)) {
    manifest[docId] = remoteCidStr;
    saveHeadsManifest(manifest);
    return {
      action: 'adopt',
      reason: 'remote is ahead of local — fast-forwarding',
      headCid: remoteCidStr,
    };
  }

  // Merged is a true merge — both sides had unique changes. Serialize
  // the merged doc, sign it with OUR key, write as a new block, update
  // the manifest. We intentionally DO NOT publish here to avoid a
  // gossip cycle with a peer doing the same merge; the next local
  // applyBrainChange will broadcast this state forward.
  const mergedBytes: Uint8Array = Automerge.save(mergedDoc);
  const mergeEnvelope = await signBrainChange(mergedBytes);
  const mergeEnvelopeBytes = new TextEncoder().encode(JSON.stringify(mergeEnvelope));
  const hash = await sha256.digest(mergeEnvelopeBytes);
  const mergeCid = CID.createV1(0x55, hash);
  const bs = new FsBlockstore(join(getBrainHome(), 'helia-blocks'));
  await bs.open();
  try {
    await bs.put(mergeCid, mergeEnvelopeBytes);
  } finally {
    await bs.close();
  }
  manifest[docId] = mergeCid.toString();
  saveHeadsManifest(manifest);
  return {
    action: 'merge',
    reason: `CRDT merge of local ${localHeads.length}-head with remote ${remoteHeads.length}-head into ${mergedHeads.length}-head`,
    headCid: mergeCid.toString(),
  };
}

/**
 * Projection helper — returns the current Automerge doc as a plain
 * JS object (for JSON display). Wraps openBrainDoc and Automerge.clone.
 */
export async function readBrainDoc(docId: string): Promise<{ doc: any; headCid: string | null }> {
  const { doc, headCid } = await openBrainDoc(docId);
  const Automerge = await getAutomerge();
  // Automerge docs are frozen proxies; return a plain JS snapshot.
  return { doc: Automerge.toJS(doc), headCid };
}
