import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { knownFact, unknownFact } from '@poa-box/core/data/facts';
import { AUTHORITY_KEYS, permissionWord } from '@poa-box/core/tx/authority';
import { getAbi } from '@poa-box/core/contracts';
import { createPollWorkflow, createBallotWorkflow } from '../../src/workflows';
import type { PollRequest, PollEvidence, BallotEvidence, BallotRequest } from '../../src/workflows';
import { addr, assertReady, authorityData, fixture, hash, memberData, scope } from './fixture';

const poll: PollRequest = { lane: 'dd', title: 'Synthetic poll', description: 'Choose an option', durationMinutes: '10', optionNames: ['Yes', 'No'], createdAt: 1000000 };
function pollFixture() {
  const f = fixture();
  const evidence = (): PollEvidence => ({
    module: f.snapshot({ paused: knownFact(false), executor: knownFact(scope.contracts.executor), membershipAuthority: knownFact(scope.contracts.membershipAuthority) }, scope.contracts.directDemocracyVoting),
    authority: f.snapshot(authorityData(AUTHORITY_KEYS.DD_CREATE, permissionWord('1').toString()), scope.contracts.membershipAuthority, true),
    memberships: f.snapshot(memberData, scope.contracts.membershipAuthority, true, true),
  });
  const reader = { read: async () => { await f.control.beforeRead?.(); return evidence(); } };
  return { ...f, evidence, reader, create: () => createPollWorkflow(f.host, reader) };
}
async function preparedPoll(f: ReturnType<typeof pollFixture>) { const w = f.create(); return { w, review: assertReady(await w.review(poll)),
  async prepare() { return assertReady(await w.prepare({ review: this.review })); } }; }

