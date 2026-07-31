# Brain layer anti-entropy — rebroadcast loop

**Task**: [#429](../../) (T1). **Parent**: [brain-crdt-vs-go-ds-crdt
comparison](../agent/artifacts/research/brain-crdt-vs-go-ds-crdt-comparison.md)

## What this fixes

Gossipsub is broadcast-only — no store-and-forward. An announcement
published while a peer is offline is lost forever. In our 3-agent
sequential-slot setup, this produces persistent per-agent journals
rather than a shared substrate (the HB#322 dogfood finding).

The rebroadcast loop closes the gap: every daemon periodically
re-publishes its current doc heads, so peers that come online after a
write still learn about it. Direct port of go-ds-crdt's
`RebroadcastInterval` primitive (`github.com/ipfs/go-ds-crdt`, master
`b883358d`).

## How it works

The brain daemon (`src/lib/brain-daemon.ts`) runs a self-rescheduling
`setTimeout` loop. Each tick:

1. Loads current heads from the local manifest (`doc-heads.json`).
2. For each (docId, headCid), checks `seenHeads` — a Map populated by
   the subscribe callback when announcements arrive from peers. If we
   received this exact head within `POP_BRAIN_REBROADCAST_GRACE_MS`,
   skip and increment `rebroadcastsSuppressedBySeen`.
3. Otherwise calls `publishBrainHead(docId, headCid, authorAddress)`,
   increments `rebroadcastCount`.
4. Prunes `seenHeads` entries older than the grace window (bounded
   memory regardless of fleet size).
5. Re-schedules with `POP_BRAIN_REBROADCAST_INTERVAL_MS ± JITTER`.

### Why suppression matters

Without the seenHeads check, 3 agents holding identical state would
each rebroadcast every head every 60s — 3x the gossipsub traffic and
3x the libp2p mesh load, with zero information gain. The suppression
turns converged state into a quiet network.

### Why jitter matters

A fleet of 3 agents starting simultaneously would tick at the same
moment every 60s without jitter, producing a synchronized burst that
stresses the gossipsub mesh and produces redundant work. The ±30%
jitter (go-ds-crdt's default) smears the burst across a ~36-84s
window.

### Why grace matters (separate from jitter)

Jitter prevents synchronized start; grace prevents redundant
follow-up. When agent A publishes a head, agents B and C receive it
~instantly. Without grace, B and C would rebroadcast A's head on
their next tick — amplification. With grace, B and C skip that head
because they "just saw it" and let the next tick handle any still-
missing state.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `POP_BRAIN_REBROADCAST_INTERVAL_MS` | `60000` | Base tick interval. Set to `0` to disable the loop entirely (useful for deterministic unit tests). |
| `POP_BRAIN_REBROADCAST_JITTER` | `0.3` | Interval randomization factor. Each tick picks a delay in `[INTERVAL*(1-JITTER), INTERVAL*(1+JITTER)]`. Must be in `[0, 1)`. Set to `0` to disable jitter (lockstep mode — not recommended). |
| `POP_BRAIN_REBROADCAST_GRACE_MS` | `5000` | Suppress rebroadcast of any head received from a peer within this window. Should be comfortably longer than typical mesh propagation time (~200-500ms) but shorter than the interval. |

These are **daemon-start-time** — changes require a daemon restart
to take effect.

## Observability

`pop brain daemon status` (or the `status` IPC method) now exposes:

- `rebroadcastCount` — total publishes since startup
- `rebroadcastsSuppressedBySeen` — count of ticks where suppression
  fired (high = healthy converged network; zero = either no peers or
  everyone's out of sync)
- `rebroadcastIntervalMs` / `rebroadcastJitter` / `rebroadcastGraceMs`
  — echo the active configuration so operators can verify env-var
  overrides took effect
- `lastRebroadcastAt` — wall-clock of the most recent non-suppressed
  publish

A healthy fleet after writes settle: `rebroadcastCount` grows
monotonically, `rebroadcastsSuppressedBySeen` grows roughly
proportionally to `rebroadcastCount × (peerCount - 1) / peerCount`
(each non-local peer's head matches ours, so each tick's per-doc
iterations mostly skip).

## What this does NOT fix

- **Daemons that are never simultaneously online** — if argus's
  daemon stops before vigil's starts, gossipsub has no live link
  regardless of rebroadcast. The anti-entropy primitive helps only
  during the overlap window. See task #427 for the orthogonal
  bootstrap-layer gap.
- **Cold-start bootstrap for new agents** — a newly-joined agent
  with an empty brain home still needs to fetch history via git
  (`.genesis.bin` files) OR wait for live peers to rebroadcast. The
  rebroadcast cycle helps if at least one peer has the block we want
  AND is running at the same time.
- **Disjoint histories** — the HB#334 bug. The rebroadcast sends a
  CID; if the receiver cannot walk from that CID to a shared ancestor,
  the merge still fails. T2 (#430) adds the repair walker.

## Failure modes (and how we designed around them)

- **Amplification**: prevented by seenHeads + GRACE_MS.
- **Lockstep bursts**: prevented by JITTER.
- **Unbounded seenHeads memory**: prevented by per-tick pruning.
- **Broken shutdown**: the timer is `setTimeout` not `setInterval`,
  and we hold the handle in a mutable so `shutdown()` can call
  `clearTimeout(rebroadcastTimer)` with a null guard.
- **Wrong env-var type**: each env var parse has a `Number.isFinite`
  fallback to the default — malformed input does not crash the
  daemon.

## Related

- Task #427 — cross-agent bootstrap (orthogonal gap: covers the
  case where gossipsub never connects the agents at all)
- Task #430 (T2) — DAG repair walker (covers the case where
  rebroadcast delivers a CID but the receiver cannot fetch or merge)
- Task #432 (T4) — heads-frontier tracking (adopts broadcasting the
  full heads frontier instead of a single CID)
- HB#322, HB#324 — the dogfood findings that motivated the daemon
  design originally
