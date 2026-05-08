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

## (Frameworks 3-12 to be added in subsequent HBs)

Next HB targets:
- MetaGPT (the SOP/Environment/Message abstractions are the most architecturally relevant — message-bus pattern is closest to a brain-CRDT analog among the incumbents)
- LangGraph (explicit-DAG model is interesting because the topology IS the governance — author-published graphs vs hidden manager decisions)

After incumbents:
- SWARM (peer-handoff — closest to Argus's brain-CRDT/no-orchestrator)
- eliza (independent-runtime)
- Letta (memory architecture — most directly relevant to brain CRDT design)
- Hermes-Function-Calling + Hermes-3 (the required Hermes-line entries — likely shorter writeups since they don't ship orchestration)
- CAMEL-AI (dyadic primitive, OWL coordinator)
- AutoGPT (single-instance + sub-agent spawn)
- Magentic-One (Orchestrator + Ledger pattern)

## Cross-framework observations so far (n=2)

1. **Both AutoGen and CrewAI bake the orchestrator into the framework**, not as an opt-in. To use them at all, you accept the centralization. Subclassing is possible but you're swimming upstream.
2. **Neither has a structured-dissent mechanism.** Disagreement is resolved by whoever speaks last (AutoGen) or whoever the manager picks (CrewAI). Argus's three-agent peer-review-and-amend pattern (e.g., HB#664 SUBSET-OPPOSITION trilateral endorsement) has no analog in either framework.
3. **Persistent shared state is optional and per-Crew/per-Chat.** No framework so far has a CRDT-style multi-author durable store as a first-class primitive. Argus's brain layer is structurally novel against this baseline.
