import { ethers } from 'ethers';
import { getAbi } from '../contracts';
import { requireRawUint } from '../amounts';
import { assertPlanScope, assertSourceBlock, PlanScope, requireCompleteSnapshot, SourceRef, SourceSnapshot } from '../data/facts';
import { ProtocolQuery, readIndexedSingletonFacts } from '../reads/protocol';
import { decodeCanonicalCall, ExactOperationIdentity, ExactTransactionExecution, exactTransactionCall, ProvenanceFreshness, ProvenanceProvider, readCanonicalTransaction } from '../reads/provenance';
import { normalizeSubjectId } from '../authority/ids';
import { ExecutionCall } from '../tx/governance';

const DOCUMENT = `query RoleContinuation($orgId: ID!, $id: String!, $block: Block_height) {
  _meta(block: $block) { block { number hash timestamp } }
  organization(id: $orgId, block: $block) { id membershipAuthority { id } hybridVoting { id } executorContract { id } }
  proposals(first: 1, where: {id: $id}, block: $block) {
    id proposalId transactionHash createdAtBlock wasExecuted executionFailed isValid winningOption status
    hybridVoting { id organization { id } }
    batchExecutions(first: 2) { proposalId callCount transactionHash executedAtBlock executor { id } }
  }
}`;
export interface RoleContinuationInput {
  scope: PlanScope & { orgId: string; contract: string; account: string;
    contracts: { membershipAuthority: string; hybridVoting: string; executor: string } };
  source: SourceRef; rpcSource: SourceRef; query: ProtocolQuery; provider: ProvenanceProvider;
  creationTransactionHash: string; proposalId?: string; creationCall: ExecutionCall;
  /** Optional exact identity retained by the unsigned transport journal. */
  creationOperation?: ExactOperationIdentity;
  /** Independent identity: announceWinner may use another account or bundle. */
  executionOperation?: ExactOperationIdentity;
  subjects: SourceSnapshot<readonly { subjectId: string; kind: 'Role' | 'Group' }[]>;
  freshness: ProvenanceFreshness;
}
export type RoleContinuationResult = { proposalId: string; creationTransactionHash: string } & (
  { state: 'pending' | 'failed' | 'rejected' } |
  { state: 'created'; subjectId: string; executionTransactionHash: string });
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// Intent selection uses calldata only; proposal/receipt/index checks remain independent.
// Titles and timing are deliberately not guesses about the intended operation: if the
// same account submits the same batch twice, exact operation identity is required.
function matchesProposalBatch(data: string, voting: ethers.utils.Interface, batch: readonly ExecutionCall[]): boolean {
  try {
    const parsed = decodeCanonicalCall(voting, data), args = parsed.args;
    return ['createProposal', 'createProposalV2'].includes(parsed.name) && args.numOptions === 2
      && args.batches.length === 2 && args.batches[1].length === 0 && args.batches[0].length === batch.length
      && args.batches[0].every((row: ethers.utils.Result, i: number) => same(row.target, batch[i].target)
        && row.value.eq(batch[i].value) && same(row.data, batch[i].calldata));
  } catch { return false; }
}

/** Exact, bounded continuation proof. Saved drafts/IDs are lookup hints only. Checks the
 * original account/call, canonical creation and execution receipts, exact proposal/executor
 * association and a fresh indexed subject. Never selects by name, sequence or recent history.
 * Throws while evidence is unavailable; pending/failed/rejected are positively observed states.
 */
