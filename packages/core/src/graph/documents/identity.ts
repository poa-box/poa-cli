/** Endpoint/registry-qualified identity discovery. ID cursors and explicit bounds replace
 * capped batch results. Hosts own source selection, ranking, debounce and profile edit policy. */
const ACCOUNT_FIELDS = `id user username isDeleted registeredAt registeredAtBlock lastUpdatedAt
  registry { id } profileMetadataHash
  metadata { id bio avatar github twitter website }`;
const PAGE_ARGS = '$registry: String!, $cursor: Bytes!, $first: Int!, $block: Block_height';

export const SEARCH_ACCOUNTS_PAGE = `query SearchAccountsPage(${PAGE_ARGS}, $query: String!) {
  _meta(block: $block) { block { number hash timestamp } }
  accounts(first: $first, orderBy: id, orderDirection: asc, block: $block,
    where: { registry: $registry, id_gt: $cursor, username_contains_nocase: $query, isDeleted: false }) {
    ${ACCOUNT_FIELDS}
  }
}`;

export const FETCH_ACCOUNTS_BY_NAMES = `query AccountsByNames(${PAGE_ARGS}, $names: [String!]!) {
  _meta(block: $block) { block { number hash timestamp } }
  accounts(first: $first, orderBy: id, orderDirection: asc, block: $block,
    where: { registry: $registry, id_gt: $cursor, username_in: $names, isDeleted: false }) {
    ${ACCOUNT_FIELDS}
  }
}`;

/** Includes tombstones so an indexed deleted profile is distinguishable from no row. */
export const FETCH_PROFILES_BY_ADDRESSES = `query ProfilesByAddresses(${PAGE_ARGS}, $addresses: [Bytes!]!) {
  _meta(block: $block) { block { number hash timestamp } }
  accounts(first: $first, orderBy: id, orderDirection: asc, block: $block,
    where: { registry: $registry, id_gt: $cursor, id_in: $addresses }) {
    ${ACCOUNT_FIELDS}
  }
}`;
