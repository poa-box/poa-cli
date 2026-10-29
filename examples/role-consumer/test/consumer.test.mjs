import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { reviewRoleOperation, prepareRoleOperation, readRoleOperationStatus } from '@poa-box/core/governance/role-operations';
import { buildGovernanceProposal } from '@poa-box/core/tx/governance';
import { createFixture } from '../src/adapters/fixture.mjs';
import { prepareStage, runFixtureStory, dispatchFixture } from '../src/consumer.mjs';
const config = () => JSON.parse(readFileSync(new URL('../fixtures/role-workflow.v1.json', import.meta.url)));
let original;
before(() => { original = globalThis.fetch; globalThis.fetch = () => { throw new Error('REAL_NETWORK_FORBIDDEN'); }; });
after(() => { globalThis.fetch = original; });

test('real packed operations create, recover a lost ack without replay, prove actual ID and separately configure', async () => {
  const f = createFixture(config()), result = await runFixtureStory(f);
  assert.equal(result.synthetic, true); assert.match(result.label, /SYNTHETIC/);
  assert.equal(result.permission.value.value, '8');
  assert.deepEqual(result.trace.sends.map(row => row.stage), ['creation', 'configuration']);
  assert.equal(result.creation.review.mode, 'create');
  assert.equal(result.creation.review.preview.createsSubject, true);
  assert.equal(result.creation.status.creation.subjectId, f.ids.actual);
  assert.notEqual(f.ids.actual, f.ids.sameName);
  assert.equal(result.creation.recovery.saved.phase, 'succeeded');
  assert.equal(result.creation.recovery.recovery.status, 'succeeded');
  assert.equal(result.creation.status.next, 'review-configuration');
  assert.equal(result.configuration.outcome.status, 'ready');
  assert.equal(result.configuration.outcome.data.configuration.state, 'executed');
  assert.equal(result.configuration.outcome.data.next, 'complete');
  const first = f.authority.parseTransaction({ data: result.creation.batch[0].calldata });
  assert.equal(result.creation.batch.length, 1); assert.equal(first.name, 'createRole');
  assert.equal(first.args[3].toString(), '2');
  const configCalls = result.configuration.batch.map(call => f.authority.parseTransaction({ data: call.calldata }));
  assert.deepEqual(configCalls.map(call => call.name), ['renameSubject', 'setMaxMembers', 'setSubjectDefault', 'addRoleToGroup', 'setPerm', 'grant']);
  assert(configCalls.every(call => call.args[0].toString() === f.ids.actual));
  assert.equal(configCalls.find(call => call.name === 'grant').args[1].toLowerCase(), f.scope.account);
  assert.equal(configCalls.find(call => call.name === 'setPerm').args[3].toString(), ethers.BigNumber.from(2).pow(255).add(8).toString());
  assert(result.trace.queries.every(row => !/RoleOperationHistory|ProposalArchive/.test(row.document)));
  const again = await runFixtureStory(createFixture(config()));
  assert.deepEqual(again, result);
});
test('creation receipt cannot stand in for the separately requested configuration after reload', async () => {
  const adapter = createFixture(config()), stage = await prepareStage(adapter, adapter.request);
  assert.equal(stage.review.requiresConfiguration, true);
  const first = await dispatchFixture(adapter, 'creation', stage.intent), batch = stage.result.data.batch;
  const saved = JSON.parse(JSON.stringify({ scope: adapter.scope,
    creation: { transactionHash: first.transactionHash, call: batch[0] },
    configuration: { transactionHash: first.transactionHash, batch } }));
  const result = await readRoleOperationStatus({ ...saved, sources: adapter.sources });
  assert.equal(adapter.state.configured, false);
  assert.equal(result.status, 'unknown'); assert(result.codes.includes('ROLE_CONFIGURATION_STAGE_REPLAY'));
  assert.equal(result.observations.creation.value.subjectId, adapter.ids.actual);
  assert.equal(result.data, undefined); assert.equal(adapter.trace.sends.length, 1);
});
test('canonical configuration for another subject never completes this created subject after reload', async () => {
  const adapter = createFixture(config()), stage = await prepareStage(adapter, adapter.request);
  const first = await dispatchFixture(adapter, 'creation', stage.intent);
  const batch = [{ target: adapter.scope.contract, value: '0',
    calldata: adapter.authority.encodeFunctionData('setSubjectDefault', [adapter.ids.sameName, true, false]) }];
  const intent = buildGovernanceProposal({ votingAddress: adapter.scope.contracts.hybridVoting, votingAbiName: 'HybridVotingNew',
    orgId: adapter.scope.orgId, title: 'Synthetic foreign configuration', descriptionHash: ethers.constants.HashZero,
    durationMinutes: '1440', numOptions: 2, batches: [batch, []] });
  const second = await dispatchFixture(adapter, 'configuration', intent);
  const saved = JSON.parse(JSON.stringify({ scope: adapter.scope,
    creation: { transactionHash: first.transactionHash, call: stage.result.data.batch[0] },
    configuration: { transactionHash: second.transactionHash, batch } }));
  const result = await readRoleOperationStatus({ ...saved, sources: adapter.sources });
  assert.equal(result.status, 'unknown'); assert(result.codes.includes('ROLE_CONFIGURATION_SUBJECT_UNPROVEN'));
  assert.equal(result.observations.creation.value.subjectId, adapter.ids.actual);
  assert.equal(result.data, undefined); assert.equal(adapter.trace.sends.length, 2);
});
for (const failure of ['elapsed', 'module']) test('delayed proposal preparation with ' + failure + ' change causes zero manager calls', async () => {
  const f = createFixture(config()); let managerCalls = 0;
  const result = await prepareStage(f, f.request, {
    afterEnvelope: async () => { if (failure === 'elapsed') f.state.now += 61; else f.state.authorityExecutor = '0x' + 'ab'.repeat(20); },
    handoff: async () => { managerCalls++; },
  });
  assert.notEqual(result.result.status, 'ready'); assert.equal(managerCalls, 0); assert.equal(f.trace.sends.length, 0);
  assert.equal(result.result.data, undefined);
});
test('absent indexed block proof remains unknown before publication', async () => {
  const f = createFixture(config()); f.state.missingMeta = true;
  const result = await prepareStage(f, f.request);
  assert.equal(result.result.status, 'unknown');
  assert.equal(f.trace.publications.length, 0); assert.equal(f.trace.sends.length, 0);
});

