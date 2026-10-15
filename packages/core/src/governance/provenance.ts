import { ethers } from 'ethers';
import { requireRawUint } from '../amounts';
import { getAbi } from '../contracts';
import { assertPlanScope, assertSourceBlock, PlanResult, PlanScope, requireCompleteSnapshot, SourceRef, SourceSnapshot } from '../data/facts';
import type { SubjectCreationProposal } from '../authority/ids';
import { IndexedRow, ProtocolQuery, readIndexedSingletonFacts } from '../reads/protocol';
import { decodeCanonicalCall, exactTransactionCall, ProvenanceFreshness, ProvenanceProvider, readCanonicalTransaction, requireProvenanceFreshness } from '../reads/provenance';
import { validateGovernanceBatches } from './capabilities';

/** Existing serving fields only. Exact known ID, never a recent-feed lookup. */
const proposalDocument = `query RecoverSubjectCreation($orgId: ID!, $id: String!, $block: Block_height) {
  _meta(block: $block) { block { number hash } }
  organization(id: $orgId, block: $block) { id membershipAuthority { id } hybridVoting { id } }
  proposals(first: 1, where: {id: $id}, block: $block) {
    id proposalId title descriptionHash numOptions transactionHash createdAtBlock
    hybridVoting { id organization { id } }
  }
}`;
export interface VerifiedSubjectCreation {
  readonly id: string;
  readonly createsSubject: boolean;
  /** Calls describe intent, not an allocated ID or a successful execution. */
  readonly creations: readonly { optionIndex: number; callIndex: number; kind: 'Role' | 'Group' }[];
  readonly transactionHash: string;
  readonly calldataHash: string;
  readonly indexedSource: SourceRef;
  readonly receiptBlock: { number: string; hash: string };
}
const proofs = new WeakSet<object>();
function blocked<T>(error: unknown): PlanResult<T> {
  const message = error instanceof Error ? error.message : '';
  const code = /^[A-Z][A-Z_0-9]+$/.test(message) ? message : 'SUBJECT_CREATION_PROVENANCE_UNAVAILABLE';
  return { status: 'blocked', codes: [code], prerequisites: [{ code }], consequences: [] };
}
function same(a: unknown, b: string): boolean { return typeof a === 'string' && a.toLowerCase() === b.toLowerCase(); }
const safeAuthorityMethods = new Set(['addRoleToGroup', 'removeRoleFromGroup', 'renameSubject', 'setMaxMembers', 'setSubjectDefault',
  'setPerm', 'clearPerm', 'configureVouchAttestor', 'setManagerConfig', 'setMaxDailyVouches', 'setPaused', 'grant', 'offer', 'withdrawOffer',
  'remove', 'unremove', 'setRule', 'clearRule', 'setEmailVerified', 'clearUserVouches', 'resetVouchEpoch']);

/** Recover missing metadata markers from a canonical exact call and creation event.
 * Unknown targets/wrappers/seeding/indirect calls stay blocked: absence of a known
 * create selector is not evidence that arbitrary code cannot allocate a subject.
 */
