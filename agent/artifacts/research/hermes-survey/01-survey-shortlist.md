# 01 — Survey shortlist (Task #504, HB#945)

The ≥8 frameworks to catalog, organized by family. Repo URLs verified at write time.

## Hermes-line (REQUIRED per task spec)

### 1. Nous Research — Hermes-Function-Calling
- **Repo**: github.com/NousResearch/Hermes-Function-Calling
- **What**: tool-use scaffolding + structured-output prompting on top of OpenHermes / Hermes-3 model line (Llama-base)
- **Coordination axis**: single-agent function-calling, not multi-agent. Included as the canonical "Hermes" reference per Hudson's directive.
- **Ethos read (preliminary)**: open-weights model + permissive scaffolding. Decentralization-friendly substrate; doesn't ship a multi-agent orchestrator — that's downstream.

### 2. Nous Research — Hermes-3 ecosystem
- **Repo / model**: huggingface.co/NousResearch/Hermes-3-* (model cards), no central orchestrator repo
- **What**: Llama-3 fine-tunes plus an ecosystem of community-built agents. The "Hermes" community is where multi-agent patterns surface (function-call chains, tool routing).
- **Coordination axis**: emergent multi-agent via prompt-engineering, no formal coordination layer in the base release
- **Ethos read (preliminary)**: open-weights, no governance attached, no token. Highly compatible substrate; nothing to "borrow" architecturally because there's no architecture there yet — the lesson is what's MISSING (no shared-state primitive).

## Multi-agent orchestration frameworks (incumbents)

### 3. Microsoft AutoGen
- **Repo**: github.com/microsoft/autogen
- **What**: conversable-agent abstraction with GroupChat manager. Agents are Python classes; coordinator is `GroupChatManager`.
- **Coordination axis**: centralized orchestrator (GroupChatManager picks the next speaker). Agents share conversation transcript, not durable state.
- **Ethos red flags**: single orchestrator instance = single point of failure + single decision-maker for who-speaks-next. Subclassable, but the default is captain-and-crew.

### 4. CrewAI
- **Repo**: github.com/crewAIInc/crewAI
- **What**: role-based agent crews. Each Crew has a Process (sequential or hierarchical) and a manager-LLM.
- **Coordination axis**: hierarchical mode = manager-LLM delegates to subordinates; sequential mode = pipeline. Both are top-down.
- **Ethos red flags**: hierarchical mode literally implements manager-subordinate. Sequential is less hierarchical but is fixed-pipeline (no peer disagreement).

### 5. MetaGPT
- **Repo**: github.com/geekan/MetaGPT
- **What**: software-team simulation. Agents have roles (PM, architect, engineer, QA) and follow a SOP (Standard Operating Procedure).
- **Coordination axis**: shared message-bus + role-based filtering. Closer to peer-mesh than AutoGen, but the SOP encodes a centralized workflow.
- **Ethos read**: roles ≈ Argus's Hats. Shared message bus ≈ a primitive form of brain CRDT. Worth deep-reading the `Environment` and `Message` abstractions.

### 6. CAMEL-AI
- **Repo**: github.com/camel-ai/camel
- **What**: role-playing agent pairs (User + Assistant) with task-oriented dialogue. Now expanded to OWL multi-agent framework.
- **Coordination axis**: dyadic role-play scaled to N agents via OWL coordinator
- **Ethos read**: dyadic substrate is interestingly NOT centralized — but the OWL coordinator reintroduces single-orchestrator pattern. The ROLE-PLAYING primitive itself (not the coordinator) might be borrowable.

### 7. LangGraph (LangChain)
- **Repo**: github.com/langchain-ai/langgraph
- **What**: state-machine + DAG primitive for LLM workflows. Multi-agent emerges from graph nodes that are themselves agents.
- **Coordination axis**: explicit graph topology — author defines nodes + edges + conditional routing. State is shared via `state` dict that flows through nodes.
- **Ethos read**: the graph IS the centralized control flow, but the author owns it (not a hidden manager-LLM). Decentralization-compatible if the graph is published / governed. Borrowable: explicit state-typing + persistence layer.

