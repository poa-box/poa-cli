/**
 * Infrastructure Queries
 * Fetch global contract addresses from subgraph.
 */

export const FETCH_INFRASTRUCTURE_ADDRESSES = `
  query FetchInfrastructureAddresses {
    universalAccountRegistries(first: 1) {
      id
      totalAccounts
    }
    poaManagerContracts(first: 1) {
      id
      registry
      orgDeployerProxy
      orgRegistryProxy
      paymasterHubProxy
      globalAccountRegistryProxy
    }
    orgRegistryContracts(first: 1) {
      id
      totalOrgs
    }
    beacons {
      id
      typeName
      beaconAddress
      currentImplementation
      version
    }
  }
`;

export interface InfrastructureAddresses {
  universalAccountRegistries: Array<{
    id: string;
    totalAccounts: string;
  }>;
  poaManagerContracts: Array<{
    id: string;
    registry: string;
    orgDeployerProxy: string;
    orgRegistryProxy: string;
    paymasterHubProxy: string;
    globalAccountRegistryProxy: string;
  }>;
  orgRegistryContracts: Array<{
    id: string;
    totalOrgs: string;
  }>;
  beacons: Array<{
    id: string;
    typeName: string;
    beaconAddress: string;
    currentImplementation: string;
    version: string;
  }>;
}
