import { ethers } from 'ethers';
import type { Fact, SourceSnapshot } from '@poa-box/core/data/facts';
import { knownFact } from '@poa-box/core/data/facts';
import { requireRawUint } from '@poa-box/core/amounts';
import type { AuthorityMemberFact, AuthorityPermissionData } from '@poa-box/core/authority/permissions';
import { projectUserPermissions } from '@poa-box/core/authority/permissions';
import { AUTHORITY_KEYS, projectContext } from '@poa-box/core/tx/authority';
import { decideTaskActions, projectTaskPermissionMask, TaskPolicyFacts } from '@poa-box/core/tasks/policy';
import { parseTaskCreatedReceipt } from '@poa-box/core/tasks/receipts';
import { buildClaimTask, buildCompleteTask, buildCreateTaskRaw, CreateTaskRawArgs } from '@poa-box/core/tx/task';
import { buildTaskMetadata, requireTaskMetadataFinal, serializeTaskMetadata, TaskMetadataFields } from '@poa-box/core/metadata/task';
import { cidV0ToBytes32 } from '@poa-box/core/encoding/cid';
import { createOperationWorkflow } from './operation';
import { copy, freeze, known, moduleScope, nonzero, refuse, semantic, snapshot } from './shared';
import type { EvidenceReader, PublishedWorkflowDocument, WorkflowHost, WorkflowResult } from './types';

export type TaskWorkflowRequest = { action: 'create'; projectId: string;
  task: Omit<CreateTaskRawArgs, 'taskManagerAddress' | 'projectId' | 'orgId' | 'metadataHash' | 'features'>;
  metadata: TaskMetadataFields } | { action: 'claim' | 'complete'; projectId: string; taskId: string };