describe('informational polls', () => {
  it('reviews without side effects and encodes call-free metadata in the selected DD domain', async () => {
    const f = pollFixture(), p = await preparedPoll(f);
    expect(f.control.publishes).toBe(0); expect(f.control.sends).toBe(0);
    const prepared = await p.prepare();
    const decoded = new ethers.utils.Interface(getAbi('DirectDemocracyVotingNew')).parseTransaction({ data: prepared.call.data });
    expect(prepared.call.to).toBe(scope.contracts.directDemocracyVoting);
    expect(decoded.name).toBe('createProposal'); expect(decoded.args[4]).toEqual([]); expect(decoded.args[3].toString()).toBe('2');
    expect(f.control.approvals).toEqual(['publish']); expect(Object.isFrozen(prepared)).toBe(true);
  });
  it('copies mutable input and rejects serialized review/prepared authority', async () => {
    const f = pollFixture(), w = f.create(), input = JSON.parse(JSON.stringify(poll));
    const review = assertReady(await w.review(input)); input.title = 'Changed'; input.optionNames[0] = 'Changed';
    expect(review.request.title).toBe(poll.title); expect(review.request.optionNames[0]).toBe('Yes');
    expect((await w.prepare({ review: JSON.parse(JSON.stringify(review)) })).codes).toEqual(['CURRENT_REVIEW_REQUIRED']);
    const prepared = assertReady(await w.prepare({ review }));
    expect((await w.submit({ prepared: JSON.parse(JSON.stringify(prepared)) })).codes).toEqual(['CURRENT_PREPARATION_REQUIRED']);
  });
  it('denies publication approval and never publishes', async () => {
    const f = pollFixture(), p = await preparedPoll(f); f.control.approve = false;
    expect((await p.w.prepare({ review: p.review })).codes).toEqual(['APPROVAL_DECLINED']); expect(f.control.publishes).toBe(0);
  });
  for (const variant of ['denied', 'unknown', 'foreign-account', 'foreign-module', 'incomplete', 'stale'] as const) it(`does not authorize ${variant} evidence`, async () => {
    const f = pollFixture(), evidence = f.evidence();
    if (variant === 'denied') evidence.authority!.data.permissions[0].word = permissionWord('0').toString();
    if (variant === 'unknown') evidence.memberships!.data[0].isMember = unknownFact('MEMBERSHIP_UNAVAILABLE');
    if (variant === 'foreign-account') evidence.memberships!.source.account = addr('f');
    if (variant === 'foreign-module') evidence.module.source.contract = scope.contracts.hybridVoting;
    if (variant === 'incomplete') evidence.authority!.coverage.status = 'incomplete';
    if (variant === 'stale') evidence.module.source.observedAt = 900;
    const w = createPollWorkflow(f.host, { read: async () => evidence }), result = await w.review(poll);
    expect(result.status).toBe(variant === 'denied' ? 'blocked' : 'unknown'); expect(f.control.publishes).toBe(0); expect(f.control.sends).toBe(0);
  });
  it('checks current permission after wallet async setup and refuses changed authority', async () => {
    const f = pollFixture(); let permit = true;
    const w = createPollWorkflow(f.host, { read: async () => { const e = f.evidence(); if (!permit) e.authority!.data.permissions[0].word = permissionWord('0').toString(); return e; } });
    const review = assertReady(await w.review(poll)), prepared = assertReady(await w.prepare({ review })); f.control.walletSetup = () => { permit = false; };
    expect((await w.submit({ prepared })).status).toBe('blocked'); expect(f.control.sends).toBe(0);
  });
  it('checks after durable writes and marks a trusted refusal without broadcasting', async () => {
    const f = pollFixture(), p = await preparedPoll(f), prepared = await p.prepare();
    f.control.afterWrite = data => { if (JSON.stringify(data).includes('"phase":"submitting"')) f.control.current = false; };
    expect((await p.w.submit({ prepared })).codes).toEqual(['SUBMISSION_NOT_DISPATCHED']); expect(f.control.sends).toBe(0);
  });
  it('never dispatches when journal persistence fails', async () => {
    const f = pollFixture(), p = await preparedPoll(f), prepared = await p.prepare();
    f.control.beforeWrite = data => { if (JSON.stringify(data).includes('"submission"')) throw new Error('SYNTHETIC_STORAGE_FAILURE'); };
    expect((await p.w.submit({ prepared })).status).not.toBe('pending'); expect(f.control.sends).toBe(0);
  });
  it('lost publication acknowledgement blocks retries and recovers only proven bytes', async () => {
    const f = pollFixture(), p = await preparedPoll(f); f.control.publicationLost = true;
    expect((await p.w.prepare({ review: p.review })).status).toBe('unknown');
    expect((await p.w.prepare({ review: p.review })).codes).toEqual(['PUBLICATION_RECOVERY_REQUIRED']); expect(f.control.publishes).toBe(1);
    const [cid, document] = [...f.documentBytes.entries()][0];
    const receipt = { key: 'proposal-metadata', digest: ethers.utils.id(JSON.stringify(document)), cid };
    expect((await p.w.recover({ publicationReceipts: [receipt] })).status).toBe('ready');
    f.control.publicationLost = false;
    expect((await p.w.prepare({ review: p.review })).status).toBe('ready'); expect(f.control.publishes).toBe(1);
  });
  it('lost send acknowledgement blocks every workflow for the account and recovers exact nonce without replay', async () => {
    const f = pollFixture(), p = await preparedPoll(f), prepared = await p.prepare(); f.control.lostAck = true;
    expect((await p.w.submit({ prepared })).codes).toEqual(['SUBMISSION_OUTCOME_UNKNOWN']);
    expect((await f.create().review(poll)).codes).toEqual(['ACCOUNT_RECOVERY_REQUIRED']); expect(f.control.sends).toBe(1);
    expect((await p.w.recover()).status).toBe('unknown');
    f.control.mined = true;
    const iface = new ethers.utils.Interface(getAbi('DirectDemocracyVotingNew')), event = iface.getEvent('NewProposal');
    const encoded = iface.encodeEventLog(event, event.inputs.map(i => i.name === 'id' ? 73 : i.type === 'address' ? scope.account : i.type === 'bytes' ? '0x' : i.type === 'bytes32' ? hash('0') : i.type === 'bool' ? false : i.type.endsWith('[]') ? [] : 0));
    f.control.logs = [{ address: scope.contracts.directDemocracyVoting, ...encoded }];
    const recovered = await f.create().recover(); expect(recovered.status).toBe('confirmed'); expect(recovered.data).toMatchObject({ proposalId: '73' }); expect(f.control.sends).toBe(1);
  });
  it('cancellation, stale scope and foreign simulation account never dispatch', async () => {
    const f = pollFixture(), p = await preparedPoll(f), controller = new AbortController(); controller.abort();
    expect((await p.w.prepare({ review: p.review, signal: controller.signal })).codes).toEqual(['WORKFLOW_CANCELLED']);
    f.control.simulateAccount = addr('e'); expect((await p.w.prepare({ review: p.review })).status).toBe('unknown'); expect(f.control.sends).toBe(0);
  });
});

