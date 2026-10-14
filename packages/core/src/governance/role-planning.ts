import { ethers } from 'ethers';
import { requireRawUint } from '../amounts';
import { assertPlanScope, assertSourceBlock, assertSourceRef, Fact, PlanConsequence, PlanResult, PlanScope, requireCompleteSnapshot, SourceBlock, SourceSnapshot } from '../data/facts';
import { predictNextSubjectIds, normalizeSubjectId, SubjectAllocation, SubjectCreationProposal, subjectCreationRaceFacts } from '../authority/ids';
import { AuthorityReadiness, isAuthorityReady } from '../reads/authority';
import { buildAuthorityAction, permissionWord, projectContext } from '../tx/authority';
import { encodeIntent } from '../tx/intent';
import { encodeExecutorCall, ExecutionCall } from '../tx/governance';
import { validateGovernanceBatches } from './capabilities';
import { paymasterSubjectKey, SUBJECT_TYPE } from '../sponsorship/codec';
import { metadataPointerToBytes32 } from '../encoding/cid';
import { mergeVerifiedAllowlist, VerifiedAllowlist } from '../email/allowlist';
import { getAbi } from '../contracts';

export interface PlanningFreshness { now: number; maxAgeSeconds: number; /** Explicit host-observed current org-chain block, never an inferred head. */ block: SourceBlock }
/** Live source, explicit clock, complete fields and scope; no implicit Date.now. */
export function requireLivePlanningSnapshot<T>(snapshot: SourceSnapshot<T>, scope: PlanScope, freshness: PlanningFreshness): T {
  const data = requireCompleteSnapshot(snapshot, { scope, indexed: false, block: freshness.block });
  if (!freshness.block) throw new Error('CURRENT_LIVE_BLOCK_REQUIRED');
  if (snapshot.source.snapshot !== 'latest' && snapshot.source.snapshot !== 'pinned') throw new Error('LIVE_SNAPSHOT_UNPROVEN');
  const at = snapshot.source.observedAt;
  if (!Number.isSafeInteger(freshness.now) || !Number.isSafeInteger(freshness.maxAgeSeconds) || freshness.maxAgeSeconds < 0
    || at === undefined || freshness.now < at || freshness.now - at > freshness.maxAgeSeconds) throw new Error('LIVE_EVIDENCE_STALE');
  return data;
}
/** Attached fields prove their own contract/account/block. The complete parent
 * proves aggregate module bindings; fields need not repeat that entire map,
 * but any explicitly supplied binding must agree. */
