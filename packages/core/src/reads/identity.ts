import { assertSourceRef, Fact, knownFact, SourceRef, SourceSnapshot, unknownFact } from '../data/facts';
import { reduceSourceResults, SourceReduction } from '../graph/sources';
import { FETCH_ACCOUNTS_BY_NAMES, FETCH_PROFILES_BY_ADDRESSES, SEARCH_ACCOUNTS_PAGE } from '../graph/documents/identity';
import { ProtocolQuery, readIndexedPageFacts } from './protocol';
import { requireRawUint } from '../amounts';

export type IdentitySelector = { kind: 'search'; query: string } | { kind: 'names'; names: readonly string[] } | { kind: 'addresses'; addresses: readonly string[] };
export interface IdentityAccount {
  id: string;
  user: string;
  username: string;
  isDeleted: boolean;
  registry: { id: string };
  profileMetadataHash: string | null;
  metadata: { id: string; bio: string | null; avatar: string | null; github: string | null; twitter: string | null; website: string | null } | null;
  registeredAt: string;
  registeredAtBlock: string;
  lastUpdatedAt: string;
  /** Actual source qualified by this account; never inferred from host wallet/default chain. */
  source: SourceRef;
}
export interface IdentityFacts extends SourceReduction<IdentityAccount> {
  /** Retained selector makes complete absence meaningful only for the requested universe. */
  selector: IdentitySelector;
  /** Every attempted source, including a pinned failure whose provenance became unknown.
   * The shared reducer cannot match that changed capability to the requested source identity. */
  observations: readonly SourceSnapshot<readonly IdentityAccount[]>[];
}

/** One paged batch per explicit source, not one org/profile query per account. Registry-scoped
 * complete empty results differ from source outage. Search order is ID; host ranking stays injected.
 * ProtocolQuery must enforce endpoint/chain and throw on all transport/GraphQL errors. */
export async function readIdentityFacts(input: {
  sources: readonly SourceRef[]; query: ProtocolQuery; selector: IdentitySelector; pageSize?: number; maxPages?: number;
}): Promise<IdentityFacts> {
  for (const source of input.sources) {
    assertSourceRef(source);
    if (!source.indexed || !source.contract || source.orgId || source.account) throw new Error('Unscoped indexed registry source required');
    if (source.block && source.snapshot !== 'pinned') throw new Error('Explicit indexed block requires pinned source');
  }
  // Check duplicate sources before issuing any requests.
  const sourceCheck = reduceSourceResults<IdentityAccount>(input.sources, [], { blockAlignment: 'independent' });
  if (sourceCheck.coverage.issues.some(issue => issue.code === 'DUPLICATE_EXPECTED_SOURCE')) throw new Error('Duplicate identity source');
  if (input.pageSize !== undefined && (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 1000)) throw new Error('Page size must be between 1 and 1000');
  let selector: IdentitySelector, document: string, variables: Record<string, unknown>;
  if (input.selector.kind === 'addresses') {
    const addresses = [...new Set(input.selector.addresses.map(address => {
      if (!/^0x[\da-f]{40}$/i.test(address)) throw new Error('Invalid account address');
      return address.toLowerCase();
    }))];
    selector = { kind: 'addresses', addresses }; document = FETCH_PROFILES_BY_ADDRESSES; variables = { addresses };
  } else if (input.selector.kind === 'names') {
    if (input.selector.names.some(name => typeof name !== 'string' || !name)) throw new Error('Invalid username selector');
    selector = { kind: 'names', names: [...new Set(input.selector.names)] }; document = FETCH_ACCOUNTS_BY_NAMES; variables = { names: selector.names };
  } else {
    if (typeof input.selector.query !== 'string') throw new Error('Invalid search selector');
    selector = { kind: 'search', query: input.selector.query }; document = SEARCH_ACCOUNTS_PAGE; variables = { query: selector.query };
  }
  const results = await Promise.all(input.sources.map(async source => {
    const valid = new Set<unknown>();
    const snapshot = await readIndexedPageFacts({ source, query: input.query, document, collection: 'accounts', initialCursor: '0x',
      variables: { ...variables, registry: source.contract!.toLowerCase() }, pageSize: input.pageSize, maxPages: input.maxPages,
      validateRow: row => {
        const registry = row.registry as { id?: string } | null;
        if (registry?.id?.toLowerCase() !== source.contract!.toLowerCase() || typeof row.id !== 'string' || !/^0x[\da-f]{40}$/i.test(row.id)
          || typeof row.user !== 'string' || row.user.toLowerCase() !== row.id.toLowerCase()
          || typeof row.username !== 'string' || typeof row.isDeleted !== 'boolean') throw new Error('Identity scope mismatch');
        if (selector.kind === 'addresses' && !selector.addresses.includes(row.id.toLowerCase())) throw new Error('Address selector mismatch');
        if (selector.kind === 'names' && (!selector.names.includes(row.username) || row.isDeleted)) throw new Error('Name selector mismatch');
        if (selector.kind === 'search' && (!row.username.toLowerCase().includes(selector.query.toLowerCase()) || row.isDeleted)) throw new Error('Search selector mismatch');
        for (const field of ['registeredAt', 'registeredAtBlock', 'lastUpdatedAt']) requireRawUint(row[field] as string);
        if (row.profileMetadataHash !== null && (typeof row.profileMetadataHash !== 'string' || !/^0x[\da-f]{64}$/i.test(row.profileMetadataHash))) throw new Error('Profile pointer unavailable');
        if (row.metadata !== null) {
          const metadata = row.metadata as Record<string, unknown> | undefined;
          if (!metadata || typeof metadata.id !== 'string') throw new Error('Profile metadata unavailable');
          for (const field of ['bio', 'avatar', 'github', 'twitter', 'website']) if (metadata[field] !== null && typeof metadata[field] !== 'string') throw new Error('Profile field unavailable');
        }
        valid.add(row);
      } });
    const data = snapshot.data.filter(row => valid.has(row)).map(row => ({ ...row, source: { ...snapshot.source, account: String(row.id), contract: String((row.registry as { id: string }).id) } } as unknown as IdentityAccount));
    return { status: 'fulfilled' as const, snapshot: { ...snapshot, data } };
  }));
  return { ...reduceSourceResults(input.sources, results, { blockAlignment: 'independent' }), selector, observations: results.map(result => result.snapshot) };
}

/** Exact address/name lookup across the requested source sweep. Partial results remain available
 * in data, but unknown never becomes a free-name or absent-account decision. */
export function lookupIdentityFact(facts: IdentityFacts, selector: { address: string } | { username: string }): Fact<readonly IdentityAccount[]> {
  const covered = 'address' in selector
    ? facts.selector.kind === 'addresses' && facts.selector.addresses.includes(selector.address.toLowerCase())
    : facts.selector.kind === 'names' && facts.selector.names.includes(selector.username);
  if (!covered) return unknownFact('IDENTITY_SELECTOR_NOT_COVERED');
  if (!facts.sources.length || facts.coverage.status !== 'complete') return unknownFact('IDENTITY_SOURCES_INCOMPLETE');
  return knownFact(facts.data.filter(row => 'address' in selector ? row.id.toLowerCase() === selector.address.toLowerCase() : row.username === selector.username));
}
