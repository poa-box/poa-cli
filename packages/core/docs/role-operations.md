# Review, create, then configure a role

The role-operation facade is available starting in `@poa-box/core@2.1.0`.
Install that version with `ethers@5.7.2`, or use an explicit reviewed candidate
archive before publication. Use the
[independent consumer](https://github.com/poa-box/poa-cli/tree/main/examples/role-consumer) for an offline,
explicitly synthetic walkthrough. See the [catalog](operation-manifest.v1.json)
for machine-readable imports, states, units and side effects.

1. Supply public organization/chain/account/module scope, separate indexed/RPC
   endpoint identities, a scheduled read-only transport and integer Unix seconds.
   `readRoleOperationEvidence` defaults to `purpose: 'operation'` and observes only
   the requested branch. Missing facts,
   stale heads, exhausted finite budgets and inconsistent blocks remain unknown.
2. Call `reviewRoleOperation({ scope, sources, request, fetchDocument })` with an
   explicit `mode: 'create'`. Pass the full desired configuration. Review reads
   and may fetch a selected current allowlist, but never publishes or sends.
   Display `currentEffects`, `deferredEffects`, `consequences` and document digests.
   Staged creation never predicts a subject ID or scans allocation/proposal history.
3. After visible approval call `prepareRoleOperation`. Its trusted publisher gets
   `{ key, json, digest }`: digest is keccak256 of those exact UTF-8 bytes. It must
   record successful/uncertain publication before returning or throwing, return a
   valid CIDv0, and never substitute bytes. The CID is the adapter's attestation;
   a raw JSON digest does not prove an IPFS UnixFS/DAG content identity. Preparation
   reobserves before and after publication and returns a role batch, never a send.
4. Use existing metadata/governance helpers to enclose that batch. After any async
   proposal upload, revalidate immediately before handing it to the host wallet.
   The host retains the original exact batch and refuses stale/changed scope.
5. Persist the unsigned version-2 submission journal before dispatch/wait. A lost
   acknowledgment is uncertain. Reconcile the original exact call with
   `reconcileSubmissionRecovery`; do not send again. Missing hash discovery is
   bounded from the saved pre-send block or an explicit candidate, never history.
6. Supply the recovered exact creation reference to `readRoleOperationStatus`.
   Only `creation.state: 'created'` with `next: 'review-configuration'` permits
   `mode: 'existing'`, the proven actual `subjectId`, and that `continuation`.
   Same names/counters/saved IDs do not prove which subject was created.
7. Review and prepare configuration separately. Save its own transaction/batch
   reference and operation identity. Read status with both references until the
   separate configuration outcome is proven. Pending/unknown means wait; failed
   or rejected permits a deliberate new review only when the returned next action
   proves it safe. Outer transaction success never proves an inner operation.

Status binds the configuration to the actual subject from the exact creation
proof. The configuration must have a different proven proposal ID; separate
operations may share an outer bundle transaction. Every call is canonically
decoded against bound modules. Subject arguments, task grants, voting-class
membership, admin assignment and subject budgets must refer to that actual ID.
Shared sponsorship rules are accepted only with that subject's budget and the
supported exact selectors; an email claim budget must match the same budget terms.
Creation replay, foreign subjects, unsupported calls and unbound ancillary calls
remain unknown, retaining the independently proven creation in `observations`.

For an email allowlist configuration, supply the optional
`fetchDocument(cid, { signal }) => Promise<unknown | null>` on
`readRoleOperationStatus`. Status invokes it at most once, only after exact
transaction/proposal outcome proof. Core verifies the returned document against
the committed root and organization and requires a committed leaf for the actual
created subject. Missing/unavailable documents cannot produce completion. The
host owns fetch scheduling, cancellation and its deadline; status rechecks source
canonicality and freshness after the await. The callback is never a publisher.
JSON-reloaded unsigned creation/configuration references remain usable; no opaque
review handle or caller-asserted subject association replaces this proof.

Keep the original review's `requiresConfiguration` with the host draft/display
intent. The status reader cannot infer the original deferred intent: after proven
creation it reports `review-configuration` even when that review flag was false.
For a create-only request, the workflow is complete once the exact created proof
exists. `review-configuration` permits a separately reviewed stage when deferred
settings were requested; it does not instruct the host to submit an empty second vote.

Creation applies role name/details/cap or group composition. Permissions, people,
joining and sponsorship are deferred effects requiring the second review.
`mode: 'existing'` without a continuation is an explicit edit of an independently
observed subject, not recovery of an uncertain create. Advanced `mode: 'compound'`
retains bounded historical and allocation proof plus execution-race consequences.

For form options, call `readRoleOperationEvidence({ scope, sources, request,
purpose: 'capabilities' })`, even when the staged role name is blank. Core derives
the available task, voting-class, registry, sponsorship and email reads from the
explicitly bound modules in `scope.contracts`. Absent optional modules have no
module facts; a configured module's known `false` is retained, while unavailable
proof returns `unknown` with source facts. An email claim budget is configured
when its actual `epochLen` is nonzero, including a zero-cap budget. Without an
email module that budget is unknown/not requested, never an invented zero.

Capability evidence identifies `purpose: 'capabilities'`. It reads no subject
details, holder grants, email registration or proposal/allocation history, and
predicts no ID. It only describes current options: it cannot authorize a change,
prove creation or replace review. `reviewRoleOperation` omits `purpose` from its
public input and always forces strict `operation` evidence at runtime. Preparation
and final revalidation renew that strict review; status independently proves exact
transactions. Staged creation still reads only creation facts and defers optional
configuration. Never pass capability readiness to wallet transport.

All subject/project/proposal IDs and raw uint/native-wei values are decimal strings;
addresses are nonzero EVM addresses, permission/context keys are bytes32. A subject
ID may exceed Number precision. Duration is integer minutes; freshness uses seconds;
proposal metadata uses milliseconds. See `RoleConfigurationRequest` for canonical
fields (`capRaw`, `epochSeconds`, `delaySeconds`, booleans, class indexes).

Omitted existing metadata/image preserves the observed value; explicit empty
replacement clears it. A new metadata document and `metadataPointer` are mutually
exclusive. Creation defers email publication until configuration. Reviews and
prepared objects are immutable in-memory handles: JSON displays cannot be replayed
as authority. Renew review after reload and keep scoped unsigned records separately.

This executable envelope helper assumes the caller obtained approval and owns
journaling/locking, transport and receipts. `execute` is the only host handoff.

<!-- sdk-test:role-envelope -->
```js
import { reviewRoleOperation, prepareRoleOperation, revalidatePreparedRoleOperation }
  from '@poa-box/core/governance/role-operations';
import { buildProposalMetadata, serializeProposalMetadata }
  from '@poa-box/core/metadata/proposal';
import { buildGovernanceProposal } from '@poa-box/core/tx/governance';
import { ipfsCidToBytes32 } from '@poa-box/core/encoding';

export async function submitReviewedRole({ scope, sources, request, review,
  fetchDocument, publishDocument, publishProposalDocument, createdAt, isCurrent, execute }) {
  // review was already displayed and approved; never silently renew it here.
  const input = { scope, sources, review, currentRequest: request, fetchDocument, publishDocument };
  const prepared = await prepareRoleOperation(input);
  if (prepared.status !== 'ready') return prepared;
  const metadata = buildProposalMetadata({ description: 'Review the role change',
    optionNames: ['Yes', 'No'], createdAt });
  const { cid } = await publishProposalDocument(serializeProposalMetadata(metadata));
  const intent = buildGovernanceProposal({ votingAddress: scope.contracts.hybridVoting,
    votingAbiName: 'HybridVotingNew', title: 'Role change',
    descriptionHash: ipfsCidToBytes32(cid), durationMinutes: '1440', numOptions: 2,
    batches: [[...prepared.data.batch], []], orgId: scope.orgId });
  const final = await revalidatePreparedRoleOperation({ ...input, prepared: prepared.data });
  if (final.status !== 'ready') return final;
  if (!isCurrent()) return { status: 'stale' };
  return execute(intent); // host persists exact unsigned identity before dispatch
}
export { reviewRoleOperation };
```

`ready` proves only that function's current observation/review/batch. It is not
consent, future vote execution, durable identity or product/deployment parity.
`blocked` is a proven refusal; `unknown` is unavailable proof. Both retain diagnostic
facts/coverage and may retain publication receipts, but never an executable batch.
Abort errors may carry already known publication receipts. Store these, do not
blindly repeat uploads. Revalidation never publishes. No library operation signs,
broadcasts, retries publication, discovers an uncertain submission by history scan,
or owns React/cache/storage lifecycle.
