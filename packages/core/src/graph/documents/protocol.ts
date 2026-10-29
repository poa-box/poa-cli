/** Explicit protocol instances. Indexed config is descriptive history, never a fresh getter. */
export const FETCH_PROTOCOL_OVERVIEW = `
  query ProtocolOverview($manager: Bytes!, $registry: Bytes!, $accountRegistry: Bytes!, $hub: Bytes!, $block: Block_height) {
    _meta(block: $block) { block { number hash timestamp } }
    poaManagerContracts(where: { id: $manager }, first: 2, block: $block) {
      id registry beaconCount orgDeployerProxy orgRegistryProxy paymasterHubProxy globalAccountRegistryProxy passkeyAccountFactoryProxy createdAt createdAtBlock
    }
    orgRegistryContracts(where: { id: $registry }, first: 2, block: $block) { id totalOrgs totalContracts }
    universalAccountRegistries(where: { id: $accountRegistry }, first: 2, block: $block) { id totalAccounts passkeyFactory }
    paymasterHubContracts(where: { id: $hub }, first: 2, block: $block) {
      id entryPoint totalDeposit solidarityBalance totalFeesCollected solidarityDistributionPaused gracePeriodDays maxSpendDuringGrace minDepositRequired createdAt createdAtBlock
    }
    onboardingConfigs(where: { id: $hub }, first: 2, block: $block) { id maxGasPerCreation dailyCreationLimit enabled accountRegistry updatedAt blockNumber }
    orgDeployConfigs(where: { id: $hub }, first: 2, block: $block) { id maxGasPerDeploy dailyDeployLimit maxDeploysPerAccount enabled orgDeployer updatedAt blockNumber }
  }
`;
export const FETCH_PROTOCOL_ORGS_PAGE = `
  query ProtocolOrgsPage($hub: String!, $cursor: String!, $first: Int!, $block: Block_height) {
    _meta(block: $block) { block { number hash timestamp } }
    paymasterOrgConfigs(where: { paymasterHub: $hub, id_gt: $cursor }, first: $first, orderBy: id, orderDirection: asc, block: $block) {
      id orgId paymasterHub { id } totalSpent totalSolidarityReceived depositBalance totalDeposited stats { totalUserOps totalGasSponsored }
    }
  }
`;
export const FETCH_BEACON_EVENTS_PAGE = `
  query BeaconEventsPage($manager: String!, $cursor: Bytes!, $first: Int!, $block: Block_height) {
    _meta(block: $block) { block { number hash timestamp } }
    beaconUpgradeEvents(where: { poaManager: $manager, id_gt: $cursor }, first: $first, orderBy: id, orderDirection: asc, block: $block) {
      id poaManager { id } beacon { id beaconAddress } typeId newImplementation version upgradedAt upgradedAtBlock transactionHash
    }
  }
`;
export const FETCH_SOLIDARITY_EVENTS_PAGE = `
  query SolidarityEventsPage($hub: String!, $cursor: Bytes!, $first: Int!, $block: Block_height) {
    _meta(block: $block) { block { number hash timestamp } }
    solidarityEvents(where: { paymasterHub: $hub, id_gt: $cursor }, first: $first, orderBy: id, orderDirection: asc, block: $block) {
      id paymasterHub { id } orgConfig { id orgId } eventType from amount eventAt eventAtBlock transactionHash
    }
  }
`;
