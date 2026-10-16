import { requireRawUint } from '../amounts';
import { assertPlanScope, assertSourceBlock, assertSourceRef, Fact, knownFact, requireCompleteSnapshot, SourceRef, SourceSnapshot, unknownFact } from '../data/facts';
import { collectCursorPages } from '../graph/pagination';
import { FETCH_ACCOUNT_FACTS, FETCH_FACTORY_FACTS, FETCH_SOLIDARITY_STATE, FETCH_CREDENTIAL_PAGE, FETCH_CREDENTIAL_PAGE_LEGACY, FETCH_CREDENTIAL_DISCOVERY_PAGE_TIERS } from '../graph/documents/accounts';
import { FETCH_PROTOCOL_OVERVIEW, FETCH_PROTOCOL_ORGS_PAGE, FETCH_BEACON_EVENTS_PAGE, FETCH_SOLIDARITY_EVENTS_PAGE } from '../graph/documents/protocol';
import { FETCH_PAYMASTER_DEPOSITS_PAGE, FETCH_PAYMASTER_USAGE_PAGE } from '../graph/documents/paymaster';

export type IndexedRow = Record<string, unknown>;
/**
 * Execute the unchanged document/variables at this source's endpoint/chain and
 * throw on HTTP/GraphQL errors. Do not strip or reinterpret Block_height.hash.
 * Pinned documents must use the same $block on every selected collection and
 * on `_meta(block: $block) { block { number hash timestamp } }`. Metadata must
 * come from that response, never from the requested SourceRef or another query.
 */
export type ProtocolQuery = (document: string, variables: Record<string, unknown>, source: SourceRef) => Promise<Record<string, unknown>>;
function blockVariables(source: SourceRef): Record<string, unknown> {
  if (source.snapshot === 'pinned') {
    const n = BigInt(source.block!.number);
    if (n > 2147483647n) throw new Error('Graph block exceeds Int width');
    // Graph Block_height selects by ONE identity. Hash pins identity; metadata
    // independently proves its number (including conflicting caller N/H).
    return { block: source.block!.hash ? { hash: source.block!.hash } : { number: Number(n) } };
  }
  return {};
}
function validResponse(response: Record<string, unknown>): Record<string, unknown> {
  if (!response || typeof response !== 'object' || (Array.isArray(response.errors) && response.errors.length)) throw new Error('Graph query failed');
  return response;
}
function indexed(source: SourceRef): void {
  assertSourceRef(source);
  if (!source.indexed) throw new Error('Indexed reader requires indexed source');
}

class IndexedBlockEvidenceError extends Error {
  constructor(public readonly code: string) { super(code); }
}
function unprovenSource(source: SourceRef): SourceRef {
  if (source.snapshot !== 'pinned') return source;
  const { block: _requestedBlock, ...scope } = source;
  return { ...scope, snapshot: 'unknown' };
}
/** A hash-filter response may legitimately have null hash; the filter enforces
 * identity, while the independently returned number is still mandatory. */
function provenSource(source: SourceRef, response: Record<string, unknown>): SourceRef {
  if (source.snapshot !== 'pinned') return source;
  const meta = response._meta as { block?: Record<string, unknown> } | null | undefined;
  if (!meta?.block || typeof meta.block !== 'object' || meta.block.hash === undefined) throw new IndexedBlockEvidenceError('BLOCK_EVIDENCE_UNAVAILABLE');
  try {
    const number = requireRawUint(meta.block.number as string | number);
    const hash = meta.block.hash;
    if (hash != null && (typeof hash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(hash))) throw new Error('Invalid block hash');
    if (hash != null && source.block!.hash && hash.toLowerCase() !== source.block!.hash.toLowerCase()) throw new Error('Wrong block hash');
    const timestamp = meta.block.timestamp == null ? undefined : requireRawUint(meta.block.timestamp as string | number);
    const block = { number, ...(hash != null || source.block!.hash ? { hash: source.block!.hash ?? hash as string } : {}), ...(timestamp !== undefined ? { timestamp } : {}) };
    assertSourceBlock(block, source.block!);
    // Preserve identity for callers whose requested dimensions exactly match
    // proven dimensions; additional observed evidence gets its own source.
    return block.number === source.block!.number && block.hash === source.block!.hash && block.timestamp === source.block!.timestamp
      ? source : { ...source, block };
  } catch { throw new IndexedBlockEvidenceError('BLOCK_EVIDENCE_MISMATCH'); }
}