export async function readRoleContinuation(input: RoleContinuationInput): Promise<RoleContinuationResult> {
  const { scope, source, rpcSource, freshness, provider } = input;
  if (!scope.orgId || !ethers.utils.isAddress(scope.account) || BigInt(scope.account) === 0n
    || !same(scope.contract, scope.contracts.membershipAuthority)) throw new Error('ROLE_CONTINUATION_SCOPE_REQUIRED');
  for (const address of Object.values(scope.contracts)) if (!ethers.utils.isAddress(address) || BigInt(address) === 0n) throw new Error('ROLE_CONTINUATION_SCOPE_REQUIRED');
  assertPlanScope(source, scope); assertPlanScope(rpcSource, scope); assertSourceBlock(source.block, rpcSource.block!);
  const subjects = requireCompleteSnapshot(input.subjects, { scope: { chainId: scope.chainId, orgId: scope.orgId,
    contract: scope.contract }, indexed: true, snapshot: 'pinned', block: source.block });
  const authority = new ethers.utils.Interface(getAbi('MembershipAuthority'));
  const voting = new ethers.utils.Interface(getAbi('HybridVotingNew'));
  const executor = new ethers.utils.Interface(getAbi('Executor'));
  const expected = input.creationCall;
  if (!same(expected.target, scope.contract) || !ethers.BigNumber.from(expected.value).isZero()) throw new Error('EXACT_ROLE_CREATION_CALL_REQUIRED');
  const create = decodeCanonicalCall(authority, expected.calldata);
  if (!['createRole', 'createGroup'].includes(create.name)) throw new Error('EXACT_ROLE_CREATION_CALL_REQUIRED');
  const creation = (await readCanonicalTransaction({ source: rpcSource, provider,
    transactionHash: input.creationTransactionHash, freshness })).data;
  const call = exactTransactionCall(creation, scope.chainId, { ...input.creationOperation,
    sender: input.creationOperation?.sender ?? scope.account, target: scope.contracts.hybridVoting,
    matchesCall: call => same(call.caller, scope.account) && matchesProposalBatch(call.data, voting, [expected]) });
  if (call.operationStatus !== 'succeeded' || !same(call.caller, scope.account)
    || !same(call.target, scope.contracts.hybridVoting)) throw new Error('ROLE_CREATION_ACCOUNT_OR_TARGET_MISMATCH');
  const proposal = decodeCanonicalCall(voting, call.data);
  if (!['createProposal', 'createProposalV2'].includes(proposal.name)) throw new Error('EXACT_ROLE_PROPOSAL_REQUIRED');
  const args = proposal.args;
  if (args.numOptions !== 2 || args.batches.length !== 2 || args.batches[0].length !== 1 || args.batches[1].length !== 0
    || !same(args.batches[0][0].target, expected.target) || !args.batches[0][0].value.isZero()
    || !same(args.batches[0][0].data, expected.calldata)) throw new Error('ROLE_CREATION_BATCH_MISMATCH');
  const logs = (tx: ExactTransactionExecution, iface: ethers.utils.Interface, emitter: string, name: string) => tx.logs.filter(log =>
    same(log.address, emitter) && same(log.topics[0], iface.getEventTopic(name))).map(log => {
    const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    const encoded = iface.encodeEventLog(parsed.signature, parsed.args);
    if (!same(encoded.data, log.data) || encoded.topics.length !== log.topics.length
      || encoded.topics.some((topic, i) => !same(topic, log.topics[i]))) throw new Error('NONCANONICAL_CONTINUATION_EVENT');
    return parsed.args;
  });
  const eventName = args.hatIds.length ? 'NewHatProposal' : 'NewProposal';
  const events = logs(call, voting, scope.contracts.hybridVoting, eventName);
  const otherEvents = logs(call, voting, scope.contracts.hybridVoting, args.hatIds.length ? 'NewProposal' : 'NewHatProposal');
  if (events.length !== 1 || otherEvents.length || !same(events[0].title, args.title)
    || !same(events[0].descriptionHash, args.descriptionHash) || events[0].numOptions !== 2
    || (args.hatIds.length && (events[0].hatIds.length !== args.hatIds.length
      || events[0].hatIds.some((id: ethers.BigNumber, i: number) => !id.eq(args.hatIds[i]))))) throw new Error('EXACT_ROLE_PROPOSAL_EVENT_REQUIRED');
  const proposalId = events[0].id.toString();
  if (input.proposalId !== undefined && requireRawUint(input.proposalId) !== proposalId) throw new Error('ROLE_PROPOSAL_ID_MISMATCH');
  const id = `${scope.contracts.hybridVoting.toLowerCase()}-${proposalId}`;
  const indexed = await readIndexedSingletonFacts(source, input.query, DOCUMENT, { orgId: scope.orgId, id }, ['proposals'], { proposals: id });
  const data = requireCompleteSnapshot(indexed, { scope, indexed: true, snapshot: 'pinned', block: source.block }) as any;
  const org = data.organization, rows = data.proposals;
  if (!same(org?.id, scope.orgId) || !same(org?.membershipAuthority?.id, scope.contract)
    || !same(org?.executorContract?.id, scope.contracts.executor) || !same(org?.hybridVoting?.id, scope.contracts.hybridVoting)
    || rows?.length !== 1) throw new Error('ROLE_CONTINUATION_BINDING_MISMATCH');
  const row = rows[0];
  if (row.proposalId !== proposalId || !same(row.hybridVoting?.id, scope.contracts.hybridVoting)
    || !same(row.hybridVoting?.organization?.id, scope.orgId) || !same(row.transactionHash, creation.transactionHash)
    || requireRawUint(row.createdAtBlock) !== creation.inclusion.number) throw new Error('ROLE_CONTINUATION_PROPOSAL_MISMATCH');
  const base = { proposalId, creationTransactionHash: creation.transactionHash };
  if (row.executionFailed === true) return { ...base, state: 'failed' };
  if (row.isValid === false || (row.winningOption != null && requireRawUint(row.winningOption) !== '0')) return { ...base, state: 'rejected' };
  if (row.wasExecuted === false) return { ...base, state: 'pending' };
  if (row.wasExecuted !== true || row.executionFailed !== false || row.isValid !== true || row.winningOption !== '0'
    || row.batchExecutions?.length !== 1) throw new Error('ROLE_EXECUTION_EVIDENCE_UNAVAILABLE');
  const batch = row.batchExecutions[0];
  if (batch.proposalId !== proposalId || requireRawUint(batch.callCount) !== '1'
    || !same(batch.executor?.id, scope.contracts.executor)) throw new Error('ROLE_EXECUTION_ASSOCIATION_MISMATCH');
  const executed = (await readCanonicalTransaction({ source: rpcSource, provider,
    transactionHash: batch.transactionHash, freshness })).data;
  if (executed.inclusion.number !== requireRawUint(batch.executedAtBlock)) throw new Error('ROLE_EXECUTION_BLOCK_MISMATCH');
  const executionCall = exactTransactionCall(executed, scope.chainId, { ...input.executionOperation,
    target: scope.contracts.hybridVoting, data: voting.encodeFunctionData('announceWinner', [proposalId]) });
  if (executionCall.operationStatus !== 'succeeded' || !same(executionCall.target, scope.contracts.hybridVoting)) throw new Error('EXACT_ROLE_EXECUTION_REQUIRED');
  const announced = decodeCanonicalCall(voting, executionCall.data);
  if (announced.name !== 'announceWinner' || announced.args[0].toString() !== proposalId) throw new Error('EXACT_ROLE_EXECUTION_REQUIRED');
  const successes = logs(executionCall, voting, scope.contracts.hybridVoting, 'ProposalExecuted');
  const batches = logs(executionCall, executor, scope.contracts.executor, 'BatchExecuted');
  const calls = logs(executionCall, executor, scope.contracts.executor, 'CallExecuted');
  const created = logs(executionCall, authority, scope.contract, 'SubjectCreated');
  if (logs(executionCall, voting, scope.contracts.hybridVoting, 'ProposalExecutionFailed').length || successes.length !== 1
    || successes[0].id.toString() !== proposalId || !successes[0].winningIdx.isZero() || !successes[0].numCalls.eq(1)
    || batches.length !== 1 || batches[0].proposalId.toString() !== proposalId || !batches[0].calls.eq(1)
    || calls.length !== 1 || calls[0].proposalId.toString() !== proposalId || !calls[0].index.isZero()
    || !same(calls[0].target, scope.contract) || !calls[0].value.isZero() || created.length !== 1) throw new Error('EXACT_ROLE_EXECUTION_EVENTS_REQUIRED');
  const subject = created[0], kind = create.name === 'createRole' ? 'Role' : 'Group';
  const subjectId = normalizeSubjectId(subject.subjectId.toString());
  if (subject.kind !== (kind === 'Role' ? 0 : 1) || subject.name !== create.args[0]
    || !same(subject.metadataCID, create.args[1]) || !ethers.BigNumber.from(subject.maxMembers).eq(kind === 'Role' ? create.args[3] : 0)
    || !subjects.some(s => normalizeSubjectId(s.subjectId) === subjectId && s.kind === kind)) throw new Error('FRESH_CREATED_SUBJECT_REQUIRED');
  return { ...base, state: 'created', subjectId, executionTransactionHash: executed.transactionHash };
}