export async function readSubjectCreationProvenance(input: {
  scope: PlanScope & { orgId: string; contract: string; contracts: { membershipAuthority: string } };
  source: SourceRef; rpcSource: SourceRef; query: ProtocolQuery; provider: ProvenanceProvider;
  proposalId: string; freshness: ProvenanceFreshness;
}): Promise<PlanResult<VerifiedSubjectCreation>> {
  try {
    const { scope, source, rpcSource } = input;
    for (const value of [scope.contract, scope.contracts.membershipAuthority]) if (!ethers.utils.isAddress(value) || BigInt(value) === 0n) throw new Error('INVALID_PROVENANCE_TARGET');
    assertPlanScope(source, scope); assertPlanScope(rpcSource, scope);
    requireProvenanceFreshness(source, input.freshness); requireProvenanceFreshness(rpcSource, input.freshness);
    assertSourceBlock(rpcSource.block, source.block!);
    const proposalId = requireRawUint(input.proposalId), id = `${scope.contract.toLowerCase()}-${proposalId}`;
    const indexed = await readIndexedSingletonFacts(source, input.query, proposalDocument, { orgId: scope.orgId, id }, ['proposals'], { proposals: id });
    const data = requireCompleteSnapshot(indexed, { scope, indexed: true, snapshot: 'pinned', block: source.block });
    const org = data.organization as { id?: string; membershipAuthority?: { id?: string }; hybridVoting?: { id?: string } } | null;
    const rows = data.proposals as IndexedRow[];
    if (!same(org?.id, scope.orgId) || !same(org?.hybridVoting?.id, scope.contract)
      || !same(org?.membershipAuthority?.id, scope.contracts.membershipAuthority) || rows.length !== 1) throw new Error('PROPOSAL_BINDING_UNPROVEN');
    const row = rows[0], module = row.hybridVoting as { id?: string; organization?: { id?: string } } | null;
    if (row.proposalId !== proposalId || !same(module?.id, scope.contract) || !same(module?.organization?.id, scope.orgId)
      || typeof row.transactionHash !== 'string' || typeof row.createdAtBlock !== 'string') throw new Error('PROPOSAL_IDENTITY_UNPROVEN');
    const tx = (await readCanonicalTransaction({ source: rpcSource, provider: input.provider, transactionHash: row.transactionHash, freshness: input.freshness })).data;
    if (tx.inclusion.number !== requireRawUint(row.createdAtBlock)) throw new Error('PROPOSAL_RECEIPT_BLOCK_MISMATCH');
    const call = exactTransactionCall(tx, scope.chainId);
    if (call.operationStatus !== 'succeeded' || !same(call.target, scope.contract)) throw new Error('PROPOSAL_CALL_TARGET_MISMATCH');
    const voting = new ethers.utils.Interface(getAbi('HybridVotingNew'));
    const parsed = decodeCanonicalCall(voting, call.data);
    if (!['createProposal', 'createProposalV2'].includes(parsed.name)) throw new Error('PROPOSAL_CREATION_CALL_REQUIRED');
    const args = parsed.args;
    if (!same(row.descriptionHash, args.descriptionHash) || row.numOptions !== args.numOptions
      || typeof row.title !== 'string' || ethers.utils.toUtf8String(args.title) !== row.title) throw new Error('PROPOSAL_CALL_IDENTITY_MISMATCH');
    const events = tx.logs.filter(log => same(log.address, scope.contract) && ['NewProposal', 'NewHatProposal'].some(name => same(log.topics[0], voting.getEventTopic(name))));
    if (events.length !== 1) throw new Error('EXACT_PROPOSAL_EVENT_REQUIRED');
    const event = voting.parseLog({ topics: [...events[0].topics], data: events[0].data });
    const encoded = voting.encodeEventLog(event.eventFragment, event.args);
    if (!same(encoded.data, events[0].data) || encoded.topics.length !== events[0].topics.length
      || encoded.topics.some((topic, i) => !same(topic, events[0].topics[i])) || event.args.id.toString() !== proposalId
      || !same(event.args.title, args.title) || !same(event.args.descriptionHash, args.descriptionHash) || event.args.numOptions !== args.numOptions
      || event.name !== (args.hatIds.length ? 'NewHatProposal' : 'NewProposal')
      || (args.hatIds.length && (event.args.hatIds.length !== args.hatIds.length || event.args.hatIds.some((v: ethers.BigNumber, i: number) => !v.eq(args.hatIds[i]))))) throw new Error('PROPOSAL_EVENT_MISMATCH');
    const batches = args.batches.map((batch: ethers.utils.Result[]) => batch.map(c => ({ target: c.target, value: c.value, calldata: c.data })));
    validateGovernanceBatches(batches, args.numOptions);
    const authority = new ethers.utils.Interface(getAbi('MembershipAuthority'));
    const creations: { optionIndex: number; callIndex: number; kind: 'Role' | 'Group' }[] = [];
    for (const [optionIndex, batch] of batches.entries()) for (const [callIndex, item] of batch.entries()) {
      if (!ethers.BigNumber.from(item.value).isZero()) throw new Error('INDIRECT_SUBJECT_ALLOCATION_UNPROVEN');
      if (same(item.target, scope.contracts.membershipAuthority)) {
        const decoded = decodeCanonicalCall(authority, item.calldata);
        if (decoded.name === 'createRole' || decoded.name === 'createGroup') creations.push({ optionIndex, callIndex, kind: decoded.name === 'createRole' ? 'Role' : 'Group' });
        else if (!safeAuthorityMethods.has(decoded.name)) throw new Error('INDIRECT_SUBJECT_ALLOCATION_UNPROVEN');
      } else if (same(item.target, scope.contract)) {
        const decoded = decodeCanonicalCall(voting, item.calldata);
        if (!['setConfig', 'setClasses', 'addHatToClass', 'removeHatFromClass', 'setClassSubject', 'pause', 'unpause'].includes(decoded.name)) throw new Error('INDIRECT_SUBJECT_ALLOCATION_UNPROVEN');
      } else throw new Error('INDIRECT_SUBJECT_ALLOCATION_UNPROVEN');
    }
    const proof: VerifiedSubjectCreation = Object.freeze({ id, createsSubject: creations.length > 0,
      creations: Object.freeze(creations.map(c => Object.freeze(c))), transactionHash: tx.transactionHash,
      calldataHash: ethers.utils.keccak256(call.data), receiptBlock: tx.inclusion,
      indexedSource: Object.freeze({ ...indexed.source, block: Object.freeze({ ...indexed.source.block! }), contracts: Object.freeze({ ...indexed.source.contracts }) }) });
    proofs.add(proof);
    return { status: 'ready', data: proof, consequences: [{ code: 'SUBJECT_CREATION_RACE', values: { executionStable: false } }] };
  } catch (error) { return blocked(error); }
}

/** Preserve the original history coverage. Unverified metadata never authorizes
 * a negative creation assertion; executed proposals keep their existing settlement.
 * Proof objects must be re-observed after reload, never trusted from saved JSON.
 */
export function recoverSubjectCreationHistory(history: SourceSnapshot<readonly SubjectCreationProposal[]>, evidence: readonly VerifiedSubjectCreation[]): SourceSnapshot<readonly SubjectCreationProposal[]> {
  requireCompleteSnapshot(history, { indexed: true, snapshot: 'pinned' });
  const byId = new Map<string, VerifiedSubjectCreation>();
  const ids = new Set(history.data.map(row => row.id));
  if (ids.size !== history.data.length) throw new Error('DUPLICATE_PROPOSAL');
  for (const proof of evidence) {
    if (!proofs.has(proof) || byId.has(proof.id) || !ids.has(proof.id)) throw new Error('SUBJECT_CREATION_PROOF_REQUIRED');
    assertPlanScope(proof.indexedSource, { chainId: history.source.chainId, orgId: history.source.orgId, contract: history.source.contract, endpoint: history.source.endpoint, contracts: history.source.contracts });
    assertSourceBlock(proof.indexedSource.block, history.source.block!);
    byId.set(proof.id, proof);
  }
  return { ...history, data: history.data.map(row => {
    const proof = byId.get(row.id);
    return { ...row, createsSubject: proof?.createsSubject, actionSummaries: undefined };
  }) };
}
