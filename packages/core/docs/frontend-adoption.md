# Adopting @poa-box/core 2.2 in a frontend

Core owns protocol encodings, canonical metadata, typed documents, exact
amounts and evidence-bearing planning. The host retains wallet UI, rendering,
identity hydration, caching and lifecycle state. Adoption is a separate product
change; a package test never closes a host or backend finding.

Core 2.2.0 is a candidate; install its reviewed archive until publication.
It includes optional `@poa-box/core/browser/*` adapters and
`@poa-box/core/workflows` in the same package and version as the protocol APIs.
The [browser guide](browser.md), [integration guide](browser-integration.md) and
[feature catalog](browser-features.v1.json) cover that shared runtime. Existing
2.1.0 protocol imports remain compatible.

For a first integration, use [getting started](getting-started.md) and the
[task recipes](workflow-recipes.v1.json). This guide is the detailed host checklist.

## Preserve the service boundary

Keep domain service APIs and route built intents through the existing manager.
Use `intentToExecutionRequest` / `executeIntentWithHost` from `tx/intent` for
exact value, arbitrary host options and raw receipt preservation. Supply the
scope guard and callback; account/org/chain/generation changes must suppress
stale results. A manager unable to send native value must reject positive value
before any send. Never flatten intent metadata into execution options.

Passkey and sponsored hosts can use `encodeIntent` for calldata. The codecs in
`accounts/codecs`, `accounts/userop-v07` and `sponsorship/codec` are pure. Browser
WebAuthn authentication, credential storage, key checks and wallet handoff can
use the optional `browser/passkeys`, `browser/storage` and `browser/wallet`
modules. The application supplies RP/origin configuration, connection UI,
account-specific encoding, sponsorship services and gas policy. Load
`execute/sponsored` only on the optional action route. Journal possible
submission identities before waiting and reconcile uncertain responses; do not
resend an ambiguous operation. Match hash and EntryPoint for receipt outcomes.

## Migrate by domain

| Existing service responsibility | Package leaf |
|---|---|
| Task/project builders, metadata and task mutation/receipts | `tx/task`, `tx/project`, `metadata/task`, `metadata/folders`, `tasks/policy`, `tasks/receipts` |
| Authority permission/context/group and membership planning | `authority/permissions`, `authority/lifecycle`, `authority/activation`, `tx/authority` |
| Education reads and intent builders | `reads/education`, `tx/education` |
| Organization metadata, version policy and bootstrap | `metadata/org`, `deployment/policy`, `deployment/bootstrap`, `tx/org` |
| Votes and governance batches/classes/roles/elections | `tx/vote`, `tx/governance`, `governance/*`, `reads/vote` |
| Treasury sends, distributions and histories | `treasury/planning`, `treasury/distributions`, `metadata/distribution`, `reads/treasury` |
| Email allowlists and prepared claim proofs | `email/allowlist`, `email/proof`, `tx/zkemail` |
| Identity/user/profile metadata | `reads/identity`, `reads/user`, `metadata/user`, `tx/user` |
| Account/factory/protocol/paymaster histories | `reads/protocol`, `graph/documents/accounts`, `graph/documents/protocol`, `graph/documents/paymaster` |
| CID pointers and exact raw amount inputs | `encoding/cid`, `amounts` |
| Strict vote vectors, lightweight account defaults, historical pointer reads | `governance/validation`, `accounts/constants`, `encoding/legacy-pointer` |
| Diagnostic error trees | `errors/envelope`, `errors/compat`, `error-catalog` |
| External cashout request schema | `integrations/cashout` (isolated external configuration) |

The authority-only protocol does not restore retired eligibility/Hats control
surfaces. Diagnostic compatibility errors are not permission or method support.

## Keep evidence honest

Pass chain, endpoint, organization, installed modules and actual observed block
to read/planning seams. Apollo can retain its cache: use canonical documents or
`createDocumentQueryAdapter` with injected clients. Execute exact selector and
variable shapes; field output scalar types do not determine relation-filter
input scalars. On serving deployments, modern credential key fields may be
absent and must remain unknown after the exact fallback.

Pinned readers require same-response metadata and matching proof on every page.
Hash-qualified sources use the hash filter; number-only sources never acquire a
requested hash by echo. Include terminal pages, coverage and failures. Complete
no-match differs from transport outage, partial enumeration, absent field
population and unknown amounts. Cross-source totals require explicit sources,
complete unique rows and the selected alignment policy. Do not truncate to a
page and present it as a global count. Source proof alone does not establish
fresh authority, deployed bytecode or concurrent execution stability.

Parse decimal strings to raw uints once, qualify assets by chain/address and
retain exact decimal-string amounts until display. Compare distribution
CID/root/claims and creation evidence immutably; preserve false, zero and known
empty results. Projected history is not current native causal accounting.

## Type migration

`OrgUser` historical arrays may be absent/null for authority-only users. Use
`isIndexedOrgUser` before code requiring every array; otherwise render unknown
explicitly. Never fabricate arrays to satisfy old types. Default organization
metadata overloads retain their legacy nulls; the widened `ReturnType` includes
supplied extensions/request-time units. Raw merge extension keys survive.

