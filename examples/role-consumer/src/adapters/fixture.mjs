import { ethers } from 'ethers';
import { getAbi } from '@poa-box/core/contracts';
import { composeSubjectId } from '@poa-box/core/authority/ids';
import { AUTHORITY_KEYS, permissionWord, projectContext } from '@poa-box/core/tx/authority';
import * as authorityDocs from '@poa-box/core/graph/documents/authority';
import { FETCH_ORG_BY_ID } from '@poa-box/core/graph/documents/org';

const assert = (ok, message) => { if (!ok) throw new Error('FIXTURE:' + message); };
const canonical = value => value.replace(/\s+/g, ' ').trim();
const hash = digit => '0x' + digit.repeat(64);
const HEAD = 'query RoleOperationHead { _meta { block { number hash timestamp } } }';
const BINDINGS = `query RolePlanningModuleBindings($orgId: ID!, $block: Block_height) {
  _meta(block: $block) { block { number hash timestamp } }
  organization(id: $orgId, block: $block) { id membershipAuthority { id } executorContract { id } hybridVoting { id } }
}`;
const CONTINUATION = `query RoleContinuation($orgId: ID!, $id: String!, $block: Block_height) {
  _meta(block: $block) { block { number hash timestamp } }
  organization(id: $orgId, block: $block) { id membershipAuthority { id } hybridVoting { id } executorContract { id } }
  proposals(first: 1, where: {id: $id}, block: $block) {
    id proposalId transactionHash createdAtBlock wasExecuted executionFailed isValid winningOption status
    hybridVoting { id organization { id } }
    batchExecutions(first: 2) { proposalId callCount transactionHash executedAtBlock executor { id } }
  }
}`;

