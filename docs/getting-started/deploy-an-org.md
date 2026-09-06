# Deploy a Worker-Owned Organization

Stand up your own Perpetual Organization — governance, tasks, treasury,
membership, and gas sponsorship — from a single config file. This takes about
15 minutes.

If you just want to *join* an org and start earning, do the
[quickstart](quickstart.md) instead. This guide is for founders.

## What gets deployed

`pop org deploy` deploys a full org from one JSON config. In one shot you get:

| Module | What it does |
| --- | --- |
| **Executor** | The org's on-chain "hands" — governance-approved calls run through it. |
| **MembershipAuthority** | Role and group subjects, membership, vouching and permissions. |
| **HybridVoting** | Multi-class governance (direct democracy + token-weighted). |
| **DirectDemocracy** | One-person-one-vote track for membership-level decisions. |
| **Participation Token (PT)** | Non-transferable token minted for work; also voting weight. |
| **TaskManager** | Projects, tasks, claims, reviews, deadlines, bounties. |
| **EducationHub** | Optional quiz-based learning modules that reward PT. |
| **Paymaster** (optional) | ERC-4337 gas sponsorship so members transact for free. |

Everything is wired together and byte-identical to what the POP web frontend
produces, so your org renders correctly in the UI.

## Prerequisites

- The [CLI installed and configured](quickstart.md#install) (`pop init` done).
- Your deployer wallet funded with native gas on the target chain (Gnosis `100`
  or Arbitrum `42161` for mainnet; ~0.5 xDAI is comfortable).
- A username for yourself (you can register it after deploy).

---

## Step 1 — Generate a deploy config

Scaffold a config with sensible defaults:

```bash
pop org deploy-config --name "My DAO" --username founder
```

This writes `org-deploy-config.json`. Use `--template minimal` for the leanest
viable org, or `--template standard` (the default) for the full set of modules.
Point it elsewhere with `--output`:

```bash
pop org deploy-config --name "My DAO" --username founder --template minimal --output my-org.json
```

**Review this file before deploying — it is your org's constitution.** See
[`examples/org-deploy-config.json`](../../examples/org-deploy-config.json) for a
complete annotated example and the
[deploy-config reference](../reference/org-deploy-config.md) for every field.

### The parts that matter most

**Roles** — each entry becomes an authority role subject. `canVote` selects the default hybrid electorate; `open` controls permissionless claiming and `maxMembers` caps membership (`0` means unlimited);
`distribution.mintToDeployer` mints it to you at deploy time so you can bootstrap.

```json
"roles": [
  { "name": "Admin",       "canVote": true, "open": false,  "distribution": { "mintToDeployer": true } },
  { "name": "Member",      "canVote": true, "open": false,  "distribution": { "mintToDeployer": true } },
  { "name": "Contributor", "canVote": false, "open": false, "distribution": { "mintToDeployer": false } }
]
```

**Role assignments** — bitmap-style permission grants that reference roles *by
index* into the `roles` array. For example `"taskCreatorRoles": [0, 1]` means the
roles at index 0 (Admin) and 1 (Member) may create tasks; `"quickJoinRoles": [1]`
means new members join straight into the Member role; set that role to `open: true`.

| Assignment | Grants |
| --- | --- |
| `quickJoinRoles` | Roles new members receive via QuickJoin. |
| `tokenMemberRoles` | Roles that hold/earn participation tokens. |
| `tokenApproverRoles` | Roles that can approve token requests (mint PT). |
| `taskCreatorRoles` | Roles that can create tasks. |
| `educationCreatorRoles` / `educationMemberRoles` | Who can author modules / who can complete them. |
| `hybridProposalCreatorRoles` | Roles that can open hybrid proposals. |
| `ddVotingRoles` / `ddCreatorRoles` | Who votes / creates in direct democracy. |

**Voting classes** — `hybridVoting.classes` is an array of weighted classes that
sum to 100% of the vote. Each class picks a `strategy`:

| Field | Meaning |
| --- | --- |
| `strategy: "DIRECT"` | One member, 100 points — pure democracy. |
| `strategy: "ERC20_BAL"` | Token-weighted by PT (or another asset) balance. |
| `slicePct` | This class's share of the total vote (all slices sum to 100). |
| `quadratic` | Optional: dampen large balances via quadratic weighting. |
| `minBalance` | Minimum balance to participate in an `ERC20_BAL` class. |
| `subjectIds` | Optional authority subject IDs as decimal strings. |

The default 50/50 split (one DIRECT class + one ERC20_BAL class) means half the
power is one-person-one-vote and half is PT-weighted. `thresholdPct` (e.g. `51`)
is the **support percentage** a winning option needs — this is separate from
**quorum**, which is a minimum *voter count* set later via governance.

---

## Step 2 — Deploy

Point `pop org deploy` at your config. Add `--dry-run` first to simulate and
catch config errors before spending gas:

```bash
pop org deploy --config org-deploy-config.json --dry-run --deployer 0xYourAddress
```

The preview publishes no metadata, signs no registration, and sends no transaction. Its zero metadata hash and omitted registration are placeholders; final execution gas is estimated during the real run.

When it looks right, deploy for real:

```bash
pop org deploy --config org-deploy-config.json --chain 100
```

Deployment takes a couple of minutes and emits the org ID and explorer links.
Expected (abridged):

```text
✓ Organization deployed
  Org ID:   0x...
  Explorer: https://gnosisscan.io/tx/0x...
```

Save the org ID as your default so you can drop `--org` from here on:

```bash
pop init --org "My DAO" --chain 100 --force
```

(Or add `POP_DEFAULT_ORG=My DAO` to your `.env` by hand — see
[configuration.md](configuration.md).)

---

## Step 3 — Verify

```bash
pop org status
pop org roles
```

`org status` is a quick health summary (modules, member count, treasury).
`org roles` lists each role with its **subject ID** and vouch requirements — you'll
need those subject IDs to onboard people and grant permissions.

Register your own username if you haven't:

```bash
pop user register --username founder
```

---

## Step 4 — Fund gas sponsorship (optional)

If you enabled a paymaster, members can transact for free once the org's
sponsorship balance is funded. Check the current state:

```bash
pop paymaster status
```

If the org isn't registered with the PaymasterHub yet, register it (the
`--admin-hat` is usually your org top hat, from `pop org roles`):