Strict root/EOA consumers of ethers5.7.2 need `@types/node` as a dev dependency
with `skipLibCheck:false`. Runtime remains browser-pure. Optional
viem/permissionless are required only on sponsored aggregates. Amounts, facts,
CID, pagination, source and budget leaves compile without ethers or Node types.
New namespace shorthands are explicit exports; direct nested leaves remain
supported under Node/classic, Node16 and bundler resolution.

## Small adoption APIs

```ts
import { requireValidVoteWeights } from '@poa-box/core/governance/validation';
import { ENTRY_POINT, EOA_DELEGATION } from '@poa-box/core/accounts/constants';
import { legacyPointerToBytes32, legacyBytes32ToIpfsCid } from '@poa-box/core/encoding/legacy-pointer';
import { buildCreateTasksBatchRaw } from '@poa-box/core/tx/task';

const vector = requireValidVoteWeights([40, 60], [2, 0]);
// Returns copied { weights, optionIndices }; throws on fractional/nonfinite
// weights, totals other than 100, or mismatched/duplicate/unsafe indices.
const intent = buildCreateTasksBatchRaw({
  taskManagerAddress, projectId,
  tasks: [{ title: 'Review', payoutRaw: '1000000000000000000',
    metadataHash: '0x' + '0'.repeat(64),
    bountyToken, bountyPayoutRaw: '1000001' }],
});
```

Call the validator before the existing `buildVote`; its historical permissive
encoding stays compatible. Proposal-specific option bounds and member-facing
errors remain host responsibilities. The validator is also available from the
`governance` barrel, and constants from `accounts`. These direct leaves load no
optional executor or full ethers namespace.

`ENTRY_POINT` retains the v0.7 value and `EOA_DELEGATION` retains the sponsored
executor's Gnosis default. Neither asserts deployment on every chain. UAR/Hats
fallbacks remain host bootstrap descriptors; no unverified infrastructure
registry is added. Dynamically discovered indexed organization infrastructure
remains authoritative within its source/chain, subject to the normal readiness
and freshness checks. This package change provides no new deployment evidence.

The named legacy pointer APIs reproduce historical frontend semantics: empty
input/zero-string absence, tolerant CIDv0 digest handling, unchecked bytes32
strings, UTF-8 text keccak hashing, and permissive byte-array/short digest
decoding. CIDv1 text takes the historical text-hash path; this **does not convert
a CIDv1 content digest**. Invalid Qm input returns zero, invalid decoding returns
null, malformed UTF-16 still throws. Logging remains host-owned. Strict
`encoding/cid` APIs are unchanged and should be used for validated content
pointers. Compatibility decoding can produce a multihash with a non-32-byte
digest; it does not validate a CID for new storage.

Raw task builders accept an explicit all-zero bytes32 metadata sentinel for
the existing no-storage capability. Empty strings and invalid nonzero pointers
still reject. This task-domain exception also applies to receipt evidence; it
does not relax strict CID codecs. Raw batch rows use named `payoutRaw` and
`bountyPayoutRaw` inputs, share one project, and all pass the same validation as
`buildCreateTaskRaw` before one atomic intent is returned. Convert amounts once
using the host's known token decimals. Contract permissions, project existence,
budgets and deadline freshness remain execution-time checks. Offline calldata
parity against the checked-in ABI/source is not live acceptance.

## Creation receipt scope

`parseTaskCreatedReceipt` remains conservative by default: repeated identical
drafts cannot be assigned IDs from an unscoped outer receipt. Distinct payloads
still match in requested draft order even if log order differs.

Set `creationLogScope: 'ordered-single-operation'` only after the host has
verified inner success and isolated **all** creation logs belonging to exactly
one operation, retaining original emission order and excluding unrelated
creations. For a UserOp this requires host evidence of that inner operation's
log scope; an outer receipt or a successful outer status is insufficient.
Within this attested scope, repeated identical drafts consume matching events
in submitted occurrence order. Exact cardinality/multiplicity, canonical event
encoding, matching payloads/emitter, and unique IDs are required. Extra,
missing, malformed, foreign-emitter or duplicate records return unknown. The
parser cannot verify the host's attestation or reconstruct omitted log scope.
If the host cannot supply that evidence, leave the option unset and retain
unknown IDs until authoritative reconciliation.

## Atomic enrollment

The pure `tx/user` leaf adds
`buildRegisterAndQuickJoin(a: RegisterAndQuickJoinArgs): TxIntent` and
`buildRegisterAndQuickJoinWithPasskey(a: RegisterAndQuickJoinWithPasskeyArgs): TxIntent`.
The EOA arguments are `{ quickJoinAddress, user, username, deadline, nonce,
signature, orgId? }`. The passkey arguments are `{ quickJoinAddress, passkey,
username, deadline, nonce, auth, orgId? }`, where `passkey` is
`{ credentialId: string, publicKeyX: string, publicKeyY: string, salt: RawUintInput }`
and `auth` is the existing `WebAuthnAuth` from `accounts/codecs`. Deadline and
nonce also use `RawUintInput` (decimal string, bigint or safe integer number).
All three passkey byte identifiers/coordinates are bytes32; no curve verification
or account derivation is implied by this shape check.
The shared `tx/enrollment` leaf exports the `PasskeyEnrollment` and
`PasskeyRegistrationArgs` types and
`passkeyRegistrationArgs(a: PasskeyRegistrationArgs): unknown[]`, the validated
five-argument registration tuple used by these builders. Prefer the named
action builders when preparing transaction intents.

