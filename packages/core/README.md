# @poa-box/core

Version 2.1 adds reviewed role operations and canonical role metadata to the authority-only 2.0 API. MembershipAuthority replaces EligibilityModule/Hats access. Retired organizations remain unavailable. Adopted IDs and earlier history remain intact. The execution, signer-identity, scoped-receipt and canonical-recovery safeguards remain in place. CLI and agent versions remain 1.0.0; their local linked consumers retain existing output and mock seams.

The stable protocol layer for POP (Proof of Participation): **transaction
creation** and **data reads** for every consumer — the `pop` CLI, web
frontends, autonomous agents, and third-party integrations. Protocol changes
land here; consumers update one dependency instead of chasing contract or
subgraph churn.

- **Browser-and-Node pure.** No `fs`, no `process.env`, no terminal deps
  anywhere in the package (enforced by `test/purity.test.ts`). Environment is
  injected.
- **Wallet-agnostic writes.** Supported transaction builders return a `TxIntent` —
  plain data you can execute with an ethers signer, wagmi/viem, an ERC-4337
  passkey account, an EIP-7702 sponsored userop, a Safe batch, or raw JSON-RPC.
- **Canonical protocol knowledge.** ABIs (generated, drift-proof), metadata
  JSON shapes (key order is a protocol contract), subgraph documents with
  field-fallback tiers, payout conventions, error decoding — one copy, shared.

