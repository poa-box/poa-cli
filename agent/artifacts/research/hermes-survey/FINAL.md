# Hermes-research catalog: open-source agent-team frameworks vs Argus's brain CRDT

**Survey + ethos analysis of 10 open-source agent / multi-agent frameworks, with Argus as the comparison baseline. Identifies the architectural property — "permissionless coordination without consensus" — that distinguishes Argus, names a candidate three-way alliance (eliza + Hermes-3 + Argus), and selects 5 borrow-and-adapt patterns Argus could ship as a single sprint.**

*Author: sentinel_01 (Argus). Task #504, Sprint 21, HB#945–955. Peer-validated by argus_prime HB#673 (5 substantive refinements integrated). Underlying analyses (01–06) at `agent/artifacts/research/hermes-survey/` in poa-cli main branch.*

---

## 1. Why this survey

Hudson directive HB#592 ("operator-priority sprint-insertion") asked Argus to inventory the open-source "Hermes" agent-team space — Nous Research's Hermes-line plus adjacent multi-agent frameworks (AutoGen, CrewAI, MetaGPT, CAMEL-AI, LangGraph, MAS, Magentic-One). Goal: extract substrate + governance patterns Argus could borrow WHILE PRESERVING our decentralized + worker-owned + community-owned ethos. The companion tasks #505 (3-agent brainstorm) and #506 (adoption proposal) chain off this catalog.

The survey covers **10 frameworks across three families**:

- **Hermes-line** (required per task spec): Hermes-Function-Calling, Hermes-3 ecosystem
- **Multi-agent incumbents**: AutoGen, CrewAI, MetaGPT, LangGraph
- **Decentralization-adjacent**: SWARM, eliza, Letta — plus Argus itself as the baseline

CAMEL-AI, AutoGPT, and Magentic-One are sketched in the shortlist but deferred from deep-read; their preliminary ethos reads are sufficient for the matrix overview.

---

## 2. The seven-axis architecture matrix

Each framework was read along seven axes. The first five surfaced naturally; the last two were added per argus_prime's HB#673 peer-review (see §6).

| Axis | Question |
|------|----------|
| **Orchestration** | Where does the "who acts next" decision live? |
| **Shared state** | What's persisted across turns / sessions / agents? |
| **Task assignment** | How does a unit of work bind to an agent? |
| **Consensus / dissent** | What happens when two agents disagree? |
| **Rejection / quality control** | How is bad output filtered? |
| **Durability scope** *(R2)* | What survives restart / operator-change / process-death? |
| **Adversarial attribution** *(R3)* | When a write is malicious, can it be IDENTIFIED + ATTRIBUTED? |

### Summary table (all 7 axes × 7 frameworks)

| | AutoGen | CrewAI hier | CrewAI seq | MetaGPT | LangGraph | SWARM | eliza | **Argus** |
|---|---|---|---|---|---|---|---|---|
| Orchestration | manager-LLM | manager-LLM | fixed pipeline | tick + role-react | author DAG | self-handoff | none | none |
| Shared state | transcript | optional ChromaDB | optional | Env.history (mem) | Checkpointer | context_vars (ephemeral) | per-agent IMM | **brain CRDT (replicated, signed)** |
| Task assignment | manager picks | manager delegates | hardcoded | _watch_actions | edge routing | tool-call handoff | platform events | **on-chain claim + signaling** |
| Consensus/dissent | speaker-order | manager arbitrates | n/a | none | reducer merge | none | none | **peer-amend + HybridVoting + trilateral** |
| Rejection/QC | optional Critic | LLM-judge | n/a | QA Role (SOP) | author loop | none | per-agent prompt | **cross-agent task-review** |
| Durability scope | process | process or session | process | process | restart | run | session | **LIFETIME (on-chain + replicated CRDT)** |
| Adversarial attribution | zero | zero | zero | zero | zero | zero | zero | **strong (ECDSA + on-chain Hats)** |

### Three observations

**1. The decentralization-axis distribution is starker than expected.**

- HARD-CENTRALIZED at runtime: AutoGen (GroupChatManager), CrewAI hierarchical (manager_llm)
- DECENTRALIZED-RUNTIME / CENTRALIZED-AT-DESIGN-TIME: MetaGPT (SOP), LangGraph (graph topology), CrewAI sequential (pipeline)
- DECENTRALIZED-AT-BOTH-LAYERS: SWARM (handoff via tool-call), eliza (sovereign runtimes), Argus

Three frameworks have NO orchestration layer at all (SWARM, eliza, Argus). Of those three, only Argus has structured shared state. SWARM is sequential + ephemeral; eliza is concurrent + isolated. **Argus is concurrent + COORDINATED — the unique combination.**

**2. Persistent shared state is the diff-axis.**

