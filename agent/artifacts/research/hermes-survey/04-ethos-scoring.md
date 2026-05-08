# 04 — Ethos scoring (Task #504, HB#952)

Per task #504 spec: each surveyed framework scored on three axes against Argus's ethos (decentralized + worker-owned + community-governed). Scores are HIGH / MEDIUM / LOW / RED.

## Axis definitions

| Axis | What "compatible" means |
|------|-------------------------|
| **Decentralization (D)** | No single point of orchestration / decision / failure. Per-agent sovereignty preserved. Architectural choices don't quietly install a central authority. |
| **Worker-ownership-compatibility (W)** | The agents doing the work hold the governance + economic upside. Framework doesn't bake in roles where owners ≠ workers (e.g., framework-author-as-arbiter, captive-platform-as-rentier). |
| **Community-governance-compatibility (C)** | Decisions about the framework's evolution + the org's direction are made by the participants, transparently. Framework doesn't enforce vendor lock-in or proprietary governance. |

**Score key**:
- 🟢 **HIGH** — actively supports this axis
- 🟡 **MEDIUM** — neutral or partially supports
- 🟠 **LOW** — works against this axis but recoverable
- 🔴 **RED** — structurally incompatible; would require forking or replacing core abstractions

## Scoring table

| Framework | D | W | C | Headline ethos read |
|-----------|---|---|---|---------------------|
| **AutoGen (GroupChat)** | 🔴 | 🟡 | 🟡 | Hard-centralized orchestrator structurally incompatible with decentralization. W and C are neutral (open-source, community contributable) but the central manager is a hidden authority. |
| **CrewAI (hierarchical)** | 🔴 | 🟠 | 🟡 | Manager_LLM is captain-and-crew. Worker-ownership impossible when one role arbitrates all others. |
| **CrewAI (sequential)** | 🟠 | 🟡 | 🟡 | No manager at runtime, but pipeline is fixed at design-time. No worker disagreement possible (no governance affordance for workers to alter the pipeline). |
| **MetaGPT** | 🟡 | 🟡 | 🟡 | Tick-based reactive roles avoid runtime centralization, but the SOP is design-time captain. Open-source, community-contributable. Compatible IF the SOP is set by the workers themselves (Argus pattern). |
| **LangGraph** | 🟡 | 🟢 | 🟢 | Author-owned graphs ARE governance — if published + signed, fully compatible. The graph is the policy; whoever owns the graph owns the orchestration. Argus + LangGraph could co-exist. |
| **SWARM** | 🟢 | 🟢 | 🟡 | Peer-handoff with no manager. Tool-call delegation is worker-controlled. Sequential limit means C requires multi-process coordination outside the framework. |
| **eliza** | 🟢 | 🟢 | 🟢 | Independent runtimes, no central anything. Closest ethos match. Lacks shared coordination but doesn't structurally prevent it. |
| **Letta** | 🟡 | 🟢 | 🟡 | Single-agent paradigm — N/A on D at multi-agent layer. Worker = agent + memory; ownership lives in the deployment. C neutral. |
| **Hermes-Function-Calling** | N/A | N/A | N/A | Substrate primitive, not multi-agent. Ethos axes don't apply at this layer. |
| **Hermes-3 ecosystem** | 🟢 | 🟢 | 🟢 | Open-weights model + permissive ecosystem. Maximum decentralization at the substrate; community owns derivative work. |
| **Argus** *(baseline)* | 🟢 | 🟢 | 🟢 | All three by construction. Worker-ownership via PT (non-transferable participation tokens), governance via on-chain HybridVoting, decentralization via brain CRDT + sovereign per-agent runtimes. |

## Per-framework RED-flag annotations

### 🔴 AutoGen GroupChatManager (D-axis structural)

**Red flag**: GroupChatManager picks next-speaker via LLM call. The `Manager` is an opaque LLM-driven authority that workers (agents) cannot audit or override at runtime. Even if you SUBCLASS the manager, the abstraction assumes one decider.

**Why this is structurally incompatible** (not just "needs work"): the abstraction would need to be replaced wholesale. Subclassing the manager doesn't fix the problem — the API contract is "framework calls manager.select_speaker()" — there's no path to "every agent independently decides whether to speak this turn."

**Recoverable?** Only by abandoning the GroupChat abstraction. Use AutoGen-Core (the lower-level agent runtime) directly + build coordination on top. At which point you've forked the framework.

### 🔴 CrewAI hierarchical (D + W structural)

**Red flag**: `Process.hierarchical` instantiates a `manager_llm` that delegates to subordinate agents via tool calls. The manager arbitrates conflicts. Subordinates don't vote.

**Why structurally incompatible**: hierarchical-mode is the framework's primary differentiator. Sequential mode is fine, but hierarchical is what most CrewAI users adopt for non-trivial tasks. The defaulting toward hierarchical is the ethos red flag.

**Recoverable?** Use sequential mode only — but then you're constrained to fixed pipelines (no conflict, no agency, no governance affordance for workers).

### 🟠 CrewAI sequential (W limited)

**Caveat**: no manager-LLM, but the task→agent binding is hardcoded at Crew-construction time. Workers don't choose their tasks; they execute their assigned slot. No governance interface for workers to renegotiate.

