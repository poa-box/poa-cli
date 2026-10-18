import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSchema, extendSchema, graphql, parse } from 'graphql';
import { ethers } from 'ethers';
import { subjectCreationRaceFacts } from '../src/authority/ids';
import { getAbi } from '../src/contracts';
import { PlanResult, requireCompleteSnapshot, SourceRef } from '../src/data/facts';
import { readSubjectCreationProvenance, recoverSubjectCreationHistory } from '../src/governance/provenance';
import { ProtocolQuery } from '../src/reads/protocol';
import { readProposalArchive } from '../src/reads/vote';

// Retained governance schema plus the authority binding selected by this proof.
// Execute whole documents so unselected metadata cannot leak from the fixture.
const schema = extendSchema(buildSchema(readFileSync(new URL('./fixtures/core-update/governance/schema.graphql', import.meta.url), 'utf8')),
  parse('type MembershipAuthorityContract { id: Bytes! } extend type Organization { membershipAuthority: MembershipAuthorityContract }'));
const VOTING = '0x1111111111111111111111111111111111111111';
const AUTHORITY = '0x2222222222222222222222222222222222222222';
const ACCOUNT = '0x3333333333333333333333333333333333333333';
const ORG = '0x' + 'e5'.repeat(32), TX = '0x' + 'a1'.repeat(32);
const HASH = '0x' + 'b2'.repeat(32), OLD_HASH = '0x' + 'c3'.repeat(32), META = '0x' + 'd4'.repeat(32);
const scope = { chainId: 100, orgId: ORG, contract: VOTING, contracts: { membershipAuthority: AUTHORITY } };
const source: SourceRef = { ...scope, endpoint: 'mock://timestamp-index', method: 'proposal-history', indexed: true,
  snapshot: 'pinned', block: { number: '100', hash: HASH, timestamp: '1900' }, observedAt: 2000 };
