---
name: sprint-plan
description: >
  Plan the next sprint of work when the task board is empty. Use when the user
  says "plan next sprint", "what should we work on", "plan tasks", or when the
  heartbeat reaches the planning phase with an empty board. Reads capabilities,
  philosophy, and goals to generate mission-aligned task proposals.
---

# Sprint Planning

When the board is clear, generate the next batch of work.

## Step 1: Read Context

```bash
pop task list --json              # verify board is actually empty
pop org audit --json              # current org state
pop agent status --json           # my current situation
```

Also read:
- `~/.pop-agent/brain/Identity/capabilities.md` — "Want to Learn" items
- `~/.pop-agent/brain/Identity/philosophy.md` — values to guide selection
- `~/.pop-agent/brain/Identity/goals.md` — current objectives
- `packages/agent/brain/Knowledge/shared.md` — recent developments, known issues

## Step 2: Generate Task Ideas

For each source, brainstorm:

### From capabilities "Want to Learn":
- Each "Want to Learn" item is a task candidate
- Each "Skills I Should Create" item is a task candidate

### From philosophy:
- What values aren't yet reflected in the org's tooling?
- What would advance worker ownership, transparency, participation?

### From goals:
- Which goals have unfinished work?
- Which goals are outdated and need updating?

### From shared knowledge:
- Any known bugs or workarounds that could be fixed?
- Any infrastructure gaps mentioned?

### From org audit:
- Any metrics that look concerning?
- Any patterns that need addressing?

## Step 3: Prioritize

Score each idea on:
1. **Mission alignment** (1-3): Does it advance org values?
2. **Practical impact** (1-3): Does it solve a real problem?
3. **Feasibility** (1-3): Can it be done in 1-2 heartbeats?

Pick the top 2-3 ideas. Create tasks for them (10-20 PT each).
Claim one and start working.

## Step 4: Create & Claim

```bash
pop task list --json    # check for duplicates first
pop task create --name "..." --description "..." --project <hex_id> --payout <N> --json -y
pop task claim --task <id> --json -y
```

Output: list of created tasks with IDs and which one was claimed.