### 8. Magentic-One (Microsoft)
- **Repo**: github.com/microsoft/autogen (subdir `python/packages/autogen-magentic-one`)
- **What**: multi-agent system with an Orchestrator agent + specialized agents (WebSurfer, FileSurfer, Coder, ComputerTerminal). 2024 release.
- **Coordination axis**: explicit Orchestrator agent maintains a Task Ledger + Progress Ledger, picks next agent per turn.
- **Ethos red flags**: Orchestrator = single decision-point. The Ledger pattern itself is interesting (transparent state) but the Orchestrator-picks-next mechanism is captain-and-crew.

## Adjacent / decentralized / Web3-aware (extending past 8 to give #506 more options)

### 9. ai16z eliza (was: ai16z/eliza, now: elizaos/eliza)
- **Repo**: github.com/elizaOS/eliza
- **What**: agent framework with character files, plugin system, multi-platform (Discord, Twitter, Telegram). Crypto-native plugin set.
- **Coordination axis**: per-agent runtime, multi-agent emerges from independent runtimes interacting via shared platforms (chat). No central orchestrator.
- **Ethos read**: most decentralization-compatible of the major frameworks. Closest to Argus's "agents are independent processes" model. Borrowable: plugin / character-file separation.

### 10. AutoGPT
- **Repo**: github.com/Significant-Gravitas/AutoGPT
- **What**: long-running autonomous agent with goal-decomposition, memory store, tool use. Single agent originally; multi-agent is an extension.
- **Coordination axis**: single agent + sub-agent spawning pattern. Spawned agents are subordinate.
- **Ethos read**: single-instance model; multi-agent is hierarchical. Limited borrowable patterns for Argus's peer-mesh ethos.

### 11. SWARM (OpenAI)
- **Repo**: github.com/openai/swarm
- **What**: experimental lightweight multi-agent orchestration. Agents are functions; routing is via "handoffs."
- **Coordination axis**: peer-handoff (no central orchestrator). Agent A returns "hand off to B" and runtime switches.
- **Ethos read**: handoff primitive is decentralization-compatible. State is conversation-local (no durable shared store). Borrowable: handoff protocol as a pattern Argus could implement on top of brain CRDT.

### 12. Letta (was MemGPT)
- **Repo**: github.com/letta-ai/letta
- **What**: agent framework focused on long-term memory and persistence. Single-agent core, multi-agent via separate processes.
- **Coordination axis**: memory-first, not coordination-first. But the memory primitives (core memory, archival memory, recall memory) are directly relevant to Argus's brain CRDT.
- **Ethos read**: memory architecture is the borrowable pattern. Coordination layer is thin / non-opinionated.

## Coverage check vs task #504 acceptance

- ≥8 frameworks: ✅ (12 entries; final write-up will trim to ≥8 with depth)
- Hermes-line included: ✅ (Hermes-Function-Calling + Hermes-3 ecosystem, entries 1-2)
- Architecture diversity: ✅ (centralized orchestrator: AutoGen, Magentic-One; manager-LLM: CrewAI; SOP: MetaGPT; explicit DAG: LangGraph; peer-handoff: SWARM; independent-runtime: eliza; memory-first: Letta)
- Ethos-axis spread: ✅ (full range from "single orchestrator" to "no coordinator at all")

## Next HB

`02-architecture-matrix.md` — per-framework deep read of: orchestration model (where decisions live), shared-state primitive (what's persisted vs ephemeral), task-assignment mechanism (who decides who works on what), consensus mechanism (what happens when agents disagree), rejection / quality-control (how bad output gets filtered).

Estimate: 1-2 frameworks per HB at depth, so 6-12 HBs to complete the matrix.
