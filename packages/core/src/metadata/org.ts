/**
 * Org metadata documents.
 *
 * KEY ORDER IS A PROTOCOL CONTRACT: the subgraph metadata handlers and the
 * frontend both parse these documents positionally-by-convention, so every
 * object literal below is constructed with an explicit, load-bearing key
 * order. Do not reorder, and do not let a spread introduce new keys after
 * the canonical block.
 *
 * Shapes verified against:
 *   - `pop org deploy`          — src/commands/org/deploy.ts (fresh document)
 *   - `pop org update-metadata` — src/commands/org/update-metadata.ts (merge)
 */

export interface OrgLink {
  name: string;
  url: string;
}

export interface IndexedOrgLink extends OrgLink {
  index: number;
}

/**
 * Stamp each link with its array position, exactly like both CLI commands do
 * (`(links || []).map((l, i) => ({ ...l, index: i }))` — spread first, so any
 * extra keys on a link survive and `index` lands last / is overwritten).
 */
export function stampLinkIndices(links: OrgLink[] | undefined | null): IndexedOrgLink[] {
  return (links || []).map((l, i) => ({ ...l, index: i }));
}

/** Fresh-deploy org metadata document (`pop org deploy`). */
export interface OrgDeployMetadata {
  description: string;
  links: IndexedOrgLink[];
  template: string;
  logo: null;
  backgroundColor: null;
  hideTreasury: boolean;
}

/** Selected launch fields; the historical six-field return type stays available for old inputs. */
export interface OrgDeployMetadataDocument extends Omit<OrgDeployMetadata, 'logo' | 'backgroundColor'> {
  logo: string | null;
  backgroundColor: string | null;
  useTokenSymbol?: boolean;
  taskPayoutHoursOnly?: boolean;
  taskPayoutHourlyRate?: number | null;
  zkEmailAllowlist?: unknown;
  [key: string]: unknown;
}

export interface OrgDeployMetadataInput extends OrgMetadataUpdates {
  template?: string;
}

export type LegacyOrgDeployMetadataInput = Pick<OrgDeployMetadataInput, 'description' | 'links'>
  & { [K in Exclude<keyof OrgDeployMetadataInput, 'description' | 'links'>]?: never };

/** A prepared document may carry its already-pinned CIDv0 or nonzero bytes32. */
export interface PreparedOrgMetadata {
  document: Record<string, unknown>;
  pointer?: string;
}

/** Indexed display projections and failed fetches are never raw write bases. */
export function requireRawOrgMetadata(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error('Expected a raw org metadata JSON object');
  }
  return value as Record<string, any>;
}

export const DEFAULT_TOKEN_LABEL = 'Shares';

export function resolveTokenLabel(params: { useTokenSymbol?: boolean | null; symbol?: string | null } = {}): string {
  return params.useTokenSymbol === true && typeof params.symbol === 'string' && params.symbol.trim()
    ? params.symbol.trim() : DEFAULT_TOKEN_LABEL;
}

/** Validate explicit edits before any content callback. Numeric indexed rates remain supported. */
export function validateOrgMetadataUpdates(updates: OrgMetadataUpdates): void {
  for (const key of ['hideTreasury', 'useTokenSymbol', 'taskPayoutHoursOnly'] as const) {
    if (updates[key] !== undefined && typeof updates[key] !== 'boolean') throw new Error(key + ' must be a boolean');
  }
  for (const key of ['description', 'logoCid', 'backgroundColor'] as const) {
    const value = updates[key];
    if (value !== undefined && !(key !== 'description' && value === null) && typeof value !== 'string') {
      throw new Error(key + ' must be text' + (key === 'description' ? '' : ' or null'));
    }
  }
  if (updates.links !== undefined && (!Array.isArray(updates.links)
    || updates.links.some(link => !link || typeof link.name !== 'string' || typeof link.url !== 'string'))) {
    throw new Error('links must contain name/url pairs');
  }
  if (updates.extensions !== undefined) requireRawOrgMetadata(updates.extensions);
  if (updates.taskPayoutHourlyRate !== undefined && updates.taskPayoutHourlyRate !== null
    && ((typeof updates.taskPayoutHourlyRate !== 'string' && typeof updates.taskPayoutHourlyRate !== 'number')
      || String(updates.taskPayoutHourlyRate).trim() === '' || !Number.isFinite(Number(updates.taskPayoutHourlyRate)))) {
    throw new Error('taskPayoutHourlyRate must be finite numeric text, a number or null');
  }
}

/**
 * Port of the metadata document `pop org deploy` pins before calling
 * OrgDeployer.deployFullOrg — src/commands/org/deploy.ts.
 *
 * Key order (load-bearing): description, links, template, logo,
 * backgroundColor, hideTreasury.
 */
