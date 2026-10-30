# Integrating core browser modules

Use the same `@poa-box/core` installation beneath the application's service boundary. Keep UI,
wallet selection, cache ownership, refresh events and branding in the application.
Keep core protocol builders and policy checks in `@poa-box/core`. Do not copy the
reference frontend's provider tree or recreate calldata in page components.

## Configure once and diagnose explicitly

The configuration module reports `available`, `misconfigured`, `unavailable`,
`unknown` and `unsupported` setup states. Every result includes
`authorization: false`: availability does not establish permission or consent.
A configured address is not proof that a module exists or belongs to the selected
organization. Operation readers and policies perform those stronger checks.

<!-- browser-test:configuration -->
```js
import { checkBrowserConfiguration } from '@poa-box/core/browser/config';

export function inspectSetup(configuration, capabilities) {
  return checkBrowserConfiguration(configuration, capabilities);
}
```

`BrowserConfiguration` contains `chainId`, optional `orgId`, named `endpoints`,
`modules`, the resolved wallet identity and passkey `rpId`/`rpName`/`origin`.
`detectBrowserCapabilities` checks API presence without opening credentials or
storage. `diagnoseBrowserConfiguration` accepts explicit read-only reader ports
for chain, indexing status, bytecode and service health. Bind those ports to the
configured endpoints. It has a five-second default budget (maximum thirty
seconds), propagates cancellation and redacts endpoint values and thrown messages.
Unavailable probes remain unknown; a wrong chain is unavailable. Health checks
never replace an exact transaction simulation or current permission checks.

Module names are `membershipAuthority`, `taskManager`, `directDemocracyVoting`,
`hybridVoting`, `executor`, `accountRegistry`, `passkeyFactory`, `quickJoin` and
`zkEmailInvites`. Endpoints are `rpc`, `indexer`, `bundler`, `metadata` and `email`.
Use HTTPS except explicit localhost development. Do not put secret pinning or
proof-service credentials in the browser configuration; use your own authenticated
service boundary where a service requires secrets.

## Passkeys

`createPasskeyClient({ rpId, rpName, origin, ...ports })` exposes creation,
discovery, assertion and signing helpers. The default ceremony adapter uses native
`navigator.credentials` only when called; an injected adapter can use the host's
existing `startRegistration` and `startAuthentication` functions. Pass the signal
to cancel work. User cancellation never causes a second prompt. A specifically
identified RP mismatch can use the documented hostname fallback; unrelated errors
cannot.

Configure the expected origin and RP ID explicitly for every deployed frontend.
A local related-origin list is not browser authorization to use that RP. The
browser must accept its origin/RP policy. Preserve credential identity across
lookup and account restoration. Registered public keys must match the selected
credential, factory and chain; saved local records cannot supply missing proof.
The helpers reject malformed client data, wrong challenge/type/origin/RP,
missing user-presence/user-verification flags, malformed P-256 keys and invalid
signature encodings. The contract still verifies the cryptographic assertion
before an action succeeds.

Credential-store adapters preserve the reference frontend's historical keys and
pending/recovery pointers. They store public credential material and hints, not
private keys or signed operations. The unsigned operation journal rejects signed
payload fields and enforces atomic compare-and-swap writes under an account lock.
Different application databases need a deliberate shared lock namespace when they
can act on the same account within one origin.

## Wallet and submission boundaries

The EIP-1193 adapter takes an already selected provider; it never opens a connection
modal. All asynchronous population, gas and identity checks precede the final
review callback. The last synchronous scope/ownership guard is followed directly
by `eth_sendTransaction`. Values and nonces remain exact decimal strings or
hex quantities; never route them through JavaScript `Number`.

For an existing ethers service, `guardedRpcSigner` preserves contract receipt,
event, replacement and wait behavior using a request-local provider. Disposing a
bridge prevents further sends. The application's shared provider is unchanged.

The sponsored/passkey adapter supports **EntryPoint v0.7** through explicit
account-encoding, preparation, signing, nonce, bundler-dispatch and recovery ports.
It is not a hosted bundler or a universal account implementation. Account-specific
encoding and sponsorship services must be supplied and tested. Preparation is unsigned. The adapter requires separate `beforeSign` and
`beforeSend` guards; built-in workflows provide both after explicit approval.
Signing data stays in memory. A computed UserOperation hash, sender, nonce and EntryPoint identify
an uncertain operation; they must never be relabeled as an EOA transaction hash.
The workflow transport distinguishes both kinds, and confirms exact inner success.

When ownership is lost, sessions and leases become invalid and pending IndexedDB
transactions are aborted. The final send callback checks ownership again after
all awaited setup. No timeout, tab closure or storage exception clears an
uncertain-operation barrier automatically.

## Workflows and evidence

