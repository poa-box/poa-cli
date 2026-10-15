import { requireRawUint } from '../amounts';
import { assertPlanScope, assertSourceBlock, assertSourceRef, Fact, PlanScope, requireCompleteSnapshot, SourceSnapshot } from '../data/facts';
import type { EffectivePermission } from '../authority/permissions';
import { AUTHORITY_KEYS, projectContext } from '../tx/authority';
import { knownFact, unknownFact } from '../data/facts';
import { PERM_BITS } from '../perms';
import { effectiveTaskDeadlineSeconds, TASK_STATUS } from '../task-lens';
import { deriveProjectCreatorAuthorization, ProjectCreatorInput, ProjectCreatorSources } from './project-creator';

export type TaskActionReason = 'BAD_STATUS' | 'NOT_FOUND' | 'MISSING_PERMISSION' | 'SELF_REVIEW_REQUIRED'
  | 'NOT_CLAIMER' | 'CLAIM_NOT_EXPIRED' | 'REQUIRES_APPLICATION' | 'APPLICATION_NOT_REQUIRED'
  | 'ALREADY_APPLIED' | 'UNKNOWN_FACT' | 'INCOMPLETE_SOURCE' | 'SOURCE_SCOPE_MISMATCH' | 'INVALID_FACT';
export interface TaskActionDecision { state: 'allowed' | 'denied' | 'unknown'; reasons: readonly TaskActionReason[] }
/** Current effective project mask, not role IDs or a guessed creator list. */
export interface TaskPolicyFacts {
  projectId: Fact<string>;
  actor: Fact<string>; executor: Fact<boolean>; projectManager: Fact<boolean>; permissionMask: Fact<string>;
  projectExists: Fact<boolean>; creator: Fact<boolean>;
  taskExists: Fact<boolean>; status: Fact<number>; claimer: Fact<string>;
  absoluteDeadline: Fact<number>; claimDeadline: Fact<number>;
  requiresApplication: Fact<boolean>; alreadyApplied: Fact<boolean>;
}
export interface TaskPolicyInput {
  projectId: string; snapshot: SourceSnapshot<TaskPolicyFacts>; scope: PlanScope; now: number;
  /** Opt-in creator evidence for deleteProject ONLY. Indexed policy evidence must
   * have an explicit expected endpoint and the same pinned canonical block.
   * Other actions and their existing field-source validation are unchanged. */
  projectCreator?: ProjectCreatorInput & { sources: ProjectCreatorSources };
}
export type TaskAction = 'create' | 'createAndAssign' | 'claim' | 'apply' | 'assign' | 'submit'
  | 'complete' | 'reject' | 'cancel' | 'editFull' | 'editMetadata' | 'release' | 'budget' | 'deleteProject';
