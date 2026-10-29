import { ethers } from 'ethers';
import { getAbi } from '../contracts';
import { requireRawUint } from '../amounts';
import { assertPlanScope, assertSourceBlock, Coverage, knownFact, requireCompleteSnapshot, SourceBlock, SourceRef, SourceSnapshot, unknownFact } from '../data/facts';
import { AuthoritySnapshotData, AuthoritySnapshotQuery, isAuthorityReady, readAuthoritySnapshot } from '../reads/authority';
import { ProtocolQuery } from '../reads/protocol';
import { ProvenanceProvider } from '../reads/provenance';
import { sourceIdentityKey } from '../graph/sources';
import { decodeIndexedAuthorityCap } from '../authority/indexed-cap';
import { STORAGE_KEYS } from '../task-lens';
import { paymasterSubjectKey, SUBJECT_TYPE } from '../sponsorship/codec';
import { readProposalArchive } from '../reads/vote';
import { readSubjectCreationProvenance, recoverSubjectCreationHistory, VerifiedSubjectCreation } from './provenance';
import { SubjectCreationProposal, normalizeSubjectId } from '../authority/ids';
import { emailHash } from '../zkemail';
import { RolePlanningContext } from './role-planning';
import type { ReadRoleOperationEvidenceInput, ReadRoleOperationStatusInput, RoleOperationEvidence, RoleOperationObservationSet, RoleOperationRequest, RoleOperationResult, RoleOperationScope, RoleOperationSources } from './role-operation-types';

export const same = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const nonzero = (value: unknown): value is string => typeof value === 'string' && ethers.utils.isAddress(value) && !same(value, ethers.constants.AddressZero);
export function active(signal?: AbortSignal): void {
  if (signal?.aborted) { const error = new Error('ROLE_OPERATION_ABORTED'); error.name = 'AbortError'; throw error; }
}
export function clock(sources: RoleOperationSources): number {
  const now = sources.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('INVALID_ROLE_OPERATION_CLOCK');
  return now;
}
export function failure<T>(error: unknown, observations?: RoleOperationObservationSet, status: 'blocked' | 'unknown' = 'unknown'): RoleOperationResult<T> {
  if ((error as Error)?.name === 'AbortError') throw error;
  const candidate = (error as { code?: string })?.code ?? (error instanceof Error ? error.message : '');
  const code = /^[A-Z][A-Z_0-9]+$/.test(candidate) ? candidate : 'ROLE_OPERATION_EVIDENCE_UNAVAILABLE';
  return { status, codes: [code], prerequisites: [{ code }], consequences: [], ...(observations ? { observations } : {}) };
}
export function validateScope(scope: RoleOperationScope, sources: RoleOperationSources): void {
  if (!scope || !/^0x[\da-f]{64}$/i.test(scope.orgId) || !nonzero(scope.contract) || !nonzero(scope.account)
    || !same(scope.contract, scope.contracts?.membershipAuthority)
    || !['membershipAuthority', 'hybridVoting', 'executor'].every(key => nonzero(scope.contracts[key]))
    || Object.values(scope.contracts).some(value => !nonzero(value)) || !Number.isSafeInteger(scope.chainId) || scope.chainId <= 0
    || scope.endpoint !== undefined || scope.method !== undefined) throw new Error('ROLE_OPERATION_SCOPE_REQUIRED');
  for (const endpoint of [sources.indexed.endpoint, sources.rpc.endpoint]) if (typeof endpoint !== 'string' || !endpoint.trim() || endpoint !== endpoint.trim()) throw new Error('ROLE_OPERATION_ENDPOINT_REQUIRED');
  clock(sources);
}
export function roleDemand(request: RoleOperationRequest) {
  const r = request.role, selected = request.mode !== 'create';
  return { tasks: selected && !!(r.taskGrants?.creator || r.taskGrants?.organizer), binding: selected && r.bindingClassIndex !== undefined,
    registry: selected && !!r.editOrgDetails, sponsorship: selected && !!r.sponsorship,
    email: selected && (!!r.emailAdditions?.length || !!(r.sponsorship?.supportPasskeys && r.sponsorship.includeConfiguredEmailRules)),
    capacity: selected && request.mode === 'existing' && r.kind === 'Role' && (r.maxMembers !== undefined || !!r.holders?.length),
    accounts: selected ? [...new Set((r.holders ?? []).map(row => row.account.toLowerCase()))].sort() : [] };
}
/** Options depend on available bound modules, never a hypothetical subject or
 * the unfinished form's selected configuration. These facts do not authorize it. */
