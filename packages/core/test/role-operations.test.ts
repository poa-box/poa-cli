import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import ts from 'typescript';
import { resolve } from 'path';
import { getAbi } from '../src/contracts';
import { composeSubjectId } from '../src/authority/ids';
import { bytes32ToCidV0 } from '../src/encoding/cid';
import { mergeVerifiedAllowlist } from '../src/email/allowlist';
import { emailHash } from '../src/zkemail';
import { paymasterSubjectKey, SUBJECT_TYPE } from '../src/sponsorship/codec';
import { AUTHORITY_KEYS as PERM_KEYS, permissionKey } from '../src/tx/authority';
import { readRoleOperationEvidence, reviewRoleOperation, prepareRoleOperation, revalidatePreparedRoleOperation, readRoleOperationStatus } from '../src/governance/role-operations';
import { planRoleConfiguration } from '../src/governance/role-planning';
import type { RoleOperationRequest, RoleOperationSources, RoleOperationScope, RoleOperationResult, RoleOperationReview } from '../src/governance/role-operations';

beforeEach(() => { vi.stubGlobal('fetch', () => { throw new Error('OFFLINE_NETWORK_BLOCKED'); }); });
afterEach(() => vi.unstubAllGlobals());
const addr = (x: string) => '0x' + x.repeat(40), hash = (x: string) => '0x' + x.repeat(64);
const AUTH = addr('1'), HV = addr('2'), EXEC = addr('3'), ACCOUNT = addr('4'), ORG = hash('5');
const META = hash('b'), CID = bytes32ToCidV0(hash('c')), EMAIL_CID = bytes32ToCidV0(hash('d'));
const a = new ethers.utils.Interface(getAbi('MembershipAuthority')), h = new ethers.utils.Interface(getAbi('HybridVotingNew')), e = new ethers.utils.Interface(getAbi('Executor'));
function ready<T>(result: RoleOperationResult<T>): T { expect(result.status, JSON.stringify(result.status !== 'ready' && result.codes)).toBe('ready'); if (result.status !== 'ready') throw new Error(result.codes.join(',')); return result.data; }
function fixture(mode: RoleOperationRequest['mode'] = 'create') {
  const id = composeSubjectId(AUTH, 15);
  const scope: RoleOperationScope = { chainId: 100, orgId: ORG, contract: AUTH, account: ACCOUNT, contracts: { membershipAuthority: AUTH, hybridVoting: HV, executor: EXEC } };
  const request: RoleOperationRequest = mode === 'existing' ? { mode, subjectId: id, role: { kind: 'Role', name: 'Builders' } } : { mode, role: { kind: 'Role', name: 'Builders' } };
  const f = { scope, request, now: 1000, timestamp: 1000, height: 100, blockHash: hash('8'), root: ethers.constants.HashZero, rootCid: ethers.constants.HashZero,
    executor: EXEC, currentMeta: META, image: 'existing-image', accepted: false, memberCount: '0', cap: '2', minter: false, registered: false, epochLen: 0,
    classConfig: { strategy: 0, slicePct: 100, quadratic: false, minBalance: '0', asset: ethers.constants.AddressZero, hatIds: [] as string[] },
    subjects: [{ id, subjectId: id, kind: 'Role', name: 'Builders', defaultAllow: false, maxMembers: '2', memberCount: '0', activeMemberCount: '0', createdAt: '1', vouchConfig: null, managerConfig: null }],
    groupEdges: [] as any[], archive: [] as any[], exactRows: new Map<string, any>(), txs: new Map<string, any>(), receipts: new Map<string, any>(), docs: new Map<string, unknown>(),
    fail: '', modify: (_source: any, _document: string, _variables: any, _result: any) => {} };
  const abiNames: Record<string, string> = { membershipAuthority: 'MembershipAuthority', hybridVoting: 'HybridVotingNew', executor: 'Executor', taskManager: 'TaskManagerNew', registry: 'OrgRegistry', paymaster: 'PaymasterHub', email: 'ZkEmailInvites' };
  const interfaces = Object.fromEntries(Object.entries(abiNames).map(([key, name]) => [key, new ethers.utils.Interface(getAbi(name))]));
  const provider: any = {
    getNetwork: vi.fn(async () => ({ chainId: 100 })),
    getBlock: vi.fn(async (tag: string | number) => {
      for (const tx of f.txs.values()) if (tag === tx.blockHash || typeof tag === 'string' && tag.startsWith('0x') && BigInt(tag) === BigInt(tx.blockNumber)) return { number: tx.blockNumber, hash: tx.blockHash, timestamp: 900 };
      return { number: f.height, hash: f.blockHash, timestamp: f.timestamp };
    }),
    getTransaction: vi.fn(async (tx: string) => f.txs.get(tx)), getTransactionReceipt: vi.fn(async (tx: string) => f.receipts.get(tx)),
    call: vi.fn(async (tx: any, block: number) => {
      expect(block).toBe(f.height);
      const key = Object.keys(interfaces).find(key => f.scope.contracts[key] === tx.to)!;
      const iface = interfaces[key]; if (!iface) throw new Error('Unexpected target');
      const parsed = iface.parseTransaction(tx), method = parsed.name;
      if (f.fail === method) throw new Error('network unavailable');
      let values: any[];
      if (key === 'membershipAuthority') {
        if (method === 'executor') values = [f.executor];
        else if (method === 'orgId') values = [ORG];
        else if (method === 'subjectCount') values = [f.subjects.length];
        else if (method === 'getSubject') { const row = f.subjects.find(row => row.subjectId === String(parsed.args[0])); if (!row) throw new Error('Subject missing'); values = [[row.kind === 'Group' ? 1 : 0, row.name, f.currentMeta, f.image, f.cap, true]]; }
        else if (method === 'groupMemberRoles') values = [f.groupEdges.filter(row => row.groupSubjectId === String(parsed.args[0]) && row.isActive).map(row => row.roleSubjectId)];
        else if (method === 'userSubjects') values = [f.accepted ? [id] : []];
        else if (method === 'getStatus') values = [f.accepted, false, '0', 0];
        else if (method === 'memberCount') values = [f.memberCount];
        else throw new Error('Unexpected authority read: ' + method);
      } else if (key === 'taskManager') values = [ethers.utils.defaultAbiCoder.encode(['address'], [f.executor])];
      else if (key === 'hybridVoting') values = method === 'executor' ? [f.executor] : [[f.classConfig]];
      else if (key === 'registry') values = method === 'getOrgMetadataAdminHat' ? [id] : [];
      else if (key === 'paymaster') values = method === 'getBudget' ? [[0, 0, f.epochLen, 0]] : [];
      else if (key === 'executor') values = method === 'hats' ? [AUTH] : [f.minter];
      else if (key === 'email') values = method === 'executor' ? [EXEC] : method === 'merkleRoot' ? [f.root] : method === 'allowlistCid' ? [f.rootCid]
        : method === 'isEmailRegistered' ? [f.registered] : [addr('a')];
      else throw new Error('Unexpected module');
      return iface.encodeFunctionResult(method, values);
    }),
  };
  const query = vi.fn(async (source: any, document: string, variables: any) => {
    const meta = { number: f.height, hash: f.blockHash, ...(document.includes('number hash timestamp') ? { timestamp: f.timestamp } : {}) };
    const org: any = { id: ORG, membershipAuthority: { id: AUTH, isRouterBound: true, cutoverAt: '1', paused: false,
      subjectCount: String(f.subjects.length), roleSubjectCount: String(f.subjects.filter(row => row.kind === 'Role').length), groupSubjectCount: String(f.subjects.filter(row => row.kind === 'Group').length), acceptedMembershipCount: '0' }, hybridVoting: { id: HV }, executorContract: { id: EXEC } };
    const fields: any = { taskManager: 'taskManager', email: 'zkEmailInvites', participationToken: 'participationToken', paymentManager: 'paymentManager' };
    for (const [key, field] of Object.entries(fields)) if (f.scope.contracts[key]) org[field as string] = { id: f.scope.contracts[key] };
    const data: any = { _meta: { block: meta }, organization: org };
    if (document.includes('RolePlanningModuleBindings')) data.poaManagerContracts = [{ orgRegistryProxy: f.scope.contracts.registry, paymasterHubProxy: f.scope.contracts.paymaster }];
    else if (document.includes('RecoverSubjectCreation') || document.includes('RoleContinuation')) data.proposals = f.exactRows.has(variables.id) ? [f.exactRows.get(variables.id)] : [];
    else if (document.includes('HybridProposalsPage')) data.proposals = f.archive.filter(row => row.id > variables.cursor).slice(0, variables.first);
    else {
      const field = ['subjects', 'subjectMemberships', 'groupCompositions', 'permRows', 'accessRules', 'subjectVouchRecords', 'pendingActions'].find(field => document.includes(field + '('));
      if (field) data[field] = (field === 'subjects' ? f.subjects : field === 'groupCompositions' ? f.groupEdges : []).filter(row => row.id > variables.lastId).slice(0, variables.first);
    }
    const result = { source: { ...source }, data, issues: [] }; f.modify(source, document, variables, result); return result;
  });
  const sources: RoleOperationSources = { indexed: { endpoint: 'mock://index', query: query as any }, rpc: { endpoint: 'mock://rpc', provider }, now: () => f.now };
  const fetchDocument = vi.fn(async (cid: string) => f.docs.get(cid) ?? null);
  const publishDocument = vi.fn(async (doc: any) => ({ cid: doc.key === 'email-allowlist' ? EMAIL_CID : CID }));
  return Object.assign(f, { sources, provider, query, fetchDocument, publishDocument, id, input: () => ({ scope, request: f.request, sources }),
    prepare: (review: RoleOperationReview) => ({ scope, sources, review, currentRequest: f.request, fetchDocument, publishDocument }) });
}
function optional(f: ReturnType<typeof fixture>) { Object.assign(f.scope.contracts, { taskManager: addr('6'), registry: addr('7'), paymaster: addr('8'), email: addr('9') }); }
function proposal(f: ReturnType<typeof fixture>, n: number, batch: any[], executed = false) {
  const txHash = '0x' + (10000 + n).toString(16).padStart(64, '0'), blockHash = hash('e'), title = ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Proposal ' + n));
  const tx = { hash: txHash, to: HV, from: ACCOUNT, chainId: 100, blockNumber: 50, blockHash, value: ethers.constants.Zero,
    data: h.encodeFunctionData('createProposal', [title, META, 10, 2, [batch.map(c => [c.target, c.value, c.calldata]), []], []]) };
  f.txs.set(txHash, tx);
  const log = (iface: ethers.utils.Interface, emitter: string, name: string, args: any[], transaction = tx) => ({ ...iface.encodeEventLog(iface.getEvent(name), args), address: emitter,
    transactionHash: transaction.hash, blockNumber: transaction.blockNumber, blockHash: transaction.blockHash, removed: false });
  f.receipts.set(txHash, { status: 1, transactionHash: txHash, blockNumber: 50, blockHash, logs: [log(h, HV, 'NewProposal', [n, title, META, 2, 1600, 900])] });
  const row: any = { id: HV + '-' + n, proposalId: String(n), transactionHash: txHash, title: 'Proposal ' + n, numOptions: 2, descriptionHash: META, createdAtBlock: '50',
    wasExecuted: executed, executionFailed: false, isValid: executed ? true : null, winningOption: executed ? '0' : null, status: executed ? 'Executed' : 'Active', hybridVoting: { id: HV, organization: { id: ORG } }, batchExecutions: [] };
  f.exactRows.set(row.id, row); f.archive.push(row);
  return { transactionHash: txHash, row, log, tx };
}
function created(f: ReturnType<typeof fixture>, n = 7, kind: 'Role' | 'Group' = 'Role') {
  const call = { target: AUTH, value: '0', calldata: kind === 'Role' ? a.encodeFunctionData('createRole', ['Builders', META, 'image', 2])
    : a.encodeFunctionData('createGroup', ['Builders', META, 'image', []]) };
  const p = proposal(f, n, [call], true), execHash = '0x' + (20000 + n).toString(16).padStart(64, '0');
  const tx = { ...p.tx, hash: execHash, blockNumber: 90, blockHash: hash('f'), data: h.encodeFunctionData('announceWinner', [n]) }; f.txs.set(execHash, tx);
  f.receipts.set(execHash, { status: 1, transactionHash: execHash, blockNumber: 90, blockHash: hash('f'), logs: [
    p.log(a, AUTH, 'SubjectCreated', [f.id, kind === 'Role' ? 0 : 1, 'Builders', META, kind === 'Role' ? 2 : 0], tx), p.log(e, EXEC, 'CallExecuted', [n, 0, AUTH, 0], tx),
    p.log(e, EXEC, 'BatchExecuted', [n, 1], tx), p.log(h, HV, 'ProposalExecuted', [n, 0, 1], tx),
  ] });
  p.row.batchExecutions = [{ proposalId: String(n), callCount: '1', transactionHash: execHash, executedAtBlock: '90', executor: { id: EXEC } }];
  return { transactionHash: p.transactionHash, proposalId: String(n), call };
}
function executedConfiguration(f: ReturnType<typeof fixture>, batch: readonly any[], n = 8) {
  const p = proposal(f, n, [...batch], true);
  const tx = { ...p.tx, hash: hash('a'), blockNumber: 91, blockHash: hash('d'), data: h.encodeFunctionData('announceWinner', [n]) }; f.txs.set(tx.hash, tx);
  f.receipts.set(tx.hash, { status: 1, transactionHash: tx.hash, blockNumber: 91, blockHash: tx.blockHash, logs: [
    ...batch.map((call, index) => p.log(e, EXEC, 'CallExecuted', [n, index, call.target, call.value], tx)),
    p.log(e, EXEC, 'BatchExecuted', [n, batch.length], tx), p.log(h, HV, 'ProposalExecuted', [n, 0, batch.length], tx),
  ] });
  p.row.batchExecutions = [{ proposalId: String(n), callCount: String(batch.length), transactionHash: tx.hash, executedAtBlock: '91', executor: { id: EXEC } }];
  return { transactionHash: p.transactionHash, proposalId: String(n), batch };
}

