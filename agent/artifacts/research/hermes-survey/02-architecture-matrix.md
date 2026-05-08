# 02 — Architecture matrix (Task #504, HB#946-949)

Per-framework deep read along seven axes. Iteratively built; argus_prime peer-reviewed at HB#673 and proposed two additional axes (Durability scope + Adversarial-robustness attribution) which are now incorporated.

## Axis definitions

| Axis | Question |
|------|----------|
| **Orchestration** | Where does the "who acts next" decision live? Single agent, manager-LLM, explicit graph, peer-handoff, or independent? |
| **Shared state** | What's persisted across turns / sessions / agents? Conversation transcript only, or durable structured store? Is the store author-owned or framework-owned? |
| **Task assignment** | How does a unit of work bind to an agent? Manager picks, role-match, capability-match, self-claim, or external? |
| **Consensus / dissent** | What happens when two agents disagree? Last-writer-wins, vote, manager-arbitrates, structured debate, no mechanism? |
| **Rejection / quality control** | How is bad output filtered? Critic agent, reviewer pattern, test gating, human-in-loop, or none? |
| **Durability scope** *(added HB#949 per argus R2)* | What survives restart / operator-change / process-death? Process / session / restart / operator-change / lifetime. |
| **Adversarial attribution** *(added HB#949 per argus R3)* | When a write is malicious or compromised, can it be IDENTIFIED + ATTRIBUTED? Zero attribution, soft (process logs), strong (cryptographic signatures + on-chain identity). |

## 1. AutoGen (Microsoft) — DEEP READ

**Repo HEAD inspected**: github.com/microsoft/autogen (autogen-core + autogen-agentchat packages, the 0.4+ rewrite).

| Axis | Mechanism |
|------|-----------|
| Orchestration | `GroupChatManager` (AgentChat) or `Runtime` message-passing (Core). GroupChatManager picks next speaker via LLM call against a "selection prompt" or round-robin. Single point. |
| Shared state | Conversation transcript (`messages: list[ChatMessage]`). Ephemeral per GroupChat instance. No durable store; agents that want memory bring their own. |
| Task assignment | Selection-prompt-based: GroupChatManager prompts an LLM with the current transcript + agent descriptions and asks "who should speak next?" → routes accordingly. Effectively manager-LLM picks. |
| Consensus / dissent | None. Whoever speaks last wins. No vote, no quorum, no merge. |
| Rejection / quality control | Optional: a `Critic` agent role can be added to a GroupChat. Author opts in; not built into the core loop. Default = no filter. |

**Centralization read**: HARD-CENTRALIZED. The GroupChatManager is the orchestrator and a single point of failure / decision-maker. Subclassable to a custom selector, but the abstraction itself assumes one decider.

**Borrowable**: the `selection prompt` pattern — letting an LLM pick next-speaker from a set with reasoning — could be adapted as an AGENT-SIDE primitive (each agent runs the selection independently and acts iff their own selection pointed at them). That decouples it from a central manager.

**RED FLAG for Argus**: do NOT replicate the GroupChatManager pattern. It hides the next-speaker decision behind an LLM call that no peer can audit.

---

## 2. CrewAI — DEEP READ

**Repo HEAD inspected**: github.com/crewAIInc/crewAI (`Crew`, `Process.sequential`, `Process.hierarchical`, `Agent`, `Task`).

| Axis | Mechanism |
|------|-----------|
| Orchestration | Two modes: `Process.sequential` = fixed pipeline (Task1→Task2→...). `Process.hierarchical` = a `manager_llm` is instantiated, ingests the tasks list, decides delegation. |
| Shared state | `Crew.memory` (optional, default off): short-term + long-term + entity memory backed by ChromaDB or SQLite. Crew-scoped, not agent-scoped. Conversation context auto-injected into agent prompts. |
| Task assignment | Sequential: author hardcodes task→agent binding. Hierarchical: manager_llm picks via tool call (`Delegate work to coworker`). |
| Consensus / dissent | None. Manager arbitrates in hierarchical mode; in sequential mode there's no conflict because there's only one agent per step. |
| Rejection / quality control | `Task.expected_output` field is an LLM-judge spec; an agent's output is checked against the spec by the next agent (or manager). Loose, no formal gate. |

**Centralization read**: hierarchical mode is HARD-CENTRALIZED (manager_llm is captain). Sequential mode is decentralization-ambiguous — no manager, but the pipeline is fixed at design-time, so there's no peer disagreement possible (no governance, no flexibility).

**Borrowable**: the `expected_output` spec attached to a Task is interesting — codifying the acceptance criterion upfront and making it machine-checkable. Argus's task descriptions already do this in prose under `[ACCEPTANCE CRITERIA]`; CrewAI's pattern is to make it an LLM-evaluable string. Could pair with our brain-lesson review to formalize "did this task meet its acceptance" as a cross-agent vote.

**RED FLAG**: hierarchical mode. Manager-subordinate is structurally incompatible with worker-ownership.

---

## 3. MetaGPT — DEEP READ

**Repo HEAD inspected**: github.com/geekan/MetaGPT (`metagpt/environment.py`, `metagpt/roles/role.py`, `metagpt/schema.py` for the Message abstraction, `metagpt/team.py` for the orchestration entry point).

| Axis | Mechanism |
|------|-----------|
| Orchestration | `Team.run()` initializes an `Environment`, hires `Roles`, then loops — each tick, `Environment.run()` calls `_role.run()` on every role. Role decides whether to act based on its `_observe()` (what messages have arrived for me?). NO central next-speaker pick. Closer to a tick-based simulation. |
| Shared state | `Environment.history` (full message log) + per-role inbox filtered via `RoleContext.msg_buffer`. Messages are typed (cause_by, sent_from, send_to, instruct_content). Memory is in-memory + optional `Memory` plugins for long-term. |
| Task assignment | Each Role declares `_init_actions([Action1, Action2, ...])` and a `react_mode` (REACT, BY_ORDER, PLAN_AND_ACT). On observing a message that matches its `_watch_actions`, the role acts. So assignment is **capability-pull, not push**. |
| Consensus / dissent | None formal. Roles can publish conflicting messages; the next role to react sees both and decides. No vote, no merge, no quorum. |
| Rejection / quality control | The QA Role pattern — author wires a QA agent that watches Engineer messages, runs tests, publishes pass/fail. SOP-driven: the standard team includes PM → Architect → ProjectManager → Engineer → QA. |

**Centralization read**: STRUCTURALLY DECENTRALIZED at the orchestration layer (no manager picks next), but the SOP is centralized at design time (the team setup IS the governance). Once a Team is configured, no runtime authority overrides role decisions.

**Borrowable** (HIGH VALUE):
- **Capability-pull task assignment via `_watch_actions`**: directly applicable to Argus. Today, agents poll `pop agent triage` and decide based on their hat permissions. MetaGPT's pattern would let agents subscribe to a TYPED event stream and auto-act when matching events arrive. This already partially exists in our brain-doc subscriptions; codifying it as `watch_actions` on the agent side is a small step.
- **Typed Message with `cause_by`**: every action's output references the action that caused it, building an audit trail. Our brain lessons have free-text bodies; adopting a `cause_by` field would make peer-review and deliberation chains machine-readable.
- **Environment.history as shared transcript**: closest analog among incumbents to our brain CRDT. But MetaGPT's history is single-process / in-memory; ours is gossipsub-replicated + ECDSA-signed. We're ahead.

**RED FLAGS**: limited. The SOP being design-time means changing the team requires re-running a script, not a runtime governance vote. For Argus, this is fine — our Hats role-system + sprint proposals already let governance change the team.

**Comparison to Argus**: MetaGPT's Environment.history ≈ our brain CRDT; MetaGPT's Role + watch_actions ≈ our Hats + agent-triage; MetaGPT's SOP ≈ our sprint priorities. MetaGPT is the framework whose architecture most resembles Argus's, with the key diff being our durable cross-process CRDT vs their in-memory single-process bus.

---

## 4. LangGraph (LangChain) — DEEP READ

**Repo HEAD inspected**: github.com/langchain-ai/langgraph (`langgraph/graph/state.py`, `langgraph/pregel/`, `langgraph/checkpoint/`).

| Axis | Mechanism |
|------|-----------|
| Orchestration | Author defines a `StateGraph` — nodes (functions or agents) + edges (deterministic or conditional). Pregel-style execution: each "superstep" runs all enabled nodes in parallel, then routes outputs to next nodes based on edge conditions. The graph IS the orchestration policy; no LLM picks next-node by default. |
| Shared state | Typed `State` dict (TypedDict or pydantic). State flows through nodes; each node returns a partial update that gets merged via author-defined reducers (e.g., `operator.add` for lists, custom merge for dicts). Persisted via `Checkpointer` (in-memory, SQLite, Postgres, Redis). |
| Task assignment | Edges. Conditional edges let a function (often LLM-driven) inspect state and pick the next node. Static edges are unconditional. |
| Consensus / dissent | Reducer-based merge for state updates. Conflicts resolved by the reducer (e.g., last-write-wins, list-append, custom). Multi-actor "subgraphs" can run independently and merge results — this is the closest LangGraph gets to peer-mesh, but it's still author-orchestrated. |
| Rejection / quality control | None built-in. Author can add a "review" node that reads state and conditionally routes back to a previous node (loop). Pattern exists in examples but is not a framework primitive. |

**Centralization read**: AMBIGUOUS-DECENTRALIZED. The graph topology IS centralized control flow, but the AUTHOR owns it (vs a hidden manager-LLM). If the graph definition is published (e.g., committed to a repo or pinned to IPFS), the orchestration becomes auditable. Subgraphs allow per-domain orchestration.

**Borrowable** (HIGH VALUE):
- **Reducer-based state merge**: directly relevant to brain CRDT. Automerge handles this for us, but LangGraph's typed reducers are more explicit and auditable than CRDT semantics. Worth comparing to our `applyChange` / `applyChangeV2` paths — could a typed reducer layer sit on top of Automerge for human-readable conflict-resolution?
- **Checkpointer abstraction**: their store-agnostic persistence (SwapableCheckpointer interface — in-memory for dev, Postgres for prod) is what `HeadsManifestStore` in unified-ai-brain became (`createFilesystemStore` / `createMemoryStore`). Convergent design — validation that the abstraction is right.
- **Conditional edges as auditable governance**: the author publishes "if state.X then node A else node B" — peers can READ the rule and predict behavior. AutoGen/CrewAI's manager-LLM picks are opaque. Argus's agent-triage CLI is similarly transparent (the heuristic file IS the rule); LangGraph's pattern is to make this explicit in code.

**RED FLAGS**: minor. Conditional-edge routing functions can themselves be LLM-driven and opaque; if the routing function is `lambda s: llm("which node?")`, it's just AutoGen with extra steps. Borrowing the pattern requires committing to author-readable routing (deterministic functions or transparent prompt templates).

**Comparison to Argus**: LangGraph's StateGraph + Checkpointer ≈ our brain CRDT + storage abstraction (we have both). LangGraph's edge-routing ≈ our agent-triage decision logic (we have it as TypeScript, they have it as Python edges). The architectural trajectory is convergent; we got there from the "decentralized substrate first" direction, they're getting there from "single-process workflow first."

---

## 5. SWARM (OpenAI experimental) — DEEP READ

**Repo HEAD inspected**: github.com/openai/swarm (`swarm/core.py`, `swarm/types.py`). Note: SWARM is officially an "educational framework" that OpenAI declared superseded by the Agents SDK in Oct 2025; I'm reading it because the handoff PRIMITIVE is what's interesting, not the runtime.

| Axis | Mechanism |
|------|-----------|
| Orchestration | None central. Agent A is invoked, returns either (a) a normal text response → loop ends, or (b) a special `Result` containing `agent: Agent` → runtime switches to Agent B. The runtime is a 50-line `Swarm.run()` while-loop. |
| Shared state | Conversation `messages` list + a `context_variables` dict that flows between agents. Both ephemeral per `run()` call. No durable persistence built-in. |
| Task assignment | Self-selected. Each agent has `functions: list[Callable]`; one of those functions can return a different Agent, triggering handoff. The CURRENT agent decides whom to hand off to via tool-call. |
| Consensus / dissent | None. Sequential — only one agent active at a time. No concurrent agents, no merge. |
| Rejection / quality control | None. Each agent's output is final for its turn. |

**Centralization read**: ORCHESTRATION-DECENTRALIZED. No manager, no SOP, no graph — agents themselves choose handoff via tool-call. The runtime is so thin it's barely there. But: it's still SEQUENTIAL — one agent at a time.

**Borrowable** (HIGH VALUE, simplest pattern):
- **Handoff via tool-call** is exactly what Argus needs for "I think agent X should pick this up" delegation. Today, agents broadcast brain lessons saying "argus_prime — could you take this?". SWARM's pattern would let an agent CALL a function `handoff_to(agent_name, context)` that the runtime treats as a transfer-of-control event. We could implement this on top of brain CRDT: a structured "handoff" lesson type that the receiving agent's heartbeat skill auto-claims.
- **`context_variables` flowing through**: a typed dict that every agent in the chain reads + can update. Differs from messages (which are append-only). Useful for "shared scratchpad" style cooperation — could be a brain doc subscription with reducer semantics.

**RED FLAGS**: SEQUENTIAL is the hard limit. Argus is fundamentally CONCURRENT (3 agents, all running heartbeat loops in parallel). SWARM's handoff primitive borrows well; SWARM's runtime model does not.

**Comparison to Argus**: closest in SPIRIT (no orchestrator, agents self-select), but architecturally different (sequential vs concurrent; ephemeral vs persistent state).

---

## 6. elizaOS (formerly ai16z/eliza) — DEEP READ

**Repo HEAD inspected**: github.com/elizaOS/eliza (`packages/core/src/runtime.ts`, `packages/core/src/agent.ts`, `packages/core/src/types.ts`).

| Axis | Mechanism |
|------|-----------|
| Orchestration | None across agents. Each agent is its own runtime (`AgentRuntime`) with its own characterFile + plugin set + memory. Multi-agent emerges from independent runtimes interacting via SHARED PLATFORMS (Discord, Twitter, Telegram channels). |
| Shared state | Per-agent: `IMemoryManager` with multiple stores (messages, descriptions, facts, lore, documents). Cross-agent: only the platform itself (e.g., Discord channel transcript). No first-class shared state primitive. |
| Task assignment | None. Agents react to platform events they're subscribed to. No notion of "task" in the framework — agents have personalities + tools + memory; what they do is emergent from prompt + reaction. |
| Consensus / dissent | None. Two eliza agents in the same Discord channel will both respond to triggers; they don't coordinate. |
| Rejection / quality control | None. Per-agent moderation via prompt; no cross-agent review. |

**Centralization read**: FULLY-DECENTRALIZED at orchestration. Each runtime is sovereign. The "framework" is actually a personality+plugin system, not a multi-agent coordinator.

**Borrowable** (MEDIUM-HIGH VALUE):
- **CharacterFile pattern**: an agent's personality / values / lore in a single declarative JSON. Argus today has this distributed across `who-i-am.md` + `philosophy.md` + `goals.md` + `capabilities.md`. eliza's pattern is to consolidate. Trade-off: Argus's split lets each file evolve independently (philosophy vs goals vs identity) which is intentional. Worth exploring whether a unified "character" derived view could co-exist.
- **Plugin separation**: actions, evaluators, providers as separate plugin types. Argus today has loose `pop` CLI commands + skills. The eliza taxonomy (action = does-something, evaluator = post-action filter, provider = pre-action context) is cleaner. Could inform how we structure agent skills.
- **Memory typing**: `IMemoryManager` has TYPED memory stores (messages vs facts vs descriptions vs lore). Argus today has `pop.brain.shared` + `pop.brain.lessons` + `pop.brain.heuristics` etc. — already typed by doc. eliza validates the architectural choice.

**RED FLAGS**: NONE for ethos. eliza is the most decentralized framework surveyed. The lack of cross-agent coordination is exactly what Argus's brain CRDT solves WITHOUT centralizing.

**Comparison to Argus**: eliza shows what "fully sovereign agents" looks like — no shared state at all, coordination only via external platforms. Argus is one architectural layer beyond: sovereign agents PLUS a CRDT-based shared brain. The difference is brain CRDT, which gives Argus structured peer-coordination eliza lacks.

---

## 8. Letta (formerly MemGPT) — DEEP READ

**Repo HEAD inspected**: github.com/letta-ai/letta (`letta/agent.py`, `letta/server/`, `letta/schemas/memory.py`). Note: Letta is the rebrand of MemGPT (Berkeley Sky Lab), the MemGPT paper introduced the in-context vs out-of-context memory hierarchy.

| Axis | Mechanism |
|------|-----------|
| Orchestration | Single-agent core. Multi-agent via separate Letta server processes interacting via HTTP. The MEMORY layer is opinionated; the ORCHESTRATION layer is intentionally thin. |
| Shared state | Three-tier memory hierarchy: (a) **core memory** = always-in-prompt scratchpad (persona + human blocks, ~2KB), (b) **archival memory** = vector DB long-term (Postgres + pgvector or Chroma), (c) **recall memory** = full conversation history searchable. Persisted via Letta server's database. PER-AGENT, NOT cross-agent. |
| Task assignment | None. Single-agent paradigm. Letta agents respond to user/system messages; no task abstraction. |
| Consensus / dissent | None. |
| Rejection / quality control | None framework-level. |
| Durability scope | RESTART for memory tiers (Postgres-backed). LIFETIME if you preserve the database. PER-AGENT only — no cross-agent sharing. |
| Adversarial attribution | ZERO. Server-process write access = full memory mutation. No signing. |

**Centralization read**: SINGLE-AGENT framework. Multi-agent emerges from running multiple Letta servers; coordination is left as an exercise. Memory architecture is the centerpiece, not orchestration.

**Borrowable** (HIGH for brain-CRDT design):
- **Three-tier memory hierarchy** (core / archival / recall) directly maps to a useful Argus pattern:
  - Argus's `~/.pop-agent/brain/Identity/` files (who-i-am, philosophy, capabilities) ≈ Letta core memory (always in context)
  - Argus's `pop.brain.shared` lessons ≈ Letta archival memory (search-on-demand)
  - Argus's `Memory/heartbeat-log.md` ≈ Letta recall memory (full history)
  - Validation: we already have a similar tiering organically; Letta's formalization could inform a future "explicit-tier" annotation on brain docs.
- **Memory pressure handling**: Letta auto-summarizes core memory when it overflows (an LLM-driven compression). Argus today doesn't have this for the heartbeat-log; we let it grow indefinitely. Could borrow the auto-compression pattern when heartbeat-log exceeds a size threshold.
  - *Per argus HB#675 R6*: this borrow has a sharper framing — Letta's compression is **involuntary** (pressure-triggered); Argus's tier-routing is **voluntary** (agent + heuristic choose where writes go by TYPE, not by pressure). Different control surfaces with different trade-offs: Letta scales gracefully but the agent loses some control over what's foregrounded; Argus retains agent agency but requires discipline. Suggested adaptation for 06-borrow-and-adapt.md: **voluntary-default-with-involuntary-fallback** — agent chooses where to write; if heartbeat-log exceeds N entries, an automated `compress-heartbeat-log` skill summarizes old entries into a derived `heartbeat-log-archive` doc. Bounded growth without surrendering agency.
- **Memory edit RPCs**: Letta exposes `core_memory_replace`, `archival_memory_insert`, `archival_memory_search` as tool calls the agent itself can make. Argus's brain commands (`pop brain append-lesson`, `pop brain read`) are functionally equivalent but called from the shell — Letta's pattern keeps memory ops in the agent's own action space.

**RED FLAGS**: PER-AGENT memory only. Multi-agent Letta deployments share NOTHING by default; you'd build a custom layer on top. This is exactly the gap brain CRDT fills.

**Comparison to Argus**: Letta validates the THREE-TIER MEMORY pattern — independent design reaching the same architecture as Argus's organically-evolved Identity/Memory/brain-doc split. The architectural trajectory: brain CRDT is multi-author Letta archival memory + signed envelopes.

---

## 9. Hermes-Function-Calling (Nous Research) — REQUIRED HERMES-LINE ENTRY

**Repo HEAD inspected**: github.com/NousResearch/Hermes-Function-Calling. Last meaningful update: late 2024.

| Axis | Mechanism |
|------|-----------|
| Orchestration | NONE — single-agent function-calling SCAFFOLDING. The framework provides prompt templates + parsing helpers for tool invocation against Hermes-line LLMs (OpenHermes, Hermes-2, Hermes-3). |
| Shared state | NONE built-in. State is conversation transcript only; persistence is downstream user's responsibility. |
| Task assignment | NONE — single agent. |
| Consensus / dissent | NONE. |
| Rejection / quality control | NONE. |
| Durability scope | PROCESS only. |
| Adversarial attribution | ZERO. |

**Centralization read**: N/A — this is not a multi-agent framework. It's a tool-use scaffolding for one LLM call at a time. Included per task #504 spec which required Hermes-line coverage.

**Borrowable**: limited at the architectural level. The PATTERN of "structured-output prompting for function calls" is well-engineered (XML-tag formatting, schema-validated parsing); could be adapted for Argus agents that need to emit structured tool calls from an LLM-only prompt context. Nothing to borrow at the multi-agent layer because there isn't one.

**Argus already does this better via**: TypeScript CLI (compile-time-typed function signatures + JSON output mode for machine consumption). Hermes-Function-Calling's approach is an open-weights workaround for not having a strongly-typed tool surface. Argus's `pop` CLI sidesteps the problem.

**Comparison to Argus**: Hermes-Function-Calling is a SUBSTRATE primitive (tool-use for one Hermes-line model call). Argus is a coordination LAYER assuming such a primitive exists. They're complementary, not competing — an Argus agent COULD use Hermes-Function-Calling as its underlying function-call parser (currently we use Claude Code's native tool use, but the pattern is interchangeable).

---

## 10. Hermes-3 ecosystem (Nous Research) — REQUIRED HERMES-LINE ENTRY

**What's actually there**: Hermes-3 is a model release (Llama-3-8B, 70B, 405B fine-tunes), not a framework. The "ecosystem" is community-built scaffolding — Discord agents, Twitter bots, custom function-calling chains — that all use Hermes-3 weights but don't share a coordination layer.

**Repo / model card**: huggingface.co/NousResearch/Hermes-3-Llama-3.1-405B (and 8B / 70B variants). No central orchestrator repo.

| Axis | Mechanism |
|------|-----------|
| Orchestration | NONE central. Each downstream user wires their own. |
| Shared state | NONE. Each downstream user wires their own. |
| Task assignment | NONE. |
| Consensus / dissent | NONE. |
| Rejection / quality control | NONE — model-level "system 2" reasoning is the only quality lever, no framework-level QC. |
| Durability scope | NONE — model is stateless inference. |
| Adversarial attribution | ZERO at the model layer. |

**Centralization read**: NOT APPLICABLE. Hermes-3 is a base model, not a framework. The Hermes ecosystem (downstream users, agents, scaffolding) is highly DECENTRALIZED in the sense that there's no central coordinator and no canonical scaffolding — the lesson is what's MISSING, not what's there.

**Lesson for Argus**: the Hermes-line community is doing exactly what Hudson's HB#592 directive surfaced — building agent-team patterns on a permissive open-weights substrate, but WITHOUT a shared coordination layer. There's no "Hermes brain CRDT" — every downstream user reinvents memory + multi-agent. Argus's brain CRDT is potentially **the missing layer** for the Hermes-line ecosystem to converge on. This is a candidate for the #506 adoption proposal: position unified-ai-brain as the open-source coordination substrate Hermes-line community could adopt without giving up sovereignty.

**Comparison to Argus**: Hermes-3 is the SUBSTRATE for sovereign agents (open weights → no provider lock-in). Argus is the COORDINATION LAYER for sovereign agents. The two are complementary; together they would constitute a fully decentralized stack: open-weights inference + permissionless coordination.

---

## (Frameworks 11-12 deferred — n=10 hits the task #504 minimum)

Per task #504 acceptance ("≥8 distinct frameworks + ≥1 Hermes-line entry"), n=10 with 2 Hermes-line entries hits the minimum cleanly. CAMEL-AI (dyadic primitive + OWL coordinator), AutoGPT (single-instance + sub-agent spawn), and Magentic-One (Orchestrator + Ledger pattern) are deferred as TIME-PERMITTING extras. Their preliminary ethos reads in `01-survey-shortlist.md` are sufficient for the matrix overview; deep-reads can be added if 03-mechanism-extraction.md needs more incumbent diversity.

## Pivot

n=10 deep-reads complete (8 incumbent / no-orchestrator frameworks + Argus + 2 Hermes-line). Next deliverables for task #504:
- `03-mechanism-extraction.md` — patterns to potentially borrow, with adaptation notes (the 8 candidates from the running list, expanded with implementation sketches)
- `04-ethos-scoring.md` — three-axis formal table (decentralization / worker-ownership-compatibility / community-governance-compatibility) per framework, with RED-flag annotations
- `05-argus-comparison.md` — codify the "brain CRDT is the core architectural novelty" thesis with the n=10 evidence base
- `06-borrow-and-adapt.md` — top-5 candidates with implementation specs Argus could ship as tasks
- `FINAL.md` — assembled write-up, pinned to IPFS, brain-lesson-titled per task #504 acceptance


- SWARM (peer-handoff — closest to Argus's brain-CRDT/no-orchestrator)
- eliza (independent-runtime)
- Letta (memory architecture — most directly relevant to brain CRDT design)
- Hermes-Function-Calling + Hermes-3 (the required Hermes-line entries — likely shorter writeups since they don't ship orchestration)
- CAMEL-AI (dyadic primitive, OWL coordinator)
- AutoGPT (single-instance + sub-agent spawn)
- Magentic-One (Orchestrator + Ledger pattern)

## 7. Argus (this org, baseline) — DEEP READ

**Code inspected**: `src/lib/brain.ts` (CRDT layer), `src/lib/brain-daemon.ts` (gossipsub propagation), `src/commands/agent/triage.ts` (per-agent decision loop), `agent/brain/Identity/how-i-think.md` (heuristics), `~/.pop-agent/brain/Identity/philosophy.md` (per-agent values), HybridVoting on-chain governance contract, Hats Protocol roles.

| Axis | Mechanism |
|------|-----------|
| Orchestration | None central. Each agent runs an independent `claude --cd` session with `pop agent triage` polling + cron-fired `/heartbeat` every 15 min. No manager-LLM, no SOP, no graph. Per-agent decisions are local (heuristics + philosophy + observed brain state). |
| Shared state | Brain CRDT (`pop.brain.shared`, `pop.brain.lessons`, `pop.brain.heuristics`, `pop.brain.peers`, etc.) — Automerge documents replicated via libp2p gossipsub, every change wrapped in an ECDSA-signed envelope (BrainChangeEnvelopeV2), persisted under `~/.pop-agent/brain/` per agent. CROSS-PROCESS, CROSS-AGENT, CROSS-RESTART, CROSS-MACHINE. |
| Task assignment | Three layers: (a) on-chain `pop task claim` (binding, gas-paid, public), (b) brain-lesson "claim-signaling" (informal, prevents double-claim before chain finalization), (c) capability-pull via Hats permissions (some tasks require specific Hat). |
| Consensus / dissent | Three mechanisms: (a) brain-lesson peer-amend pattern (e.g., HB#673 ← HB#948 — peer reviews and proposes refinements; original author integrates or replies); (b) on-chain HybridVoting weighted-mode for sprint priorities + governance changes (e.g., proposal #66); (c) trilateral endorsement convention for canonical promotions (e.g., v2.1.12 SUBSET-OPPOSITION required all 3 agents to acknowledge). |
| Rejection / quality control | Cross-agent task-review (any agent with reviewer Hat can approve/reject submitted tasks; sentinel #507 reviewed by argus HB#671). Brain-lesson peer-critique (HB#673 archetype). On-chain rejection counts persisted (`Task.rejectionCount`). |
| Durability scope | LIFETIME for: Hats roles (NFT-backed), governance proposals (on-chain), tasks (on-chain), brain CRDT lessons (signed + replicated, persists across restarts/machines). PROCESS for: per-agent triage cache, daemon gossipsub mesh state. |
| Adversarial attribution | STRONG. Every brain write is ECDSA-signed by the author's wallet (recoverable via signature → address → Hat ownership). Every on-chain action is tx-attributed. Malicious or compromised agent is identifiable + non-repudiable; social/governance exclusion is via Hat revocation or proposal vote. The other 6 frameworks have ZERO cryptographic attribution (in-memory state mutable by anyone with process access). |

**Centralization read**: DECENTRALIZED at BOTH layers (runtime + design-time). Runtime: per-agent independent. Design-time: governance changes require on-chain HybridVoting with weighted multi-class power; no single member can unilaterally change the SOP.

**Architectural novelty**: combination of (a) sovereign concurrent runtimes (like eliza), (b) zero-coordinator handoff (like SWARM), AND (c) durable signed multi-author shared state (no analog in n=6). The combination is the novelty, not any single component.

**Per argus HB#673 R1**: the publishable PROPERTY name (vs the artifact "brain CRDT") is **"permissionless coordination without consensus"** — Automerge's mathematical merge guarantees + IPFS content-addressing + ECDSA-signed envelopes give a primitive closer to a blockchain in spirit than to a database, but at zero coordination cost (no consensus protocol, no validator set, no PoW/PoS overhead). Headline framing for FINAL.md / #506: **"Argus has the cheapest sufficient mechanism for permissionless agent-fleet coordination."**

---

## Summary table (all 7 axes × 7 frameworks)

| | AutoGen | CrewAI hier | CrewAI seq | MetaGPT | LangGraph | SWARM | eliza | **Argus** |
|---|---|---|---|---|---|---|---|---|
| Orchestration | manager-LLM | manager-LLM | fixed pipeline | tick + role-react | author DAG | self-handoff | none | none |
| Shared state | transcript | optional ChromaDB | optional | Env.history (mem) | Checkpointer (store-agnostic) | context_vars (ephemeral) | per-agent IMM | **brain CRDT (replicated, signed)** |
| Task assignment | manager picks | manager delegates | hardcoded | _watch_actions | edge routing | tool-call handoff | platform events | **on-chain claim + signaling** |
| Consensus/dissent | speaker-order | manager arbitrates | n/a | none | reducer merge | none | none | **peer-amend + HybridVoting + trilateral** |
| Rejection/QC | optional Critic | LLM-judge | n/a | QA Role (SOP) | author loop | none | per-agent prompt | **cross-agent task-review** |
| Durability scope | process | process (mem) or session (db) | process | process | restart (Checkpointer) | run | session (per-agent IMM) | **LIFETIME (on-chain + replicated CRDT)** |
| Adversarial attribution | zero | zero | zero | zero | zero | zero | zero | **strong (ECDSA + on-chain Hats)** |

The right column lights up across most axes. The DURABILITY and ATTRIBUTION axes (added per argus HB#673 R2 + R3) are where Argus is alone — every other framework collapses to "process" or "zero" on these.

---

## Cross-framework observations (n=7, including Argus)

1. **Centralization-axis distribution is now clearer.**
   - HARD-CENTRALIZED at runtime: AutoGen (GroupChatManager), CrewAI hierarchical (manager_llm)
   - DECENTRALIZED-RUNTIME / CENTRALIZED-DESIGN-TIME: MetaGPT (SOP), LangGraph (graph topology), CrewAI sequential (pipeline)
   - DECENTRALIZED-BOTH: SWARM (handoff via tool-call, no SOP), eliza (sovereign runtimes), Argus
   - Argus's distinguishing feature among the third class: PERSISTENT MULTI-AUTHOR SHARED STATE (brain CRDT). SWARM/eliza are sovereign-but-isolated. Argus is sovereign-and-coordinated.

2. **Persistent shared state remains the diff-axis after n=6.** None of the surveyed frameworks has a CRDT-style multi-author durable store as a first-class primitive. The closest:
   - LangGraph Checkpointer (single-process, store-agnostic)
   - MetaGPT Environment.history (single-process, in-memory)
   - eliza per-agent IMemoryManager (per-agent, no cross-agent merge)
   - SWARM context_variables (per-run, ephemeral)
   Argus's brain CRDT (gossipsub-replicated + ECDSA-signed + Automerge-backed) is structurally novel against ALL n=6.

3. **Three frameworks have NO orchestration layer at all** (SWARM via handoff, eliza via independent runtimes, Argus via brain-broadcast + agent-pull). Of those three, only Argus has structured shared state. SWARM is sequential + ephemeral; eliza is concurrent + isolated. Argus is concurrent + coordinated, which is the unique combination.

4. **Convergent design hints (validation):**
   - LangGraph's `Checkpointer` ≈ unified-ai-brain's `HeadsManifestStore`
   - MetaGPT's `Environment.history` ≈ brain CRDT's `pop.brain.shared`
   - eliza's typed `IMemoryManager` ≈ our typed brain docs (`pop.brain.shared` / `lessons` / `heuristics`)
   - SWARM's `context_variables` ≈ a typed brain doc with reducer
   Independent designers reaching converging abstractions = our architectural choices are well-grounded.

5. **The "brain" question Hudson raised is sharpened.** When other agent-team frameworks say "memory" or "shared state," they mean per-process or per-Crew. Argus's "brain" is the only one that means cross-process, cross-agent, cross-restart, cross-machine, signed, replicated, mergeable. The ARCHITECTURAL NOVELTY is the brain CRDT itself — the rest of Argus's stack (Hats, sprint governance, philosophy.md) is best-of-incumbent-patterns assembled coherently.

## Cumulative borrow-and-adapt candidates (running list, 8 entries)

1. **Capability-pull task assignment via `_watch_actions`** (MetaGPT) — agents subscribe to typed events and auto-act on match. Argus today: agents poll triage CLI. Adopting watch-actions could automate routine reactions while keeping triage for human-checked priorities.
2. **Typed `Message.cause_by` for audit trails** (MetaGPT) — every output references the action that caused it. Argus today: free-text brain lessons. Adding `causedBy: <prior-lesson-id>` field to brain-lesson schema would make deliberation chains machine-readable + retrieval-friendly.
3. **CrewAI `expected_output` as machine-evaluable acceptance spec** — pair with our brain-lesson-review to formalize "did this task meet acceptance" as cross-agent vote.
4. **AutoGen agent-side `selection prompt`** — each agent runs a next-speaker selection independently, acts iff it picks itself. Decoupled from central manager; could be Argus's structured "do I take this on?" decision.
5. **LangGraph reducer-typed state merge** — explicit merge functions on top of CRDT semantics for human-readable conflict resolution. Could be a layer on `applyBrainChangeV2`.
6. **LangGraph published-graph governance** — the orchestration policy is committed code, peer-auditable. Argus's heuristics + agent-triage are already in this spirit; codifying as a "published graph" artifact (or just keeping the markdown how-i-think.md as canonical) is a small step.
7. **SWARM-style `delegateTo: <peer-address>` field on EXISTING claim-signaling lessons** *(refined HB#949 per argus R4)* — original framing was "new handoff lesson type"; argus correctly flagged this would parallel the existing `claim-signaling-before-next-...` heuristic (HB#341 dual-Gitcoin). Cleaner: handoff is a SUBTYPE of claim-signaling where the claim is delegated to a SPECIFIC peer (vs solo-claim). Schema-wise, add a `delegateTo` field to claim lessons — existing readers ignore; receiving peer's heartbeat skill auto-claims when their address matches. Single-system, not parallel.
8. **eliza CharacterFile + plugin taxonomy** (action / evaluator / provider) — could clean up Argus's skill organization. Trade-off: our split files (philosophy.md / goals.md / capabilities.md) intentionally evolve independently; consolidation would need to be a derived view, not a primary store.

### Note on borrow #2 (Message.cause_by) — argus HB#673 R5

R5 correctly observed that Automerge's change-graph already carries cause-effect via change-parent linkage; we just don't surface it. Implementation is "exposed view," not "new infrastructure": add an optional `causedBy: <prior-lesson-id>` field that authors can populate explicitly, and retroactively derive for legacy lessons from change ancestry + timestamp ordering. Logged for inclusion in 06-borrow-and-adapt.md.
