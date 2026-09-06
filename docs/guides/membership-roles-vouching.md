# Membership, roles, groups and vouching

POP CLI 1.0 supports MembershipAuthority organizations. A migrated organization keeps its original organization ID, module addresses, adopted role IDs, historical tasks, proposals, payments and member statistics. Current eligibility, membership, vouches and permissions come from the authority index.

Organizations appear after their authority is registered, bound and cut over. Seeded authorities and rolled-back organizations are unavailable. Native authority organizations qualify automatically; there is no organization-name allowlist. Kansas Blockchain, Decentral Park, Poa and Test6 retain their earlier history. Inactive organizations that never migrated, including Argus, are unavailable. An unavailable authority index produces an error; it does not enable an older protocol path.

## Observe and join

```bash
POP_READONLY=1 pop org list --chain 100 --json
pop org roles --json
pop org members --json
pop user whoami --address 0xYOUR_ADDRESS --json
pop user join --username alice --dry-run
pop role claim --subject ROLE_ID --dry-run
```

Roles require acceptance and eligibility. Groups derive membership from their constituent roles and cannot be claimed. `org roles` lists both subject kinds. Historical JSON fields such as `hatId` and `currentHatIds` carry the same adopted IDs; they do not select a Hats implementation.

## Vouching

```bash
pop vouch status --subject ROLE_ID --user 0xMEMBER --json
pop vouch for --subject ROLE_ID --user 0xMEMBER --dry-run
pop vouch revoke --subject ROLE_ID --user 0xMEMBER --dry-run
pop vouch claim --subject ROLE_ID --dry-run
```

Vouch quorum grants eligibility. The recipient claims the role explicitly. Vouch counts and records are epoch-scoped. A reset invalidates the previous epoch; clearing one user invalidates that user's received vouches.

## Governance and delegation

Governance-only commands create a two-option executable proposal: option 0 applies the authority call and option 1 leaves the current state. The usual vote/cast/execute lifecycle applies. These commands broadcast a proposal unless `--dry-run` is set.

```bash
pop role create --name Reviewer --max-members 10 --dry-run
pop role grant --subject ROLE_ID --user 0xMEMBER --dry-run
pop role offer --subject ROLE_ID --user 0xOUTSIDER --dry-run
pop role remove --subject ROLE_ID --user 0xMEMBER --ban --yes --dry-run
pop role set-default --subject ROLE_ID --allow --dry-run
pop role set-manager --subject ROLE_ID --manager MANAGER_SUBJECT --caps 3 --delay 86400 --dry-run
pop group create --name Council --roles ROLE_ID_A ROLE_ID_B --dry-run
pop group add-role --group GROUP_ID --role ROLE_ID --dry-run
pop vouch configure --subject ROLE_ID --quorum 3 --voucher-subject VOUCHER_SUBJECT --dry-run
pop vouch reset --subject ROLE_ID --yes --dry-run
```

Manager actions use explicit `delegate-grant`, `delegate-offer`, `delegate-remove` and `delegate-unremove` commands. A grant or removal is finalized with `role finalize --pending ID` after the review delay. An offer is accepted through `role claim`. `role cancel --pending ID` cancels a pending action. Governance bans and sticky grants cannot be overridden by delegates. `role renounce` resigns; `role reconcile` repairs a membership whose eligibility has lapsed.

## Permissions

```bash
pop role set-perm --subject ROLE_ID --key PT_MEMBER --value 1 --dry-run
pop role set-perm --subject ROLE_ID --key DD_VOTE --value 1 --dry-run
pop task perms show --json
pop task perms propose-global --subject ROLE_ID --perms create,claim,review --dry-run
pop task perms set --subject ROLE_ID --project 0xPROJECT_BYTES32 --perms claim --dry-run
```

`set-perm` packs existence and inheritance flags. `clear-perm` removes the row. Setting a zero value creates an explicit denial for that subject/context; clearing a project row restores global inheritance. Task project contexts encode `projectId + 1`, so project zero is distinct from the global zero context. `--inherit-global` combines a project row with the global row.

EligibilityModule applications, super-admin transfer, join-time overrides, hat minting, and `user claim-hats` were removed. Use authority offers, claims, governance rules and manager delegation. The generated [role reference](../reference/cli/role.md), [group reference](../reference/cli/group.md) and [vouch reference](../reference/cli/vouch.md) describe every command.