Polls are informational: no executable batches. Ballots support DD and Hybrid
policy and weight rules. Tasks cover create, claim and complete using current
project/task authority. Enrollment covers atomic account registration plus
QuickJoin with a separate registration-signature approval; email proving and
legacy multitransaction registration are separate integrations. Roles retain
actual created-subject proof and separately reviewed configuration.

Each factory takes a `WorkflowHost` and a typed evidence reader. The host provides
`workflowId`, exact `scope`, source endpoints and clock, `wallet`, `journal`,
`isCurrent`, `confirm`, `simulate`, and optional `documents`. A single factory
instance and its opaque review/preparation handles belong to the active scope.
Do not serialize those handles as authorization. Persist only the unsigned journal
and original draft, then renew review from current evidence after a reload.

For authority-bound V2 deployments, use `createWorkflowReaders` to assemble these
observations. It accepts an ethers-compatible read provider and the core's
`ProtocolQuery` port bound to the configured indexed endpoint. It checks the real
indexed block against RPC, organization/module bindings, complete pagination,
canonical freshness, actual task lens data and immutable proposal configuration.
It returns `poll`, `ballot`, `task`, `enrollment` and `simulate` ports. Unsupported
schemas, ambiguous implementation capabilities and incomplete observations fail
closed. Limits and cancellation keep reads bounded. Legacy deployments need an
explicitly supported custom evidence adapter; selecting `authority-v2` does not
upgrade a deployment.

This complete assembly function is tested against the installed archive. The host
supplies its own approval UI and metadata service; construction and review do not
publish, sign or broadcast.

<!-- browser-test:poll-controller -->
```js
import { createWorkflowReaders } from '@poa-box/core/browser/observations';
import { createPollWorkflow } from '@poa-box/core/workflows';

export function createPollController({ workflowId, connection, scope, sources,
  provider, query, confirm, documents }) {
  const active = connection.session.capture();
  if (active.scope.chainId !== scope.chainId ||
      active.scope.accountAddress !== scope.account.toLowerCase()) {
    throw new Error('CONNECTED_ACCOUNT_SCOPE_MISMATCH');
  }
  const readers = createWorkflowReaders({ deployment: 'authority-v2',
    scope, sources, provider, query });
  return createPollWorkflow({ workflowId, scope, sources,
    wallet: connection.wallet, journal: connection.journal,
    isCurrent: active.isCurrent, confirm, documents,
    simulate: readers.simulate }, readers.poll);
}
```

Use a stable `workflowId` for the same draft across reloads. Call `review(request)`
and render its summary and documents. If ready, call `prepare({review: result.data})`,
which requests publication approval, then `submit({prepared: result.data})`, which
requests send approval. Each stage may return blocked or unknown; show its codes
instead of advancing. After pending/unknown submission, call `recover()` on that
same workflow ID. Do not create a fresh workflow to bypass its unresolved journal.
Use `createBallotWorkflow(host, readers.ballot)` or
`createTaskWorkflow(host, readers.task)` for those operations; enrollment additionally
requires an explicit registration-signing port. Role creation uses
`createRoleWorkflow` with its core `RoleEvidenceSources` (RPC and indexed ports)
and retains the distinct creation/configuration lifecycle described by its types.

An evidence reader provides actual source snapshots, not authorization booleans.
Built-in workflows check canonical block alignment, source scope, coverage,
freshness, module bindings, authority, task/voting policy and exact input identity.
Simulation is a read-only `eth_call` for the actual from/to/data/value at the
selected canonical block. It returns a pinned snapshot containing the exact core
`submissionIntentKey` and a known success fact. A successful simulation predicts
that the call will not revert; it does not replace the permission checks.

The operation journal associates publication receipts with the exact submitted
stage, so editing an unsent draft cannot later reconcile against earlier metadata.
It retains unresolved publication and submission identities. Recovery is read-only
apart from updating those unsigned records under the same lock. Known successful
receipt proofs are rechecked canonically, including the exact UserOperation when
bundled. No automatic resend follows an unknown result.

## Units and supported limits

- Chain IDs and option indices are safe integers; role/task/proposal IDs and
  nonces are exact decimal strings. Project and organization IDs are bytes32.
- Native value is wei. Reward/bounty amounts use the selected asset's base units.
- Ballot weights are integer percentages summing to 100; options are zero-based.
- Review freshness and enrollment deadlines use Unix seconds; proposal metadata
  creation time uses Unix milliseconds. Poll duration uses integer minutes.
- Sponsor policy, email proof infrastructure, deployed factory/verifier wiring,
  native-history completeness and index backfills remain external responsibilities.
- Passkey cash-out initiation is not enabled by this package. Eventless native
  history is not represented as a complete balance or causal revenue history.

The machine-readable catalog describes these boundaries for coding agents. A
package export is never sufficient evidence of a deployed feature or permission.