export function buildOrgDeployMetadata(params: LegacyOrgDeployMetadataInput): OrgDeployMetadata;
export function buildOrgDeployMetadata(params: OrgDeployMetadataInput): OrgDeployMetadataDocument;
export function buildOrgDeployMetadata(params: OrgDeployMetadataInput): OrgDeployMetadata | OrgDeployMetadataDocument {
  validateOrgMetadataUpdates(params);
  if (params.template !== undefined && typeof params.template !== 'string') throw new Error('template must be text');
  const doc: OrgDeployMetadataDocument = {
    description: params.description || '',
    links: stampLinkIndices(params.links),
    template: params.template || 'default',
    logo: params.logoCid || null,
    backgroundColor: params.backgroundColor || null,
    hideTreasury: params.hideTreasury ?? false,
  };
  for (const key of ['useTokenSymbol', 'taskPayoutHoursOnly', 'taskPayoutHourlyRate', 'zkEmailAllowlist'] as const) {
    if (params[key] !== undefined) Object.defineProperty(doc, key, {
      value: key === 'taskPayoutHourlyRate' && params[key] !== null ? Number(params[key]) : params[key],
      enumerable: true, configurable: true, writable: true,
    });
  }
  // Extensions cannot replace canonical fields, including omitted preference defaults.
  for (const [key, value] of Object.entries(params.extensions ?? {})) {
    if (!ORG_METADATA_KEYS.has(key)) Object.defineProperty(doc, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return doc;
}

/** Fields `pop org update-metadata` lets the caller override. */
export interface OrgMetadataUpdates {
  description?: string;
  /** Replacement link list — index-stamped here; omit to keep current links. */
  links?: OrgLink[];
  /** CID of a freshly pinned logo; omit to keep the current logo. */
  logoCid?: string | null;
  backgroundColor?: string | null;
  hideTreasury?: boolean;
  useTokenSymbol?: boolean;
  taskPayoutHoursOnly?: boolean;
  taskPayoutHourlyRate?: number | string | null;
  /** Staged invite metadata only; this does not set an on-chain root. */
  zkEmailAllowlist?: unknown;
  /** Unknown JSON extensions; canonical fields must use their explicit patch options. */
  extensions?: Record<string, unknown>;
}

const ORG_METADATA_KEYS = new Set(['description', 'links', 'template', 'logo', 'backgroundColor', 'hideTreasury',
  'useTokenSymbol', 'taskPayoutHoursOnly', 'taskPayoutHourlyRate', 'zkEmailAllowlist']);

/**
 * Canonical merged org metadata (`pop org update-metadata`). The canonical
 * keys are typed; unknown keys from the current IPFS document ride along
 * untyped (that is the point of the merge).
 */
export interface OrgMetadata {
  description: string;
  links: IndexedOrgLink[];
  template: string;
  logo: string | null;
  backgroundColor: string | null;
  hideTreasury: boolean;
  useTokenSymbol: boolean;
  taskPayoutHoursOnly: boolean;
  taskPayoutHourlyRate: number | null;
  [key: string]: unknown;
}

/**
 * Port of the merge in `pop org update-metadata` — src/commands/org/update-metadata.ts.
 *
 * Build metadata JSON — spread the fetched doc, then override only what was passed.
 *
 * Spreading first is what makes this robust: unknown keys survive (e.g.
 * `zkEmailAllowlist`, which the web settings editor writes and reads back),
 * and re-assigning an existing key keeps its original position, so a doc
 * written by the frontend retains the frontend's key order (the subgraph/UI
 * compatibility rule in CLAUDE.md). The explicit keys below then pin the
 * canonical order for a doc that lacks them entirely.
 *
 * `currentMeta` should be the RAW IPFS document when one exists — the
 * subgraph's typed projection only carries the fields schema.graphql
 * declares, so merging over it silently drops everything else.
 */
export function mergeOrgMetadata(
  currentMeta: Record<string, any>,
  updates: OrgMetadataUpdates
): OrgMetadata {
  requireRawOrgMetadata(currentMeta);
  validateOrgMetadataUpdates(updates);
  let links: IndexedOrgLink[] = currentMeta.links || [];
  if (updates.links !== undefined) {
    links = stampLinkIndices(updates.links);
  }

  const metadata: any = {
    ...currentMeta,
    description: updates.description !== undefined ? updates.description : (currentMeta.description || ''),
    links,
    template: currentMeta.template || 'default',
    logo: updates.logoCid !== undefined ? updates.logoCid || null : currentMeta.logo || null,
    backgroundColor: updates.backgroundColor !== undefined ? updates.backgroundColor : (currentMeta.backgroundColor || null),
    hideTreasury: updates.hideTreasury !== undefined ? updates.hideTreasury : (currentMeta.hideTreasury || false),
    useTokenSymbol: updates.useTokenSymbol ?? currentMeta.useTokenSymbol === true,
    taskPayoutHoursOnly: updates.taskPayoutHoursOnly ?? currentMeta.taskPayoutHoursOnly === true,
    // BigDecimal arrives from the SUBGRAPH as a STRING ("12.5") while the raw IPFS doc holds
    // a number. The metadata handler only reads this key when it is JSONValueKind.NUMBER, so
    // echoing a string back would silently drop the rate. Coerce whichever form we got.
    taskPayoutHourlyRate: updates.taskPayoutHourlyRate !== undefined
      ? updates.taskPayoutHourlyRate === null ? null : Number(updates.taskPayoutHourlyRate)
      : currentMeta.taskPayoutHourlyRate != null
      && Number.isFinite(Number(currentMeta.taskPayoutHourlyRate))
      ? Number(currentMeta.taskPayoutHourlyRate)
      : null,
  };
  if (updates.zkEmailAllowlist !== undefined) metadata.zkEmailAllowlist = updates.zkEmailAllowlist;
  for (const [key, value] of Object.entries(updates.extensions ?? {})) {
    if (!ORG_METADATA_KEYS.has(key)) Object.defineProperty(metadata, key, { value, enumerable: true, configurable: true, writable: true });
  }

  return metadata as OrgMetadata;
}

/** Exact serialization both org commands pin (plain JSON.stringify). */
export function serializeOrgMetadata(metadata: OrgDeployMetadata | OrgDeployMetadataDocument | OrgMetadata | Record<string, unknown>): string {
  return JSON.stringify(metadata);
}
