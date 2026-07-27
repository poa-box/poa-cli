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
pop org deploy --config org-deploy-config.json --dry-run --yes   # validate + estimate, no tx
pop org deploy --config org-deploy-config.json                   # deploy for real
```

The file maps directly onto the `DeploymentParams` tuple consumed by
`OrgDeployer.deployFullOrg()`. The CLI (`src/commands/org/deploy.ts`) reads
this JSON, pins the org metadata to IPFS, signs the deployer's registration
(EIP-712, no separate tx), assembles the 22-field tuple, and fires the single
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
    { "name": "Website", "url": "https://example.com" },
    { "name": "Discord", "url": "https://discord.gg/example" }
  ],
  "autoUpgrade": true,

  "hybridVoting": {
    "thresholdPct": 51,
    "classes": [
      { "strategy": "DIRECT",    "slicePct": 80, "quadratic": false, "hatIds": [] },
      { "strategy": "ERC20_BAL", "slicePct": 20, "quadratic": true,  "minBalance": "1", "hatIds": [] }
    ]
  },
  "directDemocracy": { "thresholdPct": 51 },

  "roles": [
    {
      "name": "Admin",
      "canVote": true,
      "defaults": { "eligible": true, "standing": true },
      "distribution": { "mintToDeployer": true },
      "hatConfig": { "maxSupply": 10, "mutableHat": true }
    },
    {
      "name": "Member",
      "canVote": true,
      "vouching": { "enabled": true, "quorum": 1, "voucherRoleIndex": 0 },
      "defaults": { "eligible": true, "standing": true },
      "distribution": { "mintToDeployer": true },
      "hatConfig": { "maxSupply": 1000, "mutableHat": true }
    },
    {
      "name": "Contributor",
      "canVote": false,
      "defaults": { "eligible": true, "standing": true },
      "distribution": { "mintToDeployer": false },
      "hatConfig": { "maxSupply": 1000, "mutableHat": true }
    }
  ],

  "roleAssignments": {
    "quickJoinRoles": [1],
    "tokenMemberRoles": [0, 1, 2],
    "tokenApproverRoles": [0],
    "taskCreatorRoles": [0, 1],
    "educationCreatorRoles": [0],
    "educationMemberRoles": [0, 1, 2],
    "hybridProposalCreatorRoles": [0, 1],
    "ddVotingRoles": [0, 1],
    "ddCreatorRoles": [0, 1]
  },

  "metadataAdminRoleIndex": 0,
  "educationHub": { "enabled": true },

  "taskManagerPerms": {
    "roleIndices": [0, 1],
    "masks": [255, 2]
  },

  "paymaster": {
    "operatorRoleIndex": 0,
    "maxFeePerGas": "2",
    "maxPriorityFeePerGas": "1",
    "defaultBudgetCapPerEpoch": "0.05",
    "defaultBudgetEpochLen": 86400,
    "funding": "0.1"
  }
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
| `hatIds` | number[] | no | `[]` | Restrict this class to wearers of these hats (empty = no hat gate). |

The classic "80/20" org is a `DIRECT` class at `slicePct: 80` plus an
`ERC20_BAL` class at `slicePct: 20` — 80% democratic, 20% earned-influence.

## `directDemocracy`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `thresholdPct` | number (uint8) | no | `51` | Support percentage for the pure 1-member-1-vote track (no PT weighting). |

## `roles` — hats

Each role becomes a **hat** (Hats Protocol). Order matters: a role's index
(0-based) is how `roleAssignments`, `taskManagerPerms`, `metadataAdminRoleIndex`,
`paymaster.operatorRoleIndex`, and each role's `vouching.voucherRoleIndex` /
`hierarchy.adminRoleIndex` refer to it.

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `name` | string | **yes** | — | Role/hat name (stored as hat details). |
| `image` | string | no | `""` | Hat image URI. |
| `canVote` | boolean | **yes** | — | Whether wearers may vote in hybrid governance. |
| `vouching` | object | no | disabled | Vouch-gated entry for this role (see below). |
| `defaults` | `{eligible,standing}` | no | `{true,true}` | Default eligibility + good-standing for wearers. |
| `hierarchy` | `{adminRoleIndex}` | no | none | Role index that administers this hat (its admin hat). |
| `distribution` | object | no | `{mintToDeployer:true}` | Who receives the hat at deploy time. |
| `hatConfig` | `{maxSupply,mutableHat}` | no | `{4294967295,true}` | Max simultaneous wearers (uint32) and whether the hat's properties can change later. |

### `roles[].vouching`

Turns a role into a vouch-gated membership: candidates accumulate vouches until
they hit `quorum`, then claim the hat (`pop vouch claim`). See
[membership-roles-vouching.md](../guides/membership-roles-vouching.md).

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `enabled` | boolean | **yes** | — | Enable vouch-gated entry for this role. |
| `quorum` | number (uint32) | **yes** | — | Vouches required before the hat is claimable. |
| `voucherRoleIndex` | number | **yes** | max uint (none) | Role index whose wearers are allowed to vouch for this role. |
| `combineWithHierarchy` | boolean | no | `false` | Also honor hierarchy eligibility and let hat admins vouch. |

### `roles[].distribution`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `mintToDeployer` | boolean | no | `true` | Mint this hat to the deployer at deploy time. |
| `additionalWearers` | address[] | no | `[]` | Extra addresses to mint the hat to immediately. |

## `roleAssignments` — permission bitmaps

Each key is a **list of role indices** that the deployer converts into a
bitmap. These wire roles to org-wide capabilities. Every list references the
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
pop task perms set --project 0 --hat <id> --perms claim,review   # per-project override
pop task perms propose-global --hat <id> --perms create,claim    # org-wide via governance
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

For reference, the CLI assembles this 22-field tuple (order is ABI-significant;
verified against `src/abi/OrgDeployerNew.json` + contracts `OrgDeployer.sol`):

`orgId`, `orgName`, `metadataHash`, `registryAddr`, `deployerAddress`,
`deployerUsername`, `regDeadline`, `regNonce`, `regSignature`, `autoUpgrade`,
`hybridThresholdPct`, `ddThresholdPct`, `hybridClasses`, `ddInitialTargets`,
`roles`, `roleAssignments`, `metadataAdminRoleIndex`, `passkeyEnabled`,
`educationHubConfig`, `bootstrap`, `paymasterConfig`, `taskManagerPerms`.

Most of these are derived by the CLI (IDs, hashes, the registration signature,
the passkey/bootstrap defaults); the config file above supplies the rest.

## Related

- [getting-started/deploy-an-org.md](../getting-started/deploy-an-org.md) — deployment walkthrough.
- [guides/org-admin.md](../guides/org-admin.md) — running the org after deploy (metadata, upgrades, audits).
- [reference/errors-and-exit-codes.md](errors-and-exit-codes.md) — what a failed deploy reports.
