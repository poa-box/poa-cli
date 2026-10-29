import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { createRoleWorkflow } from '../src/workflow.mjs';
import { createWorkflowFixture, runWorkflowFixture } from '../src/workflow-fixture.mjs';
import { createBrowserJournal } from '../src/adapters/browser-journal.mjs';
import { browserStorageFixture } from './browser-storage-fixture.mjs';
const config = () => JSON.parse(readFileSync(new URL('../fixtures/role-workflow.v1.json', import.meta.url)));
const proposal = { title: 'Reviewed synthetic role', description: 'Synthetic only', durationMinutes: '1440' };
let originalFetch;
before(() => { originalFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('REAL_NETWORK_FORBIDDEN'); }; });
after(() => { globalThis.fetch = originalFetch; });
const ready = observed => { assert.equal(observed.status, 'ready', JSON.stringify(observed)); return observed.data; };
async function prepare(host, workflow = host.create()) {
  const review = ready(await workflow.review(host.adapter.request));
  return { workflow, review, prepared: ready(await workflow.prepare({ review, proposal })) };
}
const stage = async workflow => ready(await workflow.inspect()).stages.creation;

test('runnable synthetic controller path uses shared core APIs, separate approvals and actual-ID continuation after reload', async () => {
  const observed = await runWorkflowFixture(config());
  assert.equal(observed.synthetic, true); assert.match(observed.journal, /in-memory/);
  assert.equal(observed.complete, true); assert.notEqual(observed.actualSubjectId, observed.earlierSameNameSubjectId);
  assert.deepEqual(observed.approvals, [{ kind: 'publish', stage: 'creation' }, { kind: 'send', stage: 'creation' },
    { kind: 'publish', stage: 'configuration' }, { kind: 'send', stage: 'configuration' }]);
  assert.deepEqual(observed.sends.map(row => row.stage), ['creation', 'configuration']);
});
test('capabilities allow a blank form without publication, journal writes or executable review authority', async () => {
  const h = createWorkflowFixture(config()), w = h.create(); let writes = 0; h.control.beforeWrite = () => { writes++; };
  const evidence = ready(await w.capabilities({ ...h.adapter.request, role: { ...h.adapter.request.role, name: '' } }));
  assert.equal(evidence.purpose, 'capabilities'); assert.equal(evidence.context.data.hybrid.classes[0].classIndex, 0);
  assert.equal(writes, 0); assert.equal(h.control.approvals.length, 0); assert.equal(h.control.publications.length, 0);
  assert.equal((await w.prepare({ review: evidence, proposal })).status, 'blocked');
});
test('review never publishes or sends; a serialized review is not preparation authority', async () => {
  const h = createWorkflowFixture(config()), w = h.create(), review = ready(await w.review(h.adapter.request));
  assert.equal(Object.isFrozen(review), true); assert.equal(h.control.publications.length, 0); assert.equal(h.adapter.trace.sends.length, 0);
  assert.deepEqual((await w.prepare({ review: JSON.parse(JSON.stringify(review)), proposal })).codes, ['CURRENT_REVIEW_REQUIRED']);
});
test('publication requires an explicit approval callback and a positive answer', async () => {
  const h = createWorkflowFixture(config()); h.control.approvePublish = false;
  const w = h.create(), review = ready(await w.review(h.adapter.request));
  assert.deepEqual((await w.prepare({ review, proposal })).codes, ['APPROVAL_DECLINED']);
  assert.equal(h.control.publications.length, 0); assert.equal(h.adapter.trace.sends.length, 0);
  const absent = createRoleWorkflow({ workflowId: 'no-consent', scope: h.adapter.scope, sources: h.adapter.sources,
    wallet: h.wallet, journal: h.journal, documents: h.documents, isCurrent: () => true });
  const another = ready(await absent.review(h.adapter.request));
  assert.deepEqual((await absent.prepare({ review: another, proposal })).codes, ['EXPLICIT_APPROVAL_REQUIRED']);
  assert.equal(h.control.publications.length, 0);
});
test('invalid proposal duration is rejected before publication or its approval', async () => {
  const h = createWorkflowFixture(config()), w = h.create(), review = ready(await w.review(h.adapter.request));
  assert.notEqual((await w.prepare({ review, proposal: { ...proposal, durationMinutes: '0' } })).status, 'ready');
  assert.equal(h.control.publications.length, 0); assert.equal(h.control.approvals.length, 0);
});
test('wallet approval is separate from publication approval; declining it leaves zero dispatches', async () => {
  const h = createWorkflowFixture(config()), p = await prepare(h); h.control.approveSend = false;
  const observed = await p.workflow.submit({ prepared: p.prepared });
  assert.equal(observed.status, 'blocked'); assert.deepEqual(observed.codes, ['APPROVAL_DECLINED']);
  assert.equal(h.control.publications.length, 2); assert.equal(h.adapter.trace.sends.length, 0);
  const sendApproval = h.control.approvals.find(row => row.kind === 'send');
  assert.equal(sendApproval.call.value, '0'); assert.equal(sendApproval.scope.account, h.adapter.scope.account);
  assert.equal((await stage(p.workflow)).submission, undefined);
});
for (const changed of ['account', 'chain', 'scope', 'cancellation']) test(`changed ${changed} before preparation permits no publication`, async () => {
  const h = createWorkflowFixture(config()), w = h.create(), review = ready(await w.review(h.adapter.request)), controller = new AbortController();
  if (changed === 'account') h.control.account = '0x' + '99'.repeat(20);
  if (changed === 'chain') h.control.chainId = 1;
  if (changed === 'scope') h.control.current = false;
  if (changed === 'cancellation') controller.abort();
  assert.equal((await w.prepare({ review, proposal, signal: controller.signal })).status, 'blocked');
  assert.equal(h.control.publications.length, 0); assert.equal(h.adapter.trace.sends.length, 0);
});
test('identity changed during wallet approval is refused before a submission barrier or dispatch', async () => {
  const h = createWorkflowFixture(config()), p = await prepare(h);
  h.control.beforeApproval = approval => { if (approval.kind === 'send') h.control.account = '0x' + '99'.repeat(20); };
  const observed = await p.workflow.submit({ prepared: p.prepared });
  assert.equal(observed.status, 'blocked'); assert.equal(h.adapter.trace.sends.length, 0); assert.equal((await stage(p.workflow)).submission, undefined);
});
test('document await expiry leaves publication receipts but never a prepared wallet call', async () => {
  const h = createWorkflowFixture(config()), w = h.create(), review = ready(await w.review(h.adapter.request));
  h.control.afterPublication = document => { if (document.key === 'proposal-metadata') h.adapter.state.now += 40; };
  const observed = await w.prepare({ review, proposal });
  assert.notEqual(observed.status, 'ready'); assert.equal(h.adapter.trace.sends.length, 0);
  assert(ready(await w.inspect()).publications.every(row => row.status === 'published'));
});
test('a slow final broadcast CAS expires review and durably proves zero dispatch; only a fresh review may try again', async () => {
  const h = createWorkflowFixture(config()), p = await prepare(h); let delayed = false;
  h.control.afterWrite = data => { if (!delayed && data.workflows['synthetic-role'].stages.creation?.submission?.phase === 'submitting') {
    delayed = true; h.adapter.state.now += 40;
  } };
  const observed = await p.workflow.submit({ prepared: p.prepared });
  assert.equal(observed.status, 'blocked'); assert.deepEqual(observed.codes, ['SUBMISSION_NOT_DISPATCHED']); assert.equal(h.adapter.trace.sends.length, 0);
  const saved = await stage(p.workflow); assert.equal(saved.submission.phase, 'submitting'); assert.equal(saved.notDispatched.attemptId, saved.submission.attemptId);
  assert.equal((await h.create().recover()).status, 'blocked'); assert.equal(h.adapter.trace.sends.length, 0);
  h.adapter.state.now = h.adapter.config.block.timestamp + 1;
  const replacement = await prepare(h, h.create()); assert.equal(ready(await replacement.workflow.inspect()).history.length, 1);
  assert.equal(h.adapter.trace.sends.length, 0); assert.equal((await replacement.workflow.submit({ prepared: replacement.prepared })).status, 'unknown');
  assert.equal(h.adapter.trace.sends.length, 1);
});
test('failure to persist a no-dispatch proof retains the unresolved account barrier', async () => {
  const h = createWorkflowFixture(config()), p = await prepare(h); let delayed = false;
  h.control.afterWrite = data => { if (!delayed && data.workflows['synthetic-role'].stages.creation?.submission?.phase === 'submitting') { delayed = true; h.adapter.state.now += 40; } };
  h.control.beforeWrite = data => { if (data.workflows['synthetic-role'].stages.creation?.notDispatched) throw new Error('STORAGE_UNAVAILABLE'); };
  assert.deepEqual((await p.workflow.submit({ prepared: p.prepared })).codes, ['JOURNAL_OUTCOME_UNKNOWN']);
  h.adapter.state.now = h.adapter.config.block.timestamp + 1;
  assert.deepEqual((await h.create('another-intent').review(h.adapter.request)).codes, ['ACCOUNT_RECOVERY_REQUIRED']);
  assert.equal(h.adapter.trace.sends.length, 0);
});
test('failure persisting the pre-send record prevents dispatch and leaves an explicit recovery path', async () => {
  const h = createWorkflowFixture(config()), p = await prepare(h);
  h.control.beforeWrite = data => { if (data.workflows['synthetic-role'].stages.creation?.submission?.phase === 'prepared') throw new Error('STORAGE_UNAVAILABLE'); };
  assert.equal((await p.workflow.submit({ prepared: p.prepared })).status, 'blocked');
  assert.equal(h.adapter.trace.sends.length, 0); assert.equal((await stage(p.workflow)).submission, undefined);
});
test('publication journal failure occurs before any external publication', async () => {
  const h = createWorkflowFixture(config()), w = h.create(), review = ready(await w.review(h.adapter.request));
  h.control.beforeWrite = data => { if (data.workflows['synthetic-role'].publications.some(row => row.status === 'submitting')) throw new Error('STORAGE_UNAVAILABLE'); };
  assert.notEqual((await w.prepare({ review, proposal })).status, 'ready'); assert.equal(h.control.publications.length, 0);
});
test('accepted publication with lost response survives reload and is resolved by exact document evidence without republishing', async () => {
  const h = createWorkflowFixture(config()), w = h.create(), review = ready(await w.review(h.adapter.request)); h.control.publicationLost = true;
  assert.notEqual((await w.prepare({ review, proposal })).status, 'ready'); assert.equal(h.control.publications.length, 1);
  const reloaded = h.create(); assert.equal((await reloaded.recover()).status, 'unknown');
  const anotherReview = ready(await reloaded.review(h.adapter.request));
  assert.deepEqual((await reloaded.prepare({ review: anotherReview, proposal })).codes, ['PUBLICATION_RECOVERY_REQUIRED']);
  assert.equal(h.control.publications.length, 1);
  const receipt = h.control.publications[0]; assert.equal((await reloaded.recover({ publicationReceipts: [receipt] })).status, 'ready');
  h.control.publicationLost = false;
  const next = ready(await reloaded.review(h.adapter.request)); assert.equal((await reloaded.prepare({ review: next, proposal })).status, 'ready');
  assert.equal(h.control.publications.filter(row => row.key === 'role-metadata').length, 1);
  assert.equal(h.adapter.trace.sends.length, 0);
});
test('an asserted publication CID is only a lookup hint; different bytes cannot clear the ledger', async () => {
  const h = createWorkflowFixture(config()), w = h.create(), review = ready(await w.review(h.adapter.request)); h.control.publicationLost = true;
  await w.prepare({ review, proposal }); const receipt = h.control.publications[0];
  h.control.documents.set(receipt.cid, { name: 'Foreign bytes' });
  assert.deepEqual((await h.create().recover({ publicationReceipts: [receipt] })).codes, ['PUBLICATION_BYTES_MISMATCH']);
  assert.equal(ready(await w.inspect()).publications[0].status, 'unknown'); assert.equal(h.control.publications.length, 1);
});
test('a lost transaction acknowledgement blocks every other intent and reload recovery never resends', async () => {
  const h = createWorkflowFixture(config()), p = await prepare(h);
  assert.equal((await p.workflow.submit({ prepared: p.prepared })).status, 'unknown'); assert.equal(h.adapter.trace.sends.length, 1);
  assert.deepEqual((await h.create('other-role').review(h.adapter.request)).codes, ['ACCOUNT_RECOVERY_REQUIRED']);
  const observed = await h.create().recover(); assert.equal(observed.status, 'confirmed'); assert.equal(observed.data.creation.subjectId, h.adapter.ids.actual);
  assert.equal(observed.data.complete, false); assert.equal(h.adapter.trace.sends.length, 1);
  assert.deepEqual((await p.workflow.submit({ prepared: p.prepared })).codes, ['STAGE_ALREADY_SUBMITTED']);
  assert.equal(h.adapter.trace.sends.length, 1);
});
test('transport success stays pending until core proves proposal execution', async () => {
  const h = createWorkflowFixture(config()), p = await prepare(h); await p.workflow.submit({ prepared: p.prepared });
  const query = h.adapter.sources.indexed.query;
  h.adapter.sources.indexed.query = async (...args) => { const observed = await query(...args);
    for (const row of observed.data?.proposals ?? []) { row.wasExecuted = false; row.isValid = null; row.winningOption = null; row.batchExecutions = []; }
    return observed;
  };
  const reloaded = h.create(); const recovered = await reloaded.recover(); assert.equal(recovered.status, 'pending');
  assert.equal(recovered.data.creation.state, 'pending'); assert.equal((await reloaded.continuation()).status, 'pending'); assert.equal(h.adapter.trace.sends.length, 1);
});
test('another reviewed draft invalidates an older preparation before approval or dispatch', async () => {
  const h = createWorkflowFixture(config()), p = await prepare(h);
  ready(await h.create().review({ ...h.adapter.request, role: { ...h.adapter.request.role, name: 'Another draft' } }));
  assert.deepEqual((await p.workflow.submit({ prepared: p.prepared })).codes, ['CURRENT_PREPARATION_REQUIRED']);
  assert.equal(h.control.approvals.filter(row => row.kind === 'send').length, 0); assert.equal(h.adapter.trace.sends.length, 0);
});
test('a JSON preparation cannot authorize submission after reload', async () => {
  const h = createWorkflowFixture(config()), p = await prepare(h);
  assert.deepEqual((await h.create().submit({ prepared: JSON.parse(JSON.stringify(p.prepared)) })).codes, ['CURRENT_PREPARATION_REQUIRED']);
  assert.equal(h.adapter.trace.sends.length, 0);
});
test('real durable journal adapter survives a new adapter/controller and keeps canonical recovery exclusive', async () => {
  const storage = browserStorageFixture(), firstJournal = createBrowserJournal(storage), h = createWorkflowFixture(config(), { journal: firstJournal });
  const p = await prepare(h); await p.workflow.submit({ prepared: p.prepared });
  const nextJournal = createBrowserJournal(storage), reloaded = h.create('synthetic-role', { journal: nextJournal });
  assert.equal((await reloaded.recover()).status, 'confirmed'); assert.equal(h.adapter.trace.sends.length, 1);
  assert.equal(ready(await reloaded.inspect()).stages.creation.submission.phase, 'succeeded');
  await firstJournal.withAccountLock({ chainId: 100, accountAddress: h.adapter.scope.account }, async () => {
    const refused = await h.create('other-role', { journal: nextJournal }).review(h.adapter.request);
    assert.notEqual(refused.status, 'ready'); assert.equal(h.adapter.trace.sends.length, 1);
  });
});

