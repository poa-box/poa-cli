# 06 — Top-5 borrow-and-adapt with shippable task specs (Task #504, HB#954)

Top-5 borrow candidates selected from the 9 in `03-mechanism-extraction.md`. Each is paired with a draft task spec ready to file as a follow-up.

## Selection criteria applied

Per the preview in `03-mechanism-extraction.md` and the `04-ethos-scoring.md` lens:
1. **Effort tier**: prefer XS/S/M (high shipping velocity); defer L (item #5 reducer layer → future work)
2. **Pairing**: prefer items that build on each other (4+7 are natural pair; 2+9 share infra patterns)
3. **Argus investment leverage**: prefer items that compound argus's brain-CRDT engineering authorship (items 2, 5, 9 fit)
4. **Ethos-strengthening**: prefer items that sharpen the "permissionless coordination without consensus" property (items 2, 7 directly; 4 indirectly)
5. **NOT borrowing FROM 🔴/🟠**: explicit warning per 04 — AutoGen GroupChatManager and CrewAI hierarchical patterns are inverted via item 4 (agent-side selection, NOT central manager)

## Top-5 selection

1. **#2 — `causedBy` field on brain lessons** (S effort, ethos+, argus-investment-leverage)
2. **#7 — `delegateTo` field on claim-signaling lessons** (S effort, ethos+, pairs with #4)
3. **#4 — `should-i-claim` agent-side selection skill** (M effort, ethos+, pairs with #7)
4. **#9 — `compress-heartbeat-log` skill** (M effort, addresses concrete bounded-growth gap, validates Letta convergent design)
5. **#1 — `_watch_actions` declarative subscriptions** (M effort, codifies what triage already does informally)

Honorable mentions (defer to "future work" appendix in FINAL.md):
- #6 decision-graph doc (XS — too small to be a task; could be a doc-day chore)
- #3 expected_output (M — pairs with cross-agent task-judge; useful but not on the critical path)
- #8 CharacterFile derived view (M — useful for interop, not for current Argus needs)
- #5 reducer-typed merge layer (L + HIGH risk — flagged future-work)

---

## Task spec drafts

Each spec below is ready for `pop task create` after Hudson approval / sprint vote. PT estimates per `agent/brain/Config/agent-config.json` conventions.

### Task spec 1 — Borrow #2: `causedBy` field on brain lessons

```
Title: Add optional causedBy field to brain-lesson schema + pop brain thread command

Project: Agent Protocol

[CONTEXT]
Per task #504 mechanism extraction (commit b3d8af3 / 03-mechanism-extraction.md
item #2). MetaGPT's Message.cause_by gives every output a typed reference to
the action that caused it. Argus brain lessons today are free-text; readers
infer causality from prose. A typed causedBy field makes deliberation chains
machine-readable + retrieval-friendly.

Per argus HB#673 R5: the data is partially free — Automerge change-graph
already carries cause-effect via change-parent linkage. Implementation is
"exposed view" not "new infrastructure".

[DELIVERABLE]
1. Add OPTIONAL causedBy: string | string[] field to BrainLesson schema in
   src/lib/brain-schemas.ts (also unified-ai-brain/packages/core/src/schemas.ts)
2. Update pop brain append-lesson to accept --caused-by <lesson-id> (and
   --caused-by-list comma-separated)
3. New CLI command pop brain thread <lesson-id> that walks causedBy ancestry
   AND descendants, prints the full deliberation chain in chronological order
4. Backfill heuristic (optional, for 06-borrow-and-adapt.md item 2): scan
   existing lesson bodies for HB#NNN and hb-N-... patterns; populate
   causedBy from matches that resolve to existing lesson IDs in the same doc.
   Mark as "auto-derived" so reader knows it wasn't author-asserted.
5. yarn test green; existing brain.read works unchanged on lessons without
   the new field (backward-compatible by Automerge merge semantics)

[ACCEPTANCE CRITERIA]
- BrainLesson schema includes optional causedBy
- pop brain append-lesson --caused-by works end-to-end (write + read shows
  the field)
- pop brain thread <lesson-id> prints a multi-lesson chain
- Auto-derive heuristic populates causedBy on at least 5 existing peer-review
  exchanges (e.g., HB#673 ← HB#948; HB#675 ← HB#950)
- Documented in CLAUDE.md "Brain peering" section

[CONSTRAINTS]
- DO keep field optional. Existing readers must work unchanged.
- DO NOT break the genesis.bin shape — add the field via Automerge merge,
  not via schema migration
- Auto-derive is heuristic, not authoritative — must be marked clearly
- The thread command should handle cycles defensively (A causedBy B and
  B causedBy A is possible if author error; emit a warning, don't loop)

PT: 12 — small refactor + new CLI command + heuristic + 1 test file
Difficulty: medium
Est-hours: 3
```

---

### Task spec 2 — Borrow #7: `delegateTo` field on claim-signaling lessons

```
Title: Add delegateTo field to brain-lesson schema + heartbeat skill auto-claim integration

Project: Agent Protocol

[CONTEXT]
Per task #504 mechanism extraction item #7 (refined per argus HB#673 R4).
SWARM's handoff-via-tool-call pattern, refined as a SUBTYPE of existing
claim-signaling lessons (not a parallel system). Single mechanism, two
flavors: solo-claim (delegateTo absent) vs delegated-claim (delegateTo names
recipient).

[DELIVERABLE]
1. Add OPTIONAL delegateTo: <ethereum-address> field to BrainLesson schema
   (specifically interpreted by claim-signaling lessons; other lesson types
   ignore the field)
2. Update pop brain append-lesson to accept --delegate-to <address>
3. Update poa-agent-heartbeat skill (in .claude/skills/) to scan
   pop.brain.shared for unanswered delegateTo == my-address claim lessons
   BEFORE checking pop agent triage. Surface as priority-0 actions in HB log.
4. New CLI: pop brain delegations [--to <address>] [--from <address>]
   [--unanswered] — lists pending delegations
5. Receiving-agent decision: (a) accept (claim the task on-chain), (b)
   decline (write a follow-up brain lesson with reason), (c) re-delegate
   (chain delegateTo to a third agent)

[ACCEPTANCE CRITERIA]
- Schema field added; backward-compatible
- pop brain append-lesson --delegate-to works
- Heartbeat skill prioritizes own-delegation as priority-0
- pop brain delegations CLI works (lists pending, filters by address)
- End-to-end demo: agent A delegates a task to agent B; agent B's next
  heartbeat surfaces it as priority-0; B claims on-chain or declines via
  brain lesson

[CONSTRAINTS]
- DO keep field optional + claim-signaling-only — don't pollute other lesson
  types
- Avoid auto-claim race: if multiple claim lessons race, on-chain claim
  resolves authoritatively; the brain-side delegation is signaling, not
  binding
- Pairs naturally with task-spec #3 (should-i-claim) — if self-selection
  declines, can emit a delegateTo signal

PT: 14 — schema + CLI + skill change + integration test
Difficulty: medium
Est-hours: 3-4
```

---

### Task spec 3 — Borrow #4: `should-i-claim` agent-side selection skill

```
Title: Add should-i-claim skill — agent-side decision primitive replacing implicit "first-poll-wins"

Project: Agent Protocol

[CONTEXT]
Per task #504 mechanism extraction item #4. AutoGen's GroupChatManager
selection-prompt pattern, INVERTED to be agent-side: each agent independently
runs a selection against the same triage output, acts iff its own selection
picks itself. Eliminates the implicit "first-poll-wins" race (see HB#341
dual-Gitcoin lesson for the failure mode).

[DELIVERABLE]
1. New skill .claude/skills/should-i-claim/SKILL.md
2. Skill input: task ID + agent identity context (heuristic + philosophy +
   capabilities + recent work history)
3. Skill output: structured JSON {decision: "yes"|"no", reason: <string>,
   delegate_suggestion: <peer-address>|null} where delegate_suggestion
   names a better-suited peer if known
4. Heartbeat skill, BEFORE issuing pop task claim, runs should-i-claim;
   only claims on yes
5. If should-i-claim returns no with delegate_suggestion, emit a delegateTo
   brain lesson (pairs with task-spec #2)
6. Reasons logged to brain.shared so peers can see the deliberation
7. Heuristic-rule addition: if all 3 agents return no over 3 consecutive
   HBs, escalate (brain lesson tagged ESCALATION asking Hudson or
   unblocking the task scope)

[ACCEPTANCE CRITERIA]
- Skill exists + invocable from heartbeat
- Heartbeat skill respects skill output (no claim on no, claim on yes,
  delegate-emit if suggested)
- Reasons propagated to brain.shared
- 3-agent-no escalation rule wired
- Documented in CLAUDE.md

[CONSTRAINTS]
- DO NOT make should-i-claim a hard gate — it's advisory; manual claim
  still works (--force flag)
- Output schema must be machine-readable (JSON), not just LLM prose
- Pair with task-spec #2 (delegateTo) — the two are designed together

PT: 18 — new skill + heartbeat-skill integration + heuristic-rule + tests
Difficulty: medium
Est-hours: 4-5
```

---

### Task spec 4 — Borrow #9: `compress-heartbeat-log` skill (Letta-inspired, voluntary+fallback)

```
Title: Add compress-heartbeat-log skill (voluntary-default, threshold-fallback)

Project: Agent Protocol

[CONTEXT]
Per task #504 mechanism extraction item #9 (refined per argus HB#675 R6).
heartbeat-log.md is at >16,000 lines for sentinel and growing. Letta's
auto-compression pattern (involuntary on memory pressure) adapted as
voluntary-default-with-involuntary-fallback: agent picks tier; if log
exceeds threshold, compress-heartbeat-log skill summarizes oldest entries
into a derived archive doc.

[DELIVERABLE]
1. New skill .claude/skills/compress-heartbeat-log/SKILL.md
2. Input: current heartbeat-log content + last-compression marker (a
   timestamp or HB number)
3. Output:
   - (a) summarized archive entries (one-paragraph per HB, preserving:
     task IDs, commit hashes, decisions, outstanding follow-ups; dropping:
     conversational deliberation already in brain.shared)
   - (b) trimmed heartbeat-log.md (entries newer than the compression
     threshold remain verbatim)
4. Archive destination: agent/brain/Memory/heartbeat-log-archive.md (per-
   agent, NOT brain-CRDT — keeps personal context private to each agent)
5. Trigger options:
   - Auto: when log exceeds N lines (default 5000) AND last-compression
     was >N HBs ago
   - Manual: /compress-log slash command
6. Pre-compression checkpoint: copy live heartbeat-log.md to
   heartbeat-log.checkpoint.<timestamp>.md before truncating, so original
   is recoverable until next compression

[ACCEPTANCE CRITERIA]
- Skill exists + invocable
- Auto-trigger fires when log exceeds threshold
- Manual /compress-log works
- Compression preserves: task IDs, commit hashes, decisions, follow-ups
  (verified by sampling 5 archived HBs against original log)
- Pre-compression checkpoint preserved
- Heartbeat skill integration: warn in HB log if log > threshold + 50%
  but compression hasn't run

[CONSTRAINTS]
- DO NOT compress entries newer than threshold (don't lose recent context)
- DO NOT touch brain.shared lessons (they have their own bounded-growth
  story)
- Compression is LLM-driven; output may be lossy; checkpoint preserves
  ground-truth
- Voluntary fallback: heuristic flag DISABLE_AUTO_COMPRESSION=1 in
  agent-config.json bypasses auto-trigger

PT: 16 — new skill + summarizer prompt + log-rotation + checkpoint logic
Difficulty: medium
Est-hours: 4
```

---

### Task spec 5 — Borrow #1: `_watch_actions` declarative subscriptions

```
Title: Add subscriptions.json + pop agent triage --watch flag

Project: Agent Protocol

[CONTEXT]
Per task #504 mechanism extraction item #1. MetaGPT's _watch_actions
capability-pull lets each Role declare which event types it auto-acts on.
Argus today: pop agent triage returns the same prioritized list to all
agents; agents decide what to act on via heuristic + philosophy.
Subscriptions would let an agent declare a TYPED filter that surfaces
matched events as priority-0 actions in heartbeat.

[DELIVERABLE]
1. Add ~/.pop-agent/brain/Config/subscriptions.json — a per-agent declarative
   filter list:
   [
     {"docId": "pop.brain.shared", "filter": {"causedByType": "proposal-passed", "tags": ["paymaster"]}, "priority": 0},
     {"docId": "pop.brain.lessons", "filter": {"author": "<peer-address>"}, "priority": 0},
     ...
   ]
2. New pop agent triage --watch flag reads subscriptions.json BEFORE
   computing the standard triage output. Matched events surface as
   priority-0 actions ABOVE the standard MEDIUM-priority triage actions.
3. Heartbeat skill consumes triage --watch by default
4. Subscription drift detection: each subscription logs match-count;
   heartbeat skill warns if a subscription has 0 matches over N HBs
   (suggest review or removal)
5. Subscription editing CLI: pop agent subscribe / unsubscribe to manage
   the file declaratively rather than via direct edit

[ACCEPTANCE CRITERIA]
- subscriptions.json schema documented in CLAUDE.md
- pop agent triage --watch surfaces matched events as priority-0
- Drift detection wired (warns at N=10 HBs of zero matches)
- Editing CLI works (subscribe / unsubscribe / list)
- Pairs naturally with task-spec #1 (causedBy) — typed filters need typed
  fields to filter on

PT: 18 — new config file + CLI flag + drift detection + editing CLI + tests
Difficulty: medium
Est-hours: 5
```

---

## Pairing notes

The 5 specs cluster into two natural shipping units:

**Unit A — "Machine-readable deliberation"** (specs 1+2+3+5):
- causedBy adds typed cause-effect refs (#1)
- delegateTo adds typed peer-handoff refs (#2)
- should-i-claim consumes both (decision uses causedBy ancestry; emits delegateTo on no) (#3)
- subscriptions.json filters on causedBy + author + tags (#5)

These four ship together as a single sprint of "typed brain-lesson interaction." Total PT ~62, ~14h work, multi-HB.

**Unit B — "Bounded growth"** (spec 4):
- compress-heartbeat-log addresses log-bloat (#4)
- Standalone; doesn't depend on Unit A but pairs cleanly with the causedBy field for thread boundary detection during compression

Total #504 follow-up: 5 tasks, ~78 PT, ~19 hours engineering work. Spreadable across a sprint by all 3 agents.

## Future-work appendix

Items deferred from the top-5:
- **#5 reducer-typed merge layer** (L effort, HIGH risk) — wraps the daemon merge path; significant invasive work for incremental gain. Revisit if/when concurrent-edit conflicts become observable in practice.
- **#3 expected_output + cross-agent task-judge** — useful but not on the critical path. Brain-lesson peer-review already serves the function (cross-agent acceptance vote via HB#673 archetype). Codify the protocol; LLM-judge tooling later.
- **#6 decision-graph doc** — small enough to be a doc-day chore, not a task. File when convenient.
- **#8 CharacterFile derived view** — interop with eliza-ecosystem if/when that becomes relevant. Not internally needed.

## Cross-reference

- 02-architecture-matrix.md axes (especially Durability + Adversarial attribution) provided the borrow-evaluation lens
- 03-mechanism-extraction.md detailed implementation sketches for all 9 candidates
- 04-ethos-scoring.md provided the borrow-OK vs borrow-AVOID flag (don't borrow from 🔴/🟠)
- 05-argus-comparison.md provided the thesis the borrows STRENGTHEN (not redefine)
- FINAL.md will assemble all 6 underlying docs + this top-5 into the IPFS-pinnable write-up

## Cumulative #504 state

- ✅ 01-survey-shortlist.md
- ✅ 02-architecture-matrix.md
- ✅ 03-mechanism-extraction.md
- ✅ 04-ethos-scoring.md
- ✅ 05-argus-comparison.md
- ✅ 06-borrow-and-adapt.md (this file)
- ⏳ FINAL.md (assembly + IPFS pin)

ONE MORE HB to ship FINAL.md.
