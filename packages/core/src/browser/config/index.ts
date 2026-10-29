/** Setup diagnostics are observations, never permission to sign or send. */
export type BrowserFeature = 'reads' | 'wallet' | 'passkey' | 'sponsored' | 'metadata'
  | 'role' | 'poll' | 'ballot' | 'task-create' | 'task-claim' | 'task-complete' | 'enrollment' | 'email' | 'cashout';
export type ModuleName = 'membershipAuthority' | 'taskManager' | 'directDemocracyVoting' | 'hybridVoting'
  | 'executor' | 'accountRegistry' | 'passkeyFactory' | 'quickJoin' | 'zkEmailInvites';
export type EndpointName = 'rpc' | 'indexer' | 'bundler' | 'metadata' | 'email';
export type SetupState = 'available' | 'misconfigured' | 'unavailable' | 'unknown' | 'unsupported';
export interface BrowserConfiguration {
  chainId: number;
  orgId?: string;
  endpoints: Partial<Record<EndpointName, string>>;
  modules?: Partial<Record<ModuleName, string>>;
  wallet?: { kind: 'eoa' | 'passkey' | 'sponsored'; account: string; chainId: number };
  passkey?: { rpId: string; rpName: string; origin: string; relatedOrigins?: readonly string[] };
}
export interface BrowserCapabilities {
  secureContext?: boolean;
  webAuthn?: boolean;
  indexedDB?: boolean;
  webLocks?: boolean;
}
export interface SetupIssue { code: string; field: string }
export interface FeatureSetup {
  feature: BrowserFeature;
  state: SetupState;
  reasons: readonly string[];
  /** Even available setup does not prove current contract permission or funding. */
  authorization: false;
}
export interface ConfigurationReport {
  version: 1;
  valid: boolean;
  issues: readonly SetupIssue[];
  features: readonly FeatureSetup[];
  /** URLs, API keys and credential values are deliberately absent. */
  networkChecked: boolean;
  authorization: false;
}
export interface SetupReaders {
  readChainId?(options: { signal?: AbortSignal }): Promise<number>;
  getBytecode?(address: string, options: { signal?: AbortSignal }): Promise<string>;
  readIndexStatus?(options: { signal?: AbortSignal }): Promise<{ chainId: number; blockNumber: number; hasIndexingErrors: boolean }>;
  /** Read-only health checks. These must never publish, request a wallet or sign. */
  checkService?(service: 'bundler' | 'metadata' | 'email', options: { signal?: AbortSignal }): Promise<boolean>;
}
export interface DiagnosticOptions {
  capabilities?: BrowserCapabilities;
  readers?: SetupReaders;
  signal?: AbortSignal;
  /** Whole diagnostic budget, 1–30,000 ms; unresponsive ports remain unknown. */
  timeoutMs?: number;
}

const endpointNames: EndpointName[] = ['rpc', 'indexer', 'bundler', 'metadata', 'email'];
const moduleNames: ModuleName[] = ['membershipAuthority', 'taskManager', 'directDemocracyVoting', 'hybridVoting',
  'executor', 'accountRegistry', 'passkeyFactory', 'quickJoin', 'zkEmailInvites'];