export function capabilityDemand(scope: RoleOperationScope) {
  return { tasks: !!scope.contracts.taskManager, binding: !!scope.contracts.hybridVoting,
    registry: !!scope.contracts.registry, sponsorship: !!scope.contracts.paymaster,
    email: !!scope.contracts.email, capacity: false, accounts: [] as string[] };
}
/** Only exact canonical authorization errors from this module's ABI prove denial.
 * Transport failures, generic reverts and unrelated contract errors stay unknown. */
function denied(error: unknown, name: string, expected: string): boolean {
  const iface = new ethers.utils.Interface(getAbi(name));
  const value = error as { data?: unknown; error?: { data?: unknown; error?: { data?: unknown } } };
  for (const data of [value?.data, value?.error?.data, value?.error?.error?.data]) if (typeof data === 'string') {
    try {
      const parsed = iface.parseError(data);
      if (parsed.name === expected && same(iface.encodeErrorResult(parsed.signature, parsed.args), data)) return true;
    } catch { /* Unrecognized evidence never proves denial. */ }
  }
  return false;
}
export function finite(value: number | undefined, fallback: number, cap = Number.MAX_SAFE_INTEGER): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > cap) throw new Error('INVALID_ROLE_OPERATION_BOUNDS');
  return n;
}
/** Every invocation goes through the injected host transport (including exact proof reads).
 * The host retains scheduling/sharing. Core enforces cancellation and the optional total budget. */
export function transport(input: Pick<ReadRoleOperationEvidenceInput, 'sources' | 'signal' | 'bounds'>) {
  const { sources, signal } = input;
  let used = 0;
  const max = finite(input.bounds?.maxRpcCalls, Number.MAX_SAFE_INTEGER);
  const run = async <T>(fn: () => Promise<T>): Promise<T> => { active(signal); const result = await fn(); active(signal); return result; };
  const provider = Object.fromEntries(['getNetwork', 'getBlock', 'getTransaction', 'getTransactionReceipt', 'call'].map(method => [method,
    (...args: unknown[]) => run(() => {
      if (++used > max) throw new Error('ROLE_RPC_BUDGET_EXHAUSTED');
      return (sources.rpc.provider[method as keyof typeof sources.rpc.provider] as (...args: unknown[]) => Promise<unknown>).apply(sources.rpc.provider, args);
    })])) as unknown as RoleOperationSources['rpc']['provider'];
  const query: AuthoritySnapshotQuery = (source, document, variables) => run(async () => {
    const result = await sources.indexed.query<any>(source, document, variables);
    if (!result || !Array.isArray(result.issues)) throw new Error('ROLE_INDEX_RESPONSE_UNAVAILABLE');
    assertPlanScope(result.source, source);
    if (result.source.indexed !== true || result.source.snapshot !== source.snapshot) throw new Error('ROLE_INDEX_SOURCE_MISMATCH');
    if (Array.isArray(result.data?.errors) && result.data.errors.length) return { ...result, issues: [...result.issues, { code: 'GRAPHQL_ERROR' }] };
    return result;
  });
  const protocol: ProtocolQuery = async (document, variables, source) => {
    const result = await query<any>(source, document, variables);
    if (result.issues.length || !result.data || (Array.isArray(result.data.errors) && result.data.errors.length)) throw new Error('ROLE_INDEX_RESPONSE_INCOMPLETE');
    return result.data;
  };
  return { provider, query, protocol, run };
}
const HEAD = `query RoleOperationHead { _meta { block { number hash timestamp } } }`;
const orgFields: Readonly<Record<string, string>> = { membershipAuthority: 'membershipAuthority', executor: 'executorContract', hybridVoting: 'hybridVoting', taskManager: 'taskManager', email: 'zkEmailInvites', participationToken: 'participationToken', paymentManager: 'paymentManager' };
function bindingDocument(scope: RoleOperationScope): string {
  const fields = Object.keys(orgFields).filter(key => scope.contracts[key]).map(key => `${orgFields[key]} { id }`).join(' ');
  return `query RolePlanningModuleBindings($orgId: ID!, $block: Block_height) {
    _meta(block: $block) { block { number hash timestamp } }
    organization(id: $orgId, block: $block) { id ${fields} }
    ${scope.contracts.registry || scope.contracts.paymaster ? 'poaManagerContracts(first: 100, block: $block) { orgRegistryProxy paymasterHubProxy }' : ''}
  }`;
}
function observedBlock(raw: any): SourceBlock {
  if (!raw || !/^0x[\da-f]{64}$/i.test(raw.hash)) throw new Error('ROLE_BLOCK_UNAVAILABLE');
  return { number: requireRawUint(raw.number), hash: raw.hash, timestamp: requireRawUint(raw.timestamp) };
}
export function blockFresh(block: SourceBlock, sources: RoleOperationSources, start: number, maxAge = 30): void {
  const now = clock(sources), timestamp = Number(block.timestamp);
  if (!Number.isSafeInteger(timestamp) || now < start || now - start > 30 || now < timestamp || now - timestamp > maxAge) throw new Error('ROLE_OPERATION_EVIDENCE_STALE');
}
/** Validate the optimization's original per-collection proofs and projections, not
 * a caller's aggregate ready/complete flag. Cached field substitution is rejected. */
