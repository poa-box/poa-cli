/** SYNTHETIC ONLY: real core/controller/EOA adapter, fake reads and fake wallet
 * transport. This memory journal demonstrates reloading handles, not disk durability. */
import { ethers } from 'ethers';
import { getAbi } from '@poa-box/core/contracts';
import { bytes32ToCidV0 } from '@poa-box/core/encoding/cid';
import { createRoleWorkflow } from './workflow.mjs';
import { createEthersWalletAdapter } from './adapters/ethers-wallet.mjs';
import { createFixture } from './adapters/fixture.mjs';

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
export function createSyntheticJournal(control = {}) {
  let envelope = null, held = false;
  return { async withAccountLock(scope, run) {
    if (held) throw new Error('ACCOUNT_ACTION_IN_PROGRESS'); held = true; let active = true;
    try { return await run({ async read() { if (!active) throw new Error('JOURNAL_SESSION_EXPIRED'); return clone(envelope); },
      async compareAndSwap(expected, data) {
        if (!active || JSON.stringify(expected) !== JSON.stringify(envelope)) throw new Error('STALE_JOURNAL_OWNER');
        await control.beforeWrite?.(data);
        const next = { version: 1, scope: clone(scope), revision: envelope ? envelope.revision + 1 : 0, data: clone(data) };
        envelope = next; await control.afterWrite?.(data); return clone(next);
      } });
    } finally { active = false; held = false; }
  } };
}
export function createWorkflowFixture(config, { journal: suppliedJournal } = {}) {
  const adapter = createFixture(clone(config));
  const control = { current: true, chainId: adapter.scope.chainId, account: adapter.scope.account,
    approvePublish: true, approveSend: true, approvals: [], publicationLost: false, publications: [], documents: new Map(), beforeWrite: null, afterWrite: null };
  const originalCall = adapter.sources.rpc.provider.call;
  const hybrid = new ethers.utils.Interface(getAbi('HybridVotingNew'));
  adapter.sources.rpc.provider.call = async (transaction, tag) => {
    if (transaction.to.toLowerCase() !== adapter.scope.contracts.hybridVoting.toLowerCase()) return originalCall(transaction, tag);
    const parsed = hybrid.parseTransaction(transaction);
    if (parsed.name === 'executor') return hybrid.encodeFunctionResult(parsed.name, [adapter.scope.contracts.executor]);
    if (parsed.name === 'getClasses') return hybrid.encodeFunctionResult(parsed.name, [[{ strategy: 0, slicePct: 100,
      quadratic: false, minBalance: '0', asset: ethers.constants.AddressZero, hatIds: [] }]]);
    throw new Error('UNEXPECTED_SYNTHETIC_HYBRID_READ');
  };
  const provider = { ...adapter.sources.rpc.provider, async getNetwork() { return { chainId: control.chainId }; },
    async getBlockNumber() { return adapter.config.block.number; }, async getBlockWithTransactions(number) {
      return { transactions: await adapter.recoveryReaders.getBlockTransactions(String(number)) };
    } };
  const signer = { provider, async estimateGas() { return ethers.BigNumber.from(21000); }, async getAddress() { return control.account; }, async getTransactionCount() { return adapter.trace.sends.length; },
    async sendTransaction(transaction) {
      const stage = adapter.trace.sends.length ? 'configuration' : 'creation';
      const txHash = await adapter.send({ to: transaction.to, data: transaction.data, value: transaction.value }, stage);
      return { hash: txHash };
    } };
  const wallet = createEthersWalletAdapter({ signer, provider, dispatchPopulatedTransaction: transaction => signer.sendTransaction(transaction) });
  const journal = suppliedJournal ?? createSyntheticJournal(control);
  const documents = { async fetch(cid) { return clone(control.documents.get(cid)) ?? null; }, async publish(document) {
    // Deliberately fake CID adapter attestation, never a real IPFS publication.
    const cid = bytes32ToCidV0(ethers.utils.id(document.json));
    control.documents.set(cid, JSON.parse(document.json)); control.publications.push({ ...clone(document), cid });
    await control.afterPublication?.(document);
    if (control.publicationLost) throw new Error('SYNTHETIC_PUBLICATION_ACK_LOST');
    return { cid };
  } };
  const create = (workflowId = 'synthetic-role', ports = {}) => createRoleWorkflow({ workflowId, scope: adapter.scope, sources: adapter.sources,
    wallet, journal: ports.journal ?? journal, documents, isCurrent: () => control.current, confirm: async approval => {
      control.approvals.push(clone(approval)); await control.beforeApproval?.(approval); return approval.kind === 'publish' ? control.approvePublish : control.approveSend;
    } });
  return { adapter, control, wallet, journal, documents, create };
}
const requireState = (observed, state) => { if (observed.status !== state) throw new Error('SYNTHETIC_WORKFLOW_FAILED:' + JSON.stringify(observed)); return observed.data; };
export async function runWorkflowFixture(config) {
  const host = createWorkflowFixture(config), proposal = { title: 'Synthetic reviewed role', description: 'SYNTHETIC: no real publication or transaction', durationMinutes: '1440' };
  let workflow = host.create();
  const capabilities = await workflow.capabilities({ ...host.adapter.request, role: { ...host.adapter.request.role, name: '' } }); requireState(capabilities, 'ready');
  const review = requireState(await workflow.review(host.adapter.request), 'ready');
  const prepared = requireState(await workflow.prepare({ review, proposal }), 'ready');
  const uncertain = await workflow.submit({ prepared }); requireState(uncertain, 'unknown');
  workflow = host.create(); // Fresh controller; opaque reviews/preparations are gone.
  const creation = requireState(await workflow.recover(), 'confirmed');
  const continuation = requireState(await workflow.continuation(), 'ready');
  const nextReview = requireState(await workflow.review(continuation.request), 'ready');
  const nextPrepared = requireState(await workflow.prepare({ review: nextReview, proposal }), 'ready');
  const pending = await workflow.submit({ prepared: nextPrepared }); requireState(pending, 'pending');
  const outcome = requireState(await host.create().recover(), 'confirmed');
  return { synthetic: true, label: config.label, journal: 'SYNTHETIC in-memory port; real host uses durable IndexedDB/Web Locks adapter',
    workflowId: 'synthetic-role', states: ['capabilities:ready', 'review:ready', 'prepare:ready', 'submit:unknown', 'reload/recover:confirmed',
      'continuation:ready', 'configuration/review:ready', 'configuration/prepare:ready', 'configuration/submit:pending', 'configuration/recover:confirmed'],
    actualSubjectId: creation.creation.subjectId, earlierSameNameSubjectId: host.adapter.ids.sameName,
    approvals: host.control.approvals.map(({ kind, stage }) => ({ kind, stage })),
    publications: host.control.publications.map(({ key, digest, cid }) => ({ key, digest, cid })),
    sends: host.adapter.trace.sends.map(({ stage, txHash }) => ({ stage, txHash })), complete: outcome.complete,
  };
}
