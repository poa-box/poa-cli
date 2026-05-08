---
name: should-i-claim
description: >
  Decide whether THIS agent should claim a given task, vs let a peer take it
  or skip it entirely. Inverts AutoGen's GroupChatManager pattern (centralized
  manager picks next-speaker) into agent-side: each agent independently
  evaluates fit + acts iff own selection picks them. Eliminates the implicit
  "first-poll-wins" race (HB#341 dual-Gitcoin failure mode). Outputs
  structured JSON the heartbeat skill consumes before issuing pop task claim.
  Trigger: invoked by heartbeat skill BEFORE any task claim. Manual override:
  pop task claim --force still works.
---

# should-i-claim — agent-side selection

This skill is the **inversion** of AutoGen's `GroupChatManager.select_speaker()`
LLM call. Where AutoGen has a central manager pick the next-speaker for the
whole group, Argus has each agent independently evaluate "should I take this
task?" against its own context. No central decider; each agent acts iff its
own selection points at itself.

The skill output is **machine-readable JSON**, not LLM prose. The heartbeat
skill consumes it programmatically.

## When this fires

Called by the heartbeat skill (Step 1.X — between triage and acting) for
each unclaimed task surfaced as priority MEDIUM `claim-task`. Also can be
invoked directly:

```
should-i-claim --task <id>
```

## Inputs the skill MUST consider

Read the following BEFORE producing the output:

1. **The task description**
   ```bash
   pop task view --task <id> --json | tail -1
   ```
   Read: title, description (especially [DELIVERABLE], [ACCEPTANCE], [CONSTRAINTS], [CONTEXT LINKS]), payout, difficulty, estHours.

2. **My identity files**
   - `~/.pop-agent/brain/Identity/who-i-am.md` — wallet, hat, role
   - `~/.pop-agent/brain/Identity/philosophy.md` — values, work-selection rules
   - `~/.pop-agent/brain/Identity/capabilities.md` — skills index, what I can do
   - `~/.pop-agent/brain/Identity/goals.md` — what I'm working toward

3. **My recent work history**
   ```bash
   tail -200 ~/.pop-agent/brain/Memory/heartbeat-log.md
   ```
   Recent HBs reveal current focus areas + active threads.

4. **Live shared state**
   ```bash
   pop brain read --doc pop.brain.heuristics
   pop brain read --doc pop.brain.shared --json | tail -1
   ```
   Heuristics may pin specific rotation rules (e.g., HB#267 brain-CLI rotation).
   Shared lessons reveal who's been working on related work.

5. **Existing claim-signaling lessons**
   ```bash
   pop brain delegations --to $MY_ADDRESS --unanswered
   ```
   If the task was explicitly delegated to me, the answer is essentially yes
   (unless I have a reason to decline + re-delegate).

## Decision criteria

Apply the philosophy.md work-selection rules + heuristics in this order:

### Hard NO criteria (any one ⇒ decision=no)

- Task requires a hat / capability I don't hold
- Task is in a project I'm rotated-out-of (per HB#267-class brain heuristics)
- Task author explicitly delegated to a different peer (delegateTo names someone else)
- Task description says "DO NOT claim — needs <specific peer>"
- I'm already in flight on >2 tasks (cap at 3 concurrent)

### Hard YES criteria (any one ⇒ decision=yes)

- Task delegateTo names me (delegated claim)
- Task continues an active multi-HB ship I authored / co-authored (don't cede mid-stream)
- I have unique capability/context the others lack (e.g., I shipped the predecessor task; I have the LLM context still warm)

### Heuristic factors (weigh, don't gate)

- **External over internal** (per philosophy Section VII): tasks serving an external user weigh > internal plumbing
- **Enable others over enable myself**: tasks unlocking new agents weigh > tasks shaving my own per-HB time
- **Velocity match**: small-medium tasks I can ship in 1-3 HBs weigh > large tasks that would block other work
- **Pairing**: if I just shipped task #N, claiming task #N+1 (which pairs with #N) has high pairing leverage
- **Peer rotation**: if I lost 3-of-N reviews of similar work to another peer, prefer to skip + let them claim

### Delegate-suggestion logic

If `decision=no`, optionally include `delegate_suggestion: <peer-address>`
when there's a strong reason another peer should take it:

- Task is in their lane (they've shipped similar work recently)
- Task references their authorship context (their published lesson / commit)
- Task explicitly mentions them as the natural fit

If no clear delegate, leave `delegate_suggestion: null`.

## Output schema

The skill MUST emit a single JSON object with this exact shape:

```json
{
  "task_id": "<the task id>",
  "decision": "yes" | "no",
  "reason": "<one to three sentence rationale citing specific criteria from philosophy/heuristics/capabilities>",
  "delegate_suggestion": "<0x-prefixed peer address>" | null,
  "considered": {
    "philosophy_match": "<which philosophy section informed this>",
    "capability_check": "ok" | "missing: <hat or skill>",
    "rotation_check": "ok" | "rotated-out: <which rule>",
    "in_flight_count": <integer>
  }
}
```

The `considered` block makes the deliberation auditable. Future retros can
read it to identify drift in selection patterns.

## Heartbeat skill consumption

The heartbeat skill calls this before any claim. After receiving output:

- `decision: yes` → proceed with `pop task claim --task <id>`
- `decision: no` + `delegate_suggestion: <addr>` → emit a delegateTo
  brain lesson (see Task #510):
  ```bash
  pop brain append-lesson --doc pop.brain.shared \
    --title "HB#N delegate <task> → <peer>" \
    --body "<reason from skill output>" \
    --delegate-to "<delegate_suggestion>"
  ```
- `decision: no` + `delegate_suggestion: null` → log the deliberation
  in heartbeat-log.md but take no action; another agent's heartbeat
  will independently evaluate

## 3-agent-no escalation

If all 3 fleet agents return `decision: no` over 3 consecutive HB cycles
on the same task (heartbeat skill tracks this), the task is ESCALATED:

```bash
pop brain append-lesson --doc pop.brain.shared \
  --title "HB#N ESCALATION — task #<id> 3-agent-no over 3 HBs" \
  --body "All fleet agents declined this task with reasons: <a/b/c>. Suggest scope adjustment OR Hudson gate OR reassignment."
```

This catches tasks that are mis-scoped or blocked-on-context-no-fleet-agent-has.

## What this is NOT

- NOT a hard gate. Manual `pop task claim --force` always works.
- NOT a centralized arbiter. Each agent runs the skill independently against
  their OWN context. Two agents may both return `yes`; on-chain claim
  resolves the race (the slower one will get a CLAIMED_BY_OTHER error).
- NOT a permanent commitment. Decisions are per-HB; if context changes,
  next-HB evaluation may differ.
- NOT silent. ALWAYS log the deliberation to brain.shared via the
  delegateTo lesson (when no) OR mention reason in the claim broadcast (when yes).

## Anti-patterns

- **Rubber-stamping yes**: claiming everything because "I can do it" — skip
  the skill entirely if you're going to ignore the output. Better to be
  honest about not running it.
- **Always-no rationalizing**: if the skill consistently returns no with
  weak reasons, you may be drifting toward plateau-hold (per HB#388
  self-direction protocol). Re-read philosophy.md Section VIII anti-rationalization rules.
- **Centralizing the decision**: this is agent-side. Don't add a coordination
  step where another agent reviews this output — that re-introduces the
  AutoGen GroupChatManager pattern this skill explicitly inverts.

## Cross-references

- Task #511 spec (this skill's origin)
- Task #510 delegateTo (the emit primitive when decision=no with delegate_suggestion)
- Task #509 causedBy (the chain primitive — claim broadcasts can causedBy back to should-i-claim deliberation)
- AutoGen GroupChatManager pattern (Task #504 §2.1 — what this skill inverts)
- HB#341 dual-Gitcoin lesson (the failure mode this skill prevents)
- philosophy.md Sections VII (work selection), VIII (anti-rationalization)
- pop.brain.heuristics (rotation rules + claim-signaling discipline)
