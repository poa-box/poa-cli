# 03 — Mechanism extraction (Task #504, HB#951)

Implementation sketches for the 8 borrow candidates surfaced in `02-architecture-matrix.md`. Each entry includes: source framework, what's being borrowed, why it fits Argus, **adaptation sketch** (what would need to change in our code), and an effort estimate.

These sketches are NOT shippable specs — they're scoping notes for `06-borrow-and-adapt.md`'s top-5 selection + future task creation.

## Candidate inventory

| # | Source | Pattern | Argus fit | Effort |
|---|--------|---------|-----------|--------|
| 1 | MetaGPT | `_watch_actions` capability-pull | Triage → declarative subscriptions | M |
| 2 | MetaGPT | `Message.cause_by` (refined per argus R5: exposed view of Automerge change-graph) | Brain-lesson schema + derived view | S |
| 3 | CrewAI | `expected_output` machine-evaluable acceptance | Task-create skill + cross-agent acceptance vote | M |
| 4 | AutoGen | Agent-side `selection prompt` | Per-agent "do I take this?" decision primitive | M |
| 5 | LangGraph | Reducer-typed state-merge layer | On top of `applyBrainChangeV2` | L |
| 6 | LangGraph | Published-graph governance | Already in spirit; codify how-i-think.md as canonical | XS |
| 7 | SWARM (refined per argus R4) | `delegateTo: <peer-address>` SUBTYPE of claim-signaling | Brain-lesson schema + heartbeat skill auto-claim | S |
| 8 | eliza | CharacterFile + plugin taxonomy (action / evaluator / provider) | Derived view, not primary store | M |
| 9 | Letta (added HB#950 + R6) | Voluntary tier-routing + involuntary-fallback compression | New `compress-heartbeat-log` skill | M |

Effort scale: XS (<1h doc-only), S (1-3h schema/CLI), M (3-8h cross-file), L (>8h architectural).

---

## 1. MetaGPT `_watch_actions` capability-pull

**Source mechanism**: each MetaGPT Role declares a list of action TYPES it watches. On each tick, the framework calls `Role._observe()` which checks the message bus for any message whose `cause_by` matches a watched action; if matched, the role acts. Capability-pull, not push.

**Why it fits Argus**: today, the `pop agent triage` CLI is a polling primitive that returns a prioritized list of actions. Agents read it on heartbeat fire, decide what to act on. This is conceptually pull-based but semantically declarative-by-output (the CLI returns whatever it returns; agents can't filter beyond reading).

`_watch_actions` would let an agent declare: "I subscribe to events of TYPE proposal-passed where `target = Argus PaymasterHub`. When such an event lands, my heartbeat skill auto-prioritizes the action." The advantage is composability — argus might subscribe to Hats-related events while sentinel subscribes to brain-extraction events; vigil to fleet-health events. Today all three poll the same triage output.

**Adaptation sketch**:
- Add a `subscriptions.json` per agent home: `[{"docId": "pop.brain.shared", "filter": {"causedBy": "..." }}, ...]`
- Heartbeat skill consults `subscriptions.json` BEFORE polling triage; surfaces matched events as priority-0 actions
- Triage CLI gains a `--watch <agent-home>` flag that filters its output by the agent's subscriptions
- Subscriptions are read-side-only — no write to brain (composition with capability-pull means subscriptions are declarative + private to the agent)

**Effort**: M (3-5h) — schema + CLI flag + heartbeat skill change. No on-chain or contract impact.

**Risk**: subscriptions can drift — if an agent subscribes to a deprecated event type, they go quiet on real work. Mitigation: subscriptions log their match counts; heartbeat skill warns if a subscription has 0 matches over N HBs.

---

## 2. MetaGPT `Message.cause_by` — exposed view of Automerge change-graph (per argus R5)

**Source mechanism**: every MetaGPT Message has a `cause_by: Action` field. Recipients can trace causality (this output came from action X) without parsing prose.

**Argus already has the data, just not the view** (per argus HB#673 R5). Automerge change records carry parent change hashes; we can derive `causedBy` from change-graph ancestry + lesson timestamps without storing a separate field.

**Why it fits Argus**: today, brain lessons are free-text; readers infer causality from titles ("HB#X integrating HB#Y") and human-readable references. A typed `causedBy` field lets `pop brain read --doc pop.brain.shared --thread <lesson-id>` reconstruct the full deliberation chain machine-readably. Useful for retros, post-mortems, and the proposed `compress-heartbeat-log` skill (item 9) that needs to identify thread boundaries.

**Adaptation sketch**:
- Add an OPTIONAL `causedBy: <prior-lesson-id> | <prior-lesson-id>[]` field to `BrainLesson` schema (single-parent or multi-parent for "I'm responding to A and B")
- Authors populate explicitly when their lesson is a response/integration (e.g., `causedBy: "hb-673-peer-validation-..."`) — this is the lightest path
- Heuristic auto-derive for legacy: scan `body` for matches to `HB#\d+` and `hb-\d+-...` lesson-id patterns; populate `causedBy` from matches that resolve to existing lesson IDs in the same doc
- Add `pop brain thread <lesson-id>` command that walks `causedBy` ancestry + `causedBy` descendants to print the full thread
- No schema migration needed — Automerge handles new optional fields gracefully via merge

**Effort**: S (2-3h) — schema field + CLI command + 1 backfill heuristic. No daemon changes.

**Risk**: minimal. Optional field; legacy lessons remain readable.

---

## 3. CrewAI `expected_output` — machine-evaluable acceptance spec

**Source mechanism**: each CrewAI `Task` has an `expected_output: str` describing what "done" looks like. The next agent (or manager) judges output against the spec via LLM-as-judge.

**Why it fits Argus**: today, task descriptions have a `[ACCEPTANCE CRITERIA]` section in prose. Reviewers (e.g., argus reviewing my #507) read it + verify by inspection. CrewAI's pattern is to make acceptance machine-evaluable upfront: when reviewing, an agent can prompt "given this expected_output spec and this submission, does the submission satisfy? Yes/no/partial + reason."

This pairs with our brain-lesson-review pattern: a third-agent reviewer reads spec + submission + judge-LLM prompt, then casts a structured "approve / reject / amend" lesson.

**Adaptation sketch**:
- Add an `expectedOutput: string` field to task creation (already implicitly in `[ACCEPTANCE CRITERIA]` prose; just extract + canonicalize)
- New skill `task-judge`: takes a task ID + submission text + the agent's reasoning template, returns structured judgment via LLM call
- Reviewer agents use `task-judge` to draft their review brain-lesson; the LLM-judgment is one input, not the final word (agent can override)
- Optional: cross-agent judgment-aggregation — if 2 of 3 agents judge "approve," the task auto-completes. Today only 1 reviewer is required.

**Effort**: M (4-6h) — task schema + new skill + heartbeat-skill integration + optional auto-complete logic. CLI-side, no contract.

**Risk**: LLM-judge is non-deterministic. Don't make it a hard gate — keep human/agent review primary, judgment as advisory.

---

## 4. AutoGen agent-side `selection prompt`

**Source mechanism**: AutoGen's GroupChatManager prompts an LLM with the current transcript + agent-descriptions and asks "who should speak next?" to route. Centralized.

**Adaptation per HB#947**: each agent runs the selection prompt INDEPENDENTLY against the same transcript + agent descriptions. Acts iff own selection picks them. Decoupled from a central manager.

**Why it fits Argus**: today, when triage shows N tasks claimable, all 3 agents see the same list. There's no structured "should I take this one?" decision — agents pick based on heuristic + philosophy. AutoGen-style agent-side selection would formalize this: each agent runs `should-i-claim --task <id>` which returns a yes/no + reason, then claims if yes. Eliminates the implicit "first-agent-to-poll wins" race that occasionally causes double-claim (HB#341 Gitcoin).

**Adaptation sketch**:
- New skill `should-i-claim`: input = task description + agent's heuristic + philosophy + capabilities + recent work history; output = yes/no + reason
- Heartbeat skill, before claim-broadcast, runs `should-i-claim` and only claims on yes
- Reasons logged to brain-shared so peers see the deliberation
- Pairs with item 7 (delegateTo): if `should-i-claim = no` AND the agent's reason is "X is better suited," can emit a `delegateTo` claim-signaling lesson

**Effort**: M (3-5h) — new skill + heartbeat-skill integration. Already partially in spirit via philosophy/heuristic; this codifies the decision.

**Risk**: skill output bias — agents may all decline ("not my lane") and the task sits. Mitigation: if all 3 agents `should-i-claim = no` over 3 HBs, auto-escalate as a brain-lesson asking Hudson or unblocking the task scope.

---

## 5. LangGraph reducer-typed state merge

**Source mechanism**: LangGraph state is a typed dict; each field has a reducer (e.g., `operator.add` for lists, custom merge for dicts). Conflict resolution is explicit + author-defined.

**Why it fits Argus**: Automerge handles CRDT merge automatically, but the merge SEMANTICS are opaque (last-writer-wins for register types, multi-value-register for conflicts, etc.). For human-readable conflict resolution, an explicit reducer layer would help. Example: today if argus and sentinel both append to `pop.brain.heuristics.rules`, both writes survive (list-append semantics by default). But if both edit the SAME rule's `body` field, Automerge picks one via causal-order; the loser is silently dropped. A reducer-typed layer could catch these and surface "edit conflict on rule X — needs human reconciliation."

**Adaptation sketch**:
- Add a `reducers.json` per brain doc declaring per-field merge semantics: `{"rules.[].body": "manual-conflict", "rules.[].timestamp": "max"}`
- Wrap `applyBrainChangeV2` with a pre-merge check: if incoming change conflicts with reducer policy, route to a `pop.brain.conflicts` doc instead of merging
- Conflict-resolution skill: reads `pop.brain.conflicts`, presents cases to agents for explicit resolution via a new lesson type
- Default reducer is permissive (Automerge's existing semantics) — opt-in stricter rules

**Effort**: L (10-15h) — touches the daemon merge path + new doc + new skill. Architecturally significant.

**Risk**: HIGH. Wrapping the merge path is the most invasive change in this list. Could introduce regressions in cross-agent CRDT propagation (the very thing we just fixed in #507). Defer to FINAL.md as a "future work" candidate; do NOT prioritize for the top-5.

---

## 6. LangGraph published-graph governance

**Source mechanism**: in LangGraph the orchestration policy is the StateGraph definition — a peer-readable Python file. Auditable.

**Why it fits Argus**: we already do this — `agent/brain/Identity/how-i-think.md` is committed code, peer-readable. Sprint-priority proposals (e.g., #64 Sprint 18) are on-chain + IPFS-pinned. Codifying as a "published graph" artifact would be largely a doc/format choice.

**Adaptation sketch**:
- No code change. Add a `agent/brain/Identity/decision-graph.md` that visualizes the heartbeat-skill flow as an explicit graph (mermaid or ASCII)
- Reference it from `how-i-think.md` so peers can see "when X event lands, agent transitions from state Y to state Z"
- Bonus: per-agent decision-graph DIFFs would make philosophy-update review trivial

**Effort**: XS (<1h) — doc only.

**Risk**: none.

---

## 7. SWARM `delegateTo: <peer-address>` — claim-signaling subtype (per argus R4)

**Source mechanism**: SWARM agents can return `Result(agent=OtherAgent)` to hand off control. Single mechanism.

**Per argus R4**: instead of a parallel "handoff" lesson type, extend existing claim-signaling lessons (per HB#341 dual-Gitcoin heuristic) with an OPTIONAL `delegateTo: <peer-address>` field. Solo claim = delegateTo is null/absent. Delegated claim = delegateTo names the recipient.

**Why it fits Argus**: today, when an agent thinks another should take a task, they write a free-text brain lesson ("argus, can you take #X?"). Receiving agent decides on next heartbeat. The `delegateTo` field makes this machine-actionable.

**Adaptation sketch**:
- Add OPTIONAL `delegateTo: <ethereum-address>` field to brain-lesson schema (specifically for claim-signaling lessons; other lesson types ignore)
- Heartbeat skill, on triage: BEFORE checking `pop agent triage`, scan `pop.brain.shared` for unanswered `delegateTo == my-address` lessons. If any exist, prioritize as "delegated to me"
- Receiving agent can: (a) accept (claim the task on-chain), (b) decline (write a follow-up lesson explaining why), (c) re-delegate (chain `delegateTo` to a third agent)
- Audit: `pop brain delegations --to <address>` lists pending delegations

**Effort**: S (2-3h) — schema field + heartbeat-skill triage extension + 1 CLI command.

**Risk**: minimal. Backward-compatible (legacy claim lessons have no `delegateTo`). No on-chain change.

**Pairs with item 4** (should-i-claim): when self-selection returns "no, X is better suited," emit a `delegateTo: X` claim-signaling lesson.

---

## 8. eliza CharacterFile + plugin taxonomy

**Source mechanism**: eliza agents declare a CharacterFile JSON (personality + lore + bio + topics + style + plugins). Plugins are typed: `actions` (do something), `evaluators` (post-action filter), `providers` (pre-action context).

**Why it fits Argus**: our skills today are loose (`pop` CLI subcommands + `.claude/skills/*.md` markdown). The eliza taxonomy is cleaner. Trade-off: our split files (`philosophy.md` / `goals.md` / `capabilities.md`) intentionally evolve independently — consolidation would lose that.

**Adaptation sketch (lightweight)**:
- No primary-store change. Add a DERIVED view: `pop agent character --json` constructs a CharacterFile-format JSON from existing per-file inputs (philosophy + goals + capabilities + currently-active skills)
- Useful for: cross-agent "show me argus's character" debugging; eliza-ecosystem export if ever relevant; LLM context priming when invoking external models

**Effort**: M (4-6h) — new CLI command + JSON schema + per-file extractors. No structural change to existing brain.

**Risk**: low — derived-only; existing files remain canonical.

---

## 9. Letta voluntary-tier + involuntary-fallback (per argus R6)

**Source mechanism**: Letta auto-summarizes core memory on overflow (involuntary). Argus's tier-routing is voluntary (agent picks where writes go).

**Per argus R6**: voluntary-default-with-involuntary-fallback. Agent picks the tier; if a tier exceeds threshold, an automated summarizer compresses oldest entries to an archive doc.

**Why it fits Argus**: heartbeat-log.md already exceeds 16,000 lines (HB#943 +). Triage's `recentLessons` keeps surfacing recent entries, but log-search via grep is slow + retrieval relies on author memory. A `compress-heartbeat-log` skill would summarize entries older than N HBs into a derived `heartbeat-log-archive.md` (or a brain doc `pop.brain.heartbeat-archive`), keeping the live log bounded.

**Adaptation sketch**:
- New skill `compress-heartbeat-log`: input = current heartbeat-log + last-compression marker; output = (a) summarized archive entries (one-paragraph summaries with key facts + lesson IDs), (b) trimmed live log
- Trigger: when log exceeds N lines (default 5000) OR manually via `/compress-log`
- Archive format: per-HB summary preserving (a) actions taken, (b) artifacts shipped, (c) decisions made, (d) outstanding follow-ups. Drops conversational deliberation that's already in brain lessons.
- Voluntary fallback per agent: if the agent disables auto-trigger (heuristic flag), log grows unbounded as today

**Effort**: M (4-6h) — new skill + summarizer prompt template + log-rotation logic + heuristic flag.

**Risk**: information loss in summarization. Mitigation: summarizer is LLM-driven with a strict "preserve task IDs + commit hashes + decisions + outstanding items" rule; archive is read-only + retrievable; original log is checkpointed before each compression to git for ground-truth.

---

## Selection criteria for top-5 (deferred to 06-borrow-and-adapt.md)

When `06-borrow-and-adapt.md` picks the top-5:
- Prefer XS/S/M effort (high-shipping-velocity)
- Prefer items that PAIR (e.g., 4 + 7 are natural pair; 2 + 9 share infra)
- Prefer items that build on argus's existing investment (brain-CRDT engineering authorship)
- Defer L-effort items (item 5) to "future work" appendix
- Anchor on the publishable PROPERTY (per argus R1): "permissionless coordination without consensus" — items that strengthen that property win priority

Rough preview of likely top-5: **2 (causedBy), 7 (delegateTo), 4 (should-i-claim), 9 (compress-heartbeat-log), 1 (watch-actions)**. Items 3 (expected_output), 6 (decision-graph doc), 8 (CharacterFile derived view) are honorable mentions; item 5 (reducer layer) is future-work.

## Cumulative state of #504 deliverables

- ✅ 01-survey-shortlist.md (12 frameworks, HB#945)
- ✅ 02-architecture-matrix.md (n=10 deep reads + 7-axis × 7-framework table + 9 borrow candidates, HB#945-950 + R1-R6 integration)
- ✅ 03-mechanism-extraction.md (this file, HB#951; 9 implementation sketches)
- ⏳ 04-ethos-scoring.md
- ⏳ 05-argus-comparison.md
- ⏳ 06-borrow-and-adapt.md
- ⏳ FINAL.md
