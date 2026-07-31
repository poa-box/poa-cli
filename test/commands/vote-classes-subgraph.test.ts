/**
 * `pop vote classes show` — subgraph-first reads.
 *
 * The three contract calls this command used to make (getClasses /
 * getProposalClasses + thresholdPct + quorum) are all mirrored by the
 * subgraph, and `pop vote results` already sourced thresholdPct/quorum from
 * HybridVotingContract — two sources for one number inside one command family.
 * These tests pin the unified behaviour AND the fallback, because the contract
 * remains authoritative for un-indexed orgs and older deployments.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';

const {
  resolveOrgModulesMock,
  createReadContractMock,
  queryWithFieldFallbackMock,
  jsonMock,
  isJsonModeMock,
  tableMock,
} = vi.hoisted(() => ({
  resolveOrgModulesMock: vi.fn(),
  createReadContractMock: vi.fn(),
  queryWithFieldFallbackMock: vi.fn(),
  jsonMock: vi.fn(),
  isJsonModeMock: vi.fn(() => true),
  tableMock: vi.fn(),
}));

vi.mock('../../src/lib/resolve', () => ({ resolveOrgModules: resolveOrgModulesMock }));
vi.mock('../../src/lib/subgraph', () => ({
  query: vi.fn(),
  queryWithFieldFallback: queryWithFieldFallbackMock,
}));
vi.mock('../../src/lib/signer', () => ({
  createProvider: vi.fn(() => ({})),
  createSigner: vi.fn(() => ({ signer: {} })),
}));
vi.mock('../../src/lib/contracts', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, createReadContract: createReadContractMock, createWriteContract: vi.fn() };
});
vi.mock('../../src/lib/command', () => ({
  getWriteContext: vi.fn(), confirmWrite: vi.fn(), finishWrite: vi.fn(), withIdempotency: vi.fn(),
}));
vi.mock('../../src/lib/preflight', () => ({
  runPreflight: vi.fn(), checkGasBalance: vi.fn(() => ({ label: 'gas balance' })),
}));
vi.mock('../../src/lib/output', () => ({
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), text: '' })),
  success: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(),
  table: tableMock, json: jsonMock, isJsonMode: isJsonModeMock, keyValueBlock: vi.fn(),
}));

import { classesShowHandler } from '../../src/commands/vote/classes';

const HYBRID_ADDR = ethers.utils.getAddress('0x' + '1a'.repeat(20));
const ASSET = ethers.utils.getAddress('0x' + '2b'.repeat(20));
const BIG_HAT_ID = '26959946667150639794667015087019630673637144422540572481103610249216';

function modules(): any {
  return { orgId: '0x' + '11'.repeat(32), hybridVotingAddress: HYBRID_ADDR };
}

function subgraphClasses(version: string) {
  return [
    {
      version, classIndex: 0, strategy: 'DIRECT', slicePct: 80, quadratic: false,
      minBalance: '0', asset: ethers.constants.AddressZero, hatIds: [BIG_HAT_ID], isActive: true,
    },
    {
      version, classIndex: 1, strategy: 'ERC20_BAL', slicePct: 20, quadratic: true,
      minBalance: '1000000000000000000', asset: ASSET.toLowerCase(), hatIds: [], isActive: true,
    },
  ];
}

describe('vote classes show — subgraph first', () => {
  let exitSpy: any;
  let logSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    isJsonModeMock.mockReturnValue(true);
    resolveOrgModulesMock.mockResolvedValue(modules());
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('serves the live config from VotingClass + HybridVotingContract without touching the contract', async () => {
    queryWithFieldFallbackMock.mockResolvedValue({
      tierIndex: 0,
      data: {
        hybridVotingContract: {
          id: HYBRID_ADDR.toLowerCase(),
          thresholdPct: 25,
          quorum: 1,
          classVersion: '45607962',
          // Stale rows from an earlier setClasses() must be ignored.
          votingClasses: [
            ...subgraphClasses('45435144').map(c => ({ ...c, slicePct: c.classIndex === 0 ? 10 : 90 })),
            ...subgraphClasses('45607962'),
          ],
        },
      },
    });

    await classesShowHandler.handler({ org: 'test-org', chain: 100 } as any);

    expect(createReadContractMock).not.toHaveBeenCalled();
    const doc = jsonMock.mock.calls[0][0];
    expect(doc.source).toBe('subgraph');
    expect(doc.scope).toBe('current configuration');
    expect(doc.supportThresholdPct).toBe(25);
    expect(doc.quorumVoterCount).toBe(1);
    expect(doc.classes).toHaveLength(2);
    expect(doc.classes[0]).toEqual({
      classIndex: 0, strategy: 'DIRECT', slicePct: 80, quadratic: false,
      minBalance: '0', asset: ethers.constants.AddressZero, hatIds: [BIG_HAT_ID],
    });
    // The subgraph returns lowercase Bytes; the contract returns a checksummed
    // address. --json must not change casing depending on who answered.
    expect(doc.classes[1].asset).toBe(ASSET);
    expect(doc.classes[1].minBalance).toBe('1000000000000000000');
    expect(doc.classes[1].quadratic).toBe(true);
  });

  it('resolves the per-proposal snapshot through Proposal.classesVersion', async () => {
    queryWithFieldFallbackMock.mockResolvedValue({
      tierIndex: 0,
      data: {
        hybridVotingContract: {
          id: HYBRID_ADDR.toLowerCase(),
          thresholdPct: 51,
          quorum: 0,
          proposals: [{ proposalId: '7', classesVersion: '45435144' }],
          votingClasses: [
            ...subgraphClasses('45435144').map(c => ({ ...c, slicePct: c.classIndex === 0 ? 10 : 90 })),
            ...subgraphClasses('45607962'),
          ],
        },
      },
    });

    await classesShowHandler.handler({ org: 'test-org', proposal: '7', chain: 100 } as any);

    const [, tierOpts] = queryWithFieldFallbackMock.mock.calls[0];
    expect(tierOpts).toEqual({ chainId: 100 });
    expect(queryWithFieldFallbackMock.mock.calls[0][0][0].variables).toEqual({
      hybridVoting: HYBRID_ADDR.toLowerCase(),
      proposalId: '7',
    });
    expect(createReadContractMock).not.toHaveBeenCalled();

    const doc = jsonMock.mock.calls[0][0];
    expect(doc.scope).toBe('snapshot for proposal #7');
    // The FROZEN slices, not the live ones.
    expect(doc.classes.map((c: any) => c.slicePct)).toEqual([10, 90]);
  });

  it('falls back to getClasses/thresholdPct/quorum when the subgraph cannot answer', async () => {
    const contract = {
      getClasses: vi.fn(async () => [{
        strategy: 1, slicePct: 100, quadratic: false,
        minBalance: ethers.BigNumber.from(0), asset: ASSET, hatIds: [],
      }]),
      getProposalClasses: vi.fn(),
      thresholdPct: vi.fn(async () => 60),
      quorum: vi.fn(async () => 3),
    };
    createReadContractMock.mockReturnValue(contract);
    queryWithFieldFallbackMock.mockRejectedValue(new Error('subgraph down'));

    await classesShowHandler.handler({ org: 'test-org', chain: 100 } as any);

    expect(contract.getClasses).toHaveBeenCalledTimes(1);
    const doc = jsonMock.mock.calls[0][0];
    expect(doc.source).toBe('rpc');
    expect(doc.supportThresholdPct).toBe(60);
    expect(doc.quorumVoterCount).toBe(3);
    expect(doc.classes[0].strategy).toBe('ERC20_BAL');
  });

  it('falls back rather than printing an empty table when the contract is not indexed', async () => {
    const contract = {
      getClasses: vi.fn(async () => []),
      getProposalClasses: vi.fn(),
      thresholdPct: vi.fn(async () => 50),
      quorum: vi.fn(async () => 0),
    };
    createReadContractMock.mockReturnValue(contract);
    queryWithFieldFallbackMock.mockResolvedValue({ tierIndex: 0, data: { hybridVotingContract: null } });

    await classesShowHandler.handler({ org: 'test-org', chain: 100 } as any);

    expect(contract.getClasses).toHaveBeenCalledTimes(1);
    expect(jsonMock.mock.calls[0][0].source).toBe('rpc');
  });

  it('never guesses a proposal snapshot: no classesVersion means the contract decides', async () => {
    const contract = {
      getClasses: vi.fn(),
      getProposalClasses: vi.fn(async () => [{
        strategy: 0, slicePct: 100, quadratic: false,
        minBalance: ethers.BigNumber.from(0), asset: ethers.constants.AddressZero, hatIds: [],
      }]),
      thresholdPct: vi.fn(async () => 50),
      quorum: vi.fn(async () => 0),
    };
    createReadContractMock.mockReturnValue(contract);
    queryWithFieldFallbackMock.mockResolvedValue({
      tierIndex: 0,
      data: {
        hybridVotingContract: {
          id: HYBRID_ADDR.toLowerCase(), thresholdPct: 25, quorum: 1,
          proposals: [], // proposal not indexed → version unknown
          votingClasses: subgraphClasses('45607962'),
        },
      },
    });

    await classesShowHandler.handler({ org: 'test-org', proposal: '7', chain: 100 } as any);

    expect(contract.getProposalClasses).toHaveBeenCalledWith(7);
    expect(jsonMock.mock.calls[0][0].source).toBe('rpc');
  });
});

describe('vote classes show — explicit --rpc', () => {
  let exitSpy: any;
  let logSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    isJsonModeMock.mockReturnValue(true);
    resolveOrgModulesMock.mockResolvedValue(modules());
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('never consults the subgraph when the caller pinned an RPC endpoint', async () => {
    const contract = {
      getClasses: vi.fn(async () => [{
        strategy: 0, slicePct: 100, quadratic: false,
        minBalance: ethers.BigNumber.from(0), asset: ethers.constants.AddressZero, hatIds: [],
      }]),
      getProposalClasses: vi.fn(),
      thresholdPct: vi.fn(async () => 51),
      quorum: vi.fn(async () => 2),
    };
    createReadContractMock.mockReturnValue(contract);

    await classesShowHandler.handler({ org: 'test-org', chain: 100, rpc: 'http://localhost:8545' } as any);

    expect(queryWithFieldFallbackMock).not.toHaveBeenCalled();
    expect(contract.getClasses).toHaveBeenCalledTimes(1);
    expect(jsonMock.mock.calls[0][0].source).toBe('rpc');
  });
});
