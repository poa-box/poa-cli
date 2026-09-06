# Wave G: CLI and core 1.0 migration

Version 1.0 removes V1 access support. Current membership, vouching, groups and module permissions come from MembershipAuthority. Organizations are available only when their indexed authority has a nonzero address, `isRouterBound: true` and positive `cutoverAt`. Pausing membership does not retire an organization. Future native V2 organizations satisfy the same condition without a name allowlist.

Kansas Blockchain, Decentral Park, Poa and Test6 retain their organization, module and adopted role IDs. Their earlier V1 tasks, votes, token balances, metadata and member history remain readable. Current member lists use authority membership instead of old User/Hats flags. Unmigrated organizations are excluded from discovery and rejected by name and direct ID. There is no legacy query or transaction fallback for access decisions.

## Command changes

- `role apply`, `role applications`, `role withdraw-application`, `role eligibility`, `role admin`, and `user claim-hats` are removed. Use authority offers, claims, rules, delegated management and finalization through the [membership guide](guides/membership-roles-vouching.md).
- Roles and vouches use `--subject` and `--user`. The subject is a uint256 string; adopted role IDs keep their original value. `group create`, `group add-role` and `group remove-role` manage role unions.
- Governance-only role, vouch and task-permission mutations create executable HybridVoting proposals. `task perms set` now proposes a permission row; `task perms clear` removes it. An explicit zero project row denies that subject's global task grant, while a missing row inherits it. `--inherit-global` combines a project row with the global row. Context is always `projectId + 1`, including project zero.
- Project creation retains `--managers` address lists. The four legacy `--create-hats`, `--claim-hats`, `--review-hats` and `--assign-hats` inputs are removed. Configure authority task permissions after creation. The old seven-argument task-creation fallback and `hat-allowed` voting configuration are removed.
- `user whoami --on-chain` and its Hats membership fallback are removed. An unavailable authority index produces unknown membership rather than a V1 answer.
- Deploy config requires role `open` and supports `maxMembers` and native groups. Legacy `hatConfig`, `defaults`, `hierarchy` and `combineWithHierarchy` are rejected. `taskCreatorRoles` gives project creation and explicitly seeds task CREATE; supplied task masks retain their other bits. Actual deployments require OrgDeployer version 2 before publishing metadata or signing registration. Unsigned `--dry-run --deployer` previews do neither; target compatibility is marked unverified.

Task, batch-task and project dry runs use zero metadata-hash placeholders and do not publish metadata. Existing contracted JSON keys remain unless listed as a removed access surface. Role `hatId` and whoami `hats` keys retain adopted IDs for consumers; `canVote` role metadata is explicitly historical, and current policy is read from the authority.

## SDK changes

`@poa-box/core` 1.0 removes `reads.eligibility`, `tx.eligibility`, the EligibilityModule/ToggleModule ABIs, the role-application metadata builder namespace, QuickJoin claim-hat builders, `parseHatIds`, `checkHasHat`, legacy task encoding fragments and legacy task-permission query/mask fallback exports. Replace them with `reads/authority`, `tx/authority` and `checkSubjectMembership`.

`OrgModules.membershipAuthorityAddress` replaces `eligibilityModuleAddress`. Authority builders expose role/group lifecycle, rules, vouches, delegation and native permission words. Low-level `buildSetProjectRolePerm` targets the executor-only authority selector; the resolved `setProjectRolePermIntent` wraps it in governance. Module constructors and generated ABIs use the current protocol shapes. Review the checked-in API surface diff when updating consumers.

## Upgrade order

1. Complete survivor cutovers and verify their current authority readiness and preserved history in the serving subgraphs.
2. Upgrade the protocol runtime and native OrgDeployer to Wave G using the separately reviewed contract release. Do not publish this CLI against an unupgraded runtime as a compatibility release.
3. Release core 1.0, CLI 1.0 and the coordinated agent package, then deploy the authority-only frontend. Confirm survivor discovery, direct-ID rejection for retired organizations and representative historical reads.

Release verification uses build, unit tests, generated docs/manifest checks, the core API snapshot and read-only live JSON output contracts. This branch does not execute protocol upgrades or publish packages.