export interface IndexedPageFactsOptions {
  source: SourceRef; query: ProtocolQuery; document: string; collection: string;
  variables: Record<string, unknown>; pageSize?: number; maxPages?: number;
  /** Bytes ID collections start at 0x; String ID collections at empty string. */
  initialCursor: string;
  validateRow?: (row: IndexedRow) => void;
}
/** Reuses foundation coverage/cursor contract and retains partial evidence.
 * Pinned custom documents must meet ProtocolQuery's same-block metadata contract.
 * Missing proof cannot yield a complete pinned snapshot, even for empty rows.
 * Every page, including terminal empty pages, must prove the first page's block
 * dimensions exactly; later optional evidence cannot attest earlier rows. */
export async function readIndexedPageFacts(options: IndexedPageFactsOptions): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  indexed(options.source);
  let proofReceived = false;
  let firstPageSource: SourceRef | undefined;
  const proofIssues: { code: string; id: string }[] = [];
  const result = await collectCursorPages<IndexedRow>({ source: options.source, pageSize: options.pageSize ?? 1000, maxPages: options.maxPages ?? 100,
    shortPageMeansComplete: true, cursor: { initial: options.initialCursor, fromRow: row => String(row.id ?? ''), compare: (a, b) => a < b ? -1 : a > b ? 1 : 0 },
    fetchPage: async ({ cursor, first, page }) => {
      const response = validResponse(await options.query(options.document, { ...options.variables, ...blockVariables(options.source), cursor, first }, options.source));
      let source: SourceRef;
      try { source = provenSource(options.source, response); proofReceived = true; }
      catch (error) {
        if (error instanceof IndexedBlockEvidenceError) proofIssues.push({ code: error.code, id: `page:${page}` });
        throw error;
      }
      const issues: { code: string; id?: string }[] = [];
      if (source.snapshot === 'pinned') {
        if (firstPageSource) {
          try {
            // Compare both directions: a newly observed hash/timestamp cannot
            // strengthen pages that proved only the number (or fewer fields).
            assertSourceBlock(source.block, firstPageSource.block!);
            assertSourceBlock(firstPageSource.block, source.block!);
          } catch { issues.push({ code: 'PAGE_SOURCE_MISMATCH', id: `page:${page}` }); }
          // Retain the original proof, including when mismatched rows are kept
          // diagnostically by the foundation's incomplete-page contract.
          source = firstPageSource;
        } else firstPageSource = source;
      }
      const rows = response[options.collection];
      if (Array.isArray(rows)) for (const row of rows) {
        try {
          if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id) throw new Error('Invalid row');
          options.validateRow?.(row);
        } catch { issues.push({ code: 'INVALID_OR_MISMATCHED_ROW', id: row?.id }); }
      }
      return { rows: Array.isArray(rows) ? rows as IndexedRow[] : null, issues, source };
    },
  });
  return { ...result, source: proofReceived ? result.source : unprovenSource(options.source),
    coverage: { ...result.coverage, issues: [...result.coverage.issues, ...proofIssues] } };
}

