import { describe, expect, test } from 'vitest';
import { submissionIntentKey } from '@poa-box/core/execute/recovery';
import { requireCompleteSnapshot } from '@poa-box/core/data/facts';
import { createBallotWorkflow, createPollWorkflow } from '../../src/workflows';
import { createWorkflowReaders } from '../../src/observations';
import { fixture as hostFixture } from '../workflows/fixture';
import { fixture, HASH, scope } from './fixture';
const request = { lane: 'dd' as const, proposalId: '1', optionIndices: [0], weights: [100] };
const options = { scope };
const poll = { lane: 'dd' as const, title: 'Community priorities', description: 'Choose together.', durationMinutes: '60', optionNames: ['A', 'B'], createdAt: 1000000 };
describe('complete V2 workflow observation adapters', () => {
  test('pins indexed scope and every authority page to one RPC-crosschecked block', async () => {
    const f = fixture(); const result = await f.readers.poll.read(poll, options);
    expect(result.module.source).toMatchObject({ indexed: false, block: { number: '100', hash: HASH, timestamp: '1000' } });
    expect(result.authority?.source).toMatchObject({ indexed: true, contract: scope.contracts.membershipAuthority, block: { number: '100', hash: HASH, timestamp: '1000' } });
    expect(result.memberships?.source.account).toBe(scope.account);
    expect(result.module.data.executor).toMatchObject({ state: 'known', value: scope.contracts.executor });
    expect(f.state.calls.map(call => call.name).sort()).toEqual(['executor', 'membershipAuthority', 'paused']);
    expect(f.state.calls.every(call => call.block === 100)).toBe(true);
    expect(f.state.queries.filter(query => query.variables.block).every(query => (query.variables.block as { hash: string }).hash === HASH)).toBe(true);
    expect(f.state.queries.every(query => query.document.includes('timestamp'))).toBe(true);
    expect(f.state.queries.every(query => !/\$orgId\s*:\s*ID!/.test(query.document))).toBe(true);
    expect(requireCompleteSnapshot(result.authority!)).toMatchObject({ ready: { state: 'known', value: true } });
  });
  test.each(['dd', 'hybrid'] as const)('feeds the real %s poll and ballot workflows without caller-built snapshots', async lane => {
    const f = fixture(), host = hostFixture().host;
    const adapted = { ...host, scope, sources: f.sources, simulate: f.readers.simulate,
      wallet: { ...host.wallet, getIdentity: async () => ({ chainId: 100, accountAddress: scope.account }) } };
    const reviewed = await createPollWorkflow(adapted, f.readers.poll).review({ ...poll, lane });
    expect(reviewed.status, JSON.stringify(reviewed.codes)).toBe('ready');
    const ballot = await createBallotWorkflow({ ...adapted, workflowId: `ballot-${lane}` }, f.readers.ballot).review({ ...request, lane });
    expect(ballot.status, JSON.stringify(ballot.codes)).toBe('ready');
  });
  test('keeps indexed already-voted history and hybrid accumulators with their real provenance', async () => {
    const f = fixture(); f.state.alreadyVoted = true;
    const result = await f.readers.ballot.read({ ...request, lane: 'hybrid' }, options);
    expect(result.indexedProposal?.data.alreadyVoted).toMatchObject({ state: 'known', value: true, source: { indexed: true } });
    expect(result.hybridPower?.data.classes[0]).toMatchObject({ strategy: 'DIRECT', subjectId: { state: 'known', value: '0' } });
    expect(result.hybridTallies?.data.optionClassRaw[0][0]).toMatchObject({ state: 'known', value: '100', source: { indexed: true } });
    expect(f.state.calls.some(call => call.name === 'getClasses')).toBe(false);
    expect(f.state.calls.filter(call => ['proposalCreatedAt', 'proposalEndTimestamp', 'pollRestricted'].includes(call.name)).map(call => call.args[0].toString())).toEqual(['1', '1', '1']);
  });
  test('assembles registry state and exact factory prediction without signing', async () => {
    const f = fixture(); const result = await f.readers.enrollment.read({ mode: 'passkey', username: 'member', deadline: '1100', accountAddress: scope.account,
      passkey: { credentialId: `0x${'11'.repeat(32)}`, publicKeyX: `0x${'22'.repeat(32)}`, publicKeyY: `0x${'33'.repeat(32)}`, salt: '900719925474099312345' } }, options);
    expect(result.registry.data).toMatchObject({ nonce: { state: 'known', value: '9' }, registered: { state: 'known', value: false }, usernameAvailable: { state: 'known', value: true } });
    expect(result.passkeyPrediction?.data.accountAddress).toMatchObject({ state: 'known', value: scope.account });
    expect(f.state.calls.find(call => call.name === 'getAddress')?.args[3].toString()).toBe('900719925474099312345');
    expect(f.state.calls.map(call => call.name)).toEqual(expect.arrayContaining(['getUsername', 'getAddressOfUsername', 'nonces', 'accountRegistry', 'universalFactory']));
  });
  test.each(['chain', 'hash', 'timestamp', 'missing-time', 'lag', 'reorg', 'module', 'index-outage', 'index-errors'])('refuses %s instead of returning positive evidence', async mode => {
    const f = fixture();
    if (mode === 'chain') f.state.rpcChain = 42161;
    if (mode === 'hash') f.state.hash = `0x${'ff'.repeat(32)}`;
    if (mode === 'timestamp') f.state.rpcTime = 999;
    if (mode === 'missing-time') f.state.missingTimestamp = true;
    if (mode === 'lag') f.state.latest = 300;
    if (mode === 'reorg') f.state.mismatchFinal = true;
    if (mode === 'module') f.state.moduleMismatch = true;
    if (mode === 'index-outage') f.state.outage = true;
    if (mode === 'index-errors') f.state.indexErrors = true;
    await expect(f.readers.poll.read({ ...poll, lane: 'hybrid' }, options)).rejects.toThrow();
  });
  test('refuses stale observations and actor substitution before producing usable facts', async () => {
    const f = fixture(); f.state.now = 1031;
    await expect(f.readers.poll.read(poll, options)).rejects.toThrow('STALE');
    await expect(f.readers.poll.read(poll, { scope: { ...scope, account: `0x${'ff'.repeat(20)}` } })).rejects.toThrow();
    expect(() => createWorkflowReaders({ deployment: 'legacy' as never, scope, provider: f.provider, query: f.query, sources: f.sources })).toThrow('UNSUPPORTED');
  });
  test.each(['dd', 'hybrid'] as const)('retains the %s pre-authority activation sentinel independently from the voting window', async lane => {
    const f = fixture(); f.state.createdAt = '0';
    const evidence = await f.readers.ballot.read({ ...request, lane }, options);
    expect(evidence.indexedProposal?.data.startTimestamp).toMatchObject({ state: 'known', value: '900', source: { indexed: true } });
    expect((lane === 'dd' ? evidence.ddAuthorization : evidence.hybridPower)?.data.createdAt).toMatchObject({ state: 'known', value: '0', source: { indexed: false } });
    const host = hostFixture().host;
    const adapted = { ...host, scope, sources: f.sources, simulate: f.readers.simulate,
      wallet: { ...host.wallet, getIdentity: async () => ({ chainId: 100, accountAddress: scope.account }) } };
    expect((await createBallotWorkflow(adapted, f.readers.ballot).review({ ...request, lane })).status).toBe('ready');
  });
  test('enumerates another ballot page and validates the terminal response before proving absence or presence', async () => {
    const f = fixture({ pageSize: 1, maxPages: 2 }); f.state.alreadyVoted = true;
    const evidence = await f.readers.ballot.read(request, options);
    expect(evidence.indexedProposal?.data.alreadyVoted).toMatchObject({ state: 'known', value: true });
    expect(f.state.queries.filter(query => query.document.includes('ProposalBallotsPage'))).toHaveLength(2);
    f.state.terminalPageMismatch = true;
    await expect(f.readers.ballot.read(request, options)).rejects.toThrow();
    f.state.terminalPageMismatch = false; f.state.terminalIndexErrors = true;
    await expect(f.readers.ballot.read(request, options)).rejects.toThrow();
  });
  test('missing indexed option counts stay unavailable rather than becoming zero', async () => {
    const f = fixture(); f.state.missingOptions = true;
    await expect(f.readers.ballot.read(request, options)).rejects.toThrow();
  });
  test('bounds unresponsive transports and rejects pre-cancelled reads without dispatch', async () => {
    const f = fixture();
    const readers = createWorkflowReaders({ deployment: 'authority-v2', scope, sources: f.sources, provider: f.provider,
      query: () => new Promise(() => {}), limits: { timeoutMs: 5 } });
    await expect(readers.poll.read(poll, options)).rejects.toThrow('OBSERVATION_TIMEOUT');
    const cancelled = new AbortController(); cancelled.abort();
    await expect(f.readers.poll.read(poll, { scope, signal: cancelled.signal })).rejects.toThrow('CANCELLED');
    expect(f.state.queries).toHaveLength(0);
  });
  test('a full final ballot page never proves complete history', async () => {
    const f = fixture({ pageSize: 1, maxPages: 1 }); f.state.alreadyVoted = true;
    await expect(f.readers.ballot.read(request, options)).rejects.toThrow();
  });
  test.each(['success', 'revert', 'outage'] as const)('simulates exact actor, target, value and calldata with %s distinguished', async outcome => {
    const f = fixture(); f.state.simulation = outcome;
    const call = { to: scope.contracts.hybridVoting, data: '0x12345678', value: '900719925474099312345' };
    const result = await f.readers.simulate(call, options);
    expect(result.data.callKey).toBe(submissionIntentKey([call]));
    expect(result.data.succeeds).toMatchObject(outcome === 'outage' ? { state: 'unknown', code: 'SIMULATION_UNAVAILABLE' } : { state: 'known', value: outcome === 'success' });
    expect(f.state.calls.find(call => call.name === 'simulation')).toMatchObject({ contract: call.to, from: scope.account, data: call.data, value: call.value, block: 100 });
  });
});