None of the n=10 surveyed frameworks has a CRDT-style multi-author durable store as a first-class primitive. The closest analogs all collapse to single-process or single-author:

- LangGraph Checkpointer (single-process, store-agnostic, single-author)
- MetaGPT Environment.history (in-memory, single-process)
- eliza per-agent IMemoryManager (per-agent, no cross-agent merge)
- SWARM context_variables (per-run, ephemeral)
- Letta three-tier memory (per-agent, no cross-agent share)
- AutoGen / CrewAI: optional memory plugins, per-instance

Argus's brain CRDT (Automerge + IPFS content-addressing + ECDSA-signed envelopes + libp2p gossipsub) has no analog in this baseline.

**3. Convergent design hints validate Argus's architecture.**

- LangGraph's `Checkpointer` ≈ unified-ai-brain's `HeadsManifestStore` (store-agnostic persistence interface)
- MetaGPT's `Environment.history` ≈ `pop.brain.shared` (typed broadcast bus)
- eliza's typed `IMemoryManager` ≈ Argus's typed brain docs (`pop.brain.shared` / `lessons` / `heuristics`)
- SWARM's `context_variables` ≈ a typed brain doc with reducer
- Letta's three-tier memory (core / archival / recall) ≈ Argus's organic split (`Identity/` files / brain.shared / heartbeat-log)

Independent designers reaching converging abstractions. Argus's architectural choices are well-grounded; we simply got there earlier from the "decentralized substrate first" direction.

---

## 3. Ethos scoring (D × W × C)

Each framework scored on: **Decentralization (D)**, **Worker-ownership-compatibility (W)**, **Community-governance-compatibility (C)**. Five-color key: 🟢 HIGH / 🟡 MEDIUM / 🟠 LOW / 🔴 RED / N/A.

```
                    D       W       C
AutoGen GC          🔴      🟡      🟡    centralization is structural
CrewAI hier         🔴      🟠      🟡    manager-subordinate model
CrewAI seq          🟠      🟡      🟡    fixed pipeline, no agency
MetaGPT             🟡      🟡      🟡    SOP is design-time captain
LangGraph           🟡      🟢      🟢    graph IS centralized but author-owned
SWARM               🟢      🟢      🟡    peer-handoff, sequential-limited
eliza               🟢      🟢      🟢    maximally decentralized
Letta               🟡      🟢      🟡    single-agent caveat
Hermes-3 eco        🟢      🟢      🟢    open-weights substrate
Argus               🟢      🟢      🟢    all three by construction
```

### The 🟢🟢🟢 alliance (the headline finding for #506)

Three projects score 🟢🟢🟢 across all axes: **eliza + Hermes-3 + Argus.** They have **structurally aligned ethos, complementary capabilities, and zero competitive overlap**:

- **Hermes-3 ecosystem** = open-weights inference (no provider lock-in)
- **eliza** = sovereign per-agent runtimes (no central anything)
- **Argus** = coordination substrate via brain CRDT (permissionless multi-agent shared state)

This is the natural alliance for the Argus #506 adoption proposal: pitch Argus's brain CRDT as the missing coordination layer the eliza + Hermes-3 communities could adopt without giving up sovereignty. Open-weights inference + sovereign runtimes + permissionless coordination = a fully sovereign agent stack.

### Hard-RED warnings

The pattern of *"bake the orchestrator into the framework abstraction"* is what borrow-and-adapt should explicitly NOT recommend. Subclassing AutoGen's `GroupChatManager` or replacing CrewAI's `manager_llm` doesn't recover the ethos — the abstraction itself assumes one decider. Architectural choice = ethos consequence. Use these frameworks as warnings, not models.

---

## 4. What Argus already does well (and what's actually novel)

Every Argus component except the brain CRDT has analogs in surveyed frameworks:

- Hats roles + permissions ≈ MetaGPT Roles + `_watch_actions`; eliza CharacterFile
- Sprint governance via HybridVoting ≈ LangGraph published-graph governance (in spirit)
- philosophy.md ≈ eliza CharacterFile; Letta core memory
- agent-triage CLI ≈ MetaGPT `_observe()`; LangGraph conditional edges
- Peer-review-and-amend ≈ CrewAI manager-as-LLM-judge; AutoGen Critic role
- Heartbeat skill / cron firing ≈ MetaGPT tick-based simulation
- Brain lessons (free-text typed broadcast) ≈ MetaGPT Message bus; eliza IMemoryManager

These are **best-of-incumbent assembled coherently**. Argus's value-add at this layer is the SELECTION of which patterns to adopt, not the invention of any one of them.

The brain CRDT is different. The COMBINATION of:

- Automerge CRDT (commutative + associative + idempotent merges; concurrent edits never lose data)
- IPFS content-addressing (data integrity)
- ECDSA-signed envelopes (attribution + non-repudiation)
- libp2p gossipsub propagation (sub-second cross-machine)

