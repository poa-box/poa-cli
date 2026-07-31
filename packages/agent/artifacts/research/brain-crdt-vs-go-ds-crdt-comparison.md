# Our brain CRDT vs ipfs/go-ds-crdt — Principal-engineer comparison

**Author**: argus_prime (HB#299)
**Date**: 2026-04-16
**Source pinned at**: `QmfSXhgYoeaFhr9b2X7rq7ejvVPdkQz6LkDduMZwkaV4P4` (task #428 v1; a re-pin happens on this re-submission with placeholder fixed)
**Driven by**: Hudson's request to surface concrete architectural improvements

This document compares our Automerge+Helia+gossipsub stack (`src/lib/brain*.ts`,
`src/commands/brain/*`) against ipfs/go-ds-crdt's Merkle-CRDT stack
(`github.com/ipfs/go-ds-crdt @ b883358d`, master 2026-04-15). Goal: identify
concrete improvements, not survey trivia. Each finding maps to a follow-up task
or an explicit "no, we should not adopt this and here's why."

---

## TL;DR

| Dimension | Ours | go-ds-crdt | Verdict |
|---|---|---|---|
| Wire format | Full Automerge snapshot per write | Delta-per-write (IPLD ProtoNode w/ parent links) | **Adopt deltas (T3)** — directly addresses HB#322 deferral and snapshot bloat |
| Causality | Single per-doc head; Automerge internal change DAG | IPLD DAG of deltas; multiple-head frontier; `priority = max(parents)+1` | **Adopt frontier model (T4)** — enables true anti-entropy |
| Anti-entropy | NONE (gossipsub-only, sequential agents miss writes) | Periodic rebroadcast every ~1m ±30%; DAG repair every 1h | **Adopt periodic rebroadcast (T1)** — fixes #427 root cause |
| Repair / catch-up | NONE | Dirty-bit + `Repair()` walks DAG from heads down | **Adopt DAG repair (T2)** — needed even with anti-entropy |
| Block fetch | Helia bitswap point-lookup on announcement | DAGSyncer (also bitswap), session-aware via `SessionDAGService` | Largely matches; minor session optimization possible |
| GC / pruning | None | None — `PR #288 closed because "Merkle-DAG of snapshots is its own scaling problem"` | Both punt; **document the constraint (T5)**; don't reinvent the wheel |
| Conflict resolution | Automerge per-type (lists, maps, registers) | OR-Set with priority + `bytes.Compare(value)` tiebreaker | Different tradeoff — we have richer types; keep ours |
| Auth | ECDSA-signed envelopes + dynamic+static allowlist | NONE (issue #308 punted to "custom Delta") | **WE WIN.** Don't lose this when adopting other features |
| Membership | Allowlist via subgraph + `POP_BRAIN_PEERS` | None at CRDT layer | We win |
| Heads cache | `doc-heads.json` (single CID per doc) | In-memory map primed at startup, no upper bound | Small surface area — fine for our scale |
| Schema | Per-doc TS interfaces + write-time schema validator | Single OR-Set; pluggable Delta type via `DeltaFactory` | Different shape; `DeltaFactory` is interesting for future extensibility |
| Recent direction | Stabilization | Named DAG segmentation + custom deltas + abandoned snapshot work | Both maturing |

**Bottom line**: go-ds-crdt's *transport semantics* are ahead of ours
(anti-entropy, DAG walking, periodic rebroadcast) but their *application
semantics* are behind ours (no auth, single CRDT type, no membership). The
five tasks below adopt the transport wins without giving up the auth/schema
wins.

---

## Side-by-side architecture

### Wire format

**Ours** (`src/lib/brain.ts:684-758` `applyBrainChange`, `src/lib/brain-signing.ts:86`):

```typescript
// Every write produces a full snapshot of the doc:
const automergeBytes = Automerge.save(doc);  // FULL state, e.g. 450KB for 450-lesson doc
const envelope = { v: 1, author, timestamp,
                   automerge: hex(automergeBytes), sig };
// Block: raw IPLD codec 0x55 carrying JSON-encoded envelope
```

**Theirs** (`go-ds-crdt/crdt.go:1514` `addDAGNode`):

```go
// Every write produces a single delta:
node := ipld.ProtoNode {
  Data:  marshal(pb.Delta{ elements, tombstones, priority }),
  Links: parentHeadCIDs,  // explicit parent links
}
// height = max(parent.height) + 1
```

**Why this matters**: theirs is a true Merkle DAG — every block links to its
parent CIDs, height is intrinsic, you can walk backward to find missing
predecessors. Ours is a sequence of independent snapshots with no link to
predecessor; given a head CID, you cannot walk backward to ancestors because
they don't exist as separate blocks.

This is the root cause of multiple of our problems:
- **HB#334 disjoint-history bug** — Automerge.merge silently drops content
  when two docs lack a common root. With per-delta blocks linking explicit
  parents, this class of bug is structurally impossible.
- **No DAG repair** — we cannot repair what we cannot walk.
- **Snapshot bloat** — every write at 450KB cost regardless of how small the
  logical change is. Theirs: ~hundreds of bytes per single-key write.
- **No per-write attribution** — our envelope signs the *whole doc state*, so
  the signature certifies "argus_prime says doc looks like this at T", not
  "argus_prime says this specific change is valid." Hard to validate single
  changes for replay/audit.

### Heads tracking

**Ours**: `doc-heads.json` is a flat `{docId: cid}` map — single head per doc.
When two agents diverge, the next agent to see both runs `Automerge.merge`
producing a merged doc with combined heads, then writes ONE new envelope
whose CID becomes the new single head.

**Theirs**: `heads.go` tracks a *frontier* — an in-memory map of all
known-head CIDs. Multiple heads can coexist for the same DAG. `processNode`
calls `Replace(oldHead, newHead)` when it walks past a node that was a head;
otherwise just `Add(newHead)`. Heads naturally collapse as the DAG grows.

**Why this matters**: their multiple-heads model means the broadcast payload
is "here are my heads" — receivers fetch any head they don't have. This IS
their anti-entropy mechanism. Ours can't broadcast a frontier because there
isn't one — we collapsed to a single CID early.

### Broadcast / anti-entropy

**Ours** (`src/lib/brain.ts:398-440` `publishBrainHead`,
`src/lib/brain-daemon.ts:352-363` keepalive):

- One announcement per write: `{v:1, docId, cid, author, timestamp}` on
  topic `pop/brain/{docId}/v1`.
- Keepalive every 20s on `pop/brain/net/v1` to prevent ConnManager eviction.
- Allow publish to zero-peer topics (`allowPublishToZeroTopicPeers: true`)
  — but this just suppresses the error; receivers still don't get it.
- **No periodic rebroadcast of heads.** A peer offline at write time misses
  the announcement and never recovers.

**Theirs** (`go-ds-crdt/crdt.go:660-720` `rebroadcast`):

- One announcement per write (same as us).
- **Periodic rebroadcast every `RebroadcastInterval` (default 1m, jittered
  ±30%)** on each topic. Payload: list of *all current heads* not seen in
  others' broadcasts in the last interval.
- `seenHeads map[cid.Cid]struct{}` accumulates heads heard from others;
  cleared each interval. Suppresses redundant rebroadcasts.

**Why this matters**: this single feature — periodic rebroadcast of head
CIDs — is the difference between "all 3 agents converge whenever they're
online together" (ours) and "all 3 agents eventually converge if any pair
overlaps for one rebroadcast interval" (theirs). Task #427's
"sequential-agents-miss-bootstrap" pain is exactly this.

### DAG sync / repair

**Ours**: on receiving a head announcement, `fetchAndMergeRemoteHead`
(`src/lib/brain.ts:901-1135`) calls `helia.blockstore.get(remoteCid)`. That's
a point-lookup. If the block is missing locally, Helia bitswap fetches it.
Once fetched, it's merged via `Automerge.merge`. **No descent.** No
"recursively fetch missing predecessors" because the snapshot has no parent
links.

**Theirs**: `handleBranch → sendNewJobs → dagWorker → processNode`
(`crdt.go:982-1090`). Workers walk the DAG breadth-first from the announced
head, fetching each block via the user-supplied `DAGSyncer`. `NumWorkers`
(default 5) parallel goroutines. Stop conditions: block already in the
processed-blocks namespace OR another worker is already walking it
(deduplicated via `queuedChildren *cidSafeSet`).

**Repair**: `repair` goroutine ticks every `RepairInterval` (default 1h);
if `dirty` bit is set (meaning a worker errored mid-walk), `repairDAG` walks
the entire DAG from current heads, queuing unprocessed nodes.

**Why this matters**: their model survives transient bitswap failures,
peer churn, and incomplete syncs. Ours fails-stop on first error; the
sender's announcement is gone, the receiver may or may not have the block,
and there's no retry surface.

### Persistence

**Ours**: Helia FsBlockstore at `~/.pop-agent/brain/helia-blocks/`. Each
block = JSON envelope. Typical 19MB store after ~1 year. No GC.

**Theirs**: User-supplied `ds.Datastore` (Pebble recommended after #325).
Multiple key namespaces:
- `h/<cid>` — heads
- `s/s/<key>/<blockID>` — element entries (one per add-event!)
- `s/t/<key>/<blockID>` — tombstones
- `s/k/<key>/v` — current materialized value
- `s/k/<key>/p` — current materialized priority
- `b/<cid-multihash>` — processed-block markers
- `d` — dirty bit

**Why this matters**: theirs has more rows per write but supports atomic
batching via `ds.Batching`. Their "every add produces a row even if the
key already existed" is what makes the OR-Set semantics work — we don't
need that because Automerge handles concurrent writes internally.
Persistence-wise we're roughly equivalent (both monotonic, both no GC).

### Auth & membership

**Ours**: `src/lib/brain-signing.ts:53-59` signs every envelope with ECDSA
over `pop-brain-change/v1|<author>|<ts>|<automerge-hex>`. Verifier
(`src/lib/brain-membership.ts`) checks signer is in the allowlist (subgraph
dynamic + static JSON fallback). Unauthorized writes are rejected at the
merge step.

**Theirs**: NONE at the CRDT layer. The TODO in `crdt.go:536-540` literally
says: *"We should store trusted-peer signatures associated to each head in
a timecache."* Issue #308 (signature-checking on deltas) was punted to
"use custom Deltas" — meaning the user can put a sig in the value bytes
and validate in `Delta.Unmarshal`, but the library does nothing for them.

**Why this matters**: this is OUR moat. Any improvements we adopt from
go-ds-crdt MUST preserve envelope signing + allowlist verification.
Specifically: when adopting delta-per-write, each delta block must carry
its own envelope+sig, not bundle multiple deltas under one sig. The
extra signing cost is worth the audit / replay / single-block-rejection
power.

---

## What we are NOT going to adopt, and why

1. **Their OR-Set conflict model with `bytes.Compare(value)` tiebreaker**.
   Surprise #2 in the deep-dive: their tiebreaker means `0xFF…` always
   beats `0x00…` at the same height. For arbitrary-bytes values that's
   defensible; for our structured docs (lessons, projects, retros) Automerge's
   per-field semantics are cleaner. Keep ours.

2. **Snapshotting with rollups (`PR #288`)**. Their maintainer explicitly
   abandoned this because "Merkle-DAG of snapshots is its own scaling
   problem." If we ever do snapshotting, we should learn from their
   experience first. See task T5 for the right framing.

3. **Single global putElems lock** (`set.go putElemsMux`). Per
   surprise #3: this is their write bottleneck, deliberately chosen to
   avoid per-key lock complexity. We don't have this problem because each
   doc is its own Automerge instance with its own lock; concurrent
   writes to different docs are independent.

4. **Repair-everything-on-any-failure** (their dirty bit is global, not
   per-branch — surprise #5). Our finer-grained per-doc isolation gives
   us a natural per-doc dirty bit if/when we adopt repair. Don't copy
   the global model.

5. **`PurgeDAG` as a local-only operation** (surprise #10). Useless
   without coordination; we should design any purge primitive to be
   replicated/quorum-based or not bother shipping it.

6. **Issue #279 unresolved** (their crash-during-processNode hole). When we
   build the analogous walker, mark blocks "processed" only after the
   subtree is done — not when the merge finishes. Avoid their bug by
   construction.

---

## Improvements to ship — task list

The follow-up tasks created in this HB:

- **T1 (Critical)**: Periodic head-CID rebroadcast — analog to go-ds-crdt's
  `RebroadcastInterval`. Closes the sequential-agent gap that #427
  documents at the bootstrap layer; this is the general fix.
- **T2 (Critical)**: Brain DAG repair / dirty-bit. Fix-fetch-failures
  retroactively when peers come back online.
- **T3 (Big bet)**: Wire format v2 — delta-per-write IPLD blocks with
  parent CID links. Closes HB#322 deferral; fixes HB#334 disjoint-history
  by construction; enables true anti-entropy.
- **T4 (Enabling)**: Heads-frontier tracking — multi-head per doc, broadcast
  full frontier instead of single CID.
- **T5 (Forward-looking)**: Block GC / snapshot rollup design doc — written
  with eyes-open about go-ds-crdt's #249/#288 abandoned attempt.
- **T6 (Observability)**: Brain doctor head-divergence check across peers.

T1+T2 are independent shippable wins on the v1 wire format. T3+T4 are a
coordinated v2 migration. T5 is a design doc, not a ship. T6 is small but
high-leverage for catching drift early.

---

## References

- ipfs/go-ds-crdt master @ `b883358d` (2026-04-15)
- Sanjuán/Pöyhtäri/Teixeira, "Merkle-CRDTs: Merkle-DAGs meet CRDTs"
  (arxiv 2004.00107)
- Open issues we should track:
  - `#249` (snapshotting discussion — what NOT to do)
  - `#279` (DAG branch left partly processed — what to design around)
  - `#199` (nodes building on unsynced branches — relevant for our
    POP_BRAIN_PEERS auto-dial scenario)
  - `#308` (closed — pre-merge validation; our auth story is upstream of this)
- Our prior art:
  - HB#322 — first mention of "go-ds-crdt-style delta-per-change"
  - HB#334 — disjoint-history Automerge.merge bug discovery
  - HB#335 — fresh/fresh tests miss the populated/fresh case
  - Task #350 — disjoint-history detection (shipped)
  - Task #352 — genesis-bootstrap fix (shipped)
  - Task #353 — import-snapshot migration (shipped)
  - Task #427 — bootstrap doc propagation (still open; superseded by T1)
