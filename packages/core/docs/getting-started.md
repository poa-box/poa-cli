# Start with the task you need

Core 2.1 supplies protocol reads, unsigned builders and reviewed role operations.
Your application keeps its UI, account, cache, approval, storage and wallet.
These follow-up recipes work with the published `@poa-box/core@2.1.0`; the new
recipe files are repository documentation, not a change to that immutable release.

Copy [`examples/role-consumer`](https://github.com/poa-box/poa-cli/tree/main/examples/role-consumer)
into a separate directory, with Node 18 or newer:

```sh
npm install --ignore-scripts
npm test
npm start
npm start -- --workflow-fixture
```

Its dependencies are exact registry `@poa-box/core@2.1.0` and `ethers@5.7.2`.
Both demos are explicitly synthetic: no real signing, sending or publication.
The workflow demo exercises the actual host controller with explicit approval,
unsigned persistence, lost-acknowledgment recovery and separate configuration.
For a blank application, use `npm install @poa-box/core@2.1.0 ethers@5.7.2`.
Prefer public subpath imports; you do not need frontend source or the POP CLI.

| Your task | Start here | Result and boundary |
|---|---|---|
| Find organization modules | `reads/resolve.resolveOrgModules` | Addresses or a failure; not current permission proof |
| Prepare a funded task | `tx/task.buildCreateTaskRaw` | Unsigned intent; explicit raw reward and deployed feature support |
| Prepare an informational poll | `tx/governance.buildGovernanceProposal` | Empty-batch DD intent; executing batches require Hybrid |
| Prepare a ballot | `governance/validation.requireValidVoteWeights`, then `tx/vote.buildVote` | Unsigned intent; current eligibility remains a separate read/gate |
| Create/configure a role | [Reviewed role recipe](role-operations.md) | Review → approval → prepare → approved host send → exact actual-ID proof → separate configuration |
| Resume an uncertain send | `execute/recovery.reconcileSubmissionRecovery` | Read-only original outcome; unknown keeps the barrier, never resend |

The [structured recipes](workflow-recipes.v1.json) and [schema](workflow-recipes.schema.json)
record the exact imports, input units, effects, result branches and executable
snippet names. They are instructions for a consumer, not a workflow engine.
The existing [role-operation catalog](operation-manifest.v1.json) remains unchanged.

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
