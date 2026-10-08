# Wave G: core, CLI and agent 1.0 migration

Version 1.0 removes V1 access support. Current membership, vouching, groups and module permissions come from MembershipAuthority. Organizations are available only when their indexed authority has a nonzero address, `isRouterBound: true` and positive `cutoverAt`. Pausing membership does not retire an organization. Future native V2 organizations satisfy the same condition without a name allowlist.

Kansas Blockchain, Decentral Park, Poa and Test6 retain their organization, module and adopted role IDs. Their earlier V1 tasks, votes, token balances, metadata and member history remain readable. Current member lists use authority membership instead of old User/Hats flags. Unmigrated organizations are excluded from discovery and rejected by name and direct ID. There is no legacy query or transaction fallback for access decisions.

## Command changes

- `role apply`, `role applications`, `role withdraw-application`, `role eligibility`, `role admin`, and `user claim-hats` are removed. Use authority offers, claims, rules, delegated management and finalization through the [membership guide](guides/membership-roles-vouching.md).
- Roles and vouches use `--subject` and `--user`. The subject is a uint256 string; adopted role IDs keep their original value. `group create`, `group add-role` and `group remove-role` manage role unions.
- Governance-only role, vouch and task-permission mutations create executable HybridVoting proposals. `task perms set` now proposes a permission row; `task perms clear` removes it. An explicit zero project row denies that subject's global task grant, while a missing row inherits it. `--inherit-global` combines a project row with the global row. Context is always `projectId + 1`, including project zero.
- Project creation retains `--managers` address lists. The four legacy `--create-hats`, `--claim-hats`, `--review-hats` and `--assign-hats` inputs are removed. Configure authority task permissions after creation. The old seven-argument task-creation fallback and `hat-allowed` voting configuration are removed.
- `user whoami --on-chain` and its Hats membership fallback are removed. An unavailable authority index produces unknown membership rather than a V1 answer.
- Deploy config requires role `open` and supports `maxMembers` and native groups. Legacy `hatConfig`, `defaults`, `hierarchy` and `combineWithHierarchy` are rejected. `taskCreatorRoles` gives project creation and explicitly seeds task CREATE; supplied task masks retain their other bits. Actual deployments require OrgDeployer version 2 before publishing metadata or signing registration. Unsigned `--dry-run --deployer` previews do neither; target compatibility is marked unverified.

Task and project dry runs use local metadata-hash placeholders and do not publish metadata. Existing contracted JSON keys remain unless listed as a removed access surface. Role `hatId` and whoami `hats` keys retain adopted IDs for consumers; `canVote` role metadata is explicitly historical, and current policy is read from the authority.

Member and role wearer lists exclude the org executor and retired eligibility contract by address, matching indexed User identity rules. Historical user metrics are cursor-paginated independently of authority memberships, so larger organizations retain earlier balances, task/vote totals and join timestamps. Genuine authority wallet members without an indexed User remain visible with `historyIndexed: false`; their member/wearer metrics are `null` and their original join date is unknown. Aggregate reports are incomplete while those histories are unavailable. Low-level `projectAuthorityUsers` callers must supply those system addresses and complete history themselves; `readAuthorityUsers` resolves both automatically.

## SDK changes

`@poa-box/core` 1.0 removes `reads.eligibility`, `tx.eligibility`, the EligibilityModule/ToggleModule ABIs, the role-application metadata builder namespace, QuickJoin claim-hat builders, `parseHatIds`, `checkHasHat`, legacy task encoding fragments and legacy task-permission query/mask fallback exports. Replace them with `reads/authority`, `tx/authority` and `checkSubjectMembership`.

`OrgModules.membershipAuthorityAddress` replaces `eligibilityModuleAddress`. Authority builders expose role/group lifecycle, rules, vouches, delegation and native permission words. Low-level `buildSetProjectRolePerm` targets the executor-only authority selector; the resolved `setProjectRolePermIntent` wraps it in governance. Module constructors and generated ABIs use the current protocol shapes. Review the checked-in API surface diff when updating consumers.

## Verified source and additional parity checks

This CLI tracks [POP PR #193](https://github.com/poa-box/POP/pull/193), merged as
`fa37b3e7341c9225bdc1ab6a9ba94ee41a876c8d`. The pending CLI migration from
[PR #35](https://github.com/poa-box/poa-cli/pull/35) is incorporated and checked
against that merged contract source.

The ABI sync uses the production Foundry profile and canonical recursive tuple
signatures. This preserves both PaymasterHub `registerAndConfigureOrg` overloads;
using the string `tuple` alone had silently dropped one. AuthorityRouter and
CutoverVerifier are included for decoding and inspection. ABI updates are validated
before any output is written, and library events/errors are included for receipt
and revert decoding.

Additional CLI support includes role/group status, pending delegated actions,
current-authority SDK and agent membership, restricted proposal quorum overrides,
equal-weight hybrid polls, and stable class-subject bindings. Deployment and project
inputs are validated before publishing metadata. Agent setup requires an explicit
organization instead of defaulting to retired Argus.

The production subgraphs currently omit V2 per-proposal quorum/equal-weight
configuration and stable class-subject bindings. Voting output identifies these
values as unknown, preserves the current-global quorum separately and avoids
substituting an organization's classes for a potentially synthetic restricted
proposal snapshot. Indexing these fields requires a companion subgraph update;
this CLI update does not deploy a subgraph.

The companion subgraph changes were reviewed through
[subgraph-pop PR #214](https://github.com/poa-box/subgraph-pop/pull/214), commit
`4956ed91cea4606ce646c60cf5a59527a6471630`, including authority indexing, native
deployments, immutable task submissions and protection against stale legacy events.
Current eligibility is projected from the latest indexed rules, defaults and vouch
epoch rather than trusting an unaccepted membership's cached result. Historical
membership and task records remain available.

`task view` exposes immutable submissions and their linked rejection history when
indexed, including submissions that a later rejection removed from the mutable task
pointer. Shared project/task reads paginate fully; metadata writes fetch the task
directly so older tasks are not lost behind a page limit. Voting reads paginate
ballots and select the exact class-change record when available. `vote results`
reports an announced valid winner separately from the raw ballot-allocation leader;
`vote analyze` normalizes each class independently before applying its slice, and
labels quorum/validity as unevaluated.

## Upgrade order

The protocol, subgraphs and authority-only frontend are already deployed. Do not
rerun the one-off Wave G upgrade ceremony; its version and deployment slots are
occupied. The remaining release is core 1.0, CLI 1.0 and the coordinated agent
package. Verify survivor discovery, retired direct-ID rejection and representative
historical reads against the serving subgraphs before publication.

Release verification uses build, unit tests, generated docs/manifest checks, the core API snapshot and read-only live JSON output contracts. This branch does not execute protocol upgrades or publish packages.