The pure `tx/zkemail` leaf adds
`buildRegisterAndClaimByDomainWithPasskey(a: RegisterAndClaimWithPasskeyArgs<'v1'>): TxIntent`
and `buildRegisterAndClaimByEmailWithPasskey(a: RegisterAndClaimWithPasskeyArgs<'v2'>): TxIntent`.
Their arguments combine the same passkey registration fields with
`{ zkEmailInvitesAddress, proof, claimer, hatIds, merkleProof, orgId? }` from
the existing prepared claim API. `proof` must be an actual `projectGroth16Proof`
projection of the matching version bound to `claimer`; role order is preserved.
These functions each return one current-ABI intent. They never register and
join/claim in separate operations.

```ts
const challenge = registrationChallenge({
  user: hostResolvedAccount, username, nonce, deadline, chainId, registryAddress,
}, 'passkey'); // RegisterPasskeyAccount primary type
const auth = await hostSignRegistrationChallenge(challenge);
const join = buildRegisterAndQuickJoinWithPasskey({
  quickJoinAddress, passkey, username, nonce, deadline, auth,
});
const claim = buildRegisterAndClaimByEmailWithPasskey({
  zkEmailInvitesAddress, passkey, username, nonce, deadline, auth,
  proof: projectedV2Proof, claimer: hostResolvedAccount, hatIds, merkleProof,
});
```

The host selects one action, verifies chain/registry pointers, derives the
passkey account, obtains current nonce/deadline and signs the appropriate
challenge. Core does not verify signatures or cryptographic proofs, fetch,
deploy, sign or send. EOA registration uses `RegisterAccount`; passkey
registration uses `RegisterPasskeyAccount`.

## Whole-list private invite edits

`email/allowlist` adds
`replaceVerifiedAllowlist(args: ReplaceVerifiedAllowlistArgs): BuiltVerifiedAllowlist`.
Its input is `{ orgId: string, currentRoot: string, current: VerifiedAllowlist,
retained: readonly RetainedAllowlistLeaf[], additions?: readonly AllowlistInputEntry[] }`.
Each retained row is `{ leaf: VerifiedAllowlistLeaf,
hatIds?: readonly (string | bigint | number)[] }`. Keep the **actual leaf object**
projected from this verified `current` in form state; copied descriptors and
leaves from another verification handle are rejected even if their bytes match.
The expected org/root must match the verified base.

```ts
const current = verifyAllowlistDocument(doc, { orgId, root: currentRoot });
const rows = projectVerifiedAllowlistLeaves(current).map(leaf => ({ leaf }));
// Host reviews the whole final selection; omitted leaves are removed.
const next = replaceVerifiedAllowlist({
  orgId, currentRoot, current,
  retained: reviewedRows, // optionally { leaf: rows[0].leaf, hatIds: reviewedRoleIds }
  additions: [{ type: 'email', identifier: newEmail, hatIds: newRoleIds }],
});
```

An unchanged selection preserves committed role order and the root. Authored
grant replacements/additions sort exact uint256 IDs; duplicate grants or
identities, empty final lists, sparse/malformed inputs and unsafe numbers fail.
New identities require normalized, printable ASCII plaintext within the existing
192-byte limit. Email plaintext is omitted from the resulting canonical document,
including newly added emails; domain names remain public. Uncommitted role-index
hints are discarded, as in the verified republish/merge APIs. Existing
`buildAllowlist`, `buildAllowlistFromVerifiedLeaves` and `mergeVerifiedAllowlist`
retain their compatibility behavior. The new replacement API rejects ambiguous
duplicate-identity or duplicate-grant legacy selections; it does not change the
older builders' historical acceptance. Actual role existence/eligibility, member
copy, source lifecycle, uploads and final root freshness remain host-owned.

## Indexed caps and configured email sponsorship

`authority/indexed-cap` exports
`decodeIndexedAuthorityCap(value: RawUintInput): string`. Only explicit indexed
`-1` (string, bigint or number) maps to uint32.max, `"4294967295"`.
`readAuthoritySnapshot` uses it for `subjects[].maxMembers`, retaining the
original scalar in `raw.maxMembers` and the raw collection. Native zero stays
`"0"`; missing/malformed/other negative values produce incomplete coverage.
`requireRawUint` stays strict. UI rule previews, including renounce wording and
no-grant semantics, remain host policy.

`RoleConfigurationRequest.sponsorship` adds
`includeConfiguredEmailRules?: boolean`, independently of `request.email`.
Set it with `supportPasskeys: true` to sponsor existing configured org email
claim/registration methods without adding role invites or publishing a new list:

```ts
const result = planRoleConfiguration({ ...verifiedPlanningInput, request: {
  kind: 'Role', name: 'Builders',
  sponsorship: { capRaw, epochSeconds, supportPasskeys: true,
    includeConfiguredEmailRules: true },
} });
```

The complete fresh context must bind the email/executor/paymaster targets,
ready authority, enabled email module, matching authority, authorized minter,
nonzero active root, both known verifier-mode flags and sponsor operator
authorization. Only enabled modes contribute selectors; both enabled preserve
the four-selector claim/register set and existing order. No mode enabled is
blocked. The existing role-email additions path still explicitly plans its
allowlist/minter changes. Configured-only rules do not make those changes.
Claim-budget facts must be known: an absent budget requires the separate
`initializeClaimBudget: true` consent and yields an
`INITIALIZE_EMAIL_CLAIM_BUDGET` consequence. An existing claim budget is never
updated implicitly. Rebuild/revalidate from current scoped facts before sending.

