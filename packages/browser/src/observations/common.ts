import { ethers } from 'ethers';
import { requireRawUint } from '@poa-box/core/amounts';
import { assertPlanScope, assertSourceBlock, knownFact, requireCompleteSnapshot, SourceBlock, SourceRef, SourceSnapshot } from '@poa-box/core/data/facts';
import { readAuthoritySnapshot, authorityAccountActivationMemberships } from '@poa-box/core/reads/authority';
import type { ProtocolQuery } from '@poa-box/core/reads/protocol';
import type { WorkflowScope, WorkflowSources } from '../workflows/types';

export interface ObservationProvider {
  getNetwork(): Promise<{ chainId: number }>;
  getBlock(block: number | 'latest'): Promise<{ number: number; hash: string; timestamp: number } | null>;
  getStorageAt?(address: string, slot: string, block: number): Promise<string>;
  getCode?(address: string, block: number): Promise<string>;
  call(transaction: { to: string; from?: string; data: string; value?: string }, block: number): Promise<string>;
}
export interface ObservationLimits { pageSize?: number; maxPages?: number; maxRows?: number; timeoutMs?: number; maxBlockLag?: number }
export interface WorkflowReaderOptions {
  /** Current authority-bound V2 modules and the complete V2 indexed schema only. */
  deployment: 'authority-v2'; scope: WorkflowScope; sources: WorkflowSources;
  provider: ObservationProvider; query: ProtocolQuery; limits?: ObservationLimits;
}
export const complete = () => ({ status: 'complete' as const, receivedKeys: [], missingIds: [], failedIds: [], issues: [] });
export function fail(code: string): never { throw Object.assign(new Error(code), { code, workflowState: 'unknown' }); }
export function address(value: unknown): string {
  if (typeof value !== 'string' || !ethers.utils.isAddress(value) || value.toLowerCase() === ethers.constants.AddressZero) fail('OBSERVATION_ADDRESS_UNAVAILABLE');
  return value.toLowerCase();
}
export function bool(value: unknown): boolean { if (typeof value !== 'boolean') fail('OBSERVATION_BOOLEAN_UNAVAILABLE'); return value; }
export function uint(value: unknown, bits?: number): string {
  if (value === undefined || value === null) fail('OBSERVATION_UINT_UNAVAILABLE');
  return requireRawUint(ethers.BigNumber.isBigNumber(value) ? value.toString() : value as string | number, bits);
}
export function normalizeScope(input: WorkflowScope): WorkflowScope {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0 || !/^0x[\da-f]{64}$/i.test(input.orgId)) fail('OBSERVATION_SCOPE_REQUIRED');
  return Object.freeze({ chainId: input.chainId, orgId: input.orgId.toLowerCase(), account: address(input.account),
    contracts: Object.freeze(Object.fromEntries(Object.entries(input.contracts).map(([key, value]) => [key, address(value)]))) });
}
const HEAD = 'query WorkflowObservationHead { _meta { hasIndexingErrors block { number hash timestamp } } }';
export class ObservationRuntime {
  readonly scope: WorkflowScope; readonly sources: WorkflowSources;
  readonly pageSize: number; readonly maxPages: number; readonly maxRows: number;
  readonly timeoutMs: number; readonly maxBlockLag: number;
  constructor(readonly options: WorkflowReaderOptions) {
    if (options.deployment !== 'authority-v2') fail('UNSUPPORTED_OBSERVATION_DEPLOYMENT');
    this.scope = normalizeScope(options.scope); this.sources = { ...options.sources };
    if (!this.sources.indexedEndpoint || !this.sources.rpcEndpoint || typeof this.sources.now !== 'function') fail('EXPLICIT_OBSERVATION_SOURCES_REQUIRED');
    const limits = options.limits ?? {};
    this.pageSize = limits.pageSize ?? 100; this.maxPages = limits.maxPages ?? 20;
    this.maxRows = limits.maxRows ?? this.pageSize * this.maxPages; this.timeoutMs = limits.timeoutMs ?? 15000; this.maxBlockLag = limits.maxBlockLag ?? 128;
    for (const [value, maximum] of [[this.pageSize, 1000], [this.maxPages, 1000], [this.maxRows, 100000], [this.timeoutMs, 30000], [this.maxBlockLag, 10000]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('INVALID_OBSERVATION_LIMIT');
    }
  }
  async run<T>(expected: WorkflowScope, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    assertPlanScope({ ...this.scope }, normalizeScope(expected));
    const controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('OBSERVATION_CANCELLED'), { name: 'AbortError' })), { once: true });
      if (controller.signal.aborted) reject(Object.assign(new Error('OBSERVATION_CANCELLED'), { name: 'AbortError' }));
      timer = setTimeout(() => { reject(Object.assign(new Error('OBSERVATION_TIMEOUT'), { workflowState: 'unknown' })); controller.abort(); }, this.timeoutMs);
    });
    try { return await Promise.race([work(controller.signal), stopped]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  }
  guard(signal: AbortSignal) { if (signal.aborted) throw Object.assign(new Error('OBSERVATION_CANCELLED'), { name: 'AbortError' }); }
  now(): number {
    const now = this.sources.now(), age = this.sources.maxAgeSeconds ?? 30;
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(age) || age < 0 || age > 300) fail('INVALID_OBSERVATION_CLOCK');
    return now;
  }
  source(contract: string, indexed: boolean, block: SourceBlock, method: string, account?: string): SourceRef {
    return { ...this.scope, account, contract: address(contract), endpoint: indexed ? this.sources.indexedEndpoint : this.sources.rpcEndpoint,
      indexed, snapshot: 'pinned', block: { ...block }, observedAt: this.now(), method };
  }
  snapshot<T>(data: T, source: SourceRef): SourceSnapshot<T> { return { data, source, coverage: complete() }; }
  async query(document: string, variables: Record<string, unknown>, source: SourceRef, signal: AbortSignal) {
    this.guard(signal);
    // Core authority documents predate timestamp selection; request the real field
    // in every response instead of copying time from another query into evidence.
    const selected = document.replace(/block\s*\{\s*number\s+hash\s*\}/g, 'block { number hash timestamp }')
      .replace(/\$orgId\s*:\s*ID!/g, '$orgId: Bytes!')
      .replace(/(_meta(?:\([^)]*\))?\s*\{)(?!\s*hasIndexingErrors)/g, '$1 hasIndexingErrors ');
    const data = await this.options.query(selected, variables, source); this.guard(signal);
    if (!data || typeof data !== 'object' || (Array.isArray(data.errors) && data.errors.length)) fail('INDEX_QUERY_UNAVAILABLE');
    this.proof(data, source.snapshot === 'pinned' ? source.block : undefined);
    return data;
  }
  proof(data: Record<string, unknown>, expected?: SourceBlock): SourceBlock {
    const meta = data._meta as { hasIndexingErrors?: unknown; block?: { number?: unknown; hash?: unknown; timestamp?: unknown } } | undefined;
    if (!meta?.block || meta.hasIndexingErrors !== false || typeof meta.block.hash !== 'string' || !/^0x[\da-f]{64}$/i.test(meta.block.hash)) fail('INDEX_BLOCK_UNAVAILABLE');
    const block = { number: uint(meta.block.number, 31), hash: meta.block.hash.toLowerCase(), timestamp: uint(meta.block.timestamp, 64) };
    if (expected) assertSourceBlock(block, expected);
    return block;
  }
  async canonical(block: SourceBlock, signal: AbortSignal) {
    const [network, observed] = await Promise.all([this.options.provider.getNetwork(), this.options.provider.getBlock(Number(block.number))]);
    this.guard(signal);
    if (network.chainId !== this.scope.chainId || !observed) fail('RPC_CHAIN_OR_BLOCK_MISMATCH');
    assertSourceBlock({ number: uint(observed.number), hash: observed.hash, timestamp: uint(observed.timestamp) }, block);
    const now = this.now(), age = this.sources.maxAgeSeconds ?? 30;
    if (BigInt(block.timestamp!) > BigInt(now) || BigInt(now) - BigInt(block.timestamp!) > BigInt(age)) fail('INDEX_OBSERVATION_STALE');
  }
  async open(module: 'hybridVoting' | 'directDemocracyVoting' | 'quickJoin' | 'taskManager', signal: AbortSignal): Promise<SourceBlock> {
    const headSource: SourceRef = { ...this.scope, account: undefined, endpoint: this.sources.indexedEndpoint, method: 'workflow-index-head', indexed: true, snapshot: 'latest' };
    const head = await this.query(HEAD, {}, headSource, signal), block = this.proof(head);
    const [latest] = await Promise.all([this.options.provider.getBlock('latest'), this.canonical(block, signal)]);
    this.guard(signal);
    if (!latest || BigInt(uint(latest.number)) < BigInt(block.number) || BigInt(uint(latest.number)) - BigInt(block.number) > BigInt(this.maxBlockLag)) fail('INDEX_LAG_UNAVAILABLE');
    const source = this.source(this.scope.contracts[module], true, block, 'workflow-organization-bindings');
    const query = `query WorkflowOrganizationBindings($orgId: Bytes!, $block: Block_height!) {
      organization(id: $orgId, block: $block) { id executorContract { id } membershipAuthority { id isRouterBound cutoverAt } ${module} { id } }
      _meta(block: $block) { hasIndexingErrors block { number hash timestamp } }
    }`;
    const response = await this.query(query, { orgId: this.scope.orgId, block: { hash: block.hash } }, source, signal); this.proof(response, block);
    const org = response.organization as { id?: string; executorContract?: { id?: string }; membershipAuthority?: { id?: string; isRouterBound?: unknown; cutoverAt?: unknown }; [key: string]: unknown } | undefined;
    if (org?.id?.toLowerCase() !== this.scope.orgId || address(org.executorContract?.id) !== this.scope.contracts.executor
      || address(org.membershipAuthority?.id) !== this.scope.contracts.membershipAuthority || org.membershipAuthority?.isRouterBound !== true
      || BigInt(uint(org.membershipAuthority?.cutoverAt, 64)) <= 0n
      || address((org[module] as { id?: string })?.id) !== this.scope.contracts[module]) fail('ORGANIZATION_MODULE_BINDING_MISMATCH');
    return block;
  }
  async rpc(contract: string, abi: readonly unknown[], method: string, args: readonly unknown[], block: SourceBlock, signal: AbortSignal) {
    this.guard(signal);
    const iface = new ethers.utils.Interface(abi as ConstructorParameters<typeof ethers.utils.Interface>[0]);
    const result = await this.options.provider.call({ to: address(contract), data: iface.encodeFunctionData(method, [...args]) }, Number(block.number));
    this.guard(signal);
    const decoded = iface.decodeFunctionResult(method, result);
    return decoded.length === 1 ? decoded[0] : decoded;
  }
  async authority(block: SourceBlock, signal: AbortSignal) {
    const source = this.source(this.scope.contracts.membershipAuthority, true, block, 'workflow-authority');
    const authority = await readAuthoritySnapshot({ source, pageSize: this.pageSize, maxPages: this.maxPages, maxRows: this.maxRows,
      query: async <T>(ref: SourceRef, document: string, variables: Record<string, unknown>) => {
        const data = await this.query(document, variables, ref, signal); this.proof(data, block);
        return { source: ref, data: data as T, issues: [] };
      } });
    requireCompleteSnapshot(authority, { scope: source, indexed: true, snapshot: 'pinned', block });
    if (authority.data.ready.state !== 'known' || authority.data.ready.value !== true
      || address(authority.data.authority?.executor) !== this.scope.contracts.executor) fail('AUTHORITY_BINDING_UNAVAILABLE');
    return { authority, memberships: authorityAccountActivationMemberships(authority, this.scope.account) };
  }
}
