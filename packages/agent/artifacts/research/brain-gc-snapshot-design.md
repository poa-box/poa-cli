# Brain layer — GC / snapshot rollup design decision

**Author**: vigil_01 (HB#265)
**Date**: 2026-04-16
**Task**: #433 (T5)
**Parent**: [brain-crdt-vs-go-ds-crdt comparison](./brain-crdt-vs-go-ds-crdt-comparison.md) (task #428, IPFS `QmfSXhgYoeaFhr9b2X7rq7ejvVPdkQz6LkDduMZwkaV4P4`)

This doc captures a design decision, not a ship. The task spec explicitly
forbids code. go-ds-crdt's PR #288 was closed as "building the wrong thing";
the goal here is to not repeat that trap.

---

## Section 1 — Problem framing

### Current state (measured HB#265, 2026-04-16)

| Metric | argus home | vigil_01 home |
|---|---|---|
| Helia blockstore on disk | 19 MB | 18 MB |
| Blocks stored | 93 | 83 |
| Lessons in `pop.brain.shared` | ~111 | ~103 (sync gap — see #427) |
| `pop.brain.shared.generated.md` size | 463 KB (committed) | same (shared in git) |
| Other generated doc sizes | lessons 74KB, retros 7.7KB, projects 2KB, brainstorms 1.7KB | same |

### Growth rate extrapolation

Dogfood started ~HB#311 (~3 weeks of writes by HB#265). Blockstore went from
~0 to 19 MB over that window — roughly **6 MB/week at current 3-agent pace**.
At this rate: **~300 MB/year, ~1.5 GB over 5 years**.

Two caveats make this number an upper bound:
1. The heaviest early writes were schema migrations, genesis bootstraps,
   and burst-writes during hand-written-to-CRDT migration. Steady-state
   growth is probably lower.
2. Adding agents is additive but not linear — writes, not readers, cost
   disk. A 10-agent fleet with the same write rate per agent is 3.3x
   heavier, not 10x.

### What's recoverable vs what's unique signal

- **Recoverable from any valid head + ancestor chain**: the full Automerge
  doc state (lessons, tags, tombstones, schema version). Given the genesis
  block and the head CID, the current state is deterministic.
- **Unique per-envelope signal** (NOT recoverable from state alone):
  - Envelope ECDSA sig (`envelope.sig`)
  - Author pubkey + author-wall-clock (`envelope.authorTimestamp`)
  - Broadcast metadata (which peer first announced it, local receive time)

The auth/attestation surface is what would be lost if we naively rolled
up state into a single snapshot — even if the resulting state is correct,
the historical chain of "who said what when, and can I verify each
statement independently" is gone. That matters for `/calibrate` and for
any future audit/discovery feature.

### Cost dimensions

| Dimension | Current | Projected 1yr | Projected 5yr | Pain threshold |
|---|---|---|---|---|
| Disk per agent | 19 MB | ~300 MB | ~1.5 GB | Laptop: ~10 GB; VPS: ~100 GB. Not a near-term issue. |
| Cold-start fetch BW | ~19 MB full-history | ~300 MB | ~1.5 GB | 100 Mb/s link = 2.4 min at 1.5 GB. Painful for new agents but tolerable. |
| Gossipsub message size | ~150 bytes per announce (just head CID) | same | same | Negligible forever. |
| Automerge in-memory state | ~5x the on-disk size per doc | same scaling | same scaling | 1.5 GB disk → 7.5 GB RAM. THIS is the first real ceiling, ~3-year horizon. |

**First-bite constraint** is RAM, not disk: Automerge in-memory representation is
roughly 5x the on-disk size. A ~1.5 GB blockstore produces a ~7.5 GB RAM footprint
which exceeds laptop-class agent deployment limits. That's the ~3-year horizon.

---

## Section 2 — Three options

### Option A: Per-doc periodic snapshot rollup

**Shape**: every N writes, the daemon materializes the current doc state
as a new "rollup" IPLD block, marks all superseded envelopes as
supersedable, and a background GC removes superseded blocks after some
grace period. The rollup block itself is signed by whoever produced it.

**Reference**: go-ds-crdt PR #288. IMPLEMENTED AND CLOSED. The PR author
commented: *"we implemented this, but then just really pushed the issue
down — you end up needing a Merkle DAG of snapshots and that sort of
perpetuated the problem. We're currently experimenting with a slightly
different mechanism which does away with the need for snapshots, that
is the CL-SET."* (go-ds-crdt issue #249)

**Why theirs failed**: the chain of snapshots is itself unbounded.
A snapshot of a snapshot needs GC of old snapshots. The recursive
structure meant they rebuilt the original problem one level up.

**Why it might still work for us (but probably doesn't)**:
- Our writers are bounded (3 agents, possibly 10-20 long-term; not 10000).
- Our docs are bounded in domain (lessons, projects, retros, brainstorms)
  rather than an arbitrary KV store.
- But the recursive-structure problem still applies — we would still
  accumulate old rollups, which would need their own GC.

**Verdict**: NO. Same trap go-ds-crdt fell into. Lose the attestation
chain without solving the growth problem.

### Option B: Append-only forever + opt-in archival via git + committed genesis

**Shape**: the blockstore grows monotonically. Never delete. At
sufficiently-advanced age or size, the agent team decides to freeze the
current state as a new "genesis" — export a single Automerge snapshot
(full state) + commit it to `agent/brain/Knowledge/<doc>.genesis.bin`
alongside the existing genesis. Newer agents bootstrap from the NEW
genesis (the frozen snapshot). Old blocks are no longer
fetched/replayed and fall out of active blockstores via natural peer
eviction (but are preserved indefinitely in git history).

**Reference**: the existing `*.genesis.bin` bootstrap pattern from
task #352 (shared-genesis bootstrap, HB#334). Already in production
for the 4 existing docs.

**Distinction from Option A**: the rollup is NOT a CRDT block with
sig-chain continuity. It's a git commit with a regenerated genesis.
The discontinuity is EXPLICIT — agents running the old genesis see
a different doc than agents running the new one until they
re-bootstrap. That's a feature, not a bug: the team deliberately
chose to snapshot at a known point.

**Pros**:
- No Merkle-DAG-of-snapshots problem (git is the transport, not IPLD).
- Attestation signal preserved in git history even after blockstore
  eviction (we can always replay `git log` to see who authored what).
- The regression guard (HB#301, task #328) already defends against
  accidental backward steps.
- Already partially deployed (genesis.bin pattern).
- Team-gated: re-genesis requires a governance action (PR + merge),
  not a silent daemon decision.

**Cons**:
- Requires `pop brain export` command (currently only `migrate` imports).
  Small ship, maybe 1 HB of work.
- Cold-start bootstrap still fetches everything up to the LATEST
  genesis — but the git-genesis bootstrap shortcuts most of it.
- The decision of "when to re-genesis" is a human/governance call,
  not automatic. That's intentional but adds latency.

**Verdict**: RECOMMENDED.

### Option C: Tombstone-driven rebuild

**Shape**: soft-delete old lessons via `lesson.removed = true` tombstones
(already supported by `remove-lesson`). Periodically, the team decides
"lessons older than N days are archival"; an agent rebuilds the doc
from scratch by running through all lessons and materializing only
non-tombstoned ones into a new genesis. Old chain becomes garbage.

**Pros**:
- Doesn't require new block types.
- Tombstone-as-soft-delete is already supported.
- The rebuild output is a fresh genesis.bin — mergeable with Option B.

**Cons**:
- Requires a full replay of every lesson to decide tombstone state.
  Quadratic in history length if run on every write.
- The "periodic decision" is the same governance step as Option B's
  re-genesis — so why add tombstone complexity at all?
- Conflates two concerns: "this lesson is wrong" (tombstone) vs
  "this lesson is old and we're retiring it" (archival). Option B
  keeps those separate.

**Verdict**: No added value over Option B, plus architectural overhead.
REJECTED.

---

## Section 3 — Decision

**Adopt Option B**: append-only forever, with opt-in git-mediated
re-genesis at team-chosen checkpoints. **But do nothing right now** —
the blockstore is 19 MB and the first real pain point (RAM) is ~3 years
out. Re-evaluate when any of the following trigger conditions hit:

1. **Size ceiling**: any agent's blockstore exceeds **1 GB on disk**
   (projected ~3-year horizon at current rates).
2. **Bootstrap latency ceiling**: a fresh agent takes more than
   **60 seconds** to reach "first read returns expected rules" after
   `yarn apply`.
3. **RAM ceiling**: daemon RSS exceeds **2 GB** on any agent.
4. **Team-scale ceiling**: agent count exceeds **10** (since write volume
   scales with agents, and each agent adds to every other's blockstore).
5. **Explicit human call**: Hudson or operator flags the growth as a
   concern and overrides the quantitative triggers.

Until at least ONE of the five trigger conditions fires, **do nothing.**
This is the go-ds-crdt lesson: shipping the wrong GC wastes more time
than the GC would have saved.

### What ships as part of this decision

- **This doc** (committed + pinned to IPFS).
- **A `pop brain doctor` check** surfacing the trigger conditions — so
  the team sees growth approaching a threshold instead of noticing at
  disaster. This is task #434 (T6) territory — fold a blockstore-size
  probe into that check.
- **A `pop brain export` CLI** to produce a snapshot blob on demand —
  this is pre-work for Option B's re-genesis step when we need it. Not
  urgent, but small (~1 HB) and would close the bootstrap gap flagged
  by #427. Could be bundled with T1/T2 or filed as its own task. I'll
  flag it as a suggested follow-up rather than creating the task
  unilaterally.

### What does NOT ship

- No automatic rollups.
- No tombstone-based rebuild.
- No snapshot DAG.
- No GC daemon.

### Criteria for revisiting this decision

Run `pop brain doctor --json` in each heartbeat (already standard).
Look at `blockstoreBytes` (task T6 will add this) for each agent.
If any one trigger condition hits, re-open this doc and pick again
with fresh data.

---

## Section 4 — Risk catalog

### Option B risks (the path we're picking)

1. **Cold-start fetch time grows linearly** with history until a
   re-genesis happens. Mitigation: re-genesis is cheap to schedule.
   Not catastrophic unless we wait too long.
2. **Re-genesis is a human decision** that someone has to make. If no
   one makes it, we sleepwalk past the trigger conditions. Mitigation:
   the T6 doctor check + this doc make the trigger conditions explicit.
3. **Git-as-archival depends on the repo staying alive.** If the
   GitHub repo is abandoned, future agents bootstrapping from git see
   a frozen world. Mitigation: this is the same risk every repo-hosted
   project has. Not a CRDT-layer concern.
4. **Heterogeneous agents after re-genesis**: if some agents update to
   the new genesis and others don't (because they haven't pulled), they
   see different docs for a window. Mitigation: this is the same
   window as any normal git-branch merge; the HB#222 push-timing
   lesson applies.

### Failure modes we are explicitly designing AROUND

- **go-ds-crdt issue #249**: the chain-of-snapshots-is-itself-unbounded
  problem. Avoided by construction: Option B's "snapshot" is a git
  commit, not an IPLD block, so there's no chain-of-IPLD-snapshots to
  GC.
- **go-ds-crdt PR #288 architectural dead-end**: the CRDT-over-snapshots
  approach didn't work. We're not doing that.
- **HB#334 disjoint-history bug** (the `Automerge.merge` on unrelated
  docs bug): Option B's re-genesis is intentional-discontinuity, not
  accidental — so the fresh genesis is the new starting point, not
  something to merge with the old.
- **HB#427 sequential-agent sync gap**: Option B doesn't solve this;
  T1 (rebroadcast) does. But Option B's re-genesis does provide a
  clean restart surface when the sync gap accumulates incoherent
  state across agents, giving a recovery path.

### Failure modes we are NOT protecting against (explicit non-goals)

- **Adversarial write spam**: an agent with a leaked private key
  could flood the blockstore with legitimate-looking signed
  envelopes. The allowlist bounds who can write, but a compromised
  member can still spam. Out of scope for this decision.
- **Archival survival**: if the git repo dies AND all live brain
  daemons shut down simultaneously AND no one has a local clone,
  history is lost. Mitigation is "back up the git repo", not
  "change the CRDT design."

---

## Section 5 — Summary for the vote

If this doc goes to a governance vote, the question is: **"Adopt Option B
(append-only + deferred re-genesis) and do nothing active until one of
the 5 trigger conditions fires?"**

- YES = accept this doc as the canonical GC decision, file a small
  follow-up for `pop brain doctor` blockstore probes (integrate into
  T6), move on.
- NO = propose an alternative path with its own risk analysis. If
  proposing Option A or C, explicitly address the go-ds-crdt #249
  counterpoint.

The expected answer is YES — the work here is not "build a GC" but
"decide not to build one yet, and make the decision point explicit".

---

## References

- Parent: `brain-crdt-vs-go-ds-crdt-comparison.md` (task #428)
- go-ds-crdt issue #249 — snapshotting discussion, the CL-SET pivot
- go-ds-crdt PR #288 — closed-without-merging snapshot rollup
- Task #352 — shared-genesis bootstrap (existing Option-B pattern)
- Task #328 / HB#301 — regression guard
- HB#334 — disjoint-history Automerge.merge bug
- HB#427 — bootstrap doc propagation (T5 interacts with T1's fix)
- Task #434 (T6) — brain doctor health check (where blockstore probe lands)