test('review has no publisher/send capability and a serialized handle cannot authorize preparation', async () => {
  const f = createFixture(config());
  const review = await reviewRoleOperation({ scope: f.scope, sources: f.sources, request: f.request });
  assert.equal(review.status, 'ready');
  assert.equal(review.data.predictedSubjectId, undefined); assert.equal(review.data.batch, undefined);
  assert.equal(review.data.requiresConfiguration, true);
  assert(review.data.deferredEffects.some(effect => effect.field === 'permissions'));
  assert.equal(f.trace.publications.length, 0); assert.equal(f.trace.sends.length, 0);
  const copied = JSON.parse(JSON.stringify(review.data));
  const result = await prepareRoleOperation({ scope: f.scope, sources: f.sources, review: copied,
    currentRequest: f.request, publishDocument: f.publishDocument });
  assert.notEqual(result.status, 'ready'); assert.equal(result.data, undefined);
  assert.equal(f.trace.publications.length, 0); assert.equal(f.trace.sends.length, 0);
});

test('create-only intent completes at exact creation proof without an empty configuration vote', async () => {
  const f = createFixture(config()), request = { mode: 'create', role: { kind: 'Role', name: f.config.name, maxMembers: f.config.maxMembers } };
  const prepared = await prepareStage(f, request);
  assert.equal(prepared.result.status, 'ready'); assert.equal(prepared.review.requiresConfiguration, false);
  const sent = await dispatchFixture(f, 'creation', prepared.intent);
  const status = await readRoleOperationStatus({ scope: f.scope, sources: f.sources,
    creation: { transactionHash: sent.transactionHash, call: prepared.result.data.batch[0] } });
  assert.equal(status.status, 'ready'); assert.equal(status.data.creation.state, 'created');
  assert.equal(status.data.creation.subjectId, f.ids.actual);
  // Status does not receive the original draft intent; this permits another review
  // but the retained false flag means this host's create-only workflow is done.
  assert.equal(status.data.next, 'review-configuration');
  assert.deepEqual(f.trace.sends.map(row => row.stage), ['creation']);
});
