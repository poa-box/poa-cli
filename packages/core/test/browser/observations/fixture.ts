import { ethers } from 'ethers';
import { getAbi } from '../../../src/contracts';
import type { WorkflowScope } from '../../../src/workflows/types';
import { computeSelector, TM_FEATURE_FRAGMENTS } from '../../../src/version';
import { createWorkflowReaders } from '../../../src/browser/observations';
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
export const PROJECT = `0x${'77'.repeat(32)}`;
export const HASH = `0x${'ab'.repeat(32)}`;
export const scope: WorkflowScope = { chainId: 100, orgId: `0x${'cd'.repeat(32)}`, account: addr(1), contracts: {
  executor: addr(1), membershipAuthority: addr(2), hybridVoting: addr(3), directDemocracyVoting: addr(4),
  quickJoin: addr(5), accountRegistry: addr(6), passkeyFactory: addr(7), taskManager: addr(8),
} };
export function fixture(limits = {}) {
  const state = { now: 1000, rpcChain: 100, hash: HASH, indexHash: HASH, indexTime: 1000, rpcTime: 1000, latest: 100,
    mismatchFinal: false, missingTimestamp: false, outage: false, indexErrors: false, moduleMismatch: false,
    calls: [] as { contract: string; name: string; args: unknown[]; block: number; from?: string; value?: string; data: string }[],
    queries: [] as { document: string; variables: Record<string, unknown> }[],
    pages: {} as Record<string, unknown[][]>, alreadyVoted: false,
    createdAt: '900', terminalPageMismatch: false, terminalIndexErrors: false, missingOptions: false, taskStatus: 'Open', rpcTaskStatus: undefined as number | undefined, missingDeadline: false, nullAssignee: false, legacyFeature: false, featureOutage: false, ambiguousProxy: false,
    simulation: 'success' as 'success' | 'revert' | 'outage', rpcBlocks: 0,
  };
  const meta = () => ({ hasIndexingErrors: state.indexErrors, block: { number: 100, hash: state.indexHash,
    ...(state.missingTimestamp ? {} : { timestamp: state.indexTime }) } });
  const parent = (hybrid: boolean) => ({ id: `${scope.contracts[hybrid ? 'hybridVoting' : 'directDemocracyVoting']}-1`, proposalId: '1', numOptions: state.missingOptions ? undefined : 2, createdAtBlock: '90',
    [hybrid ? 'hybridVoting' : 'directDemocracyVoting']: { id: scope.contracts[hybrid ? 'hybridVoting' : 'directDemocracyVoting'], organization: { id: scope.orgId } } });
  const org = () => ({ id: scope.orgId, executorContract: { id: scope.contracts.executor },
    membershipAuthority: { id: scope.contracts.membershipAuthority, executor: scope.contracts.executor,
      isRouterBound: true, cutoverAt: '1', paused: false, subjectCount: '0', roleSubjectCount: '0', groupSubjectCount: '0', acceptedMembershipCount: '0' },
    hybridVoting: { id: state.moduleMismatch ? addr(99) : scope.contracts.hybridVoting }, directDemocracyVoting: { id: scope.contracts.directDemocracyVoting }, quickJoin: { id: scope.contracts.quickJoin }, taskManager: { id: scope.contracts.taskManager, organization: { id: scope.orgId } } });
  const query = async (document: string, variables: Record<string, unknown>) => {
    state.queries.push({ document, variables });
    if (state.outage) throw new Error('SYNTHETIC_INDEX_OUTAGE');
    const result: Record<string, unknown> = { _meta: meta(), organization: org() };
    const project = { id: `${scope.contracts.taskManager}-${PROJECT}`, projectId: PROJECT, deleted: false,
      taskManager: { id: scope.contracts.taskManager, organization: { id: scope.orgId } } };
    const task = { id: `${scope.contracts.taskManager}-1`, taskId: '1', taskManager: scope.contracts.taskManager, project,
      status: state.taskStatus, assignee: state.nullAssignee ? null : scope.account, requiresApplication: false,
      ...(state.missingDeadline ? {} : { absoluteDeadline: '0', claimDeadline: '0' }) };
    if (document.includes('WorkflowTaskTarget')) {
      result.projects = [project]; result.tasks = variables.taskId ? [task] : [];
    } else if (document.includes('WorkflowTaskManagers')) {
      result.projectManagers = [];
    } else if (document.includes('TaskApplicationsPage')) {
      result.tasks = [task]; result.taskApplications = [];
    } else if (document.includes('FetchProposalDetail')) {
      const hybrid = String(variables.compositeId).startsWith(scope.contracts.hybridVoting);
      const proposal = { ...parent(hybrid), startTimestamp: '900', endTimestamp: '1100', isHatRestricted: false, restrictedHatIds: [], classesVersion: '1', classesChange: null };
      result.proposals = hybrid ? [proposal] : []; result.ddvproposals = hybrid ? [] : [proposal];
    } else if (document.includes('ProposalBallotsPage')) {
      const hybrid = document.includes('Hybrid'); const p = parent(hybrid);
      result[hybrid ? 'proposals' : 'ddvproposals'] = [p];
      const voter = state.alreadyVoted ? scope.account : addr(20);
      result[hybrid ? 'votes' : 'ddvvotes'] = state.pages.ballots?.[variables.cursor ? 1 : 0] ?? (!variables.cursor && state.alreadyVoted ? [{ id: `${p.id}-${voter}`, voter,
        optionIndexes: [0], optionWeights: [100], ...(hybrid ? { classRawPowers: ['100'] } : {}),
        votedAt: '950', votedAtBlock: '95', transactionHash: `0x${'de'.repeat(32)}`, proposal: p }] : []);
    } else {
      for (const field of ['subjects', 'subjectMemberships', 'groupCompositions', 'permRows', 'accessRules', 'subjectVouchRecords', 'pendingActions']) {
        if (new RegExp(`\\b${field}\\(`).test(document)) {
          const page = state.pages[field]?.[variables.lastId ? 1 : 0] ?? [];
          result[field] = page;
          if (field === 'subjects' && state.pages[field]) {
            (result.organization as ReturnType<typeof org>).membershipAuthority.subjectCount = String(state.pages[field].flat().length);
            (result.organization as ReturnType<typeof org>).membershipAuthority.roleSubjectCount = String(state.pages[field].flat().length);
          }
        }
      }
    }
    if (state.terminalIndexErrors && document.includes('ProposalBallotsPage') && variables.cursor) result._meta = { ...meta(), hasIndexingErrors: true };
    if (state.terminalPageMismatch && document.includes('ProposalBallotsPage') && variables.cursor) result._meta = { ...meta(), block: { ...meta().block, hash: `0x${'ee'.repeat(32)}` } };
    return result;
  };
  const interfaces = new Map(Object.entries(scope.contracts).flatMap(([name, contract]) => {
    const abiName = name === 'hybridVoting' ? 'HybridVotingNew' : name === 'directDemocracyVoting' ? 'DirectDemocracyVotingNew'
      : name === 'quickJoin' ? 'QuickJoinNew' : name === 'accountRegistry' ? 'UniversalAccountRegistry' : name === 'passkeyFactory' ? 'PasskeyAccountFactory' : name === 'taskManager' ? 'TaskManagerNew' : undefined;
    return abiName ? [[contract, new ethers.utils.Interface(getAbi(abiName))] as const] : [];
  }));
  const provider = {
    async getStorageAt(_address: string, _slot: string, _block: number) {
      if (state.featureOutage) throw new Error('STORAGE_UNAVAILABLE');
      return state.ambiguousProxy ? ethers.utils.hexZeroPad(scope.contracts.passkeyFactory, 32) : `0x${'00'.repeat(32)}`;
    },
    async getCode(_address: string, _block: number) {
      return state.legacyFeature ? '0x6000' : `0x63${computeSelector(TM_FEATURE_FRAGMENTS.deadlines).slice(2)}6000`;
    },
    async getNetwork() { return { chainId: state.rpcChain }; },
    async getBlock(block: number | 'latest') {
      if (block !== 'latest') state.rpcBlocks++;
      return { number: block === 'latest' ? state.latest : block, hash: state.mismatchFinal && state.rpcBlocks > 1 ? `0x${'ef'.repeat(32)}` : state.hash, timestamp: state.rpcTime };
    },
    async call(tx: { to: string; data: string; from?: string; value?: string }, block: number) {
      const iface = interfaces.get(tx.to); if (!iface) throw new Error('UNKNOWN_TEST_CONTRACT');
      let parsed: ethers.utils.TransactionDescription;
      try { parsed = iface.parseTransaction(tx); } catch {
        state.calls.push({ contract: tx.to, name: 'simulation', args: [], block, ...tx });
        if (state.simulation === 'revert') throw Object.assign(new Error('EVM_REVERT'), { code: 'CALL_EXCEPTION', data: '0x' });
        if (state.simulation === 'outage') throw Object.assign(new Error('NETWORK_OUTAGE'), { code: 'NETWORK_ERROR' });
        return '0x';
      }
      state.calls.push({ contract: tx.to, name: parsed.name, args: [...parsed.args], block, ...tx });
      if (parsed.name === 'getLensData') {
        const key = Number(parsed.args[0]);
        const status = state.rpcTaskStatus ?? ({ Open: 0, Assigned: 1, Submitted: 2, Completed: 3, Cancelled: 4 }[state.taskStatus] ?? 0);
        const raw = key === 4 ? ethers.utils.defaultAbiCoder.encode(['address'], [scope.contracts.executor])
          : key === 12 ? ethers.utils.defaultAbiCoder.encode(['address'], [scope.contracts.membershipAuthority])
          : key === 2 ? ethers.utils.defaultAbiCoder.encode(['uint128', 'uint128', 'bool'], ['100', '0', true])
          : key === 1 ? ethers.utils.defaultAbiCoder.encode(['bytes32', 'uint96', 'address', 'uint96', 'bool', 'uint8', 'address', 'uint48', 'uint32', 'uint48'],
            [PROJECT, '1', state.nullAssignee ? ethers.constants.AddressZero : scope.account, '0', false, status, ethers.constants.AddressZero, '0', '0', '0']) : undefined;
        if (!raw) throw new Error('UNKNOWN_LENS_KEY');
        return iface.encodeFunctionResult(parsed.name, [raw]);
      }
      const values: Record<string, unknown> = { paused: false, executor: scope.contracts.executor, membershipAuthority: scope.contracts.membershipAuthority,
        accountRegistry: scope.contracts.accountRegistry, universalFactory: scope.contracts.passkeyFactory, nonces: '9', getUsername: '', getAddressOfUsername: ethers.constants.AddressZero,
        getAddress: scope.account, proposalCreatedAt: state.createdAt, proposalEndTimestamp: '1100', pollRestricted: false,
        getProposalClasses: [{ strategy: 0, slicePct: 100, quadratic: false, minBalance: '0', asset: ethers.constants.AddressZero, hatIds: [] }], proposalClassSubject: '0' };
      if (!(parsed.name in values)) throw new Error('UNEXPECTED_ABI_METHOD_' + parsed.name);
      return iface.encodeFunctionResult(parsed.name, [values[parsed.name]]);
    },
  };
  const sources = { indexedEndpoint: 'indexed:observations', rpcEndpoint: 'rpc:observations', now: () => state.now };
  return { state, provider, query, sources, readers: createWorkflowReaders({ deployment: 'authority-v2', scope, sources, query, provider, limits }) };
}