const allow = (): TaskActionDecision => ({ state: 'allowed', reasons: [] });
const deny = (reason: TaskActionReason): TaskActionDecision => ({ state: 'denied', reasons: [reason] });
const unknown = (reason: TaskActionReason = 'UNKNOWN_FACT'): TaskActionDecision => ({ state: 'unknown', reasons: [reason] });
function any(...decisions: TaskActionDecision[]): TaskActionDecision {
  return decisions.find(d => d.state === 'allowed') ?? decisions.find(d => d.state === 'unknown') ?? decisions[0];
}
function all(...decisions: TaskActionDecision[]): TaskActionDecision {
  return decisions.find(d => d.state === 'denied') ?? decisions.find(d => d.state === 'unknown') ?? allow();
}
function bool(f: Fact<boolean>): TaskActionDecision { return f.state === 'unknown' ? unknown() : f.value ? allow() : deny('MISSING_PERMISSION'); }
function validated(input: TaskPolicyInput): TaskPolicyFacts {
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error('Invalid decision time');
  // An explicit actor, org and TaskManager scope is mandatory for safety decisions.
  if (!/^0x[\da-fA-F]{64}$/.test(input.projectId)) throw new Error('Invalid project scope');
  if (!input.scope.account || !input.scope.orgId || !input.scope.contract) throw new Error('Missing policy scope');
  const data = requireCompleteSnapshot(input.snapshot, { scope: input.scope });
  for (const key of ['projectId', 'actor', 'executor', 'projectManager', 'permissionMask', 'projectExists', 'creator', 'taskExists', 'status', 'claimer', 'absoluteDeadline', 'claimDeadline', 'requiresApplication', 'alreadyApplied'] as const) {
    const fact = data[key];
    if (!fact || !['known', 'unknown'].includes(fact.state)) throw new Error('Invalid fact');
    if (fact.source) {
      const authority = input.scope.contracts?.membershipAuthority;
      const contract = key === 'permissionMask' && authority ? authority : input.scope.contract;
      assertPlanScope(fact.source, { chainId: input.scope.chainId, orgId: input.scope.orgId, account: input.scope.account, contract });
      if (fact.source.indexed !== input.snapshot.source.indexed) throw new Error('Mixed source kinds');
      if (input.snapshot.source.block) assertSourceBlock(fact.source.block, input.snapshot.source.block);
    }
    if (fact.state !== 'known') continue;
    const v = fact.value;
    if (key === 'projectId') {
      if (typeof v !== 'string' || v.toLowerCase() !== input.projectId.toLowerCase()) throw new Error('Project scope mismatch');
    } else if (key === 'actor' || key === 'claimer') {
      if (typeof v !== 'string' || !/^0x[\da-fA-F]{40}$/.test(v)) throw new Error('Invalid identity');
    } else if (key === 'permissionMask') requireRawUint(v as string, 8);
    else if (key === 'status') { if (!Number.isInteger(v) || Number(v) < 0 || Number(v) > 4) throw new Error('Invalid status'); }
    else if (key === 'absoluteDeadline' || key === 'claimDeadline') requireRawUint(v as number, 48);
    else if (typeof v !== 'boolean') throw new Error('Invalid boolean fact');
  }
  if (data.actor.state === 'known' && (data.actor.value.toLowerCase() !== input.scope.account.toLowerCase() || /^0x0{40}$/i.test(data.actor.value))) throw new Error('Actor scope mismatch');
  return data;
}
function permission(f: TaskPolicyFacts, bit: number): TaskActionDecision {
  const mask = f.permissionMask.state === 'known'
    ? (BigInt(f.permissionMask.value) & BigInt(bit)) === BigInt(bit) ? allow() : deny('MISSING_PERMISSION') : unknown();
  return any(bool(f.executor), bool(f.projectManager), mask);
}
function own(f: TaskPolicyFacts): TaskActionDecision {
  if (f.actor.state === 'unknown' || f.claimer.state === 'unknown') return unknown();
  return f.actor.value.toLowerCase() === f.claimer.value.toLowerCase() ? allow() : deny('NOT_CLAIMER');
}
function status(f: TaskPolicyFacts, values: readonly number[]): TaskActionDecision {
  return f.status.state === 'unknown' ? unknown() : values.includes(f.status.value) ? allow() : deny('BAD_STATUS');
}
function exists(f: Fact<boolean>): TaskActionDecision { return f.state === 'unknown' ? unknown() : f.value ? allow() : deny('NOT_FOUND'); }
function expired(f: TaskPolicyFacts, now: number): TaskActionDecision {
  if (f.absoluteDeadline.state === 'unknown' || f.claimDeadline.state === 'unknown') return unknown();
  const cutoff = effectiveTaskDeadlineSeconds({ absoluteDeadline: f.absoluteDeadline.value, claimDeadline: f.claimDeadline.value });
  return cutoff !== undefined && now > cutoff ? allow() : deny('CLAIM_NOT_EXPIRED');
}
function available(f: TaskPolicyFacts, now: number): TaskActionDecision {
  if (f.status.state === 'unknown') return unknown();
  if (f.status.value === TASK_STATUS.UNCLAIMED) return allow();
  return all(status(f, [TASK_STATUS.CLAIMED]), expired(f, now));
}
function decide(f: TaskPolicyFacts, action: TaskAction, now: number): TaskActionDecision {
  if (f.actor.state === 'unknown' || f.projectId.state === 'unknown') return unknown();
  const project = exists(f.projectExists);
  if (action === 'budget') {
    const budget = f.permissionMask.state === 'unknown' ? unknown()
      : (BigInt(f.permissionMask.value) & 32n) !== 0n ? allow() : deny('MISSING_PERMISSION');
    return all(project, any(bool(f.executor), budget));
  }
  if (action === 'deleteProject') return all(project, any(bool(f.executor), bool(f.creator)));
  if (action === 'create') return all(project, permission(f, PERM_BITS.create));
  if (action === 'createAndAssign') return all(project, permission(f, PERM_BITS.create | PERM_BITS.assign));
  const task = all(project, exists(f.taskExists));
  if (action === 'release') return all(task, status(f, [TASK_STATUS.CLAIMED]),
    any(own(f), all(permission(f, PERM_BITS.assign), expired(f, now))));
  if (action === 'submit') return all(task, status(f, [TASK_STATUS.CLAIMED]), own(f));
  if (action === 'claim' || action === 'apply') {
    const app = f.requiresApplication.state === 'unknown' ? unknown()
      : f.requiresApplication.value === (action === 'apply') ? allow()
      : deny(action === 'claim' ? 'REQUIRES_APPLICATION' : 'APPLICATION_NOT_REQUIRED');
    const duplicate = action === 'claim' ? allow() : f.alreadyApplied.state === 'unknown' ? unknown()
      : f.alreadyApplied.value ? deny('ALREADY_APPLIED') : allow();
    return all(task, available(f, now), permission(f, PERM_BITS.claim), app, duplicate);
  }
  if (action === 'assign') return all(task, available(f, now), permission(f, PERM_BITS.assign));
  if (action === 'cancel') return all(task, status(f, [TASK_STATUS.UNCLAIMED]), permission(f, PERM_BITS.create));
  if (action === 'reject') return all(task, status(f, [TASK_STATUS.SUBMITTED]), permission(f, PERM_BITS.review));
  if (action === 'complete') {
    const self = own(f);
    const selfPerm = f.permissionMask.state === 'unknown' ? unknown()
      : (BigInt(f.permissionMask.value) & 16n) !== 0n ? allow() : deny('SELF_REVIEW_REQUIRED');
    const gate = self.state === 'denied' ? allow() : self.state === 'unknown' ? any(bool(f.executor), bool(f.projectManager), selfPerm, unknown())
      : any(bool(f.executor), bool(f.projectManager), selfPerm);
    return all(task, status(f, [TASK_STATUS.SUBMITTED]), permission(f, PERM_BITS.review), gate);
  }
  const editMask = action === 'editFull' ? PERM_BITS['edit-full'] : PERM_BITS['edit-full'] | PERM_BITS['edit-meta'];
  // EDIT_FULL implies metadata editing; either edit bit suffices, unlike atomic CREATE+ASSIGN.
  const edit = f.permissionMask.state === 'unknown' ? unknown() : (BigInt(f.permissionMask.value) & BigInt(editMask)) !== 0n ? allow() : deny('MISSING_PERMISSION');
  return all(task, status(f, [0, 1, 2]), any(bool(f.executor), bool(f.projectManager), edit,
    all(status(f, [TASK_STATUS.UNCLAIMED]), permission(f, PERM_BITS.create))));
}
export function decideTaskActions(input: TaskPolicyInput): Record<TaskAction, TaskActionDecision> {
  const actions: TaskAction[] = ['create', 'createAndAssign', 'claim', 'apply', 'assign', 'submit', 'complete', 'reject', 'cancel', 'editFull', 'editMetadata', 'release', 'budget', 'deleteProject'];
  let f: TaskPolicyFacts;
  try { f = validated(input); }
  catch (error) {
    const code = (error as { code?: string }).code;
    const reason = code === 'INCOMPLETE_SNAPSHOT' || code === 'INCONSISTENT_COVERAGE' ? 'INCOMPLETE_SOURCE'
      : code === 'SCOPE_MISMATCH' || code === 'BLOCK_MISMATCH' ? 'SOURCE_SCOPE_MISMATCH' : 'INVALID_FACT';
    return Object.fromEntries(actions.map(a => [a, unknown(reason)])) as Record<TaskAction, TaskActionDecision>;
  }
  const decisions = Object.fromEntries(actions.map(a => [a, decide(f, a, input.now)])) as Record<TaskAction, TaskActionDecision>;
  if (input.projectCreator) {
    try {
      if (!input.scope.endpoint || !input.projectCreator.sources?.block.hash) throw new Error('Expected creator/policy sources required');
      assertPlanScope(input.projectCreator.scope, { ...input.scope, endpoint: undefined, method: undefined });
      requireCompleteSnapshot(input.snapshot, { scope: input.scope, indexed: true, snapshot: 'pinned', block: input.projectCreator.sources.block });
      for (const fact of [f.projectId, f.actor, f.projectExists]) if (fact.source) {
        assertSourceRef(fact.source);
        assertPlanScope(fact.source, { ...input.scope, contracts: undefined });
        if (!fact.source.indexed || fact.source.snapshot !== 'pinned') throw new Error('Pinned indexed project fact required');
        assertSourceBlock(fact.source.block, input.projectCreator.sources.block);
      }
      const creator = deriveProjectCreatorAuthorization(input.projectCreator);
      decisions.deleteProject = decide({ ...f, creator: creator.creator, executor: creator.executor }, 'deleteProject', input.now);
    } catch { decisions.deleteProject = unknown('SOURCE_SCOPE_MISMATCH'); }
  }
  return decisions;
}
export function decideTaskRelease(input: TaskPolicyInput): TaskActionDecision { return decideTaskActions(input).release; }
export function decideProjectBudget(input: TaskPolicyInput): TaskActionDecision { return decideTaskActions(input).budget; }

/** Adapt an already verified USER permission projection at this exact authority project context.
 * Subject potential permissions are not user authority; obtain this from projectUserPermissions.
 * TaskManager casts the aggregate to uint8; the 254-bit original stays in the authority projection. */
export function projectTaskPermissionMask(permission: EffectivePermission, projectId: string): Fact<string> {
  try {
    if (permission.permKey.toLowerCase() !== AUTHORITY_KEYS.TM_PERMS.toLowerCase() || permission.ctx.toLowerCase() !== projectContext(projectId).toLowerCase()) return unknownFact('TASK_PERMISSION_CONTEXT_MISMATCH', permission.value.source);
    if (permission.value.state === 'unknown') return permission.value;
    return knownFact((BigInt(requireRawUint(permission.value.value, 254)) & 255n).toString(), permission.value.source);
  } catch { return unknownFact('INVALID_TASK_PERMISSION', permission.value.source); }
}
