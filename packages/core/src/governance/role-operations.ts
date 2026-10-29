/** Stateless role operations. Read/review do not publish; prepare only invokes the
 * explicitly supplied document publisher. No signing, sending, retries or host storage. */
import { ethers } from 'ethers';
import { assertSourceBlock, knownFact, unknownFact, Fact, PlanResult, requireCompleteSnapshot } from '../data/facts';
import { getAbi } from '../contracts';
import { decodeCanonicalCall } from '../reads/provenance';
import { paymasterSubjectKey, SUBJECT_TYPE } from '../sponsorship/codec';
import { requireRawUint } from '../amounts';
import { bytes32ToCidV0, cidV0ToBytes32 } from '../encoding/cid';
import { mergeVerifiedAllowlist, VerifiedAllowlist, verifyAllowlistDocument } from '../email/allowlist';
import { normalizeSubjectId, predictNextSubjectIds, subjectCreationRaceFacts } from '../authority/ids';
import { ExecutionCall } from '../tx/governance';
import { buildRoleMetadata } from '../metadata/role';
import { planExistingRoleConfiguration, planRoleConfiguration, planRoleCreation, requirePlanningFact, RoleConfigurationRequest, RolePlanningContext } from './role-planning';
import { readRoleConfigurationOutcome, readRoleContinuation } from './role-continuation';
import { active, blockFresh, capabilityDemand, clock, failure, finishObservation, observe, readBase, roleDemand, same, transport, validateScope } from './role-operation-observer';
import type { PreparedRoleOperation, PrepareRoleOperationInput, ReadRoleOperationEvidenceInput, ReadRoleOperationStatusInput, ReviewRoleOperationInput,
  RoleOperationDocument, RoleOperationEffect, RoleOperationEvidence, RoleOperationObservationSet, RoleOperationRequest, RoleOperationResult, RoleOperationReview, RoleOperationRole, RoleOperationStatus } from './role-operation-types';
export type * from './role-operation-types';