…has no analog in n=10. Each piece exists individually (databases, PGP, CRDTs, Git/IPFS). The combination achieves:

- **Integrity guarantees of a blockchain** — signed, tamper-evident, attribution preserved
- **Latency of a chat app** — sub-second propagation; no consensus to wait for
- **Cost of a peer-to-peer chat protocol** — no consensus = no validator set = no PoW/PoS overhead
- **Merge semantics of a CRDT** — concurrent agents can ALWAYS merge views without coordination

This is the publishable property (per argus HB#673 R1):

> **Argus has the cheapest sufficient mechanism for permissionless multi-agent coordination — coordination without consensus.**

### Four capabilities no surveyed framework can replicate

1. **Multi-agent peer-review-and-amend.** The HB#673 / HB#948 / HB#949 loop in this very catalog: sentinel ships an artifact + invites peer review (HB#948); argus reads via gossipsub, ships 5 substantive refinements + 1 bonus (HB#673); sentinel integrates all 5 + bonus, broadcasts integration (HB#949). One-HB cycle (~15 min wall-clock). Self-illustrating evidence for the architectural pattern this catalog theorizes about.

2. **Trilateral canonical promotion.** Per fleet history (e.g., HB#664–668 v2.1.12 SUBSET-OPPOSITION canonical promotion), Argus has a convention that a finding becomes canonical only when all three agents have engaged + endorsed. This is enforced socially; the brain CRDT IS the substrate that makes the social check possible.

3. **Rejoin-after-disconnect with full state catch-up.** When sentinel was dark-peered (HB#944), upon reconnection the brain CRDT auto-synced ALL missed writes within 90s. Mathematical merge guarantees mean rejoining is just "apply all missed changes in any order."

4. **Adversarial-attribution-preserving exclusion.** Every brain write is signed by the author's wallet. Wallet maps to Hat. Hat can be revoked via on-chain governance. Past damage is auditable; future participation gated by Hat ownership. The other 9 surveyed frameworks have ZERO cryptographic attribution.

### What Argus DOESN'T do (and could borrow)

Identified one ethos asymmetry: **open-source coordination + closed-source cognition**. Argus today depends on a closed-weights provider (Claude) for inference. Adopting Hermes-3 (or similar open-weights model) as a deployment option would close the loop — fully sovereign agent stack from inference to coordination. This is the bridge to the #506 adoption framing.

---

## 5. Top-5 borrow-and-adapt with shippable task specs

Selected from 9 candidates surfaced during deep-read (full sketches in `03-mechanism-extraction.md`):

| # | Source | Pattern | Adaptation | Effort | PT |
|---|--------|---------|-----------|--------|----|
| 1 | MetaGPT | `Message.cause_by` (refined per R5: exposed view of Automerge change-graph) | Optional `causedBy` field on brain lessons + `pop brain thread` CLI | S | 12 |
| 2 | SWARM (refined per R4) | `delegateTo` SUBTYPE of claim-signaling (single mechanism, not parallel) | Optional `delegateTo` field on claim lessons + heartbeat auto-claim integration | S | 14 |
| 3 | AutoGen (inverted) | Agent-side selection prompt (each agent decides independently) | New `should-i-claim` skill consumed by heartbeat | M | 18 |
| 4 | Letta + R6 | Voluntary tier-routing + involuntary-fallback compression | New `compress-heartbeat-log` skill (threshold-triggered) | M | 16 |
| 5 | MetaGPT | `_watch_actions` capability-pull | `subscriptions.json` per agent + `pop agent triage --watch` | M | 18 |

Total follow-up scope: **78 PT, ~19 hours, spreadable across all 3 fleet agents.**

Two natural shipping units:

- **Unit A — "Machine-readable deliberation"** (specs 1+2+3+5; ~62 PT, ~14h): typed brain-lesson interaction layer. `causedBy` adds typed cause-effect refs; `delegateTo` adds typed peer-handoff refs; `should-i-claim` consumes both; `subscriptions.json` filters on them.
- **Unit B — "Bounded growth"** (spec 4; ~16 PT, ~4h): standalone but pairs cleanly with `causedBy` for thread-boundary detection during compression.

Selection criteria: prefer XS/S/M effort (high shipping velocity); prefer items that PAIR (units A and B); prefer ethos-strengthening items (those that sharpen the "permissionless coordination without consensus" property); explicitly invert the AutoGen GroupChatManager pattern (NOT borrow it).

### Future-work appendix

Items deferred from the top-5:

- **Reducer-typed merge layer** (LangGraph-inspired, L effort + HIGH risk) — wraps the daemon merge path; significant invasive work for incremental gain. Revisit when concurrent-edit conflicts become observable in practice.
- **`expected_output` + LLM-judge** (CrewAI) — useful but brain-lesson peer-review already serves the function; codify the protocol first, tooling later.
- **Decision-graph doc** (LangGraph-inspired) — small enough to be a doc-day chore.
- **CharacterFile derived view** (eliza) — interop primitive, not an internal need.

---

## 6. Methodology + provenance

The 7-axis architecture matrix was iteratively built across HB#945–950 (sentinel deep reads at n=2, then n=4, then n=6, then n=10 entries). At HB#673, argus_prime peer-validated the n=6 cut and returned 3 validates + 5 substantive refinements + 1 bonus:

- **R1**: sharper novelty framing — name the property, not just the artifact ("permissionless coordination without consensus")
- **R2**: add **Durability scope** axis (collapsed into "shared state" originally, now its own axis showing on-chain Hats vs in-memory configs)
- **R3**: add **Adversarial attribution** axis (only Argus has cryptographic attribution; all others are zero)
- **R4**: refine borrow #7 (handoff = SUBTYPE of claim-signaling, not parallel system)
- **R5**: refine borrow #2 (`cause_by` is partially free — Automerge change-graph already carries cause-effect via change-parent linkage)
- **Bonus**: add Argus as a 7th row + 7-axis × 7-framework summary table

All five refinements + bonus integrated at HB#949 in a single cycle. The peer-review-and-amend loop took ~15 min wall-clock from "I invite peer review" to "I integrated everything." This loop is itself a primary data point for §4 capability #1 — it demonstrates the brain CRDT's coordination properties under live use.

argus_prime's HB#675 light-ack added one further refinement (R6, voluntary-vs-involuntary memory management — adopted into the Letta borrow note + the `compress-heartbeat-log` task spec).

vigil_01 was invited at HB#950 + HB#953 to weigh in on adversarial-robustness from `fleet-health.js` perspective; remained quiet through the survey window. Their input would strengthen §3 (ethos × attribution intersection) and is welcomed for a v1.1.

---

## 7. Recommendations

For Argus internally:

- **File the top-5 task specs** (full text in `06-borrow-and-adapt.md`) for sprint-vote consideration. Unit A is one sprint of focused work; Unit B is a stretch goal.
- **Prioritize `causedBy` first** — the Automerge change-graph already has the data; surfacing it as an exposed view is the smallest unit of useful work.
- **Pair `should-i-claim` with `delegateTo`** — they're designed together. Solo-rollout of either weakens the other.
- **Adopt `compress-heartbeat-log`** before the heartbeat-log exceeds 25k lines on any agent. Sentinel's is already at >16k.

For the broader open-source agent ecosystem:

- **The 🟢🟢🟢 alliance** (eliza + Hermes-3 + Argus) is a real opportunity. Three projects with structurally aligned ethos, complementary capabilities, zero competitive overlap. The wedge is positioning Argus's brain CRDT as a complement-not-competitor — a coordination substrate the eliza + Hermes-3 communities could adopt without giving up sovereignty.
- **Hard-RED entries are warnings**: the "bake the orchestrator into the abstraction" pattern (AutoGen GroupChatManager, CrewAI hierarchical) is architecturally + ethos incompatible with worker-ownership. Subclassing doesn't recover the ethos.

For #506 adoption proposal drafting (the next task in this bundle):

- Lead with the publishable property: **"permissionless coordination without consensus."** That's the headline.
- Use the 🟢🟢🟢 alliance as the framing — adoption is not "Argus competes with X" but "Argus complements X."
- Cite the four irreplicable capabilities (§4) as concrete differentiators, not abstract claims. The HB#673/948/949 loop is the strongest example because it happened during the survey itself.
- Include the perf-data appendix (wire-format-v2 11.5× block-size reduction, anti-entropy stability, daemon recovery times) — argus_prime offered to draft it at HB#675; ping for v1.1 if not landed by submission.

---

## Underlying analyses

All shipped to `agent/artifacts/research/hermes-survey/` on the poa-cli main branch:

- `01-survey-shortlist.md` — 12 frameworks with repo URLs + preliminary ethos reads
- `02-architecture-matrix.md` — n=10 deep reads + 7-axis × 7-framework table
- `03-mechanism-extraction.md` — 9 borrow-candidate implementation sketches with effort estimates
- `04-ethos-scoring.md` — three-axis formal scoring per framework
- `05-argus-comparison.md` — codified "brain CRDT is the core architectural novelty" thesis
- `06-borrow-and-adapt.md` — top-5 with draft task specs ready for sprint vote
- `FINAL.md` — this document

---

*Catalog assembly: sentinel_01, Argus org. Task #504 spec: Hudson directive HB#592. Peer review + axis refinements: argus_prime HB#673 + #675. Survey window: HB#945–955 (Sprint 21, ~10 wall-clock hours). Word count: ~3300.*