/** Only transport fixtures live here. All observation/planning/recovery is core. */
export function createFixture(config) {
  assert(config.synthetic === true && config.version === 1, 'SYNTHETIC_CONFIG_REQUIRED');
  const { contracts, orgId, account } = config, AUTH = contracts.membershipAuthority, HV = contracts.hybridVoting, EXEC = contracts.executor;
  const scope = { chainId: config.chainId, orgId, account, contract: AUTH, contracts };
  const ids = Object.fromEntries(['initial', 'group', 'actual', 'sameName'].map(key => [key, composeSubjectId(AUTH, config[key + 'Sequence'])]));
  const authority = new ethers.utils.Interface(getAbi('MembershipAuthority'));
  const voting = new ethers.utils.Interface(getAbi('HybridVotingNew'));
  const executor = new ethers.utils.Interface(getAbi('Executor'));
  const trace = { queries: [], rpc: [], publications: [], sends: [] };
  const state = { now: config.now, created: false, configured: false, missingMeta: false, authorityExecutor: EXEC };
  const transactions = new Map(), receipts = new Map(), proposals = new Map();
  const zero = ethers.constants.HashZero;
  const role = { kind: 'Role', name: config.name, maxMembers: config.maxMembers, defaultAllow: true,
    groupIds: [ids.group], permissions: [{ key: AUTHORITY_KEYS.TM_PERMS, value: '8' }], holders: [{ account, sticky: false }] };
  const request = { mode: 'create', role, metadata: { name: config.name, description: 'Synthetic reviewed role' } };
  const organization = () => ({ id: orgId, name: 'Synthetic organization', membershipAuthority: { id: AUTH, executor: EXEC,
    isRouterBound: true, cutoverAt: '1', paused: false, registeredAt: '1', maxDailyVouches: '10', initConfigDerived: false,
    subjectCount: state.created ? '4' : '3', roleSubjectCount: state.created ? '3' : '2', groupSubjectCount: '1', acceptedMembershipCount: '1', lastUpdatedAt: '1000' },
    hybridVoting: { id: HV }, executorContract: { id: EXEC }, taskManager: null, directDemocracyVoting: null,
    participationToken: null, educationHub: null, quickJoin: null, paymentManager: null, zkEmailInvites: null });
  const subject = (subjectId, kind, name, cap = '0') => ({ id: subjectId, subjectId, kind, name, metadataCID: zero,
    imageURI: '', maxMembers: cap, memberCount: '0', activeMemberCount: '0', defaultAllow: subjectId === ids.initial,
    isLegacyAdopted: false, createdAt: '900', createdAtBlock: '90', lastUpdatedAt: '1000', vouchConfig: null, managerConfig: null });
  function subjects() {
    const rows = [subject(ids.initial, 'Role', 'Members'), subject(ids.group, 'Group', 'Team'), subject(ids.sameName, 'Role', config.name)];
    if (state.created) rows.push(subject(ids.actual, 'Role', config.name, config.maxMembers));
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }
  const member = () => ({ id: ids.initial + '-' + account, user: account, userUsername: 'fixture', accepted: true,
    acceptedAt: '900', seededWhilePaused: false, eligible: true, isMember: true, claimable: false, ruleKind: 'None',
    eligibilitySource: 'SubjectDefault', emailVerified: false, vouchCount: '0', vouchEpoch: '0', vouchMet: false,
    firstSeenAt: '900', lastUpdatedAt: '1000', subject: { id: ids.initial, subjectId: ids.initial, kind: 'Role', name: 'Members', defaultAllow: true, vouchConfig: null }, rule: null, pendingAction: null });
  const edge = { id: ids.group + '-' + ids.initial, groupSubjectId: ids.group, roleSubjectId: ids.initial, isActive: true,
    addedAt: '900', addedAtBlock: '90', updatedAt: '1000', group: { id: ids.group, subjectId: ids.group, kind: 'Group', name: 'Team' },
    role: { id: ids.initial, subjectId: ids.initial, kind: 'Role', name: 'Members' } };
  const permission = { id: ids.group + '-task-global', subject: { id: ids.group, subjectId: ids.group, kind: 'Group', name: 'Team' },
    permKey: AUTHORITY_KEYS.TM_PERMS, ctx: zero, word: permissionWord('8').toString(), value: '8', exists: true, inheritGlobal: false,
    foldTag: 1, isGlobalCtx: true, setAt: '900', clearedAt: null, lastUpdatedAt: '1000' };
  const collections = () => ({ subjects: subjects(), subjectMemberships: [member()], groupCompositions: [edge], permRows: [permission], accessRules: [], subjectVouchRecords: [], pendingActions: [] });
  const meta = timestamp => state.missingMeta ? {} : { _meta: { block: { number: config.block.number, hash: config.block.hash, ...(timestamp ? { timestamp: config.block.timestamp } : {}) } } };
  const pageDocs = ['SUBJECTS', 'MEMBERSHIPS', 'GROUP_EDGES', 'PERMS', 'RULES', 'VOUCHES', 'PENDING'].map((key, index) => [canonical(authorityDocs['FETCH_AUTHORITY_' + key + '_PAGE']), ['subjects', 'subjectMemberships', 'groupCompositions', 'permRows', 'accessRules', 'subjectVouchRecords', 'pendingActions'][index]]);
  async function query(source, document, variables = {}) {
    assert(source.endpoint === config.indexedEndpoint && source.chainId === config.chainId && source.orgId === orgId, 'INDEX_SCOPE');
    assert(!source.account || source.account.toLowerCase() === account, 'INDEX_ACCOUNT');
    trace.queries.push({ document, variables: structuredClone(variables), method: source.method });
    const doc = canonical(document); let data;
    if (doc === canonical(HEAD)) {
      assert(Object.keys(variables).length === 0 && source.snapshot === 'latest', 'HEAD_VARIABLES'); data = meta(true);
    } else {
      assert(JSON.stringify(variables.block) === JSON.stringify({ hash: config.block.hash }), 'HASH_PIN_REQUIRED');
      assert(variables.orgId === orgId && source.snapshot === 'pinned' && source.block?.hash === config.block.hash, 'PINNED_SCOPE');
      if (doc === canonical(BINDINGS)) data = { ...meta(true), organization: { id: orgId, membershipAuthority: { id: AUTH }, executorContract: { id: EXEC }, hybridVoting: { id: HV } } };
      else if (doc === canonical(authorityDocs.FETCH_AUTHORITY_STATE)) data = { ...meta(false), organization: { id: orgId, membershipAuthority: organization().membershipAuthority } };
      else if (doc === canonical(CONTINUATION)) {
        assert(proposals.has(variables.id) && Object.keys(variables).sort().join(',') === 'block,id,orgId', 'EXACT_PROPOSAL_REQUIRED');
        data = { ...meta(true), organization: { id: orgId, membershipAuthority: { id: AUTH }, hybridVoting: { id: HV }, executorContract: { id: EXEC } }, proposals: [proposals.get(variables.id)] };
      } else {
        const selected = pageDocs.find(([expected]) => expected === doc);
        assert(selected, 'UNEXPECTED_DOCUMENT:' + doc.slice(0, 90));
        assert(Number.isInteger(variables.first) && variables.first > 0 && variables.first <= 1000 && typeof variables.lastId === 'string', 'PAGE_BOUNDS');
        const rows = collections()[selected[1]].filter(row => row.id > variables.lastId).slice(0, variables.first);
        data = { ...meta(false), [selected[1]]: rows };
      }
    }
    return { source, data: structuredClone(data), issues: [] };
  }
  const blocks = new Map([[String(config.block.number), { ...config.block }], [config.block.hash, { ...config.block }]]);
  function block(tag) {
    const key = typeof tag === 'string' && /^0x[\da-f]{1,10}$/i.test(tag) ? String(BigInt(tag)) : String(tag);
    assert(blocks.has(key), 'UNEXPECTED_BLOCK:' + key); return { ...blocks.get(key) };
  }
  const provider = {
    async getNetwork() { trace.rpc.push({ method: 'getNetwork' }); return { chainId: config.chainId }; },
    async getBlock(tag) { trace.rpc.push({ method: 'getBlock', tag }); return block(tag); },
    async getTransaction(txHash) { trace.rpc.push({ method: 'getTransaction', txHash }); return transactions.get(txHash) ?? null; },
    async getTransactionReceipt(txHash) { trace.rpc.push({ method: 'getTransactionReceipt', txHash }); return receipts.get(txHash) ?? null; },
    async call(transaction, tag) {
      assert(transaction.to.toLowerCase() === AUTH && block(tag).hash === config.block.hash, 'CALL_SCOPE');
      const decoded = authority.parseTransaction(transaction); trace.rpc.push({ method: 'call', name: decoded.name, args: decoded.args.map(String), tag });
      let answer;
      if (decoded.name === 'executor') answer = [state.authorityExecutor];
      else if (decoded.name === 'orgId') answer = [orgId];
      else if (decoded.name === 'getSubject') {
        const row = subjects().find(row => row.subjectId === decoded.args[0].toString()); assert(row, 'EXACT_SUBJECT');
        answer = [{ kind: row.kind === 'Role' ? 0 : 1, name: row.name, metadataCID: row.metadataCID, imageURI: row.imageURI, maxMembers: row.maxMembers, exists: true }];
      } else if (decoded.name === 'memberCount') { assert(subjects().some(row => row.subjectId === decoded.args[0].toString()), 'CAPACITY_SUBJECT'); answer = ['0']; }
      else if (decoded.name === 'userSubjects') { assert(decoded.args[0].toLowerCase() === account, 'HOLDER_ACCOUNT'); answer = [[ids.initial]]; }
      else if (decoded.name === 'getStatus') { assert(decoded.args[0].toString() === ids.actual && decoded.args[1].toLowerCase() === account, 'HOLDER_STATUS'); answer = [false, false, 0, 0]; }
      else throw new Error('FIXTURE:UNEXPECTED_CALL:' + decoded.name);
      return authority.encodeFunctionResult(decoded.signature, answer);
    },
  };
  const sources = { indexed: { endpoint: config.indexedEndpoint, query }, rpc: { endpoint: config.rpcEndpoint, provider }, now: () => state.now };
  const client = { async query(document, variables, chainId) {
    assert(chainId === config.chainId && variables.id === orgId, 'ORG_READ_SCOPE');
    assert([authorityDocs.FETCH_ORG_AUTHORITY, FETCH_ORG_BY_ID].includes(document), 'ORG_DOCUMENT');
    return { organization: structuredClone(organization()) };
  } };
  async function publishDocument(document) {
    assert(document.digest === ethers.utils.keccak256(ethers.utils.toUtf8Bytes(document.json)), 'EXACT_REVIEWED_BYTES');
    trace.publications.push({ ...document, cid: config.cid }); return { cid: config.cid };
  }
  async function publishProposalDocument(json) { trace.publications.push({ key: 'proposal', json, cid: config.cid }); return { cid: config.cid }; }
  function log(iface, address, name, args, tx) {
    return { ...iface.encodeEventLog(iface.getEvent(name), args), address, transactionHash: tx.hash, blockNumber: tx.blockNumber, blockHash: tx.blockHash, removed: false, logIndex: 0, transactionIndex: 0 };
  }
  async function send(encoded, stage) {
    assert(['creation', 'configuration'].includes(stage) && !trace.sends.some(row => row.stage === stage), 'DUPLICATE_STAGE_SEND');
    const decoded = voting.parseTransaction({ data: encoded.data });
    assert(encoded.to.toLowerCase() === HV && encoded.value === '0' && decoded.name === 'createProposal', 'PROPOSAL_ENVELOPE');
    const proposalId = config[stage + 'ProposalId'], txHash = hash(stage === 'creation' ? '6' : 'b'), execHash = hash(stage === 'creation' ? '7' : 'c');
    const inclusion = { number: config.block.number + 1, hash: hash(stage === 'creation' ? '9' : 'd'), timestamp: config.block.timestamp + 1 };
    const executionBlock = { number: config.block.number + 5, hash: hash(stage === 'creation' ? 'a' : 'e'), timestamp: config.block.timestamp + 4 };
    for (const b of [inclusion, executionBlock]) { blocks.set(String(b.number), b); blocks.set(b.hash, b); }
    const tx = { hash: txHash, to: HV, from: account, nonce: stage === 'creation' ? 0 : 1, chainId: config.chainId, blockNumber: inclusion.number, blockHash: inclusion.hash, value: ethers.constants.Zero, data: encoded.data };
    const execution = { hash: execHash, to: HV, from: '0x' + '99'.repeat(20), nonce: 1, chainId: config.chainId, blockNumber: executionBlock.number, blockHash: executionBlock.hash, value: ethers.constants.Zero, data: voting.encodeFunctionData('announceWinner', [proposalId]) };
    transactions.set(txHash, tx); transactions.set(execHash, execution);
    const batch = decoded.args.batches[0];
    const receipt = { status: 1, transactionHash: txHash, blockNumber: inclusion.number, blockHash: inclusion.hash, logs: [log(voting, HV, 'NewProposal', [proposalId, decoded.args.title, decoded.args.descriptionHash, 2, 1600, 950], tx)] };
    receipts.set(txHash, receipt);
    const logs = [];
    if (stage === 'creation') {
      assert(batch.length === 1, 'STAGED_CREATE_ONLY');
      const create = authority.parseTransaction({ data: batch[0].data });
      assert(create.name === 'createRole' && create.args[0] === config.name && create.args[3].toString() === config.maxMembers, 'CREATE_CAP_AND_NAME');
      logs.push(log(authority, AUTH, 'SubjectCreated', [ids.actual, 0, config.name, create.args[1], config.maxMembers], execution)); state.created = true;
    } else state.configured = true;
    batch.forEach((call, i) => logs.push(log(executor, EXEC, 'CallExecuted', [proposalId, i, call.target, call.value], execution)));
    logs.push(log(executor, EXEC, 'BatchExecuted', [proposalId, batch.length], execution), log(voting, HV, 'ProposalExecuted', [proposalId, 0, batch.length], execution));
    logs.forEach((row, i) => row.logIndex = i);
    receipts.set(execHash, { status: 1, transactionHash: execHash, blockNumber: executionBlock.number, blockHash: executionBlock.hash, logs });
    proposals.set(HV + '-' + proposalId, { id: HV + '-' + proposalId, proposalId, transactionHash: txHash, createdAtBlock: String(inclusion.number), wasExecuted: true,
      executionFailed: false, isValid: true, winningOption: '0', status: 'Executed', hybridVoting: { id: HV, organization: { id: orgId } },
      batchExecutions: [{ proposalId, callCount: String(batch.length), transactionHash: execHash, executedAtBlock: String(executionBlock.number), executor: { id: EXEC } }] });
    trace.sends.push({ stage, ...encoded, txHash });
    Object.assign(config.block, { number: config.block.number + 10, hash: hash(stage === 'creation' ? 'f' : '1'), timestamp: config.block.timestamp + 5 });
    state.now = config.block.timestamp + 1;
    blocks.set(String(config.block.number), { ...config.block }); blocks.set(config.block.hash, { ...config.block });
    if (stage === 'creation') throw new Error('SYNTHETIC_LOST_ACKNOWLEDGMENT');
    return txHash;
  }
  const recoveryTransaction = tx => tx && ({ ...tx, value: tx.value.toString() });
  const recoveryReaders = { getChainId: async () => config.chainId,
    getTransaction: async hash => recoveryTransaction(await provider.getTransaction(hash)), getTransactionReceipt: provider.getTransactionReceipt,
    getBlock: provider.getBlock, getBlockNumber: async () => config.block.number,
    async getBlockTransactions(number) { return [...transactions.values()].filter(tx => String(tx.blockNumber) === number).map(recoveryTransaction); } };
  return { config, scope, sources, client, ids, state, trace, request, authority, query, publishDocument, publishProposalDocument,
    send, recoveryReaders, permissionKey: AUTHORITY_KEYS.TM_PERMS, projectContext: projectContext('0'), zero };
}
