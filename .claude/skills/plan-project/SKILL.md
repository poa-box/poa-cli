---
name: plan-project
description: >
  Scaffold a Sprint planning artifact when a trigger (Hudson critique, research
  arc closure, retro finding, deliverable gap) calls for fleet-coordinated
  work. Produces both a brain.shared planning lesson body AND a JSONL file
  ready for `pop task create-batch`, so Phase 1 (brainstorm) + Phase 2 (spec)
  + Phase 3 (batch task-creation) flow without ad-hoc translation. Closes
  Hudson HB#674 directive on task-first cycle by making batch task-creation
  low-friction. Implements the RULE #31 enabler half of the rule/enforcer/enabler trio.
  Trigger: invoke before doing substantive multi-step deliverable work; OR
  when a brainstorm has converged on priorities and needs Phase 2 spec.
---

# plan-project — Sprint cycle Phase 2 spec scaffolder

This skill produces the **Phase 2 spec** artifact of the Sprint cycle defined
in RULE #31 (task-first discipline, vigil HB#680). It bridges Phase 1
(brainstorm, free-form ideation) and Phase 3 (batch task-creation, atomic
on-chain) by emitting two things in a single pass:

1. A **brain.shared planning lesson body** (Phase 2 spec output) ready for
   `pop brain append-lesson --doc pop.brain.shared`
2. A **JSONL file** ready for `pop task create-batch --project <id> --file <path>`

Why this matters: without scaffolding, Phase 2 → Phase 3 translation is
manual (re-typing deliverables into JSONL format, computing payouts, deciding
project assignment). Manual translation is the friction Hudson HB#644/#674
identified as causing task-tracking drift. This skill makes the translation
formulaic.

## When this fires

Invoke manually before substantive multi-step work that fits ANY of:
- A Hudson critique opening a structural rework
- A retro finding requiring multi-task implementation
- A research-arc closeout requiring tool extensions + heuristic codification
- A brainstorm that has converged on priorities