## Recorded native inflows and global fee pots

The `treasury/indexed-inflows` leaf adds a separate indexed entity DTO. Its
`projectIndexedNativeInflow(row, collection, source, nativeAsset)` returns
`Fact<IndexedNativeInflowEvent>` with explicit source, collection, opaque Bytes
entity ID, actual transaction hash, block, sender, target and exact raw amount.
Payment retains its actual organization relation. Global hub deposit/donation
events have no invented organization or log index. `deduplicateIndexedNativeInflows`
deduplicates identical source/collection/entity observations; conflicting payloads
or multiple indexed endpoints on one chain return unknown. Equal transaction
hashes/amounts on different entity IDs remain distinct. Collection IDs occupy
separate namespaces and are never decoded into transaction/log identities.

`HistoricalPaymasterHubPot` adds the `kind: 'paymaster-hub'` variant with chain,
address and creation block, and no `orgId`. The existing `HistoricalPot` and
`readHistoricalPotFacts` stay compatible. `classifyInternalMovement` and
`normalizeRecordedInflows` also accept the additive `HistoricalInflowPot` union;
global hubs require complete global indexed history at the selected block.
Historical former addresses remain active from their own creation blocks.

Replace the local native/hub classification in `lib/landing/inflows.js` and
the supplemental `LANDING_INFLOWS_QUERY` collections with these canonical
readers. The host first selects its indexed block, then injects the existing
Graph/Apollo query adapter. Each response must supply its own `_meta` proof:

```ts
import { readHistoricalPotFacts } from '@poa-box/core/treasury/inflows';
import {
  readHistoricalPaymasterHubPotFacts, readIndexedNativeInflowFacts,
  normalizeIndexedRecordedInflows,
} from '@poa-box/core/treasury/indexed-inflows';

const options = { source: pinnedGlobalSource, query: hostQuery,
  pageSize: 1000, maxPages: 10 };
const pots = { ...await readHistoricalPotFacts(options),
  'paymaster-hub': await readHistoricalPaymasterHubPotFacts(options) };
const collections = ['payments', 'paymasterDepositEvents', 'solidarityEvents'] as const;
const streams = await Promise.all(collections.map(collection =>
  readIndexedNativeInflowFacts({ ...options, collection, fromBlock })));
const recorded = normalizeIndexedRecordedInflows({
  pots, streams, chunks: hostErc20LogChunks, fromBlock, block: selectedBlock,
  nativeAsset: { chainId, address: '0x0000000000000000000000000000000000000000',
    decimals: hostNativeDecimals },
});
// Only a known externalRecordedTotals may feed host asset/USD presentation.
// completeRevenue remains unknown even when every recorded stream is complete.
```

`readIndexedNativeInflowFacts(options)` returns
`Promise<SourceSnapshot<IndexedNativeInflowStream>>`; its collection selects
native PaymentReceived, OrgDeposit or DonationReceived only, with inclusive
`fromBlock` through `source.block.number`. `readHistoricalPaymasterHubPotFacts`
returns `Promise<SourceSnapshot<readonly HistoricalPaymasterHubPot[]>>`.
Both require explicit positive `pageSize <= 1000` and `maxPages`, a pinned
global indexed source and terminal cursor evidence. A full page at the limit
stays incomplete. The four documents are exported from `graph/documents/inflows`:
`FETCH_PAYMASTER_HUB_POTS_PAGE`, `FETCH_INDEXED_NATIVE_PAYMENTS_PAGE`,
`FETCH_INDEXED_ORG_DEPOSITS_PAGE` and `FETCH_INDEXED_DONATIONS_PAGE`.

`normalizeIndexedRecordedInflows(input): IndexedRecordedInflows` requires
all four complete pot histories and all three complete native streams at one
indexed endpoint/block, plus complete ERC20 log chunks covering the same range.
Rows must bind the actual pot kind, organization when present, chain and creation
cutoff. Identical repeated stream observations are idempotent; conflicting
alternatives stay unknown. Native log/trace rows cannot be mixed into these
chunks: the package has no proof linking them to opaque indexed entity IDs.
The existing strict log DTO, functions and return types remain available.

Network endpoints, chain verification, bounded ERC20 log transport, token/native
decimals, supported/stable asset selection, spot rates and USD rendering remain
host-owned. Include verified former/current hubs among the existing log targets;
these APIs add no RPC scans. Graph cursor enumeration can require more requests
than the previous capped supplemental query. Preserve coverage and unknowns
through caching/UI; do not bypass missing or failed pages. The offline serving
schema fixtures prove previously observed field compatibility, not current
deployment/population or exhaustive native, trace or causal revenue. No new
infrastructure addresses or frontend configuration are installed by this change.

## Authority display, detail ballots and DD authorization additions

