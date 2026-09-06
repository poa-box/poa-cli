# Voting & Governance

Governance in a Perpetual Organization runs through on-chain proposals. This
guide covers the two voting engines (hybrid and direct-democracy), the v6
**N-class** voting model, the crucial distinction between **quorum** (how many
voters) and **threshold** (how much support), execution-call proposals, and how
to read results.

Every command here is grounded in the CLI reference:
[vote.md](../reference/cli/vote.md).

## Prerequisites

- A deployed org with a voting module. See the
  [quickstart](../getting-started/quickstart.md).
- A wallet holding a hat that is eligible to vote (some proposals are
  hat-gated — see [Restricted proposals](#restricted-hat-gated-proposals)).
- For token-weighted classes, a balance of the relevant participation token.

## Two voting engines: hybrid vs direct-democracy

Every proposal is created against one engine, chosen with `--type`:

| `--type` | Engine | How power is counted |
| --- | --- | --- |
| `hybrid` | **HybridVoting** | Blends multiple *classes* of power (e.g. one-person-one-vote + token-weight), each contributing a slice of the total. This is the flagship engine. |
| `dd` | **DirectDemocracy** | Pure one-member-one-vote. Simple and equal. |

You pass the same `--type` to `create`, `cast`, `announce`, and `execute` so
the CLI talks to the right module.

## N-class voting (hybrid)

HybridVoting doesn't pick *one* way to weight votes — it composes several. Each
proposal is scored against an ordered list of **classes** (`ClassConfig[]`), and
each class owns a percentage slice of the outcome. This is how you get "80%
democracy, 20% token-weight" in a single vote.

### ClassConfig fields

| Field | Meaning |
| --- | --- |
| `strategy` | `DIRECT` (1) = one person, 100 points each. `ERC20_BAL` (2) = power proportional to token balance. |
| `slicePct` | This class's share of the total outcome. **All slices must sum to 100.** |
| `quadratic` | If set, power scales with the square root of the raw amount (dampens whales). |
| `minBalance` | Minimum token balance required to participate in this class. |
| `asset` | For `ERC20_BAL`, the token whose balance is weighed. |
| `hatIds` | Optional hat gating — only wearers of these hats count in this class. |

> **DIRECT vs ERC20_BAL.** `DIRECT` is egalitarian: every eligible member casts
> the same 100 points regardless of holdings — pure headcount. `ERC20_BAL` is
> stake-weighted: your influence tracks your token balance (optionally softened
> by `quadratic` and floored by `minBalance`).

### Inspecting and changing classes

```bash
# Show the live class config + support threshold + quorum
pop vote classes show

# Show the class snapshot frozen for one proposal (by ID or fuzzy title)
pop vote classes show --proposal 42
pop vote classes show --proposal "treasury split"

# Propose replacing the whole class config via a governance vote.
# --file is a ClassConfig[] JSON file (strategy, slicePct, quadratic,
# minBalance, asset, hatIds). Slices in the file must sum to 100.
pop vote classes propose --file classes.json --duration 1440
```

An example `classes.json` describing an 80/20 democracy-plus-token split:

```json doc-test=skip
[
  { "strategy": "DIRECT",    "slicePct": 80 },
  { "strategy": "ERC20_BAL", "slicePct": 20, "asset": "0xPT_TOKEN", "quadratic": true, "minBalance": "1" }
]
```

> Class snapshots are **frozen per proposal**: changing the live config never
> alters how an already-open vote is counted. Use `classes show --proposal N`
> to see exactly what a given proposal is being judged against.

## Quorum vs threshold — the v6 separation

These are two independent gates, and v6 keeps them cleanly separate. A proposal
passes an option only if it clears **both**:

| Gate | What it measures | Configured via |
| --- | --- | --- |
| **Quorum** | A minimum **voter COUNT** — how many distinct voters must participate. `0` = disabled. It is *not* a percentage. | `pop vote propose-quorum` or `propose-config --key quorum` |
| **Threshold** | The **support percentage** an option needs to win (e.g. 51%). | `pop vote propose-config --key threshold` |

Think of it as: *quorum asks "did enough people show up?"*, *threshold asks "did
enough of them agree?"* You can raise participation requirements and support
requirements independently.

```bash
# Require at least 10 distinct voters on future proposals (quorum = a COUNT)
pop vote propose-quorum --quorum 10 --duration 60

# Same thing via the generic config command
pop vote propose-config --key quorum --value 10 --duration 60

# Require 60% support to pass (threshold = a PERCENT)
pop vote propose-config --key threshold --value 60 --duration 60
```

`pop vote propose-config` also drives other governance parameters via `--key`:
`target-allowed` (DD execution targets) and `executor`. Authorize DD voters with `role set-perm --key DD_VOTE --value 1`.

## Proposal lifecycle

```text
pop vote create ──▶ Active ──pop vote cast──▶ (voting…) ──▶ Ended
                                                              │
                                            pop vote announce (declare winner)
                                                              │
                                            pop vote execute (run option's calls, if any)
                                                              ▼
                                                          Executed
```

### 1. Create

```bash
pop vote create --type hybrid --name "Adopt the new logo" \
  --description "Should we switch to the v2 mark?" \
  --duration 1440 --options "Yes,No"
```

`--duration` is in minutes (1440 = 24h). `--options` is a comma-separated list;
option indices start at 0 (`Yes` = 0, `No` = 1).

### 2. Cast

Hybrid votes let you **split your weight across options**. `--options` are the
indices you're voting for and `--weights` are the percentages you allocate —
**they must sum to 100.**

```bash
# All-in on option 0
pop vote cast --type hybrid --proposal 0 --options "0" --weights "100"

# Split 70/30 across options 0 and 1
pop vote cast --type hybrid --proposal 0 --options "0,1" --weights "70,30"
```

`--proposal` accepts an ID **or** a fuzzy title query, so
`--proposal "new logo"` works too.

### 3. Announce

After voting ends, announce the winner (this tallies and records the result):

```bash
pop vote announce --type hybrid --proposal 0

# Or sweep every ended proposal at once
pop vote announce-all
```

### 4. Execute

If the winning option carried execution calls (see below), run them:

```bash
pop vote execute --proposal 0
```

## Execution-call proposals

A proposal can do more than signal — it can carry an on-chain **execution
batch** that runs if its option wins. Attach calls to option 0 with `--calls`,
a JSON array of `{target, value, data}` objects:

```bash doc-test=skip
pop vote create --type hybrid --name "Fund the grants pool" \
  --description "Transfer 500 tokens to the grants safe" --duration 1440 \
  --options "Approve,Reject" \
  --calls '[{"target":"0xSAFE","value":"0","data":"0xDATA"}]'
```

**Safety: the confirm summary decodes every call.** Before you sign, the CLI
resolves each call's `target` to a known module name and decodes the function
`selector` against the org's ABIs, so you approve a human-readable action — not
opaque calldata. Calls it can't decode are labelled `UNDECODABLE` rather than
hidden, so nothing is ever silently rubber-stamped. Non-winning options get
empty batches (they do nothing on execution).

Once such a proposal wins and is announced, `pop vote execute --proposal N` runs
the batch.

> Execution targets must be whitelisted. Use
> `pop vote propose-config --key target-allowed --value 0xTARGET` to authorize a
> new target through governance first.

## Restricted (hat-gated) proposals

Limit who may vote on a proposal to specific hat-wearers with `--hat-ids`
(comma-separated):

```bash
pop vote create --type hybrid --name "Council-only: ratify the budget" \
  --description "Steering council ratification" --duration 720 \
  --options "Ratify,Reject" --hat-ids 0xCOUNCIL_HAT
```

The restricted IDs are authority subject IDs. Migrated roles retain their original IDs. DD voting eligibility is configured through `role set-perm --key DD_VOTE --value 1`.

## Reading results

| Command | Shows |
| --- | --- |
| `pop vote list` | Proposals, filterable by `--status Active/Ended/Executed`, `--type`, and `--unvoted` (only ones you haven't voted on). |
| `pop vote results` | Final option names, tallies, and rankings for a proposal. |
| `pop vote analyze` | Deep hybrid breakdown: power per class, plus counterfactuals ("what if class X hadn't voted"). |

```bash
# Find active proposals you still need to vote on (needs your key)
pop vote list --status Active --unvoted

# See who won and by how much
pop vote results --proposal 0

# Understand *why* — per-class power and counterfactuals
pop vote analyze --proposal 0
```

## Where to go next

- [Tasks & Projects guide](tasks.md) — the work proposals often fund
  (`project propose`, `task perms propose-global`).
- [Vote command reference](../reference/cli/vote.md) — every flag.
- [Quickstart](../getting-started/quickstart.md) — the 15-minute tour.
