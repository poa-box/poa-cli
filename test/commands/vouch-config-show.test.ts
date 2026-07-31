/**
 * `pop vouch config show` read sourcing + `pop role apply` pre-flight batching.
 *
 * config show is display-only, so the vouch config is served SUBGRAPH-FIRST
 * with getVouchConfig() kept as fallback. getMaxDailyVouches() has NO subgraph
 * field (EligibilityModuleContract exposes neither maxDailyVouches nor the
 * MaxDailyVouchesSet event it emits), so it stays on chain in both paths and
 * the --json shape is unchanged.
 *
 * role apply's two pre-flight reads BOTH stay on chain — each predicts a
 * revert — but now share one Multicall3 round-trip.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createProvider: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  createReadContract: vi.fn(),
  query: vi.fn(),
  getWriteContext: vi.fn(),
  confirmWrite: vi.fn(),
  finishWrite: vi.fn(),
  withIdempotency: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
}));

vi.mock('../../src/lib/signer', () => ({
  createProvider: mocks.createProvider,
  createSigner: mocks.createSigner,
}));
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => modules[key],
}));
vi.mock('../../src/lib/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/contracts')>();
  return { ...actual, createReadContract: mocks.createReadContract };
});
vi.mock('../../src/lib/command', () => ({
  getWriteContext: mocks.getWriteContext,
  confirmWrite: mocks.confirmWrite,
  finishWrite: mocks.finishWrite,
  withIdempotency: mocks.withIdempotency,
}));
vi.mock('../../src/lib/preflight', () => ({
  runPreflight: mocks.runPreflight,
  checkGasBalance: mocks.checkGasBalance,
}));
vi.mock('../../src/lib/output', () => {
  const makeSpinner = () => {
    const s: any = { text: '' };
    s.start = () => s;
    s.stop = () => s;
    return s;
  };
  return {
    spinner: vi.fn(makeSpinner),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    json: vi.fn(),
    keyValueBlock: vi.fn(),
    isJsonMode: vi.fn(() => true),
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import { configShowHandler } from '../../src/commands/vouch/config';
import { applyHandler } from '../../src/commands/role/apply';
import * as output from '../../src/lib/output';

const EM_ADDR = '0x27114cb757bedf77e30eeb0ca635e3368d8c2914';
const ORG_ID = '0x' + 'cd'.repeat(32);
const SIGNER = '0x9999999999999999999999999999999999999999';

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

function fakeReader(overrides: Record<string, any> = {}) {
  return {
    getVouchConfig: vi.fn(async () => ({
      quorum: 3,
      membershipHatId: ethers.BigNumber.from(45),
      flags: 3, // enabled + combine hierarchy
    })),
    getMaxDailyVouches: vi.fn(async () => ethers.BigNumber.from(20)),
    isVouchingEnabled: vi.fn(async () => true),
    hasActiveApplication: vi.fn(async () => false),
    ...overrides,
  };
}

const SUBGRAPH_ROW = {
  id: `${EM_ADDR}-123`,
  hatId: '123',
  quorum: 3,
  membershipHatId: '45',
  enabled: true,
  combinesWithHierarchy: true,
};

describe('pop vouch config show — subgraph-first config, RPC-only rate limit', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);
    mocks.resolveOrgModules.mockResolvedValue({ orgId: ORG_ID, eligibilityModuleAddress: EM_ADDR });
    mocks.createProvider.mockReturnValue({});
    mocks.createReadContract.mockReturnValue(fakeReader());
    mocks.query.mockResolvedValue({ vouchConfigs: [SUBGRAPH_ROW] });
    (output.isJsonMode as any).mockReturnValue(true);
  });

  afterEach(() => exitSpy.mockRestore());

  it('reads the config from the subgraph and skips getVouchConfig()', async () => {
    const reader = fakeReader();
    mocks.createReadContract.mockReturnValue(reader);

    await configShowHandler.handler({ hat: '123', org: 'testorg' } as any);

    expect(reader.getVouchConfig).not.toHaveBeenCalled();
    // No subgraph field exists for this one — it must still hit the chain.
    expect(reader.getMaxDailyVouches).toHaveBeenCalled();
    expect((output.json as any).mock.calls[0][0]).toEqual({
      hat: '123',
      enabled: true,
      quorum: 3,
      membershipHat: '45',
      combineWithHierarchy: true,
      maxDailyVouches: 20,
      eligibilityModule: EM_ADDR,
    });
  });

  it('produces a byte-identical payload via the RPC fallback', async () => {
    await configShowHandler.handler({ hat: '123', org: 'testorg' } as any);
    const fromSubgraph = (output.json as any).mock.calls[0][0];

    (output.json as any).mockClear();
    mocks.query.mockRejectedValue(new Error('subgraph down'));
    await configShowHandler.handler({ hat: '123', org: 'testorg' } as any);
    const fromRpc = (output.json as any).mock.calls[0][0];

    expect(Object.keys(fromSubgraph)).toEqual(Object.keys(fromRpc));
    expect(fromSubgraph).toEqual(fromRpc);
  });

  it('a missing VouchConfig row falls back to getVouchConfig()', async () => {
    const reader = fakeReader();
    mocks.createReadContract.mockReturnValue(reader);
    mocks.query.mockResolvedValue({ vouchConfigs: [] });

    await configShowHandler.handler({ hat: '123', org: 'testorg' } as any);

    expect(reader.getVouchConfig).toHaveBeenCalled();
    expect((output.json as any).mock.calls[0][0].quorum).toBe(3);
  });

  it('--rpc pins the read to that node and never queries the subgraph', async () => {
    const reader = fakeReader();
    mocks.createReadContract.mockReturnValue(reader);

    await configShowHandler.handler({ hat: '123', org: 'testorg', rpc: 'http://localhost:8545' } as any);

    expect(mocks.query).not.toHaveBeenCalled();
    expect(reader.getVouchConfig).toHaveBeenCalled();
  });

  it('accepts a hex --hat and normalises it to a decimal BigInt variable', async () => {
    await configShowHandler.handler({ hat: '0x7b', org: 'testorg' } as any);

    expect(mocks.query.mock.calls[0][1].hatId).toBe('123');
    // Output still echoes the parsed hat id, as before.
    expect((output.json as any).mock.calls[0][0].hat).toBe('123');
  });
});

describe('pop role apply — both pre-flight reads stay on chain, batched', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);
    mocks.getWriteContext.mockResolvedValue({
      orgId: ORG_ID,
      address: SIGNER,
      networkName: 'gnosis',
      provider: {},
      signer: {},
      modules: { eligibilityModuleAddress: EM_ADDR },
    });
    mocks.createReadContract.mockReturnValue(fakeReader());
    mocks.runPreflight.mockResolvedValue(undefined);
  });

  afterEach(() => exitSpy.mockRestore());

  it('never consults the subgraph for the vouching-enabled / duplicate gates', async () => {
    mocks.confirmWrite.mockRejectedValue(new ExitError(0)); // stop before IPFS/tx

    await expect(applyHandler.handler({ hat: '123', org: 'testorg' } as any))
      .rejects.toBeInstanceOf(ExitError);

    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('fails fast when vouching is disabled for the hat', async () => {
    mocks.createReadContract.mockReturnValue(fakeReader({
      isVouchingEnabled: vi.fn(async () => false),
    }));

    await expect(applyHandler.handler({ hat: '123', org: 'testorg' } as any))
      .rejects.toBeInstanceOf(ExitError);
    expect((output.error as any).mock.calls[0][0]).toMatch(/Vouching is not enabled/);
  });

  it('fails fast on a duplicate application', async () => {
    mocks.createReadContract.mockReturnValue(fakeReader({
      hasActiveApplication: vi.fn(async () => true),
    }));

    await expect(applyHandler.handler({ hat: '123', org: 'testorg' } as any))
      .rejects.toBeInstanceOf(ExitError);
    expect((output.error as any).mock.calls[0][0]).toMatch(/already have an active application/);
  });
});