const SYMBOLIC_POINTER = '0x' + '01'.repeat(32);
type Plan = { batch: ExecutionCall[]; fingerprint: string; createsSubject: boolean; subjectId?: string };
interface ReviewRecord { request: RoleOperationRequest; documents: readonly RoleOperationDocument[]; bounds: ReadRoleOperationEvidenceInput['bounds']; plan: Plan; planningRequest: RoleConfigurationRequest; }
const reviews = new WeakMap<RoleOperationReview, ReviewRecord>();
const preparedHandles = new WeakMap<PreparedRoleOperation, { review: RoleOperationReview; batchKey: string; documentsKey: string }>();
/** JSON inputs are detached before awaits; raw numeric units never go through Number. */
function canonical(value: any): any {
  if (ethers.BigNumber.isBigNumber(value) || typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
const key = (value: unknown) => JSON.stringify(canonical(value));
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function detached<T>(value: T): T { return canonical(value); }
function effects(request: RoleOperationRequest): { currentEffects: RoleOperationEffect[]; deferredEffects: RoleOperationEffect[] } {
  const creation = new Set(['kind', 'name', 'metadataPointer', 'imageURI', 'maxMembers', 'memberRoleIds', 'metadata']);
  const selected = Object.entries(request.role).filter(([field, value]) => value !== undefined && (creation.has(field)
    || (Array.isArray(value) ? value.length > 0 : typeof value === 'boolean' ? value || field === 'defaultAllow' && request.mode === 'existing'
      : field === 'taskGrants' ? !!(request.role.taskGrants?.creator || request.role.taskGrants?.organizer) : true))).map(([field]) => ({ field: field as keyof RoleOperationRole | 'metadata' }));
  if (request.metadata !== undefined) selected.push({ field: 'metadata' });
  return { currentEffects: request.mode === 'create' ? selected.filter(row => creation.has(row.field)) : selected,
    deferredEffects: request.mode === 'create' ? selected.filter(row => !creation.has(row.field)) : [] };
}
function validateRequest(request: RoleOperationRequest): void {
  if (!request || !['create', 'existing', 'compound'].includes(request.mode) || !request.role) throw new Error('INVALID_ROLE_OPERATION_REQUEST');
  const r = request.role;
  if (!['Role', 'Group'].includes(r.kind) || typeof r.name !== 'string' || !r.name.trim() || 'email' in r) throw new Error('INVALID_ROLE_CONFIGURATION');
  if (request.metadata !== undefined && (typeof request.metadata.name !== 'string' || typeof request.metadata.description !== 'string'
    || r.metadataPointer !== undefined)) throw new Error('INVALID_ROLE_METADATA_REQUEST');
  for (const value of [r.imageURI, r.metadataPointer]) if (value !== undefined && typeof value !== 'string') throw new Error('INVALID_ROLE_METADATA_REQUEST');
  for (const value of [r.defaultAllow, r.editOrgDetails, r.vouch?.selfVouch, r.taskGrants?.creator, r.taskGrants?.organizer,
    r.sponsorship?.supportPasskeys, r.sponsorship?.includeConfiguredEmailRules, r.sponsorship?.initializeClaimBudget]) if (value !== undefined && typeof value !== 'boolean') throw new Error('INVALID_ROLE_BOOLEAN');
  if (r.kind === 'Group' && (r.holders?.length || r.vouch || r.defaultAllow || r.maxMembers !== undefined || r.groupIds?.length || r.emailAdditions?.length)) throw new Error('GROUP_HAS_ROLE_ONLY_REQUESTS');
  if (r.kind === 'Role' && r.memberRoleIds?.length) throw new Error('ROLE_HAS_GROUP_ONLY_REQUESTS');
  if (r.maxMembers !== undefined) requireRawUint(r.maxMembers, 32);
  for (const ids of [r.groupIds, r.memberRoleIds]) if (ids) {
    const normalized = ids.map(normalizeSubjectId); if (new Set(normalized).size !== normalized.length) throw new Error('INVALID_COMPOSITION_SUBJECTS');
  }
  if ((r.groupIds?.length ?? 0) > 8 || (r.memberRoleIds?.length ?? 0) > 16) throw new Error('COMPOSITION_LIMIT');
  for (const p of r.permissions ?? []) {
    if (!ethers.utils.isHexString(p.key, 32) || p.inheritGlobal !== undefined && typeof p.inheritGlobal !== 'boolean') throw new Error('INVALID_PERMISSION_KEY');
    requireRawUint(p.value, 254); if (p.projectId !== undefined) requireRawUint(p.projectId);
  }
  if (r.vouch) { if (requireRawUint(r.vouch.quorum, 32) === '0') throw new Error('INVALID_VOUCH_QUORUM'); normalizeSubjectId(r.vouch.voucherSubjectId); }
  if (r.manager) { normalizeSubjectId(r.manager.managerSubjectId); requireRawUint(r.manager.delaySeconds, 32);
    if (!Number.isSafeInteger(r.manager.caps) || r.manager.caps < 0 || r.manager.caps > 15) throw new Error('INVALID_MANAGER_CAPS'); }
  const holders = new Set<string>();
  for (const holder of r.holders ?? []) {
    if (!ethers.utils.isAddress(holder.account) || same(holder.account, ethers.constants.AddressZero) || holders.has(holder.account.toLowerCase()) || typeof holder.sticky !== 'boolean') throw new Error('INVALID_OR_DUPLICATE_HOLDER'); holders.add(holder.account.toLowerCase());
  }
  if (r.bindingClassIndex !== undefined && (!Number.isSafeInteger(r.bindingClassIndex) || r.bindingClassIndex < 0 || r.bindingClassIndex > 255)) throw new Error('BINDING_CLASS_UNAVAILABLE');
  if (r.sponsorship) {
    requireRawUint(r.sponsorship.capRaw, 128); const epoch = BigInt(requireRawUint(r.sponsorship.epochSeconds, 32));
    if (epoch < 3600n || epoch > 31536000n) throw new Error('INVALID_SPONSORSHIP_EPOCH');
    if (r.sponsorship.includeConfiguredEmailRules && !r.sponsorship.supportPasskeys) throw new Error('EMAIL_RULES_REQUIRE_PASSKEY_SUPPORT');
    if (r.sponsorship.initializeClaimBudget && (!r.sponsorship.supportPasskeys || !(r.emailAdditions?.length || r.sponsorship.includeConfiguredEmailRules))) throw new Error('INVALID_CLAIM_BUDGET_REQUEST');
  }
  if (r.emailAdditions?.length) mergeVerifiedAllowlist({ orgId: '0x' + '11'.repeat(32), currentRoot: ethers.constants.HashZero,
    entries: r.emailAdditions.map(row => ({ ...row, hatIds: ['1'], roleIndexes: [] })) });
  if (request.mode === 'existing') normalizeSubjectId(request.subjectId);
}
function requiredFacts(evidence: RoleOperationEvidence, request: RoleOperationRequest): void {
  const { context, scope } = evidence, data = context.data, demand = evidence.purpose === 'capabilities' ? capabilityDemand(scope) : roleDemand(request);
  const requireFact = <T>(value: Fact<T> | undefined, code: string, contract = scope.contract): T => requirePlanningFact(value, context, { ...scope, contract }, code);
  const bool = (value: Fact<boolean> | undefined, code: string, contract = scope.contract) => { if (typeof requireFact(value, code, contract) !== 'boolean') throw new Error(code); };
  bool(data.executorAuthorized, 'EXECUTOR_AUTHORIZATION_UNAVAILABLE');
  if (demand.tasks) bool(data.taskManager?.executorAuthorized, 'TASK_MANAGER_AUTHORIZATION_UNAVAILABLE', scope.contracts.taskManager);
  if (demand.binding) bool(data.hybrid?.executorAuthorized, 'HYBRID_AUTHORIZATION_UNAVAILABLE', scope.contracts.hybridVoting);
  if (demand.registry) { bool(data.registry?.executorAuthorized, 'REGISTRY_AUTHORIZATION_UNAVAILABLE', scope.contracts.registry); requireFact(data.registry?.currentAdminSubject, 'CURRENT_ADMIN_UNAVAILABLE', scope.contracts.registry); }
  if (demand.sponsorship) {
    bool(data.sponsorship?.operatorAuthorized, 'SPONSORSHIP_AUTHORIZATION_UNAVAILABLE', scope.contracts.paymaster);
    if (demand.email) bool(data.sponsorship?.claimBudgetExists, 'CLAIM_BUDGET_UNAVAILABLE', scope.contracts.paymaster);
  }
  if (demand.email) {
    for (const [fact, contract] of [[data.email?.enabled, scope.contracts.email], [data.email?.authorityMatches, scope.contracts.email],
      [data.email?.domainEnabled, scope.contracts.email], [data.email?.emailEnabled, scope.contracts.email], [data.email?.minterAuthorized, scope.contracts.executor]] as const) bool(fact, 'EMAIL_CONFIGURATION_UNAVAILABLE', contract);
    requireFact(data.email?.currentRoot, 'CURRENT_ALLOWLIST_ROOT_UNAVAILABLE', scope.contracts.email);
    requireCompleteSnapshot(evidence.activeAllowlist!, { scope: { ...scope, contract: scope.contracts.email, endpoint: evidence.context.source.endpoint }, indexed: false, snapshot: 'pinned', block: evidence.freshness.block, requiredKeys: ['root', 'cid'] });
  }
  for (const account of demand.accounts) {
    const row = data.accounts.find(row => same(row.account, account));
    const value = requirePlanningFact(row?.acceptedAnywhere, context, { ...scope, account }, 'ACCEPTANCE_ANYWHERE_UNAVAILABLE');
    if (typeof value !== 'boolean') throw new Error('ACCEPTANCE_ANYWHERE_UNAVAILABLE');
    if (request.mode === 'existing' && typeof requirePlanningFact(row?.acceptedInSubject, context, { ...scope, account }, 'SUBJECT_ACCEPTANCE_UNAVAILABLE') !== 'boolean') throw new Error('SUBJECT_ACCEPTANCE_UNAVAILABLE');
  }
  if (evidence.purpose === 'operation' && request.mode === 'compound' && subjectCreationRaceFacts(evidence.proposals!, { chainId: scope.chainId, orgId: scope.orgId }).hasCompetingCreation.state !== 'known') throw new Error('PROPOSAL_HISTORY_UNAVAILABLE');
}
export async function readRoleOperationEvidence(input: ReadRoleOperationEvidenceInput): Promise<RoleOperationResult<RoleOperationEvidence>> {
  try { return await evidenceWithTransport(input, transport(input)); } catch (error) { return failure(error); }
}
async function evidenceWithTransport(input: ReadRoleOperationEvidenceInput, io: ReturnType<typeof transport>): Promise<RoleOperationResult<RoleOperationEvidence>> {
  const observations: RoleOperationObservationSet = {};
  try {
    const safe = { ...input, scope: detached(input.scope), request: detached(input.request), authoritySnapshot: input.authoritySnapshot && detached(input.authoritySnapshot), bounds: input.bounds && detached(input.bounds) };
    const data = await observe(safe, observations, io); requiredFacts(data, safe.request);
    return { status: 'ready', data, consequences: [] };
  } catch (error) { return failure(error, observations, (error as Error)?.message === 'ROLE_EMAIL_ALREADY_REGISTERED' ? 'blocked' : 'unknown'); }
}
async function buildReviewed(input: ReviewRoleOperationInput, evidence: RoleOperationEvidence): Promise<{ plan: PlanResult<Plan>; documents: RoleOperationDocument[]; planningRequest: RoleConfigurationRequest }> {
  const { request, scope } = input, role = request.role;
  const documents: RoleOperationDocument[] = [];
  const document = (key: RoleOperationDocument['key'], json: string) => documents.push(freeze({ key, json, digest: ethers.utils.id(json) }));
  if (request.metadata?.description.trim()) document('role-metadata', JSON.stringify(buildRoleMetadata(request.metadata)));
  const r: RoleConfigurationRequest = { ...role, ...(request.metadata !== undefined ? { metadataPointer: request.metadata.description.trim() ? SYMBOLIC_POINTER : ethers.constants.HashZero } : {}) };
  delete (r as RoleOperationRole).emailAdditions;
  let subjectId = request.mode === 'existing' ? normalizeSubjectId(request.subjectId) : undefined;
  if (request.mode === 'compound') {
    const prediction = predictNextSubjectIds({ authority: scope.contract, history: evidence.allocations!, scope });
    if (prediction.status !== 'ready') return { plan: prediction, documents, planningRequest: r };
    subjectId = prediction.data.subjectIds[0];
  }
  if (request.mode !== 'create' && role.emailAdditions?.length) {
    const activeList = evidence.activeAllowlist!;
    const root = activeList.data.root, pointer = activeList.data.cid;
    if (root.state !== 'known' || pointer.state !== 'known') throw new Error('CURRENT_ALLOWLIST_UNAVAILABLE');
    let current: VerifiedAllowlist | undefined;
    if (!same(root.value, ethers.constants.HashZero)) {
      if (!input.fetchDocument) throw new Error('ROLE_ALLOWLIST_FETCH_REQUIRED');
      const doc = await input.fetchDocument(bytes32ToCidV0(pointer.value), { signal: input.signal }); active(input.signal);
      try { current = verifyAllowlistDocument(doc, { orgId: scope.orgId, root: root.value }); } catch { throw new Error('ROLE_ALLOWLIST_DOCUMENT_UNPROVEN'); }
    }
    const merged = mergeVerifiedAllowlist({ orgId: scope.orgId, currentRoot: root.value, current,
      entries: role.emailAdditions.map(row => ({ ...row, hatIds: [subjectId!], roleIndexes: [] })) });
    document('email-allowlist', merged.json);
    r.email = { current, additions: role.emailAdditions, preparedRoot: merged.root, cid: SYMBOLIC_POINTER };
  }
  const common = { scope, freshness: { ...evidence.freshness, now: clock(input.sources) }, context: evidence.context };
  const plan: PlanResult<Plan> = request.mode === 'create'
    ? planRoleCreation({ ...common, request: { kind: r.kind, name: r.name, metadataPointer: r.metadataPointer, imageURI: r.imageURI,
      ...(r.kind === 'Role' ? { maxMembers: r.maxMembers } : { memberRoleIds: r.memberRoleIds }) } })
    : request.mode === 'existing' ? planExistingRoleConfiguration({ ...common, request: r, subjectId: request.subjectId })
      : planRoleConfiguration({ ...common, request: r, allocations: evidence.allocations!, proposals: evidence.proposals! });
  return { plan, documents, planningRequest: r };
}
function observationsFrom(e: RoleOperationEvidence): RoleOperationObservationSet { return { authority: e.authoritySnapshot, planning: e.context,
  ...(e.allocations ? { allocations: e.allocations } : {}), ...(e.proposals ? { proposals: e.proposals } : {}) }; }
export async function reviewRoleOperation(input: ReviewRoleOperationInput): Promise<RoleOperationResult<RoleOperationReview>> {
  let evidence: RoleOperationEvidence | undefined;
  try {
    active(input.signal);
    const request = freeze(detached(input.request)), scope = freeze(detached(input.scope));
    try { validateRequest(request); validateScope(scope, input.sources); } catch (error) { return failure(error, undefined, 'blocked'); }
    // JavaScript callers can supply extra fields: a review always observes the
    // strict selected operation, regardless of injected capabilities readiness.
    const safe = { ...input, request, scope, purpose: 'operation' as const };
    const io = transport(safe);
    const observed = await evidenceWithTransport(safe, io);
    if (observed.status !== 'ready') return observed;
    evidence = observed.data;
    const { plan, documents, planningRequest } = await buildReviewed(safe, evidence);
    if (plan.status !== 'ready') return { ...plan, observations: observationsFrom(evidence) };
    active(input.signal);
    // Document fetching is asynchronous; canonicality and the clock are rechecked
    // after that boundary, using the same transport and observation budget.
    const block = await io.provider.getBlock(Number(evidence.freshness.block.number));
    assertSourceBlock(block ? { number: String(block.number), hash: block.hash, timestamp: String(block.timestamp) } : undefined, evidence.freshness.block);
    blockFresh(evidence.freshness.block, input.sources, evidence.context.source.observedAt!);
    const stageEffects = effects(request);
    const review = freeze({ kind: 'role-operation-review', requestKey: ethers.utils.id(key([scope, request])), fingerprint: plan.data.fingerprint,
      mode: request.mode, ...(request.mode === 'existing' ? { subjectId: plan.data.subjectId } : request.mode === 'compound' ? { predictedSubjectId: plan.data.subjectId } : {}),
      requiresConfiguration: stageEffects.deferredEffects.length > 0, ...stageEffects,
      consequences: plan.consequences, documents: documents.map(({ key, digest }) => ({ key, digest })),
      preview: { callCount: plan.data.batch.length, createsSubject: plan.data.createsSubject }, evidence: detached(evidence) }) as unknown as RoleOperationReview;
    reviews.set(review, { request, documents: freeze(documents), bounds: input.bounds && freeze(detached(input.bounds)), plan: freeze(plan.data), planningRequest: freeze(planningRequest) });
    return { status: 'ready', data: review, consequences: review.consequences };
  } catch (error) { return failure(error, evidence && observationsFrom(evidence)); }
}
function binding(input: PrepareRoleOperationInput): ReviewRecord {
  const record = reviews.get(input.review);
  if (!record || input.review.requestKey !== ethers.utils.id(key([input.scope, input.currentRequest]))) throw new Error('ROLE_OPERATION_REVIEW_REQUIRED');
  return record;
}
async function renewed(input: PrepareRoleOperationInput, record: ReviewRecord): Promise<RoleOperationResult<RoleOperationReview>> {
  const result = await reviewRoleOperation({ scope: input.scope, sources: input.sources, request: record.request, fetchDocument: input.fetchDocument,
    bounds: record.bounds, signal: input.signal });
  if (result.status !== 'ready') return result;
  if (result.data.fingerprint !== input.review.fingerprint || key(result.data.documents) !== key(input.review.documents)) return failure(new Error('STALE_ROLE_OPERATION_REVIEW'), observationsFrom(result.data.evidence), 'blocked');
  return result;
}
function retain<T>(result: RoleOperationResult<T>, docs: PreparedRoleOperation['documents']): RoleOperationResult<T> {
  return result.status === 'ready' || !docs.length ? result : { ...result, publishedDocuments: [...docs] };
}
function abortReceipts(error: unknown, docs: PreparedRoleOperation['documents']): void {
  if ((error as Error)?.name === 'AbortError' && docs.length) {
    try { Object.assign(error as object, { publishedDocuments: [...docs] }); } catch { /* Host errors can be immutable. */ }
  }
}
export async function prepareRoleOperation(input: PrepareRoleOperationInput): Promise<RoleOperationResult<PreparedRoleOperation>> {
  const documents: { key: string; digest: string; cid: string }[] = [];
  try {
    active(input.signal);
    let record: ReviewRecord;
    try { record = binding(input); } catch (error) { return failure(error, undefined, 'blocked'); }
    const safe = { ...input, scope: detached(input.scope), currentRequest: detached(input.currentRequest) };
    const before = await renewed(safe, record);
    if (before.status !== 'ready') return before;
    binding(input);
    if (record.documents.length && !input.publishDocument) return failure(new Error('ROLE_DOCUMENT_PUBLISHER_REQUIRED'), undefined, 'blocked');
    for (const document of record.documents) {
      active(input.signal);
      const result = await input.publishDocument!(document, { signal: input.signal });
      // Retain a valid adapter receipt before observing cancellation or any fallible follow-up.
      cidV0ToBytes32(result?.cid);
      documents.push({ key: document.key, digest: document.digest, cid: result.cid }); active(input.signal); binding(input);
    }
    const after = await renewed(safe, record);
    if (after.status !== 'ready') return retain(after, documents);
    binding(input);
    // Rebuild through the same strict planner with named actual pointers. Never patch calldata.
    const final = finalPlan(safe, after.data, documents);
    if (final.status !== 'ready') return retain(final, documents);
    blockFresh(after.data.evidence.freshness.block, input.sources, after.data.evidence.context.source.observedAt!);
    const prepared = freeze({ mode: after.data.mode, ...(after.data.subjectId ? { subjectId: after.data.subjectId } : {}),
      ...(after.data.predictedSubjectId ? { predictedSubjectId: after.data.predictedSubjectId } : {}), requiresConfiguration: after.data.requiresConfiguration,
      fingerprint: after.data.fingerprint, batch: final.data.batch.map(call => ({ ...call, value: ethers.BigNumber.from(call.value).toString() })),
      consequences: final.consequences, documents, evidence: after.data.evidence });
    preparedHandles.set(prepared, { review: input.review, batchKey: key(prepared.batch), documentsKey: key(documents) });
    return { status: 'ready', data: prepared, consequences: prepared.consequences };
  } catch (error) { abortReceipts(error, documents); return retain(failure(error), documents); }
}
function finalPlan(input: PrepareRoleOperationInput, review: RoleOperationReview, documents: PreparedRoleOperation['documents']): PlanResult<Plan> {
  const record = reviews.get(review)!;
  const metadata = documents.find(row => row.key === 'role-metadata');
  const email = documents.find(row => row.key === 'email-allowlist');
  const role: RoleConfigurationRequest = { ...record.planningRequest };
  if (record.request.metadata !== undefined) role.metadataPointer = metadata ? cidV0ToBytes32(metadata.cid) : ethers.constants.HashZero;
  if (email) role.email = { ...role.email!, cid: email.cid };
  active(input.signal);
  const e = review.evidence, common = { scope: input.scope, context: e.context, freshness: { ...e.freshness, now: clock(input.sources) } };
  const plan: PlanResult<Plan> = record.request.mode === 'create'
    ? planRoleCreation({ ...common, request: { kind: role.kind, name: role.name, metadataPointer: role.metadataPointer, imageURI: role.imageURI,
      ...(role.kind === 'Role' ? { maxMembers: role.maxMembers } : { memberRoleIds: role.memberRoleIds }) } })
    : record.request.mode === 'existing' ? planExistingRoleConfiguration({ ...common, request: role, subjectId: record.request.subjectId })
      : planRoleConfiguration({ ...common, request: role, allocations: e.allocations!, proposals: e.proposals! });
  return plan;
}
export async function revalidatePreparedRoleOperation(input: PrepareRoleOperationInput & { prepared: PreparedRoleOperation }): Promise<RoleOperationResult<PreparedRoleOperation>> {
  try {
    active(input.signal); const record = binding(input), handle = preparedHandles.get(input.prepared);
    if (!handle || handle.review !== input.review || handle.batchKey !== key(input.prepared.batch) || handle.documentsKey !== key(input.prepared.documents)) return failure(new Error('ROLE_OPERATION_PREPARED_REQUIRED'), undefined, 'blocked');
    const current = await renewed(input, record);
    if (current.status !== 'ready') return retain(current, input.prepared.documents);
    binding(input);
    const rebuilt = finalPlan(input, current.data, input.prepared.documents);
    if (rebuilt.status !== 'ready') return retain(rebuilt, input.prepared.documents);
    const batch = rebuilt.data.batch.map(call => ({ ...call, value: ethers.BigNumber.from(call.value).toString() }));
    if (key(batch) !== handle.batchKey) return retain(failure(new Error('STALE_ROLE_OPERATION_PREPARED'), observationsFrom(current.data.evidence), 'blocked'), input.prepared.documents);
    blockFresh(current.data.evidence.freshness.block, input.sources, current.data.evidence.context.source.observedAt!);
    const prepared = freeze({ ...input.prepared, evidence: current.data.evidence }); preparedHandles.set(prepared, { ...handle });
    return { status: 'ready', data: prepared, consequences: prepared.consequences };
  } catch (error) { abortReceipts(error, input.prepared?.documents ?? []); return retain(failure(error), input.prepared?.documents ?? []); }
}
/** A canonical executed batch is not by itself a configuration of this subject.
 * Check every supported call, including global ancillary calls; caller labels,
 * a matching first call and JSON-replayed prepared handles are not proof. */
async function requireConfigurationSubject(input: ReadRoleOperationStatusInput, subjectId: string): Promise<void> {
  const { scope, configuration } = input, batch = configuration!.batch, id = normalizeSubjectId(subjectId);
  if (!batch.length || batch.length > 20) throw new Error('EXACT_ROLE_CONFIGURATION_BATCH_REQUIRED');
  const authority = new ethers.utils.Interface(getAbi('MembershipAuthority'));
  const kind = decodeCanonicalCall(authority, input.creation.call.calldata).name === 'createRole' ? 'Role' : 'Group';
  const bound = (value: ethers.BigNumberish) => normalizeSubjectId(ethers.BigNumber.from(value).toString()) === id;
  const fail = (): never => { throw new Error('ROLE_CONFIGURATION_SUBJECT_UNPROVEN'); };
  const modules: Record<string, string> = { membershipAuthority: 'MembershipAuthority', taskManager: 'TaskManagerNew',
    hybridVoting: 'HybridVotingNew', registry: 'OrgRegistry', paymaster: 'PaymasterHub', email: 'ZkEmailInvites', executor: 'Executor' };
  const calls = batch.map(call => {
    if (!ethers.BigNumber.from(call.value).isZero()) return fail();
    const module = Object.keys(modules).find(key => same(scope.contracts[key], call.target));
    if (!module) return fail();
    return { module, parsed: decodeCanonicalCall(new ethers.utils.Interface(getAbi(modules[module])), call.calldata) };
  });
  let roleBudget: ethers.utils.Result | undefined, claimBudget: ethers.utils.Result | undefined;
  let rules: ethers.utils.Result | undefined, allowlist: ethers.utils.Result | undefined, minter = false, admin = false;
  for (const { module, parsed: { name, args } } of calls) {
    if (module === 'membershipAuthority') {
      if (name === 'addRoleToGroup' ? !bound(args[kind === 'Role' ? 0 : 1])
        : !['renameSubject', 'setMaxMembers', 'setSubjectDefault', 'setPerm', 'configureVouchAttestor', 'setManagerConfig', 'grant', 'offer'].includes(name) || !bound(args[0])) fail();
    } else if (module === 'taskManager' && name === 'setConfig') {
      if (!['1', '7'].includes(args[0].toString())) fail();
      const decoded = ethers.utils.defaultAbiCoder.decode(['uint256', 'bool'], args[1]);
      if (!bound(decoded[0]) || decoded[1] !== true || !same(args[1], ethers.utils.defaultAbiCoder.encode(['uint256', 'bool'], decoded))) fail();
    } else if (module === 'hybridVoting' && name === 'addHatToClass') {
      if (!bound(args[1])) fail();
    } else if (module === 'registry' && name === 'setOrgMetadataAdminHat') {
      if (!same(args[0], scope.orgId) || !bound(args[1])) fail(); admin = true;
    } else if (module === 'paymaster' && name === 'setBudget') {
      if (!same(args[0], scope.orgId) || Number(args[3]) < 3600 || Number(args[3]) > 31536000) fail();
      if (same(args[1], paymasterSubjectKey(SUBJECT_TYPE.HAT, id))) {
        if (roleBudget) fail(); roleBudget = args;
      } else if (scope.contracts.email && same(args[1], paymasterSubjectKey(SUBJECT_TYPE.CLAIM, scope.contracts.email))) {
        if (claimBudget) fail(); claimBudget = args;
      } else fail();
    } else if (module === 'paymaster' && name === 'setRulesBatch') {
      if (rules || !same(args[0], scope.orgId)) fail(); rules = args;
    } else if (module === 'email' && name === 'setActiveAllowlist') {
      if (allowlist || kind !== 'Role') fail(); allowlist = args;
    } else if (module === 'executor' && name === 'setHatMinterAuthorization') {
      if (minter || !same(args[0], scope.contracts.email) || args[1] !== true) fail(); minter = true;
    } else fail();
  }
  let emailRules = false;
  if (rules) {
    if (!roleBudget) fail();
    const expected: { target: string; selector: string; hint: number }[] = [];
    for (const [name, hint] of [['claim', 300000], ['renounce', 200000], ['vouch', 0], ['revokeVouch', 200000],
      ['delegatedGrant', 250000], ['delegatedOffer', 300000], ['delegatedRemove', 250000], ['delegatedUnremove', 200000], ['finalize', 600000], ['cancel', 200000]] as const) {
      expected.push({ target: scope.contract, selector: authority.getSighash(name), hint });
    }
    const email = new ethers.utils.Interface(getAbi('ZkEmailInvites'));
    const selectors = rules[2] as string[];
    const domain = selectors.some(selector => same(selector, email.getSighash('claimRoleByDomain')));
    const address = selectors.some(selector => same(selector, email.getSighash('claimRoleByEmail')));
    emailRules = domain || address;
    if (emailRules && !scope.contracts.email) fail();
    for (const [name, enabled, hint] of [['claimRoleByDomain', domain, 800000], ['claimRoleByEmail', address, 800000],
      ['registerAndClaimByDomainWithPasskey', domain, 1200000], ['registerAndClaimByEmailWithPasskey', address, 1200000]] as const) {
      if (enabled) expected.push({ target: scope.contracts.email, selector: email.getSighash(name), hint });
    }
    if (admin) expected.push({ target: scope.contracts.registry, selector: new ethers.utils.Interface(getAbi('OrgRegistry')).getSighash('updateOrgMetaAsAdmin'), hint: 0 });
    if ([rules[1], rules[2], rules[3], rules[4]].some(values => values.length !== expected.length)
      || expected.some((rule, index) => !same(rules![1][index], rule.target) || !same(rules![2][index], rule.selector)
        || rules![3][index] !== true || !ethers.BigNumber.from(rules![4][index]).eq(rule.hint))) fail();
  }
  if (claimBudget && (!roleBudget || !emailRules || !ethers.BigNumber.from(claimBudget[2]).eq(roleBudget[2])
    || !ethers.BigNumber.from(claimBudget[3]).eq(roleBudget[3]))) fail();
  if (minter && !allowlist) fail();
  if (allowlist) {
    if (!input.fetchDocument) throw new Error('ROLE_CONFIGURATION_DOCUMENT_REQUIRED');
    active(input.signal);
    const document = await input.fetchDocument(bytes32ToCidV0(allowlist[1]), { signal: input.signal });
    active(input.signal);
    let verified: VerifiedAllowlist;
    try { verified = verifyAllowlistDocument(document, { orgId: scope.orgId, root: allowlist[0] }); }
    catch { throw new Error('ROLE_CONFIGURATION_DOCUMENT_UNPROVEN'); }
    if (!verified.leaves.some(leaf => leaf.hatIds.some(value => normalizeSubjectId(value) === id))) fail();
  }
}
export async function readRoleOperationStatus(input: ReadRoleOperationStatusInput): Promise<RoleOperationResult<RoleOperationStatus>> {
  const observations: RoleOperationObservationSet = {};
  try {
    const safe = { ...input, scope: detached(input.scope), creation: detached(input.creation), configuration: input.configuration && detached(input.configuration), authoritySnapshot: input.authoritySnapshot && detached(input.authoritySnapshot) };
    const io = transport(safe), base = await readBase(safe, io, observations), { scope, creation, configuration } = safe;
    const common = { scope, source: base.indexed, rpcSource: base.source, provider: io.provider, query: io.protocol,
      freshness: { now: clock(input.sources), maxAgeSeconds: 30 } };
    const proof = await readRoleContinuation({ ...common, creationTransactionHash: creation.transactionHash, proposalId: creation.proposalId,
      creationCall: creation.call, creationOperation: creation.operation, executionOperation: creation.executionOperation,
      subjects: { ...base.authority, source: { ...base.authority.source, block: base.block }, data: base.authority.data.subjects } });
    observations.creation = knownFact(proof, base.indexed);
    let outcome: RoleOperationStatus['configuration'];
    if (configuration) {
      if (proof.state !== 'created') throw new Error('ROLE_CONFIGURATION_WITHOUT_CREATED_SUBJECT');
      outcome = await readRoleConfigurationOutcome({ ...common, freshness: { now: clock(input.sources), maxAgeSeconds: 30 },
        creationTransactionHash: configuration.transactionHash, proposalId: configuration.proposalId, batch: configuration.batch,
        creationOperation: configuration.operation, executionOperation: configuration.executionOperation });
      observations.configuration = unknownFact('ROLE_CONFIGURATION_SUBJECT_UNPROVEN', base.indexed);
      if (outcome.proposalId === proof.proposalId) throw new Error('ROLE_CONFIGURATION_STAGE_REPLAY');
      await requireConfigurationSubject(safe, proof.subjectId);
      observations.configuration = knownFact(outcome, base.indexed);
    }
    await finishObservation(base, safe, io);
    const next = proof.state === 'pending' ? 'wait' : proof.state !== 'created' ? 'review-creation'
      : outcome?.state === 'executed' ? 'complete' : outcome?.state === 'pending' ? 'wait' : 'review-configuration';
    return { status: 'ready', data: { creation: proof, ...(outcome ? { configuration: outcome } : {}), next }, consequences: [] };
  } catch (error) { return failure(error, observations); }
}
