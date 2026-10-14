/** Isolated current MembershipAuthority documents. No retired schema fallback. */
export const FETCH_ORG_AUTHORITY = `query OrgAuthority($id: ID!) {
  organization(id: $id) { id name membershipAuthority { id isRouterBound cutoverAt paused } }
}`;

export const FETCH_AUTHORITY_SUBJECTS = `query AuthoritySubjects($orgId: String!, $lastId: String!) {
  subjects(first: 1000, orderBy: id, where: { organization: $orgId, id_gt: $lastId }) {
    id subjectId kind name metadataCID imageURI maxMembers memberCount activeMemberCount defaultAllow
    vouchConfig { quorum voucherSubjectId epoch }
    managerConfig { managerSubjectId caps delaySecs }
    memberRoles(first: 1000, where: { isActive: true }) { role { id subjectId name } }
  }
}`;

export const FETCH_AUTHORITY_MEMBERSHIPS = `query AuthorityMemberships($orgId: String!, $lastId: String!) {
  subjectMemberships(first: 1000, orderBy: id, where: { organization: $orgId, id_gt: $lastId }) {
    id user userUsername accepted eligible isMember claimable acceptedAt seededWhilePaused
    ruleKind eligibilitySource emailVerified vouchCount vouchEpoch vouchMet
    rule { kind author delegable sticky }
    subject { id subjectId kind name defaultAllow vouchConfig { quorum epoch } }
    pendingAction { id pendingId action activatesAt status }
  }
}`;

/** Delegated offers are consumed by claim; only grants/removals use finalize. */
export const FETCH_AUTHORITY_PENDING = `query AuthorityPendingActions($orgId: String!, $lastId: String!) {
  pendingActions(first: 1000, orderBy: id, where: { organization: $orgId, id_gt: $lastId }) {
    id pendingId action user actor actorUsername activatesAt status createdAt resolvedAt cancelledBy transactionHash
    subject { id subjectId kind name }
  }
}`;

export const FETCH_AUTHORITY_PERMS = `query AuthorityPerms($orgId: String!, $lastId: String!) {
  permRows(first: 1000, orderBy: id, where: { organization: $orgId, id_gt: $lastId }) {
    id subject { id subjectId name kind } permKey ctx word value exists inheritGlobal
  }
}`;

export const FETCH_AUTHORITY_VOUCHES = `query AuthorityVouches($orgId: String!, $lastId: String!) {
  subjectVouchRecords(first: 1000, orderBy: id, where: { organization: $orgId, id_gt: $lastId }) {
    id subject { id subjectId } user voucher voucherUsername active epoch seeded vouchedAt
    config { epoch quorum voucherSubjectId }
  }
}`;


