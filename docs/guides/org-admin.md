# Org Administration

Once your org is deployed, this guide covers the day-two operator surface:
editing org metadata, keeping modules up to date, and the read-only tooling for
auditing health — yours and any other POP org.

## Prerequisites

- A deployed org (see [getting-started/deploy-an-org.md](../getting-started/deploy-an-org.md)).
- For metadata edits: the metadata-admin hat (or governance).
- Configuration set: [getting-started/configuration.md](../getting-started/configuration.md).

## Org metadata

The org's name, description, links, logo, and display flags live in an IPFS
metadata blob referenced on-chain. Two commands manage it.

### Edit metadata directly

If your hat is the org's metadata admin (set via `metadataAdminRoleIndex` at
deploy, or changed later — see below), you can edit metadata without a vote:

```bash
pop org update-metadata --description "A worker-owned research collective"
pop org update-metadata --name "New Name" --logo ./logo.png \
  --links '[{"name":"Website","url":"https://example.com"}]'
```

Available fields: `--name`, `--description`, `--logo` (path to an image file),
`--links` (JSON array of `{name,url}`), `--background-color`, `--hide-treasury`.

> Metadata JSON key order must match the frontend exactly for subgraph/UI
> compatibility — the CLI handles this for you, so prefer these commands over
> hand-crafting the blob.

### Change who can edit metadata

The metadata-admin hat itself is changed through governance:

```bash
pop org set-metadata-admin --hat <hat-id>     # 0 = clear (top-hat fallback applies)
```

This opens a governance proposal (default 60-minute vote). Vote and announce it
like any other proposal — see [voting.md](voting.md).

## Module versions & upgrades

POP orgs are built from upgradeable module proxies behind the protocol's
`SwitchableBeacon`. Each org chooses, per module, whether to **auto-upgrade**
(follow the protocol's latest implementation) or **pin** to the implementation
it deployed with.

`pop org status` includes a **version panel** that, for every module, compares
the deployed proxy's implementation against the protocol's current
implementation for that module type and shows the auto-upgrade state:

```bash
pop org status            # health summary + per-module version panel
pop org status --fast     # skip the on-chain version check (subgraph summary only)
```

Each row reports the module (TaskManager, HybridVoting, DirectDemocracyVoting,
ParticipationToken, EducationHub, PaymentManager, QuickJoin, EligibilityModule),
whether it is on the latest implementation, and — when it's behind — whether
`autoUpgrade` is on or the beacon is pinned. The panel is best-effort: any
RPC/subgraph hiccup degrades it to a one-line note, and `--fast` skips it.

The org-wide `autoUpgrade` default is set at deploy time
(`autoUpgrade` in the [deploy config](../reference/org-deploy-config.md)).

## Roles, members, and activity

Read-only views of the org's people and recent changes:

```bash
pop org roles      # roles with hat IDs and vouch requirements
pop org members    # members with activity metrics
pop org view       # full org details
pop org activity --since <unix-ts>   # recent changes (the agent heartbeat feed)
```

For managing role permissions and vouching, see
[membership-roles-vouching.md](membership-roles-vouching.md).

## Audit & health tooling (read-only)

POP ships a broad suite of **read-only** governance analytics. None of these
send transactions — they read on-chain + subgraph data and (optionally) pin a
report to IPFS. Use them to monitor your own org or to benchmark against others.

### Your own org

| Command | Produces |
|---|---|
| `pop org audit` | Governance transparency report for your org. |
| `pop org health-score` | A single 0–100 health metric. |
| `pop org members` | Per-member activity and standing. |
| `pop config validate` | RPC + subgraph connectivity check (run before acting). |

```bash
pop org health-score
pop org audit
```

### Any POP org (external)

| Command | Produces |
|---|---|
| `pop org explore` | Scan every POP org across chains. |
| `pop org audit-external --target <name>` | Full audit of any named POP org. |
| `pop org audit-all` | Ecosystem-wide health report across all POP orgs. |
| `pop org leaderboard --spaces <ids>` | Rank multiple DAOs by governance health. |
| `pop org compare --a <space> --b <space>` | Head-to-head comparison of two Snapshot DAOs. |

```bash
pop org explore
pop org audit-external --target some-other-dao
pop org audit-all
```

Add `--pin` to publish a report to IPFS where the command supports it
(`audit-external`, `audit-all`, `leaderboard`, …). The `org` domain also
includes auditors for non-POP governance (Snapshot, Safe, on-chain Governors);
see [reference/cli/org.md](../reference/cli/org.md) for the complete list of 30+
subcommands.

## Related

- [reference/org-deploy-config.md](../reference/org-deploy-config.md) — the deploy config every setting above traces back to.
- [guides/membership-roles-vouching.md](membership-roles-vouching.md) — roles, task permissions, vouching.
- [guides/gas-sponsorship.md](gas-sponsorship.md) — keeping members' transactions free.
- [reference/errors-and-exit-codes.md](../reference/errors-and-exit-codes.md) — what admin commands report on failure.