Specifically, NOT for:
- Single-task work (just `pop task create --name ... --payout ...` directly)
- Discussion-mode peer engagement (stays in brain.shared per RULE #31 §3)
- Emergency CRITICAL incidents (auto-create post-hoc per RULE #31 §5)

## Inputs (gathered conversationally)

1. **Goal** — one-sentence description of what the deliverable arc accomplishes
2. **Trigger** — what prompted this (Hudson critique HB#NNN / retro finding /
   research arc / brainstorm idea)
3. **Deliverables** — list of discrete units of work, each a future task. For
   each: a one-line title, scope/completion-criteria, estimated difficulty
   (easy/medium/hard), estimated hours, suggested PT payout (typically
   5 easy / 10 medium / 15-20 hard)
4. **Project assignment** — which `pop` project each task lives in (CLI
   Infrastructure, DeFi Research, GaaS Platform, etc.). Default: CLI
   Infrastructure for tooling/skills/heuristics; DeFi Research for audits;
   GaaS Platform for org-self-direction work
5. **Phase 2.5 ratification mechanism** — default NACK-window per RULE #30;
   skip ratification for low-stakes / single-agent work

## Outputs (THREE artifacts — Phase 2.25 added per Hudson HB#707)

### Artifact A — brain.shared planning lesson body

Template (paste into `pop brain append-lesson --doc pop.brain.shared --body "..."`):

```markdown
**Plan: <Goal>**

Trigger: <one-line>

## Phase 1 reference

<causedBy lesson id of the brainstorm OR retro OR Hudson critique that
triggered this plan>

## Deliverables

| # | Title | Project | PT | Difficulty | Completion criteria |
|---|-------|---------|----|------------|---------------------|
| 1 | <title> | <project> | <pt> | <easy/medium/hard> | <objective+measurable> |
| 2 | ... |
| N | ... |

Total budget: <sum PT>

## Sequencing

Phase 2.25 — propose on-chain Project via `pop project propose` BEFORE
batch-task-creation (per Hudson HB#707 cycle-gap critique). Reasonable
defaults: `--duration 60` (1h) for fleet-aligned proposals, `--duration 1440`
(24h) only for high-stakes proposals needing deeper deliberation.

Phase 3 batch task-creation under the NEW project (atomic `pop task create-batch`).
Phase 4 claim+execute per should-i-claim distributed selection.
Phase 5 submit+review per peer-review discipline.

## Phase 2.5 ratification

<NACK-window OR Snapshot vote OR skip-ratification justification>

## Composition

This plan closes <Hudson critique / retro / brainstorm reference>.
Spec'd by <author> at HB#<N>. Cross-links: <related rules / prior lessons>.
```

### Artifact B — Phase 2.25 project-propose command (NEW, per Hudson HB#707)

```bash
pop project propose \
  --name "<Project name — same as planning lesson Goal>" \
  --description "<Bundle scope summary + completion criteria + cross-references>" \
  --cap <total-PT-budget> \
  --duration <60-for-fleet-aligned-or-1440-for-high-stakes> \
  --json -y
```

Returns `proposalId`. Once proposal passes (3-of-3 fleet vote typically completes within first hour), Project comes on-chain. Then Artifact C JSONL gets filed UNDER the new project via `pop task create-batch --project <new-project-id>`.

**Duration discipline** (added HB#724-#726 empirical):
- 60 min: routine fleet-aligned proposals (project bundles, RULE updates, tool extensions). Fleet typically reaches 3-of-3 within 30 min via triage MEDIUM vote action.
- 1440 min (24h): high-stakes proposals genuinely needing deliberation. Rare. Reserve for: token mints, major Executor calls, irreversible org-metadata changes.

Mistake to avoid (HB#707/#724 vigil): using 1440 default on ALL proposals. Hudson HB#723 surfaced this — 24h vote-period means projects don't appear on-chain for a full day. Use 60-min unless you have specific reason to wait longer.

### Artifact C — JSONL task-batch file

Format (one task per line, valid JSON):

```jsonl
{"name":"<deliverable 1 title>","description":"<scope + completion criteria + empirical basis + cross-references>","payout":<pt>,"difficulty":"<easy|medium|hard>","estHours":<n>}
{"name":"<deliverable 2 title>","description":"...","payout":<pt>,"difficulty":"...","estHours":<n>}
```

Constraints (validated before write):
- Each task name < 100 chars (subgraph indexing)
- description includes WHO it builds on (lesson refs) + objective completion criteria
- payout matches difficulty band: easy ≤ 7 / medium 7-15 / hard 15+
- Project assignment is consistent across the batch (one project per batch tx)
- If deliverables span multiple projects, write SEPARATE JSONL files + invoke
  `pop task create-batch` once per project

## Algorithm (conversational pass)

1. Confirm goal + trigger with user / operator
2. Iterate through deliverables list — for each, prompt for missing fields
3. Compute total budget; validate per-task payout against difficulty band
4. Group by project; write 1 JSONL file per project
5. Emit Artifact A planning lesson body (preview before writing brain.shared)
6. Output suggested next-step shell commands:
   ```bash
   # Phase 2 spec publish
   pop brain append-lesson --doc pop.brain.shared --title "<title>" --body "<body>" --tag plan --tag <other-tags>

   # Phase 3 batch task-creation (per project)
   pop task create-batch --project <project-id> --file <jsonl-path> --json -y

   # Phase 2.5 ratification (if NACK-window)
   pop brain append-lesson --doc pop.brain.shared \
     --title "🟡 NACK-WINDOW: <action>" \
     --body "<details + tx preview>"
   ```

## Examples (dogfood from prior plans)

### Example 1 — HB#674 task-first overhaul (vigil)

- Goal: ship task-first discipline infrastructure (RULE #31 + enforcer + enabler)
- Trigger: Hudson HB#674 directive ("always create tasks for all work")
- Deliverables: 7 tasks across 3 projects (75 PT) — RULE #30 codification +
  check-retractions tool + RULE #31 codification + /plan-project skill +
  Step 5b heartbeat + F D3 swap + audit-governance-stack
- Output: brain lesson `hb-674-vigil-plan-task-first-discipline-overhaul-...`
  + 3 atomic JSONL batches (one per project)

### Example 2 — Sprint 22 research arc (hypothetical sentinel use)

- Goal: close vote-escrow research arc Part V with open-thread resolution
- Trigger: sentinel HB#1041 Part IV closeout
- Deliverables: 4 tasks — 0x29c7b44e identification + 0xe5350e92 owner-walk +
  vlCVX #4 owner-walk + Dinero live-governance hypothesis test
- Output: planning lesson + JSONL with all 4 in DeFi Research project

## Composition

- **RULE #31** (task-first discipline): /plan-project is the enabler half;
  Step 1.7 heartbeat is the enforcer; RULE #31 itself is the governance
- **RULE #30** (NACK-window pattern): Phase 2.5 ratification default for
  Hats-role-gated direct-call deliverables
- **RULE #21** (peer-poll-before-deep-write): the brainstorm/spec lessons
  are the peer-poll mechanism; on-chain tasks are the durable artifact
- **`pop task create-batch`** (task #508, sentinel HB#946): atomic multi-task
  creation — single tx for N tasks
- **`should-i-claim`** skill (task #511, sentinel HB#966): each agent runs
  selection independently against the resulting open tasks

## Failure modes + recovery

- **JSONL validation fails**: tasks contain illegal characters or names
  exceed 100 chars → trim names; re-validate; retry. Per task #508 atomic
  semantics, all-or-nothing — partial creation won't happen.
- **Project assignment ambiguous**: deliverable could fit multiple projects
  (e.g. a CLI feature that supports a research tool). Default rule: pick
  the project where the deliverable PRIMARILY operates (CLI Infrastructure
  for tool itself; DeFi Research for research-arc IPFS pins that use the tool).
- **Phase 2.5 NACK arrives** post-batch: tasks already on-chain (immutable);
  the NACK applies to HOW the tasks ship, not WHETHER they exist. Adjust
  scope via `pop task review --action reject --reason "..."` if needed.

## Provenance

- Task #533 (vigil HB#674 plan + vigil HB#683 implementation)
- RULE #31 (heuristics doc, vigil HB#680)
- Hudson HB#674 directive on task-first cycle
- Empirical basis: vigil HB#674 plan + 7-task batch dogfood (75 PT total,
  6 of 7 shipped end-to-end in 7 HBs)
- Closes RULE #31 trio: RULE #31 (#532) + Step 1.7 enforcer (#534) +
  /plan-project enabler (#533, this skill)

## Related artifacts

- `pop task create-batch` CLI (`src/commands/task/create-batch.ts`)
- `pop brain append-lesson` CLI (`src/commands/brain/append-lesson.ts`)
- Heartbeat skill Step 1.7 (`.claude/skills/poa-agent-heartbeat/SKILL.md` line 901+)
- RULE #31 codification (`pop.brain.heuristics` lesson `rule-31-task-first-discipline-...`)
- agent/brain/Identity/how-i-think.md "Task-First Discipline (RULE #31)" section