export const FETCH_AUTHORITY_STATE = `query AuthorityState($orgId: ID!, $block: Block_height) {
  _meta(block: $block) { block { number hash } }
  organization(id: $orgId, block: $block) { id membershipAuthority {
    id executor paused isRouterBound cutoverAt registeredAt maxDailyVouches initConfigDerived
    subjectCount roleSubjectCount groupSubjectCount acceptedMembershipCount lastUpdatedAt
  } }
}`;
const PAGE_ARGS = '$orgId: String!, $lastId: String!, $first: Int!, $block: Block_height';
const PAGE_FILTER = 'first: $first, orderBy: id, orderDirection: asc, block: $block, where: { organization: $orgId, id_gt: $lastId }';
const META = '_meta(block: $block) { block { number hash } }';
export const FETCH_AUTHORITY_SUBJECTS_PAGE = `query AuthoritySubjectsPage(${PAGE_ARGS}) {
  ${META}
  subjects(${PAGE_FILTER}) {
    id subjectId kind name metadataCID imageURI maxMembers memberCount activeMemberCount defaultAllow
    isLegacyAdopted createdAt createdAtBlock lastUpdatedAt
    vouchConfig { id quorum voucherSubjectId epoch configuredAt lastUpdatedAt voucherSubject { id subjectId kind name } }
    managerConfig { id managerSubjectId caps canGrant canRemove delaySecs enabled setAt lastUpdatedAt managerSubject { id subjectId kind name } }
  }
}`;
export const FETCH_AUTHORITY_MEMBERSHIPS_PAGE = `query AuthorityMembershipsPage(${PAGE_ARGS}) {
  ${META}
  subjectMemberships(${PAGE_FILTER}) {
    id user userUsername accepted acceptedAt seededWhilePaused eligible isMember claimable ruleKind
    eligibilitySource emailVerified vouchCount vouchEpoch vouchMet firstSeenAt lastUpdatedAt
    subject { id subjectId kind name defaultAllow vouchConfig { quorum epoch voucherSubjectId } }
    rule { id kind author delegable sticky setAt clearedAt managerSubject { id subjectId name } }
    pendingAction { id pendingId action user actor actorUsername activatesAt status createdAt resolvedAt cancelledBy }
  }
}`;
export const FETCH_AUTHORITY_GROUP_EDGES_PAGE = `query AuthorityGroupEdgesPage(${PAGE_ARGS}) {
  ${META}
  groupCompositions(${PAGE_FILTER}) {
    id groupSubjectId roleSubjectId isActive addedAt addedAtBlock updatedAt
    group { id subjectId kind name } role { id subjectId kind name }
  }
}`;
export const FETCH_AUTHORITY_PERMS_PAGE = `query AuthorityPermsPage(${PAGE_ARGS}) {
  ${META}
  permRows(${PAGE_FILTER}) {
    id subject { id subjectId kind name } permKey ctx word value exists inheritGlobal foldTag isGlobalCtx setAt clearedAt lastUpdatedAt
  }
}`;
export const FETCH_AUTHORITY_RULES_PAGE = `query AuthorityRulesPage(${PAGE_ARGS}) {
  ${META}
  accessRules(${PAGE_FILTER}) {
    id subject { id subjectId kind name } user kind author delegable sticky setAt clearedAt lastUpdatedAt
    managerSubject { id subjectId kind name }
  }
}`;
export const FETCH_AUTHORITY_VOUCHES_PAGE = `query AuthorityVouchesPage(${PAGE_ARGS}) {
  ${META}
  subjectVouchRecords(${PAGE_FILTER}) {
    id subject { id subjectId kind name } user voucher voucherUsername active epoch seeded vouchedAt revokedAt
    config { id epoch quorum voucherSubjectId configuredAt }
  }
}`;
export const FETCH_AUTHORITY_PENDING_PAGE = `query AuthorityPendingPage(${PAGE_ARGS}) {
  ${META}
  pendingActions(${PAGE_FILTER}) {
    id pendingId action user actor actorUsername activatesAt status createdAt resolvedAt cancelledBy transactionHash
    subject { id subjectId kind name }
  }
}`;

/** Recent display windows, NOT complete authority history or authorization evidence.
 * The host owns the bounded `first` limit and may pin the shared response block. */
export const FETCH_AUTHORITY_MEMBERSHIP_EVENTS_RECENT = `query AuthorityMembershipEventsRecent($authority: String!, $first: Int = 50, $block: Block_height) {
  subjectMembershipEvents(first: $first, orderBy: timestamp, orderDirection: desc, where: { authority: $authority }, block: $block) {
    id action user userUsername actor actorUsername banned delegated timestamp transactionHash
    subject { id subjectId name kind }
  }
  _meta(block: $block) { block { number hash timestamp } }
}`;

export const FETCH_AUTHORITY_CONFIG_LINTS_RECENT = `query AuthorityConfigLintsRecent($authority: String!, $first: Int = 200, $block: Block_height) {
  configLintEvents(first: $first, orderBy: emittedAt, orderDirection: desc, where: { authority: $authority }, block: $block) {
    id code lintCode subjectId emittedAt subject { id name }
  }
  _meta(block: $block) { block { number hash timestamp } }
}`;