```bash
pop paymaster register --admin-hat <top-hat-id> --deposit 0.05
```

Top up the balance any time — this is permissionless and one-way (no withdraw):

```bash
pop paymaster deposit --amount 0.05
```

For the full ERC-4337 / EIP-7702 sponsorship setup (fee caps, per-hat budgets),
see the [paymaster reference](../reference/cli/paymaster.md).

---

## Step 5 — Create your first project and task

Tasks live under projects. Create a project directly (your role has the required authority permissions)
or propose one through governance:

```bash
# Direct — if your role has the create permission
pop project create --name "Getting Started" --cap 100 --description "Bootstrap tasks"

# Or via a governance vote
pop project propose --name "Getting Started" --description "Bootstrap tasks" --duration 60
```

Then create a task in it (use the project ID from `pop project list`):

```bash
pop task create --project 0 --name "Write ABOUT.md" \
  --description "Describe what this org does" --payout 10
```

From here the org runs itself: members claim tasks, submit work, reviewers
approve, PT is minted, and holders vote. Walk that loop end-to-end in the
[quickstart](quickstart.md).

---

## Onboard members

Add people so ownership actually spreads.

**Open membership (QuickJoin):** if a role is in `quickJoinRoles`, anyone can
join directly:

```bash
pop user join --org "My DAO"
```

**Vouch-gated membership:** an existing member vouches for a newcomer; once
enough vouches accumulate (the quorum), the newcomer *claims* the hat (it is not
auto-minted). Vouches are rate-limited (default 3/day) with a short grace period
for brand-new users.

```bash
# You vouch (find the hat ID via `pop org roles`)
pop vouch for --user 0xNEW_MEMBER --subject <role-hat-id>

# Track progress toward quorum
pop vouch status --subject <role-hat-id> --user 0xNEW_MEMBER

# The new member claims the role once quorum is met
pop vouch claim --subject <role-hat-id>
```

Configure or inspect a hat's vouching rules (quorum, membership hat) with
`pop vouch config show --subject <id>`. For patterns and trade-offs, see
[governance templates](../guides/governance-templates.md).

---

## Manage the treasury

Deposit funds, then distribute rewards to members by PT via a merkle
distribution:

```bash
# Fund the treasury with an ERC-20
pop treasury deposit --token 0xTOKEN --amount 1000

# Compute a PT-weighted merkle distribution
pop treasury compute-merkle --amount 40 --token 0xTOKEN --output merkle-distribution.json

# Propose it (governance), then after it passes members claim their share
pop treasury propose-distribution --merkle-file merkle-distribution.json
pop treasury claim-mine
```

Full treasury pipeline (swaps, sDAI yield, finalizing unclaimed funds) is in the
[treasury reference](../reference/cli/treasury.md).

---

## Next steps

- [Configuration reference](configuration.md) — env, chains, output modes, exit codes.
- [Deploy-config reference](../reference/org-deploy-config.md) — every config field.
- [Governance templates](../guides/governance-templates.md) — voting classes, quorum, roles.
- [CLI reference](../reference/cli/index.md) — every command and flag.
- [Run an AI agent](../../packages/agent/docs/agents/running-an-agent.md) — add an autonomous contributor.
