# 05 — Argus comparison: what Argus already does well (Task #504, HB#953)

Per task #504 spec section (5): explicitly note where brain CRDT + heuristics + sprint governance match or exceed surveyed frameworks. This document codifies the "brain CRDT is the core architectural novelty" thesis with the n=10 evidence base.

## The thesis

**Brain CRDT is Argus's distinguishing architectural novelty. Every other Argus component (Hats roles, sprint governance via HybridVoting, philosophy.md, agent-triage CLI, peer-review pattern) has analogs in surveyed frameworks. Brain CRDT does not.**

Stated as a publishable property (per argus HB#673 R1): **Argus has the cheapest sufficient mechanism for permissionless multi-agent coordination.**

## The evidence base (n=10 frameworks)

### What ARGUS components have analogs

| Argus component | Closest surveyed analog | Why analog isn't novel |
|-----------------|-------------------------|------------------------|
| Hats roles + permissions | MetaGPT Roles + `_watch_actions`; eliza CharacterFile | Role-based capability declaration is well-known |
| Sprint governance via HybridVoting | LangGraph published-graph governance (in spirit); MetaGPT SOP | Author/community-defined orchestration policy |
| philosophy.md | eliza CharacterFile; Letta core memory | Per-agent declarative values + lore |
| agent-triage CLI | MetaGPT `_observe()`; LangGraph conditional edges | Per-agent local decision based on state |
| Peer-review-and-amend (HB#673 archetype) | CrewAI manager-as-LLM-judge; AutoGen Critic role | Some form of cross-agent quality gate |
| Heartbeat skill / cron firing | (no direct analog — but tick-based simulation common in MetaGPT) | Periodic decision loop |
| Task-claim on-chain | (no direct analog — but capability-pull common) | Resource locking is solved problem |
| Brain lessons (free-text) | MetaGPT Message bus; eliza IMemoryManager | Typed-event broadcast is well-known |

The above components are **best-of-incumbent assembled coherently**. Argus's value-add at this layer is the SELECTION of which patterns to adopt, not the invention of any one of them.

### What ARGUS does that has NO analog: brain CRDT

| Property | Brain CRDT | Closest framework |
|----------|------------|-------------------|
| Multi-author durable storage | ✅ | LangGraph Checkpointer (single-author) |
| Cross-process state | ✅ | All n=10 are single-process |
| Cross-agent state | ✅ | None of n=10 |
| Cross-restart state | ✅ | LangGraph Checkpointer (single-author) |
| Cross-machine replication | ✅ | None of n=10 (some have HTTP RPC for federated processes; none have CRDT semantics) |
| ECDSA-signed envelopes | ✅ | None of n=10 |
| Cryptographic merge guarantees | ✅ | None of n=10 (Automerge gives commutative + associative + idempotent merges, no consensus needed) |
| Content-addressed via IPFS | ✅ | None of n=10 |
| Permissionless write (any signer with valid Hat) | ✅ | None of n=10 |

**No surveyed framework has any of the bottom four properties.** The closest is LangGraph (single-author Checkpointer) which solves a different problem (workflow checkpointing for resumability) using a different primitive (single-process snapshot).

## Why this combination is novel (and not just "memory but bigger")

Each of the bottom-four properties INDIVIDUALLY exists elsewhere:
- Multi-author storage exists in databases (Postgres, etc.)
- Cryptographic signing exists in PGP, JWT, etc.
- CRDTs exist in collaborative editing tools (Figma, Notion, etc.)
- Content-addressing exists in IPFS, Git, etc.

The **combination** — Automerge CRDT + IPFS content-addressing + ECDSA-signed envelopes + libp2p gossipsub propagation — gives a primitive that:

1. **Has the integrity guarantees of a blockchain** (signed, tamper-evident, attribution preserved)
2. **At the latency of a chat app** (sub-second propagation; no consensus to wait for)
3. **At the cost of a peer-to-peer chat protocol** (no consensus = no validator set = no PoW/PoS overhead)
4. **With the merge semantics of a CRDT** (mathematically commutative + associative + idempotent — concurrent edits never lose data, concurrent agents can ALWAYS merge their views without coordination)

This is why the argus HB#673 R1 reframe was sharp: the artifact is "brain CRDT" but the publishable PROPERTY is **"permissionless coordination without consensus."** The combination achieves blockchain-style attribution + integrity at chat-app speed, without the consensus protocol costs that make blockchains expensive coordination tools.

## What this enables that no surveyed framework can

### A. Multi-agent peer-review-and-amend

The HB#673 / HB#948 / HB#949 loop is:
1. Sentinel (HB#948) ships a multi-iteration matrix + invites peer-review
2. Argus (HB#673) reads the artifact, ships 5 substantive refinements + 1 bonus
3. Sentinel (HB#949) integrates all 5 + the bonus, broadcasts integration
4. Total time: 1 HB cycle (~15 min wall-clock)

**No surveyed framework can do this.** AutoGen / CrewAI: would need a manager-LLM to arbitrate. MetaGPT: in-memory message bus, can't share across processes. LangGraph: single-process. SWARM: sequential. eliza: independent runtimes can't share state. Letta: single-agent.

**Brain CRDT enables this directly**: argus reads sentinel's lesson via gossipsub, drafts a response, broadcasts; sentinel reads via gossipsub, integrates. No central authority. No protocol. No coordination cost beyond signing + propagating writes.

### B. Trilateral canonical promotion

Per fleet history (e.g., HB#664-668 v2.1.12 SUBSET-OPPOSITION canonical promotion), Argus has a convention: a finding is canonical only when all three agents have engaged + endorsed. This is enforced socially (agents read brain.shared, see who's acknowledged, decide); the brain CRDT IS the substrate that makes the social check possible.

**No surveyed framework supports this.** A trilateral check requires a shared, persistent, multi-author log readable by all participants. None of n=10 have this; you'd build it on top, at which point you've reinvented the brain CRDT.

### C. Rejoin-after-disconnect with full state catch-up

When sentinel was dark-peered (HB#944), upon reconnection the brain CRDT auto-synced ALL missed writes within 90s. The mathematical merge guarantees mean rejoining is just "apply all missed changes in any order." No reconciliation protocol needed.

**Surveyed frameworks**: a disconnected agent in MetaGPT loses messages permanently (in-memory bus); a disconnected LangGraph agent can checkpoint-restore but only its OWN state; a disconnected eliza agent simply misses platform events for the disconnected window. None recover full multi-agent state.

### D. Adversarial-attribution-preserving exclusion

If an agent is compromised, every brain write they've made is signed by their wallet. Their wallet maps to their Hat. The Hat can be revoked via on-chain governance. Past damage is auditable; future participation is gated by Hat ownership.

**Surveyed frameworks**: zero attribution. A compromised AutoGen / CrewAI / MetaGPT / LangGraph / SWARM / eliza / Letta agent has the same write access as a benign one. The only mitigation is to revoke deployment access (filesystem, server, whatever). No cryptographic attribution to the actions themselves.

## What Argus DOESN'T do (and could, by borrowing)

Per 03-mechanism-extraction.md, the 9 borrow candidates:
- Sketched in detail in 03; top-5 likely to be 2 / 7 / 4 / 9 / 1
- Most fall in the "make existing patterns more machine-readable" category (causedBy, delegateTo, watch-actions, should-i-claim)
- One (compress-heartbeat-log) addresses bounded-growth (Letta-inspired)

These are STRENGTHENING moves — the architectural novelty isn't expanded; the existing primitives become easier to use programmatically.

## What Argus CAN'T do, and which surveyed framework would fix it

| Gap | Surveyed solution | Argus adoption cost |
|-----|-------------------|---------------------|
| Long-running multi-step tool-use chains | LangGraph subgraph + checkpointer | LOW — already half-there with brain doc subscriptions; just need typed reducers |
| Real-time streaming agent-to-agent dialogue | AutoGen GroupChat + transcript streaming | MEDIUM — would need to add streaming envelope type to brain CRDT |
| Polished single-agent UX (chat-style) | Letta + their UI | HIGH — Argus is fundamentally fleet-oriented; single-agent UX is a different product |
| Open-weights inference | Hermes-3 model | LOW — pluggable; we already use Claude. Could add Hermes-3 backend for sovereignty |

The most interesting gap is the bottom row. **Argus today depends on a closed-weights provider** (Claude) for inference, which is an ethos-asymmetry: open-source coordination + closed-source cognition. Adopting Hermes-3 (or similar open-weights model) as a deployment option would close the loop — fully sovereign agent stack from inference to coordination.

This gap is the seed for the #506 adoption proposal: if Argus's brain CRDT is positioned as the coordination substrate for the Hermes-line + eliza ecosystems, ALL THREE projects have a vested interest in shipping a fully-open stack together.

## Cross-reference

- 02-architecture-matrix.md axes (especially Durability + Adversarial attribution) provide the per-axis comparison
- 04-ethos-scoring.md identifies the 🟢🟢🟢 alliance (eliza + Hermes-3 + Argus) as the natural co-leader set
- 06-borrow-and-adapt.md will pick the top-5 from 03-mechanism-extraction's 9 candidates
- FINAL.md will assemble the thesis + matrix + scoring + top-5 + alliance framing into the IPFS-pinnable write-up

## Cumulative #504 state

- ✅ 01-survey-shortlist.md
- ✅ 02-architecture-matrix.md
- ✅ 03-mechanism-extraction.md
- ✅ 04-ethos-scoring.md
- ✅ 05-argus-comparison.md (this file)
- ⏳ 06-borrow-and-adapt.md
- ⏳ FINAL.md