const freshness = { now: 2000, maxAgeSeconds: 0 };
// Independent contract-shaped calldata/event oracle, not a stub of core proof logic.
const voting = new ethers.utils.Interface([
  'function createProposal(bytes title,bytes32 descriptionHash,uint32 minutesDuration,uint8 numOptions,(address target,uint256 value,bytes data)[][] batches,uint256[] hatIds)',
  'event NewProposal(uint256 id,bytes title,bytes32 descriptionHash,uint8 numOptions,uint64 endTs,uint64 created)',
]);
const authority = new ethers.utils.Interface(getAbi('MembershipAuthority'));
function fixture(createsSubject = false) {
  const title = ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Historical subject action'));
  const action = createsSubject ? authority.encodeFunctionData('createRole', ['Stewards', META, '', 0])
    : authority.encodeFunctionData('renameSubject', ['9', 'Stewards', META, '']);
  const tx = { hash: TX, blockNumber: 50, blockHash: OLD_HASH, from: ACCOUNT, to: VOTING,
    data: voting.encodeFunctionData('createProposal', [title, META, 10, 2, [[[AUTHORITY, 0, action]], []], []]),
    value: ethers.BigNumber.from(0), chainId: 100 };
  const event = voting.encodeEventLog(voting.getEvent('NewProposal'), [7, title, META, 2, 1600, 1000]);
  const receipt = { status: 1, transactionHash: TX, blockNumber: 50, blockHash: OLD_HASH,
    logs: [{ ...event, address: VOTING, transactionHash: TX, blockNumber: 50, blockHash: OLD_HASH, removed: false }] };
  const row = { id: VOTING + '-7', proposalId: '7', title: 'Historical subject action', descriptionHash: META, numOptions: 2,
    startTimestamp: '1000', endTimestamp: '1600', status: 'Ended', winningOption: null, isValid: true, executionFailed: false,
    executionError: null, isHatRestricted: false, restrictedHatIds: [], proposer: ACCOUNT, proposerUsername: null,
    createdAtBlock: '50', transactionHash: TX, metadata: null, creatorUsername: null, wasExecuted: false, classesVersion: '0',
    classesChange: null, hybridVoting: { id: VOTING, organization: { id: ORG } } };
  const organization = { id: ORG, membershipAuthority: { id: AUTHORITY }, hybridVoting: { id: VOTING } };
  const indexedBlock: { number: number; hash: string; timestamp?: number | null } = { number: 100, hash: HASH, timestamp: 1900 };
  const responses: Record<string, unknown>[] = [];
  const query = vi.fn<Parameters<ProtocolQuery>, ReturnType<ProtocolQuery>>(async (document, variables, at) => {
    expect(at.endpoint).toBe(source.endpoint);
    // An exact hash filter is enforced independently of response block metadata.
    const checkBlock = (block: unknown) => expect(block).toEqual({ hash: HASH });
    const result = await graphql({ schema, source: document, variableValues: variables, rootValue: {
      _meta: ({ block }: { block: unknown }) => { checkBlock(block); return { block: indexedBlock }; },
      organization: ({ id, block }: { id: string; block: unknown }) => { checkBlock(block); return id === ORG ? organization : null; },
      proposals: ({ first, where, block }: { first: number; where: { id?: string; hybridVoting?: string; id_gt?: string }; block: unknown }) => {
        checkBlock(block);
        return [row].filter(r => (!where.id || r.id === where.id) && (!where.hybridVoting || r.hybridVoting.id === where.hybridVoting)
          && (where.id_gt === undefined || r.id > where.id_gt)).slice(0, first);
      },
    } });
    expect(result.errors).toBeUndefined();
    const response = result.data as Record<string, unknown>;
    responses.push(response);
    return response;
  });
  const provider = { getNetwork: vi.fn(async () => ({ chainId: 100 })), getTransaction: vi.fn(async () => tx),
    getTransactionReceipt: vi.fn(async () => receipt), getBlock: vi.fn(async (tag: string) => tag === '0x32'
      ? { number: 50, hash: OLD_HASH, timestamp: 1000 } : { number: 100, hash: HASH, timestamp: 1900 }) };
  const input = { scope, source, rpcSource: { ...source, indexed: false, endpoint: 'mock://timestamp-rpc', method: 'exact-receipt' },
    proposalId: '7', query, provider: provider as any, freshness };
  return { input, query, provider, indexedBlock, responses, row, organization, tx, receipt };
}
function ready<T>(result: PlanResult<T>): T {
  expect(result.status, JSON.stringify(result)).toBe('ready');
  if (result.status !== 'ready') throw new Error('Blocked proof');
  return result.data;
}