test('a slow publication marker is revalidated before publisher invocation, with a durable known-not-published record', async () => {
  const h = createWorkflowFixture(config()), w = h.create(), review = ready(await w.review(h.adapter.request)); let delayed = false;
  h.control.afterWrite = data => { if (!delayed && data.workflows['synthetic-role'].publications.some(row => row.status === 'submitting')) {
    delayed = true; h.adapter.state.now += 40;
  } };
  const observed = await w.prepare({ review, proposal }); assert.notEqual(observed.status, 'ready');
  assert.equal(h.control.publications.length, 0); assert.equal(ready(await w.inspect()).publications[0].status, 'not-published');
  h.adapter.state.now = h.adapter.config.block.timestamp + 1;
  const fresh = ready(await w.review(h.adapter.request)); assert.equal((await w.prepare({ review: fresh, proposal })).status, 'ready');
  assert.equal(h.control.publications.length, 2); assert.equal(h.adapter.trace.sends.length, 0);
});
test('failure persisting a known-not-published outcome retains the original uncertainty barrier', async () => {
  const h = createWorkflowFixture(config()), w = h.create(), review = ready(await w.review(h.adapter.request)); let delayed = false;
  h.control.afterWrite = data => { if (!delayed && data.workflows['synthetic-role'].publications.some(row => row.status === 'submitting')) { delayed = true; h.adapter.state.now += 40; } };
  h.control.beforeWrite = data => { if (data.workflows['synthetic-role'].publications.some(row => row.status === 'not-published')) throw new Error('STORAGE_UNAVAILABLE'); };
  await w.prepare({ review, proposal }); assert.equal(h.control.publications.length, 0);
  assert.equal((await h.create().recover()).status, 'unknown');
  assert.equal(ready(await w.inspect()).publications[0].status, 'submitting');
});

test('checksummed module addresses preserve the same exact normalized wallet call', async () => {
  const fixture = config(); fixture.contracts.hybridVoting = '0xa112233445566778899001122334455667788990';
  const h = createWorkflowFixture(fixture), scope = { ...h.adapter.scope, contracts: { ...h.adapter.scope.contracts,
    hybridVoting: ethers.utils.getAddress(h.adapter.scope.contracts.hybridVoting) } };
  const w = createRoleWorkflow({ workflowId: 'mixed-case', scope, sources: h.adapter.sources, wallet: h.wallet, journal: h.journal,
    documents: h.documents, confirm: async () => true, isCurrent: () => true });
  const reviewed = ready(await w.review(h.adapter.request)), prepared = ready(await w.prepare({ review: reviewed, proposal }));
  assert.equal((await w.submit({ prepared })).status, 'unknown'); assert.equal(h.adapter.trace.sends.length, 1);
});