/** Multiple/missing rows remain explicit; no HOME or first-factory fallback. */
export async function readIndexedSingletonFacts(source: SourceRef, query: ProtocolQuery, document: string, variables: Record<string, unknown>, collections: readonly string[], expectedIds: Readonly<Record<string, string>> = {}): Promise<SourceSnapshot<Record<string, unknown>>> {
  indexed(source);
  try {
    const data = validResponse(await query(document, { ...variables, ...blockVariables(source) }, source));
    const observed = provenSource(source, data);
    const missing = collections.filter(key => !Array.isArray(data[key]));
    const mismatched = collections.filter(key => expectedIds[key] && Array.isArray(data[key]) && (data[key] as IndexedRow[]).some(row => typeof row?.id !== 'string' || row.id.toLowerCase() !== expectedIds[key].toLowerCase()));
    const ambiguous = collections.filter(key => Array.isArray(data[key]) && (data[key] as unknown[]).length > 1);
    return { source: observed, data, coverage: { status: missing.length || ambiguous.length || mismatched.length ? 'incomplete' : 'complete', expectedKeys: collections, receivedKeys: collections.filter(key => !missing.includes(key)),
      missingIds: missing, failedIds: [], issues: [...ambiguous.map(id => ({ code: 'AMBIGUOUS_SINGLETON', id })), ...mismatched.map(id => ({ code: 'SINGLETON_SCOPE_MISMATCH', id }))] } };
  } catch (error) {
    return { source: unprovenSource(source), data: {}, coverage: { status: 'unavailable', expectedKeys: collections, receivedKeys: [], missingIds: collections, failedIds: collections, issues: [{ code: 'SOURCE_FAILED' }, ...(error instanceof IndexedBlockEvidenceError ? [{ code: error.code }] : [])] } };
  }
}
function required(source: SourceRef, key: 'account' | 'contract', variable: string, variables: Record<string, unknown>): void {
  if (!source[key] || !variables[variable]) throw new Error(`Explicit ${key}/${variable} required`);
  assertPlanScope(source, { chainId: source.chainId, [key]: String(variables[variable]) });
}
export function readAccountFacts(source: SourceRef, query: ProtocolQuery, registry: string): Promise<SourceSnapshot<Record<string, unknown>>> {
  if (!source.account) throw new Error('Explicit account source required');
  assertPlanScope(source, { chainId: source.chainId, contracts: { registry } });
  return readIndexedSingletonFacts(source, query, FETCH_ACCOUNT_FACTS, { account: source.account, registry }, ['passkeyAccounts', 'accounts'], { passkeyAccounts: source.account, accounts: source.account });
}
export function readFactoryFacts(source: SourceRef, query: ProtocolQuery, registry: string): Promise<SourceSnapshot<Record<string, unknown>>> {
  if (!source.contract) throw new Error('Explicit factory source required');
  assertPlanScope(source, { chainId: source.chainId, contracts: { registry } });
  return readIndexedSingletonFacts(source, query, FETCH_FACTORY_FACTS, { factory: source.contract, registry }, ['passkeyAccountFactories', 'universalAccountRegistries'], { passkeyAccountFactories: source.contract, universalAccountRegistries: registry });
}
export function readSolidarityFacts(source: SourceRef, query: ProtocolQuery): Promise<SourceSnapshot<Record<string, unknown>>> {
  if (!source.contract) throw new Error('Explicit hub source required');
  return readIndexedSingletonFacts(source, query, FETCH_SOLIDARITY_STATE, { hub: source.contract }, ['paymasterHubContracts', 'onboardingConfigs'], { paymasterHubContracts: source.contract, onboardingConfigs: source.contract });
}

