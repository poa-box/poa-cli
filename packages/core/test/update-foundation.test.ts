import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import bs58 from 'bs58';
import { build } from 'esbuild';
import { resolve } from 'path';
import { AssetRef, normalizeNativeAsset, parseDecimalAmountToRaw, requireRawUint, sumRawAssetAmounts } from '../src/amounts';
import { assertCoverage, assertPlanScope, assertSourceRef, Coverage, knownFact, PlanResult, requireCompleteSnapshot, SourceRef, SourceSnapshot, unknownFact } from '../src/data/facts';
import { collectCursorPages, CollectCursorPagesOptions, CursorPage } from '../src/graph/pagination';
import { createDocumentQueryAdapter, QueryEnvelope, RawQueryClient, reduceSourceResults } from '../src/graph/sources';
import { cidV0ToBytes32, bytes32ToCidV0, metadataPointerToBytes32 } from '../src/encoding/cid';
import { bytes32ToIpfsCid, ipfsCidToBytes32 } from '../src/encoding';
import { NETWORKS, getTokenByAddress, getTokenDecimals, resolveNetworkConfig } from '../src/chains';
import { GraphClient } from '../src/graph/client';
import { FETCH_ORG_BY_ID } from '../src/graph/documents/org';
import { buildCreateTask } from '../src/tx/task';
import { buildApproveErc20, buildPayErc20 } from '../src/tx/treasury';
import { encodeIntent } from '../src/tx/intent';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const ZERO = ethers.constants.AddressZero;
const HASH = '0x' + 'ab'.repeat(32);
const source: SourceRef = {
  chainId: 100, endpoint: 'https://example.invalid/gnosis', method: 'organizations',
  indexed: true, snapshot: 'pinned', block: { number: '9007199254740993', hash: HASH }, orgId: ADDRESS,
};
const complete: Coverage = { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] };
function snapshot<T>(data: T, ref: SourceRef = source, coverage: Coverage = complete): SourceSnapshot<T> {
  return { source: ref, data, coverage };
}
type Row = { id: string; supported?: boolean };
const row = (id: number, supported = true): Row => ({ id: String(id).padStart(4, '0'), supported });
function pages(fetchPage: CollectCursorPagesOptions<Row>['fetchPage'], overrides: Partial<CollectCursorPagesOptions<Row>> = {}) {
  return collectCursorPages({
    source, fetchPage, cursor: { initial: '0000', fromRow: r => r.id, compare: (a, b) => a < b ? -1 : a > b ? 1 : 0 },
    pageSize: 2, maxPages: 4, shortPageMeansComplete: true, ...overrides,
  });
}