function validateAuthority(snapshot: SourceSnapshot<AuthoritySnapshotData>): void {
  const fields = ['subjects', 'subjectMemberships', 'groupCompositions', 'permRows', 'accessRules', 'subjectVouchRecords', 'pendingActions'];
  requireCompleteSnapshot(snapshot, { requiredKeys: fields.map(method => sourceIdentityKey({ ...snapshot.source, method })) });
  for (const method of fields) {
    const collection = snapshot.data.collections?.[method];
    if (!collection) throw new Error('ROLE_AUTHORITY_COLLECTION_UNAVAILABLE');
    requireCompleteSnapshot(collection, { scope: { ...snapshot.source, method }, indexed: true, snapshot: 'pinned', block: snapshot.source.block });
    assertSourceBlock(snapshot.source.block, collection.source.block!);
  }
  const data = snapshot.data, authority = data.authority;
  if (data.ready.source) {
    assertPlanScope(data.ready.source, snapshot.source);
    assertSourceBlock(data.ready.source.block, snapshot.source.block!);
  }
  if (!authority || !same(authority.id, snapshot.source.contract) || data.ready.state !== 'known'
    || data.ready.value !== isAuthorityReady({ membershipAuthority: authority }) || data.ready.value !== true) throw new Error('AUTHORITY_READINESS_UNAVAILABLE');
  const actualSubjects = data.collections.subjects.data;
  if (actualSubjects.length !== data.subjects.length || new Set(data.subjects.map(row => row.subjectId)).size !== data.subjects.length) throw new Error('ROLE_AUTHORITY_PROJECTION_MISMATCH');
  for (const row of data.subjects) {
    const raw = actualSubjects.find(raw => raw.subjectId === row.subjectId);
    if (!raw || raw.id !== row.subjectId || row.kind !== raw.kind || row.name !== raw.name || row.defaultAllow !== raw.defaultAllow
      || row.maxMembers !== decodeIndexedAuthorityCap(raw.maxMembers as string) || row.memberCount !== requireRawUint(raw.memberCount as string)) throw new Error('ROLE_AUTHORITY_PROJECTION_MISMATCH');
  }
  const rawEdges = data.collections.groupCompositions.data;
  if (rawEdges.length !== data.groupEdges.length || data.groupEdges.some(row => !rawEdges.some(raw =>
    raw.groupSubjectId === row.groupSubjectId && raw.roleSubjectId === row.roleSubjectId && raw.isActive === row.isActive))) throw new Error('ROLE_AUTHORITY_PROJECTION_MISMATCH');
  for (const [field, count] of Object.entries({ subjectCount: data.subjects.length,
    roleSubjectCount: data.subjects.filter(row => row.kind === 'Role').length, groupSubjectCount: data.subjects.filter(row => row.kind === 'Group').length,
    acceptedMembershipCount: data.collections.subjectMemberships.data.filter(row => row.accepted === true).length })) {
    if (requireRawUint(authority[field] as string, 32) !== String(count)) throw new Error('ROLE_AUTHORITY_COUNT_MISMATCH');
  }
}
export async function readBase(input: Pick<ReadRoleOperationEvidenceInput, 'scope' | 'sources' | 'signal' | 'bounds' | 'authoritySnapshot'>,
  io: ReturnType<typeof transport>, observations: RoleOperationObservationSet) {
  const { scope, sources, bounds } = input;
  validateScope(scope, sources); active(input.signal);
  for (const [key, value] of Object.entries(bounds ?? {})) finite(value, 1,
    key === 'authorityPageSize' || key === 'proposalPageSize' ? 1000 : key === 'maxAccounts' ? 50 : key === 'maxCompoundSubjects' ? 256 : Number.MAX_SAFE_INTEGER);
  const start = clock(sources);
  let authority = input.authoritySnapshot;
  if (!authority) {
    const latest: SourceRef = { chainId: scope.chainId, orgId: scope.orgId, contract: scope.contract,
      endpoint: sources.indexed.endpoint, method: 'role-operation-head', indexed: true, snapshot: 'latest', observedAt: start };
    const result = await io.protocol(HEAD, {}, latest);
    const block = observedBlock((result._meta as any)?.block);
    authority = await readAuthoritySnapshot({ source: { ...latest, snapshot: 'pinned', block: { number: block.number, hash: block.hash } }, query: io.query,
      pageSize: bounds?.authorityPageSize, maxPages: bounds?.authorityMaxPages, maxRows: bounds?.authorityMaxRows });
  }
  observations.authority = authority;
  // A ready=false authority is a known refusal, but incomplete/missing collections never become ready.
  requireCompleteSnapshot(authority, { scope: { chainId: scope.chainId, orgId: scope.orgId, contract: scope.contract, endpoint: sources.indexed.endpoint }, indexed: true, snapshot: 'pinned' });
  validateAuthority(authority);
  if (authority.data.ready.state !== 'known') throw new Error('AUTHORITY_READINESS_UNAVAILABLE');
  if (authority.data.ready.value !== true) throw new Error('AUTHORITY_NOT_READY');
  if (authority.source.account !== undefined && !same(authority.source.account, scope.account)) throw new Error('ROLE_ACCOUNT_SCOPE_MISMATCH');
  if (!authority.source.block?.hash) throw new Error('ROLE_HASH_PIN_REQUIRED');
  const block = observedBlock(await io.provider.getBlock(Number(requireRawUint(authority.source.block.number, 31))));
  assertSourceBlock(block, authority.source.block);
  // Initial head gate is 60s; completed observations must still pass the stricter 30s gate.
  const now = clock(sources), timestamp = Number(block.timestamp);
  if (now < start || now < timestamp || now - timestamp > 60) throw new Error('ROLE_INDEX_HEAD_STALE');
  if ((await io.provider.getNetwork()).chainId !== scope.chainId) throw new Error('ROLE_CHAIN_MISMATCH');
  const source: SourceRef = { ...scope, endpoint: sources.rpc.endpoint, method: 'role-operation-observation', indexed: false, snapshot: 'pinned', block, observedAt: start };
  const indexed: SourceRef = { ...scope, endpoint: sources.indexed.endpoint, method: 'role-operation-bindings', indexed: true, snapshot: 'pinned', block, observedAt: start };
  const result = await io.protocol(bindingDocument(scope), { orgId: scope.orgId, block: { hash: block.hash } }, indexed);
  assertSourceBlock(observedBlock((result._meta as any)?.block), block);
  const org = result.organization as any;
  if (!same(org?.id, scope.orgId) || Object.entries(orgFields).some(([key, field]) => scope.contracts[key] && !same(org?.[field]?.id, scope.contracts[key]))) throw new Error('ROLE_MODULE_BINDING_MISMATCH');
  if ((scope.contracts.registry || scope.contracts.paymaster) && !(result.poaManagerContracts as any[])?.some(row =>
    (!scope.contracts.registry || same(row.orgRegistryProxy, scope.contracts.registry)) && (!scope.contracts.paymaster || same(row.paymasterHubProxy, scope.contracts.paymaster)))) throw new Error('ROLE_INFRASTRUCTURE_BINDING_UNPROVEN');
  const protocolQuery: ProtocolQuery = io.protocol;
  return { authority, block, start, source, indexed, protocolQuery };
}
export async function finishObservation(base: Awaited<ReturnType<typeof readBase>>, input: Pick<ReadRoleOperationEvidenceInput, 'sources' | 'signal'>, io: ReturnType<typeof transport>): Promise<void> {
  assertSourceBlock(observedBlock(await io.provider.getBlock(Number(base.block.number))), base.block);
  active(input.signal); blockFresh(base.block, input.sources, base.start);
}

