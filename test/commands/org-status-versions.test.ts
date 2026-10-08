/**
 * pop org status — module version panel.
 *
 * buildVersionPanel compares each deployed module proxy's implementation
 * (lib/version.getImplementation) against
 * PoaManager.getCurrentImplementationById(keccak256(typeName)) and annotates
 * behind modules with OrgRegistry.isAutoUpgrade(keccak256(orgId ‖ typeId)).
 * TypeName strings and both derivations verified against contracts
 * origin/main (ModuleTypes.sol, DeployInfrastructure.s.sol, OrgRegistry.sol).
 *
 * Covered here:
 *   - equal impls            → upToDate true, 'up to date'
 *   - differing impls        → behind, with the autoUpgrade on/off/unknown labels
 *   - per-row RPC throw      → nulls, 'version unknown (read failed)'
 *   - handler degrade        → infra query throw → moduleVersionsError (JSON additive)
 *   - --fast                 → skips the panel entirely (no infra query, no RPC)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getImplementation: vi.fn(),
  createReadContract: vi.fn(),
  resolveOrgModules: vi.fn(),
  query: vi.fn(),
  isJsonMode: vi.fn(() => false),
  json: vi.fn(),
}));

vi.mock('../../src/lib/version', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/version')>();
  return { ...actual, getImplementation: mocks.getImplementation };
});
vi.mock('../../src/lib/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/contracts')>();
  return { ...actual, createReadContract: mocks.createReadContract };
});
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => modules[key],
}));
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
vi.mock('../../src/lib/output', () => {
  const makeSpinner = () => {
    const s: any = { text: '' };
    s.start = () => s;
    s.stop = () => s;
    s.succeed = () => s;
    s.fail = () => s;
    return s;
  };
  return {
    spinner: vi.fn(makeSpinner),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    json: mocks.json,
    table: vi.fn(),
    keyValueBlock: vi.fn(),
    isJsonMode: mocks.isJsonMode,
    isQuietMode: vi.fn(() => false),
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import {
  buildVersionPanel,
  versionStatusLabel,
  MODULE_TYPES,
  statusHandler,
} from '../../src/commands/org/status';
import { FETCH_INFRASTRUCTURE_ADDRESSES } from '../../src/queries/infrastructure';
import type { OrgModules } from '../../src/lib/resolve';

const ORG_ID = '0x' + 'ab'.repeat(32);
const TM_PROXY = '0x1111111111111111111111111111111111111111';
const VOTING_PROXY = '0x2222222222222222222222222222222222222222';
const POA_MANAGER = '0x9999999999999999999999999999999999999999';
const ORG_REGISTRY = '0x5555555555555555555555555555555555555555';
const IMPL_A = ethers.utils.getAddress('0x' + 'aa'.repeat(20));
const IMPL_B = ethers.utils.getAddress('0x' + 'bb'.repeat(20));

function modulesFixture(overrides: Partial<OrgModules> = {}): OrgModules {
  return {
    orgId: ORG_ID,
    taskManagerAddress: TM_PROXY,
    hybridVotingAddress: VOTING_PROXY,
    ddVotingAddress: null,
    participationTokenAddress: null,
    educationHubAddress: null,
    executorAddress: null,
    quickJoinAddress: null,
    membershipAuthorityAddress: null,
    paymentManagerAddress: null,
    zkEmailInvitesAddress: null,
    ...overrides,
  };
}

/** Wire the createReadContract mock to PoaManager/OrgRegistry stubs. */
function stubContracts(opts: {
  latest?: (typeId: string) => Promise<string>;
  autoUpgrade?: (contractId: string) => Promise<boolean>;
}) {
  const poaManager = {
    getCurrentImplementationById: vi.fn((typeId: string) =>
      opts.latest ? opts.latest(typeId) : Promise.resolve(IMPL_A)),
  };
  const orgRegistry = {
    isAutoUpgrade: vi.fn((contractId: string) =>
      opts.autoUpgrade ? opts.autoUpgrade(contractId) : Promise.resolve(true)),
  };
  mocks.createReadContract.mockImplementation((_addr: string, abiName: string) =>
    abiName === 'PoaManager' ? poaManager : orgRegistry);
  return { poaManager, orgRegistry };
}

const provider = {} as ethers.providers.Provider; // panel reads go through the mocked seams