const features: BrowserFeature[] = ['reads', 'wallet', 'passkey', 'sponsored', 'metadata', 'role', 'poll', 'ballot',
  'task-create', 'task-claim', 'task-complete', 'enrollment', 'email', 'cashout'];
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
const chain = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const local = (hostname: string) => hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]';
function endpoint(value: unknown): URL | undefined {
  try {
    if (typeof value !== 'string' || value.trim() !== value) return;
    const url = new URL(value);
    if (url.username || url.password || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && local(url.hostname)))) return;
    return url;
  } catch { return; }
}
function origin(value: unknown): URL | undefined {
  const url = endpoint(value);
  return url && url.pathname === '/' && !url.search && url.origin === value ? url : undefined;
}
const rpMatches = (host: string, rpId: string) => host === rpId || host.endsWith('.' + rpId);
function inspect(config: BrowserConfiguration) {
  const issues: SetupIssue[] = [];
  const add = (code: string, field: string) => issues.push({ code, field });
  if (!config || typeof config !== 'object') {
    add('CONFIGURATION_REQUIRED', 'configuration');
    return issues;
  }
  if (!chain(config.chainId)) add('INVALID_CHAIN_ID', 'chainId');
  if (config.orgId !== undefined && (!/^0x[\da-f]{64}$/i.test(config.orgId) || /^0x0{64}$/i.test(config.orgId))) add('INVALID_ORGANIZATION_ID', 'orgId');
  if (!config.endpoints || typeof config.endpoints !== 'object') add('ENDPOINTS_REQUIRED', 'endpoints');
  for (const name of endpointNames) if (config.endpoints?.[name] !== undefined && !endpoint(config.endpoints[name])) add('INVALID_ENDPOINT', `endpoints.${name}`);
  for (const name of moduleNames) if (config.modules?.[name] !== undefined && !address(config.modules[name])) add('INVALID_MODULE_ADDRESS', `modules.${name}`);
  if (config.wallet) {
    if (!['eoa', 'passkey', 'sponsored'].includes(config.wallet.kind)) add('INVALID_WALLET_KIND', 'wallet.kind');
    if (!address(config.wallet.account)) add('INVALID_WALLET_ACCOUNT', 'wallet.account');
    if (!chain(config.wallet.chainId) || config.wallet.chainId !== config.chainId) add('WALLET_CHAIN_MISMATCH', 'wallet.chainId');
  }
  if (config.passkey) {
    const p = config.passkey, url = origin(p.origin);
    if (!url) add('INVALID_PASSKEY_ORIGIN', 'passkey.origin');
    if (typeof p.rpName !== 'string' || !p.rpName.trim()) add('PASSKEY_RP_NAME_REQUIRED', 'passkey.rpName');
    if (typeof p.rpId !== 'string' || !/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)*[a-z\d](?:[a-z\d-]*[a-z\d])?$/.test(p.rpId)) add('INVALID_PASSKEY_RP_ID', 'passkey.rpId');
    if (p.relatedOrigins !== undefined && (!Array.isArray(p.relatedOrigins) || p.relatedOrigins.some(value => !origin(value)))) add('INVALID_RELATED_ORIGINS', 'passkey.relatedOrigins');
    if (url && typeof p.rpId === 'string' && !rpMatches(url.hostname, p.rpId)
      && !(Array.isArray(p.relatedOrigins) && p.relatedOrigins.includes(url.origin))) add('PASSKEY_ORIGIN_NOT_CONFIGURED', 'passkey.origin');
  }
  return issues;
}

