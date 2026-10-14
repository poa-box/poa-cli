# Adopting @poa-box/core 2.0 in a frontend

Core owns protocol encodings, canonical metadata, typed documents, exact
amounts and evidence-bearing planning. The host retains wallet UI, rendering,
identity hydration, caching and lifecycle state. Adoption is a separate product
change; a package test never closes a host or backend finding.

## Preserve the service boundary

Keep domain service APIs and route built intents through the existing manager.
Use `intentToExecutionRequest` / `executeIntentWithHost` from `tx/intent` for
exact value, arbitrary host options and raw receipt preservation. Supply the
scope guard and callback; account/org/chain/generation changes must suppress
stale results. A manager unable to send native value must reject positive value
before any send. Never flatten intent metadata into execution options.

Passkey and sponsored hosts can use `encodeIntent` for calldata. The codecs in
`accounts/codecs`, `accounts/userop-v07` and `sponsorship/codec` are pure. Browser
WebAuthn authentication, durable credential restoration, curve/key checks,
bundler transport, signing and gas policy remain host responsibilities. Load
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