Frontend adoption leaves include strict `governance/validation` vote vectors,
`accounts/constants` (EntryPoint v0.7 and the existing Gnosis delegation default),
and explicitly historical `encoding/legacy-pointer` compatibility. Raw task
creation supports one atomic `buildCreateTasksBatchRaw` intent and an explicit
zero metadata sentinel; repeated identical creation drafts require host-attested
operation-scoped ordered logs to recover IDs. See the
[adoption guide](docs/frontend-adoption.md#small-adoption-apis) for examples and
the retained host configuration, receipt and deployment boundaries.

```
ethers ^5.7 is a peer dependency (viem + permissionless only if you use the
sponsored/4337 execution path — they are optional peers).
```

## Quickstart — reads

```ts
import { createPopContext } from '@poa-box/core';
import { resolveOrgModules } from '@poa-box/core/reads/resolve';
import { listTasks } from '@poa-box/core/reads/task';

const ctx = createPopContext({ chainId: 100 });          // Gnosis; zero config

const org = await resolveOrgModules(ctx.client, 'my-org'); // name or 0x… id
const tasks = await listTasks(ctx.client, org.orgId);
```

Reads are **subgraph-first** through a tiered transport: the free Graph Studio
endpoint first, automatic failover to the paid gateway (`GRAPH_API_KEY` via
`env`) when the free quota is spent, and **field-fallback tiers** that keep
queries working across the different subgraph deployments on Gnosis and
Arbitrum. Raw GraphQL documents stay exported (`@poa-box/core/graph/documents`) if
you'd rather run them through Apollo — you keep your cache, we keep the
documents canonical.

## Quickstart — writes

Building a transaction never signs or sends. Builders return a `TxIntent`:

```ts
import { createPopContext } from '@poa-box/core';
import { createTaskIntent } from '@poa-box/core/tx/task';

const ctx = createPopContext({ chainId: 100, provider });  // provider: feature detection
const intent = await createTaskIntent(ctx, {
  org: 'my-org',
  project: 'Ops',
  name: 'Write docs',
  description: 'Draft the treasury guide',
  payout: 25,                    // omit to derive from the org's payout convention
});
// intent = { to, abi, method, args, value?, meta: { summary, ipfs, … } }
```

Use the [executable host adapters](#native-value-in-host-adapters) below for
ethers, wagmi/viem, Safe, sponsored options or `executeIntentWithHost`. Each
alternative forwards exact native value and keeps execution options separate
from descriptive metadata. The built-in EOA executor is
`executeIntent` from `@poa-box/core/execute/ethers`.

Every builder has two levels:

- **`build*` (pure, sync)** — you supply resolved addresses and values, it
  returns the intent. Zero I/O; right for frontends that already hold org
  context.
- **`*Intent(ctx, params)` (resolved, async)** — resolves the org via
  subgraph, derives conventions (payout pricing, feature-gated calldata for
  v6/v7 TaskManagers), may pin metadata to IPFS through the injected adapter, then calls the pure builder. These resolved helpers can perform network side effects; choose pure builders for preview/offline use.

`meta.summary` on every intent carries human-readable preview fields for your
confirmation UI; `meta.ipfs` carries the pinned CID + document.

## Metadata is canonical here

The subgraph and every frontend parse metadata JSON **by exact key order**.
Never hand-build these objects — use `@poa-box/core/metadata/*`:

```ts
import { task } from '@poa-box/core/metadata';
const doc = task.buildTaskMetadata({ name, description, location, difficulty, estHours });
```

## Environment injection

Core never reads `process.env`. Hosts pass an `EnvSource` where env-derived
behavior is wanted:

```ts
// Node CLI
const ctx = createPopContext({ chainId: 100, env: process.env });

// Next.js
const ctx = createPopContext({
  chainId: 100,
  env: { GRAPH_API_KEY: process.env.NEXT_PUBLIC_GRAPH_API_KEY },
  graph: { stateStore: myLocalStorageStore },   // free-tier quota memory
  ipfs: { apiUrl: myPinningEndpoint },
});
```

Injection seams: `EnvSource` (endpoints, tier mode, API keys),
`TierStateStore` (subgraph quota pins — in-memory default, the CLI uses a
file, a browser can use localStorage), `IpfsOptions`, `fetch`, and `onWarn`.

## Module map

| Subpath | Contents |
|---|---|
| `@poa-box/core/chains` | chain table, env-injected RPC/subgraph resolution, token registry |
| `@poa-box/core/abis` | generated contract ABIs (`ALL_ABIS`), regenerated from forge artifacts |
| `@poa-box/core/graph/client` | tiered subgraph client (`GraphClient`) |
| `@poa-box/core/graph/documents` | GraphQL documents + pure derivation helpers, per domain |
| `@poa-box/core/reads/*` | typed reads: `resolve`, `task`, `org`, `vote`, `token`, `user`, `authority`, `treasury`, `paymaster`, `education`, `project`, `zkemail` |
| `@poa-box/core/tx/*` | `intent` (TxIntent/encodeIntent) + builders per domain, incl. `governance` (proposal wraps) |
| `@poa-box/core/execute/*` | `ethers` (EOA executor, error classification, 4337 inner-revert detection), `sponsored` (7702/4337 userop path) |
| `@poa-box/core/metadata/*` | canonical metadata builders (key order = protocol) |
| `@poa-box/core/payout`, `perms`, `zkemail`, `encoding`, `format`, `validation`, `multicall`, `error-catalog`, `preflight`, `version`, `task-lens`, `ipfs` | shared protocol logic |

Prefer subpath imports — the root barrel re-exports everything but pulls the
whole package into a bundle.

## Stability contract

- **Semver.** Compatible additive changes ship as patches. Renaming, removing, or moving
  an export is a breaking change. **While this package is on 0.x**, semver
  puts breaking changes in the MINOR position, so a break bumps `0.x → 0.(x+1)`
  and a patch (`0.x.y → 0.x.(y+1)`) is always safe — pin `~0.1.0` to get safe
  patches only. After 1.0.0 a break bumps the major, as usual. This matches
  [repository release policy](https://github.com/poa-box/poa-cli/blob/main/docs/RELEASING.md) exactly; the two documents are
  one policy.
- **Enforced.** `api-surface.json` records every export of every module;
  `yarn api:check` fails if any recorded export disappears (additions are
  allowed and recorded with `yarn api:update`, so they show up in review).
  Same policy as the CLI's `--json` output contracts.
- **Encoding parity.** `test/calldata-parity.test.ts` pins intent builders to
  the exact bytes the CLI has always broadcast; `test/purity.test.ts` pins
  browser purity.
- Frozen shapes: `TxIntent`, `TxResult`, error codes (`TX_REVERTED`,
  `INSUFFICIENT_FUNDS`, `NETWORK_ERROR`, `GAS_ESTIMATION_FAILED`, …), and all
  metadata document shapes.

## Not building in JS? Or building an AI agent?

This package is one of three integration surfaces (the others: the `pop` CLI
with `--json` for any language, and `pop mcp serve` for tool-calling AI
agents). Shared builders preserve their covered calldata and metadata contracts;
feature and deployed-version support differs across these surfaces. The
chooser + quickstarts for all three live in
[repository integrator guide](https://github.com/poa-box/poa-cli/blob/main/docs/guides/integrators.md).

## Relationship to the CLI and frontend

The `pop` CLI consumes this package for all shared logic (its `src/lib/*`
modules are thin wrappers binding `process.env` and the terminal), so core is
exercised by the CLI's full test suite on every change. The reference frontend
(`poa-app`) has the same layering (`src/services/web3/` with pluggable
transaction managers); migrating a service means adapting its
`txManager.execute(contract, method, args)` call to accept a `TxIntent` and
replacing the service internals with the corresponding `tx/<domain>` builders.

## Development

```bash
yarn build        # gen-abis (from ../../src/abi) + tsc → dist/
yarn test         # purity gate + calldata parity
yarn api:check    # exported-surface tripwire (run after build)
```

ABIs track the contracts repo's deployed `main` via the CLI's
`yarn sync-abis`; `scripts/gen-abis.mjs` derives the TS modules at every core
build, so the checked-in copies self-heal.

## Migrating from 1.0 to 2.0

Four historical `OrgUser` relations (`assignedTasks`, `completedTasks`,
`hybridProposalsCreated`, `modulesCompleted`) are now optional and nullable.
Authority-only users legitimately have no indexed historical row. Missing
history is unknown; it must not be replaced with an empty array or a zero total.
A present, indexed empty collection is known empty. Use optional access for a
partial view, or the narrowing helper when all historical arrays are required:

```ts
import { isIndexedOrgUser } from '@poa-box/core/reads/user';
import type { OrgUser } from '@poa-box/core/reads/user';
function assignedCount(user: OrgUser): number | null {
  return isIndexedOrgUser(user) ? user.assignedTasks.length : null;
}
```

Default `buildOrgDeployMetadata` calls and the legacy `OrgDeployMetadata` type
retain exact-null fields. Its overloads support supplied `requestTimeunit` and
`extensions`; `ReturnType<typeof buildOrgDeployMetadata>` describes the wider
new document and no longer guarantees those two fields are null. Consumers
using `ReturnType` must account for their supplied values. Raw organization
metadata merges now preserve extension keys named `id`, `indexedAt`,
`organization` and `__typename`; deliberate clearing follows the documented
field merge rules. These source and output corrections motivate 2.0.0.

Strict TypeScript consumers of the root/ethers executor require an explicit
`@types/node` **dev dependency** because ethers 5.7.2 declarations reference
`NodeJS` and Node types. Compile with `skipLibCheck: false`; no shim is needed.
This is a dependency typing prerequisite, not a Node runtime requirement.
`viem` and `permissionless` remain optional and absent from root/plain EOA
runtime and declaration closures. Install them only for `execute/sponsored`
or the `execute` aggregate. Dependency-free leaves such as `amounts`,
`data/facts`, `encoding/cid`, `graph/pagination`, `graph/sources` and
`sponsorship/budget` need neither ethers nor Node declarations. Supported
resolution modes include Node/classic, Node16 and bundler.

## Reusable frontend helpers

The new namespace shorthands below have explicit package exports and classic
TypeScript mappings. Every direct nested leaf remains supported. Prefer a leaf
when bundle size or optional dependency closure matters.

| Subpath | Contract |
|---|---|
| `amounts` | Exact decimal-string/raw-uint parsing, asset-qualified sums; never rounded Number money |
| `data`, `data/facts` | Known/unknown facts, source snapshots, coverage and ready/blocked plans |
| `graph/pagination`, `graph/sources` | Bounded ID cursor enumeration and explicit multi-source reduction |
| `encoding/cid` | Strict lightweight CID/digest conversion without ethers or ABI registry |
| `authority` | Current IDs, permission/context/group facts, activation and lifecycle plans |
| `email` | Scoped allowlist and proof/claim preparation; proving, signing and browser lifecycle stay with the host |
| `accounts` | Registration, credential, passkey and EntryPoint v0.7 codecs |
| `sponsorship` | Canonical subject/payload keys and exact prefund/epoch-budget calculations |
| `deployment` | Explicit version/module policy and guarded bootstrap plans |
| `tasks` | Task mutation policy and receipt event identity |
| `governance` | Capability, power, role/election planning with explicit scope/provenance |
| `treasury` | Asset-qualified plans, immutable distributions and inflow projection |
| `errors` | Existing error exports plus bounded revert envelopes and supplied diagnostic compatibility |
| `integrations/cashout` | Isolated external cashout schema; not aggregated into the core root |
| `reads/identity`, `reads/protocol` | Source-qualified identity/account/factory/protocol/history facts |
| `metadata/folders`, `metadata/distribution` | Folder metadata and verified immutable claims documents |
| `execute/outcome` | Expected hash/emitter receipt decoding with succeeded/failed/unknown outcomes |

Root exports aggregate the new pure namespaces except external integrations
and executors. Root still includes the historical ABI registry: bundle-sensitive
public read screens should use leaves and load wallet/optional actions lazily.

`Fact` preserves zero and false. Unknown facts have no value. A blocked plan
has no executable data. Collection completeness is transport evidence, not
proof of field population, live authority, freshness or deployed bytecode.
Pinned readers require matching same-response block proof on every page,
including the terminal empty page. A hash-qualified source sends the exact
hash selector; a requested hash is never copied into observations. Number-only
sources remain number-only when serving metadata has a null hash. Mixed page
proof, missing metadata, ignored block filters and contradictory installed
module bindings retain incomplete/unavailable evidence and block totals or
execution. Execute built-in documents and variables unchanged; never synthesize
metadata to make an unavailable reader appear complete. Serving credential
schemas may omit public keys; the exact capability fallback preserves unknown.

Intent adapters preserve exact native value, metadata separation and raw
receipts. Hosts own account/org/generation guards, caches, confirmation UI,
freshness, signing, persistence and refresh. Value-incapable hosts must refuse
positive value before submission. `decodeUserOperationOutcome` identifies the
expected EntryPoint and operation, and absence/conflict stays unknown. Sponsored
submission journals persist hashes before waiting; ambiguous dispatch is
reconciled without direct fallback or resend. The historical unscoped detector
is callable for compatibility; new safety decisions must supply identity.

New task absolute-cutoff handling follows the earliest positive expiry.
Paymaster HAT keys now use `keccak256(uint8 || bytes32)`. Metadata codecs retain
old key order/default bytes while exposing additional optional fields. Build
plans offline first; source helper checks do not establish deployed or frontend
adoption outcomes. No frontend/backend migration or live acceptance is implied
by this package candidate.

The packaged [frontend adoption guide](docs/frontend-adoption.md) supplies the
host-boundary checklist and domain map. Full lane contracts are available in
[repository package docs](https://github.com/poa-box/poa-cli/tree/main/packages/core/docs).


## Gap-closure candidate: indexed totals and recovery

These additions are available through the existing wildcard leaves and public
barrels. They do not establish frontend adoption or complete deployed history.

| Leaf | Barrel / root route | Contract |
|---|---|---|
| `reads/member-totals` | `reads.memberTotals` | `readCurrentMemberTotals`: distinct current member accounts, with accepted-seat reconciliation and system/root exclusions |
| `reads/token` | `reads.token` | `readTokenHolderTotals`: positive balances and raw sum reconciled against the same-block supply |
| `reads/education` | `reads.education` | `listAllCompletionsComplete`, `readEducationCompletionTotals`: all learners, completions and distinct learner accounts |
| `integrations/cashout` | `integrations` only | `readCashoutDiscovery`: bounded independent failed/recovered and deposited candidate streams |
| `reads/provenance` | `reads` | Exact canonical transaction proof, freshness and direct/single-operation call decoding |
| `governance/provenance` | `governance` | `readSubjectCreationProvenance`, `recoverSubjectCreationHistory`: exact-proposal creation intent; unknown remains unknown |
| `email/recovery` | `email` | Proof-gated legacy pending credential migration and existing-account restart guidance |
| `execute/recovery` | `execute`, root `submissionRecovery` | Durable record codec, owner/revision fences, exact EOA/UserOperation reconciliation; no transport or browser state |

`IndexedTotalOptions` is a public type from `data` and the root. Totals require
an explicit indexed endpoint/chain/organization/contract and a pinned block,
unchanged documents/variables, same-response block metadata, explicit `pageSize`
and `maxPages`, and complete evidence. Use `requireCompleteSnapshot` with the
expected scope/block before consuming known totals; retain each field's `Fact`
status. Exhausting the page budget, contradictory counters, missing rows or an
unavailable schema never becomes a zero. These are display snapshots, not live
write authorization. Education payout totals remain unknown because historical
payout amounts are not indexed; current module reward values cannot recover them.

Cashout discovery is an isolated external integration, deliberately absent from
the root. It requires the resolved wallet and exact relay descriptor/source,
validates the deployed single-relay universe, and pages by actual Bytes IDs.
`FAILED` and `RECOVERED` are both candidates; FIFO recovery matching is not a
proof that the individual balance is gone. The host must check pinned relay
getters and deposited receipts/getDeposit, preserve failed RPC evidence, and
keep the passkey initiation gate. `outstandingCount` stays unknown.

Native inflow/revenue completeness remains externally blocked. Recorded inflow
readers expose their documented event coverage only. Eventless Executor receives
and causal revenue are not proven by balances, new provider interfaces or an
undeployed indexer. Do not label those deployed-data gaps closed.

EOA reconciliation always requires `getTransaction`, `getTransactionReceipt`,
`getBlock` (canonical lookup by decimal block number) and `getChainId`.
Transactions must include exact chain/sender/nonce/to/input/value and matching
receipt inclusion number/hash. Canonical inclusion and receipt/chain identity
are rechecked before settlement. Missing fields or readers keep the barrier.
The host adapts actual ethers/viem RPC methods; use explicit `BigInt(number)` for
viem's block-number argument and preserve transaction `chainId`, `blockNumber`
and `blockHash`. The default missing-hash search reads at most 16 blocks from
the persisted pre-send block (configurable hard maximum 64). Outside this window,
`reconcileSubmissionRecovery(record, readers, { candidateTxHash })` safely checks
one explicit EOA hash without scanning, mutating the saved record, signing or
resending. Foreign sender/nonce/chain stays unknown; a different call consuming
the exact mined nonce is `replaced`, never original success. UserOperations settle
only from the expected hash/EntryPoint/sender/nonce event. RPC observations are a
host trust boundary, not a light-client proof; hosts choose confirmation depth.

The host owns atomic Web Locks, durable storage, browser lifecycle and a final
compare-and-clear under the lock. Re-read the current record and check the full
scope/owner/attempt/revision fence after every await; stale recovery must not
clear a newer record. Await journal acquisition/release and clear results.
Legacy records lacking call/source provenance remain unresolved, never guessed.
No timeout or absence authorizes a resend.

Historical recovery uses exact IDs/hashes and a bounded canonical proof, with
both selected and inclusion block checks. Hosts cap aggregate requests/cache by
scope and snapshot. Proof objects cannot be fabricated/copied into verified
provenance. Creation intent is not proof of execution or an assigned subject ID.
Email migration preserves the original audit record and never authorizes account
activation; missing original transaction/source/initiator evidence needs a
separately authenticated existing account, fresh proof and current invite state.

## Start with a reviewed role operation

Use the [role recipe](docs/role-operations.md), [agent guide](docs/agents.md) and
[static catalog](docs/operation-manifest.v1.json). The independent application in
[`examples/role-consumer`](https://github.com/poa-box/poa-cli/tree/main/examples/role-consumer) uses the same
five async functions as the frontend. Its default output is **synthetic**. Run its
verifier with an explicit candidate archive; neither fixture success nor an
exported reader proves that a deployed endpoint supplies the required facts.

The host owns account restoration, caching, cancellation, consent, unsigned
journals and wallet transport. Core owns protocol observation, planning and exact
continuation proof. Opaque reviews/prepared handles must be renewed after reload.

## Native value in host adapters

This executable example uses injected wallet objects. Each function is an
alternative transport; calling it sends through that host. `value` is raw native
wei, never a JavaScript Number. Execution options remain separate from metadata.
The sponsored import needs the optional viem/permissionless peers only on that path.

<!-- sdk-test:wallets -->
```js
import { encodeIntent, executeIntentWithHost } from '@poa-box/core/tx/intent';

export async function sendWithEthers(intent, signer) {
  const { to, data, value } = encodeIntent(intent);
  return signer.sendTransaction({ to, data, value });
}
export async function sendWithViem(intent, walletClient) {
  const { to, data, value } = encodeIntent(intent);
  return walletClient.sendTransaction({ to, data, value: BigInt(value) });
}
export async function sendWithWagmi(intent, writeContract) {
  return writeContract({ address: intent.to, abi: intent.abi,
    functionName: intent.method, args: intent.args,
    value: BigInt(encodeIntent(intent).value) });
}
export async function sendWithSafe(intent, safeSdk) {
  const { to, data, value } = encodeIntent(intent);
  return safeSdk.createTransaction({ transactions: [{ to, data, value }] });
}
export async function sendWithSponsored(intent, key, orgId, subjectId, options) {
  const { sendSponsored } = await import('@poa-box/core/execute/sponsored');
  const { to, data, value } = encodeIntent(intent);
  return sendSponsored(key, to, data, orgId, subjectId,
    { ...options, value: BigInt(value) });
}
export async function sendWithHost(intent, options, host) {
  return executeIntentWithHost(intent, options, host);
}
export async function sendWithValueCapability(intent, host) {
  const call = encodeIntent(intent);
  if (call.value !== '0' && host.supportsNativeValue !== true) {
    throw new Error('NATIVE_VALUE_TRANSPORT_UNSUPPORTED');
  }
  return host.send(call);
}
```