/** Internal observer; public entry catches unavailable evidence without discarding its sources. */
export async function observe(input: ReadRoleOperationEvidenceInput, observations: RoleOperationObservationSet, suppliedIo?: ReturnType<typeof transport>): Promise<RoleOperationEvidence> {
  const { scope, request, sources, bounds } = input;
  if (!request || !['create', 'existing', 'compound'].includes(request.mode) || !request.role) throw new Error('ROLE_OPERATION_MODE_REQUIRED');
  const purpose = input.purpose === undefined ? 'operation' : input.purpose, operation = purpose === 'operation';
  if (!['operation', 'capabilities'].includes(purpose)) throw new Error('INVALID_ROLE_OPERATION_PURPOSE');
  const io = suppliedIo ?? transport(input), base = await readBase(input, io, observations), { authority, block, source, start } = base;
  const demand = operation ? roleDemand(request) : capabilityDemand(scope), r = request.role;
  if (demand.accounts.length > finite(bounds?.maxAccounts, 50, 50)) throw new Error('ROLE_ACCOUNT_LIMIT_EXCEEDED');
  if (demand.accounts.some(value => !nonzero(value))) throw new Error('INVALID_ROLE_HOLDER');
  if (operation && request.mode === 'compound' && authority.data.subjects.length > finite(bounds?.maxCompoundSubjects, 256, 256)) throw new Error('ROLE_COMPOUND_SUBJECT_LIMIT_EXCEEDED');
  for (const [selected, key] of [[demand.tasks, 'taskManager'], [demand.binding, 'hybridVoting'], [demand.registry, 'registry'], [demand.sponsorship, 'paymaster'], [demand.email, 'email']] as const) if (selected && !scope.contracts[key]) throw new Error('ROLE_REQUESTED_MODULE_UNAVAILABLE');
  const expected = ['module-bindings', 'authority:executor', 'authority:orgId', 'canonical:after'];
  if (operation && request.mode === 'compound') expected.push('authority:subjectCount', 'compound:subjects', 'compound:edges', 'compound:history');
  if (operation && request.mode === 'existing') expected.push('existing:subject', ...(demand.capacity ? ['existing:capacity'] : []));
  for (const key of ['tasks', 'binding', 'registry', 'sponsorship', 'email'] as const) if (demand[key]) expected.push(key);
  for (const account of demand.accounts) expected.push('account:' + account);
  const received = new Set(['module-bindings']);
  const coverage = (): Coverage => ({ status: expected.every(key => received.has(key)) ? 'complete' : 'incomplete', expectedKeys: [...expected], receivedKeys: [...received], missingIds: expected.filter(key => !received.has(key)), failedIds: [], issues: [] });
  const data: RolePlanningContext = { indexedAuthoritySource: { ...authority.source, block }, readiness: { membershipAuthority: { id: scope.contract,
    isRouterBound: authority.data.authority?.isRouterBound as boolean, cutoverAt: authority.data.authority?.cutoverAt as string } },
    executorAuthorized: unknownFact('EXECUTOR_AUTHORIZATION_UNAVAILABLE', source),
    subjects: authority.data.subjects.map(row => ({ subjectId: row.subjectId, kind: row.kind, maxMembers: row.maxMembers, memberCount: row.memberCount })),
    groupEdges: authority.data.groupEdges.map(row => ({ groupSubjectId: row.groupSubjectId, roleSubjectId: row.roleSubjectId, isActive: row.isActive })), accounts: [] };
  const context: SourceSnapshot<RolePlanningContext> = { source, data, coverage: coverage() };
  observations.planning = context;
  const abi = new Map<string, ethers.utils.Interface>();
  const call = async (key: string, name: string, method: string, args: readonly unknown[] = [], from?: string) => {
    if (!abi.has(name)) abi.set(name, new ethers.utils.Interface(getAbi(name)));
    const iface = abi.get(name)!;
    const encoded = iface.encodeFunctionData(method, args);
    const raw = await io.provider.call({ to: scope.contracts[key], data: encoded, ...(from ? { from } : {}) }, Number(block.number));
    return iface.decodeFunctionResult(method, raw);
  };
  const auth = (method: string, args: readonly unknown[] = []) => call('membershipAuthority', 'MembershipAuthority', method, args);
  const fact = <T>(value: T, contract = scope.contract, account = scope.account) => knownFact(value, { ...source, contract, account });
  try {
    const [executor, orgId] = await Promise.all([auth('executor'), auth('orgId')]);
    data.executorAuthorized = fact(same(executor[0], scope.contracts.executor)); received.add('authority:executor');
    if (!same(orgId[0], scope.orgId)) throw new Error('ROLE_AUTHORITY_ORG_MISMATCH'); received.add('authority:orgId');
    if (operation && request.mode === 'compound') {
      if (String((await auth('subjectCount'))[0]) !== String(authority.data.subjects.length)) throw new Error('ROLE_SUBJECT_COUNT_MISMATCH'); received.add('authority:subjectCount');
      await Promise.all(authority.data.subjects.map(async row => {
        const live = (await auth('getSubject', [row.subjectId]))[0];
        if (live.exists !== true || live.name !== row.name || Number(live.kind) !== (row.kind === 'Group' ? 1 : 0)) throw new Error('ROLE_SUBJECT_CHANGED');
      })); received.add('compound:subjects');
      const edges = (await Promise.all(data.subjects.filter(row => row.kind === 'Group').map(async row =>
        ((await auth('groupMemberRoles', [row.subjectId]))[0] as ethers.BigNumber[]).map(id => ({ groupSubjectId: row.subjectId, roleSubjectId: String(id), isActive: true }))))).flat();
      const edgeKey = (rows: typeof edges) => rows.filter(row => row.isActive).map(row => row.roleSubjectId + ':' + row.groupSubjectId).sort().join(',');
      if (edgeKey(edges) !== edgeKey([...data.groupEdges])) throw new Error('ROLE_COMPOSITION_CHANGED'); received.add('compound:edges');
    }
    if (operation && request.mode === 'existing') {
      const id = normalizeSubjectId(request.subjectId), row = data.subjects.find(row => row.subjectId === id), indexed = authority.data.subjects.find(row => row.subjectId === id);
      if (!row || !indexed) throw new Error('EXISTING_SUBJECT_UNAVAILABLE');
      const live = (await auth('getSubject', [id]))[0];
      if (live.exists !== true || live.name !== indexed.name || Number(live.kind) !== (row.kind === 'Group' ? 1 : 0)) throw new Error('ROLE_SUBJECT_CHANGED');
      row.maxMembers = String(live.maxMembers); row.metadataPointer = live.metadataCID; row.imageURI = live.imageURI; received.add('existing:subject');
      if (demand.capacity) { row.memberCount = String((await auth('memberCount', [id]))[0]); received.add('existing:capacity'); }
    }
    data.accounts = await Promise.all(demand.accounts.map(async account => {
      const accepted = (await auth('userSubjects', [account]))[0];
      const result = { account, acceptedAnywhere: fact(accepted.length > 0, scope.contract, account), ...(request.mode === 'existing'
        ? { acceptedSubjectId: normalizeSubjectId(request.subjectId), acceptedInSubject: fact((await auth('getStatus', [request.subjectId, account])).accepted as boolean, scope.contract, account) } : {}) };
      received.add('account:' + account); return result;
    }));
    if (demand.tasks) {
      const encoded = (await call('taskManager', 'TaskManagerNew', 'getLensData', [STORAGE_KEYS.EXECUTOR, '0x']))[0];
      const executor = ethers.utils.defaultAbiCoder.decode(['address'], encoded)[0];
      data.taskManager = { address: scope.contracts.taskManager, executorAuthorized: fact(same(executor, scope.contracts.executor), scope.contracts.taskManager) }; received.add('tasks');
    }
    if (demand.binding) {
      const [executor, classes] = await Promise.all([call('hybridVoting', 'HybridVotingNew', 'executor'), call('hybridVoting', 'HybridVotingNew', 'getClasses')]);
      data.hybrid = { address: scope.contracts.hybridVoting, executorAuthorized: fact(same(executor[0], scope.contracts.executor), scope.contracts.hybridVoting),
        classes: classes[0].map((row: { strategy: number; slicePct: number; quadratic: boolean; minBalance: ethers.BigNumber; asset: string; hatIds: ethers.BigNumber[] }, classIndex: number) => ({ classIndex,
          strategy: Number(row.strategy), slicePct: Number(row.slicePct), quadratic: row.quadratic,
          minBalance: row.minBalance.toString(), asset: row.asset, hatIds: row.hatIds.map(id => id.toString()) })) }; received.add('binding');
    }
    if (demand.registry) {
      const admin = String((await call('registry', 'OrgRegistry', 'getOrgMetadataAdminHat', [scope.orgId]))[0]);
      let authorized = unknownFact<boolean>('REGISTRY_AUTHORIZATION_UNAVAILABLE', { ...source, contract: scope.contracts.registry });
      try { await call('registry', 'OrgRegistry', 'setOrgMetadataAdminHat', [scope.orgId, admin], scope.contracts.executor); authorized = fact(true, scope.contracts.registry); } catch (error) { active(input.signal); if ((error as Error)?.message === 'ROLE_RPC_BUDGET_EXHAUSTED') throw error; if (denied(error, 'OrgRegistry', 'NotOrgExecutor')) authorized = fact(false, scope.contracts.registry); }
      data.registry = { address: scope.contracts.registry, executorAuthorized: authorized, currentAdminSubject: fact(admin, scope.contracts.registry) }; received.add('registry');
    }
    if (demand.sponsorship) {
      let authorized = unknownFact<boolean>('SPONSORSHIP_AUTHORIZATION_UNAVAILABLE', { ...source, contract: scope.contracts.paymaster });
      try { await call('paymaster', 'PaymasterHub', 'setBudget', [scope.orgId, ethers.constants.HashZero, '1', 3600], scope.contracts.executor); authorized = fact(true, scope.contracts.paymaster); } catch (error) { active(input.signal); if ((error as Error)?.message === 'ROLE_RPC_BUDGET_EXHAUSTED') throw error; if (denied(error, 'PaymasterHub', 'NotOperator')) authorized = fact(false, scope.contracts.paymaster); }
      const budget = demand.email ? (await call('paymaster', 'PaymasterHub', 'getBudget', [scope.orgId, paymasterSubjectKey(SUBJECT_TYPE.CLAIM, scope.contracts.email)]))[0] : undefined;
      data.sponsorship = { address: scope.contracts.paymaster, operatorAuthorized: authorized,
        claimBudgetExists: demand.email ? fact(String(budget.epochLen ?? budget[2]) !== '0', scope.contracts.paymaster) : unknownFact('CLAIM_BUDGET_NOT_REQUESTED', source) }; received.add('sponsorship');
    }
    let activeAllowlist: RoleOperationEvidence['activeAllowlist'];
    if (demand.email) {
      const [executor, hats, minter, domain, specific, dkim, root, cid] = await Promise.all([
        call('email', 'ZkEmailInvites', 'executor'), call('executor', 'Executor', 'hats'), call('executor', 'Executor', 'isAuthorizedHatMinter', [scope.contracts.email]),
        call('email', 'ZkEmailInvites', 'domainVerifier'), call('email', 'ZkEmailInvites', 'emailVerifier'), call('email', 'ZkEmailInvites', 'dkimRegistry'),
        call('email', 'ZkEmailInvites', 'merkleRoot'), call('email', 'ZkEmailInvites', 'allowlistCid')]);
      const bound = same(executor[0], scope.contracts.executor) && same(hats[0], scope.contract), domainEnabled = bound && nonzero(dkim[0]) && nonzero(domain[0]), emailEnabled = bound && nonzero(dkim[0]) && nonzero(specific[0]);
      data.email = { address: scope.contracts.email, enabled: fact(domainEnabled || emailEnabled, scope.contracts.email), authorityMatches: fact(bound, scope.contracts.email),
        minterAuthorized: fact(minter[0] as boolean, scope.contracts.executor), domainEnabled: fact(domainEnabled, scope.contracts.email), emailEnabled: fact(emailEnabled, scope.contracts.email),
        currentRoot: fact(root[0] as string, scope.contracts.email), executorAddress: scope.contracts.executor };
      activeAllowlist = { source: { ...source, contract: scope.contracts.email }, data: { root: data.email.currentRoot, cid: fact(cid[0] as string, scope.contracts.email) },
        coverage: { status: 'complete', expectedKeys: ['root', 'cid'], receivedKeys: ['root', 'cid'], missingIds: [], failedIds: [], issues: [] } };
      for (const hash of operation ? [...new Set((r.emailAdditions ?? []).filter(row => row.type === 'email').map(row => emailHash(row.identifier)))] : []) {
        const key = 'email-registration:' + hash; expected.push(key);
        if ((await call('email', 'ZkEmailInvites', 'isEmailRegistered', [hash]))[0] !== false) throw new Error('ROLE_EMAIL_ALREADY_REGISTERED'); received.add(key);
      }
      received.add('email');
    }
    let allocations: RoleOperationEvidence['allocations'], proposals: RoleOperationEvidence['proposals'];
    if (operation && request.mode === 'compound') {
      allocations = { ...authority, data: authority.data.subjects.map(row => ({ subjectId: row.subjectId })), source: { ...authority.source, ...scope, block } }; observations.allocations = allocations;
      const historyScope = { ...scope, contract: scope.contracts.hybridVoting };
      const historySource: SourceRef = { ...base.indexed, ...historyScope, method: 'role-operation-history' };
      const rawHistory = await readProposalArchive({ source: historySource, query: io.protocol, lane: 'hybrid', pageSize: finite(bounds?.proposalPageSize, 100, 1000), maxPages: finite(bounds?.proposalMaxPages, 100) });
      const history = { ...rawHistory, data: rawHistory.data.map(row => ({ ...row, id: String(row.id) })) } as SourceSnapshot<readonly SubjectCreationProposal[]>;
      observations.proposals = history;
      requireCompleteSnapshot(history, { indexed: true, snapshot: 'pinned', block });
      const candidates = rawHistory.data.filter(row => row.wasExecuted !== true && row.status !== 'Executed');
      if (candidates.length > finite(bounds?.maxProvenanceCandidates, 10000)) throw new Error('ROLE_PROVENANCE_CANDIDATE_LIMIT_EXCEEDED');
      const proofs: VerifiedSubjectCreation[] = [];
      for (let offset = 0; offset < candidates.length; offset += 3) {
        active(input.signal); blockFresh(block, sources, start);
        const results = await Promise.all(candidates.slice(offset, offset + 3).map(row => readSubjectCreationProvenance({ scope: historyScope, source: historySource,
          rpcSource: { ...source, ...historyScope, method: 'role-operation-provenance' }, provider: io.provider, query: io.protocol,
          proposalId: String(row.proposalId), freshness: { now: clock(sources), maxAgeSeconds: 30 } })));
        active(input.signal);
        for (const result of results) if (result.status === 'ready') proofs.push(result.data);
      }
      proposals = recoverSubjectCreationHistory(history, proofs); observations.proposals = proposals; received.add('compound:history');
    }
    if (operation && request.mode === 'existing' && request.continuation) {
      const { readRoleContinuation } = await import('./role-continuation');
      const c = request.continuation;
      const proof = await readRoleContinuation({ scope, source: base.indexed, rpcSource: source, query: io.protocol, provider: io.provider,
        creationTransactionHash: c.transactionHash, proposalId: c.proposalId, creationCall: c.call, creationOperation: c.operation, executionOperation: c.executionOperation,
        subjects: { ...authority, source: { ...authority.source, block }, data: authority.data.subjects }, freshness: { now: clock(sources), maxAgeSeconds: 30 } });
      observations.creation = knownFact(proof, base.indexed);
      if (proof.state !== 'created' || normalizeSubjectId(proof.subjectId) !== normalizeSubjectId(request.subjectId)) throw new Error('ROLE_CONTINUATION_NOT_CREATED');
    }
    await finishObservation(base, input, io); received.add('canonical:after'); context.coverage = coverage();
    const evidence: RoleOperationEvidence = { purpose, scope, mode: request.mode, ...(operation && request.mode === 'existing' ? { subjectId: normalizeSubjectId(request.subjectId) } : {}),
      freshness: { now: clock(sources), maxAgeSeconds: 30, block }, context, authoritySnapshot: authority,
      ...(allocations ? { allocations } : {}), ...(proposals ? { proposals } : {}), ...(activeAllowlist ? { activeAllowlist } : {}) };
    return evidence;
  } finally { context.coverage = coverage(); }
}
