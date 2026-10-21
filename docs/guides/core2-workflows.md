# Core 2 workflows for CLI consumers and agents

The CLI now uses the same protocol builders and evidence readers as the frontend.
Existing command names and promised JSON keys remain available. Prefer `--json`;
inspect the [command manifest](../reference/cli/manifest.json) before unfamiliar
operations. Preparation commands emit unsigned data and never submit it.

## Observation, preparation, and execution

| Domain | Observe or prepare | Execute through an explicit write |
| --- | --- | --- |
| Authority | `role snapshot`, `group snapshot`, `role plan`, `group plan`, `role continuation`, `group continuation`, `role election-plan`, `role removal-plan` | `role propose`, `group propose`, existing authority actions |
| Voting | `vote capabilities`, `vote ballots`, `vote authorization`, `vote power`, existing `vote analyze` | `vote create`, `vote cast`, `vote announce`, `vote execute` |
| Work | `task snapshot`, `project snapshot`, `task prepare`, `project prepare` | Existing task/project actions; task creation supports atomic `--assignee` |
| Learning | `education list`, `education snapshot` | `education create-module`, `education update`, `education complete` |
| Identity | `user lookup`, `user credentials`, `user prepare` | Existing registration/join/profile commands; prepared passkey intents require a host wallet |
| Email | `zkemail prepare`, `zkemail recover` | Existing allowlist proposal; prepared proof/enrollment intents require a host wallet |
| Treasury | `treasury availability`, `treasury history`, `treasury inflows`, `treasury claims`, `token holders` | Treasury proposals, `treasury claim-stored`, existing claim/deposit/send |
| Sponsorship | `paymaster status`, `paymaster prefund` | `paymaster donate`, existing deposit/register |
| Submission recovery | `execution status`, `execution recover` | Recovery never submits a transaction; it may update the local journal |
| EOA cash-out | `cashout discover`, `cashout status`, `cashout payload`, `cashout deposit-from-receipt` | Explicit `cashout recover-failed`, `cashout withdraw-deposit` |

Commands in the execution column may broadcast real mainnet transactions. A JSON
output option is never consent. Destructive commands require explicit consent;
dry runs skip publication and broadcasting in the updated workflows. Local-file
effects are separately declared in the manifest.

## Preserve the meaning of evidence

New snapshot outputs carry `source`, `coverage`, and often `Fact` values. A known
zero is different from `state: "unknown"`; an unavailable or bounded collection is
different from a complete empty collection. Keep issue codes and raw strings when
storing results. Incomplete snapshots must not authorize a write or establish that
an account has not voted, a board is empty, or a member has no historical activity.

The source records the actual endpoint, chain, organization/module and selected
block. Readers validate each response, including terminal empty pages. Changing
organizations or chains requires new observations. A recent read from the wrong
source is not a valid substitute. The agent's legacy task-tree and member-history
adapters explicitly mark independently paged reads `snapshot: "latest", atomic:
false`. The separately pinned member total has its own source; it does not attest
the member-history rows.

Historical `OrgUser` arrays and totals can be absent for a current authority-only
member. Current membership comes from authority state. Historical completion
payouts, unsupported credential fields and eventless native inflows remain unknown
where the indexer cannot supply them. Bounded cash-out discovery returns candidates,
not a total or permission to withdraw.

## Create a role or group in two decisions

1. Write a desired configuration JSON object (`RoleConfigurationRequest` with
   `kind: "Role"` or `kind: "Group"`). Files cannot supply trusted source evidence,
   guessed subject IDs or approval fingerprints.
2. Run `role plan --file <path>` or `group plan --file <path>`. The host gathers fresh
   authority/index evidence and current module preflights. Review the consequences
   and exact batch. Creation plans contain creation only.
3. Submit `role propose` or `group propose` with the reviewed
   `--expected-fingerprint`. The command collects and checks evidence again,
   including after interactive confirmation.
4. After the creation proposal is executed, call `continuation` with the original
   proposal transaction hash, caller and exact creation calldata. ERC-4337 bundles
   may additionally need exact selected operation identities. A receipt's unrelated
   events, failed inner operation or ambiguous matching operation cannot prove
   creation.
