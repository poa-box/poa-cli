import { describe, expect, it, vi } from 'vitest';
import { checkBrowserConfiguration, diagnoseBrowserConfiguration, detectBrowserCapabilities,
  type BrowserConfiguration, type BrowserFeature, type ConfigurationReport, type SetupReaders } from '../../src/config';

const address = '0x' + '12'.repeat(20);
const capabilities = { secureContext: true, webAuthn: true, indexedDB: true, webLocks: true };
function configuration(): BrowserConfiguration {
  return { chainId: 100, orgId: '0x' + '23'.repeat(32),
    endpoints: { rpc: 'https://rpc.example/?apikey=do-not-leak', indexer: 'https://index.example/query',
      bundler: 'https://bundler.example/', metadata: 'https://documents.example/', email: 'https://email.example/' },
    modules: { membershipAuthority: address, taskManager: address, directDemocracyVoting: address, hybridVoting: address,
      executor: address, accountRegistry: address, passkeyFactory: address, quickJoin: address, zkEmailInvites: address },
    wallet: { kind: 'eoa', account: address, chainId: 100 },
    passkey: { rpId: 'example.org', rpName: 'Example', origin: 'https://app.example.org' } };
}
const row = (report: ConfigurationReport, feature: BrowserFeature) => report.features.find(value => value.feature === feature)!;
const readers = (): SetupReaders => ({ readChainId: vi.fn(async () => 100), getBytecode: vi.fn(async () => '0x6001'),
  readIndexStatus: vi.fn(async () => ({ chainId: 100, blockNumber: 50, hasIndexingErrors: false })), checkService: vi.fn(async () => true) });