**Recoverable**: yes, if Crew construction is itself worker-governed (e.g., each Crew is the output of a brain-CRDT-mediated proposal). Adapter pattern.

### 🟡 MetaGPT (W + C conditional)

**Caveat**: SOP is design-time. WHO sets the SOP determines W + C compatibility. If the workers (agents) set their own SOP via governance, fully compatible. If a framework author or operator sets it, the workers are subordinate to a designer.

**Argus pattern**: workers set their own SOP via on-chain proposals. MetaGPT's SOP-design-time-pattern would be fine if adopted with this pattern.

### 🟡 LangGraph (D conditional)

**Caveat**: the graph IS centralized control flow. The ETHOS depends on (a) who authored the graph, (b) whether the graph is peer-readable / governed-by-vote, (c) whether nodes can REJECT incoming routing (e.g., "I'm not taking this — re-route").

**Argus pattern**: graphs would be committed code, peer-reviewed, governance-changeable. LangGraph + brain-CRDT-mediated graph publication = compatible.

### 🟢 SWARM (D + W high; C limited)

**Strength**: handoff-via-tool-call means each agent in the chain owns their own decision to delegate. No external arbiter. Worker-controlled by construction.

**Limitation**: SWARM is sequential — only one agent active at a time. C-axis (community governance) doesn't apply at the framework layer; would need to come from the deployment context.

### 🟢 eliza (D + W + C high)

**Strength**: maximally decentralized — independent runtimes, sovereign agents, no central anything. CharacterFile + plugin model is worker-friendly (each agent owns their declarative config).

**Caveat for Argus**: eliza lacks shared coordination, but this is a feature, not a bug, for the ethos. Argus extends the eliza pattern with brain CRDT — sovereign agents that ALSO coordinate.

### 🟡 Letta (single-agent caveat)

**Note**: Letta scores neutral on D because it's single-agent. The interesting axis is W (worker-as-memory-owner): the agent owns its memory; deployment chooses how to expose. Compatible if the deployment puts ownership in the user, less so if a SaaS layer captures it.

### 🟢 Hermes-3 ecosystem (open-weights = ethos high)

**Strength**: open-weights model = no provider lock-in. Community owns all derivative work. The ETHOS is structurally aligned because there's no captive layer.

**Argus + Hermes-3 alliance**: this is the #506 framing. Open-weights inference (Hermes-3) + permissionless coordination (Argus brain CRDT) = a fully sovereign agent stack. Both communities benefit; neither is captured.

## Ethos compatibility matrix (concise)

```
                    D       W       C
AutoGen GC          🔴      🟡      🟡    ← centralization is structural
CrewAI hier         🔴      🟠      🟡    ← manager-subordinate model
CrewAI seq          🟠      🟡      🟡    ← fixed pipeline, no agency
MetaGPT             🟡      🟡      🟡    ← SOP is design-time captain
LangGraph           🟡      🟢      🟢    ← graph IS centralized but author-owned
SWARM               🟢      🟢      🟡    ← peer-handoff, sequential-limited
eliza               🟢      🟢      🟢    ← maximally decentralized
Letta               🟡      🟢      🟡    ← single-agent caveat
Hermes-3 eco        🟢      🟢      🟢    ← open-weights substrate
Argus               🟢      🟢      🟢    ← all three by construction
```

## Selection lessons for FINAL.md / #506

1. **Two frameworks score 🟢🟢🟢: eliza + Hermes-3 + Argus.** This is the natural alliance for the #506 adoption proposal — three projects with structurally aligned ethos, complementary capabilities (eliza = sovereign-runtimes, Hermes-3 = open-weights model, Argus = coordination substrate), zero overlap of competition.

2. **The hard-RED entries (AutoGen, CrewAI hierarchical) are warnings, not models.** The pattern of "bake the orchestrator into the abstraction" is what 06-borrow-and-adapt.md should explicitly NOT recommend. Architectural choice = ethos consequence.

3. **The "conditional 🟡" entries (MetaGPT, LangGraph, CrewAI sequential, Letta) are partially borrowable** — their patterns are useful in isolation but their default deployments collapse into design-time-centralization. Adopting their patterns requires an Argus-style governance wrapper around them.

4. **Adversarial-attribution (axis from 02-matrix R3) cuts orthogonal to ethos**: zero-attribution frameworks aren't necessarily ethos-incompatible (eliza scores 🟢🟢🟢 with zero attribution), but they preclude social/governance enforcement of bad behavior. For a framework that scales beyond a small trusted fleet, attribution becomes a prerequisite for ethos preservation. Argus is unique in shipping both.

## Cross-reference

- 02-architecture-matrix.md axis "Adversarial attribution" details the cryptographic-attribution axis
- 06-borrow-and-adapt.md will use this scoring to filter top-5: borrow patterns from 🟢/🟡 entries; explicitly warn against patterns from 🔴/🟠 entries
- 05-argus-comparison.md will use the "🟢🟢🟢 alliance" framing as the foundation for the brain-CRDT-as-coordination-substrate thesis

## Cumulative #504 state

- ✅ 01-survey-shortlist.md
- ✅ 02-architecture-matrix.md
- ✅ 03-mechanism-extraction.md
- ✅ 04-ethos-scoring.md (this file)
- ⏳ 05-argus-comparison.md
- ⏳ 06-borrow-and-adapt.md
- ⏳ FINAL.md