describe('buildVersionPanel — impl vs latest comparison', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getImplementation.mockResolvedValue(IMPL_A);
  });

  it('equal implementations → upToDate true, "up to date" label', async () => {
    stubContracts({ latest: async () => IMPL_A });

    const rows = await buildVersionPanel(provider, modulesFixture(), {
      poaManagerAddress: POA_MANAGER,
      orgRegistryAddress: ORG_REGISTRY,
    });

    expect(rows).toHaveLength(2); // only the deployed modules (TM + HybridVoting)
    for (const row of rows) {
      expect(row.upToDate).toBe(true);
      expect(versionStatusLabel(row)).toBe('up to date');
    }
  });

  it('case-insensitive address comparison still reads as up to date', async () => {
    mocks.getImplementation.mockResolvedValue(IMPL_A.toLowerCase());
    stubContracts({ latest: async () => ethers.utils.getAddress(IMPL_A) });

    const rows = await buildVersionPanel(provider, modulesFixture({ hybridVotingAddress: null }), {
      poaManagerAddress: POA_MANAGER,
      orgRegistryAddress: ORG_REGISTRY,
    });
    expect(rows[0].upToDate).toBe(true);
  });

  it('differing implementations + autoUpgrade off → "behind (autoUpgrade off — beacon pinned)"', async () => {
    stubContracts({ latest: async () => IMPL_B, autoUpgrade: async () => false });

    const rows = await buildVersionPanel(provider, modulesFixture({ hybridVotingAddress: null }), {
      poaManagerAddress: POA_MANAGER,
      orgRegistryAddress: ORG_REGISTRY,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].upToDate).toBe(false);
    expect(rows[0].autoUpgrade).toBe(false);
    expect(versionStatusLabel(rows[0])).toContain('behind');
    expect(versionStatusLabel(rows[0])).toContain('autoUpgrade off');
  });

  it('differing implementations + autoUpgrade on → behind but beacon should catch up', async () => {
    stubContracts({ latest: async () => IMPL_B, autoUpgrade: async () => true });

    const rows = await buildVersionPanel(provider, modulesFixture({ hybridVotingAddress: null }), {
      poaManagerAddress: POA_MANAGER,
      orgRegistryAddress: ORG_REGISTRY,
    });

    expect(versionStatusLabel(rows[0])).toContain('behind');
    expect(versionStatusLabel(rows[0])).toContain('autoUpgrade on');
  });

  it('OrgRegistry.isAutoUpgrade revert (ContractUnknown) degrades to impl-vs-latest only', async () => {
    stubContracts({
      latest: async () => IMPL_B,
      autoUpgrade: async () => { throw new Error('ContractUnknown'); },
    });

    const rows = await buildVersionPanel(provider, modulesFixture({ hybridVotingAddress: null }), {
      poaManagerAddress: POA_MANAGER,
      orgRegistryAddress: ORG_REGISTRY,
    });

    expect(rows[0].upToDate).toBe(false);
    expect(rows[0].autoUpgrade).toBeNull();
    expect(versionStatusLabel(rows[0])).toBe('1+ versions behind latest');
  });

  it('per-row RPC throw → nulls + "version unknown (read failed)" (panel survives)', async () => {
    mocks.getImplementation.mockRejectedValue(new Error('RPC down'));
    stubContracts({ latest: async () => { throw new Error('RPC down'); } });

    const rows = await buildVersionPanel(provider, modulesFixture(), {
      poaManagerAddress: POA_MANAGER,
      orgRegistryAddress: ORG_REGISTRY,
    });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.implementation).toBeNull();
      expect(row.latestImplementation).toBeNull();
      expect(row.upToDate).toBeNull();
      expect(versionStatusLabel(row)).toBe('version unknown (read failed)');
    }
  });

  it('queries PoaManager with keccak256(typeName) and OrgRegistry with keccak256(orgId ‖ typeId)', async () => {
    const { poaManager, orgRegistry } = stubContracts({ latest: async () => IMPL_A });

    await buildVersionPanel(provider, modulesFixture({ hybridVotingAddress: null }), {
      poaManagerAddress: POA_MANAGER,
      orgRegistryAddress: ORG_REGISTRY,
    });

    const typeId = ethers.utils.id('TaskManager'); // ModuleTypes.sol derivation
    expect(poaManager.getCurrentImplementationById).toHaveBeenCalledWith(typeId);
    expect(orgRegistry.isAutoUpgrade).toHaveBeenCalledWith(
      ethers.utils.solidityKeccak256(['bytes32', 'bytes32'], [ORG_ID, typeId]) // OrgRegistry.registerOrgContract derivation
    );
  });

  it('no OrgRegistry address → autoUpgrade null without any registry call', async () => {
    stubContracts({ latest: async () => IMPL_B });

    const rows = await buildVersionPanel(provider, modulesFixture({ hybridVotingAddress: null }), {
      poaManagerAddress: POA_MANAGER,
      orgRegistryAddress: null,
    });

    expect(rows[0].autoUpgrade).toBeNull();
  });

  it('MODULE_TYPES typeNames match the verified PoaManager contract-type strings', () => {
    // Each string must be a real PoaManager contract type, i.e. keccak256(typeName) must be a
    // registered beacon typeId. Verified against the live Gnosis beacon set.
    const verified = new Set([
      'TaskManager', 'HybridVoting', 'DirectDemocracyVoting', 'ParticipationToken',
      'EducationHub', 'PaymentManager', 'QuickJoin', 'MembershipAuthority',
      'ZkEmailInvites',
    ]);
    for (const m of MODULE_TYPES) {
      expect(verified.has(m.typeName), `unverified typeName ${m.typeName}`).toBe(true);
    }
  });
});