describe('read-only role capabilities and strict operation boundary', () => {
  it.each([0, 1])('retains actual voting strategy %s for host display without changing class identity', async strategy => {
    const f = fixture(); f.classConfig.strategy = strategy;
    const evidence = ready(await readRoleOperationEvidence({ ...f.input(), purpose: 'capabilities' }));
    expect(evidence.context.data.hybrid?.classes).toEqual([{ classIndex: 0, ...f.classConfig }]);
    expect(evidence.context.source.indexed).toBe(false);
    expect(evidence.context.source.block?.hash).toBe(f.blockHash);
  });
  it.each(['strategy', 'slicePct', 'quadratic', 'minBalance', 'asset', 'hatIds'])('requires new review when actual class %s changes even with the same call/index', async field => {
    const f = fixture('existing'); f.request.role.bindingClassIndex = 0;
    const review = ready(await reviewRoleOperation(f.input()));
    const changed = { strategy: 1, slicePct: 75, quadratic: true, minBalance: '123456789012345678901', asset: addr('a'), hatIds: [f.id] };
    Object.assign(f.classConfig, { [field]: changed[field as keyof typeof changed] });
    f.height++; f.blockHash = hash('9'); f.timestamp++; f.now++;
    const prepared = await prepareRoleOperation(f.prepare(review));
    expect(prepared.status).toBe('blocked');
    if (prepared.status !== 'ready') expect(prepared.codes).toContain('STALE_ROLE_OPERATION_REVIEW');
    expect(prepared).not.toHaveProperty('data'); expect(f.publishDocument).not.toHaveBeenCalled();
  });
  it.each(['absent', 'all', 'paymaster only', 'email only'])('observes a blank staged form across %s optional modules without history, prediction or holder work', async modules => {
    const f = fixture();
    if (modules === 'all') optional(f);
    if (modules === 'paymaster only') f.scope.contracts.paymaster = addr('8');
    if (modules === 'email only') f.scope.contracts.email = addr('9');
    f.request.role = { kind: 'Role', name: '', holders: [{ account: ACCOUNT, sticky: true }],
      emailAdditions: [{ type: 'email', identifier: 'private@example.org' }], sponsorship: { capRaw: '1', epochSeconds: '3600', supportPasskeys: true } };
    f.registered = true;
    const evidence = ready(await readRoleOperationEvidence({ ...f.input(), purpose: 'capabilities' })), data = evidence.context.data;
    expect(evidence.purpose).toBe('capabilities'); expect(evidence.mode).toBe('create');
    expect(evidence).not.toHaveProperty('subjectId'); expect(evidence).not.toHaveProperty('predictedSubjectId');
    expect(evidence.allocations).toBeUndefined(); expect(evidence.proposals).toBeUndefined(); expect(data.accounts).toEqual([]);
    expect(data.hybrid?.executorAuthorized).toMatchObject({ state: 'known', value: true }); expect(data.hybrid?.classes).toEqual([{ classIndex: 0, ...f.classConfig }]);
    expect(!!data.taskManager).toBe(modules === 'all'); expect(!!data.registry).toBe(modules === 'all');
    expect(!!data.sponsorship).toBe(modules === 'all' || modules === 'paymaster only');
    expect(!!data.email).toBe(modules === 'all' || modules === 'email only');
    if (modules === 'all') expect(data.sponsorship?.claimBudgetExists).toMatchObject({ state: 'known', value: false });
    if (modules === 'paymaster only') expect(data.sponsorship?.claimBudgetExists).toMatchObject({ state: 'unknown', code: 'CLAIM_BUDGET_NOT_REQUESTED' });
    if (data.email) expect(data.email).toMatchObject({ enabled: { state: 'known', value: true }, minterAuthorized: { state: 'known', value: false } });
    expect(evidence.context.coverage.status).toBe('complete');
    expect([...evidence.context.coverage.expectedKeys!].sort()).toEqual([...evidence.context.coverage.receivedKeys].sort());
    expect(JSON.stringify(evidence)).not.toContain('private@example.org');
    const prohibited = ['subjectCount', 'getSubject', 'memberCount', 'userSubjects', 'getStatus', 'isEmailRegistered'];
    expect(f.provider.call.mock.calls.some(([tx]: any) => prohibited.some(method => {
      try { return a.parseTransaction(tx).name === method; } catch { return false; }
    }))).toBe(false);
    expect(f.provider.call.mock.calls.some(([tx]: any) => tx.data.startsWith(new ethers.utils.Interface(getAbi('ZkEmailInvites')).getSighash('isEmailRegistered')))).toBe(false);
    expect(f.query.mock.calls.some(([, doc]) => /ProposalsPage|RecoverSubjectCreation|RoleContinuation/.test(doc))).toBe(false);
    expect(f.provider.getTransaction).not.toHaveBeenCalled(); expect(f.provider.getTransactionReceipt).not.toHaveBeenCalled();
    expect(f.fetchDocument).not.toHaveBeenCalled(); expect(f.publishDocument).not.toHaveBeenCalled();
  });
  it.each(['existing', 'compound'] as const)('never interprets %s capabilities as subject or history evidence', async mode => {
    const f = fixture(mode); optional(f); f.request.role.name = '';
    if (f.request.mode === 'existing') f.request.subjectId = 'not-an-id';
    const evidence = ready(await readRoleOperationEvidence({ ...f.input(), purpose: 'capabilities', bounds: { maxCompoundSubjects: 1, maxAccounts: 1 } }));
    expect(evidence.purpose).toBe('capabilities'); expect(evidence.subjectId).toBeUndefined(); expect(evidence.proposals).toBeUndefined(); expect(evidence.allocations).toBeUndefined();
    for (const key of ['existing:subject', 'existing:capacity', 'compound:history', 'compound:subjects', 'compound:edges']) expect(evidence.context.coverage.expectedKeys).not.toContain(key);
    expect(f.provider.call.mock.calls.some(([tx]: any) => tx.data.startsWith(a.getSighash('getSubject')) || tx.data.startsWith(a.getSighash('subjectCount')))).toBe(false);
    expect(f.provider.getTransaction).not.toHaveBeenCalled();
  });
  it.each([0, 3600])('uses the real ABI epochLen %s with a zero-cap claim budget in both purposes', async epochLen => {
    const f = fixture('existing'); optional(f); f.epochLen = epochLen;
    f.request.role.sponsorship = { capRaw: '1', epochSeconds: '3600', supportPasskeys: true, includeConfiguredEmailRules: true };
    const paymaster = new ethers.utils.Interface(getAbi('PaymasterHub'));
    for (const purpose of ['operation', 'capabilities'] as const) {
      const evidence = ready(await readRoleOperationEvidence({ ...f.input(), purpose }));
      expect(evidence.context.data.sponsorship?.claimBudgetExists).toMatchObject({ state: 'known', value: epochLen !== 0 });
    }
    const call = f.provider.call.mock.calls.find(([tx]: any) => tx.to === f.scope.contracts.paymaster && tx.data.startsWith(paymaster.getSighash('getBudget')))![0];
    expect(paymaster.decodeFunctionData('getBudget', call.data).map(String)).toEqual([ORG, paymasterSubjectKey(SUBJECT_TYPE.CLAIM, f.scope.contracts.email)]);
  });
  it.each(['known denial', 'network failure', 'unregistered org'])('preserves %s sponsorship facts without turning unavailable proof into denial', async kind => {
    const f = fixture('existing'); optional(f); f.request.role.sponsorship = { capRaw: '1', epochSeconds: '3600' };
    const paymaster = new ethers.utils.Interface(getAbi('PaymasterHub')), original = f.provider.call.getMockImplementation()!;
    f.provider.call.mockImplementation(async (tx: any, block: number) => {
      if (tx.to === f.scope.contracts.paymaster && tx.data.startsWith(paymaster.getSighash('setBudget'))) {
        if (kind === 'network failure') throw new Error('network unavailable');
        throw { data: paymaster.encodeErrorResult(kind === 'known denial' ? 'NotOperator' : 'OrgNotRegistered', []) };
      }
      return original(tx, block);
    });
    const result = await readRoleOperationEvidence({ ...f.input(), purpose: 'capabilities' });
    if (kind === 'known denial') {
      expect(ready(result).context.data.sponsorship?.operatorAuthorized).toMatchObject({ state: 'known', value: false });
      expect((await reviewRoleOperation(f.input())).status).toBe('blocked');
    } else {
      expect(result.status).toBe('unknown'); expect(result).not.toHaveProperty('data');
      if (result.status !== 'ready') expect(result.observations?.planning?.data.sponsorship?.operatorAuthorized).toMatchObject({ state: 'unknown' });
      expect((await reviewRoleOperation(f.input())).status).toBe('unknown');
    }
  });
  it('retains known false capability authorization and disabled email configuration', async () => {
    const f = fixture(); optional(f); f.executor = addr('a');
    const email = new ethers.utils.Interface(getAbi('ZkEmailInvites')), original = f.provider.call.getMockImplementation()!;
    f.provider.call.mockImplementation(async (tx: any, block: number) => tx.to === f.scope.contracts.email && tx.data.startsWith(email.getSighash('domainVerifier'))
      ? email.encodeFunctionResult('domainVerifier', [ethers.constants.AddressZero]) : tx.to === f.scope.contracts.email && tx.data.startsWith(email.getSighash('emailVerifier'))
        ? email.encodeFunctionResult('emailVerifier', [ethers.constants.AddressZero]) : original(tx, block));
    const evidence = ready(await readRoleOperationEvidence({ ...f.input(), purpose: 'capabilities' }));
    expect(evidence.context.data.executorAuthorized).toMatchObject({ state: 'known', value: false });
    expect(evidence.context.data.taskManager?.executorAuthorized).toMatchObject({ state: 'known', value: false });
    expect(evidence.context.data.hybrid?.executorAuthorized).toMatchObject({ state: 'known', value: false });
    expect(evidence.context.data.email).toMatchObject({ enabled: { state: 'known', value: false }, domainEnabled: { state: 'known', value: false }, emailEnabled: { state: 'known', value: false } });
  });
  it.each(['registry', 'email', 'RPC chain', 'module binding', 'stale', 'budget'])('retains strict %s failures for capabilities', async kind => {
    const f = fixture(); optional(f);
    if (kind === 'registry') f.fail = 'setOrgMetadataAdminHat';
    if (kind === 'email') f.fail = 'merkleRoot';
    if (kind === 'RPC chain') f.provider.getNetwork.mockResolvedValue({ chainId: 1 });
    if (kind === 'module binding') f.modify = (_source, _doc, _vars, result) => { result.data.organization.zkEmailInvites.id = addr('a'); };
    if (kind === 'stale') f.now += 31;
    const result = await readRoleOperationEvidence({ ...f.input(), purpose: 'capabilities', ...(kind === 'budget' ? { bounds: { maxRpcCalls: 3 } } : {}) });
    expect(result.status).toBe('unknown'); expect(result).not.toHaveProperty('data'); expect(f.publishDocument).not.toHaveBeenCalled();
    if (kind === 'registry' && result.status !== 'ready') expect(result.observations?.planning?.data.registry?.executorAuthorized.state).toBe('unknown');
  });
  it('keeps omitted purpose identical to explicit operation with creation-only reads', async () => {
    const f = fixture(); optional(f); f.request.role.sponsorship = { capRaw: '1', epochSeconds: '3600' };
    const implicit = ready(await readRoleOperationEvidence(f.input())), calls = f.provider.call.mock.calls.map(([tx]: any) => tx.data); f.provider.call.mockClear();
    const explicit = ready(await readRoleOperationEvidence({ ...f.input(), purpose: 'operation' }));
    expect(explicit).toEqual(implicit); expect(explicit.purpose).toBe('operation');
    expect(f.provider.call.mock.calls.map(([tx]: any) => tx.data)).toEqual(calls); expect(calls).toEqual([a.encodeFunctionData('executor'), a.encodeFunctionData('orgId')]);
  });
  it.each(['options', null, false])('rejects an invalid observation purpose %s before transport', async purpose => {
    const f = fixture(); const result = await readRoleOperationEvidence({ ...f.input(), purpose } as any);
    expect(result).toMatchObject({ status: 'unknown', codes: ['INVALID_ROLE_OPERATION_PURPOSE'] });
    expect(f.query).not.toHaveBeenCalled(); expect(f.provider.call).not.toHaveBeenCalled();
  });
  it('prepares passkey sponsorship without requesting absent email rules or silently initializing a budget', async () => {
    const f = fixture('existing'); f.scope.contracts.paymaster = addr('8');
    f.request.role.sponsorship = { capRaw: '1', epochSeconds: '3600', supportPasskeys: true };
    const plan = ready(await prepareRoleOperation(f.prepare(ready(await reviewRoleOperation(f.input())))));
    const paymaster = new ethers.utils.Interface(getAbi('PaymasterHub'));
    const calls = plan.batch.filter(call => call.target === f.scope.contracts.paymaster).map(call => paymaster.parseTransaction({ data: call.calldata }));
    expect(calls.map(call => call.name)).toEqual(['setBudget', 'setRulesBatch']);
    expect(calls[1].args[1]).not.toContain(ethers.constants.AddressZero);
    expect(plan.evidence.context.data.email).toBeUndefined(); expect(plan.consequences.map(c => c.code)).not.toContain('INITIALIZE_EMAIL_CLAIM_BUDGET');
    expect(f.provider.call.mock.calls.some(([tx]: any) => tx.to === f.scope.contracts.paymaster && tx.data.startsWith(paymaster.getSighash('getBudget')))).toBe(false);
  });
  it('forces creation-only operation review despite an injected capabilities purpose', async () => {
    const f = fixture(); optional(f); f.fail = 'getBudget';
    f.request.role.sponsorship = { capRaw: '1', epochSeconds: '3600', supportPasskeys: true, includeConfiguredEmailRules: true };
    const review = ready(await reviewRoleOperation({ ...f.input(), purpose: 'capabilities' } as any));
    expect(review.evidence.purpose).toBe('operation'); expect(review.evidence.context.data.sponsorship).toBeUndefined();
    expect(review.predictedSubjectId).toBeUndefined(); expect(review.requiresConfiguration).toBe(true);
    expect(new Set(f.provider.call.mock.calls.map(([tx]: any) => a.parseTransaction(tx).name))).toEqual(new Set(['executor', 'orgId']));
  });
  it('cannot use capabilities readiness to skip holder checks, preparation or final revalidation', async () => {
    const f = fixture('existing'); f.request.role.holders = [{ account: ACCOUNT, sticky: false }];
    const capabilities = ready(await readRoleOperationEvidence({ ...f.input(), purpose: 'capabilities' }));
    const fake = await prepareRoleOperation({ ...f.prepare(capabilities as any), purpose: 'capabilities' } as any);
    expect(fake.status).toBe('blocked');
    f.fail = 'getStatus'; expect((await reviewRoleOperation({ ...f.input(), purpose: 'capabilities' } as any)).status).toBe('unknown');
    f.fail = ''; const review = ready(await reviewRoleOperation(f.input()));
    f.fail = 'getStatus'; expect((await prepareRoleOperation({ ...f.prepare(review), purpose: 'capabilities' } as any)).status).toBe('unknown');
    f.fail = ''; const prepared = ready(await prepareRoleOperation(f.prepare(review)));
    f.fail = 'getStatus'; expect((await revalidatePreparedRoleOperation({ ...f.prepare(review), prepared, purpose: 'capabilities' } as any)).status).toBe('unknown');
    expect(f.publishDocument).not.toHaveBeenCalled();
  });
  it('does not let an injected capability purpose weaken exact status proof', async () => {
    const f = fixture(), creation = created(f); creation.call.calldata += '00';
    const result = await readRoleOperationStatus({ scope: f.scope, sources: f.sources, creation, purpose: 'capabilities' } as any);
    expect(result.status).toBe('unknown'); expect(result).not.toHaveProperty('data');
  });
  it.each([
    ['classic', ts.ModuleKind.CommonJS, ts.ModuleResolutionKind.NodeJs],
    ['Node16', ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16],
    ['bundler', ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
  ] as const)('omits purpose from public review/prepare/status types under %s', (_name, module, moduleResolution) => {
    const file = resolve(__dirname, '__role_capabilities_type_regression__.ts');
    const consumer = `
      import { readRoleOperationEvidence, reviewRoleOperation, prepareRoleOperation, readRoleOperationStatus,
        type ReadRoleOperationEvidenceInput, type ReviewRoleOperationInput, type PrepareRoleOperationInput,
        type ReadRoleOperationStatusInput, type RoleOperationEvidence } from '@poa-box/core/governance/role-operations';
      declare const input: ReadRoleOperationEvidenceInput;
      readRoleOperationEvidence({ ...input, purpose: 'capabilities' });
      readRoleOperationEvidence({ ...input, purpose: 'operation' });
      reviewRoleOperation(input); // legacy structurally compatible callers still work
      declare const review: ReviewRoleOperationInput;
      // @ts-expect-error only the evidence reader accepts a purpose
      reviewRoleOperation({ ...review, purpose: 'capabilities' });
      // @ts-expect-error purpose is omitted, not an optional review field
      type ReviewPurpose = ReviewRoleOperationInput['purpose'];
      declare const prepare: PrepareRoleOperationInput;
      // @ts-expect-error capabilities cannot be selected for preparation
      prepareRoleOperation({ ...prepare, purpose: 'capabilities' });
      declare const status: ReadRoleOperationStatusInput;
      // @ts-expect-error exact status is independent of capability readiness
      readRoleOperationStatus({ ...status, purpose: 'capabilities' });
      declare const evidence: RoleOperationEvidence;
      const purpose: 'operation' | 'capabilities' = evidence.purpose;
    `;
    const options: ts.CompilerOptions = { strict: true, skipLibCheck: false, noEmit: true, esModuleInterop: true,
      target: ts.ScriptTarget.ES2022, module, moduleResolution, types: ['node'] };
    const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
    host.getSourceFile = (path, version, onError, fresh) => path === file ? ts.createSourceFile(path, consumer, version, true) : original(path, version, onError, fresh);
    const program = ts.createProgram([file], options, host);
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  });
});

describe('shared staged role observation/review/preparation', () => {
  it('creates only the role while retaining full deferred intent; no optional reads/history/publication', async () => {
    const f = fixture(); optional(f);
    f.request.role = { ...f.request.role, maxMembers: '5', defaultAllow: true, permissions: [{ key: PERM_KEYS.HV_CREATE, value: '1' }], holders: [{ account: ACCOUNT, sticky: false }],
      taskGrants: { creator: true, organizer: true }, editOrgDetails: true, emailAdditions: [{ type: 'email', identifier: 'private@example.org' }], sponsorship: { capRaw: '1000000000000000', epochSeconds: '3600' } };
    const review = ready(await reviewRoleOperation(f.input()));
    expect(review).toMatchObject({ mode: 'create', requiresConfiguration: true, preview: { callCount: 1, createsSubject: true }, documents: [] });
    expect(review).not.toHaveProperty('subjectId'); expect(review).not.toHaveProperty('predictedSubjectId'); expect(review).not.toHaveProperty('batch');
    expect(review.deferredEffects.map(row => row.field)).toContain('emailAdditions');
    const plan = ready(await prepareRoleOperation(f.prepare(review)));
    expect(plan.batch).toHaveLength(1); expect(a.parseTransaction({ data: plan.batch[0].calldata }).name).toBe('createRole');
    expect(a.decodeFunctionData('createRole', plan.batch[0].calldata)[3]).toEqual(ethers.BigNumber.from(5).toNumber());
    expect(f.publishDocument).not.toHaveBeenCalled(); expect(f.provider.getTransaction).not.toHaveBeenCalled();
    const methods = f.provider.call.mock.calls.map(([tx]: any) => a.parseTransaction(tx).name);
    expect(new Set(methods)).toEqual(new Set(['executor', 'orgId']));
    expect(f.query.mock.calls.some(([, doc]) => doc.includes('ProposalsPage'))).toBe(false);
  });
  it('includes selected role IDs in the creation-only Group call', async () => {
    const f = fixture(); f.request.role = { kind: 'Group', name: 'Team', memberRoleIds: [f.id], permissions: [{ key: PERM_KEYS.HV_CREATE, value: '1' }] };
    const review = ready(await reviewRoleOperation(f.input())), plan = ready(await prepareRoleOperation(f.prepare(review)));
    expect(review.requiresConfiguration).toBe(true);
    expect(a.decodeFunctionData('createGroup', plan.batch[0].calldata)[3].map(String)).toEqual([f.id]);
  });
  it('reads selected capabilities for incomplete form text', async () => {
    const f = fixture('existing'); optional(f); f.request.role = { ...f.request.role, name: '', editOrgDetails: true };
    expect(ready(await readRoleOperationEvidence(f.input())).context.data.registry?.executorAuthorized).toMatchObject({ state: 'known', value: true });
    expect((await reviewRoleOperation(f.input())).status).toBe('blocked');
  });
  it('configures the explicit actual ID, preserves omitted metadata/image and retains indexed provenance', async () => {
    const f = fixture('existing'); f.accepted = true; f.memberCount = '2'; f.request.role.holders = [{ account: ACCOUNT, sticky: false }];
    const review = ready(await reviewRoleOperation(f.input())), plan = ready(await prepareRoleOperation(f.prepare(review)));
    const call = a.decodeFunctionData('renameSubject', plan.batch[0].calldata);
    expect(String(call[0])).toBe(f.id); expect(call[2]).toBe(META); expect(call[3]).toBe('existing-image');
    expect(review.evidence.authoritySnapshot.source.indexed).toBe(true); expect(review.evidence.context.source.indexed).toBe(false);
    expect(review.evidence.context.data.indexedAuthoritySource?.endpoint).toBe('mock://index');
    expect(plan.batch[1].calldata).toBe(a.encodeFunctionData('grant', [f.id, ACCOUNT, true]));
    expect(f.provider.call.mock.calls.filter(([tx]: any) => tx.data.startsWith(a.getSighash('getSubject')))).toHaveLength(3);
  });
  it('distinguishes explicit cleared metadata and image from omission', async () => {
    const f = fixture('existing'); f.request.metadata = { name: 'Builders', description: '' }; f.request.role.imageURI = '';
    const plan = ready(await prepareRoleOperation(f.prepare(ready(await reviewRoleOperation(f.input())))));
    const call = a.decodeFunctionData('renameSubject', plan.batch[0].calldata); expect(call[2]).toBe(ethers.constants.HashZero); expect(call[3]).toBe(''); expect(f.publishDocument).not.toHaveBeenCalled();
  });
  it('publishes only immutable exact named reviewed UTF-8 bytes, using the adapter CID in the rebuilt final batch', async () => {
    const f = fixture(); f.request.metadata = { name: 'Builders', description: 'Useful work 🌱' };
    const review = ready(await reviewRoleOperation(f.input())); expect(f.publishDocument).not.toHaveBeenCalled();
    const plan = ready(await prepareRoleOperation(f.prepare(review)));
    const doc = f.publishDocument.mock.calls[0][0]; expect(doc).toEqual({ key: 'role-metadata', json: '{"name":"Builders","description":"Useful work 🌱"}', digest: ethers.utils.id(doc.json) });
    expect(Object.isFrozen(doc)).toBe(true); expect(f.publishDocument).toHaveBeenCalledOnce();
    expect(a.decodeFunctionData('createRole', plan.batch[0].calldata)[1]).toBe(hash('c'));
    expect(JSON.stringify(review)).not.toContain('01010101010101010101');
  });
  it.each(['copy', 'edited request', 'scope', 'clock rewind', 'stale head', 'changed fact'])('rejects %s before publication', async kind => {
    const f = fixture(); f.request.metadata = { name: 'Builders', description: 'Details' }; const review = ready(await reviewRoleOperation(f.input())); const input = f.prepare(review);
    if (kind === 'copy') input.review = JSON.parse(JSON.stringify(review));
    if (kind === 'edited request') f.request.role.maxMembers = '5';
    if (kind === 'scope') input.scope = { ...f.scope, account: addr('a') };
    if (kind === 'clock rewind') f.now = 999;
    if (kind === 'stale head') f.now = 1061;
    if (kind === 'changed fact') f.subjects[0].maxMembers = '3';
    const result = await prepareRoleOperation(input); expect(result.status).not.toBe('ready'); expect(result).not.toHaveProperty('data'); expect(f.publishDocument).not.toHaveBeenCalled();
  });
  it('accepts advancing valid block/time attribution with unchanged reviewed protocol values', async () => {
    const f = fixture(); const review = ready(await reviewRoleOperation(f.input())); f.now++; f.timestamp++; f.height++; f.blockHash = hash('9');
    expect(ready(await prepareRoleOperation(f.prepare(review))).fingerprint).toBe(review.fingerprint);
  });
  it.each(['elapsed', 'root', 'registration', 'canonical block', 'publisher failure', 'invalid CID'])('retains successful receipts and returns no executable batch after %s', async kind => {
    const f = fixture('existing'); optional(f); f.request.metadata = { name: 'Builders', description: 'Details' }; f.request.role.emailAdditions = [{ type: 'email', identifier: 'private@example.org' }];
    const review = ready(await reviewRoleOperation(f.input()));
    f.publishDocument.mockImplementation(async (doc: any) => {
      if (kind === 'publisher failure' && doc.key === 'email-allowlist') throw new Error('upload unavailable');
      if (kind === 'invalid CID' && doc.key === 'email-allowlist') return { cid: 'not-a-cid' };
      if (doc.key === 'email-allowlist') {
        if (kind === 'elapsed') f.now += 61;
        if (kind === 'root') f.root = hash('a');
        if (kind === 'registration') f.registered = true;
        if (kind === 'canonical block') f.provider.getBlock.mockImplementation(async () => ({ number: f.height, hash: hash('a'), timestamp: f.timestamp }));
      }
      return { cid: doc.key === 'email-allowlist' ? EMAIL_CID : CID };
    });
    const result = await prepareRoleOperation(f.prepare(review)); expect(result.status).not.toBe('ready'); expect(result).not.toHaveProperty('data');
    if (result.status !== 'ready') expect(result.publishedDocuments?.[0]).toMatchObject({ key: 'role-metadata', cid: CID });
    expect(f.publishDocument).toHaveBeenCalledTimes(2);
  });
  it('retains a first upload receipt on abort and never starts the second publication', async () => {
    const f = fixture('existing'); optional(f); f.request.metadata = { name: 'Builders', description: 'Details' }; f.request.role.emailAdditions = [{ type: 'domain', identifier: 'example.org' }];
    const review = ready(await reviewRoleOperation(f.input())), controller = new AbortController(); f.publishDocument.mockImplementation(async () => { controller.abort(); return { cid: CID }; });
    await expect(prepareRoleOperation({ ...f.prepare(review), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError', publishedDocuments: [{ key: 'role-metadata', cid: CID }] });
    expect(f.publishDocument).toHaveBeenCalledOnce();
  });
  it('preserves root-verified old email commitments and excludes plaintext from the publication/diagnostics', async () => {
    const f = fixture('existing'); optional(f);
    const current = mergeVerifiedAllowlist({ orgId: ORG, currentRoot: ethers.constants.HashZero, entries: [{ type: 'email', identifier: 'old@example.org', hatIds: [f.id], roleIndexes: [] }] });
    f.root = current.root; f.rootCid = hash('b'); f.docs.set(bytes32ToCidV0(hash('b')), current.doc); f.request.role.emailAdditions = [{ type: 'email', identifier: 'new@example.org' }];
    const plan = ready(await prepareRoleOperation(f.prepare(ready(await reviewRoleOperation({ ...f.input(), fetchDocument: f.fetchDocument })))));
    const doc = f.publishDocument.mock.calls[0][0]; const parsed = JSON.parse(doc.json);
    expect(parsed.entries.map((row: any) => row.emailHash)).toEqual(expect.arrayContaining([emailHash('old@example.org'), emailHash('new@example.org')]));
    expect(doc.json).not.toContain('@'); expect(JSON.stringify(plan.evidence)).not.toContain('@');
    expect(plan.documents).toEqual([{ key: 'email-allowlist', digest: ethers.utils.id(doc.json), cid: EMAIL_CID }]);
  });
  it.each(['changed', 'expired', 'copied'])('final revalidation after an envelope await rejects %s and causes zero manager calls', async kind => {
    const f = fixture(); const review = ready(await reviewRoleOperation(f.input())); const prepared = ready(await prepareRoleOperation(f.prepare(review))); const manager = vi.fn();
    await Promise.resolve(); if (kind === 'changed') f.subjects[0].maxMembers = '3'; if (kind === 'expired') f.now += 61;
    const result = await revalidatePreparedRoleOperation({ ...f.prepare(review), prepared: kind === 'copied' ? JSON.parse(JSON.stringify(prepared)) : prepared });
    if (result.status === 'ready') manager(result.data.batch); expect(manager).not.toHaveBeenCalled(); expect(result.status).not.toBe('ready'); expect(f.publishDocument).not.toHaveBeenCalled();
  });
  it('rejects in-place host request edits made during publication and retains the receipt', async () => {
    const f = fixture(); f.request.metadata = { name: 'Builders', description: 'Details' }; const review = ready(await reviewRoleOperation(f.input()));
    f.publishDocument.mockImplementation(async () => { f.request.role.name = 'Edited'; return { cid: CID }; });
    const result = await prepareRoleOperation(f.prepare(review)); expect(result.status).not.toBe('ready'); expect((result as any).publishedDocuments[0].cid).toBe(CID); expect(result).not.toHaveProperty('data');
  });
  it('rechecks canonicality after an asynchronous current-document fetch', async () => {
    const f = fixture('existing'); optional(f); const current = mergeVerifiedAllowlist({ orgId: ORG, currentRoot: ethers.constants.HashZero, entries: [{ type: 'domain', identifier: 'old.org', hatIds: [f.id] }] });
    f.root = current.root; f.rootCid = META; f.request.role.emailAdditions = [{ type: 'domain', identifier: 'new.org' }];
    const fetchDocument = vi.fn(async () => { f.provider.getBlock.mockResolvedValue({ number: 100, hash: hash('a'), timestamp: 1000 }); return current.doc; });
    const result = await reviewRoleOperation({ ...f.input(), fetchDocument }); expect(result.status).toBe('unknown'); expect(result).not.toHaveProperty('data');
  });
  it('final revalidation preserves exact calldata/value and does not publish again', async () => {
    const f = fixture(); f.request.metadata = { name: 'Builders', description: 'Details' }; const review = ready(await reviewRoleOperation(f.input())); const prepared = ready(await prepareRoleOperation(f.prepare(review)));
    const result = ready(await revalidatePreparedRoleOperation({ ...f.prepare(review), prepared })); expect(result.batch).toEqual(prepared.batch); expect(result.batch[0].value).toBe('0'); expect(f.publishDocument).toHaveBeenCalledOnce();
  });
});

describe('strict source qualification and finite observation', () => {
  it.each(['endpoint', 'chain', 'org', 'authority', 'module', 'missing metadata', 'partial GraphQL', 'page block', 'terminal empty page', 'RPC chain', 'RPC canonical', 'RPC budget', 'field unavailable', 'unknown preflight'])('keeps %s evidence unknown without an executable review', async kind => {
    const f = fixture('existing'); optional(f); f.request.role.editOrgDetails = true;
    if (kind === 'RPC chain') f.provider.getNetwork.mockResolvedValue({ chainId: 42161 });
    if (kind === 'RPC canonical') f.provider.getBlock.mockResolvedValue({ number: 101, hash: hash('8'), timestamp: 1000 });
    if (kind === 'field unavailable') f.fail = 'getSubject';
    if (kind === 'unknown preflight') f.fail = 'setOrgMetadataAdminHat';
    f.modify = (_source, doc, _vars, result) => {
      if (kind === 'endpoint') result.source.endpoint = 'mock://wrong';
      if (kind === 'chain') result.source.chainId = 42161;
      if (kind === 'org') result.data.organization.id = hash('a');
      if (kind === 'authority') result.data.organization.membershipAuthority.id = addr('a');
      if (kind === 'module') result.data.organization.hybridVoting.id = addr('a');
      if (kind === 'missing metadata') delete result.data._meta;
      if (kind === 'partial GraphQL') result.issues = [{ code: 'GRAPHQL_ERROR' }];
      if (kind === 'page block' && doc.includes('SubjectsPage')) result.data._meta.block.hash = hash('a');
      if (kind === 'terminal empty page' && doc.includes('PermsPage')) result.data._meta.block.number++;
    };
    const result = await reviewRoleOperation({ ...f.input(), bounds: kind === 'RPC budget' ? { maxRpcCalls: 1 } : {} });
    expect(result.status).toBe('unknown'); expect(result).not.toHaveProperty('data'); expect(f.publishDocument).not.toHaveBeenCalled();
  });
  it('known false authorization is blocked and known zero/false evidence survives', async () => {
    const f = fixture(); f.executor = addr('a'); const evidence = ready(await readRoleOperationEvidence(f.input()));
    expect(evidence.context.data.executorAuthorized).toMatchObject({ state: 'known', value: false }); expect((await reviewRoleOperation(f.input())).status).toBe('blocked');
  });
  it.each(['registry', 'paymaster'])('distinguishes exact %s authorization denial from unrelated reverts', async module => {
    const f = fixture('existing'); optional(f); if (module === 'registry') f.request.role.editOrgDetails = true;
    else f.request.role.sponsorship = { capRaw: '9007199254740993', epochSeconds: '3600' };
    const original = f.provider.call.getMockImplementation()!;
    const iface = new ethers.utils.Interface(getAbi(module === 'registry' ? 'OrgRegistry' : 'PaymasterHub'));
    const method = module === 'registry' ? 'setOrgMetadataAdminHat' : 'setBudget', errorName = module === 'registry' ? 'NotOrgExecutor' : 'NotOperator';
    f.provider.call.mockImplementation(async (tx: any, block: any) => {
      if (tx.to === f.scope.contracts[module] && tx.data.startsWith(iface.getSighash(method))) throw { data: iface.encodeErrorResult(errorName, []) };
      return original(tx, block);
    });
    expect((await reviewRoleOperation(f.input())).status).toBe('blocked');
    f.provider.call.mockImplementation(async (tx: any, block: any) => {
      if (tx.to === f.scope.contracts[module] && tx.data.startsWith(iface.getSighash(method))) throw { data: iface.encodeErrorResult(module === 'registry' ? 'OrgUnknown' : 'OrgNotRegistered', []) };
      return original(tx, block);
    });
    expect((await reviewRoleOperation(f.input())).status).toBe('unknown');
  });
  it.each(['projection', 'collection scope', 'collection block', 'collection missing', 'aggregate empty coverage', 'field missing'])('rejects cached authority %s substitution while preserving actual sources', async kind => {
    const f = fixture('existing'), snapshot = ready(await readRoleOperationEvidence(f.input())).authoritySnapshot;
    const cached = JSON.parse(JSON.stringify(snapshot));
    if (kind === 'projection') cached.data.subjects[0].maxMembers = '3';
    if (kind === 'collection scope') cached.data.collections.subjects.source.endpoint = 'mock://other';
    if (kind === 'collection block') cached.data.collections.subjects.source.block.hash = hash('a');
    if (kind === 'collection missing') delete cached.data.collections.subjects;
    if (kind === 'aggregate empty coverage') cached.coverage = { status: 'complete', expectedKeys: [], receivedKeys: [], missingIds: [], failedIds: [], issues: [] };
    if (kind === 'field missing') delete cached.data.subjects[0].memberCount;
    const result = await readRoleOperationEvidence({ ...f.input(), authoritySnapshot: cached }); expect(result.status).toBe('unknown'); expect(result).not.toHaveProperty('data');
  });
  it('accepts a qualified authority optimization without refetching its collections', async () => {
    const f = fixture('existing'), snapshot = ready(await readRoleOperationEvidence(f.input())).authoritySnapshot; f.query.mockClear();
    ready(await readRoleOperationEvidence({ ...f.input(), authoritySnapshot: snapshot }));
    expect(f.query).toHaveBeenCalledOnce(); expect(f.query.mock.calls[0][1]).toContain('RolePlanningModuleBindings');
  });
  it.each([0, -1, Number.POSITIVE_INFINITY, 1.5])('invalid RPC budget %s returns unknown before transport', async maxRpcCalls => {
    const f = fixture(); const result = await readRoleOperationEvidence({ ...f.input(), bounds: { maxRpcCalls } });
    expect(result.status).toBe('unknown'); expect(f.query).not.toHaveBeenCalled(); expect(f.provider.call).not.toHaveBeenCalled();
  });
  it('requested claim budget initialization is explicit and never inferred from module availability', async () => {
    const f = fixture('existing'); optional(f); f.request.role.emailAdditions = [{ type: 'domain', identifier: 'example.org' }];
    f.request.role.sponsorship = { capRaw: '1', epochSeconds: '3600', supportPasskeys: true };
    expect(await reviewRoleOperation(f.input())).toMatchObject({ status: 'blocked', codes: ['CLAIM_BUDGET_INITIALIZATION_REQUIRED'] });
  });
  it('records the exact selected observation coverage and respects lower finite bounds', async () => {
    const f = fixture('existing'); const e = ready(await readRoleOperationEvidence(f.input())); expect(e.context.coverage.status).toBe('complete');
    expect([...e.context.coverage.expectedKeys!].sort()).toEqual([...e.context.coverage.receivedKeys].sort()); expect(e.proposals).toBeUndefined();
    expect((await readRoleOperationEvidence({ ...f.input(), bounds: { maxAccounts: 51 } })).status).toBe('unknown');
    f.request.role.holders = [{ account: ACCOUNT, sticky: false }, { account: addr('a'), sticky: false }];
    const limited = await readRoleOperationEvidence({ ...f.input(), bounds: { maxAccounts: 1 } }); expect(limited.status).toBe('unknown');
    expect((limited as any).codes).toContain('ROLE_ACCOUNT_LIMIT_EXCEEDED');
  });
  it('never enumerates unrelated subjects over RPC on an existing edit', async () => {
    const f = fixture('existing'); for (let i = 16; i < 90; i++) f.subjects.push({ ...f.subjects[0], id: composeSubjectId(AUTH, i), subjectId: composeSubjectId(AUTH, i) });
    ready(await readRoleOperationEvidence(f.input())); expect(f.provider.call.mock.calls.filter(([tx]: any) => tx.data.startsWith(a.getSighash('getSubject')))).toHaveLength(1);
  });
});

describe('explicit compound bounded complete provenance', () => {
  it.each(['missing timestamp', 'wrong timestamp', 'archive reorg', 'binding', 'chain', 'transaction hash', 'calldata', 'event', 'proposal id', 'creation block', 'indirect target'])('retains unproven %s history through strict public review', async kind => {
    const f = fixture('compound'), call = { target: AUTH, value: '0', calldata: a.encodeFunctionData('setSubjectDefault', [f.id, false, false]) }, p = proposal(f, 1, [call]);
    f.request.role.defaultAllow = true;
    if (kind === 'chain') p.tx.chainId = 1;
    if (kind === 'transaction hash') p.tx.hash = hash('a');
    if (kind === 'calldata') p.tx.data += '00';
    if (kind === 'event') f.receipts.get(p.transactionHash).logs[0].address = addr('a');
    if (kind === 'indirect target') p.tx.data = h.encodeFunctionData('createProposal', [ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Proposal 1')), META, 10, 2, [[[addr('a'), call.value, call.calldata]], []], []]);
    f.modify = (_source, doc, _vars, result) => {
      if (doc.includes('RecoverSubjectCreation')) {
        if (kind === 'missing timestamp') delete result.data._meta.block.timestamp;
        if (kind === 'wrong timestamp') result.data._meta.block.timestamp--;
        if (kind === 'binding') result.data.organization.membershipAuthority.id = addr('a');
        if (kind === 'proposal id') result.data.proposals[0] = { ...p.row, proposalId: '2' };
        if (kind === 'creation block') result.data.proposals[0] = { ...p.row, createdAtBlock: '49' };
      }
      if (kind === 'archive reorg' && doc.includes('HybridProposalsPage')) result.data._meta.block.hash = hash('a');
    };
    const result = await reviewRoleOperation(f.input());
    expect(result.status).toBe('unknown'); expect(result).not.toHaveProperty('data');
    if (result.status !== 'ready') expect(result.observations?.proposals).toBeDefined();
    expect(f.publishDocument).not.toHaveBeenCalled();
  });
  it('preserves exact ordered full-branch calldata, uint amounts and the 20/21-call limit through the public operation boundary', async () => {
    const f = fixture('compound'); optional(f);
    const group = composeSubjectId(AUTH, 16); f.subjects.push({ ...f.subjects[0], id: group, subjectId: group, kind: 'Group', maxMembers: '0' });
    f.request.role = { kind: 'Role', name: 'Builders', maxMembers: '4', defaultAllow: true, groupIds: [group], permissions: [
      { key: PERM_KEYS.HV_CREATE, value: '1' }, { key: PERM_KEYS.TM_PERMS, value: '9007199254740993', projectId: '0', inheritGlobal: false }],
      vouch: { quorum: '2', voucherSubjectId: f.id }, manager: { managerSubjectId: f.id, caps: 3, delaySeconds: '3600' }, holders: [{ account: ACCOUNT, sticky: true }],
      taskGrants: { creator: true, organizer: true }, bindingClassIndex: 0, editOrgDetails: true,
      sponsorship: { capRaw: '1000000000000001', epochSeconds: '3600', supportPasskeys: true, initializeClaimBudget: true },
      emailAdditions: [{ type: 'domain', identifier: 'example.org' }] };
    const review = ready(await reviewRoleOperation(f.input())), prepared = ready(await prepareRoleOperation(f.prepare(review)));
    const email = JSON.parse(f.publishDocument.mock.calls[0][0].json), { emailAdditions, ...role } = f.request.role;
    const low = planRoleConfiguration({ scope: f.scope, context: prepared.evidence.context, freshness: prepared.evidence.freshness, allocations: prepared.evidence.allocations!, proposals: prepared.evidence.proposals!,
      request: { ...role, email: { additions: emailAdditions!, preparedRoot: email.root, cid: EMAIL_CID } } });
    expect(low.status).toBe('ready'); if (low.status === 'ready') expect(prepared.batch).toEqual(low.data.batch.map(call => ({ ...call, value: String(call.value) })));
    const interfaces = [a, h, e, ...['TaskManagerNew', 'OrgRegistry', 'PaymasterHub', 'ZkEmailInvites'].map(name => new ethers.utils.Interface(getAbi(name)))];
    const decoded = prepared.batch.map(call => { for (const iface of interfaces) try { return iface.parseTransaction({ data: call.calldata }); } catch {} throw new Error('Unknown call'); });
    expect(decoded.map(call => call.name)).toEqual(['createRole', 'setSubjectDefault', 'addRoleToGroup', 'setPerm', 'setPerm', 'configureVouchAttestor', 'setManagerConfig', 'offer', 'setConfig', 'setConfig', 'addHatToClass', 'setOrgMetadataAdminHat', 'setBudget', 'setRulesBatch', 'setBudget', 'setHatMinterAuthorization', 'setActiveAllowlist']);
    expect(decoded[12].args[2].toString()).toBe('1000000000000001'); expect((BigInt(decoded[4].args[3].toString()) & ((1n << 254n) - 1n)).toString()).toBe('9007199254740993');
    expect(review.consequences.map(c => c.code)).toEqual(expect.arrayContaining(['SUBJECT_CREATION_RACE', 'SHARED_SPONSORSHIP_BUDGET', 'INITIALIZE_EMAIL_CLAIM_BUDGET', 'REPLACE_ORG_METADATA_ADMIN', 'ALLOWLIST_EXECUTION_RACE']));
    f.request.role.permissions = [...f.request.role.permissions!, ...[0, 1, 2].map(n => ({ key: permissionKey('extra' + n), value: '1' }))];
    expect(ready(await reviewRoleOperation(f.input())).preview.callCount).toBe(20);
    f.request.role.permissions = [...f.request.role.permissions!, { key: permissionKey('extra3'), value: '1' }];
    expect(await reviewRoleOperation(f.input())).toMatchObject({ status: 'blocked', codes: ['TOO_MANY_CALLS'] });
  });
  it('visits all 205 archived pending proposals and proves their canonical nonallocating calls', async () => {
    const f = fixture('compound'); f.request.role.permissions = [{ key: PERM_KEYS.HV_CREATE, value: '1' }];
    for (let n = 1; n <= 205; n++) proposal(f, n, [{ target: AUTH, value: '0', calldata: a.encodeFunctionData('setSubjectDefault', [f.id, false, false]) }]);
    f.archive.sort((a, b) => a.id.localeCompare(b.id));
    const review = ready(await reviewRoleOperation(f.input())); expect(review.evidence.proposals?.data).toHaveLength(205); expect(review.evidence.proposals?.coverage.pages).toBe(3);
    expect(review.predictedSubjectId).toBe(composeSubjectId(AUTH, 16)); expect(f.provider.getTransaction).toHaveBeenCalledTimes(205);
  });
  it.each(['competing', 'indirect', 'capped archive', 'candidate budget', 'subject budget'])('refuses %s without affecting staged creation', async kind => {
    const f = fixture('compound'); f.request.role.defaultAllow = true;
    proposal(f, 1, [{ target: kind === 'indirect' ? addr('a') : AUTH, value: '0', calldata: a.encodeFunctionData('createRole', ['Other', META, '', 0]) }]);
    if (kind === 'candidate budget') proposal(f, 2, [{ target: AUTH, value: '0', calldata: a.encodeFunctionData('renameSubject', [f.id, 'Updated', META, '']) }]);
    if (kind === 'subject budget') f.subjects.push({ ...f.subjects[0], id: composeSubjectId(AUTH, 16), subjectId: composeSubjectId(AUTH, 16) });
    const result = await reviewRoleOperation({ ...f.input(), bounds: kind === 'capped archive' ? { proposalPageSize: 1, proposalMaxPages: 1 } : kind === 'candidate budget' ? { maxProvenanceCandidates: 1 } : kind === 'subject budget' ? { maxCompoundSubjects: 1 } : {} });
    expect(result.status).not.toBe('ready'); expect(result).not.toHaveProperty('data'); f.request = { mode: 'create', role: f.request.role }; expect((await reviewRoleOperation(f.input())).status).toBe('ready');
  });
});

describe('shared exact status and actual-ID continuation', () => {
  it('cannot reuse the creation proposal as the configuration stage', async () => {
    const f = fixture(), creation = created(f);
    const result = await readRoleOperationStatus({ scope: f.scope, sources: f.sources, creation,
      configuration: { transactionHash: creation.transactionHash, batch: [creation.call] } });
    expect(result).toMatchObject({ status: 'unknown', codes: ['ROLE_CONFIGURATION_STAGE_REPLAY'],
      observations: { creation: { state: 'known', value: { state: 'created', subjectId: f.id } } } });
    expect(result).not.toHaveProperty('data');
  });
  it.each(['foreign subject', 'matching first call with foreign trailing call', 'another creation', 'unsupported call', 'unbound target', 'nonzero value', 'wrong role/group position'])('rejects %s configuration despite canonical successful execution', async mode => {
    const f = fixture(), creation = created(f), otherId = composeSubjectId(AUTH, 9);
    const actual = { target: AUTH, value: '0', calldata: a.encodeFunctionData('setSubjectDefault', [f.id, true, false]) };
    const foreign = { ...actual, calldata: a.encodeFunctionData('setSubjectDefault', [otherId, true, false]) };
    const batch = mode === 'foreign subject' ? [foreign] : mode === 'matching first call with foreign trailing call' ? [actual, foreign]
      : mode === 'another creation' ? [creation.call] : mode === 'unsupported call' ? [{ ...actual, calldata: a.encodeFunctionData('setPaused', [true]) }]
      : mode === 'unbound target' ? [{ ...actual, target: addr('b') }] : mode === 'nonzero value' ? [{ ...actual, value: '1' }]
      : [{ ...actual, calldata: a.encodeFunctionData('addRoleToGroup', [otherId, f.id]) }];
    const result = await readRoleOperationStatus({ scope: f.scope, sources: f.sources, creation, configuration: executedConfiguration(f, batch) });
    expect(result).toMatchObject({ status: 'unknown', codes: ['ROLE_CONFIGURATION_SUBJECT_UNPROVEN'],
      observations: { creation: { state: 'known', value: { state: 'created', subjectId: f.id } }, configuration: { state: 'unknown' } } });
    expect(result).not.toHaveProperty('data');
  });
  it.each(['passkey budget', 'email additions', 'configured email rules'])('proves an SDK-generated %s configuration after JSON reload', async mode => {
    const f = fixture('existing'); optional(f); const creation = created(f);
    const configured = mergeVerifiedAllowlist({ orgId: ORG, currentRoot: ethers.constants.HashZero,
      entries: [{ type: 'domain', identifier: 'existing.example', hatIds: [f.id], roleIndexes: [] }] });
    if (mode === 'configured email rules') { f.root = configured.root; f.rootCid = META; f.docs.set(bytes32ToCidV0(META), configured.doc); f.minter = true; }
    f.request = { mode: 'existing', subjectId: f.id, continuation: creation, role: { kind: 'Role', name: 'Builders', maxMembers: '2', defaultAllow: true,
      permissions: [{ key: PERM_KEYS.HV_CREATE, value: '1' }], holders: [{ account: ACCOUNT, sticky: false }],
      taskGrants: { creator: true, organizer: true }, bindingClassIndex: 0, editOrgDetails: true,
      sponsorship: { capRaw: '1000', epochSeconds: '3600', supportPasskeys: true, initializeClaimBudget: mode !== 'passkey budget',
        ...(mode === 'configured email rules' ? { includeConfiguredEmailRules: true } : {}) },
      ...(mode === 'email additions' ? { emailAdditions: [{ type: 'domain', identifier: 'builders.example' }] } : {}) } };
    const review = ready(await reviewRoleOperation(f.input()));
    const prepared = ready(await prepareRoleOperation({ ...f.prepare(review), publishDocument: async document => {
      const result = await f.publishDocument(document); f.docs.set(result.cid, JSON.parse(document.json)); return result;
    } }));
    const configuration = executedConfiguration(f, prepared.batch);
    const saved = JSON.parse(JSON.stringify({ scope: f.scope, creation, configuration }));
    const result = ready(await readRoleOperationStatus({ ...saved, sources: f.sources, fetchDocument: f.fetchDocument }));
    expect(result).toMatchObject({ creation: { state: 'created', subjectId: f.id }, configuration: { state: 'executed', proposalId: '8' }, next: 'complete' });
    expect(f.fetchDocument).toHaveBeenCalledTimes(mode === 'email additions' ? 1 : 0);
    if (mode === 'email additions') {
      const missing = await readRoleOperationStatus({ ...saved, sources: f.sources });
      expect(missing).toMatchObject({ status: 'unknown', codes: ['ROLE_CONFIGURATION_DOCUMENT_REQUIRED'], observations: { creation: { state: 'known', value: { subjectId: f.id } } } });
      expect(missing).not.toHaveProperty('data');
    }
  });
  it('uses the group subject position in SDK-generated group configuration after reload', async () => {
    const f = fixture('existing'), roleId = composeSubjectId(AUTH, 9); f.subjects[0].kind = 'Group';
    f.subjects.push({ ...f.subjects[0], id: roleId, subjectId: roleId, kind: 'Role' });
    f.subjects.sort((left, right) => left.id.localeCompare(right.id));
    const creation = created(f, 7, 'Group');
    f.request = { mode: 'existing', subjectId: f.id, continuation: creation, role: { kind: 'Group', name: 'Builders', memberRoleIds: [roleId] } };
    const prepared = ready(await prepareRoleOperation(f.prepare(ready(await reviewRoleOperation(f.input())))));
    const saved = JSON.parse(JSON.stringify({ scope: f.scope, creation, configuration: executedConfiguration(f, prepared.batch) }));
    expect(ready(await readRoleOperationStatus({ ...saved, sources: f.sources }))).toMatchObject({ creation: { subjectId: f.id }, configuration: { state: 'executed' }, next: 'complete' });
  });
  it('rejects unbound ancillary configuration calls and unavailable documents, retaining the creation proof', async () => {
    const f = fixture('existing'); optional(f); const creation = created(f), otherId = composeSubjectId(AUTH, 9);
    f.request = { mode: 'existing', subjectId: f.id, role: { kind: 'Role', name: 'Builders', taskGrants: { creator: true, organizer: false },
      bindingClassIndex: 0, editOrgDetails: true, emailAdditions: [{ type: 'domain', identifier: 'builders.example' }],
      sponsorship: { capRaw: '1000', epochSeconds: '3600', supportPasskeys: true, initializeClaimBudget: true } } };
    const documents = new Map<string, unknown>();
    const prepared = ready(await prepareRoleOperation({ ...f.prepare(ready(await reviewRoleOperation(f.input()))), publishDocument: async document => {
      const result = await f.publishDocument(document); documents.set(result.cid, JSON.parse(document.json)); return result;
    } }));
    const interfaces = Object.fromEntries(['PaymasterHub', 'TaskManagerNew', 'HybridVotingNew', 'OrgRegistry', 'Executor', 'ZkEmailInvites'].map(name => [name, new ethers.utils.Interface(getAbi(name))]));
    const replace = (batch: any[], abi: string, method: string, change: (args: any[]) => any[]) => {
      const iface = interfaces[abi], selector = iface.getSighash(method);
      return batch.map(call => call.calldata.startsWith(selector) ? { ...call, calldata: iface.encodeFunctionData(method, change([...iface.parseTransaction({ data: call.calldata }).args])) } : call);
    };
    const foreignList = mergeVerifiedAllowlist({ orgId: ORG, currentRoot: ethers.constants.HashZero,
      entries: [{ type: 'domain', identifier: 'foreign.example', hatIds: [otherId], roleIndexes: [] }] });
    for (const mode of ['task subject', 'voting subject', 'admin subject', 'budget subject', 'rules target', 'claim cap', 'missing budget',
      'minter target', 'minter without allowlist', 'foreign allowlist', 'missing document', 'wrong root document', 'duplicate allowlist', 'wrong org']) {
      let batch = [...prepared.batch];
      if (mode === 'task subject') batch = replace(batch, 'TaskManagerNew', 'setConfig', args => [args[0], ethers.utils.defaultAbiCoder.encode(['uint256', 'bool'], [otherId, true])]);
      if (mode === 'voting subject') batch = replace(batch, 'HybridVotingNew', 'addHatToClass', args => [args[0], otherId]);
      if (mode === 'admin subject') batch = replace(batch, 'OrgRegistry', 'setOrgMetadataAdminHat', () => [ORG, otherId]);
      if (mode === 'budget subject') batch = replace(batch, 'PaymasterHub', 'setBudget', args => [args[0], paymasterSubjectKey(SUBJECT_TYPE.HAT, otherId), args[2], args[3]]);
      if (mode === 'rules target') batch = replace(batch, 'PaymasterHub', 'setRulesBatch', args => [args[0], [addr('b'), ...args[1].slice(1)], ...args.slice(2)]);
      if (mode === 'claim cap') batch = replace(batch, 'PaymasterHub', 'setBudget', args => [args[0], args[1], sameKey(args[1], paymasterSubjectKey(SUBJECT_TYPE.CLAIM, f.scope.contracts.email)) ? '1001' : args[2], args[3]]);
      if (mode === 'missing budget') batch = batch.filter(call => !call.calldata.startsWith(interfaces.PaymasterHub.getSighash('setBudget')));
      if (mode === 'minter target') batch = replace(batch, 'Executor', 'setHatMinterAuthorization', () => [addr('b'), true]);
      if (mode === 'minter without allowlist') batch = batch.filter(call => !call.calldata.startsWith(interfaces.ZkEmailInvites.getSighash('setActiveAllowlist')));
      if (mode === 'foreign allowlist') batch = replace(batch, 'ZkEmailInvites', 'setActiveAllowlist', args => [foreignList.root, args[1]]);
      if (mode === 'duplicate allowlist') batch.push(batch.find(call => call.calldata.startsWith(interfaces.ZkEmailInvites.getSighash('setActiveAllowlist'))) !);
      if (mode === 'wrong org') batch = replace(batch, 'PaymasterHub', 'setRulesBatch', args => [hash('9'), ...args.slice(1)]);
      const fetchDocument = vi.fn(async (cid: string) => mode === 'missing document' ? null : mode === 'foreign allowlist' || mode === 'wrong root document' ? foreignList.doc : documents.get(cid));
      const result = await readRoleOperationStatus({ scope: f.scope, sources: f.sources, creation, configuration: executedConfiguration(f, batch), fetchDocument });
      expect(result.status, mode).toBe('unknown'); expect(result).not.toHaveProperty('data');
      expect((result as any).observations.creation, mode).toMatchObject({ state: 'known', value: { state: 'created', subjectId: f.id } });
      expect(fetchDocument.mock.calls.length, mode).toBeLessThanOrEqual(1);
    }
    function sameKey(left: string, right: string) { return left.toLowerCase() === right.toLowerCase(); }
  });
  it.each(['pending', 'failed', 'rejected', 'created'])('preserves proven %s creation and the constrained next action', async state => {
    const f = fixture(), creation = created(f), row = f.exactRows.get(HV + '-7');
    if (state !== 'created') { row.wasExecuted = false; row.winningOption = null; row.isValid = state === 'rejected' ? false : null; row.executionFailed = state === 'failed'; row.batchExecutions = []; }
    const result = ready(await readRoleOperationStatus({ scope: f.scope, sources: f.sources, creation }));
    expect(result.creation.state).toBe(state); expect(result.next).toBe(state === 'created' ? 'review-configuration' : state === 'pending' ? 'wait' : 'review-creation');
  });
  it('re-proves a continuation and refuses a caller-supplied alternate subject ID', async () => {
    const f = fixture('existing'), creation = created(f); f.request = { ...f.request, mode: 'existing', subjectId: f.id, continuation: creation };
    expect((await reviewRoleOperation(f.input())).status).toBe('ready');
    f.subjects.push({ ...f.subjects[0], id: composeSubjectId(AUTH, 16), subjectId: composeSubjectId(AUTH, 16) }); f.request.subjectId = composeSubjectId(AUTH, 16);
    const result = await reviewRoleOperation(f.input()); expect(result.status).toBe('unknown'); expect((result as any).observations.creation.value.subjectId).toBe(f.id);
  });
  it('retains proven creation when independent configuration proof is unavailable', async () => {
    const f = fixture(), creation = created(f), batch = [{ target: AUTH, value: '0', calldata: a.encodeFunctionData('setSubjectDefault', [f.id, true, false]) }];
    const configuration = proposal(f, 8, batch); f.exactRows.delete(configuration.row.id);
    const result = await readRoleOperationStatus({ scope: f.scope, sources: f.sources, creation, configuration: { transactionHash: configuration.transactionHash, batch } });
    expect(result.status).toBe('unknown'); expect((result as any).observations.creation).toMatchObject({ state: 'known', value: { state: 'created', subjectId: f.id } }); expect(result).not.toHaveProperty('data');
  });
  it.each(['pending', 'failed', 'rejected', 'executed'])('uses the separate configuration transaction and returns %s', async state => {
    const f = fixture(), creation = created(f), batch = [{ target: AUTH, value: '0', calldata: a.encodeFunctionData('setSubjectDefault', [f.id, true, false]) }], config = proposal(f, 8, batch, state === 'executed');
    if (state === 'failed') config.row.executionFailed = true; if (state === 'rejected') config.row.isValid = false;
    if (state === 'executed') {
      const execTx = { ...config.tx, hash: hash('a'), blockNumber: 91, blockHash: hash('d'), data: h.encodeFunctionData('announceWinner', [8]) }; f.txs.set(execTx.hash, execTx);
      f.receipts.set(execTx.hash, { status: 1, transactionHash: execTx.hash, blockNumber: 91, blockHash: hash('d'), logs: [config.log(e, EXEC, 'CallExecuted', [8, 0, AUTH, 0], execTx), config.log(e, EXEC, 'BatchExecuted', [8, 1], execTx), config.log(h, HV, 'ProposalExecuted', [8, 0, 1], execTx)] });
      config.row.batchExecutions = [{ proposalId: '8', callCount: '1', transactionHash: execTx.hash, executedAtBlock: '91', executor: { id: EXEC } }];
    }
    const result = ready(await readRoleOperationStatus({ scope: f.scope, sources: f.sources, creation, configuration: { transactionHash: config.transactionHash, proposalId: '8', batch } }));
    expect(result.configuration?.state).toBe(state); expect(result.next).toBe(state === 'executed' ? 'complete' : state === 'pending' ? 'wait' : 'review-configuration');
  });
  it('refuses a trailing creation call, wrong caller, wrong configuration association or stale head', async () => {
    for (const mode of ['trailing', 'caller', 'configuration', 'stale']) {
      const f = fixture(), creation = created(f); if (mode === 'trailing') creation.call.calldata += '00'; if (mode === 'caller') f.scope.account = addr('a'); if (mode === 'stale') f.now = 1061;
      const result = await readRoleOperationStatus({ scope: f.scope, sources: f.sources, creation, ...(mode === 'configuration' ? { configuration: { transactionHash: creation.transactionHash, batch: [{ ...creation.call, calldata: a.encodeFunctionData('setSubjectDefault', [f.id, true, false]) }] } } : {}) });
      expect(result.status).toBe('unknown'); expect(result).not.toHaveProperty('data');
    }
  });
});
