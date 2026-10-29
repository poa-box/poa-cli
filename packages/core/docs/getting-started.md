# Start with the task you need

The `@poa-box/core@2.2.0` candidate includes protocol APIs and optional browser
runtime modules in one installation. Your application keeps its UI, provider
selection, account hydration and visible approval. Use the reviewed core `.tgz`
until 2.2.0 is published; after publication:

```sh
npm install @poa-box/core@2.2.0 ethers@5.7.2
```

For a browser application, start with the [browser guide](browser.md) and
[integration guide](browser-integration.md). `@poa-box/core/browser/observations`
assembles pinned evidence through injected indexed/RPC clients;
`@poa-box/core/workflows` provides review, preparation, explicit approvals,
submission and recovery for supported operations. Wallet, passkey, storage,
session and setup adapters use `@poa-box/core/browser/*`. Choose the leaves you
need; there is no second runtime package or version pin.

The [independent consumer](https://github.com/poa-box/poa-cli/tree/main/examples/role-consumer)
contains synthetic, network-free demonstrations. Verify it against the reviewed
archive before integrating a deployment. The protocol and browser consumer
verifiers must receive the same archive:

```sh
node packages/core/scripts/verify-packed-consumer.mjs PATH_TO_CORE_TGZ
node packages/core/scripts/verify-browser-consumer.mjs PATH_TO_CORE_TGZ
```

| Your task | Start here | Result and boundary |
|---|---|---|
| Find organization modules | `reads/resolve.resolveOrgModules` | Addresses or a failure; not current permission proof |
| Prepare a funded task | `tx/task.buildCreateTaskRaw` | Unsigned intent; explicit raw reward and deployed feature support |
| Prepare an informational poll | `tx/governance.buildGovernanceProposal` | Empty-batch DD intent; executing batches require Hybrid |
| Prepare a ballot | `governance/validation.requireValidVoteWeights`, then `tx/vote.buildVote` | Unsigned intent; current eligibility remains a separate read/gate |
| Run supported browser operations | `workflows`, with `browser/observations` | Reviewed evidence, explicit approval, wallet/journal boundaries and exact recovery |
| Create/configure a role | [Reviewed role recipe](role-operations.md) | Actual-ID proof and separate configuration approval |
| Resume an uncertain send | `execute/recovery.reconcileSubmissionRecovery` or workflow `recover()` | Read-only original outcome; unknown keeps the barrier |

The [structured unsigned recipes](workflow-recipes.v1.json) and
[schema](workflow-recipes.schema.json) remain compatible with published core
2.1.0. Their minimum version describes those protocol functions, not the new
2.2.0 runtime. The [role-operation catalog](operation-manifest.v1.json) retains its
version-1 shape; the [browser feature catalog](browser-features.v1.json) describes
the optional runtime in the 2.2.0 candidate.

## Copy the unsigned preparation boundary

The following functions are executable examples. Inputs come from your resolved
organization, reviewed form and trusted deployment configuration. No function
in this block owns a wallet or publisher. The task's `features` must describe the
selected deployed TaskManager; setting a flag is not feature detection.

<!-- sdk-test:task-recipes -->
```js
import { resolveOrgModules } from '@poa-box/core/reads/resolve';
import { buildCreateTaskRaw } from '@poa-box/core/tx/task';
import { buildGovernanceProposal } from '@poa-box/core/tx/governance';
import { buildVote } from '@poa-box/core/tx/vote';
import { requireValidVoteWeights } from '@poa-box/core/governance/validation';
import { reviewRoleOperation } from '@poa-box/core/governance/role-operations';
import { reconcileSubmissionRecovery } from '@poa-box/core/execute/recovery';

export function prepareTask(input) {
  return buildCreateTaskRaw(input);
}
export function preparePoll({ votingAddress, title, descriptionHash,
  durationMinutes, numOptions, subjectIds = [], orgId }) {
  return buildGovernanceProposal({ votingAddress, votingAbiName: 'DirectDemocracyVotingNew',
    title, descriptionHash, durationMinutes, numOptions, subjectIds, orgId, batches: [] });
}
export function prepareVote(input) {
  const vector = requireValidVoteWeights(input.weights, input.optionIndices);
  return buildVote({ ...input, weights: [...vector.weights], optionIndices: [...vector.optionIndices] });
}
export { resolveOrgModules, reviewRoleOperation, reconcileSubmissionRecovery };
```

`projectId` in a TaskManager call is bytes32. Subject/proposal IDs are exact
uint256 decimal strings. `payoutRaw` is the participation asset's raw base units;
`bountyPayoutRaw` uses the selected bounty asset's decimals. Native `intent.value`
is a different quantity: raw native wei. Never convert these or IDs to Number.
Vote option indices are zero-based safe integers; weights are integer percentages
summing to 100. Poll duration is integer minutes; deadlines/freshness use Unix
seconds; proposal metadata `createdAt` uses Unix milliseconds.

Task metadata accepts an explicit zero bytes32 for no document. Otherwise build
canonical metadata with `metadata/task` or `metadata/proposal` and store the exact
serialized bytes through your trusted publisher after approval. An unsigned
builder does not upload for you. Review the deployed permission/funding/eligibility
facts before a real send; preparation is not authorization.

## Connect the host you already have

See the example's [`src/workflow.mjs`](https://github.com/poa-box/poa-cli/blob/main/examples/role-consumer/src/workflow.mjs)
and adapters for one concrete host boundary.
`createRoleWorkflow` receives explicit `scope`, `sources`, `wallet`, `journal`,
`documents`, `confirm` and `isCurrent` capabilities. Its methods separate
capabilities, review, preparation, submission, read-only recovery and continuation.
Publication and sending require separate visible approvals. Refusal, cancellation,
failed persistence, stale scope or unknown evidence prevents dispatch.

Use the [wallet examples](../README.md#native-value-in-host-adapters) to carry
exact native value. The Safe example prepares an unsigned transaction only;
Safe approval/signing/execution are subsequent host steps. A host that cannot
carry positive native value must refuse it before dispatch. Preserve metadata as
descriptive data, execution options separately and the original raw receipt.

Persist unsigned call/nonce/hash identity under an exclusive account lock before
dispatch. After timeout or reload, recover that exact record without resending.
Recheck account, chain, scope and evidence after awaited setup and immediately
before the wallet handoff. An outer mined receipt cannot prove a selected inner
operation succeeded. For staged roles, keep the original desired settings and
`requiresConfiguration`; prove the actual created subject, then review configuration
separately. Never infer an ID from a name or counter.

For existing applications, the [frontend adoption checklist](frontend-adoption.md)
explains the retained host boundaries in detail. For coding agents, see
[agents.md](agents.md). The repository's archive verifier is a release check, not
an installation prerequisite for this registry starter.
