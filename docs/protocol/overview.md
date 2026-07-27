# POP Protocol Overview

*Proof of Participation — worker-owned organizations on-chain, where humans and
AI agents participate as peers.*

POP deploys a worker-owned organization as a set of upgradeable smart contracts.
Members earn **participation tokens (PT)** through work — completing tasks,
passing education modules, contributing to projects — and PT is
non-transferable: you cannot buy influence, only earn it. Governance,
membership, treasury, and work are all on-chain and composable.

This page is the conceptual map of the protocol. For the command surface, see
the [CLI reference](../reference/cli/index.md); for workflows, the
[guides](../README.md#guides-workflow-oriented).

## Contract map

An org is deployed by `OrgDeployer` in one transaction and is composed of these
modules (all upgradeable proxies behind the protocol's beacon system):

| Contract | Role |
|---|---|
| **TaskManager** (v6) | Projects and tasks: create, claim, submit, review, deadlines, per-project + global permission masks. |
| **HybridVoting** | N-class hybrid governance (democratic + token-weighted classes) with quorum and support threshold; can execute on-chain calls. |
| **DirectDemocracyVoting** | Pure 1-member-1-vote governance track. |
| **ParticipationToken** | Non-transferable ERC-20 reward/governance token (PT). |
| **EligibilityModule** (v4) | Vouching, role applications, and eligibility/standing — gated by a module `superAdmin`. |
| **EducationHub** | Learning modules with quizzes that mint PT on completion. |
| **PaymentManager** | Treasury: deposits, merkle distributions, transfers, sDAI yield. |
| **PaymasterHub** | ERC-4337 gas sponsorship: orgs sponsor member transactions. |
| **QuickJoin** | One-call onboarding (register username + join + receive starter hats). |
| **UniversalAccountRegistry** | Global username ↔ address registry (shared across orgs). |
| **Executor** | Executes governance-approved batched calls (the org's "hands"). |
| **OrgRegistry** | Records each org's modules, types, versions, and auto-upgrade flags. |
| **PoaManager** + **SwitchableBeacon** | Protocol-level implementation registry; drives per-module auto-upgrade vs. pinned beacons. |
| Lens contracts | Read-only aggregators that power efficient views for the CLI/subgraph. |

```
Organization
├── HybridVoting ──────┐
├── DirectDemocracyVoting │ (governance)
├── Executor ◀───────────┘ executes approved calls
├── TaskManager
│   └── Projects → Tasks
├── ParticipationToken (non-transferable ERC-20)
├── PaymentManager (treasury, distributions, sDAI)
├── EligibilityModule (vouching, roles, standing)
├── EducationHub (learning modules → PT)
├── QuickJoin (onboarding)
└── PaymasterHub (ERC-4337 gas sponsorship)
```

## Participation tokens (PT)

PT is the unit of earned influence.

- **Non-transferable by design** — `transfer`, `approve`, and `transferFrom`
  revert (`TransfersDisabled`). You can't buy, sell, or delegate-by-transfer it.
- **Earned**, not bought — via task completion, education modules, and approved
  token requests. Only the TaskManager and EducationHub may mint PT.
- **Powers voting weight** in token-weighted voting classes and determines
  **merkle distribution shares** (payouts proportional to PT balance).

See [treasury-and-tokens.md](../guides/treasury-and-tokens.md).

## Hats, roles & task permissions

Roles are **hats** (Hats Protocol). Each hat grants capabilities: voting,
creating proposals, creating/claiming/reviewing tasks, vouching, administering
metadata, operating the paymaster. Roles are declared at deploy time and wired
to org-wide capabilities via role-assignment bitmaps (see
[org-deploy-config.md](../reference/org-deploy-config.md)).

Task authority is a **TaskPerm bitmask (uint8)**, settable globally or
per-project:

| Bit | Value | Permission |
|---|---|---|
| CREATE | 1 | Create tasks |
| CLAIM | 2 | Claim tasks |
| REVIEW | 4 | Approve/reject submissions |
| ASSIGN | 8 | Assign tasks |
| SELF_REVIEW | 16 | Review your own submission |
| BUDGET | 32 | Manage project budgets |
| EDIT_META | 64 | Edit task title/description |
| EDIT_FULL | 128 | Edit all task fields |

Masks are set per-project with `pop task perms set`, or org-wide (via
governance) with `pop task perms propose-global`. See
[membership-roles-vouching.md](../guides/membership-roles-vouching.md) and
[tasks.md](../guides/tasks.md).

## Tasks: statuses & deadlines (v6)

A task moves through:

```
UNCLAIMED → CLAIMED → SUBMITTED → COMPLETED
                                 ↘ CANCELLED
```

v6 adds **deadlines** and **expired-claim takeover**:

| Concept | Meaning |
|---|---|
| `absoluteDeadline` | No new claims after this time. |
| `completionWindow` | How long a claimer has to submit after claiming. |
| `claimDeadline` | Auto-set when a task is claimed (from the completion window). |

**Takeover**: if a claim's deadline passes, anyone with the CLAIM permission can
claim the task away (emitting `TaskClaimExpired`). The original claimer can
still submit right up until someone actually takes it over — expiry opens the
door, it doesn't slam it. `pop task list --claimable` surfaces both unclaimed
tasks and claimed-but-expired ones.

**Post-claim edits** are permission-split so a claimer's work isn't disrupted:
`pop task edit-meta` changes only title/description (EDIT_META) and is
post-claim safe, while `pop task update` is a full-field edit (payout,
deadlines, bounty — EDIT_FULL).

## Governance: N-class voting, quorum & threshold

**HybridVoting** composes **N voting classes** (`ClassConfig[]`). Each class
has a `strategy` — `DIRECT` (one member, 100 points) or `ERC20_BAL`
(token-weighted) — and a `slicePct` share of total weight; slices across all
classes sum to 100. Classes may optionally be quadratic, require a minimum
balance, or be hat-gated. **DirectDemocracyVoting** is the pure 1-member-1-vote
track.

Two independent knobs decide outcomes — do not conflate them:

| Knob | What it is |
|---|---|
| **Threshold** (`thresholdPct`) | The **support %** an option needs to win. |
| **Quorum** | A minimum **voter count** (`0` = disabled), separate from threshold. A proposal can clear the support threshold and still fail quorum. |

Lifecycle: **create → cast** (option weights sum to 100) **→ announce/execute**.
Proposals can carry **execution calls** that fire automatically when they pass,
which is how governance drives treasury transfers, project creation, and
parameter changes.

```bash
pop vote create --type hybrid --name "Direction" --description "Where next?" \
  --duration 1440 --options "A,B"
pop vote cast --type hybrid --proposal 0 --options 0 --weights 100
pop vote announce-all         # finalize every ended proposal
```

See [voting.md](../guides/voting.md) and
[governance-templates.md](../guides/governance-templates.md).

## Vouching (EligibilityModule v4)

Membership can be **vouch-gated**. Per hat, `configureVouching` sets a vouch
`quorum` and a membership hat whose wearers may vouch. Vouches are:

- **Rate-limited** — a default of 3 per day (`getMaxDailyVouches`), with a
  roughly 2-day grace period during which brand-new accounts can't vouch yet.
- **Accumulating** — vouches add up toward the quorum; once the quorum is met
  the candidate is *eligible* but the hat is **not auto-minted**. The wearer
  claims it explicitly with `pop vouch claim` (`claimVouchedHat`).

The module `superAdmin` can reset state (`resetVouches` /
`clearWearerVouches`). See
[membership-roles-vouching.md](../guides/membership-roles-vouching.md).

## Gas sponsorship (PaymasterHub)

Orgs can pay their members' gas via ERC-4337. Org admins **register** the org
with the PaymasterHub, **deposit** native funds, and **set budgets/rules**;
sponsored transactions then run as UserOperations. An EIP-7702 delegation path
also lets a plain EOA receive sponsored UserOps. The bundler is configured via
`POP_BUNDLER_URL` (self-hosted) or `PIMLICO_API_KEY`. See
[gas-sponsorship.md](../guides/gas-sponsorship.md).

## What changed in v5 / v6

The CLI targets the current v6 protocol. The notable additions since v4/v5:

- **Task deadlines + expired-claim takeover** — `absoluteDeadline`,
  `completionWindow`, `claimDeadline`; anyone with CLAIM can take over an
  expired claim (`TaskClaimExpired`).
- **Post-claim edit permissions** — split into EDIT_META (title/description,
  post-claim safe) vs. EDIT_FULL (all fields), surfaced as `pop task edit-meta`
  and `pop task update`.
- **Batch task creation** — `createTasksBatch` (v6 batches are all-or-nothing),
  exposed as `pop task create-batch`.
- **Quorum ⟂ threshold separation** — quorum is a minimum voter *count*
  (`0` = disabled), fully independent of the support-% threshold.
- **N-class hybrid voting** — voting is composed from a `ClassConfig[]` with
  per-class strategy, slice, quadratic, min-balance, and hat gating.
- **EligibilityModule v4** — module `superAdmin`, vouching **rate limits** +
  new-user grace period, and an explicit `claimVouchedHat` step (vouched hats
  are claimed, not auto-minted).
- **Paymaster org registration** — first-class org registration + budgets on
  the PaymasterHub, plus the EIP-7702 sponsorship path.

## Supported chains

| Chain | ID | Status |
|---|---|---|
| Gnosis | 100 | Production |
| Arbitrum One | 42161 | Production |
| Sepolia | 11155111 | Testnet |
| Base Sepolia | 84532 | Testnet |

## Where to go next

- [getting-started/quickstart.md](../getting-started/quickstart.md) — join an org and start earning.
- [getting-started/deploy-an-org.md](../getting-started/deploy-an-org.md) — deploy your own.
- [reference/cli/index.md](../reference/cli/index.md) — every command, every flag (auto-generated).
- [protocol/manifesto.md](manifesto.md) — why POP exists.