/** Pure inspection. Configured URLs/addresses do not establish deployed support. */
export function checkBrowserConfiguration(config: BrowserConfiguration, capabilities: BrowserCapabilities = {}): ConfigurationReport {
  const issues = inspect(config), safe = config ?? {} as BrowserConfiguration;
  const fieldBad = (prefix: string) => issues.some(row => row.field === prefix || row.field.startsWith(prefix + '.'));
  const prerequisite = (field: string, present: boolean, code: string): [SetupState, string] | undefined =>
    fieldBad(field) ? ['misconfigured', code + '_INVALID'] : !present ? ['unknown', code + '_NOT_CONFIGURED'] : undefined;
  const results = new Map<BrowserFeature, FeatureSetup>();
  const set = (feature: BrowserFeature, conditions: ([SetupState, string] | undefined)[]) => {
    const failed = conditions.filter((row): row is [SetupState, string] => !!row);
    const order: SetupState[] = ['misconfigured', 'unsupported', 'unavailable', 'unknown'];
    const state = order.find(value => failed.some(row => row[0] === value)) ?? 'available';
    results.set(feature, { feature, state, reasons: [...new Set(failed.map(row => row[1]))], authorization: false });
  };
  const dep = (feature: BrowserFeature): [SetupState, string] | undefined => {
    const entry = results.get(feature)!;
    return entry.state === 'available' ? undefined : [entry.state, `${feature.toUpperCase().replace(/-/g, '_')}_SETUP_REQUIRED`];
  };
  const ep = (name: EndpointName) => prerequisite(`endpoints.${name}`, !!safe.endpoints?.[name], name.toUpperCase());
  const mod = (name: ModuleName) => prerequisite(`modules.${name}`, !!safe.modules?.[name], name.toUpperCase());
  const cap = (name: keyof BrowserCapabilities): [SetupState, string] | undefined => capabilities[name] === true ? undefined
    : [capabilities[name] === false ? 'unavailable' : 'unknown', `BROWSER_${name.toUpperCase()}_${capabilities[name] === false ? 'UNAVAILABLE' : 'UNCHECKED'}`];
  const org = prerequisite('orgId', !!safe.orgId, 'ORGANIZATION');
  const base: ([SetupState, string] | undefined)[] = [fieldBad('chainId') ? ['misconfigured', 'CHAIN_INVALID'] : undefined, ep('rpc'), ep('indexer')];
  // Even valid configuration needs a read-only network observation.
  set('reads', [...base, ['unknown', 'NETWORK_UNCHECKED']]);
  set('wallet', [prerequisite('wallet', !!safe.wallet, 'WALLET'), cap('indexedDB'), cap('webLocks')]);
  const p = safe.passkey, o = p && origin(p.origin);
  set('passkey', [prerequisite('passkey', !!p, 'PASSKEY'), cap('secureContext'), cap('webAuthn'), cap('indexedDB'),
    p && o && !rpMatches(o.hostname, p.rpId) ? ['unknown', 'RELATED_ORIGIN_BROWSER_VERIFICATION_REQUIRED'] : undefined,
    mod('passkeyFactory'), mod('accountRegistry'), ep('bundler'), ep('rpc'), ['unknown', 'RPC_CHAIN_UNCHECKED'], ['unknown', 'PASSKEY_DEPLOYMENT_UNCHECKED']]);
  set('sponsored', [dep('wallet'), ep('rpc'), ep('bundler'), ['unknown', 'RPC_CHAIN_UNCHECKED'], ['unknown', 'SPONSORSHIP_POLICY_UNCHECKED']]);
  set('metadata', [ep('metadata'), ['unknown', 'METADATA_SERVICE_UNCHECKED']]);
  set('role', [dep('reads'), dep('wallet'), org, mod('membershipAuthority'), mod('hybridVoting'), mod('executor'), dep('metadata')]);
  set('poll', [dep('reads'), dep('wallet'), org, mod('membershipAuthority'), mod('directDemocracyVoting'), dep('metadata')]);
  set('ballot', [dep('reads'), dep('wallet'), org, mod('membershipAuthority'), mod('directDemocracyVoting')]);
  for (const feature of ['task-create', 'task-claim', 'task-complete'] as const) set(feature, [dep('reads'), dep('wallet'), org, mod('membershipAuthority'), mod('taskManager')]);
  set('enrollment', [dep('reads'), dep('wallet'), mod('accountRegistry'), mod('quickJoin'), org]);
  set('email', [dep('enrollment'), mod('zkEmailInvites'), ep('email'), ['unknown', 'EMAIL_DEPLOYMENT_UNCHECKED']]);
  set('cashout', [['unsupported', 'CASHOUT_INITIATION_NOT_SUPPORTED_BY_BROWSER_SDK']]);
  return { version: 1, valid: issues.length === 0, issues, features: features.map(name => results.get(name)!), networkChecked: false, authorization: false };
}