export function readProtocolOverviewFacts(source: SourceRef, query: ProtocolQuery): Promise<SourceSnapshot<Record<string, unknown>>> {
  const { manager, registry, accountRegistry, hub } = source.contracts ?? {};
  if (![manager, registry, accountRegistry, hub].every(v => typeof v === 'string' && /^0x[\da-fA-F]{40}$/.test(v))) throw new Error('Explicit protocol instance addresses required');
  assertPlanScope(source, { chainId: source.chainId, contract: hub });
  return readIndexedSingletonFacts(source, query, FETCH_PROTOCOL_OVERVIEW, { manager, registry, accountRegistry, hub }, Object.keys(INDEXED_FIELDS),
    { poaManagerContracts: manager, orgRegistryContracts: registry, universalAccountRegistries: accountRegistry, paymasterHubContracts: hub, onboardingConfigs: hub, orgDeployConfigs: hub });
}
export interface ProtocolPageOptions { source: SourceRef; query: ProtocolQuery; pageSize?: number; maxPages?: number }
export function readProtocolOrgFacts(options: ProtocolPageOptions): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  if (!options.source.contract) throw new Error('Explicit hub required');
  return readIndexedPageFacts({ ...options, document: FETCH_PROTOCOL_ORGS_PAGE, collection: 'paymasterOrgConfigs', variables: { hub: options.source.contract }, initialCursor: '',
    validateRow: row => { if ((row.paymasterHub as { id?: string } | undefined)?.id?.toLowerCase() !== options.source.contract!.toLowerCase()) throw new Error('Hub scope mismatch'); } });
}
export function readProtocolEventFacts(options: ProtocolPageOptions & { kind: 'beacon' | 'solidarity' }): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  if (!options.source.contract) throw new Error('Explicit event contract required');
  const beacon = options.kind === 'beacon';
  return readIndexedPageFacts({ ...options, document: beacon ? FETCH_BEACON_EVENTS_PAGE : FETCH_SOLIDARITY_EVENTS_PAGE, collection: beacon ? 'beaconUpgradeEvents' : 'solidarityEvents', variables: beacon ? { manager: options.source.contract } : { hub: options.source.contract }, initialCursor: '0x',
    validateRow: row => {
      if ((row[beacon ? 'poaManager' : 'paymasterHub'] as { id?: string } | undefined)?.id?.toLowerCase() !== options.source.contract!.toLowerCase()) throw new Error('Event contract mismatch');
      requireRawUint(row[beacon ? 'upgradedAt' : 'eventAt'] as string); requireRawUint(row[beacon ? 'upgradedAtBlock' : 'eventAtBlock'] as string);
      if (typeof row.transactionHash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(row.transactionHash)) throw new Error('Invalid event transaction');
      if (!beacon && row.amount !== null && row.amount !== undefined) requireRawUint(row.amount as string);
    } });
}