describe('timestamp-bearing exact subject provenance, offline only', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Offline test attempted network access'); })));
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])('recovers a nonempty real archive through canonical call/event, createsSubject=%s', async createsSubject => {
    const f = fixture(createsSubject);
    // The actual archive promotes independently selected timestamp metadata even
    // when its caller only requested number/hash. Recovery must retain that pin.
    const archiveSource = { ...source, block: { number: '100', hash: HASH } };
    const history = await readProposalArchive({ source: archiveSource, query: f.query, lane: 'hybrid', pageSize: 2, maxPages: 1 });
    expect(requireCompleteSnapshot(history, { scope, indexed: true, snapshot: 'pinned' })).toHaveLength(1);
    expect(history.source.block).toEqual(source.block);
    const proof = ready(await readSubjectCreationProvenance({ ...f.input, source: history.source }));
    expect(proof.indexedSource.block).toEqual(source.block);
    expect(proof).toMatchObject({ id: f.row.id, createsSubject, transactionHash: TX, receiptBlock: { number: '50', hash: OLD_HASH } });
    expect(subjectCreationRaceFacts(history as any, scope).hasCompetingCreation.state).toBe('unknown');
    const recovered = recoverSubjectCreationHistory(history as any, [proof]);
    expect(subjectCreationRaceFacts(recovered, scope).hasCompetingCreation).toMatchObject({ state: 'known', value: createsSubject });
    expect(recovered.source).toBe(history.source);
    expect(recovered.coverage).toBe(history.coverage);
    expect(history.data[0]).not.toHaveProperty('createsSubject');
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls[1][1]).toEqual({ orgId: ORG, id: f.row.id, block: { hash: HASH } });
    expect(f.responses[1]).not.toHaveProperty('proposals.0.wasExecuted');
    expect(f.responses[1]).toHaveProperty('_meta.block.timestamp', 1900);
    expect(f.provider.getTransaction).toHaveBeenCalledOnce();
    expect(f.provider.getTransaction).toHaveBeenCalledWith(TX);
    expect(f.provider.getTransactionReceipt).toHaveBeenCalledOnce();
    expect(f.provider.getTransactionReceipt).toHaveBeenCalledWith(TX);
    expect(f.provider.getBlock.mock.calls.map(c => c[0])).toEqual([HASH, '0x64', '0x32', '0x64']);
  });

  it('proves the transport omits unselected timestamp metadata', async () => {
    const f = fixture();
    const response = await f.query('query($block: Block_height) { _meta(block: $block) { block { number hash } } }', { block: { hash: HASH } }, source);
    expect(response).toEqual({ _meta: { block: { number: 100, hash: HASH } } });
  });

  it.each([undefined, null, 1901])('fails closed before RPC on indexed timestamp %s', async timestamp => {
    const f = fixture(); f.indexedBlock.timestamp = timestamp;
    expect(await readSubjectCreationProvenance(f.input)).toMatchObject({ status: 'blocked', codes: ['INCOMPLETE_SNAPSHOT'] });
    expect(f.provider.getNetwork).not.toHaveBeenCalled();
  });

  for (const phase of [1, 2, 4]) it.each([undefined, 1901])('fails closed on selected RPC phase ' + phase + ' timestamp %s', async timestamp => {
    const f = fixture(), original = f.provider.getBlock.getMockImplementation()!;
    let calls = 0;
    f.provider.getBlock.mockImplementation(async tag => {
      const block = await original(tag);
      return ++calls === phase ? { ...block, timestamp } as any : block;
    });
    expect((await readSubjectCreationProvenance(f.input)).status).toBe('blocked');
  });

  it.each([
    ['indexed number', (f: ReturnType<typeof fixture>) => { f.indexedBlock.number = 101; }],
    ['indexed hash', f => { f.indexedBlock.hash = OLD_HASH; }],
    ['authority binding', f => { f.organization.membershipAuthority.id = ACCOUNT; }],
    ['proposal ID', f => { f.row.proposalId = '8'; }],
    ['receipt inclusion', f => { f.row.createdAtBlock = '49'; }],
    ['canonical calldata', f => { f.tx.data += '00'; }],
    ['proposal event', f => { f.receipt.logs[0].address = ACCOUNT; }],
  ] as const)('retains %s guard with matching timestamps', async (_, mutate) => {
    const f = fixture(); mutate(f);
    expect((await readSubjectCreationProvenance(f.input)).status).toBe('blocked');
  });

  it('rejects stale or differently timed evidence and recovered history', async () => {
    const f = fixture();
    expect((await readSubjectCreationProvenance({ ...f.input, freshness: { now: 2001, maxAgeSeconds: 0 } })).status).toBe('blocked');
    expect(f.query).not.toHaveBeenCalled();
    expect((await readSubjectCreationProvenance({ ...f.input,
      rpcSource: { ...f.input.rpcSource, block: { ...source.block!, timestamp: '1901' } } })).status).toBe('blocked');
    expect(f.query).not.toHaveBeenCalled();
    const history = await readProposalArchive({ source, query: f.query, lane: 'hybrid' });
    const proof = ready(await readSubjectCreationProvenance(f.input));
    expect(() => recoverSubjectCreationHistory({ ...history, source: { ...source, block: { ...source.block!, timestamp: '1901' } } } as any, [proof])).toThrow('BLOCK_MISMATCH');
  });
});
