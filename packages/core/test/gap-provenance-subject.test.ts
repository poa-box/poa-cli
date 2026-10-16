import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { getAbi } from '../src/contracts';
import { readSubjectCreationProvenance, recoverSubjectCreationHistory } from '../src/governance/provenance';
import { subjectCreationRaceFacts } from '../src/authority/ids';
import { readCanonicalTransaction, requireCanonicalTransaction } from '../src/reads/provenance';

const VOTING = '0x1111111111111111111111111111111111111111';
const AUTHORITY = '0x2222222222222222222222222222222222222222';
const ACCOUNT = '0x3333333333333333333333333333333333333333';
const OTHER = '0x4444444444444444444444444444444444444444';
const TX = '0x' + 'a1'.repeat(32), HASH = '0x' + 'b2'.repeat(32), OLD_HASH = '0x' + 'c3'.repeat(32), META = '0x' + 'd4'.repeat(32);
const authority = new ethers.utils.Interface(getAbi('MembershipAuthority'));
// Independent contract-shaped oracle, including the facade's delegatecall event.
const voting = new ethers.utils.Interface([
  'function createProposal(bytes title,bytes32 descriptionHash,uint32 minutesDuration,uint8 numOptions,(address target,uint256 value,bytes data)[][] batches,uint256[] hatIds)',
  'function createProposalV2(bytes title,bytes32 descriptionHash,uint32 minutesDuration,uint8 numOptions,(address target,uint256 value,bytes data)[][] batches,uint256[] hatIds,uint32 quorumOverride,bool equalWeight)',
  'event NewProposal(uint256 id,bytes title,bytes32 descriptionHash,uint8 numOptions,uint64 endTs,uint64 created)',
  'event NewHatProposal(uint256 id,bytes title,bytes32 descriptionHash,uint8 numOptions,uint64 endTs,uint64 created,uint256[] hatIds)',
]);
const scope = { chainId: 100, orgId: 'test-org', contract: VOTING, contracts: { membershipAuthority: AUTHORITY } };
const source = { ...scope, endpoint: 'mock://index', method: 'exact-proposal', indexed: true, snapshot: 'pinned' as const, block: { number: '100', hash: HASH }, observedAt: 1000 };
const rpcSource = { ...source, endpoint: 'mock://rpc', method: 'exact-receipt', indexed: false };
const freshness = { now: 1000, maxAgeSeconds: 0 };
const coverage = { status: 'complete' as const, receivedKeys: [], missingIds: [], failedIds: [], issues: [] };
function call(method = 'createRole', args: unknown[] = ['Stewards', META, '', 0], target = AUTHORITY) {
  return [target, '0', authority.encodeFunctionData(method, args)];
}
function fixture(batches: unknown[][] = [[call()], []], restricted = false, v2 = false) {
  const title = ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Historical role'));
  const hats = restricted ? ['9007199254740993'] : [];
  const args = [title, META, 10, 2, batches, hats, ...(v2 ? [0, false] : [])];
  const event = voting.encodeEventLog(voting.getEvent(restricted ? 'NewHatProposal' : 'NewProposal'), [7, title, META, 2, 1600, 1000, ...(restricted ? [hats] : [])]);
  const tx = { hash: TX, blockNumber: 50, blockHash: OLD_HASH, from: ACCOUNT, to: VOTING, data: voting.encodeFunctionData(v2 ? 'createProposalV2' : 'createProposal', args), value: ethers.BigNumber.from(0), chainId: 100 };
  const receipt = { status: 1, transactionHash: TX, blockNumber: 50, blockHash: OLD_HASH,
    logs: [{ ...event, address: VOTING, transactionHash: TX, blockNumber: 50, blockHash: OLD_HASH, removed: false }] };
  const row = { id: VOTING + '-7', proposalId: '7', title: 'Historical role', descriptionHash: META, numOptions: 2, transactionHash: TX, createdAtBlock: '50', hybridVoting: { id: VOTING, organization: { id: scope.orgId } } };
  const response = { _meta: { block: { number: 100, hash: HASH } }, organization: { id: scope.orgId, membershipAuthority: { id: AUTHORITY }, hybridVoting: { id: VOTING } }, proposals: [row] };
  const provider = { getNetwork: vi.fn(async () => ({ chainId: 100 })), getTransaction: vi.fn(async () => tx), getTransactionReceipt: vi.fn(async () => receipt),
    getBlock: vi.fn(async (tag: string) => ({ number: tag === '0x32' ? 50 : 100, hash: tag === '0x32' ? OLD_HASH : HASH })) };
  const query = vi.fn(async () => response);
  const input = { scope, source, rpcSource, proposalId: '7', query, provider: provider as any, freshness };
  return { input, provider, query, response, row, tx, receipt };
}
function ready<T>(result: { status: string; data?: T }): T { expect(result.status).toBe('ready'); return result.data!; }