/** Bounded, explicit, read-only probes. No wallet connection or side effect is requested.
 * Reader ports must be bound to the configured endpoints, never to another app's cache.
 * A successful check establishes availability only, not module/org binding or permission.
 */
export async function diagnoseBrowserConfiguration(config: BrowserConfiguration, options: DiagnosticOptions = {}): Promise<ConfigurationReport> {
  // A caller editing its setup form during an awaited probe cannot change which
  // network or module the result describes. No credentials/URLs enter the report.
  config = { ...config, endpoints: { ...config?.endpoints }, modules: { ...config?.modules },
    ...(config?.wallet ? { wallet: { ...config.wallet } } : {}),
    ...(config?.passkey ? { passkey: { ...config.passkey, ...(Array.isArray(config.passkey.relatedOrigins) ? { relatedOrigins: [...config.passkey.relatedOrigins] } : {}) } } : {}) };
  const original = checkBrowserConfiguration(config, options.capabilities);
  if (!original.valid) return original;
  const readers = options.readers;
  if (!readers) return original;
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('INVALID_DIAGNOSTIC_TIMEOUT');
  const controller = new AbortController(), signal = controller.signal;
  let expired = false;
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let deadline!: ReturnType<typeof setTimeout>;
  const stop = new Promise<void>(resolve => {
    signal.addEventListener('abort', () => resolve(), { once: true });
    if (signal.aborted) resolve();
    deadline = setTimeout(() => { expired = true; controller.abort(); resolve(); }, timeoutMs);
  });
  const cancelled = () => signal?.aborted === true;
  const observed = new Map<string, SetupState>();
  const safe = async (name: string, read: (() => Promise<boolean>) | undefined) => {
    if (!read) return;
    if (cancelled()) { observed.set(name, 'unknown'); return; }
    try { const ok = await Promise.race([read(), stop.then(() => undefined)]); observed.set(name, cancelled() ? 'unknown' : ok ? 'available' : 'unavailable'); }
    catch { observed.set(name, 'unknown'); }
  };
  await Promise.all([
    safe('rpc', readers.readChainId && config.endpoints.rpc ? async () => (await readers.readChainId!({ signal })) === config.chainId : undefined),
    safe('indexer', readers.readIndexStatus && config.endpoints.indexer ? async () => {
      const value = await readers.readIndexStatus!({ signal });
      return value.chainId === config.chainId && Number.isSafeInteger(value.blockNumber) && value.blockNumber >= 0 && value.hasIndexingErrors === false;
    } : undefined),
    ...moduleNames.filter(name => config.modules?.[name]).map(name => safe(`module:${name}`, readers.getBytecode ? async () => {
      const code = await readers.getBytecode!(config.modules![name]!, { signal });
      return typeof code === 'string' && /^0x(?:[\da-f]{2})+$/i.test(code) && !/^0x0+$/i.test(code);
    } : undefined)),
    ...(['bundler', 'metadata', 'email'] as const).filter(name => config.endpoints[name]).map(name => safe(name,
      readers.checkService ? async () => (await readers.checkService!(name, { signal })) === true : undefined)),
  ]);
  clearTimeout(deadline);
  options.signal?.removeEventListener('abort', abort);
  if (cancelled()) return { ...original, networkChecked: false, features: original.features.map(row => row.state === 'unsupported' ? row :
    { ...row, state: 'unknown', reasons: [...row.reasons, expired ? 'DIAGNOSTIC_TIMEOUT' : 'DIAGNOSTIC_CANCELLED'] }) };
  const report: ConfigurationReport = { ...original, networkChecked: observed.has('rpc') || observed.has('indexer'), features: original.features.map(row => ({ ...row, reasons: [...row.reasons] })) };
  // Replace only explicitly observed availability. Contract permission, related
  // origin authorization and sponsorship policy stay outside this diagnostic.
  const resolved = new Map<BrowserFeature, FeatureSetup>();
  const moduleRequirements: Partial<Record<BrowserFeature, ModuleName[]>> = {
    role: ['membershipAuthority', 'hybridVoting', 'executor'], poll: ['membershipAuthority', 'directDemocracyVoting'],
    ballot: ['membershipAuthority', 'directDemocracyVoting'], 'task-create': ['membershipAuthority', 'taskManager'],
    'task-claim': ['membershipAuthority', 'taskManager'], 'task-complete': ['membershipAuthority', 'taskManager'],
    passkey: ['passkeyFactory', 'accountRegistry'], enrollment: ['accountRegistry', 'quickJoin'], email: ['accountRegistry', 'quickJoin', 'zkEmailInvites'],
  };
  report.features = report.features.map(row => {
    let reasons = [...row.reasons];
    const failed: SetupState[] = [];
    if (row.feature === 'reads' && observed.get('rpc') === 'available' && observed.get('indexer') === 'available') reasons = reasons.filter(code => code !== 'NETWORK_UNCHECKED');
    if (row.feature === 'metadata' && observed.get('metadata') === 'available') reasons = reasons.filter(code => code !== 'METADATA_SERVICE_UNCHECKED');
    if ((row.feature === 'passkey' || row.feature === 'sponsored') && observed.get('rpc') === 'available') reasons = reasons.filter(code => code !== 'RPC_CHAIN_UNCHECKED');
    if (row.feature === 'passkey' && observed.get('bundler') === 'available' && observed.get('module:passkeyFactory') === 'available'
      && observed.get('module:accountRegistry') === 'available') reasons = reasons.filter(code => code !== 'PASSKEY_DEPLOYMENT_UNCHECKED');
    for (const dependency of ['reads', 'wallet', 'metadata'] as const) if (resolved.get(dependency)?.state === 'available') reasons = reasons.filter(code => code !== `${dependency.toUpperCase()}_SETUP_REQUIRED`);
    const checks = row.feature === 'reads' ? ['rpc', 'indexer'] : row.feature === 'metadata' ? ['metadata']
      : row.feature === 'passkey' || row.feature === 'sponsored' ? ['rpc', 'bundler'] : row.feature === 'email' ? ['email'] : [];
    for (const key of [...checks, ...(moduleRequirements[row.feature] ?? []).map(name => `module:${name}`)]) {
      const state = observed.get(key);
      if (state !== 'available') { reasons.push(`${key.replace(':', '_').toUpperCase()}_${state === 'unavailable' ? 'UNAVAILABLE' : 'UNCHECKED'}`); failed.push(state ?? 'unknown'); }
    }
    for (const dependency of ['reads', 'wallet', 'metadata'] as const) if (reasons.includes(`${dependency.toUpperCase()}_SETUP_REQUIRED`)) failed.push(resolved.get(dependency)?.state ?? 'unknown');
    const priority: SetupState[] = ['misconfigured', 'unsupported', 'unavailable', 'unknown'];
    const state = priority.find(value => failed.includes(value) || (row.state === value && reasons.length > 0)) ?? (reasons.length ? 'unknown' : 'available');
    const result = { ...row, reasons: [...new Set(reasons)], state };
    resolved.set(row.feature, result);
    return result;
  });
  return report;
}

/** Capability presence only; opening storage/credentials is deliberately deferred. */
export function detectBrowserCapabilities(environment: {
  isSecureContext?: boolean; indexedDB?: unknown; navigator?: { credentials?: { create?: unknown; get?: unknown }; locks?: { request?: unknown } };
}): BrowserCapabilities {
  return { secureContext: environment.isSecureContext === true, indexedDB: !!environment.indexedDB,
    webLocks: typeof environment.navigator?.locks?.request === 'function',
    webAuthn: typeof environment.navigator?.credentials?.create === 'function' && typeof environment.navigator?.credentials?.get === 'function' };
}
