/** Account documents carry explicit selectors; source chain/endpoint is supplied by the reader. */
export const FETCH_ACCOUNT_FACTS = `
  query AccountFacts($account: Bytes!, $registry: String!, $block: Block_height) {
    _meta(block: $block) { block { number hash timestamp } }
    passkeyAccounts(where: { id: $account }, block: $block, first: 2) {
      id factory { id accountBeacon } initialCredentialId owner guardian recoveryDelay createdAt blockNumber transactionHash
    }
    accounts(where: { id: $account, registry: $registry }, block: $block, first: 2) {
      id user username isDeleted registeredAt registeredAtBlock profileMetadataHash registry { id }
    }
  }
`;
export const FETCH_CREDENTIAL_PAGE = `
  query CredentialPage($account: String!, $cursor: String!, $first: Int!, $block: Block_height) {
    _meta(block: $block) { block { number hash timestamp } }
    passkeyCredentials(where: { account: $account, id_gt: $cursor }, orderBy: id, orderDirection: asc, first: $first, block: $block) {
      id account { id factory { id } } credentialId active signCount publicKeyX publicKeyY createdAt removedAt blockNumber
    }
  }
`;
/** Older indexers do not emit/read keys. Missing keys must stay unknown. */
export const FETCH_CREDENTIAL_PAGE_LEGACY = FETCH_CREDENTIAL_PAGE.replace('publicKeyX publicKeyY ', '');
export const FETCH_CREDENTIAL_PAGE_TIERS = [FETCH_CREDENTIAL_PAGE, FETCH_CREDENTIAL_PAGE_LEGACY];
export const FETCH_CREDENTIAL_DISCOVERY_PAGE = FETCH_CREDENTIAL_PAGE
  .replace('CredentialPage', 'CredentialDiscoveryPage').replace('$account: String!', '$credentialId: Bytes!')
  .replace('account: $account,', 'credentialId: $credentialId,');
export const FETCH_CREDENTIAL_DISCOVERY_PAGE_TIERS = [FETCH_CREDENTIAL_DISCOVERY_PAGE, FETCH_CREDENTIAL_DISCOVERY_PAGE.replace('publicKeyX publicKeyY ', '')];
export const FETCH_FACTORY_FACTS = `
  query FactoryFacts($factory: Bytes!, $registry: Bytes!, $block: Block_height) {
    _meta(block: $block) { block { number hash timestamp } }
    passkeyAccountFactories(where: { id: $factory }, first: 2, block: $block) {
      id poaManager accountBeacon poaGuardian recoveryDelay maxCredentialsPerAccount paused createdAt blockNumber
    }
    universalAccountRegistries(where: { id: $registry }, first: 2, block: $block) { id passkeyFactory totalAccounts createdAt createdAtBlock }
  }
`;
export const FETCH_SOLIDARITY_STATE = `
  query SolidarityState($hub: Bytes!, $block: Block_height) {
    _meta(block: $block) { block { number hash timestamp } }
    paymasterHubContracts(where: { id: $hub }, first: 2, block: $block) {
      id entryPoint solidarityBalance solidarityDistributionPaused totalFeesCollected createdAt createdAtBlock
    }
    onboardingConfigs(where: { id: $hub }, first: 2, block: $block) {
      id maxGasPerCreation dailyCreationLimit enabled accountRegistry updatedAt blockNumber
    }
  }
`;