function ballotFixture(lane: 'dd' | 'hybrid' = 'dd') {
  const f = fixture(), voting = scope.contracts[lane === 'dd' ? 'directDemocracyVoting' : 'hybridVoting'];
  const request: BallotRequest = { lane, proposalId: '41', optionIndices: [0], weights: [100] };
  const evidence = (): BallotEvidence => ({
    proposal: f.snapshot({ proposalId: '41', paused: knownFact(false), executor: knownFact(scope.contracts.executor), membershipAuthority: knownFact(scope.contracts.membershipAuthority),
      exists: knownFact(true), alreadyVoted: knownFact(false), startTimestamp: knownFact('900'), endTimestamp: knownFact('1100'), numOptions: knownFact(2) }, voting, false, true),
    ddAuthorization: f.snapshot({ proposalId: '41', createdAt: knownFact('800'), membershipAuthority: knownFact(scope.contracts.membershipAuthority), executor: knownFact(scope.contracts.executor), restricted: knownFact(false), restrictedSubjectIds: knownFact([]) }, voting),
    hybridPower: f.snapshot({ proposalId: '41', createdAt: knownFact('800'), restrictedSubjectIds: knownFact([]), classes: [{ strategy: 'DIRECT', slicePct: 100, quadratic: false,
      minBalance: '0', asset: ethers.constants.AddressZero, hatIds: [], subjectId: knownFact('0') }] }, voting),
    balances: [knownFact('0')], optionClassRaw: [[knownFact('0')], [knownFact('0')]],
    authority: f.snapshot(authorityData(AUTHORITY_KEYS.DD_VOTE, permissionWord('1').toString()), scope.contracts.membershipAuthority, true),
    memberships: f.snapshot(memberData, scope.contracts.membershipAuthority, true, true),
  });
  return { ...f, request, evidence, create: (e = evidence()) => createBallotWorkflow(f.host, { read: async () => e }) };
}
describe('ballots', () => {
  for (const lane of ['dd', 'hybrid'] as const) it(`runs ${lane} core policy and decodes exact vote`, async () => {
    const f = ballotFixture(lane), w = f.create(), review = assertReady(await w.review(f.request)), prepared = assertReady(await w.prepare({ review }));
    const decoded = new ethers.utils.Interface(getAbi(lane === 'dd' ? 'DirectDemocracyVotingNew' : 'HybridVotingNew')).parseTransaction({ data: prepared.call.data });
    expect(decoded.name).toBe('vote'); expect(decoded.args[0].toString()).toBe('41'); expect(decoded.args[1].map(Number)).toEqual([0]);
    expect((await w.submit({ prepared })).status).toBe('pending'); expect(f.control.approvals).toEqual(['send']);
    f.control.mined = true; expect((await w.status()).status).toBe('confirmed');
  });
  for (const variant of ['unknown-membership', 'denied', 'already-voted', 'expired', 'bad-options', 'bad-weights', 'foreign-proposal'] as const) it(`refuses DD ${variant}`, async () => {
    const f = ballotFixture(), e = f.evidence(), request = { ...f.request };
    if (variant === 'unknown-membership') e.memberships!.data[0].isMember = unknownFact('UNAVAILABLE');
    if (variant === 'denied') e.authority!.data.permissions[0].word = permissionWord('0').toString();
    if (variant === 'already-voted') e.proposal.data.alreadyVoted = knownFact(true);
    if (variant === 'expired') e.proposal.data.endTimestamp = knownFact('999');
    if (variant === 'bad-options') request.optionIndices = [2];
    if (variant === 'bad-weights') request.weights = [99];
    if (variant === 'foreign-proposal') e.ddAuthorization!.data.proposalId = '42';
    expect((await f.create(e).review(request)).status).not.toBe('ready'); expect(f.control.sends).toBe(0);
  });
  it('does not substitute current live class subjects or zero for unknown immutable bindings', async () => {
    const f = ballotFixture('hybrid'), e = f.evidence(); e.hybridPower!.data.classes[0].subjectId = unknownFact('BINDING_UNAVAILABLE');
    expect((await f.create(e).review(f.request)).status).toBe('unknown');
  });
  it('refuses uint128 accumulator overflow using core contribution policy', async () => {
    const f = ballotFixture('hybrid'), e = f.evidence(); e.optionClassRaw![0][0] = knownFact(((1n << 128n) - 1n).toString());
    expect((await f.create(e).review(f.request)).status).toBe('unknown');
  });
  it('retains indexed provenance for proposal flags and Hybrid accumulators absent public RPC getters', async () => {
    const f = ballotFixture('hybrid'), e = f.evidence();
    e.proposal.data.exists = unknownFact('RPC_GETTER_UNAVAILABLE'); e.proposal.data.alreadyVoted = unknownFact('RPC_GETTER_UNAVAILABLE'); e.proposal.data.numOptions = unknownFact('RPC_GETTER_UNAVAILABLE');
    e.indexedProposal = f.snapshot({ proposalId: '41', exists: knownFact(true), alreadyVoted: knownFact(false), numOptions: knownFact(2) }, scope.contracts.hybridVoting, true, true);
    e.indexedProposal.data.exists = knownFact(true, e.indexedProposal.source);
    e.indexedProposal.data.startTimestamp = knownFact('900', e.indexedProposal.source); delete e.proposal.data.startTimestamp;
    e.hybridTallies = f.snapshot({ proposalId: '41', optionClassRaw: [[knownFact('0')], [knownFact('0')]] }, scope.contracts.hybridVoting, true);
    e.hybridTallies.data.optionClassRaw[0][0] = knownFact('0', e.hybridTallies.source); delete e.optionClassRaw;
    const w = f.create(e), review = assertReady(await w.review(f.request)); expect((await w.prepare({ review })).status).toBe('ready');
    e.hybridTallies.source.block!.hash = hash('f'); expect((await f.create(e).review(f.request)).status).toBe('unknown');
  });
});