describe('browser setup inspection', () => {
  it('does not equate configured URLs or modules with a verified deployment', () => {
    const result = checkBrowserConfiguration(configuration(), capabilities);
    expect(result.valid).toBe(true); expect(result.networkChecked).toBe(false);
    for (const feature of ['reads', 'passkey', 'role', 'poll', 'ballot', 'task-create', 'enrollment'] as const) expect(row(result, feature).state).toBe('unknown');
    expect(result.authorization).toBe(false); expect(result.features.every(value => value.authorization === false)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('do-not-leak');
  });
  it.each(['http://remote.example', 'javascript:alert(1)', 'https://user:password@example.org', 'https://example.org/#secret', ' https://example.org'])('refuses malformed or insecure endpoint %s', value => {
    const config = configuration(); config.endpoints.rpc = value;
    expect(checkBrowserConfiguration(config).issues).toContainEqual({ field: 'endpoints.rpc', code: 'INVALID_ENDPOINT' });
  });
  it('accepts explicit localhost development endpoints', () => {
    const config = configuration(); config.endpoints.rpc = 'http://localhost:8545';
    expect(checkBrowserConfiguration(config).valid).toBe(true);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid chain %s', value => {
    const config = configuration(); config.chainId = value;
    expect(checkBrowserConfiguration(config).valid).toBe(false);
  });
  it('exposes account/chain mismatch rather than declaring the wallet ready', () => {
    const config = configuration(); config.wallet!.chainId = 42161;
    expect(row(checkBrowserConfiguration(config, capabilities), 'wallet').state).toBe('misconfigured');
  });
  it('validates zero addresses and organization identity', () => {
    const config = configuration(); config.modules!.taskManager = '0x' + '0'.repeat(40); config.orgId = '0x' + '0'.repeat(64);
    expect(checkBrowserConfiguration(config).issues.map(value => value.code)).toEqual(['INVALID_ORGANIZATION_ID', 'INVALID_MODULE_ADDRESS']);
  });
  it('treats missing configuration separately from unsupported capabilities', () => {
    const result = checkBrowserConfiguration({ chainId: 100, endpoints: {} });
    expect(row(result, 'reads').state).toBe('unknown'); expect(row(result, 'cashout').state).toBe('unsupported');
  });
  it('does not authorize a related origin from a local allowlist', () => {
    const config = configuration(); config.passkey!.origin = 'https://another.example'; config.passkey!.relatedOrigins = ['https://another.example'];
    const result = checkBrowserConfiguration(config, capabilities);
    expect(result.valid).toBe(true); expect(row(result, 'passkey').reasons).toContain('RELATED_ORIGIN_BROWSER_VERIFICATION_REQUIRED');
  });
  it('rejects an unconfigured cross-domain origin and origin paths', () => {
    const config = configuration(); config.passkey!.origin = 'https://another.example';
    expect(checkBrowserConfiguration(config).issues.map(value => value.code)).toContain('PASSKEY_ORIGIN_NOT_CONFIGURED');
    config.passkey!.origin = 'https://app.example.org/path';
    expect(checkBrowserConfiguration(config).issues.map(value => value.code)).toContain('INVALID_PASSKEY_ORIGIN');
  });
  it('reports malformed relatedOrigins without throwing during inspection', () => {
    const config = configuration(); config.passkey!.origin = 'https://another.example';
    (config.passkey as any).relatedOrigins = {};
    expect(checkBrowserConfiguration(config).issues.map(value => value.code)).toContain('INVALID_RELATED_ORIGINS');
  });
  it('inspects capability presence without invoking browser APIs', () => {
    const open = vi.fn(), request = vi.fn(), create = vi.fn(), get = vi.fn();
    expect(detectBrowserCapabilities({ isSecureContext: true, indexedDB: { open }, navigator: { credentials: { create, get }, locks: { request } } })).toEqual(capabilities);
    for (const call of [open, request, create, get]) expect(call).not.toHaveBeenCalled();
    expect(detectBrowserCapabilities({})).toEqual({ secureContext: false, webAuthn: false, indexedDB: false, webLocks: false });
  });
});

describe('bounded read-only setup diagnostics', () => {
  it('checks actual chain, index and bytecode, preserving unknown policy', async () => {
    const result = await diagnoseBrowserConfiguration(configuration(), { capabilities, readers: readers() });
    for (const feature of ['reads', 'role', 'poll', 'ballot', 'task-create', 'task-claim', 'task-complete', 'enrollment', 'passkey'] as const) expect(row(result, feature).state, feature).toBe('available');
    expect(row(result, 'sponsored').state).toBe('unknown'); expect(row(result, 'email').state).toBe('unknown');
    expect(result.authorization).toBe(false); expect(JSON.stringify(result)).not.toContain('apikey');
  });
  it('does not invoke ports when local configuration is invalid', async () => {
    const config = configuration(); config.chainId = 0; const ports = readers();
    await diagnoseBrowserConfiguration(config, { readers: ports });
    for (const call of Object.values(ports)) expect(call).not.toHaveBeenCalled();
  });
  it('does not fabricate network availability without explicit reader ports', async () => {
    expect(row(await diagnoseBrowserConfiguration(configuration(), { capabilities }), 'reads').state).toBe('unknown');
  });
  it('propagates wrong-chain observations to dependent workflows', async () => {
    const ports = readers(); ports.readChainId = async () => 42161;
    const result = await diagnoseBrowserConfiguration(configuration(), { capabilities, readers: ports });
    expect(row(result, 'reads').state).toBe('unavailable'); expect(row(result, 'poll').state).toBe('unavailable');
    expect(row(result, 'passkey').state).toBe('unavailable'); expect(row(result, 'sponsored').state).toBe('unavailable');
  });
  it.each(['0x', '0x00', '0xabc', 'garbage'])('does not report a module available for bytecode %s', async value => {
    const ports = readers(); ports.getBytecode = async () => value;
    expect(row(await diagnoseBrowserConfiguration(configuration(), { capabilities, readers: ports }), 'role').state).toBe('unavailable');
  });
  it('keeps index errors and transport failures visible without leaking errors', async () => {
    const ports = readers(); ports.readIndexStatus = async () => { throw new Error('https://secret.example/?apikey=secret'); };
    const result = await diagnoseBrowserConfiguration(configuration(), { capabilities, readers: ports });
    expect(row(result, 'reads').state).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('refuses an index from another chain or with indexing errors', async () => {
    for (const observation of [{ chainId: 42161, blockNumber: 20, hasIndexingErrors: false }, { chainId: 100, blockNumber: 20, hasIndexingErrors: true }]) {
      const ports = readers(); ports.readIndexStatus = async () => observation;
      expect(row(await diagnoseBrowserConfiguration(configuration(), { capabilities, readers: ports }), 'reads').state).toBe('unavailable');
    }
  });
  it('snapshots caller configuration before awaited work', async () => {
    const config = configuration(), ports = readers(); ports.readChainId = async () => { config.chainId = 42161; return 100; };
    expect(row(await diagnoseBrowserConfiguration(config, { capabilities, readers: ports }), 'reads').state).toBe('available');
  });
  it('times out a reader that ignores cancellation', async () => {
    const ports = readers(); ports.readChainId = () => new Promise(() => {});
    const result = await diagnoseBrowserConfiguration(configuration(), { capabilities, readers: ports, timeoutMs: 10 });
    expect(row(result, 'reads').state).toBe('unknown'); expect(row(result, 'reads').reasons).toContain('DIAGNOSTIC_TIMEOUT');
  });
  it('handles an already-cancelled and an in-flight aborted diagnostic without ready results', async () => {
    const controller = new AbortController(); controller.abort(); const ports = readers();
    const first = await diagnoseBrowserConfiguration(configuration(), { capabilities, readers: ports, signal: controller.signal });
    expect(row(first, 'wallet').state).toBe('unknown'); expect(ports.readChainId).not.toHaveBeenCalled();
    const active = new AbortController(); ports.readChainId = async () => { active.abort(); return 100; };
    const result = await diagnoseBrowserConfiguration(configuration(), { capabilities, readers: ports, signal: active.signal });
    expect(row(result, 'reads').reasons).toContain('DIAGNOSTIC_CANCELLED');
  });
  it('keeps related-origin configuration unverified after all network checks', async () => {
    const config = configuration(); config.passkey!.origin = 'https://another.example'; config.passkey!.relatedOrigins = ['https://another.example'];
    expect(row(await diagnoseBrowserConfiguration(config, { capabilities, readers: readers() }), 'passkey').state).toBe('unknown');
  });
});