describe('historical subject intent recovery', () => {
  it.each([[false, false], [true, false], [true, true]])('recovers exact role intent, restricted=%s v2=%s', async (restricted, v2) => {
    const f = fixture([[call()], []], restricted, v2);
    const proof = ready(await readSubjectCreationProvenance(f.input));
    expect(proof).toMatchObject({ id: VOTING + '-7', createsSubject: true, creations: [{ optionIndex: 0, callIndex: 0, kind: 'Role' }], transactionHash: TX });
    expect(Object.isFrozen(proof.creations[0])).toBe(true);
    expect(f.query).toHaveBeenCalledOnce();
    expect(f.query.mock.calls[0][1]).toEqual({ orgId: scope.orgId, id: VOTING + '-7', block: { hash: HASH } });
    expect(f.provider.getTransaction).toHaveBeenCalledWith(TX);
    expect(f.provider.getBlock).toHaveBeenCalledTimes(4);
  });
  it('counts all roles/groups across options without pretending to know allocated subject IDs', async () => {
    const f = fixture([[call(), call('createGroup', ['Team', META, '', ['9007199254740993']])], [call('createRole', ['Alternative', META, '', 5])]]);
    const proof = ready(await readSubjectCreationProvenance(f.input));
    expect(proof.creations.map(c => c.kind)).toEqual(['Role', 'Group', 'Role']);
    expect(proof.creations.map(c => [c.optionIndex, c.callIndex])).toEqual([[0, 0], [0, 1], [1, 0]]);
    expect('subjectId' in proof.creations[0]).toBe(false);
  });
  it('recovers an exact no-creation proposal and unblocks the existing race check', async () => {
    const f = fixture([[call('renameSubject', ['9', 'New name', META, ''])], []]);
    const proof = ready(await readSubjectCreationProvenance(f.input));
    expect(proof.createsSubject).toBe(false);
    const history = { source, coverage, data: [{ id: VOTING + '-7', status: 'Ended', wasExecuted: false }] };
    expect(subjectCreationRaceFacts(history, scope).hasCompetingCreation.state).toBe('unknown');
    const recovered = recoverSubjectCreationHistory(history, [proof]);
    expect(subjectCreationRaceFacts(recovered, scope).hasCompetingCreation).toMatchObject({ state: 'known', value: false });
    expect(history.data[0]).not.toHaveProperty('createsSubject');
    expect(recovered.coverage).toBe(history.coverage);
  });
  it('metadata claims alone never become recovery proof, including false markers and summaries', () => {
    const history = { source, coverage, data: [{ id: VOTING + '-7', createsSubject: false, actionSummaries: ['Do nothing'], wasExecuted: false }] };
    const recovered = recoverSubjectCreationHistory(history, []);
    expect(recovered.data[0].createsSubject).toBeUndefined();
    expect(subjectCreationRaceFacts(recovered, scope).hasCompetingCreation.state).toBe('unknown');
    expect(() => recoverSubjectCreationHistory(history, [{ id: VOTING + '-7', createsSubject: false } as any])).toThrow('SUBJECT_CREATION_PROOF_REQUIRED');
  });
  it('a true creation remains competing after recovery even if stale metadata says false', async () => {
    const f = fixture(); const proof = ready(await readSubjectCreationProvenance(f.input));
    const recovered = recoverSubjectCreationHistory({ source, coverage, data: [{ id: proof.id, createsSubject: false, status: 'Ended', wasExecuted: false }] }, [proof]);
    expect(subjectCreationRaceFacts(recovered, scope)).toMatchObject({ competingIds: [proof.id], hasCompetingCreation: { state: 'known', value: true }, executionStable: false });
  });
  it('empty batches are verified false without any subject prediction', async () => {
    const proof = ready(await readSubjectCreationProvenance(fixture([]).input));
    expect(proof.createsSubject).toBe(false); expect(proof.creations).toEqual([]);
  });
  it.each([
    ['wrong authority target', () => fixture([[call('createRole', ['Spoof', META, '', 0], OTHER)], []])],
    ['arbitrary selector', () => fixture([[[AUTHORITY, 0, '0x12345678']], []])],
    ['initialization/seeding', () => fixture([[call('seedSubjects', [[], [], [], []])], []])],
    ['malformed calldata', () => fixture([[[AUTHORITY, 0, authority.encodeFunctionData('createRole', ['Role', META, '', 0]).slice(0, -2)]], []])],
    ['surplus calldata', () => fixture([[[AUTHORITY, 0, authority.encodeFunctionData('createRole', ['Role', META, '', 0]) + '00']], []])],
  ] as const)('%s cannot spoof a recoverable creation', async (_, make) => {
    const f = make(); expect((await readSubjectCreationProvenance(f.input)).status).toBe('blocked');
  });
  it.each([
    ['org', (f: ReturnType<typeof fixture>) => f.response.organization.id = 'other'],
    ['authority binding', f => f.response.organization.membershipAuthority.id = OTHER],
    ['voting binding', f => f.response.organization.hybridVoting.id = OTHER],
    ['proposal ID', f => f.row.proposalId = '8'],
    ['transaction block', f => f.row.createdAtBlock = '49'],
    ['metadata pointer', f => f.row.descriptionHash = OLD_HASH],
    ['title', f => f.row.title = 'Wrong title'],
    ['receipt failed', f => f.receipt.status = 0],
    ['wrong event emitter', f => f.receipt.logs[0].address = OTHER],
    ['removed event', f => f.receipt.logs[0].removed = true],
    ['duplicate proposal event', f => f.receipt.logs.push(f.receipt.logs[0])],
    ['noncanonical proposal call', f => f.tx.data += '00'],
    ['wrong chain', f => f.tx.chainId = 42161],
    ['wrong outer target', f => f.tx.to = OTHER],
    ['reorg', f => f.provider.getBlock.mockImplementation(async tag => ({ number: tag === '0x32' ? 50 : 100, hash: OLD_HASH }))],
    ['unproven indexed pin', f => f.response._meta.block.hash = OLD_HASH],
  ] as const)('fails closed on %s', async (_, mutate) => {
    const f = fixture(); mutate(f as any); expect((await readSubjectCreationProvenance(f.input)).status).toBe('blocked');
  });
  it.each(['valid', 'wrong target', 'wrong binding', 'unknown selector', 'malformed', 'trailing', 'mutable setter', 'indirect creation', 'native value'])('bound module classification: %s', async mode => {
    const email = new ethers.utils.Interface(getAbi('ZkEmailInvites'));
    const executor = new ethers.utils.Interface(getAbi('Executor'));
    let data = email.encodeFunctionData('setActiveAllowlist', [META, META]);
    if (mode === 'unknown selector') data = '0x12345678';
    if (mode === 'malformed') data = data.slice(0, -2);
    if (mode === 'trailing') data += '00';
    if (mode === 'mutable setter') data = email.encodeFunctionData('setDomainVerifier', [ACCOUNT]);
    if (mode === 'indirect creation') data = executor.encodeFunctionData('configureModule', [AUTHORITY, call()[2]]);
    const f = fixture([[[mode === 'wrong target' ? ACCOUNT : OTHER, mode === 'native value' ? 1 : 0, data]], []]);
    const contracts = { membershipAuthority: AUTHORITY, ...(mode === 'indirect creation' ? { executor: OTHER } : { email: OTHER }) };
    const input = { ...f.input, scope: { ...scope, contracts }, source: { ...source, contracts }, rpcSource: { ...rpcSource, contracts } };
    Object.assign(f.response.organization, { zkEmailInvites: { id: mode === 'wrong binding' ? ACCOUNT : OTHER }, executorContract: { id: OTHER } });
    const result = await readSubjectCreationProvenance(input);
    expect(result.status).toBe(mode === 'valid' ? 'ready' : 'blocked');
    if (result.status === 'ready') expect(result.data.createsSubject).toBe(false);
  });
  it.each([
    ['taskManager', 'TaskManagerNew', 'setConfig', [1, ethers.utils.defaultAbiCoder.encode(['uint256', 'bool'], ['7', true])], true],
    ['taskManager', 'TaskManagerNew', 'setConfig', [2, ethers.utils.defaultAbiCoder.encode(['uint256', 'uint8'], ['7', 133])], true],
    ['taskManager', 'TaskManagerNew', 'setConfig', [7, ethers.utils.defaultAbiCoder.encode(['uint256', 'bool'], ['7', false])], true],
    ['taskManager', 'TaskManagerNew', 'setConfig', [0, ethers.utils.defaultAbiCoder.encode(['address'], [ACCOUNT])], false],
    ['taskManager', 'TaskManagerNew', 'setConfig', [1, ethers.utils.defaultAbiCoder.encode(['uint256', 'bool'], ['7', true]) + '00'], false],
    ['executor', 'Executor', 'setHatMinterAuthorization', [ACCOUNT, true], true],
    ['executor', 'Executor', 'configureModule', [AUTHORITY, authority.encodeFunctionData('createRole', ['Indirect', META, '', 0])], false],
    ['participationToken', 'ParticipationToken', 'setName', ['Member ownership'], true],
    ['participationToken', 'ParticipationToken', 'setSymbol', ['mixedCase'], true],
    ['participationToken', 'ParticipationToken', 'transfer', [ACCOUNT, '1'], false],
    ['paymentManager', 'PaymentManager', 'createDistribution', [ACCOUNT, '1', META, '40'], true],
  ])('reviewed %s/%s/%s calldata keeps exact nested semantics', async (key, abi, method, args, expected) => {
    const iface = new ethers.utils.Interface(getAbi(abi as string));
    const f = fixture([[[OTHER, 0, iface.encodeFunctionData(method as string, args as unknown[])]], []]);
    const contracts = { membershipAuthority: AUTHORITY, [key as string]: OTHER };
    const fields: Record<string, string> = { taskManager: 'taskManager', executor: 'executorContract', participationToken: 'participationToken', paymentManager: 'paymentManager' };
    Object.assign(f.response.organization, { [fields[key as string]]: { id: OTHER } });
    const input = { ...f.input, scope: { ...scope, contracts }, source: { ...source, contracts }, rpcSource: { ...rpcSource, contracts } };
    const result = await readSubjectCreationProvenance(input);
    expect(result.status).toBe(expected ? 'ready' : 'blocked');
    if (result.status === 'ready') expect(result.data.createsSubject).toBe(false);
  });
  it('requires fresh same-snapshot evidence before reading and rejects transferred/copied proofs', async () => {
    const f = fixture();
    expect((await readSubjectCreationProvenance({ ...f.input, freshness: { now: 1001, maxAgeSeconds: 0 } })).status).toBe('blocked');
    expect(f.provider.getNetwork).not.toHaveBeenCalled();
    const proof = ready(await readSubjectCreationProvenance(f.input));
    const history = { source, coverage, data: [{ id: proof.id }] };
    expect(() => recoverSubjectCreationHistory(history, [{ ...proof }])).toThrow();
    expect(() => recoverSubjectCreationHistory({ ...history, source: { ...source, block: { number: '101', hash: HASH } } }, [proof])).toThrow();
    expect(() => recoverSubjectCreationHistory({ ...history, coverage: { ...coverage, status: 'incomplete' } }, [proof])).toThrow();
  });
  it('canonical receipt proof cannot be cloned, relabeled or silently retimed', async () => {
    const f = fixture();
    const observed = await readCanonicalTransaction({ source: rpcSource, provider: f.provider as any, transactionHash: TX, freshness });
    expect(requireCanonicalTransaction(observed, rpcSource, freshness).transactionHash).toBe(TX);
    expect(() => requireCanonicalTransaction({ ...observed }, rpcSource, freshness)).toThrow();
    expect(() => requireCanonicalTransaction(observed, { ...rpcSource, chainId: 42161 }, freshness)).toThrow();
    expect(() => requireCanonicalTransaction(observed, rpcSource, { now: 1001, maxAgeSeconds: 0 })).toThrow();
  });
});