export interface CredentialReadOptions {
  source: SourceRef; query: ProtocolQuery; credentialId?: string; pageSize?: number; maxPages?: number;
}
function missingCredentialKeyMessage(message: unknown): boolean {
  if (typeof message !== 'string') return false;
  // Accept the serving Graph Node syntax and the earlier GraphQL validator syntax.
  // Anchor every message so transport text, other types and mixed failures cannot match.
  return message.split(/;\s*|\r?\n/).every(part =>
    /^Type `PasskeyCredential` has no field `publicKey[XY]`\.?$/.test(part.trim())
    || /^Cannot query field "publicKey[XY]"(?: on type "PasskeyCredential")?\.?$/.test(part.trim()));
}
function credentialKeysUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const envelope = error as Record<string, unknown>;
  const response = envelope.response && typeof envelope.response === 'object'
    ? envelope.response as Record<string, unknown> : undefined;
  const records = response ? [envelope, response] : [envelope];
  // HTTP/transport failures cannot establish a schema capability, even if they
  // happen to carry missing-key text. Structured GraphQL arrays are authoritative:
  // never use only the first message of a GraphRequestError with mixed errors.
  for (const record of records) {
    for (const key of ['status', 'httpStatus']) {
      const status = record[key];
      if (status !== undefined && (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status >= 300)) return false;
    }
    if (record.error != null || record.cause != null || record.code != null) return false;
  }
  const errorLists = records.filter(record => record.errors !== undefined).map(record => record.errors);
  if (errorLists.length) return errorLists.every(errors => Array.isArray(errors) && errors.length > 0
    && errors.every(entry => entry && typeof entry === 'object' && missingCredentialKeyMessage(entry.message)));
  return missingCredentialKeyMessage(envelope.message);
}
/** Account listing or credential discovery, retaining revoked rows and unknown legacy keys. */
export function readCredentialFacts(options: CredentialReadOptions): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  if (!options.credentialId && !options.source.account) throw new Error('Account or credential selector required');
  if (options.credentialId && !/^0x[\da-fA-F]{64}$/.test(options.credentialId)) throw new Error('Invalid credential selector');
  const documents = options.credentialId ? FETCH_CREDENTIAL_DISCOVERY_PAGE_TIERS : [FETCH_CREDENTIAL_PAGE, FETCH_CREDENTIAL_PAGE_LEGACY];
  return readIndexedPageFacts({ ...options, document: documents[0], collection: 'passkeyCredentials', initialCursor: '',
    variables: options.credentialId ? { credentialId: options.credentialId } : { account: options.source.account },
    query: async (document, variables, source) => {
      // Only an explicit unknown-key schema error permits the legacy tier.
      // Transport/other GraphQL errors still fail the page.
      try {
        const response = await options.query(document, variables, source);
        if (credentialKeysUnavailable(response)) return options.query(documents[1], variables, source);
        return response;
      } catch (error) {
        if (credentialKeysUnavailable(error)) return options.query(documents[1], variables, source);
        throw error;
      }
    },
    validateRow: row => {
      const account = (row.account as { id?: string } | undefined)?.id;
      if (typeof account !== 'string' || !/^0x[\da-fA-F]{40}$/.test(account)) throw new Error('Missing discovered account');
      if (options.source.account && account.toLowerCase() !== options.source.account.toLowerCase()) throw new Error('Credential account mismatch');
      if (options.credentialId && row.credentialId !== options.credentialId) throw new Error('Credential selector mismatch');
      if (typeof row.active !== 'boolean') throw new Error('Missing credential status');
    } });
}

export interface PaymasterHistoryOptions {
  source: SourceRef; query: ProtocolQuery; kind: 'deposits' | 'usage'; orgConfig: string; pageSize?: number; maxPages?: number;
}
export function readPaymasterHistoryFacts(options: PaymasterHistoryOptions): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  if (!options.source.contract || !options.source.orgId || !options.orgConfig) throw new Error('Explicit hub/org/config required');
  const variables = { hub: options.source.contract, orgConfig: options.orgConfig };
  required(options.source, 'contract', 'hub', variables);
  return readIndexedPageFacts({ ...options, variables, initialCursor: '0x', document: options.kind === 'deposits' ? FETCH_PAYMASTER_DEPOSITS_PAGE : FETCH_PAYMASTER_USAGE_PAGE,
    collection: options.kind === 'deposits' ? 'paymasterDepositEvents' : 'usageEvents', validateRow: row => {
      const org = row.orgConfig as { id?: string; orgId?: string; paymasterHub?: { id: string } } | undefined;
      const hub = options.kind === 'deposits' ? (row.paymasterHub as { id?: string } | undefined)?.id : org?.paymasterHub?.id;
      if (org?.id !== options.orgConfig || org.orgId?.toLowerCase() !== options.source.orgId!.toLowerCase() || hub?.toLowerCase() !== options.source.contract!.toLowerCase()) throw new Error('History scope mismatch');
      requireRawUint(row.eventAt as string); requireRawUint(row.eventAtBlock as string);
      // Usage deltas are signed BigInt by schema; retain signs exactly.
      if (options.kind === 'deposits') requireRawUint(row.amount as string);
      else if (typeof row.delta !== 'string' || !/^-?\d+$/.test(row.delta)) throw new Error('Invalid signed delta');
      if (typeof row.transactionHash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(row.transactionHash)) throw new Error('Invalid tx hash');
    } });
}

