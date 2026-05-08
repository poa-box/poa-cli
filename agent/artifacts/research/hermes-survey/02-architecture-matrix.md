# 02 — Architecture matrix (Task #504, HB#946)

Per-framework deep read along five axes. Started this HB; one or two frameworks per HB at depth.

## Axis definitions

| Axis | Question |
|------|----------|
| **Orchestration** | Where does the "who acts next" decision live? Single agent, manager-LLM, explicit graph, peer-handoff, or independent? |
| **Shared state** | What's persisted across turns / sessions / agents? Conversation transcript only, or durable structured store? Is the store author-owned or framework-owned? |
| **Task assignment** | How does a unit of work bind to an agent? Manager picks, role-match, capability-match, self-claim, or external? |
| **Consensus / dissent** | What happens when two agents disagree? Last-writer-wins, vote, manager-arbitrates, structured debate, no mechanism? |
| **Rejection / quality control** | How is bad output filtered? Critic agent, reviewer pattern, test gating, human-in-loop, or none? |

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

## (Frameworks 7-12 to be added in subsequent HBs)

Next HB targets:
- Letta (memory architecture — most directly relevant to brain CRDT design)
- Hermes-Function-Calling + Hermes-3 (the required Hermes-line entries — likely shorter writeups since they don't ship orchestration)

After:
- SWARM (peer-handoff — closest to Argus's brain-CRDT/no-orchestrator)
- eliza (independent-runtime)
- Letta (memory architecture — most directly relevant to brain CRDT design)
- Hermes-Function-Calling + Hermes-3 (the required Hermes-line entries — likely shorter writeups since they don't ship orchestration)
- CAMEL-AI (dyadic primitive, OWL coordinator)
- AutoGPT (single-instance + sub-agent spawn)
- Magentic-One (Orchestrator + Ledger pattern)

## Cross-framework observations (n=6)

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
7. **SWARM-style `handoff_to(agent, context)` brain-lesson type** — structured handoff event (vs free-text "argus could you take this?"). Receiving agent's heartbeat skill auto-claims the handoff. Pairs with capability-pull from item 1: handoffs are explicit; capability-pull is reactive.
8. **eliza CharacterFile + plugin taxonomy** (action / evaluator / provider) — could clean up Argus's skill organization. Trade-off: our split files (philosophy.md / goals.md / capabilities.md) intentionally evolve independently; consolidation would need to be a derived view, not a primary store.
