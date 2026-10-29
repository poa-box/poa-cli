import { ethers } from 'ethers';
import { getAbi } from '@poa-box/core/contracts';
import { knownFact, unknownFact, requireCompleteSnapshot, Fact, SourceBlock, SourceRef } from '@poa-box/core/data/facts';
import { readIndexedSingletonFacts } from '@poa-box/core/reads/protocol';
import { readWorkPageFacts, projectManagerFact, validateWorkProject } from '@poa-box/core/reads/project';
import { listTaskApplicationsComplete, projectTaskApplicant, taskEntityId } from '@poa-box/core/reads/task';
import { decodeTaskInfo } from '@poa-box/core/task-lens';
import { EIP1967_BEACON_SLOT, EIP1967_IMPLEMENTATION_SLOT, featuresFromBytecode } from '@poa-box/core/version';
import type { TaskPolicyFacts } from '@poa-box/core/tasks/policy';
import type { TaskWorkflowEvidence, TaskWorkflowRequest } from '../workflows/tasks';
import type { EvidenceReader } from '../workflows/types';
import { address, fail, ObservationRuntime, uint } from './common';
const FIELDS = 'id projectId deleted taskManager { id organization { id } }';
const TARGET = `query WorkflowTaskTarget($orgId: Bytes!, $taskManager: String!, $taskManagerBytes: Bytes!, $projectId: Bytes!, $taskId: String!, $block: Block_height!) {
  organization(id: $orgId, block: $block) { id taskManager { id organization { id } } }
  projects(where: { taskManager: $taskManager, projectId: $projectId, deleted: false }, first: 2, block: $block) { ${FIELDS} }
  tasks(where: { id: $taskId, taskManager: $taskManagerBytes }, first: 2, block: $block) {
    id taskId taskManager project { ${FIELDS} } status assignee requiresApplication absoluteDeadline claimDeadline
  }
  _meta(block: $block) { hasIndexingErrors block { number hash timestamp } }
}`;
const MANAGERS = `query WorkflowTaskManagers($orgId: Bytes!, $project: String!, $cursor: String!, $first: Int!, $block: Block_height!) {
  organization(id: $orgId, block: $block) { id taskManager { id organization { id } } }
  projectManagers(where: { project: $project, isActive: true, id_gt: $cursor }, first: $first, orderBy: id, orderDirection: asc, block: $block) {
    id manager isActive project { ${FIELDS} }
  }
  _meta(block: $block) { hasIndexingErrors block { number hash timestamp } }
}`;
const statuses: Record<string, number> = { Open: 0, Assigned: 1, Submitted: 2, Completed: 3, Cancelled: 4 };
function slotAddress(word: string): string | null {
  if (!/^0x[\da-f]{64}$/i.test(word)) fail('IMPLEMENTATION_SLOT_UNAVAILABLE');
  if (!/^0x0{24}/i.test(word)) fail('IMPLEMENTATION_SLOT_UNAVAILABLE');
  return BigInt(word) === 0n ? null : address(`0x${word.slice(-40)}`);
}
async function deadlines(runtime: ObservationRuntime, block: SourceBlock, signal: AbortSignal): Promise<Fact<boolean>> {
  const source = runtime.source(runtime.scope.contracts.taskManager, false, block, 'workflow-task-implementation');
  const provider = runtime.options.provider;
  if (!provider.getStorageAt || !provider.getCode) return unknownFact('TASK_FEATURE_READ_PORTS_REQUIRED', source);
  try {
    const proxy = runtime.scope.contracts.taskManager, tag = Number(block.number);
    const [beaconWord, implementationWord] = await Promise.all([
      provider.getStorageAt(proxy, EIP1967_BEACON_SLOT, tag), provider.getStorageAt(proxy, EIP1967_IMPLEMENTATION_SLOT, tag),
    ]); runtime.guard(signal);
    const beacon = slotAddress(beaconWord), implementation = slotAddress(implementationWord);
    if (beacon && implementation) fail('AMBIGUOUS_PROXY_IMPLEMENTATION');
    const target = beacon ? address(await runtime.rpc(beacon, ['function implementation() view returns(address)'], 'implementation', [], block, signal)) : implementation ?? proxy;
    const code = await provider.getCode(target, tag); runtime.guard(signal);
    if (typeof code !== 'string' || !/^0x(?:[\da-f]{2})+$/i.test(code)) fail('IMPLEMENTATION_BYTECODE_UNAVAILABLE');
    return knownFact(featuresFromBytecode(code).deadlines, source);
  } catch (error) {
    runtime.guard(signal); return unknownFact('TASK_IMPLEMENTATION_FEATURE_UNAVAILABLE', source);
  }
}
export function taskReader(runtime: ObservationRuntime): EvidenceReader<TaskWorkflowRequest, TaskWorkflowEvidence> {
  return { read: (request, options) => runtime.run(options.scope, options.signal, async signal => {
    if (!['create', 'claim', 'complete'].includes(request.action) || !/^0x[\da-f]{64}$/i.test(request.projectId)) fail('UNSUPPORTED_TASK_REQUEST');
    const taskId = request.action === 'create' ? null : uint(request.taskId), manager = runtime.scope.contracts.taskManager;
    const block = await runtime.open('taskManager', signal), source = runtime.source(manager, true, block, 'workflow-task-policy', runtime.scope.account);
    const query = (doc: string, vars: Record<string, unknown>, ref: SourceRef) => runtime.query(doc, vars, ref, signal);
    const [target, authority, rawExecutor, rawAuthority, features] = await Promise.all([
      readIndexedSingletonFacts(source, query, TARGET, { orgId: runtime.scope.orgId, taskManager: manager, taskManagerBytes: manager,
        projectId: request.projectId.toLowerCase(), taskId: taskId === null ? '' : taskEntityId(manager, taskId) }, ['projects', 'tasks']),
      runtime.authority(block, signal),
      runtime.rpc(manager, getAbi('TaskManagerNew'), 'getLensData', [4, '0x'], block, signal),
      runtime.rpc(manager, getAbi('TaskManagerNew'), 'getLensData', [12, '0x'], block, signal),
      request.action === 'create' ? deadlines(runtime, block, signal) : Promise.resolve(unknownFact<boolean>('TASK_FEATURE_NOT_REQUESTED')),
    ]);
    requireCompleteSnapshot(target, { scope: source, block });
    const decodeAddress = (raw: unknown) => address(ethers.utils.defaultAbiCoder.decode(['address'], String(raw))[0]);
    if (decodeAddress(rawExecutor) !== runtime.scope.contracts.executor || decodeAddress(rawAuthority) !== runtime.scope.contracts.membershipAuthority) fail('TASK_MODULE_BINDING_MISMATCH');
    if (!Array.isArray(target.data.projects) || !Array.isArray(target.data.tasks)) fail('TASK_TARGET_UNAVAILABLE');
    const projects = target.data.projects as Record<string, unknown>[], tasks = target.data.tasks as Record<string, unknown>[];
    if (projects.length > 1 || tasks.length > 1) fail('TASK_TARGET_AMBIGUOUS');
    const project = projects[0], task = tasks[0];
    if (project) {
      validateWorkProject(project, source);
      if (String(project.projectId).toLowerCase() !== request.projectId.toLowerCase()) fail('TASK_PROJECT_SCOPE_MISMATCH');
    }
    if (task) {
      validateWorkProject(task.project as Record<string, unknown>, source);
      if (taskId === null || task.id !== taskEntityId(manager, taskId) || uint(task.taskId) !== taskId || String(task.taskManager).toLowerCase() !== manager
        || !project || (task.project as Record<string, unknown>).id !== project.id) fail('TASK_TARGET_SCOPE_MISMATCH');
    }
    const [managers, applications, projectLens, taskLens] = await Promise.all([
      project ? readWorkPageFacts({ source, query, document: MANAGERS, variables: { orgId: runtime.scope.orgId, project: project.id }, collection: 'projectManagers',
        pageSize: runtime.pageSize, maxPages: runtime.maxPages, initialCursor: '', validateRow: row => {
          validateWorkProject(row.project as Record<string, unknown>, source);
          if ((row.project as Record<string, unknown>).id !== project.id || row.isActive !== true) fail('TASK_MANAGER_ROW_UNAVAILABLE'); address(row.manager);
        } }) : Promise.resolve(null),
      task && taskId !== null ? listTaskApplicationsComplete({ source, query, task: taskId, pageSize: runtime.pageSize, maxPages: runtime.maxPages }) : Promise.resolve(null),
      project ? runtime.rpc(manager, getAbi('TaskManagerNew'), 'getLensData', [2, ethers.utils.defaultAbiCoder.encode(['bytes32'], [request.projectId])], block, signal) : Promise.resolve(null),
      task && taskId !== null ? runtime.rpc(manager, getAbi('TaskManagerNew'), 'getLensData', [1, ethers.utils.defaultAbiCoder.encode(['uint256'], [taskId])], block, signal) : Promise.resolve(null),
    ]);
    if (projectLens !== null && ethers.utils.defaultAbiCoder.decode(['uint128', 'uint128', 'bool'], String(projectLens))[2] !== true) fail('PROJECT_RPC_INDEX_MISMATCH');
    if (taskLens !== null) {
      const current = decodeTaskInfo(String(taskLens));
      if (current.projectId.toLowerCase() !== request.projectId.toLowerCase() || current.status !== statuses[String(task!.status)]
        || (task!.assignee != null && current.claimer.toLowerCase() !== String(task!.assignee).toLowerCase()) || current.requiresApplication !== task!.requiresApplication
        || (current.absoluteDeadline !== undefined && task!.absoluteDeadline != null && String(current.absoluteDeadline) !== uint(task!.absoluteDeadline, 48))
        || (current.claimDeadline !== undefined && task!.claimDeadline != null && String(current.claimDeadline) !== uint(task!.claimDeadline, 48))) fail('TASK_RPC_INDEX_MISMATCH');
    }
    if (managers) { requireCompleteSnapshot(managers, { scope: source, block }); if (managers.data.length > runtime.maxRows) fail('MANAGER_ROW_LIMIT'); }
    // The field is kept unknown when its complete stream cannot be established;
    // claim/complete never use application absence as an authorization bypass.
    const applicant = applications ? projectTaskApplicant({ applications, scope: source, task: taskId!, block }) : unknownFact<boolean>('TASK_APPLICATIONS_UNAVAILABLE', source);
    const unavailable = <T>(code: string) => unknownFact<T>(code, source);
    const field = <T>(value: unknown, decode: (value: unknown) => T, code: string): Fact<T> => {
      if (value === undefined || value === null) return unavailable<T>(code);
      try { return knownFact(decode(value), source); } catch { return unavailable<T>(code); }
    };
    const policy: TaskPolicyFacts & { taskId: string | null } = {
      taskId, projectId: knownFact(request.projectId.toLowerCase(), source), actor: knownFact(runtime.scope.account, source),
      projectExists: knownFact(Boolean(project), source), projectManager: managers ? projectManagerFact(managers, source, request.projectId, runtime.scope.account) : unavailable('PROJECT_MANAGER_UNAVAILABLE'),
      executor: unavailable('DERIVED_BY_WORKFLOW'), permissionMask: unavailable('DERIVED_BY_WORKFLOW'), creator: unavailable('PROJECT_CREATOR_NOT_REQUESTED'),
      taskExists: taskId === null ? unavailable('TASK_NOT_SELECTED') : knownFact(Boolean(task), source),
      status: field(task?.status, value => typeof value === 'string' && Object.hasOwn(statuses, value) ? statuses[value] : fail('TASK_STATUS_UNAVAILABLE'), 'TASK_STATUS_UNAVAILABLE'),
      claimer: field(task?.assignee, value => typeof value === 'string' && ethers.utils.isAddress(value) ? value.toLowerCase() : fail('TASK_CLAIMER_UNAVAILABLE'), 'TASK_CLAIMER_UNAVAILABLE'),
      requiresApplication: field(task?.requiresApplication, value => typeof value === 'boolean' ? value : fail('TASK_APPLICATION_FLAG_UNAVAILABLE'), 'TASK_APPLICATION_FLAG_UNAVAILABLE'),
      absoluteDeadline: field(task?.absoluteDeadline, value => Number(uint(value, 48)), 'TASK_ABSOLUTE_DEADLINE_UNAVAILABLE'),
      claimDeadline: field(task?.claimDeadline, value => Number(uint(value, 48)), 'TASK_CLAIM_DEADLINE_UNAVAILABLE'), alreadyApplied: applicant,
    };
    const moduleSource = runtime.source(manager, false, block, 'workflow-task-bindings');
    await runtime.canonical(block, signal);
    return { module: runtime.snapshot({ paused: unknownFact<boolean>('MODULE_PAUSE_UNSUPPORTED', moduleSource),
      executor: knownFact(runtime.scope.contracts.executor, moduleSource), membershipAuthority: knownFact(runtime.scope.contracts.membershipAuthority, moduleSource), deadlines: features }, moduleSource),
      policy: runtime.snapshot(policy, source), ...authority, authorityPaused: authority.authority.data.paused };
  }) };
}
