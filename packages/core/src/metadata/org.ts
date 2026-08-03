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

/**
 * Port of the metadata document `pop org deploy` pins before calling
 * OrgDeployer.deployFullOrg — src/commands/org/deploy.ts.
 *
 * Key order (load-bearing): description, links, template, logo,
 * backgroundColor, hideTreasury.
 */
export function buildOrgDeployMetadata(params: {
  description?: string;
  links?: OrgLink[];
}): OrgDeployMetadata {
  return {
    description: params.description || '',
    links: stampLinkIndices(params.links),
    template: 'default',
    logo: null,
    backgroundColor: null,
    hideTreasury: false,
  };
}

/** Fields `pop org update-metadata` lets the caller override. */
export interface OrgMetadataUpdates {
  description?: string;
  /** Replacement link list — index-stamped here; omit to keep current links. */
  links?: OrgLink[];
  /** CID of a freshly pinned logo; omit to keep the current logo. */
  logoCid?: string | null;
  backgroundColor?: string;
  hideTreasury?: boolean;
}

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
  let links: IndexedOrgLink[] = currentMeta.links || [];
  if (updates.links !== undefined) {
    links = stampLinkIndices(updates.links);
  }

  const metadata: any = {
    ...currentMeta,
    description: updates.description !== undefined ? updates.description : (currentMeta.description || ''),
    links,
    template: currentMeta.template || 'default',
    logo: updates.logoCid || currentMeta.logo || null,
    backgroundColor: updates.backgroundColor !== undefined ? updates.backgroundColor : (currentMeta.backgroundColor || null),
    hideTreasury: updates.hideTreasury !== undefined ? updates.hideTreasury : (currentMeta.hideTreasury || false),
    useTokenSymbol: currentMeta.useTokenSymbol === true,
    taskPayoutHoursOnly: currentMeta.taskPayoutHoursOnly === true,
    // BigDecimal arrives from the SUBGRAPH as a STRING ("12.5") while the raw IPFS doc holds
    // a number. The metadata handler only reads this key when it is JSONValueKind.NUMBER, so
    // echoing a string back would silently drop the rate. Coerce whichever form we got.
    taskPayoutHourlyRate: currentMeta.taskPayoutHourlyRate != null
      && Number.isFinite(Number(currentMeta.taskPayoutHourlyRate))
      ? Number(currentMeta.taskPayoutHourlyRate)
      : null,
  };
  // Subgraph-entity bookkeeping that is not part of the IPFS document. Only reachable when
  // the IPFS fetch was skipped because the org has no metadata pointer yet.
  for (const k of ['id', 'indexedAt', 'organization', '__typename']) delete metadata[k];

  return metadata as OrgMetadata;
}

/** Exact serialization both org commands pin (plain JSON.stringify). */
export function serializeOrgMetadata(metadata: OrgDeployMetadata | OrgMetadata): string {
  return JSON.stringify(metadata);
}