export function requirePlanningFact<T>(fact: Fact<T> | undefined, snapshot: SourceSnapshot<unknown>, scope: PlanScope, code: string): T {
  if (!fact || fact.state !== 'known') throw new Error(code);
  if (fact.source) {
    assertSourceRef(fact.source);
    assertPlanScope(fact.source, { ...scope, contracts: undefined });
    for (const expected of [snapshot.source.contracts, scope.contracts]) {
      for (const [key, contract] of Object.entries(expected ?? {})) if (fact.source.contracts?.[key] !== undefined) {
        assertPlanScope(fact.source, { chainId: scope.chainId, contracts: { [key]: contract } });
      }
    }
    if (fact.source.indexed !== snapshot.source.indexed) throw new Error('FIELD_SOURCE_KIND_MISMATCH');
    if (snapshot.source.block) assertSourceBlock(fact.source.block, snapshot.source.block);
  }
  return fact.value;
}
export function governancePlanBlocked<T>(error: unknown, consequences: readonly PlanConsequence[] = []): PlanResult<T> {
  const candidate = (error as { code?: string })?.code ?? (error instanceof Error ? error.message : '');
  const code = /^[A-Z][A-Z_0-9]+$/.test(candidate) ? candidate : 'INVALID_GOVERNANCE_PLAN';
  return { status: 'blocked', codes: [code], prerequisites: [{ code }], consequences };
}
export function authorityExecutionCall(authority: string, method: Parameters<typeof buildAuthorityAction>[0]['method'], args: unknown[]): ExecutionCall {
  const intent = buildAuthorityAction({ authorityAddress: authority, method, args });
  const encoded = encodeIntent(intent);
  return { target: encoded.to, value: encoded.value, calldata: encoded.data };
}
function address(value: string): string {
  if (!ethers.utils.isAddress(value) || value.toLowerCase() === ethers.constants.AddressZero) throw new Error('INVALID_MODULE_OR_ACCOUNT');
  return value.toLowerCase();
}
export interface RolePlanningContext {
  readiness: AuthorityReadiness;
  executorAuthorized: Fact<boolean>;
  subjects: readonly { subjectId: string; kind: 'Role' | 'Group' }[];
  groupEdges: readonly { roleSubjectId: string; groupSubjectId: string; isActive: boolean }[];
  /** _isInOrg is acceptance ANYWHERE, including an accepted but ineligible role. */
  accounts: readonly { account: string; acceptedAnywhere: Fact<boolean> }[];
  taskManager?: { address: string; executorAuthorized: Fact<boolean> };
  hybrid?: { address: string; executorAuthorized: Fact<boolean>; classes: readonly { classIndex: number }[] };
  registry?: { address: string; executorAuthorized: Fact<boolean>; currentAdminSubject: Fact<string> };
  sponsorship?: { address: string; operatorAuthorized: Fact<boolean>; claimBudgetExists: Fact<boolean> };
  email?: { address: string; enabled: Fact<boolean>; authorityMatches: Fact<boolean>; minterAuthorized: Fact<boolean>;
    domainEnabled: Fact<boolean>; emailEnabled: Fact<boolean>; currentRoot: Fact<string>; executorAddress: string };
}
export interface RolePermissionRequest { key: string; value: string; projectId?: string; inheritGlobal?: boolean }
export interface RoleConfigurationRequest {
  kind: 'Role' | 'Group'; name: string; metadataPointer?: string; imageURI?: string;
  maxMembers?: string; defaultAllow?: boolean; groupIds?: readonly string[]; memberRoleIds?: readonly string[];
  permissions?: readonly RolePermissionRequest[];
  vouch?: { quorum: string; voucherSubjectId: string; selfVouch?: boolean };
  manager?: { managerSubjectId: string; caps: number; delaySeconds: string };
  holders?: readonly { account: string; sticky: boolean }[];
  taskGrants?: { creator: boolean; organizer: boolean };
  bindingClassIndex?: number; editOrgDetails?: boolean;
  sponsorship?: { capRaw: string; epochSeconds: string; supportPasskeys?: boolean; initializeClaimBudget?: boolean;
    /** Opt in to existing org email rules without creating role email additions. Requires supportPasskeys. */
    includeConfiguredEmailRules?: boolean };
  /** Prepared CID binds the deterministic merger's root, rather than an arbitrary replacement. */
  email?: { current?: VerifiedAllowlist; additions: readonly { type: 'domain' | 'email'; identifier: string }[]; preparedRoot: string; cid: string };
}
export interface RoleConfigurationPlan { subjectId: string; batch: ExecutionCall[]; createsSubject: true; fingerprint: string }
export interface RolePlanningInput {
  scope: PlanScope; freshness: PlanningFreshness; request: RoleConfigurationRequest;
  context: SourceSnapshot<RolePlanningContext>; allocations: SourceSnapshot<readonly SubjectAllocation[]>;
  proposals: SourceSnapshot<readonly SubjectCreationProposal[]>;
}

