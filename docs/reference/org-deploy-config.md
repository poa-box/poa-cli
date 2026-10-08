# Org Deploy Config Reference

`pop org deploy --config <file>` deploys an entire organization — every module,
in one transaction — from a single JSON file. This page annotates that file
field by field.

Generate a starting point instead of writing it by hand:

```bash
pop org deploy-config --name "My DAO" --username founder --template standard
```

Then edit the emitted `org-deploy-config.json` and deploy:

```bash
pop org deploy --config org-deploy-config.json --dry-run --yes   # validate + unsigned preview; no publishing or signing
pop org deploy --config org-deploy-config.json                   # deploy for real
```

The file maps directly onto the `DeploymentParams` tuple consumed by
`OrgDeployer.deployFullOrg()`. The CLI (`src/commands/org/deploy.ts`) reads
this JSON. A dry run returns an unsigned preview with zero metadata hash and no registration signature; it does not estimate final execution gas. Add `--deployer <address>` to preview without a private key. Real execution pins the org metadata to IPFS, signs the deployer's registration
(EIP-712, no separate tx), assembles the 27-field tuple, and fires the single
on-chain write.

## The full schema

Here is a complete config exercising every block. Required top-level keys are
`orgName`, `roles`, `hybridVoting`, and `roleAssignments`; everything else has
a documented default.

```json doc-test=skip
{
  "orgName": "My DAO",
  "deployerUsername": "founder",
  "description": "A worker-owned organization built on POP",
  "links": [
    {
      "name": "Website",
      "url": "https://example.com"
    },
    {
      "name": "Discord",
      "url": "https://discord.gg/example"
    }
  ],
  "autoUpgrade": true,
  "hybridVoting": {
    "thresholdPct": 51,
    "classes": [
      {
        "strategy": "DIRECT",
        "slicePct": 80,
        "quadratic": false,
        "subjectIds": []
      },
      {
        "strategy": "ERC20_BAL",
        "slicePct": 20,
        "quadratic": true,
        "minBalance": "1",
        "subjectIds": []
      }
    ]
  },
  "directDemocracy": {
    "thresholdPct": 51
  },
  "roles": [
    {
      "name": "Admin",
      "canVote": true,
      "distribution": {
        "mintToDeployer": true
      },
      "open": false,
      "maxMembers": 10
    },
    {
      "name": "Member",
      "canVote": true,
      "vouching": {
        "enabled": true,
        "quorum": 1,
        "voucherRoleIndex": 0
      },
      "distribution": {
        "mintToDeployer": true
      },
      "open": true,
      "maxMembers": 1000
    },
    {
      "name": "Contributor",
      "canVote": false,
      "distribution": {
        "mintToDeployer": false
      },
      "open": false,
      "maxMembers": 1000
    }
  ],
  "roleAssignments": {
    "quickJoinRoles": [
      1
    ],
    "tokenMemberRoles": [
      0,
      1,
      2
    ],
    "tokenApproverRoles": [
      0
    ],
    "taskCreatorRoles": [
      0,
      1
    ],
    "educationCreatorRoles": [
      0
    ],
    "educationMemberRoles": [
      0,
      1,
      2
    ],
    "hybridProposalCreatorRoles": [
      0,
      1
    ],
    "ddVotingRoles": [
      0,
      1
    ],
    "ddCreatorRoles": [
      0,
      1
    ]
  },
  "metadataAdminRoleIndex": 0,
  "educationHub": {
    "enabled": true
  },
  "taskManagerPerms": {
    "roleIndices": [
      0,
      1
    ],
    "masks": [
      255,
      2
    ]
  },
  "paymaster": {
    "operatorRoleIndex": 0,
    "maxFeePerGas": "2",
    "maxPriorityFeePerGas": "1",
    "defaultBudgetCapPerEpoch": "0.05",
    "defaultBudgetEpochLen": 86400,
    "funding": "0.1"
  },
  "groups": [
    {
      "name": "Operations",
      "memberRoleIndices": [
        0,
        2
      ]
    }
  ]
}
```

## Top-level fields

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `orgName` | string | **yes** | — | Display name. Also derives the on-chain `orgId` = `keccak256(name.toLowerCase().replace(/\s+/g,'-'))`. |
| `deployerUsername` | string | no | normalized `orgName` | Username registered for the deployer during deploy (EIP-712 signed, not a separate tx). |
| `description` | string | no | `""` | Org description; pinned to IPFS as part of the metadata blob. |
| `links` | `{name,url}[]` | no | `[]` | Social/website links; each gets an `index` and is pinned with the metadata. |
| `autoUpgrade` | boolean | no | `true` | If true, org module proxies follow the protocol's `SwitchableBeacon` and pick up new implementations automatically. If false, beacons are pinned to the deploy-time implementation. See `pop org status` for the live per-module view. |

## `hybridVoting` — N-class hybrid voting