describe('pop org status handler — panel degradation is additive-only', () => {
  const orgFixture = {
    subjectMemberships: [], users: [],
    organization: {
      name: 'TestOrg',
      taskManager: { projects: [] },
      users: [],
      participationToken: null,
      directDemocracyVoting: null,
      paymentManager: null,
    },
  };

  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isJsonMode.mockReturnValue(true);
    mocks.resolveOrgModules.mockResolvedValue(modulesFixture());
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('infra query throw → moduleVersionsError note, base JSON fields intact', async () => {
    mocks.query.mockImplementation((q: string) =>
      q === FETCH_INFRASTRUCTURE_ADDRESSES
        ? Promise.reject(new Error('subgraph down'))
        : Promise.resolve(orgFixture));

    await statusHandler.handler({ _: [], $0: 'pop', org: 'testorg', chain: 11155111, fast: false } as any);

    expect(mocks.json).toHaveBeenCalledTimes(1);
    const payload = mocks.json.mock.calls[0][0];
    expect(payload.name).toBe('TestOrg');
    expect(payload.members).toBe(0);
    expect(payload.moduleVersions).toBeUndefined();
    expect(payload.moduleVersionsError).toContain('module version check unavailable');
    expect(payload.moduleVersionsError).toContain('subgraph down');
  });

  it('--fast skips the version panel entirely (authority membership and activity reads only)', async () => {
    mocks.query.mockResolvedValue(orgFixture);

    await statusHandler.handler({ _: [], $0: 'pop', org: 'testorg', chain: 11155111, fast: true } as any);

    expect(mocks.query).toHaveBeenCalledTimes(3); // Activity, current memberships and complete user history
    expect(mocks.getImplementation).not.toHaveBeenCalled();
    const payload = mocks.json.mock.calls[0][0];
    expect(payload.moduleVersions).toBeUndefined();
    expect(payload.moduleVersionsError).toBeUndefined();
  });

  it('healthy RPC path lands moduleVersions rows (with status labels) in the JSON payload', async () => {
    mocks.getImplementation.mockResolvedValue(IMPL_A);
    stubContracts({ latest: async () => IMPL_B, autoUpgrade: async () => false });
    mocks.query.mockImplementation((q: string) =>
      q === FETCH_INFRASTRUCTURE_ADDRESSES
        ? Promise.resolve({ poaManagerContracts: [{ id: POA_MANAGER, orgRegistryProxy: ORG_REGISTRY }] })
        : Promise.resolve(orgFixture));

    await statusHandler.handler({ _: [], $0: 'pop', org: 'testorg', chain: 11155111, fast: false } as any);

    const payload = mocks.json.mock.calls[0][0];
    expect(payload.moduleVersions).toHaveLength(2);
    expect(payload.moduleVersions[0]).toMatchObject({
      module: 'TaskManager',
      typeName: 'TaskManager',
      proxy: TM_PROXY,
      upToDate: false,
      autoUpgrade: false,
      status: expect.stringContaining('behind'),
    });
  });
});