export interface TaskWorkflowEvidence {
  module: SourceSnapshot<{ paused?: Fact<boolean>; membershipAuthority: Fact<string>; executor: Fact<string>; deadlines: Fact<boolean> }>;
  /** taskId is required for actions on an existing task; create uses null. */
  policy: SourceSnapshot<TaskPolicyFacts & { taskId: string | null }>;
  authority: SourceSnapshot<AuthorityPermissionData>;
  /** Current authority pause from the verified indexed authority snapshot.
   * TaskManager deployments with no module pause getter must use this field. */
  authorityPaused?: Fact<boolean>;
  memberships: SourceSnapshot<readonly AuthorityMemberFact[]>;
}
export interface TaskWorkflowSummary { action: 'create' | 'claim' | 'complete'; projectId: string; taskId?: string; title?: string; payoutRaw?: string }
export function createTaskWorkflow(inputHost: WorkflowHost, reader: EvidenceReader<TaskWorkflowRequest, TaskWorkflowEvidence>) {
  const host = { ...inputHost, scope: freeze(copy(inputHost.scope)), sources: { ...inputHost.sources } };
  const manager = nonzero(host.scope.contracts.taskManager), authority = nonzero(host.scope.contracts.membershipAuthority);
  const scope = moduleScope(host.scope, manager, true), authorityScope = moduleScope(host.scope, authority, true);
  const createArgs = (request: Extract<TaskWorkflowRequest, { action: 'create' }>, metadataHash: string): CreateTaskRawArgs =>
    ({ ...request.task, taskManagerAddress: manager, projectId: request.projectId, metadataHash, features: { deadlines: true }, orgId: host.scope.orgId });
  const hash = (documents: readonly PublishedWorkflowDocument[]) => {
    const doc = documents.find(d => d.key === 'task-metadata'); if (!doc) refuse('PUBLISHED_METADATA_REQUIRED'); return cidV0ToBytes32(doc.cid);
  };
  return createOperationWorkflow<TaskWorkflowRequest, TaskWorkflowEvidence, TaskWorkflowSummary>(host, reader, {
    name: 'task',
    evaluate(request, evidence) {
      if (!['create', 'claim', 'complete'].includes(request.action)) refuse('UNSUPPORTED_TASK_ACTION');
      if (!ethers.utils.isHexString(request.projectId, 32)) refuse('PROJECT_ID_REQUIRED');
      const module = snapshot(evidence.module, { ...scope, account: undefined }, host.sources, false);
      if (known(module.membershipAuthority, evidence.module, { ...scope, account: undefined }).toLowerCase() !== authority.toLowerCase()
        || known(module.executor, evidence.module, { ...scope, account: undefined }).toLowerCase() !== nonzero(host.scope.contracts.executor).toLowerCase()) refuse('MODULE_BINDINGS_CHANGED', 'unknown');
      const data = snapshot(evidence.policy, scope, host.sources, true, evidence.module);
      if (request.action === 'create' ? data.taskId !== null : data.taskId === null || requireRawUint(data.taskId) !== requireRawUint(request.taskId)) refuse('TASK_SCOPE_MISMATCH', 'unknown');
      snapshot(evidence.authority, { ...authorityScope, account: undefined }, host.sources, true, evidence.module);
      snapshot(evidence.memberships, authorityScope, host.sources, true, evidence.module);
      if (evidence.authorityPaused) {
        if (!evidence.authorityPaused.source) refuse('AUTHORITY_PAUSE_SOURCE_REQUIRED', 'unknown');
        if (known(evidence.authorityPaused, evidence.authority, { ...authorityScope, account: undefined }) !== false) refuse('AUTHORITY_PAUSED');
      } else if (known(module.paused!, evidence.module, { ...scope, account: undefined }) !== false) refuse('MODULE_PAUSED');
      const permission = projectUserPermissions({ snapshot: evidence.authority, memberships: evidence.memberships,
        scope: authorityScope, permKey: AUTHORITY_KEYS.TM_PERMS, ctx: projectContext(request.projectId) });
      const projected = projectTaskPermissionMask(permission, request.projectId);
      // Core's user projection retains the account-neutral authority source.
      // This workflow has independently verified the complete membership
      // snapshot for this actor at the identical canonical block.
      const permissionMask = projected.source ? { ...projected, source: { ...projected.source, account: host.scope.account } } : projected;
      const executor = knownFact(known(module.executor, evidence.module, { ...scope, account: undefined }).toLowerCase() === host.scope.account.toLowerCase());
      const policy = { ...data, executor, permissionMask };
      const decision = decideTaskActions({ projectId: request.projectId, scope, now: Number(evidence.module.source.block!.timestamp),
        snapshot: { ...evidence.policy, data: policy } })[request.action];
      if (decision.state !== 'allowed') refuse(`TASK_${decision.reasons[0] ?? 'POLICY_UNAVAILABLE'}`, decision.state === 'unknown' ? 'unknown' : 'blocked');
      if (request.action === 'create') {
        if (known(module.deadlines, evidence.module, { ...scope, account: undefined }) !== true) refuse('CURRENT_TASK_SIGNATURE_REQUIRED');
        buildCreateTaskRaw(createArgs(request, ethers.constants.HashZero));
        const metadata = requireTaskMetadataFinal(buildTaskMetadata(request.metadata));
        if (metadata.name !== request.task.title) refuse('TASK_METADATA_TITLE_MISMATCH');
        const json = serializeTaskMetadata(metadata);
        return { binding: semantic({ policy, authority: evidence.authority.data, members: evidence.memberships.data }),
          summary: { action: request.action, projectId: request.projectId, title: request.task.title, payoutRaw: requireRawUint(request.task.payoutRaw) },
          documents: [{ key: 'task-metadata', json, digest: ethers.utils.id(json) }] };
      }
      return { binding: semantic({ policy, authority: evidence.authority.data, members: evidence.memberships.data }),
        summary: { action: request.action, projectId: request.projectId, taskId: requireRawUint(request.taskId) } };
    },
    build(request, _evidence, documents) {
      if (request.action === 'create') return buildCreateTaskRaw(createArgs(request, hash(documents)));
      return (request.action === 'claim' ? buildClaimTask : buildCompleteTask)({ taskManagerAddress: manager, taskId: requireRawUint(request.taskId), orgId: host.scope.orgId });
    },
    outcome(request, receipt, documents): WorkflowResult {
      if (request.action !== 'create') return { status: 'confirmed', data: { taskId: request.taskId, transactionHash: receipt.transactionHash } };
      const iface = new ethers.utils.Interface(buildCreateTaskRaw(createArgs(request, ethers.constants.HashZero)).abi);
      const topic = iface.getEventTopic('TaskCreated');
      const events = (receipt.logs ?? []).filter(log => log.address.toLowerCase() === manager.toLowerCase() && log.topics[0] === topic);
      if (events.length !== 1) return { status: 'unknown', codes: ['TASK_CREATION_EVIDENCE_REQUIRED'] };
      const metadataHash = hash(documents);
      const ids = parseTaskCreatedReceipt({ taskManagerAddress: manager, status: 1, logs: receipt.logs ?? [],
        creations: [{ projectId: request.projectId, payoutRaw: request.task.payoutRaw, title: request.task.title, metadataHash,
          bountyToken: request.task.bountyToken ?? ethers.constants.AddressZero, bountyPayoutRaw: request.task.bountyPayoutRaw ?? '0', requiresApplication: request.task.requiresApplication ?? false }] });
      if (ids.state === 'unknown') return { status: 'unknown', codes: [ids.code] };
      return { status: 'confirmed', data: { taskId: ids.value[0], transactionHash: receipt.transactionHash } };
    },
  });
}