Hybrid voting composes **N voting classes**; the winning option is decided
across all of them. This is the v6 `ClassConfig[]` shape.

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `thresholdPct` | number (uint8) | **yes** | — | Support percentage an option needs to win (e.g. `51`). Separate from quorum. |
| `classes` | `ClassConfig[]` | **yes** | — | One entry per voting class. `slicePct` values across all classes **must sum to 100**. |

### `ClassConfig` (each entry in `classes`)

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `strategy` | `"DIRECT"` \| `"ERC20_BAL"` | **yes** | — | `DIRECT` = one member, 100 points (democratic). `ERC20_BAL` = weight by participation-token balance. |
| `slicePct` | number (uint8, 0–100) | **yes** | — | This class's share of total voting weight. All slices sum to 100. |
| `quadratic` | boolean | no | `false` | Apply quadratic scaling to this class's weights (dampens whales). |
| `minBalance` | string | no | `"0"` | Minimum PT balance to participate in an `ERC20_BAL` class (human units; parsed at 18 decimals). |
| `asset` | address | no | zero address | Token address for the balance snapshot. Defaults to the org's participation token. |
| `subjectIds` | string[] | no | `[]` | Authority subject IDs as decimal strings; empty uses the deployer's default electorate. |

The classic "80/20" org is a `DIRECT` class at `slicePct: 80` plus an
`ERC20_BAL` class at `slicePct: 20` — 80% democratic, 20% earned-influence.

Optional `hybridVoting.quorum` sets the uint32 minimum voter count (default `0`).
Optional `token: {name, symbol}` sets participation-token metadata. Empty values use protocol defaults.

## `directDemocracy`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `thresholdPct` | number (uint8) | no | `51` | Support percentage for the pure 1-member-1-vote track (no PT weighting). |

`directDemocracy.quorum` is the uint32 minimum voter count for polls (default `0`).

## `roles` — authority role subjects

The `roles` array contains 1–16 roles. Indices in role assignments, vouching, metadata administration,
task grants and paymaster settings always reference this array.

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Human-readable role name. |
| `canVote` | yes | Include this role in the default hybrid electorate. |
| `open` | yes | `true` permits anyone to claim; `false` requires a grant, vouch quorum or email verification. |
| `maxMembers` | no | Member cap; `0` (default) means unlimited. Must fit all initial wearers. |
| `image`, `metadataCID` | no | Image URI and bytes32 extended metadata digest. |
| `vouching` | no | `{enabled, quorum, voucherRoleIndex}`. An enabled attestor needs a positive uint32 quorum and a valid voucher role index. |
| `distribution` | no | `{mintToDeployer, additionalWearers}`. Defaults to seeding the deployer. Seeded memberships include an explicit grant. |

Use `open: false` for vouch-gated entry: an open role is already claimable without vouches.
Legacy `hatConfig`, `defaults`, `hierarchy`, and `combineWithHierarchy` fields are rejected.

## `groups` — derived membership

Optional array of at most 8 `{name, memberRoleIndices}` entries. Each group requires 1–16 unique,
valid role indices; it derives membership from those roles and has no acceptance token of its own.
Role-assignment bitmaps reference roles, not groups.

## `roleAssignments` — permission bitmaps

Each key is a **list of role indices** that the deployer converts into a
bitmap. QuickJoin roles must have `open: true`. These wire roles to org-wide capabilities. Every list references the
`roles` array by index.

| Field | Required | Grants |
|---|---|---|
| `quickJoinRoles` | **yes** | Roles auto-granted when a new user joins via QuickJoin. |
| `tokenMemberRoles` | **yes** | Roles counted as PT "members" (can request tokens / receive distributions). |
| `tokenApproverRoles` | **yes** | Roles that may approve participation-token requests (mints PT). |
| `taskCreatorRoles` | **yes** | Roles allowed to create tasks/projects. |
| `educationCreatorRoles` | no | Roles allowed to create education modules. |
| `educationMemberRoles` | no | Roles allowed to complete modules and earn PT. |
| `hybridProposalCreatorRoles` | **yes** | Roles allowed to create hybrid proposals. |
| `ddVotingRoles` | **yes** | Roles allowed to vote in direct democracy. |
| `ddCreatorRoles` | **yes** | Roles allowed to create direct-democracy proposals. |

## `taskManagerPerms` — v6 org-wide task permissions

Optional. Grants org-wide TaskManager permission masks at deploy time
(`OrgDeployer.TaskManagerPermConfig`). `roleIndices` resolve to hat IDs;
`masks` are **TaskPerm bitmasks** applied globally (not per-project). The two
arrays **must be the same length** — the CLI rejects a mismatch with exit `1`.

| Field | Type | Meaning |
|---|---|---|
| `roleIndices` | number[] | Role indices whose global task mask to set. |
| `masks` | number[] | The TaskPerm bitmask for each corresponding role. |