export interface CredentialFacts { id: Fact<string>; credentialId: Fact<string>; active: Fact<boolean>; publicKeyX: Fact<string>; publicKeyY: Fact<string>; createdAt: Fact<string>; removedAt: Fact<string> }
export function projectCredentialFacts(row: IndexedRow, source: SourceRef): CredentialFacts {
  assertSourceRef(source);
  if (!source.account || (row.account as { id?: string } | undefined)?.id?.toLowerCase() !== source.account.toLowerCase()) throw new Error('Credential account scope mismatch');
  const stringFact = (key: string, pattern: RegExp): Fact<string> => typeof row[key] === 'string' && pattern.test(row[key] as string) ? knownFact(row[key] as string, source) : unknownFact('FIELD_UNAVAILABLE', source);
  return { id: stringFact('id', /^.+$/), credentialId: stringFact('credentialId', /^0x[\da-fA-F]{64}$/), active: typeof row.active === 'boolean' ? knownFact(row.active, source) : unknownFact('FIELD_UNAVAILABLE', source),
    publicKeyX: stringFact('publicKeyX', /^0x[\da-fA-F]{64}$/), publicKeyY: stringFact('publicKeyY', /^0x[\da-fA-F]{64}$/), createdAt: stringFact('createdAt', /^\d+$/), removedAt: stringFact('removedAt', /^\d+$/) };
}

const INDEXED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  poaManagerContracts: ['id', 'registry', 'beaconCount', 'orgDeployerProxy', 'orgRegistryProxy', 'paymasterHubProxy', 'globalAccountRegistryProxy', 'passkeyAccountFactoryProxy', 'createdAt', 'createdAtBlock'],
  orgRegistryContracts: ['id', 'totalOrgs', 'totalContracts'], universalAccountRegistries: ['id', 'totalAccounts', 'passkeyFactory'],
  paymasterHubContracts: ['id', 'entryPoint', 'totalDeposit', 'solidarityBalance', 'totalFeesCollected', 'solidarityDistributionPaused', 'gracePeriodDays', 'maxSpendDuringGrace', 'minDepositRequired', 'createdAt', 'createdAtBlock'],
  onboardingConfigs: ['id', 'maxGasPerCreation', 'dailyCreationLimit', 'enabled', 'accountRegistry', 'updatedAt', 'blockNumber'],
  orgDeployConfigs: ['id', 'maxGasPerDeploy', 'dailyDeployLimit', 'maxDeploysPerAccount', 'enabled', 'orgDeployer', 'updatedAt', 'blockNumber'],
};
const LIVE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  getSolidarityFund: ['balance', 'numActiveOrgs', 'feePercentageBps', 'distributionPaused'],
  getGracePeriodConfig: ['initialGraceDays', 'maxSpendDuringGrace', 'minDepositRequired'],
  getOnboardingConfig: ['maxGasPerCreation', 'dailyCreationLimit', 'attemptsToday', 'currentDay', 'enabled', 'accountRegistry', 'maxOnboardingsPerAccount'],
  getOrgDeployConfig: ['maxGasPerDeploy', 'dailyDeployLimit', 'attemptsToday', 'currentDay', 'maxDeploysPerAccount', 'enabled', 'orgDeployer'],
};
function scalarFact(value: unknown, field: string, source: SourceRef): Fact<string | boolean> {
  if (typeof value === 'boolean' && /^(enabled|paused|.*Paused)$/.test(field)) return knownFact(value, source);
  if (typeof value === 'string') {
    if (/^(id|registry|.*Proxy|passkeyFactory|entryPoint|accountRegistry|orgDeployer)$/.test(field)) return /^0x[\da-fA-F]{40}$/.test(value) ? knownFact(value, source) : unknownFact('INVALID_ADDRESS', source);
    try { return knownFact(requireRawUint(value), source); } catch { return unknownFact('INVALID_RAW_UINT', source); }
  }
  if (typeof value === 'number') {
    try { return knownFact(requireRawUint(value), source); } catch { return unknownFact('INVALID_RAW_UINT', source); }
  }
  return unknownFact('FIELD_UNAVAILABLE', source);
}
export interface ProtocolFacts {
  indexed: Readonly<Record<string, Fact<string | boolean>>>;
  current: Readonly<Record<string, Fact<string | boolean>>>;
  coverage: SourceSnapshot<unknown>['coverage'];
}
/** Indexed card/link facts stay indexed; fresh mutable getters require same chain+hub scope. */
export function projectProtocolFacts(snapshot: SourceSnapshot<Record<string, unknown>>, live: Readonly<Record<string, SourceSnapshot<IndexedRow>>> = {}): ProtocolFacts {
  assertSourceRef(snapshot.source);
  const indexedFacts: Record<string, Fact<string | boolean>> = {}, current: Record<string, Fact<string | boolean>> = {};
  let complete = true;
  try { requireCompleteSnapshot(snapshot, { indexed: true }); } catch { complete = false; }
  for (const [collection, fields] of Object.entries(INDEXED_FIELDS)) {
    const rows = snapshot.data[collection];
    let row = complete && Array.isArray(rows) && rows.length === 1 ? rows[0] as IndexedRow : undefined;
    const key = collection === 'poaManagerContracts' ? 'manager' : collection === 'orgRegistryContracts' ? 'registry' : collection === 'universalAccountRegistries' ? 'accountRegistry' : 'hub';
    const expectedId = snapshot.source.contracts?.[key] ?? (key === 'hub' ? snapshot.source.contract : undefined);
    if (!expectedId || typeof row?.id !== 'string' || row.id.toLowerCase() !== expectedId.toLowerCase()) row = undefined;
    for (const field of fields) indexedFacts[`${collection}.${field}`] = row ? scalarFact(row[field], field, snapshot.source) : unknownFact('INDEXED_FIELD_UNAVAILABLE', snapshot.source);
  }
  for (const [method, fields] of Object.entries(LIVE_FIELDS)) {
    const candidate = live[method];
    let data: IndexedRow | undefined;
    try {
      if (!snapshot.source.contract || !candidate) throw new Error('Missing live hub read');
      data = requireCompleteSnapshot(candidate, { indexed: false, scope: { chainId: snapshot.source.chainId, contract: snapshot.source.contract, method } });
    } catch { /* No guessed deployment-time policy. */ }
    for (const field of fields) current[`${method}.${field}`] = data ? scalarFact(data[field], field, candidate!.source) : unknownFact('LIVE_FIELD_UNAVAILABLE', candidate?.source ?? snapshot.source);
  }
  return { indexed: indexedFacts, current, coverage: snapshot.coverage };
}

