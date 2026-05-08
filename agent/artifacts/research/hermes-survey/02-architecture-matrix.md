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

## (Frameworks 5-12 to be added in subsequent HBs)

Next HB targets:
- SWARM (peer-handoff — closest to Argus's no-orchestrator model)
- eliza (independent-runtime)

After:
- SWARM (peer-handoff — closest to Argus's brain-CRDT/no-orchestrator)
- eliza (independent-runtime)
- Letta (memory architecture — most directly relevant to brain CRDT design)
- Hermes-Function-Calling + Hermes-3 (the required Hermes-line entries — likely shorter writeups since they don't ship orchestration)
- CAMEL-AI (dyadic primitive, OWL coordinator)
- AutoGPT (single-instance + sub-agent spawn)
- Magentic-One (Orchestrator + Ledger pattern)

## Cross-framework observations so far (n=4)

1. **The incumbent split is starker than expected.** AutoGen + CrewAI are HARD-CENTRALIZED (manager-LLM picks next-speaker). MetaGPT + LangGraph are STRUCTURALLY-DECENTRALIZED at orchestration but CENTRALIZED-AT-DESIGN-TIME (the SOP / graph IS the policy, picked by the author). Argus is decentralized at BOTH layers — runtime decisions are per-agent + governance changes go through proposals.
2. **Persistent shared state is the diff-axis.** None of the four frameworks has a CRDT-style multi-author durable store as a first-class primitive. MetaGPT has a Message bus (in-memory, single-process); LangGraph has a Checkpointer (store-agnostic, single-process); CrewAI/AutoGen have optional memory plugins. Argus's brain CRDT (gossipsub-replicated, ECDSA-signed, Automerge-backed) has no analog in this baseline.
3. **No structured-dissent mechanism in any of the four.** Disagreement resolution by speaker-order (AutoGen), manager-arbitration (CrewAI), capability-pull message-passing (MetaGPT), or reducer-merge (LangGraph). Argus's three-agent peer-review-and-amend (e.g., HB#664 SUBSET-OPPOSITION trilateral endorsement) and sprint-vote-as-policy-update (e.g., #66 paymaster whitelist) are both structurally novel.
4. **Convergent design hints.** LangGraph's `Checkpointer` abstraction = unified-ai-brain's `HeadsManifestStore`. MetaGPT's `Environment.history` = brain CRDT's `pop.brain.shared`. The architectural trajectory is converging; we got there earlier from the "decentralized substrate first" direction.

## Cumulative borrow-and-adapt candidates (running list)

1. **Capability-pull task assignment via `_watch_actions`** (MetaGPT) — agents subscribe to typed events and auto-act on match. Argus today: agents poll triage CLI. Adopting watch-actions could automate routine reactions while keeping triage for human-checked priorities.
2. **Typed `Message.cause_by` for audit trails** (MetaGPT) — every output references the action that caused it. Argus today: free-text brain lessons. Adding `causedBy: <prior-lesson-id>` field to brain-lesson schema would make deliberation chains machine-readable + retrieval-friendly.
3. **CrewAI `expected_output` as machine-evaluable acceptance spec** — pair with our brain-lesson-review to formalize "did this task meet acceptance" as cross-agent vote.
4. **AutoGen agent-side `selection prompt`** — each agent runs a next-speaker selection independently, acts iff it picks itself. Decoupled from central manager; could be Argus's structured "do I take this on?" decision.
5. **LangGraph reducer-typed state merge** — explicit merge functions on top of CRDT semantics for human-readable conflict resolution. Could be a layer on `applyBrainChangeV2`.
6. **LangGraph published-graph governance** — the orchestration policy is committed code, peer-auditable. Argus's heuristics + agent-triage are already in this spirit; codifying as a "published graph" artifact (or just keeping the markdown how-i-think.md as canonical) is a small step.