export interface RoleConfigurationOutcomeInput extends Omit<RoleContinuationInput, 'creationCall' | 'subjects'> {
  batch: readonly ExecutionCall[];
}
export interface RoleConfigurationOutcome {
  state: 'pending' | 'failed' | 'rejected' | 'executed'; proposalId: string; creationTransactionHash: string;
}
/** Read-only reconciliation of the separate configuration vote. An unknown transport
 * outcome never authorizes resend; known failed/rejected execution permits a new review. */
export async function readRoleConfigurationOutcome(input: RoleConfigurationOutcomeInput): Promise<RoleConfigurationOutcome> {
  const { scope, source, rpcSource, provider, freshness, batch } = input;
  assertPlanScope(source, scope); assertPlanScope(rpcSource, scope); assertSourceBlock(source.block, rpcSource.block!);
  if (!batch.length || batch.length > 20) throw new Error('EXACT_ROLE_CONFIGURATION_BATCH_REQUIRED');
  const voting = new ethers.utils.Interface(getAbi('HybridVotingNew')), executor = new ethers.utils.Interface(getAbi('Executor'));
  const transaction = (await readCanonicalTransaction({ source: rpcSource, provider, transactionHash: input.creationTransactionHash, freshness })).data;
  const call = exactTransactionCall(transaction, scope.chainId, { ...input.creationOperation,
    sender: input.creationOperation?.sender ?? scope.account, target: scope.contracts.hybridVoting,
    matchesCall: call => same(call.caller, scope.account) && matchesProposalBatch(call.data, voting, batch) });
  if (call.operationStatus !== 'succeeded' || !same(call.caller, scope.account) || !same(call.target, scope.contracts.hybridVoting)) throw new Error('ROLE_CONFIGURATION_ACCOUNT_OR_TARGET_MISMATCH');
  const parsed = decodeCanonicalCall(voting, call.data);
  if (!['createProposal', 'createProposalV2'].includes(parsed.name) || parsed.args.numOptions !== 2
    || parsed.args.batches.length !== 2 || parsed.args.batches[1].length !== 0 || parsed.args.batches[0].length !== batch.length
    || parsed.args.batches[0].some((row: ethers.utils.Result, i: number) => !same(row.target, batch[i].target)
      || !row.value.eq(batch[i].value) || !same(row.data, batch[i].calldata))) throw new Error('ROLE_CONFIGURATION_BATCH_MISMATCH');
  const logs = (tx: ExactTransactionExecution, iface: ethers.utils.Interface, address: string, name: string) => tx.logs.filter(log =>
    same(log.address, address) && same(log.topics[0], iface.getEventTopic(name))).map(log => {
    const event = iface.parseLog({ topics: [...log.topics], data: log.data }), encoded = iface.encodeEventLog(event.signature, event.args);
    if (!same(encoded.data, log.data) || encoded.topics.length !== log.topics.length
      || encoded.topics.some((topic, i) => !same(topic, log.topics[i]))) throw new Error('NONCANONICAL_CONTINUATION_EVENT');
    return event.args;
  });
  const restricted = parsed.args.hatIds.length > 0;
  const events = logs(call, voting, scope.contracts.hybridVoting, restricted ? 'NewHatProposal' : 'NewProposal');
  if (events.length !== 1 || logs(call, voting, scope.contracts.hybridVoting, restricted ? 'NewProposal' : 'NewHatProposal').length
    || !same(events[0].title, parsed.args.title) || !same(events[0].descriptionHash, parsed.args.descriptionHash)
    || events[0].numOptions !== 2 || (restricted && (events[0].hatIds.length !== parsed.args.hatIds.length
      || events[0].hatIds.some((id: ethers.BigNumber, i: number) => !id.eq(parsed.args.hatIds[i]))))) throw new Error('EXACT_ROLE_PROPOSAL_EVENT_REQUIRED');
  const proposalId = events[0].id.toString();
  if (input.proposalId !== undefined && requireRawUint(input.proposalId) !== proposalId) throw new Error('ROLE_PROPOSAL_ID_MISMATCH');
  const id = `${scope.contracts.hybridVoting.toLowerCase()}-${proposalId}`;
  const indexed = await readIndexedSingletonFacts(source, input.query, DOCUMENT, { orgId: scope.orgId, id }, ['proposals'], { proposals: id });
  const data = requireCompleteSnapshot(indexed, { scope, indexed: true, snapshot: 'pinned', block: source.block }) as any;
  const org = data.organization, rows = data.proposals;
  if (!same(org?.id, scope.orgId) || !same(org?.membershipAuthority?.id, scope.contract)
    || !same(org?.executorContract?.id, scope.contracts.executor) || !same(org?.hybridVoting?.id, scope.contracts.hybridVoting)
    || rows?.length !== 1) throw new Error('ROLE_CONTINUATION_BINDING_MISMATCH');
  const row = rows[0], base = { proposalId, creationTransactionHash: transaction.transactionHash };
  if (row.proposalId !== proposalId || !same(row.hybridVoting?.id, scope.contracts.hybridVoting)
    || !same(row.hybridVoting?.organization?.id, scope.orgId) || !same(row.transactionHash, transaction.transactionHash)
    || requireRawUint(row.createdAtBlock) !== transaction.inclusion.number) throw new Error('ROLE_CONTINUATION_PROPOSAL_MISMATCH');
  if (row.executionFailed === true) return { ...base, state: 'failed' };
  if (row.isValid === false || (row.winningOption != null && requireRawUint(row.winningOption) !== '0')) return { ...base, state: 'rejected' };
  if (row.wasExecuted === false) return { ...base, state: 'pending' };
  if (row.wasExecuted !== true || row.executionFailed !== false || row.isValid !== true || row.winningOption !== '0'
    || row.batchExecutions?.length !== 1) throw new Error('ROLE_EXECUTION_EVIDENCE_UNAVAILABLE');
  const execution = row.batchExecutions[0];
  if (execution.proposalId !== proposalId || requireRawUint(execution.callCount) !== String(batch.length)
    || !same(execution.executor?.id, scope.contracts.executor)) throw new Error('ROLE_EXECUTION_ASSOCIATION_MISMATCH');
  const executed = (await readCanonicalTransaction({ source: rpcSource, provider, transactionHash: execution.transactionHash, freshness })).data;
  const executedCall = exactTransactionCall(executed, scope.chainId, { ...input.executionOperation,
    target: scope.contracts.hybridVoting, data: voting.encodeFunctionData('announceWinner', [proposalId]) });
  if (executed.inclusion.number !== requireRawUint(execution.executedAtBlock) || executedCall.operationStatus !== 'succeeded'
    || !same(executedCall.target, scope.contracts.hybridVoting)) throw new Error('EXACT_ROLE_EXECUTION_REQUIRED');
  const announced = decodeCanonicalCall(voting, executedCall.data);
  if (announced.name !== 'announceWinner' || announced.args[0].toString() !== proposalId) throw new Error('EXACT_ROLE_EXECUTION_REQUIRED');
  const success = logs(executedCall, voting, scope.contracts.hybridVoting, 'ProposalExecuted');
  const batches = logs(executedCall, executor, scope.contracts.executor, 'BatchExecuted');
  const calls = logs(executedCall, executor, scope.contracts.executor, 'CallExecuted');
  if (logs(executedCall, voting, scope.contracts.hybridVoting, 'ProposalExecutionFailed').length || success.length !== 1
    || success[0].id.toString() !== proposalId || !success[0].winningIdx.isZero() || !success[0].numCalls.eq(batch.length)
    || batches.length !== 1 || batches[0].proposalId.toString() !== proposalId || !batches[0].calls.eq(batch.length)
    || calls.length !== batch.length || calls.some((call, i) => call.proposalId.toString() !== proposalId
      || !call.index.eq(i) || !same(call.target, batch[i].target) || !call.value.eq(batch[i].value))) throw new Error('EXACT_ROLE_EXECUTION_EVENTS_REQUIRED');
  return { ...base, state: 'executed' };
}