/** Pure ordered compound plan. Requested branches fail atomically; no uploads, gas options or partial plan. */
export function planRoleConfiguration(input: RolePlanningInput): PlanResult<RoleConfigurationPlan> {
  const consequences: PlanConsequence[] = [{ code: 'SUBJECT_CREATION_RACE', values: { executionStable: false } }];
  try {
    const scope = input.scope;
    if (!scope.contract || !scope.orgId) throw new Error('ROLE_SCOPE_REQUIRED');
    address(scope.contract);
    const context = requireLivePlanningSnapshot(input.context, scope, input.freshness);
    const r = input.request;
    for (const value of [r.defaultAllow, r.editOrgDetails, r.vouch?.selfVouch, r.taskGrants?.creator, r.taskGrants?.organizer,
      r.sponsorship?.supportPasskeys, r.sponsorship?.initializeClaimBudget, r.sponsorship?.includeConfiguredEmailRules]) if (value !== undefined && typeof value !== 'boolean') throw new Error('INVALID_ROLE_BOOLEAN');
    if (!isAuthorityReady(context.readiness) || context.readiness.membershipAuthority!.id!.toLowerCase() !== scope.contract.toLowerCase()) throw new Error('AUTHORITY_UNAVAILABLE');
    const fact = <T>(value: Fact<T> | undefined, code: string, contract = scope.contract): T => requirePlanningFact(value, input.context, { ...scope, contract }, code);
    const enabled = (value: Fact<boolean> | undefined, code: string, contract = scope.contract): void => { if (fact(value, code, contract) !== true) throw new Error(code); };
    const module = (key: string, value: string) => {
      address(value);
      // Keep expected target validation independent of observed target input.
      if (scope.contracts?.[key] !== undefined) assertPlanScope({ chainId: scope.chainId, contracts: { [key]: value } },
        { chainId: scope.chainId, contracts: { [key]: scope.contracts[key] } });
      assertPlanScope(input.context.source, { chainId: scope.chainId, orgId: scope.orgId, contracts: { [key]: value } });
    };
    for (const source of [input.context.source, scope]) if (source.contracts?.membershipAuthority !== undefined) {
      assertPlanScope({ chainId: scope.chainId, contract: scope.contract }, { chainId: scope.chainId, contract: source.contracts.membershipAuthority });
    }
    enabled(context.executorAuthorized, 'EXECUTOR_AUTHORIZATION_REQUIRED');
    requireCompleteSnapshot(input.allocations, { scope, snapshot: 'pinned', block: input.freshness.block });
    const prediction = predictNextSubjectIds({ authority: scope.contract, history: input.allocations, scope });
    if (prediction.status !== 'ready') return prediction;
    const subjectId = prediction.data.subjectIds[0];
    requireCompleteSnapshot(input.proposals, { scope: { chainId: scope.chainId, orgId: scope.orgId }, snapshot: 'pinned', block: input.freshness.block });
    const race = subjectCreationRaceFacts(input.proposals, { chainId: scope.chainId, orgId: scope.orgId });
    if (race.hasCompetingCreation.state !== 'known') throw new Error('PROPOSAL_HISTORY_UNAVAILABLE');
    if (race.hasCompetingCreation.value) throw new Error('COMPETING_SUBJECT_CREATION');
    if (!['Role', 'Group'].includes(r.kind) || typeof r.name !== 'string' || !r.name.trim()) throw new Error('INVALID_ROLE_CONFIGURATION');
    if (r.defaultAllow !== undefined && typeof r.defaultAllow !== 'boolean') throw new Error('INVALID_ROLE_CONFIGURATION');
    if (r.kind === 'Group' && (r.holders?.length || r.vouch || r.defaultAllow || r.maxMembers !== undefined || r.groupIds?.length || r.email)) throw new Error('GROUP_HAS_ROLE_ONLY_REQUESTS');
    if (r.kind === 'Role' && r.memberRoleIds?.length) throw new Error('ROLE_HAS_GROUP_ONLY_REQUESTS');
    const subjects = new Map(context.subjects.map(s => [normalizeSubjectId(s.subjectId), s.kind]));
    if (subjects.size !== context.subjects.length) throw new Error('DUPLICATE_SUBJECT');
    if (input.allocations.source.block && input.context.source.block) assertSourceBlock(input.allocations.source.block, input.context.source.block);
    const allocated = new Set(input.allocations.data.map(row => normalizeSubjectId(row.subjectId)));
    if (context.subjects.some(s => !allocated.has(normalizeSubjectId(s.subjectId)))) throw new Error('ALLOCATION_CONTEXT_CHANGED');
    const edges = new Set<string>();
    for (const edge of context.groupEdges) {
      const role = normalizeSubjectId(edge.roleSubjectId), group = normalizeSubjectId(edge.groupSubjectId), key = role + ':' + group;
      if (edges.has(key) || typeof edge.isActive !== 'boolean' || subjects.get(role) !== 'Role' || subjects.get(group) !== 'Group') throw new Error('INVALID_GROUP_EDGES');
      edges.add(key);
    }
    const ids = (values: readonly string[] | undefined, kind: 'Role' | 'Group'): string[] => {
      const list = (values ?? []).map(normalizeSubjectId);
      if (new Set(list).size !== list.length || list.some(id => subjects.get(id) !== kind)) throw new Error('INVALID_COMPOSITION_SUBJECTS');
      return list;
    };
    const groups = ids(r.groupIds, 'Group'), roles = ids(r.memberRoleIds, 'Role');
    if (groups.length > 8 || roles.length > 16) throw new Error('COMPOSITION_LIMIT');
    for (const id of groups) if (context.groupEdges.filter(e => normalizeSubjectId(e.groupSubjectId) === id && e.isActive).length >= 16) throw new Error('COMPOSITION_LIMIT');
    for (const id of roles) if (context.groupEdges.filter(e => normalizeSubjectId(e.roleSubjectId) === id && e.isActive).length >= 8) throw new Error('COMPOSITION_LIMIT');
    const call = (method: Parameters<typeof authorityExecutionCall>[1], args: unknown[]) => authorityExecutionCall(scope.contract!, method, args);
    const metadata = r.metadataPointer === undefined ? ethers.constants.HashZero : metadataPointerToBytes32(r.metadataPointer);
    const batch = [r.kind === 'Role' ? call('createRole', [r.name, metadata, r.imageURI ?? '', requireRawUint(r.maxMembers ?? '0', 32)])
      : call('createGroup', [r.name, metadata, r.imageURI ?? '', roles])];
    if (r.defaultAllow) batch.push(call('setSubjectDefault', [subjectId, true, false]));
    for (const id of groups) batch.push(call('addRoleToGroup', [subjectId, id]));
    const permissionKeys = new Set<string>();
    for (const p of r.permissions ?? []) {
      if (!ethers.utils.isHexString(p.key, 32)) throw new Error('INVALID_PERMISSION_KEY');
      if (p.inheritGlobal !== undefined && typeof p.inheritGlobal !== 'boolean') throw new Error('INVALID_PERMISSION_INHERITANCE');
      const ctx = p.projectId === undefined ? ethers.constants.HashZero : projectContext(requireRawUint(p.projectId));
      const key = p.key.toLowerCase() + ctx;
      if (permissionKeys.has(key)) throw new Error('DUPLICATE_PERMISSION');
      permissionKeys.add(key);
      batch.push(call('setPerm', [subjectId, p.key, ctx, permissionWord(requireRawUint(p.value, 254), p.inheritGlobal ?? false)]));
    }
    if (r.vouch) {
      const quorum = requireRawUint(r.vouch.quorum, 32);
      if (quorum === '0') throw new Error('INVALID_VOUCH_QUORUM');
      const voucher = r.vouch.selfVouch ? subjectId : normalizeSubjectId(r.vouch.voucherSubjectId);
      if (voucher !== subjectId && !subjects.has(voucher)) throw new Error('VOUCHER_SUBJECT_UNAVAILABLE');
      batch.push(call('configureVouchAttestor', [subjectId, quorum, voucher]));
    }
    const manager = () => {
      if (!r.manager) return;
      const id = normalizeSubjectId(r.manager.managerSubjectId);
      if (id !== '0' && !subjects.has(id)) throw new Error('MANAGER_SUBJECT_UNAVAILABLE');
      if (r.kind === 'Group' && roles.includes(id)) throw new Error('SELF_MANAGED_GROUP_CYCLE');
      if (!Number.isInteger(r.manager.caps) || r.manager.caps < 0 || r.manager.caps > 15) throw new Error('INVALID_MANAGER_CAPS');
      batch.push(call('setManagerConfig', [subjectId, id, r.manager.caps, requireRawUint(r.manager.delaySeconds, 32)]));
    };
    if (r.kind === 'Role') manager();
    const accounts = new Map(context.accounts.map(a => [address(a.account), a.acceptedAnywhere]));
    if (accounts.size !== context.accounts.length) throw new Error('DUPLICATE_ACCOUNT_FACT');
    const holders = new Set<string>();
    let grants = 0;
    for (const holder of r.holders ?? []) {
      const account = address(holder.account);
      if (holders.has(account) || typeof holder.sticky !== 'boolean') throw new Error('INVALID_OR_DUPLICATE_HOLDER');
      holders.add(account);
      const accepted = requirePlanningFact(accounts.get(account), input.context, { ...scope, account }, 'ACCEPTANCE_ANYWHERE_UNAVAILABLE');
      if (typeof accepted !== 'boolean') throw new Error('ACCEPTANCE_ANYWHERE_UNAVAILABLE');
      if (accepted) grants++;
      batch.push(call(accepted ? 'grant' : 'offer', [subjectId, account, !holder.sticky]));
    }
    const cap = BigInt(requireRawUint(r.maxMembers ?? '0', 32));
    if (cap > 0n && BigInt(grants) > cap) throw new Error('SUBJECT_CAPACITY_EXCEEDED');
    if (r.kind === 'Group') manager();
    if (r.taskGrants?.creator || r.taskGrants?.organizer) {
      if (!context.taskManager) throw new Error('TASK_MANAGER_CONTEXT_REQUIRED');
      module('taskManager', context.taskManager.address);
      enabled(context.taskManager.executorAuthorized, 'TASK_MANAGER_AUTHORIZATION_REQUIRED', context.taskManager.address);
      for (const key of [...(r.taskGrants.creator ? [1] : []), ...(r.taskGrants.organizer ? [7] : [])]) batch.push(encodeExecutorCall('TaskManagerNew', address(context.taskManager.address), 'setConfig', [key, ethers.utils.defaultAbiCoder.encode(['uint256', 'bool'], [subjectId, true])]));
    }
    if (r.bindingClassIndex !== undefined) {
      const h = context.hybrid;
      if (!h) throw new Error('HYBRID_CONTEXT_REQUIRED');
      module('hybridVoting', h.address);
      enabled(h.executorAuthorized, 'HYBRID_AUTHORIZATION_REQUIRED', h.address);
      if (!Number.isSafeInteger(r.bindingClassIndex) || !h.classes.some(c => c.classIndex === r.bindingClassIndex)) throw new Error('BINDING_CLASS_UNAVAILABLE');
      batch.push(encodeExecutorCall('HybridVotingNew', address(h.address), 'addHatToClass', [r.bindingClassIndex, subjectId]));
    }
    if (r.editOrgDetails) {
      const registry = context.registry;
      if (!registry) throw new Error('ORG_ADMIN_CONTEXT_REQUIRED');
      module('registry', registry.address);
      enabled(registry.executorAuthorized, 'ORG_ADMIN_AUTHORIZATION_REQUIRED', registry.address);
      normalizeSubjectId(fact(registry.currentAdminSubject, 'CURRENT_ADMIN_UNAVAILABLE', registry.address));
      batch.push(encodeExecutorCall('OrgRegistry', address(registry.address), 'setOrgMetadataAdminHat', [scope.orgId, subjectId]));
      consequences.push({ code: 'REPLACE_ORG_METADATA_ADMIN', values: { subjectId } });
    }
    if (r.sponsorship) {
      const sponsor = context.sponsorship;
      if (!sponsor) throw new Error('SPONSORSHIP_CONTEXT_REQUIRED');
      module('paymaster', sponsor.address);
      const includeEmailRules = !!r.email || r.sponsorship.includeConfiguredEmailRules === true;
      if (r.sponsorship.includeConfiguredEmailRules && !r.sponsorship.supportPasskeys) throw new Error('EMAIL_RULES_REQUIRE_PASSKEY_SUPPORT');
      if ((r.sponsorship.supportPasskeys !== undefined && typeof r.sponsorship.supportPasskeys !== 'boolean')
        || (r.sponsorship.initializeClaimBudget && (!r.sponsorship.supportPasskeys || !includeEmailRules))) throw new Error('INVALID_CLAIM_BUDGET_REQUEST');
      enabled(sponsor.operatorAuthorized, 'SPONSORSHIP_OPERATOR_REQUIRED', sponsor.address);
      const capRaw = requireRawUint(r.sponsorship.capRaw, 128), epoch = requireRawUint(r.sponsorship.epochSeconds, 32);
      if (BigInt(epoch) < 3600n || BigInt(epoch) > 31536000n) throw new Error('INVALID_SPONSORSHIP_EPOCH');
      const budget = (type: number, id: string) => encodeExecutorCall('PaymasterHub', address(sponsor.address), 'setBudget', [scope.orgId, paymasterSubjectKey(type, id), capRaw, epoch]);
      batch.push(budget(SUBJECT_TYPE.HAT, subjectId));
      if (r.sponsorship.supportPasskeys) {
        const rules: { target: string; selector: string; hint: number }[] = [];
        const iface = new ethers.utils.Interface(buildAuthorityAction({ authorityAddress: scope.contract, method: 'claim', args: [subjectId] }).abi);
        for (const [name, hint] of [['claim', 300000], ['renounce', 200000], ['vouch', 0], ['revokeVouch', 200000], ['delegatedGrant', 250000], ['delegatedOffer', 300000], ['delegatedRemove', 250000], ['delegatedUnremove', 200000], ['finalize', 600000], ['cancel', 200000]] as const) rules.push({ target: scope.contract, selector: iface.getSighash(name), hint });
        if (includeEmailRules) {
          const email = context.email;
          if (!email) throw new Error('EMAIL_CONTEXT_REQUIRED');
          module('email', email.address); module('executor', email.executorAddress);
          enabled(email.enabled, 'EMAIL_DISABLED', email.address);
          enabled(email.authorityMatches, 'EMAIL_AUTHORITY_MISMATCH', email.address);
          const domainMode = fact(email.domainEnabled, 'DOMAIN_VERIFIER_UNAVAILABLE', email.address);
          const emailMode = fact(email.emailEnabled, 'EMAIL_VERIFIER_UNAVAILABLE', email.address);
          if (typeof domainMode !== 'boolean' || typeof emailMode !== 'boolean') throw new Error('EMAIL_MODES_UNAVAILABLE');
          if (!domainMode && !emailMode) throw new Error('EMAIL_VERIFIERS_DISABLED');
          // A configured-only request cannot repair minter authorization or an inactive root.
          // The existing additions branch below explicitly plans those changes when requested.
          if (!r.email) {
            enabled(email.minterAuthorized, 'EMAIL_MINTER_AUTHORIZATION_REQUIRED', email.executorAddress);
            const root = fact(email.currentRoot, 'CURRENT_ALLOWLIST_ROOT_UNAVAILABLE', email.address);
            if (!ethers.utils.isHexString(root, 32) || root.toLowerCase() === ethers.constants.HashZero) throw new Error('ACTIVE_ALLOWLIST_REQUIRED');
          }
          // Selectors come from the shared current ABI, never inferred from UI names.
          for (const [name, hint, mode] of [['claimRoleByDomain', 800000, domainMode], ['claimRoleByEmail', 800000, emailMode], ['registerAndClaimByDomainWithPasskey', 1200000, domainMode], ['registerAndClaimByEmailWithPasskey', 1200000, emailMode]] as const) {
            if (mode) rules.push({ target: address(email.address), selector: new ethers.utils.Interface(getAbi('ZkEmailInvites')).getSighash(name), hint });
          }
        }
        if (r.editOrgDetails) rules.push({ target: context.registry!.address, selector: ethers.utils.id('updateOrgMetaAsAdmin(bytes32,bytes,bytes32)').slice(0, 10), hint: 0 });
        batch.push(encodeExecutorCall('PaymasterHub', address(sponsor.address), 'setRulesBatch', [scope.orgId, rules.map(r => r.target), rules.map(r => r.selector), rules.map(() => true), rules.map(r => r.hint)]));
        if (includeEmailRules) {
          const exists = fact(sponsor.claimBudgetExists, 'CLAIM_BUDGET_UNAVAILABLE', sponsor.address);
          if (typeof exists !== 'boolean') throw new Error('CLAIM_BUDGET_UNAVAILABLE');
          if (!exists && !r.sponsorship.initializeClaimBudget) throw new Error('CLAIM_BUDGET_INITIALIZATION_REQUIRED');
          if (!exists) {
            batch.push(budget(SUBJECT_TYPE.CLAIM, context.email!.address));
            consequences.push({ code: 'INITIALIZE_EMAIL_CLAIM_BUDGET', values: { email: context.email!.address, capRaw, epochSeconds: epoch } });
          }
        }
      }
      consequences.push({ code: 'SHARED_SPONSORSHIP_BUDGET', values: { subjectId, capRaw, epochSeconds: epoch } });
    }
    if (r.email) {
      const email = context.email;
      if (!email) throw new Error('EMAIL_CONTEXT_REQUIRED');
      module('email', email.address); module('executor', email.executorAddress);
      enabled(email.enabled, 'EMAIL_DISABLED', email.address); enabled(email.authorityMatches, 'EMAIL_AUTHORITY_MISMATCH', email.address);
      if (!r.email.additions.length) throw new Error('EMPTY_EMAIL_ADDITIONS');
      if (r.email.additions.some(a => a.type === 'domain')) enabled(email.domainEnabled, 'DOMAIN_VERIFIER_UNAVAILABLE', email.address);
      if (r.email.additions.some(a => a.type === 'email')) enabled(email.emailEnabled, 'EMAIL_VERIFIER_UNAVAILABLE', email.address);
      const authorized = fact(email.minterAuthorized, 'MINTER_AUTHORIZATION_UNAVAILABLE', email.executorAddress);
      if (typeof authorized !== 'boolean') throw new Error('MINTER_AUTHORIZATION_UNAVAILABLE');
      if (!authorized) batch.push(encodeExecutorCall('Executor', address(email.executorAddress), 'setHatMinterAuthorization', [address(email.address), true]));
      const root = fact(email.currentRoot, 'CURRENT_ALLOWLIST_ROOT_UNAVAILABLE', email.address);
      const merged = mergeVerifiedAllowlist({ orgId: scope.orgId, currentRoot: root, current: r.email.current,
        entries: r.email.additions.map(a => ({ ...a, hatIds: [subjectId], roleIndexes: [] })) });
      if (merged.root.toLowerCase() !== r.email.preparedRoot.toLowerCase()) throw new Error('PREPARED_ALLOWLIST_CHANGED');
      batch.push(encodeExecutorCall('ZkEmailInvites', address(email.address), 'setActiveAllowlist', [merged.root, metadataPointerToBytes32(r.email.cid)]));
      consequences.push({ code: 'ALLOWLIST_EXECUTION_RACE', values: { root: merged.root } });
    }
    validateGovernanceBatches([batch]);
    const fingerprint = ethers.utils.id(JSON.stringify([scope, input.context.data, input.allocations.data, input.proposals.data, batch]));
    return { status: 'ready', data: { subjectId, batch, createsSubject: true, fingerprint }, consequences };
  } catch (error) { return governancePlanBlocked(error, consequences); }
}

/** Rebuild from newly supplied live facts before submission; no cached plan is authority. */
export function validateRolePlanFreshness(plan: RoleConfigurationPlan, current: RolePlanningInput): PlanResult<RoleConfigurationPlan> {
  const next = planRoleConfiguration(current);
  return next.status !== 'ready' ? next : next.data.fingerprint !== plan.fingerprint
    ? governancePlanBlocked(new Error('STALE_ROLE_PLAN'), next.consequences) : next;
}