`graph/documents/authority` exports `FETCH_AUTHORITY_MEMBERSHIP_EVENTS_RECENT`
and `FETCH_AUTHORITY_CONFIG_LINTS_RECENT`. Both accept `authority: String!`,
optional `first: Int` (defaults 50 events / 200 lints) and `block: Block_height`.
They preserve the serving event/lint fields, sort descending by timestamp /
emittedAt and select `_meta` with the same block. These are recent display
windows, not complete history or authorization facts. The host must retain its
window bounds, endpoint/Apollo cache ownership and unknown/error handling.

```ts
import { FETCH_AUTHORITY_MEMBERSHIP_EVENTS_RECENT,
  FETCH_AUTHORITY_CONFIG_LINTS_RECENT } from '@poa-box/core/graph/documents/authority';
// hostQuery is the existing endpoint-owned ProtocolQuery adapter.
const events = await hostQuery(FETCH_AUTHORITY_MEMBERSHIP_EVENTS_RECENT,
  { authority: authorityAddress.toLowerCase(), first: 50, block: blockSelector }, source);
const lints = await hostQuery(FETCH_AUTHORITY_CONFIG_LINTS_RECENT,
  { authority: authorityAddress.toLowerCase(), first: 200, block: blockSelector }, source);
```

`graph/documents/voting-classes` adds `FETCH_HYBRID_PROPOSAL_BALLOTS_PAGE` and
`FETCH_DD_PROPOSAL_BALLOTS_PAGE`. Prefer the bounded
`readProposalBallotFacts(options): Promise<SourceSnapshot<readonly IndexedRow[]>>`
from `reads/vote`, with public `ProposalBallotOptions`:

```ts
import { readProposalBallotFacts } from '@poa-box/core/reads/vote';
import { requireCompleteSnapshot } from '@poa-box/core/data/facts';
const ballots = await readProposalBallotFacts({ source: pinnedVotingSource,
  query: hostQuery, lane: 'dd', proposalId: exactDecimalProposalId,
  pageSize: 250, maxPages: 20 });
const rows = requireCompleteSnapshot(ballots, { scope: pinnedVotingSource,
  snapshot: 'pinned', block: pinnedVotingSource.block });
```

The source must be indexed, pinned, and contain explicit chain/endpoint/org/module
identity. Bounds are required integers in 1..1000. Every response proves the
installed org lane, exact composite proposal identity and same-response observed
block, including terminal empty pages. The documents select only one proposal
and its top-level `votes` / `ddvvotes` cursor stream. A full final allowed page,
failed/malformed/cross-proposal page, wrong module, absent proposal or wrong/missing
block remains incomplete/unavailable. Diagnostic rows may be retained; consume
them as complete only through the coverage gate. Returned serving Int allocation
vectors remain numbers; Hybrid uint256 `classRawPowers` remain exact decimal
strings; DD has no class powers. This proves indexed ballot enumeration, not a
frozen class emission, immutable class subject, current on-chain winner, or RPC
freshness. Load only mounted details/on demand; bounded feed cards stay previews.
Existing `fetchProposalVoteAnalysis`, CLI feeds and legacy fallbacks are unchanged.

`governance/dd-authorization` (also the governance barrel) adds
`deriveDirectDemocracyAuthorization(input): Fact<boolean>`, with public
`DirectDemocracyAuthorizationData` and `DirectDemocracyAuthorizationInput`.

```ts
import { deriveDirectDemocracyAuthorization }
  from '@poa-box/core/governance/dd-authorization';
const authorization = deriveDirectDemocracyAuthorization({
  scope: { chainId, orgId, contract: ddAddress, account,
    contracts: { membershipAuthority: authorityAddress } },
  proposalId: exactDecimalProposalId, proposal: ddPolicySnapshot,
  authority: authorityPermissionSnapshot, memberships: accountActivationSnapshot,
});
```

`ddPolicySnapshot.data` supplies the exact `proposalId` and Facts for
`createdAt`, `membershipAuthority`, `executor`, `restricted` and
`restrictedSubjectIds`. `createdAt` is the module's `proposalCreatedAt(id)`
activation anchor, never the poll start time; zero means the pre-authority
membership-only sentinel. Authority/executor facts must describe this DD module.
Supplied snapshots must be complete, pinned to the same observed block and bind
the same chain/org, authority and account as appropriate. Attached per-field
sources must agree; unscoped Facts are explicitly trusted caller inputs, as in
the existing activation APIs. Missing facts remain unknown.

DD requires nonzero authority before any Executor bypass. Executor skips only
the general DD_VOTE activation gate. Restricted polls still require activation
in at least one allowed subject/group, including for Executor; an empty restricted
list denies. Normal accounts need DD_VOTE at ctx0 plus activation at/before
creation and any poll restriction. Current group edges and earliest active role
timestamps (including paused seeds) use existing authority primitives; subject
IDs remain opaque uint256 values. This projector does not check proposal
existence, voting time, pause, alreadyVoted, weights or execution readiness.
Hosts retain those guards and freshness/transport policy.

The offline policy oracle is
`test/fixtures/core-update/governance/DirectDemocracyVoting.sol.txt`, vote()
lines 423..467, SHA-256
`fc77454fcafccfe6a386baf577f85af838a2365228571ff39f0ed54a8d57fd67`;
`VotingMath.sol.txt` activationOk SHA-256
`0d5b60d2775240190103f0f80fe79d29cda7694feac67ec8e771206f5273b9cd`.
Provenance lives in that fixture directory's `provenance.json`. These inspected
source fixtures do not prove deployed bytecode. Authority entity additions retain
cached source schema SHA-256
`5f9d3a3fcfceabcb81ffa8bb847e954ef50bf32df2c5fc68d0184a32f9c76a3c`;
the focused serving projection/provenance in `test/fixtures/core-update/authority`
validates GraphQL selections, variable scalars and defaults only. No new live
deployment, endpoint configuration or field-population verification is claimed.