describe('exact raw units and asset invariants', () => {
  it.each([
    ['0.000000000000000001', 18, '1'], ['0.000001', 6, '1'], ['1.000001', 6, '1000001'],
    ['9007199254740993', 0, '9007199254740993'], ['9007199254740993.123456', 6, '9007199254740993123456'],
    ['1.234567890123456789', 18, '1234567890123456789'], ['0001.00', 6, '1000000'], ['0', 18, '0'],
  ])('scales literal %s with %i decimals exactly', (text, decimals, raw) => {
    expect(parseDecimalAmountToRaw(text as string, decimals as number)).toBe(raw);
    // Independent ethers parser parity for valid literal inputs.
    expect(parseDecimalAmountToRaw(text as string, decimals as number)).toBe(ethers.utils.parseUnits(text as string, decimals as number).toString());
  });
  it.each(['1e3', '+1', '-1', '-0', ' 1', '1 ', '.1', '1.', 'NaN', 'Infinity', '1,000', '1.0000000', '0x01', ''])('refuses unsanitized decimal %s', text => {
    expect(() => parseDecimalAmountToRaw(text, 6)).toThrow();
  });
  it('rejects all float/unsafe/overflow uint inputs and never rounds', () => {
    for (const input of [-1, -0, 1.1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '-1', '1.0', '1e6', '0xff', ' 1', 1n << 256n]) expect(() => requireRawUint(input)).toThrow();
    expect(requireRawUint((1n << 256n) - 1n)).toBe(((1n << 256n) - 1n).toString());
    expect(requireRawUint(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    expect(requireRawUint('0001')).toBe('1');
    expect(requireRawUint('255', 8)).toBe('255');
    expect(() => requireRawUint('256', 8)).toThrow();
    expect(() => parseDecimalAmountToRaw(((1n << 256n) - 1n).toString(), 1)).toThrow();
    for (const decimals of [-1, 256, 1.5, NaN]) expect(() => parseDecimalAmountToRaw('1', decimals)).toThrow();
    for (const bits of [0, 257, 1.5]) expect(() => requireRawUint('1', bits)).toThrow();
  });
  it('keeps chains, precision and native aliases separate; sums exact zero and >2^53', () => {
    const asset: AssetRef = { chainId: 100, address: ADDRESS, decimals: 18 };
    const amounts = [
      { asset, rawAmount: '9007199254740993' }, { asset, rawAmount: '7' },
      { asset: { ...asset, chainId: 42161 }, rawAmount: '2' },
      { asset: { ...asset, decimals: 6 }, rawAmount: '3' },
      { asset: { ...asset, address: ZERO }, rawAmount: '0' },
    ];
    expect(sumRawAssetAmounts(amounts).map(a => a.rawAmount)).toEqual(['9007199254741000', '2', '3', '0']);
    expect(amounts[0].rawAmount).toBe('9007199254740993');
    expect(() => sumRawAssetAmounts([{ asset, rawAmount: ((1n << 256n) - 1n).toString() }, { asset, rawAmount: '1' }])).toThrow();
    const alias = { ...asset, address: '0x' + 'e'.repeat(40) };
    const native = { ...asset, address: ZERO };
    expect(sumRawAssetAmounts([{ asset: alias, rawAmount: '1' }, { asset: native, rawAmount: '1' }])).toHaveLength(2);
    expect(normalizeNativeAsset(alias, native, [])).toEqual(alias);
    expect(normalizeNativeAsset(alias, native, [alias.address])).toEqual(native);
    expect(normalizeNativeAsset({ ...alias, chainId: 1 }, native, [alias.address]).chainId).toBe(1);
    expect(() => normalizeNativeAsset({ ...alias, decimals: 6 }, native, [alias.address])).toThrow();
  });
});

describe('CID digest pointers and tolerant CLI compatibility', () => {
  const digest = '0x' + '01'.repeat(32);
  // Oracle is the literal sha2-256 multihash, independently encoded by bs58.
  const cid = bs58.encode(Uint8Array.from([0x12, 0x20, ...Array(32).fill(1)]));
  it('stores the SHA-256 digest rather than hashing CID text, preserves raw bytes32', () => {
    expect(cidV0ToBytes32(cid)).toBe(digest);
    expect(bytes32ToCidV0(digest)).toBe(cid);
    expect(metadataPointerToBytes32(cid)).toBe(digest);
    expect(metadataPointerToBytes32(HASH)).toBe(HASH);
    expect(cidV0ToBytes32(cid)).not.toBe(ethers.utils.keccak256(ethers.utils.toUtf8Bytes(cid)));
    expect(ipfsCidToBytes32(cid)).toBe(digest);
    expect(bytes32ToIpfsCid(digest)).toBe(cid);
  });
  it('strict CID rejects non-CIDv0, incorrect multihash prefix/length, and empty digest', () => {
    const zeroCid = bs58.encode(Uint8Array.from([0x12, 0x20, ...Array(32).fill(0)]));
    for (const input of ['', 'bafybeigdyrzt', 'text', digest, zeroCid,
      bs58.encode(Uint8Array.from([0x12, 0x21, ...Array(32).fill(1)])),
      bs58.encode(Uint8Array.from([0x12, 0x20, ...Array(31).fill(1)])), 'Qm0invalid']) expect(() => cidV0ToBytes32(input)).toThrow();
    for (const input of ['', ZERO, '0x01', ethers.constants.HashZero, '0x' + 'gg'.repeat(32)]) {
      expect(() => bytes32ToCidV0(input)).toThrow();
      expect(() => metadataPointerToBytes32(input)).toThrow();
    }
  });
  it('old exports keep blank/raw/text hashing and permissive decoding behavior', () => {
    expect(ipfsCidToBytes32('')).toBe(ethers.constants.HashZero);
    expect(ipfsCidToBytes32('0x' + 'zz'.repeat(32))).toBe('0x' + 'zz'.repeat(32));
    expect(ipfsCidToBytes32('bafybeigdyrzt')).toBe(ethers.utils.id('bafybeigdyrzt'));
    expect(ipfsCidToBytes32('plain text')).toBe(ethers.utils.id('plain text'));
    expect(bytes32ToIpfsCid(ethers.constants.HashZero)).toBeNull();
    expect(bytes32ToIpfsCid('0x01')).toBe(bs58.encode(Uint8Array.from([0x12, 0x20, 1])));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(ipfsCidToBytes32('Qm0invalid')).toBe(ethers.constants.HashZero);
    log.mockRestore();
  });
  it('CID leaf bundles for browsers with no ethers, ABI registry, executor or optional peers', async () => {
    const result = await build({ entryPoints: [resolve(__dirname, '../src/encoding/cid.ts')], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true });
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs.some(path => /bs58/.test(path))).toBe(true);
    expect(inputs.filter(path => /ethers|abis|execute|viem|permissionless|src\/index/.test(path))).toEqual([]);
    expect(result.outputFiles[0].text.length).toBeGreaterThan(0);
  });
});

describe('token catalog defects and existing calldata parity', () => {
  it('every catalogued bounty asset has a valid address and deliberate decimals', () => {
    for (const network of Object.values(NETWORKS)) {
      for (const [symbol, address] of Object.entries(network.bountyTokens)) {
        expect(ethers.utils.isAddress(address), `${network.chainId}:${symbol}`).toBe(true);
        const lookup = getTokenByAddress(address);
        expect(lookup?.symbol).toBe(symbol);
        expect(ethers.utils.isAddress(lookup!.address)).toBe(true);
        expect(getTokenByAddress(address.toLowerCase())).toEqual(lookup);
        expect(getTokenDecimals(address)).toBe(symbol === 'USDC' ? 6 : 18);
      }
    }
    expect(NETWORKS.gnosis.bountyTokens.USDC).toBe('0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83');
    expect(getTokenDecimals(NETWORKS.gnosis.bountyTokens.sDAI)).toBe(18);
    expect(Object.keys(getTokenByAddress(NETWORKS.gnosis.bountyTokens.sDAI)!)).toEqual(['symbol', 'decimals', 'address']);
  });
  it('Gnosis USDC 1.000001 encodes 1000001 in current task and treasury builders', () => {
    const token = NETWORKS.gnosis.bountyTokens.USDC;
    const amount = parseDecimalAmountToRaw('1.000001', getTokenDecimals(token));
    const task = buildCreateTask({ taskManagerAddress: ADDRESS, payout: '1', title: 'test', metadataHash: HASH,
      projectId: HASH, bountyToken: token, bountyAmount: '1.000001', features: { deadlines: true } });
    const taskDecoded = new ethers.utils.Interface(task.abi).decodeFunctionData(task.method, encodeIntent(task).data);
    expect(taskDecoded[4]).toBe(token);
    expect(taskDecoded[5].toString()).toBe('1000001');
    const approve = buildApproveErc20({ tokenAddress: token, spender: ADDRESS, amountWei: amount });
    const pay = buildPayErc20({ paymentManagerAddress: ADDRESS, tokenAddress: token, amountWei: amount });
    expect(new ethers.utils.Interface(approve.abi).decodeFunctionData('approve', encodeIntent(approve).data)[1].toString()).toBe('1000001');
    expect(new ethers.utils.Interface(pay.abi).decodeFunctionData('payERC20', encodeIntent(pay).data)[1].toString()).toBe('1000001');
    expect(ethers.utils.isAddress('0xDDAfbb505ad214D7b80b1f830fcCc89B60fB7A83')).toBe(false);
  });
});

describe('fact/snapshot safety gates', () => {
  it('known zero/false survives narrowing; completeness does not populate unknown fields', () => {
    const input = snapshot({ amount: knownFact('0'), enabled: knownFact(false), authority: unknownFact('NOT_POPULATED') });
    expect(requireCompleteSnapshot(input)).toEqual(input.data);
    expect(input.data.enabled).toEqual({ state: 'known', value: false });
    expect(input.data.authority.state).toBe('unknown');
    const plan: PlanResult<string> = { status: 'blocked', codes: ['NOT_POPULATED'], prerequisites: [{ code: 'AUTHORITY_READ', scope: { chainId: 100, contract: ADDRESS } }], consequences: [] };
    expect(plan.status).toBe('blocked');
  });
  it('rejects falsely complete, missing, duplicate and capped coverage instead of clean absence', () => {
    const bad: Coverage[] = [
      { ...complete, status: 'unavailable' }, { ...complete, status: 'incomplete', issues: [{ code: 'PAGE_CAP' }] },
      { ...complete, expectedKeys: ['authority'] }, { ...complete, missingIds: ['authority'] },
      { ...complete, failedIds: ['balance'] }, { ...complete, receivedKeys: ['a', 'a'] },
      { ...complete, receivedKeys: ['a'], expectedKeys: ['a', 'a'] }, { ...complete, issues: [{ code: 'NOT_POPULATED' }] },
    ];
    for (const coverage of bad) expect(() => requireCompleteSnapshot(snapshot([], source, coverage))).toThrow();
    expect(() => requireCompleteSnapshot(snapshot([]), { requiredKeys: ['balance'] })).toThrow();
    expect(() => assertCoverage({ ...complete, pages: -1 })).toThrow();
  });
  it('checks explicit org/chain/account/contracts/endpoint and pinned block without ambient time', () => {
    const scoped = { ...source, account: ADDRESS, contract: OTHER, contracts: { authority: OTHER }, observedAt: 0 };
    expect(() => assertPlanScope(scoped, { chainId: 100, orgId: ADDRESS.toUpperCase().replace('0X', '0x'), account: ADDRESS, contracts: { authority: OTHER } })).not.toThrow();
    for (const expected of [
      { chainId: 42161 }, { chainId: 100, orgId: OTHER }, { chainId: 100, account: OTHER },
      { chainId: 100, contract: ADDRESS }, { chainId: 100, contracts: { payment: ADDRESS } },
      { chainId: 100, endpoint: 'https://example.invalid/other' },
    ]) expect(() => assertPlanScope(scoped, expected)).toThrow();
    expect(requireCompleteSnapshot(snapshot('0', scoped), { indexed: true, snapshot: 'pinned', block: source.block })).toBe('0');
    expect(() => requireCompleteSnapshot(snapshot('0', scoped), { indexed: false })).toThrow();
    expect(() => requireCompleteSnapshot(snapshot('0', scoped), { block: { number: '9007199254740992' } })).toThrow();
    expect(() => requireCompleteSnapshot(snapshot('0', scoped), { block: { number: source.block!.number, timestamp: '100' } })).toThrow();
    expect(() => assertSourceRef({ ...source, block: undefined })).toThrow();
    expect(() => assertSourceRef({ ...source, observedAt: NaN })).toThrow();
  });
});

describe('cursor pagination counterexamples', () => {
  it('saturated pages require another page and unsupported pages advance unfiltered cursor', async () => {
    const fetch = vi.fn(async ({ cursor }) => ({ rows: cursor === '0000' ? [row(1, false), row(2, false)] : [row(3)] }));
    const result = await pages(fetch, { include: r => r.supported === true });
    expect(fetch.mock.calls.map(([request]) => request.cursor)).toEqual(['0000', '0002']);
    expect(result.data).toEqual([row(3)]);
    expect(result.coverage.receivedKeys).toEqual(['0001', '0002', '0003']);
    expect(result.coverage.status).toBe('complete');
  });
  it('later page errors retain the earlier rows and reject safety planning', async () => {
    const result = await pages(async ({ page }) => { if (page === 2) throw new Error('offline'); return { rows: [row(1), row(2)] }; });
    expect(result.data).toEqual([row(1), row(2)]);
    expect(result.coverage.status).toBe('incomplete');
    expect(result.coverage.failedIds).toEqual(['page:2']);
    expect(() => requireCompleteSnapshot(result)).toThrow();
  });
  it.each([
    [[row(1), row(1)], 'DUPLICATE_CURSOR_OR_KEY'], [[row(2), row(1)], 'NONADVANCING_CURSOR'],
  ])('refuses duplicate/out-of-order cursor rows', async (rows, code) => {
    const result = await pages(async () => ({ rows: rows as Row[] }));
    expect(result.coverage.status).toBe('incomplete');
    expect(result.coverage.issues.map(issue => issue.code)).toContain(code);
    expect(result.data.length).toBeGreaterThan(0);
  });
  it('repeated cross-page cursor and repeated row ID are both incomplete', async () => {
    const result = await pages(async ({ page }) => ({ rows: page === 1 ? [row(1), row(2)] : [row(2)] }));
    expect(result.data).toEqual([row(1), row(2)]);
    expect(result.coverage.status).toBe('incomplete');
    const duplicateId = await pages(async () => ({ rows: [row(1), row(2)] }), { rowKey: () => 'same' });
    expect(duplicateId.coverage.status).toBe('incomplete');
  });
  it('missing/null collection and first page failure are unavailable, never empty success', async () => {
    for (const fetch of [async () => ({}), async () => ({ rows: null }), async () => { throw new Error('network'); }]) {
      const result = await pages(fetch);
      expect(result.data).toEqual([]);
      expect(result.coverage.status).toBe('unavailable');
      expect(() => requireCompleteSnapshot(result)).toThrow();
    }
  });
  it('valid empty page needs explicit schema completion semantics; caps retain evidence', async () => {
    expect((await pages(async () => ({ rows: [] }))).coverage.status).toBe('complete');
    expect((await pages(async () => ({ rows: [] }), { shortPageMeansComplete: false })).coverage.issues[0].code).toBe('COMPLETION_UNPROVEN');
    expect((await pages(async () => ({ rows: [], complete: true }), { shortPageMeansComplete: false })).coverage.status).toBe('complete');
    expect((await pages(async () => ({ rows: [], complete: false }))).coverage.status).toBe('incomplete');
    const cap = await pages(async () => ({ rows: [row(1), row(2)] }), { maxPages: 1 });
    expect(cap.data).toHaveLength(2);
    expect(cap.coverage.issues[0].code).toBe('PAGE_CAP');
    const rowCap = await pages(async ({ page }) => ({ rows: page === 1 ? [row(1), row(2)] : [row(3), row(4)] }), { maxRows: 3 });
    expect(rowCap.data).toEqual([row(1), row(2), row(3)]);
    expect(rowCap.coverage.issues[0].code).toBe('ROW_CAP');
  });
  it('partial GraphQL errors and changed source blocks remain incomplete with retained rows', async () => {
    const partial = await pages(async () => ({ rows: [row(1)], issues: [{ code: 'GRAPHQL_VALIDATION_FAILED' }] }));
    expect(partial.data).toEqual([row(1)]);
    expect(partial.coverage.status).toBe('incomplete');
    const drift = await pages(async ({ page }) => ({ rows: page === 1 ? [row(1), row(2)] : [row(3)], source: page === 1 ? source : { ...source, block: { number: '9007199254740994' } } }));
    expect(drift.data).toHaveLength(3);
    expect(drift.coverage.issues.map(issue => issue.code)).toContain('PAGE_SOURCE_MISMATCH');
  });
});

describe('multi-source evidence and parsed-document host boundary', () => {
  const other: SourceRef = { ...source, chainId: 42161, endpoint: 'https://example.invalid/arbitrum' };
  it('failed/missing/incomplete sources never reduce to empty success, and rows stay source-qualified', () => {
    const result = reduceSourceResults([source, other], [
      { status: 'fulfilled', snapshot: snapshot([row(1)]) }, { status: 'rejected', source: other, code: 'SCHEMA_UNAVAILABLE' },
    ], { blockAlignment: 'independent' });
    expect(result.data).toEqual([row(1)]);
    expect(result.sources[0].source.chainId).toBe(100);
    expect(result.coverage.status).toBe('incomplete');
    expect(result.coverage.failedIds).toHaveLength(1);
    expect(result.blockAlignment.state).toBe('unknown');
    expect(reduceSourceResults([source], [], { blockAlignment: 'independent' }).coverage.status).toBe('unavailable');
    expect(reduceSourceResults([source], [{ status: 'fulfilled', snapshot: snapshot([], source, { ...complete, status: 'unavailable' }) }], { blockAlignment: 'independent' }).coverage.status).toBe('unavailable');
  });
  it('requires explicitly pinned same-chain blocks, never rounds block IDs or merges forks', () => {
    const second = { ...source, method: 'holders' };
    const aligned = reduceSourceResults([source, second], [
      { status: 'fulfilled', snapshot: snapshot([], source) }, { status: 'fulfilled', snapshot: snapshot([], second) },
    ], { blockAlignment: 'same-chain-block' });
    expect(aligned.coverage.status).toBe('complete');
    expect(aligned.blockAlignment.state).toBe('known');
    for (const ref of [{ ...second, block: { number: '9007199254740992', hash: HASH } }, { ...second, block: { number: source.block!.number, hash: '0x' + 'cd'.repeat(32) } }]) {
      expect(reduceSourceResults([source, ref], [{ status: 'fulfilled', snapshot: snapshot([], source) }, { status: 'fulfilled', snapshot: snapshot([], ref) }], { blockAlignment: 'same-chain-block' }).coverage.status).toBe('incomplete');
    }
  });
  it('duplicate/unexpected source results cannot cover a missing expected endpoint', () => {
    const result = reduceSourceResults([source, other], [
      { status: 'fulfilled', snapshot: snapshot([row(1)]) },
      { status: 'fulfilled', snapshot: snapshot([row(2)]) },
      { status: 'fulfilled', snapshot: snapshot([row(3)], { ...other, chainId: 1 }) },
    ], { blockAlignment: 'independent' });
    expect(result.data).toEqual([row(1)]);
    expect(result.coverage.missingIds).toHaveLength(1);
    expect(result.coverage.issues.map(issue => issue.code)).toEqual(['DUPLICATE_SOURCE', 'UNEXPECTED_SOURCE']);
    expect(result.coverage.status).toBe('incomplete');
  });
  it('latest responses with equal heights do not establish a pinned snapshot', () => {
    const latest = { ...source, snapshot: 'latest' as const };
    const result = reduceSourceResults([latest], [{ status: 'fulfilled', snapshot: snapshot([], latest) }], { blockAlignment: 'same-chain-block' });
    expect(result.blockAlignment).toEqual({ state: 'unknown', code: 'BLOCK_ALIGNMENT_UNPROVEN' });
    expect(result.coverage.status).toBe('incomplete');
    expect(() => requireCompleteSnapshot(snapshot([], latest), { snapshot: 'pinned' })).toThrow();
  });
  it('parses canonical documents once; isolates clients/caches by endpoint and scope', async () => {
    const parse = vi.fn((text: string) => ({ text }));
    const createClient = vi.fn((endpoint: string) => ({ endpoint, cache: new Map<string, unknown>() }));
    const requests: string[] = [];
    const adapter = createDocumentQueryAdapter({ parse, createClient,
      async execute<T>(client: ReturnType<typeof createClient>, request: { document: { text: string }; source: SourceRef }): Promise<QueryEnvelope<T>> {
        requests.push(client.endpoint);
        client.cache.set(request.source.orgId!, request.source.chainId);
        return { data: { orgId: request.source.orgId, chainId: request.source.chainId } as T };
      },
    });
    await adapter.query(source, FETCH_ORG_BY_ID, { id: ADDRESS });
    await adapter.query(source, FETCH_ORG_BY_ID, { id: ADDRESS });
    const result = await adapter.query<{ chainId: number }>(other, FETCH_ORG_BY_ID, { id: ADDRESS });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(result.data?.chainId).toBe(42161);
    expect(requests).toEqual([source.endpoint, source.endpoint, other.endpoint]);
    expect(createClient.mock.results[0].value.cache.get(ADDRESS)).toBe(100);
    expect(createClient.mock.results[1].value.cache.get(ADDRESS)).toBe(42161);
  });
  it('normalizes partial/HTTP/schema failures with no retired-schema rescue', async () => {
    const execute = vi.fn(async <T>(): Promise<QueryEnvelope<T>> => ({ data: { rows: [row(1)] } as T, errors: [{ extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] }));
    const adapter = createDocumentQueryAdapter({ parse: (text: string) => text, createClient: (endpoint: string) => endpoint, execute: async <T>() => await execute() as QueryEnvelope<T> });
    const partial = await adapter.query<{ rows: Row[] }>(source, FETCH_ORG_BY_ID);
    const result = await pages(async (): Promise<CursorPage<Row>> => ({ rows: partial.data?.rows, issues: partial.issues, source: partial.source }));
    expect(result.data).toEqual([row(1)]);
    expect(result.coverage.status).toBe('incomplete');
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockRejectedValueOnce(new Error('HTTP 500'));
    const failed = await adapter.query(source, FETCH_ORG_BY_ID);
    expect(failed.data).toBeUndefined();
    expect(failed.issues).toEqual([{ code: 'QUERY_FAILED' }]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('maps literal host endpoints using org chain, while wallet chain and product subset are separate', async () => {
    const network = resolveNetworkConfig(100, { POP_DEFAULT_CHAIN: '42161', POP_GNOSIS_SUBGRAPH: ' https://example.invalid/host-gnosis \n', POP_ARBITRUM_SUBGRAPH: other.endpoint });
    expect(network.resolvedSubgraph).toBe('https://example.invalid/host-gnosis');
    expect(network.nativeCurrency).toEqual({ name: 'xDAI', symbol: 'xDAI', decimals: 18 });
    expect(() => resolveNetworkConfig(999999)).toThrow(/Unsupported chain/);
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ data: { organization: { id: ADDRESS } } }), { status: 200 }));
    const client: RawQueryClient = new GraphClient({ defaultChainId: 42161, fetch });
    await client.queryUrl(network.resolvedSubgraph, FETCH_ORG_BY_ID, { id: ADDRESS });
    expect(fetch.mock.calls[0][0]).toBe(network.resolvedSubgraph);
    const explicitProductSources = [source, other];
    const result = reduceSourceResults(explicitProductSources, explicitProductSources.map(ref => ({ status: 'fulfilled' as const, snapshot: snapshot([], ref) })), { blockAlignment: 'independent' });
    expect(result.sources.map(s => s.source.chainId)).toEqual([100, 42161]);
    expect(result.sources.some(s => NETWORKS.ethereum.chainId === s.source.chainId || NETWORKS.sepolia.chainId === s.source.chainId)).toBe(false);
  });
});