### TaskPerm bitmask (uint8)

Masks are the OR of these bits:

| Bit | Value | Permission |
|---|---|---|
| CREATE | 1 | Create tasks. |
| CLAIM | 2 | Claim tasks. |
| REVIEW | 4 | Approve/reject submissions. |
| ASSIGN | 8 | Assign tasks to users. |
| SELF_REVIEW | 16 | Review your own submission. |
| BUDGET | 32 | Manage project budgets. |
| EDIT_META | 64 | Edit task title/description (post-claim safe). |
| EDIT_FULL | 128 | Edit all task fields (payout, deadlines, bounty). |

Examples: `2` = CLAIM only; `1 | 2 = 3` = create + claim; `255` = all eight
bits (full task authority). In the schema above, role 0 (Admin) gets `255` and
role 1 (Member) gets `2` (claim only).

After deploy, inspect and change these:

```bash
pop task perms show                                  # global + per-project masks
pop task perms set --project 0 --subject <id> --perms claim,review   # per-project override
pop task perms propose-global --subject <id> --perms create,claim    # org-wide via governance
```

See [tasks.md](../guides/tasks.md) for the full permission model.

## `metadataAdminRoleIndex`

| Type | Default | Meaning |
|---|---|---|
| number | max uint (none) | Role index allowed to edit org metadata directly (via `pop org update-metadata`). If unset, only the org top hat / governance can. Change it later with `pop org set-metadata-admin`. |

## `educationHub`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Deploy the EducationHub module (learning modules that mint PT). See [education.md](../guides/education.md). |

## `paymaster` — gas sponsorship

Optional. Omitting the block **disables** the paymaster at deploy
(`operatorRoleIndex` is set to max uint internally). Include it to bootstrap
ERC-4337 gas sponsorship so members transact without holding gas.

| Field | Type | Required (if block present) | Meaning |
|---|---|---|---|
| `operatorRoleIndex` | number | **yes** | Role index allowed to manage sponsorship budgets/rules. |
| `maxFeePerGas` | string (gwei) | **yes** | Fee cap for sponsored UserOps. |
| `maxPriorityFeePerGas` | string (gwei) | **yes** | Priority-fee cap for sponsored UserOps. |
| `defaultBudgetCapPerEpoch` | string (ether) | **yes** | Default per-epoch sponsorship budget, in the native gas token. |
| `defaultBudgetEpochLen` | number (seconds) | **yes** | Epoch length for the budget window (e.g. `86400` = 1 day). |
| `funding` | string (ether) | no | If set, the deploy transaction also sends this much native token to fund the paymaster (added to the pre-flight gas check). |

Gas limits (`maxCallGas`, `maxVerificationGas`, `maxPreVerificationGas`) and
`autoWhitelistContracts` are set to sane defaults by the CLI and are not
config-exposed. After deploy, manage sponsorship with `pop paymaster status`,
`pop paymaster register`, and `pop paymaster deposit` — see
[gas-sponsorship.md](../guides/gas-sponsorship.md).

## Quorum vs threshold

The deploy config sets **`thresholdPct`** (the support % an option needs to
win). It does **not** set **quorum** — quorum is a minimum *voter count*
(`0` = disabled), separate from threshold, and is changed post-deploy through
governance:

```bash
pop vote propose-quorum --quorum 5      # require ≥5 distinct voters
pop vote propose-config --key threshold --value 60   # raise support threshold to 60%
```

See [voting.md](../guides/voting.md) for the quorum/threshold model in full.

## The `DeploymentParams` tuple

For reference, the CLI assembles this 27-field tuple (order is ABI-significant;
verified against `src/abi/OrgDeployerNew.json` + contracts `OrgDeployer.sol`):

`orgId`, `orgName`, `metadataHash`, `registryAddr`, `deployerAddress`,
`deployerUsername`, `regDeadline`, `regNonce`, `regSignature`, `autoUpgrade`,
`hybridThresholdPct`, `ddThresholdPct`, `hybridClasses`, `ddInitialTargets`,
`roles`, `groups`, `roleAssignments`, `metadataAdminRoleIndex`, `passkeyEnabled`,
`educationHubConfig`, `bootstrap`, `paymasterConfig`, `taskManagerPerms`,
`hybridQuorum`, `ddQuorum`, `tokenName`, `tokenSymbol`.

Most of these are derived by the CLI (IDs, hashes, the registration signature,
the passkey/bootstrap defaults); the config file above supplies the rest.

## Related

- [getting-started/deploy-an-org.md](../getting-started/deploy-an-org.md) — deployment walkthrough.
- [guides/org-admin.md](../guides/org-admin.md) — running the org after deploy (metadata, upgrades, audits).
- [reference/errors-and-exit-codes.md](errors-and-exit-codes.md) — what a failed deploy reports.