`tx/paymaster` adds `buildDonateToSolidarity({ paymasterHubAddress, amountWei })`
and `DonateToSolidarityArgs`. It returns a canonical PaymasterHub payable intent
with no arguments, a nonzero valid hub and positive exact uint256 raw-native
value. `amountWei` accepts decimal string, bigint or safe integer; one wei stays
one wei, with no implicit ether scaling. Zero, negative, fractional, unsafe and
overflow inputs fail. The existing canonical ABI encodes `donateToSolidarity()`.
Network/account/hub selection, confirmation and any execution remain host-owned:

```ts
import { buildDonateToSolidarity } from '@poa-box/core/tx/paymaster';
const donationIntent = buildDonateToSolidarity({ paymasterHubAddress: hub,
  amountWei: 1n }); // intent only; no donation is sent
```

## Current project creators and complete task applications

`tasks/project-creator` (also the `tasks` barrel) adds
`deriveProjectCreatorAuthorization(input: ProjectCreatorInput): ProjectCreatorFacts`.
Its input is `{ scope, taskManager, authority, memberships, sources? }`. `scope` names the
chain, bytes32 org, nonzero TaskManager and account, with an optional expected
endpoint and `contracts.membershipAuthority`. `taskManager.data` is
`ProjectCreatorData`: `{ creatorSubjectIds: Fact<readonly string[]>,
membershipAuthority: Fact<string>, executor: Fact<string> }`. These are observed
TaskManager configuration facts. The other two snapshots contain the existing
`AuthorityPermissionData` and `readonly AuthorityMemberFact[]` shapes:

```ts
import { deriveProjectCreatorAuthorization }
  from '@poa-box/core/tasks/project-creator';
import { authorityAccountMembershipFacts } from '@poa-box/core/reads/authority';

const creatorInput = {
  scope: { chainId, orgId, contract: taskManagerAddress, account,
    endpoint: graphEndpoint, contracts: { membershipAuthority: authorityAddress } },
  taskManager: taskManagerCreatorSnapshot,
  authority: currentAuthoritySnapshot,
  memberships: authorityAccountMembershipFacts(currentAuthoritySnapshot, account),
  sources: {
    taskManager: { endpoint: rpcEndpoint, method: 'eth_call', indexed: false },
    authority: { endpoint: graphEndpoint, method: 'authority', indexed: true },
    memberships: { endpoint: graphEndpoint, method: 'authority', indexed: true },
    block: selectedCanonicalBlock, // { number: exactDecimalString, hash: bytes32 }
  },
};
const creators = deriveProjectCreatorAuthorization(creatorInput);
// creators.authorized is the createProject gate; no pre-existing project needed.
// Preserve unknowns and the RPC source on the result.

import { decideTaskActions } from '@poa-box/core/tasks/policy';
const deletion = decideTaskActions({
  projectId, now: hostNowSeconds, scope: creatorInput.scope,
  snapshot: indexedTaskPolicySnapshot,
  projectCreator: creatorInput,
}).deleteProject;
// Keep the indexed snapshot's creator/executor facts as originally observed
// (unknown when absent). This seam revalidates the original creator observations
// and combines their gate with the policy's exact project existence fact.
```

`creator` means current membership in **any configured authority subject**;
`executor` is equality with this TaskManager's configured Executor. `authorized`
is their OR. For a compatible same-source policy, `creator` may feed
`TaskPolicyFacts.creator` and `executor` may feed its separate executor fact.
For mixed sources use the explicit policy input above. Project-manager status and the task CREATE bit do
not authorize project creation/deletion. Historically named `creatorHatIds` are
opaque exact uint256 authority subject selectors, including adopted historical
IDs. They are never Hats wearer facts. Current groups use active group edges
and current Role membership through `projectSubjectMembership`. Empty selectors
prove creator membership false; a positive selected membership can resolve an
otherwise unknown selector match. With no positive match, missing/unknown role
facts or missing subjects remain unknown. Complete transport coverage is
mandatory even when one supplied membership is positive.

By default all three observations must be complete, pinned to the same observed
block dimensions, and share endpoint and indexed/RPC source kind. The optional
`sources: ProjectCreatorSources` enables an explicit composition: it requires
each expected endpoint, method and indexed/RPC kind, plus a selected canonical
block number **and hash**. Every observation and attached field source must
match its own expected origin and that common block proof. Endpoints/kinds are
host-selected expectations, not inferred by copying unverified response fields.
Optional expected timestamp dimensions are enforced; supplied timestamps cannot
contradict each other. Indexed metadata may include a timestamp while a matching
RPC block proof omits it. Each input keeps its original source; the resulting
Fact retains the TaskManager source and is not a portable multi-source proof.
All observations bind the same
chain/org; the authority and membership snapshots bind the actual nonzero
TaskManager authority, and memberships bind the account. Supplied per-field
sources must agree; unscoped field Facts are trusted caller inputs. Foreign,
partial, stale or malformed supplied observations cannot piggyback on Executor.
The API conservatively requires a proven nonzero authority binding even for an
Executor. Arbitrary mixed sources without these expectations remain rejected.
Pinned indexed data is not claimed to be live chain state.
Hosts retain chain/config selection, freshness, cache invalidation and transport.