/** Totals are exact and explicitly indexed; incomplete history cannot become zero/global success. */
export function sumIndexedOrgGasFacts(snapshot: SourceSnapshot<readonly IndexedRow[]>): Readonly<Record<string, Fact<string>>> {
  const fields = ['totalSpent', 'totalSolidarityReceived', 'depositBalance', 'totalDeposited', 'stats.totalUserOps', 'stats.totalGasSponsored'];
  const facts: Record<string, Fact<string>> = {};
  for (const field of fields) {
    try {
      const rows = requireCompleteSnapshot(snapshot, { indexed: true, requiredKeys: snapshot.data.map(row => String(row.id ?? '')) });
      if (!snapshot.source.contract || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Org source/uniqueness required');
      for (const row of rows) if ((row.paymasterHub as { id?: string } | undefined)?.id?.toLowerCase() !== snapshot.source.contract.toLowerCase()) throw new Error('Org hub mismatch');
      let total = 0n;
      for (const row of rows) {
        const [key, nested] = field.split('.');
        const value = nested ? (row[key] as IndexedRow | undefined)?.[nested] : row[key];
        total += BigInt(requireRawUint(value as string));
      }
      facts[field] = knownFact(requireRawUint(total), snapshot.source);
    } catch { facts[field] = unknownFact('INCOMPLETE_OR_INVALID_INDEXED_TOTAL', snapshot.source); }
  }
  return facts;
}
