import { readRoleOperationEvidence, reviewRoleOperation, prepareRoleOperation,
  revalidatePreparedRoleOperation, readRoleOperationStatus } from '@poa-box/core/governance/role-operations';
import { readAuthoritySnapshot, authorityAccountMembershipFacts } from '@poa-box/core/reads/authority';
import { resolveOrgModules } from '@poa-box/core/reads/resolve';
import { projectUserPermissions, resolvePermissionContext } from '@poa-box/core/authority/permissions';
import { knownFact, unknownFact } from '@poa-box/core/data/facts';
import { buildProposalMetadata, serializeProposalMetadata } from '@poa-box/core/metadata/proposal';
import { buildGovernanceProposal } from '@poa-box/core/tx/governance';
import { encodeIntent } from '@poa-box/core/tx/intent';
import { ipfsCidToBytes32 } from '@poa-box/core/encoding';
import { createSubmissionRecovery, transitionSubmissionRecovery, normalizeSubmissionRecovery,
  reconcileSubmissionRecovery, submissionIntentKey } from '@poa-box/core/execute/recovery';

export function ready(result) {
  if (result.status !== 'ready') throw new Error(JSON.stringify({ status: result.status, codes: result.codes }));
  return result.data;
}
export async function readOrganizationAndPermissions(adapter) {
  const { scope, sources } = adapter;
  const organization = await resolveOrgModules(adapter.client, scope.orgId, scope.chainId);
  const evidence = await readRoleOperationEvidence({ scope, sources, request: adapter.request });
  if (evidence.status !== 'ready') return { organization, evidence };
  const authority = evidence.data.authoritySnapshot;
  const memberships = authorityAccountMembershipFacts(authority, scope.account);
  const permission = projectUserPermissions({ snapshot: authority, memberships,
    scope: { chainId: scope.chainId, orgId: scope.orgId, contract: scope.contract, account: scope.account },
    permKey: adapter.permissionKey, ctx: adapter.zero });
  return { organization, evidence, permission };
}

/** Existing helpers construct the envelope; the final shared read gate precedes
 * the host handoff. This does not implement a protocol planner in the example. */
export async function prepareStage(adapter, request, { afterEnvelope, handoff } = {}) {
  const { scope, sources } = adapter;
  const review = await reviewRoleOperation({ scope, sources, request });
  if (review.status !== 'ready') return { result: review };
  const input = { scope, sources, review: review.data, currentRequest: request, publishDocument: adapter.publishDocument };
  const preparation = await prepareRoleOperation(input);
  if (preparation.status !== 'ready') return { review: review.data, result: preparation };
  const prepared = preparation.data;
  const doc = buildProposalMetadata({ description: 'Synthetic role change', optionNames: ['Yes', 'No'], createdAt: sources.now() * 1000 });
  const { cid } = await adapter.publishProposalDocument(serializeProposalMetadata(doc));
  const intent = buildGovernanceProposal({ votingAddress: scope.contracts.hybridVoting, votingAbiName: 'HybridVotingNew',
    orgId: scope.orgId, title: 'Role change', descriptionHash: ipfsCidToBytes32(cid), durationMinutes: '1440',
    numOptions: 2, batches: [[...prepared.batch], []] });
  await afterEnvelope?.();
  const result = await revalidatePreparedRoleOperation({ ...input, prepared });
  if (result.status !== 'ready') return { review: review.data, result };
  await handoff?.(intent);
  return { review: review.data, result, intent };
}

/** Illustrative single-host persistence seam. A production host must hold its
 * account lock and atomically fence owner/attempt/revision in durable storage. */
export async function dispatchFixture(adapter, stage, intent) {
  const call = encodeIntent(intent), key = submissionIntentKey([call]);
  let saved = JSON.stringify(createSubmissionRecovery({ chainId: adapter.scope.chainId,
    accountAddress: adapter.scope.account, intentKey: key, contextKey: submissionIntentKey([{ ...call, data: '0x' }]),
    sessionKey: key }, 'synthetic-host', stage));
  const transition = event => {
    const record = normalizeSubmissionRecovery(JSON.parse(saved));
    saved = JSON.stringify(transitionSubmissionRecovery(record, record, event));
  };
  transition({ type: 'prepare', kind: 'transaction', nonce: stage === 'creation' ? '0' : '1',
    callKey: key, fromBlock: String(adapter.config.block.number) });
  transition({ type: 'broadcast' }); // persist the barrier before the one fake send
  try { const txHash = await adapter.send(call, stage); transition({ type: 'acknowledge', txHash }); }
  catch (error) {
    transition({ type: 'unresolved' });
    if (error.message !== 'SYNTHETIC_LOST_ACKNOWLEDGMENT') throw error;
  }
  const reloaded = normalizeSubmissionRecovery(JSON.parse(saved));
  const recovered = await reconcileSubmissionRecovery(reloaded, adapter.recoveryReaders, { maxBlocks: 16 });
  if (recovered.outcome.status !== 'succeeded') return { saved: reloaded, recovery: recovered.outcome };
  // Retain the independently recovered hash in the durable unsigned record.
  saved = JSON.stringify(normalizeSubmissionRecovery({ ...reloaded, txHash: recovered.outcome.txHash }));
  transition({ type: 'settle', status: 'succeeded' });
  return { saved: normalizeSubmissionRecovery(JSON.parse(saved)), recovery: recovered.outcome, transactionHash: recovered.outcome.txHash };
}

export async function runFixtureStory(adapter) {
  if (adapter.config.synthetic !== true) throw new Error('SYNTHETIC_ADAPTER_REQUIRED');
  const reads = await readOrganizationAndPermissions(adapter);
  ready(reads.evidence);
  const creation = await prepareStage(adapter, adapter.request);
  const creationBatch = ready(creation.result).batch;
  const first = await dispatchFixture(adapter, 'creation', creation.intent);
  if (!first.transactionHash) throw new Error('ORIGINAL_SUBMISSION_UNRESOLVED');
  const creationRef = { transactionHash: first.transactionHash, call: creationBatch[0] };
  const status = ready(await readRoleOperationStatus({ scope: adapter.scope, sources: adapter.sources, creation: creationRef }));
  if (status.next !== 'review-configuration' || status.creation.state !== 'created') throw new Error('ACTUAL_ID_NOT_PROVEN');
  const configurationRequest = { ...adapter.request, mode: 'existing', subjectId: status.creation.subjectId, continuation: creationRef };
  const configuration = await prepareStage(adapter, configurationRequest);
  const configurationBatch = ready(configuration.result).batch;
  const second = await dispatchFixture(adapter, 'configuration', configuration.intent);
  if (!second.transactionHash) throw new Error('CONFIGURATION_UNRESOLVED');
  const outcome = await readRoleOperationStatus({ scope: adapter.scope, sources: adapter.sources, creation: creationRef,
    configuration: { transactionHash: second.transactionHash, batch: configurationBatch } });
  return { synthetic: true, label: adapter.config.label, organization: reads.organization, permission: reads.permission,
    creation: { review: { mode: creation.review.mode, preview: creation.review.preview, deferredEffects: creation.review.deferredEffects },
      batch: creationBatch, recovery: first, status },
    configuration: { batch: configurationBatch, recovery: second, outcome },
    trace: adapter.trace };
}

export { readAuthoritySnapshot, resolvePermissionContext, knownFact, unknownFact };