`TaskPolicyInput.projectCreator` accepts `ProjectCreatorInput & { sources:
ProjectCreatorSources }` for **deleteProject only**. The policy snapshot must be
complete, indexed, pinned, scoped to an explicitly expected endpoint/account/org/
TaskManager, and observe the same canonical number/hash. Its authority binding
(when expected in scope) must agree. The seam re-runs the creator projection;
it does not accept an unverified returned boolean. Project existence must still
be known true for deletion. Other task decisions retain their original facts
and checks, including task CREATE, project manager, permission and Executor
handling. Invalid optional creator evidence cannot authorize deletion. Directly
inserting an RPC creator Fact into an indexed policy remains invalid. No source
is stripped or relabeled, and the global Fact validation model is unchanged.

The serving schemas expose TaskManager `creatorHatIds`, but expose neither its
`executor` nor its `membershipAuthority`. Existing task documents already select
creator IDs. An org-level pointer alone does not prove this module's binding;
no invented Graph fields are added. Hosts can obtain the exact module facts
through their existing read transport: inspected `getLensData` variants 5, 4
and 12 respectively return `uint256[]`, `address`, and `address`. The existing
`encodeLensCall`/`decodeLensResult` codecs can support that host observation;
the old lens wrappers do not attest a pinned block by themselves. This change
adds no RPC executor, provider, or host UI integration.
Select an indexed canonical block with its response `_meta`, verify the same
block number/hash on the configured chain RPC, and batch the three settings
reads at that pinned block once per TaskManager/observation generation through
the host's existing bounded transport. Reuse the indexed authority/account
snapshot; no RPC authority tree or per-task settings loop is required. Reject
number/hash drift or unavailable historical block reads. Refresh/invalidate all
inputs on chain/org/account/module/endpoint/block changes; equal hashes do not
establish present-time freshness. Actual deployed module configuration and
bytecode compatibility remain host verification responsibilities.

`graph/documents/task` adds `FETCH_TASK_APPLICATIONS_PAGE`.
`reads/task` adds
`listTaskApplicationsComplete(options: TaskApplicationPageOptions): Promise<SourceSnapshot<TaskApplicationData>>`
and `projectTaskApplicant(input: TaskApplicantInput): Fact<boolean>`:

```ts
import { listTaskApplicationsComplete, projectTaskApplicant }
  from '@poa-box/core/reads/task';
import { requireCompleteSnapshot } from '@poa-box/core/data/facts';

// Fetch only mounted task details / action demand, with the existing hostQuery.
const applications = await listTaskApplicationsComplete({
  source: pinnedTaskManagerSource, query: hostQuery,
  task: exactDecimalTaskId, pageSize: 250, maxPages: 20,
});
const alreadyApplied = projectTaskApplicant({
  applications, task: exactDecimalTaskId, block: selectedIndexedBlock,
  scope: { chainId, orgId, contract: taskManagerAddress,
    endpoint: pinnedTaskManagerSource.endpoint, account },
});
// Consume detail rows only after coverage and source validation.
const detail = requireCompleteSnapshot(applications, {
  scope: pinnedTaskManagerSource, indexed: true, snapshot: 'pinned',
  block: selectedIndexedBlock,
});
const originalApplicationRows = detail.applications;
const originalParentTask = detail.task;
```

