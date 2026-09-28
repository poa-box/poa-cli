# Tasks & Projects

Tasks are how work gets funded in a Perpetual Organization. A member claims a
task, does the work, submits it, and a reviewer approves — at which point the
participation-token (PT) payout is minted to the worker. This guide covers the
full v6/v7 task lifecycle: deadlines, expired-claim takeover, releasing a
claim, applications, post-claim edits, batch creation, projects, and the
task-permission bitmask.

Every command here is grounded in the CLI reference:
[task.md](../reference/cli/task.md) and
[project.md](../reference/cli/project.md).

## Prerequisites

- A deployed org and a wallet with a membership hat. See the
  [quickstart](../getting-started/quickstart.md).
- At least one **project** to hold tasks (tasks always live inside a project —
  the [Projects](#projects) section below shows how to create one).
- The relevant **task permission** for what you're doing (create, claim,
  review, assign…). See [Task permissions](#task-permissions).

## The task lifecycle

```text
                   ┌──────────────────────────────────────────┐
                   │             pop task cancel               │
                   │        (only while UNCLAIMED)             │
                   ▼                                           │
   pop task create ──▶ UNCLAIMED ──pop task claim──▶ CLAIMED ──pop task submit──▶ SUBMITTED
                          │  ▲            (or assign/           │                     │
                          │  │            approve-app)         │                     ├─ review approve ─▶ COMPLETED  (PT minted)
                          │  │                                 │                     │
                          │  ├── takeover ◀── claim expired ◀──┤                     └─ review reject ──▶ back to CLAIMED
                          │  │     (anyone with CLAIM)         │                           (worker fixes & re-submits)
                          │  │                                 │
                          │  └── pop task unclaim ◀────────────┘
                          │        (the claimer any time; ASSIGN once expired)
                          ▼
                      CANCELLED
```

| State | Meaning | Who acts next |
| --- | --- | --- |
| `UNCLAIMED` | Open. Anyone with `CLAIM` can take it (or apply, if it requires an application). | claimer / applicant / assigner |
| `CLAIMED` | Someone owns it and is working. A `claimDeadline` may be ticking. | the claimer (submit, or `unclaim` to hand it back) — or, once expired, anyone with `CLAIM` (takeover) or `ASSIGN` (force-release) |
| `SUBMITTED` | Work is in for review. | a reviewer (`REVIEW`) |
| `COMPLETED` | Approved. PT payout minted to the worker; bounty (if any) released. | — terminal |
| `CANCELLED` | Killed while still unclaimed. | — terminal |

> `pop task list` surfaces these as `Open / Assigned / Submitted / Completed /
> Cancelled` and shows `Claimed (expired — claimable)` for a claim whose
> deadline has passed.

## Creating tasks

The minimum is a project, a name, a description, and a PT payout:

```bash
pop task create --project 0 --name "Write onboarding docs" \
  --description "One-page getting-started for new members" --payout 25
```

`--payout` is the participation-token reward, minted to the worker on approval.
PT is **non-transferable** — it is reputation/contribution weight, not a
tradeable coin.

### Attach an ERC-20 bounty

On top of the PT payout you can escrow a transferable ERC-20 bounty that pays
out alongside it. Provide both the token and the amount:

```bash
pop task create --project 0 --name "Fix RPC retry bug" \
  --description "Bounded backoff on 429s in the bundler client" \
  --payout 40 --bounty-token 0xTOKEN --bounty-amount 100
```

The bounty token must be within the project's configured bounty tokens/caps —
see [Projects](#projects).

### Require an application

By default a task is open-claim (first come, first served). Set
`--requires-application` to gate it behind reviewer approval instead:

```bash
pop task create --project 0 --name "Lead the Q3 audit" \
  --description "Coordinate the external security review" \
  --payout 200 --requires-application
```

Contributors then [apply](#applications-vs-open-claim-vs-direct-assign) and a
reviewer approves one of them.

### Add deadlines (v6)

v6 orgs support two independent deadline controls at creation time:

```bash
# No claims after Aug 1; once claimed, the worker has 48h to submit.
pop task create --project 0 --name "Ship the release notes" \
  --description "Changelog + migration guide for v6" --payout 30 \
  --deadline 2026-08-01 --completion-window 48h
```

See the next section for exactly what each one gates.

## The deadline model

v6 tasks have **three** related deadlines. Two you set; one the contract
derives for you on claim.

| Deadline | Flag | What it gates | Accepted formats |
| --- | --- | --- | --- |
| **Absolute deadline** | `--deadline` | The point past which *any* claim on the task counts as expired — instantly takeover-able, and force-releasable by an ASSIGN holder. It is **not** a hard cutoff for claiming: claiming and submitting both still succeed after it, the claim is simply never safe. Does not, by itself, force a submission. | `7d`, `48h`, `90m`, `3600s`, ISO date `2026-08-01`, ISO datetime `2026-08-01T12:30:00Z`, unix seconds, or `0` for none |
| **Completion window** | `--completion-window` | How long a worker has to *submit* after they claim. | `48h`, `90m`, `3600s`, bare seconds, or `0` for none |
| **Claim deadline** | (derived) | The concrete "submit-by" time for the current claim: `claimTime + completionWindow`, capped by the absolute deadline. Set automatically on claim and echoed back. | — read-only |

When you claim a task with a completion window, the CLI echoes the resulting
submit-by time and a live countdown, e.g. `Submit before 2026-08-03 14:00 UTC
(in 47h 58m)`.

> **Rule of thumb:** `--deadline` protects the *pool* of open tasks (stops
> stale tasks from being claimed forever); `--completion-window` protects
> *throughput* (a claimed task can't be sat on indefinitely). Use both for
> time-boxed bounties, either alone, or neither.

## Expired-claim takeover

This is the key v6 behavior that keeps work flowing when a claimer goes quiet.

**If a claim's deadline passes, the task becomes claimable again by anyone with
`CLAIM` permission.** Taking it over releases the old claim (emitting
`TaskClaimExpired`) and starts a fresh completion window for the new claimer.

Two things to internalize:

1. **The original claimer can still submit** right up until someone actually
   takes it over. An expired deadline does not delete their work — it just
   *opens the door* for a takeover. If they submit before anyone takes over,
   they keep the task.
2. **Takeover is not automatic.** Someone has to run `pop task claim` on the
   expired task. Until then it sits in `Claimed (expired — claimable)`.

Find takeover-eligible work:

```bash
# Everything you could claim right now: unclaimed tasks
# PLUS claimed tasks whose deadline already expired.
pop task list --claimable

# Tasks whose governing deadline lands inside a window (default 24h) —
# your own claims about to lapse, or others' about to open up.
pop task list --expiring 24h
```

Taking over is just a normal claim on an expired task:

```bash
pop task claim --task 12
# → "Taking over expired claim from 0xABC…"
# → "Takeover confirmed — the expired claim by 0xABC… was released."
```

The CLI refuses (before spending gas) to claim a task that is claimed but
**not** expired, naming the current claimer and the time remaining.

## Releasing a claim

Takeover needs a replacement worker. v7 adds the other direction: hand the task
back to the pool with nobody holding it.

```bash
# Give up your own claim — allowed at any time, no permission check.
pop task unclaim --task 12

# Force-release someone else's claim. Needs ASSIGN *and* an expired claim.
pop task unclaim --task 12 --yes
```

Two routes, deliberately asymmetric:

| Who | When | Needs |
| --- | --- | --- |
| **The claimer** | Any time | Nothing — no mask, no deadline check. An assignee never had to hold `CLAIM`, and hats get revoked mid-claim; gating this would trap exactly the people it frees. |
| **Anyone else** | Only once the claim has **already expired** | `ASSIGN` on the project (PM / executor bypass included). |

`SUBMITTED` is excluded on purpose — a zeroed claimer would let the approval
path mint the payout to `address(0)`. Reject first, then release:

```bash
pop task review --task 12 --action reject --reason "Abandoned — releasing"
pop task unclaim --task 12
```

**A claim with no deadline can never be force-released**, because it never
expires. The documented unstick is to give it one in the past and then release:

```bash
pop task update --task 12 --deadline 2020-01-01   # needs EDIT_FULL
pop task unclaim --task 12 --yes
```

Releasing and re-claiming your own task is a legitimate way to refresh the
completion window — but `absoluteDeadline` is never reset, so the hard claim
cutoff still applies and you may not get the task back at all.

**Release is not cancel.** Budgets and application hashes are untouched
on-chain: nothing is refunded, no applicant is dropped, and the task is
immediately claimable again. `pop task cancel` remains the only refund path —
and it becomes reachable again, because it only works on an unclaimed task.

**What the subgraph shows afterwards.** A release resets the task to `Open` and
nulls `assignee`, `assignedAt`, and `claimDeadline` — it looks like it was never
claimed. The only surviving evidence is `releaseCount`, which `pop task list`
renders as a `↺N` suffix on the status:

```bash
pop task list --released      # tasks someone claimed and then handed back
```

That signal is indexed on **Gnosis only** today. Elsewhere the release lands
on-chain but no read surface reflects it, and the task keeps showing as claimed
by the previous assignee — `pop task unclaim` warns you at the moment it
happens.

> **Gas sponsorship:** the `unclaimTask` selector is auto-whitelisted only for
> orgs deployed by OrgDeployer v18 or later. An existing org has to whitelist it
> through a governance batch before releases can be sponsored.

## Applications vs open claim vs direct assign

There are three ways a task gets an owner:

| Mode | How | When to use |
| --- | --- | --- |
| **Open claim** | Anyone with `CLAIM` runs `pop task claim --task N`. | Default. Low-stakes, first-come work. |
| **Application** | Task created with `--requires-application`; contributors apply, a reviewer approves one. | Higher-stakes work where you want to choose the worker. |
| **Direct assign** | Someone with `ASSIGN` runs `pop task assign`. | You already know who should do it. |

### Applications

```bash
# Contributor applies (optionally with experience / notes)
pop task apply --task 7 --experience "Led two prior audits" \
  --notes "Available immediately"

# Reviewer/manager approves one applicant → that address becomes the claimer
pop task approve-app --task 7 --applicant 0xCONTRIBUTOR
```

### Direct assign

```bash
# By address…
pop task assign --task 7 --assignee 0xCONTRIBUTOR
# …or by username (resolved to an address for you)
pop task assign --task 7 --username alice
```

## Editing a task after it's claimed

Once work has started you usually don't want to silently rewrite the payout out
from under a worker. v6 splits editing into two commands with two different
permissions:

| Command | Scope | Permission | Notes |
| --- | --- | --- | --- |
| `pop task edit-meta` | Title / description only | `EDIT_META` (64) | Post-claim safe; re-pins metadata. Use for typo fixes and clarifications. |
| `pop task update` | Full read-then-merge edit: payout, name, description, bounty, and both deadlines | `EDIT_FULL` (128) | The powerful one. Only pass the fields you want to change; the rest are read from chain and preserved. |

```bash
# Safe clarification — anyone with EDIT_META
pop task edit-meta --task 12 \
  --description "Clarified: docs must cover the v6 takeover flow too"

# Full edit — needs EDIT_FULL. Bump payout and shorten the window.
pop task update --task 12 --payout 35 --completion-window 24h

# Clearing fields with task update:
#   --bounty-token none   clears the bounty
#   --deadline 0          removes the absolute deadline
#   --completion-window 0 removes the window
# A PAST --deadline value deliberately opens a claimed task to takeover.
pop task update --task 12 --deadline 0
```

> `task update` is a *read-then-merge*: it fetches the current on-chain fields,
> overlays your flags, and writes the merged result — so omitted fields are
> never zeroed by accident.

## Reviewing & rejecting

A submitted task waits for someone with `REVIEW`:

```bash
# Approve → COMPLETED, PT payout (and bounty) released to the worker
pop task review --task 12 --action approve

# Reject → back to CLAIMED so the worker can fix and re-submit.
# A reason is required on reject.
pop task review --task 12 --action reject \
  --reason "Missing the migration section; please add and re-submit"
```

Find work waiting on you:

```bash
pop task list --for-review          # shortcut for --status Submitted
```

## Batch creation

Create many tasks at once from a JSONL file (one JSON object per line). All
tasks share one `--project`; per-row fields override the batch-wide flags.

Each line accepts: `name`, `description`, `payout` (required), plus optional
`difficulty`, `estHours`, `location`, `bountyToken`, `bountyAmount`,
`requiresApplication`, and — on v6 — per-row `deadline` and `completionWindow`.

```jsonl doc-test=skip
{"name":"Triage inbox","description":"Label new issues","payout":10}
{"name":"Weekly digest","description":"Summarize the week","payout":15,"completionWindow":"72h"}
{"name":"Security pass","description":"Review the auth path","payout":50,"requiresApplication":true,"deadline":"2026-08-15"}
```

```bash
# Batch-wide defaults; individual rows above override them.
pop task create-batch --project 0 --file tasks.jsonl \
  --deadline 2026-09-01 --completion-window 48h
```

> **v6 batches are all-or-nothing.** If any task in the batch fails, the whole
> batch reverts — you never end up with a half-created set. (The
> `--continue-on-error` flag exists only for legacy pre-v6 orgs.)

## Projects

Projects are the containers tasks live in. They carry the budget cap and the
per-permission hat lists that decide *who can do what* to their tasks.

| Command | Purpose |
| --- | --- |
| `pop project list` | List projects (IDs, names, caps). |
| `pop project create` | Create directly (needs the creator hat / executor). |
| `pop project propose` | Create via a governance vote instead. |
| `pop project delete` | Destructive removal (creator hat / executor). |

```bash
# Create the project, then configure its authority permissions through a vote
pop project create --name "Docs" --description "Documentation work" --cap 5000
pop project propose --name "Docs" --description "Documentation work" --cap 5000
```

**Budgets & caps.** `--cap` is the total PT a project may pay out (`0` =
unlimited). For ERC-20 bounties, `pop project create` also takes
`--bounty-tokens` and matching `--bounty-caps` (wei) to whitelist which tokens a
task in this project may escrow and how much:

```bash
pop project create --name "Bounties" \
  --bounty-tokens 0xTOKEN --bounty-caps 1000000000000000000000
```

## Task permissions

Task actions use the authority `TM_PERMS` bitmask. Roles and groups hold permission rows. Global and project changes both require governance.

| Bit | Value | Permission | Grants the ability to… |
| --- | --- | --- | --- |
| CREATE | `1` | `create` | Create tasks in the project |
| CLAIM | `2` | `claim` | Claim tasks (and take over expired claims) |
| REVIEW | `4` | `review` | Approve/reject submissions |
| ASSIGN | `8` | `assign` | Assign tasks & approve applications |
| SELF_REVIEW | `16` | `self-review` | Review your own submissions |
| BUDGET | `32` | `budget` | Change payouts / bounties on tasks |
| EDIT_META | `64` | `edit-meta` | Edit task title/description |
| EDIT_FULL | `128` | `edit-full` | Full `task update` edits (all fields) |

A mask is the sum of its bits. Worked examples:

| Role | Permissions | Bits | Mask |
| --- | --- | --- | --- |
| Contributor | claim only | `2` | **2** |
| Reviewer | review + assign | `4 + 8` | **12** |
| Task lead | create + claim + review + assign | `1 + 2 + 4 + 8` | **15** |
| Editor | edit-meta + edit-full | `64 + 128` | **192** |

### Inspecting and setting masks

The CLI takes permissions by **name** (comma-separated) so you don't have to do
the bitmath by hand — it computes the mask for you.

```bash
# Read current authority masks
pop task perms show --json
pop task perms show --project 0xPROJECT_BYTES32 --json

# Propose project and global permissions
pop task perms set --project 0xPROJECT_BYTES32 --subject ROLE_ID --perms review,assign --dry-run
pop task perms propose-global --subject ROLE_ID --perms create,claim --dry-run

# Clear a project row to restore global inheritance
pop task perms clear --project 0xPROJECT_BYTES32 --subject ROLE_ID --dry-run
```

A project row replaces the subject's global row unless `--inherit-global` is set. Setting `--perms none` writes an explicit zero; clearing removes the row. The CLI encodes project contexts as `projectId + 1` to avoid colliding with the global zero context.

## Where to go next

- [Voting guide](voting.md) — governance for `project propose`,
  `task perms propose-global`, and treasury distributions.
- [Task command reference](../reference/cli/task.md) — every flag.
- [Project command reference](../reference/cli/project.md).
- [Quickstart](../getting-started/quickstart.md) — the 15-minute tour.