5. Use the confirmed subject ID in a fresh `plan --subject <id>`, review its new
   fingerprint, and submit the separate configuration proposal.

Election and removal planning are unsigned. Durable bans require explicit exact
consent, and capacity/removal facts must be current. Compound predicted-ID role
creation is deliberately replaced by the two-step workflow.

## Prepare work, identity, and email operations

The `prepare` commands accept JSON through `--file`. Use their `--help` for the
available action choices. Amounts in raw builders are exact integer strings; human
amounts on task, project, token and treasury commands accept decimal strings to
avoid JavaScript rounding. Metadata patch and replacement are distinct operations.

Prepared policy decisions are calculations over supplied input, not attestation of
current permissions. Prepared intents expose their target, calldata, value and
verification limits. They do not establish deployment support, live authorization,
proof validity or credential authentication. The host remains responsible for
WebAuthn signing, proving/DKIM verification and wallet transport.

`project prepare creator-authorization` and `zkemail prepare invite-state` expose
the core's supplied-input policy projections with `liveAuthorizationVerified:
false`. `task snapshot --task <id> --account <address>` instead observes the exact
task's application stream and only proves absence when that stream is complete.

Email allowlist replacement verifies the current document/root and selects the
entire retained set; omitted rows are removed. Email recovery checks the exact
original transaction and credential identity. Optional migration only returns a
recovery pointer in stdout: it neither activates nor deletes credentials and never
resends an enrollment.

## Spend available treasury funds and recover submissions

`treasury availability` exposes same-block PaymentManager state, distribution
enumeration coverage, unresolved reservations and independently spendable funds.
PaymentManager sends and distribution proposals enforce this bound even when
optional preflight checks are disabled. Unknown enumeration is a blocked plan,
not permission to assume no reservations.

Stored claims are verified against pinned distribution state and the published
artifact. `treasury claim-stored` submits the verified exact leaf; it does not
recalculate a historical entitlement from today's holders. New Merkle computation
requires complete holder/opt-out observations and exact token decimals.

The execution host journals submission identity before transport dispatch and holds
an account lock. If sending or waiting for a receipt becomes uncertain, subsequent
sends for that account stop. Use `execution status`, then `execution recover` with
the same chain/account and appropriate RPC. Recovery is bounded and checks exact
transaction or operation identity and canonical receipts. It never sends again.
`--abandon` is limited to provably pre-broadcast records; it cannot clear an unknown
send. A `--candidate-tx` constrains recovery beyond the original scan window.

Cash-out recovery requires an explicit deployment descriptor, chain and RPC and
checks current EOA ownership/capability. Passkey cash-out initiation remains out of
scope. Inspect the descriptor and amount before approving a recovery write.

## Agent runtime

`pop agent capabilities --json` reads the installed CLI manifest and returns current
commands, flags, side effects and protocol decision rules. `--read-only` excludes
both broadcasts and local/external side effects. Agent runtime commands themselves
are not part of the CLI/MCP manifest.

Status, triage and deployment-readiness checks support `--address` or `POP_ADDRESS`
without a signing key. Run observations with `POP_READONLY=1`. Triage inspects both
Hybrid and DD voting and retains each proposal's lane. It does not call unknown
ballots unvoted, route application-required work into direct claiming, or infer an
empty board from a failed read. Indexed evidence is advisory; apply the configured
agent execution mode and recheck authorization before an explicit write.
Audit suggestions require known current member totals and complete empty Hybrid
and DD archives at one pinned source block. A missing recorded distribution claim
is only an inspection candidate; verify the stored entitlement before claiming.

Agent sponsorship status resolves the selected chain's indexed hub and applies
the core's lazy epoch-rollover budget calculation to budget state and time at the
same canonical RPC block. Indexed budgets remain separately qualified historical
observations and never establish current available funds. Agent EIP-7702 delegation/setup
currently supports Gnosis and explicitly refuses other chains. Setup uses canonical
hashed subject budget keys and exact amounts; unsupported chains are never silently
redirected to Gnosis.