Options require indexed, pinned org/module scope, `task: string` (exact decimal
uint256 or the same TaskManager's composite entity ID), and explicit integer
`pageSize`/`maxPages` in 1..1000. The document enumerates top-level
`taskApplications` in ascending String-ID cursor order, filtering by exact task
and module. Each response selects the matching parent and org/module binding
at the same `$block` as `_meta`, including an empty terminal page. The parent
belongs to a non-deleted project, matching the existing current-work readers.
Missing/foreign/deleted/ambiguous parents, absent/wrong metadata block proof,
malformed/duplicate applicants, nonadvancing/repeated cursors, errors, and a
full final allowed page leave coverage incomplete/unavailable. Diagnostic rows
may remain in `data.applications`; they cannot bypass the completeness gate.
`data.task` retains the original validated parent or null when unavailable.
This binding prevents an empty stream for one task from proving another task's
applicant absent. `projectTaskApplicant` additionally validates the host's
expected endpoint/account/block and returns exact indexed presence/absence.

Original application IDs, applicant/approver addresses, usernames, hashes,
approval flags/times and nullable notes/experience metadata survive unchanged;
raw BigInt fields stay strings. Existing tree/detail `applications` relations
still default to a 100-row preview and keep their compatible behavior. A missing
applicant in that capped relation does not prove absence. No board-wide per-task
RPC, host cache, frontend install or legacy CLI query changes are introduced.

The offline creator oracle is `test/fixtures/core-update/work/TaskManager.sol.txt`
from contracts commit `fa37b3e7341c9225bdc1ab6a9ba94ee41a876c8d`, SHA-256
`c31f6434a85caf875e866e9cefd2cace1ab7aef9ff7617633be6ccce9e2f517a`.
`_requireCreator` lines 322..325, createProject 371, deleteProject 452 and
`_hasCreatorHat`/`_authorityHoldsAny` 1361..1381 establish this rule. The separate
`work/project-applications/provenance.json` and compressed fixtures retain each
**full** cached chain-100/42161 serving introspection envelope, each raw SHA-256
`9a89a35abeb10d86741ffcb688cc1fce44678f46164deeced92d88164862cfb5`.
Tests build both schemas with `buildClientSchema(raw.data)` without projections
or extensions. Source-schema provenance remains in `work/provenance.json`.
These fixtures establish inspected source behavior and cached field compatibility;
they do not verify deployed bytecode, current field population, endpoint health,
index completeness beyond proven pages or a live deployment. No new traffic or
configuration was required for this follow-up.

## Adoption acceptance

Keep product minimum-duration policy, storage concurrency, credentials, browser
prompts, optimistic IDs, route/form refresh and permission checks in the host.
Revalidate scope/freshness and simulate immediately before an authorized send;
validate the precise inner receipt and post-state afterwards. Proof circuits,
DKIM keys, deployed verifier/factory/module wiring and index population require
separate deployment evidence. Backend backfills and native-event causality
remain backend work. Package regression checks and the local release artifact
are available for review; final packed independent, browser and live approval
are separate stages.


## Indexed totals and recovery integration obligations

Use the gap-closure API table and availability limits in the packaged README.
The package implements the readers and pure recovery contracts; React adoption,
cache ownership, Web Locks, wallet transports and actual Test6 verification are
host work. A published/exported function does not demonstrate deployed data.

* Route the unchanged indexed documents to the exact source endpoint. Require a
  matching complete pinned snapshot before replacing an unknown member, positive
  holder or all-learner total. Preserve unknown historical education rewards.
* Replace capped cashout lists with `readCashoutDiscovery`; independently verify
  every candidate with pinned relay/receipt reads. Preserve stream failures and
  the passkey initiation gate. Do not expose an invented outstanding total.
* Recover only explicit historical proposal IDs with independent org/voting/
  authority bindings. Keep unproven creation markers unknown and preserve coverage.
* Keep legacy pending email records byte-for-byte; persist a separate recovery-only
  migration audit. Require independently authenticated credentials before login/
  activation, and never reconstruct a missing original initiator from calldata.
* Await journal acquisition before prepare/sign work and release in `finally`.
  Guard account/chain/context after acquisition and before send, and check pending
  records across the account. Read-only recovery clear must acquire the same lock,
  compare full scope/owner/attempt/revision with the reread record and return an
  explicit success boolean. Await it in UI and retain the record on false/error.
* Supply exact transaction and canonical-block readers to EOA reconciliation.
  For missing hashes outside the prefix, offer an explicit candidate hash checked
  by core; never mutate saved call identity or resend. Display `replaced` as a
  different action consuming the nonce. Preserve unresolved legacy descriptors.
* Verify final installed-package behavior in tests and then under the assigned
  single browser/server owner, with fresh per-write hashes and domain/current-state
  evidence. Old confirmed submissions must never be replayed.

Exhaustive native inflows/causal revenue and absent original historical enrollment
provenance remain unavailable until real approved source evidence exists. An
indexer implementation without production deployment and demonstrated population
cannot close those gaps.

## Reviewed role operations

Use `@poa-box/core/governance/role-operations` for the supported staged role path:
`readRoleOperationEvidence`, `reviewRoleOperation`, `prepareRoleOperation`,
`readRoleOperationStatus`, and `revalidatePreparedRoleOperation`.
See [role-operations.md](role-operations.md) for the request, publication and
recovery boundaries and [agents.md](agents.md) for safe operation selection.

Frontend maps forms and display units, controls consent and lifecycle, schedules
bounded indexed/RPC reads, and stores versioned unsigned journals. It must not
recreate core's field-demand table, allowlist merger, role plan or actual-ID proof.
Unresolved auth is unknown identity. Cache entries must match restored account,
chain, organization, modules, endpoints and canonical block. Scope changes cancel
pending work; stale results never reach a transaction manager.

Prepare returns a role batch. After awaiting the enclosing proposal's metadata
publication, call `revalidatePreparedRoleOperation` immediately before manager
handoff; a changed/expired observation means zero manager calls. Neither review
nor prepared handles survive JSON serialization as authority. Reload the saved
unsigned journal and exact creation/configuration references, recover read-only,
and renew review. Keep the original form separate from opaque handles.

Staged create neither predicts an ID nor enumerates allocation/proposal history.
Only a proven actual subject ID permits the configuration stage; configuration
has its own proposal reference and independently proven outcome. Unknown, pending,
failed and rejected remain distinct. No automatic resend follows a timeout.

Status proves a separate configuration proposal and binds every supported call to
the actual created subject. For email allowlist configuration, pass the optional
read-only `fetchDocument(cid, { signal })` callback; core verifies at most one
document against its committed root/org and actual-subject leaf. Unavailable
association remains unknown with the creation proof retained in observations.

The independent consumer exercises this same public path with synthetic transport
fixtures. Its success is not evidence of frontend adoption, deployed counters,
serving completeness or Test6 behavior; those need the assigned acceptance owner.
