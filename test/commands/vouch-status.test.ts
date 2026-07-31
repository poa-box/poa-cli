/**
 * pop vouch status — signer rate-limit awareness rendering.
 *
 * The wearer-side fields (currentVouchCount vs quorum, isVouchingEnabled,
 * canClaim) are preserved, and the signer-side gate is additive:
 *   - canUserVouch true  → "You can vouch (2/3 used today)"
 *   - daily limit hit    → warn "Daily vouch limit reached (3/3 used today)"
 *                          + UTC-midnight reset hint
 *   - join-grace         → warn "Account too new" + unlock estimate
 *   - no key available   → pointer at POP_PRIVATE_KEY, no gate reads
 *
 * createReadContract is the mocked seam so the REAL helpers
 * (readVoucherGate, vouchRestriction, decodeVouchConfig) run against
 * fixture reads.
 *
 * Wearer-side sourcing (subgraph migration): the config + vouch count come
 * from the subgraph when it answers, and fall back to the on-chain getters
 * when it does not. The signer-side gate is RPC-only either way.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createProvider: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  createReadContract: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../src/lib/signer', () => ({
  createProvider: mocks.createProvider,
  createSigner: mocks.createSigner,
}));
vi.mock('../../src/lib/subgraph', () => ({
  query: mocks.query,
}));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => modules[key],
}));
vi.mock('../../src/lib/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/contracts')>();
  return { ...actual, createReadContract: mocks.createReadContract };
});
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
    json: vi.fn(),
    keyValueBlock: vi.fn(),
    isJsonMode: vi.fn(() => false),
    subgraphLagWarning: vi.fn(),
    debug: vi.fn(),
  };
});

import { ethers } from 'ethers';
import { statusHandler } from '../../src/commands/vouch/status';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const EM_ADDR = '0x1111111111111111111111111111111111111111';
const WEARER = '0x4444444444444444444444444444444444444444';
const ORG_ID = '0x' + 'ab'.repeat(32);
// Deterministic signer for the --private-key path
const SIGNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SIGNER_ADDR = new ethers.Wallet(SIGNER_KEY).address;

const NOW = Math.floor(Date.now() / 1000);

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

/** Fixture read contract: wearer progress + signer gate reads. */
function fakeReader(overrides: Record<string, any> = {}) {
  return {
    currentVouchCount: vi.fn(async () => ethers.BigNumber.from(2)),
    isVouchingEnabled: vi.fn(async () => true),
    vouchConfigs: vi.fn(async () => ({
      quorum: 3,
      membershipHatId: ethers.BigNumber.from(45),
      flags: 1, // enabled, no hierarchy combine
    })),
    canUserVouch: vi.fn(async () => true),
    getCurrentDailyVouchCount: vi.fn(async () => ethers.BigNumber.from(2)),
    getMaxDailyVouches: vi.fn(async () => ethers.BigNumber.from(3)),
    getUserJoinTime: vi.fn(async () => ethers.BigNumber.from(0)),
    ...overrides,
  };
}

/**
 * Subgraph payload shaped like the live poa-gnosis-v-1 response, matching the
 * on-chain fixture above (quorum 3, membership hat 45, 2 active vouches).
 */
function subgraphPayload(overrides: Record<string, any> = {}) {
  return {
    vouchConfigs: [{
      id: `${EM_ADDR}-123`,
      hatId: '123',
      quorum: 3,
      membershipHatId: '45',
      enabled: true,
      combinesWithHierarchy: false,
    }],
    vouches: [{ id: 'v1' }, { id: 'v2' }],
    ...overrides,
  };
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    hat: '123',
    address: WEARER,
    'private-key': SIGNER_KEY,
    privateKey: SIGNER_KEY,
    ...overrides,
  };
}

describe('pop vouch status — rate-limit awareness', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let savedEnvKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedEnvKey = process.env.POP_PRIVATE_KEY;
    delete process.env.POP_PRIVATE_KEY;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);

    mocks.resolveOrgModules.mockResolvedValue({ orgId: ORG_ID, eligibilityModuleAddress: EM_ADDR });
    mocks.createProvider.mockReturnValue({});
    mocks.createReadContract.mockReturnValue(fakeReader());
    // Default: subgraph unavailable, so the suite below exercises the RPC
    // fallback path exactly as it did before the migration.
    mocks.query.mockRejectedValue(new Error('subgraph down'));
    (output.isJsonMode as any).mockReturnValue(false);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    if (savedEnvKey === undefined) delete process.env.POP_PRIVATE_KEY;
    else process.env.POP_PRIVATE_KEY = savedEnvKey;
  });

  it('signer can vouch: renders "You can vouch (2/3 used today)"', async () => {
    await statusHandler.handler(baseArgv());

    expect(output.info).toHaveBeenCalledWith('You can vouch (2/3 used today)');
    expect(output.warn).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('daily limit hit: warns with the used/max quota and the UTC reset hint', async () => {
    mocks.createReadContract.mockReturnValue(fakeReader({
      canUserVouch: vi.fn(async () => false),
      getCurrentDailyVouchCount: vi.fn(async () => ethers.BigNumber.from(3)),
    }));

    await statusHandler.handler(baseArgv());

    const [message] = (output.warn as any).mock.calls[0];
    expect(message).toContain('Daily vouch limit reached (3/3 used today)');
    expect(message).toContain('resets');
    expect(output.info).not.toHaveBeenCalledWith(expect.stringContaining('You can vouch'));
  });

  it('join-grace restriction: warns "Account too new" with an unlock estimate', async () => {
    mocks.createReadContract.mockReturnValue(fakeReader({
      canUserVouch: vi.fn(async () => false),
      getCurrentDailyVouchCount: vi.fn(async () => ethers.BigNumber.from(0)),
      getUserJoinTime: vi.fn(async () => ethers.BigNumber.from(NOW - 3600)), // joined 1h ago
    }));

    await statusHandler.handler(baseArgv());

    const [message] = (output.warn as any).mock.calls[0];
    expect(message).toContain('Account too new');
    expect(message).toContain('unlocks in');
  });

  it('no signer key: prints the pointer and skips the gate reads', async () => {
    const reader = fakeReader();
    mocks.createReadContract.mockReturnValue(reader);

    await statusHandler.handler(baseArgv({ 'private-key': undefined, privateKey: undefined }));

    expect(output.info).toHaveBeenCalledWith(expect.stringContaining('POP_PRIVATE_KEY'));
    expect(reader.canUserVouch).not.toHaveBeenCalled();
    expect(reader.getCurrentDailyVouchCount).not.toHaveBeenCalled();
  });

  it('--json: legacy wearer fields preserved, voucher gate additive', async () => {
    (output.isJsonMode as any).mockReturnValue(true);

    await statusHandler.handler(baseArgv());

    expect(output.json).toHaveBeenCalledTimes(1);
    const payload = (output.json as any).mock.calls[0][0];
    // Legacy shape preserved
    expect(payload).toMatchObject({
      hat: '123',
      wearer: WEARER,
      vouchingEnabled: true,
      currentVouches: '2',
      requiredVouches: '3',
      canClaim: false,
    });
    // Additive signer-side gate
    expect(payload.voucher).toMatchObject({
      address: SIGNER_ADDR,
      canVouch: true,
      dailyVouchesUsed: 2,
      maxDailyVouches: 3,
    });
    expect(payload.voucher.restriction).toBeUndefined();
  });

  it('quorum met: canClaim true and the claim command is surfaced', async () => {
    mocks.createReadContract.mockReturnValue(fakeReader({
      currentVouchCount: vi.fn(async () => ethers.BigNumber.from(3)),
    }));
    (output.isJsonMode as any).mockReturnValue(true);

    await statusHandler.handler(baseArgv());

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.canClaim).toBe(true);
  });

  it('read failure: exits non-zero via the CliError path', async () => {
    mocks.resolveOrgModules.mockRejectedValue(new Error('org not found'));

    await expect(statusHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);
    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
  });
});

describe('pop vouch status — subgraph-first wearer progress', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let savedEnvKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedEnvKey = process.env.POP_PRIVATE_KEY;
    delete process.env.POP_PRIVATE_KEY;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);

    mocks.resolveOrgModules.mockResolvedValue({ orgId: ORG_ID, eligibilityModuleAddress: EM_ADDR });
    mocks.createProvider.mockReturnValue({});
    mocks.createReadContract.mockReturnValue(fakeReader());
    mocks.query.mockResolvedValue(subgraphPayload());
    (output.isJsonMode as any).mockReturnValue(true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    if (savedEnvKey === undefined) delete process.env.POP_PRIVATE_KEY;
    else process.env.POP_PRIVATE_KEY = savedEnvKey;
  });

  it('serves config + vouch count from the subgraph, skipping the on-chain getters', async () => {
    const reader = fakeReader();
    mocks.createReadContract.mockReturnValue(reader);

    await statusHandler.handler(baseArgv());

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload).toMatchObject({
      hat: '123',
      wearer: WEARER,
      vouchingEnabled: true,
      currentVouches: '2',
      requiredVouches: '3',
      canClaim: false,
      membershipHat: '45',
      combineWithHierarchy: false,
    });
    // Wearer-side RPC reads eliminated entirely.
    expect(reader.currentVouchCount).not.toHaveBeenCalled();
    expect(reader.vouchConfigs).not.toHaveBeenCalled();
    expect(reader.isVouchingEnabled).not.toHaveBeenCalled();
    // Signer gate has no subgraph equivalent — still read on chain.
    expect(reader.canUserVouch).toHaveBeenCalled();
    expect(reader.getMaxDailyVouches).toHaveBeenCalled();
  });

  it('passes the module address, decimal hat id and wearer as query variables', async () => {
    await statusHandler.handler(baseArgv({ hat: '0x7b' })); // 0x7b === 123

    const [, variables] = mocks.query.mock.calls[0];
    expect(variables).toEqual({
      eligibilityModuleId: EM_ADDR,
      hatId: '123',
      wearer: WEARER,
    });
  });

  it('quorum reached on the subgraph → canClaim true', async () => {
    mocks.query.mockResolvedValue(subgraphPayload({
      vouches: [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }],
    }));

    await statusHandler.handler(baseArgv());

    expect((output.json as any).mock.calls[0][0].canClaim).toBe(true);
  });

  it('missing VouchConfig row is ambiguous → falls back to the on-chain getters', async () => {
    const reader = fakeReader();
    mocks.createReadContract.mockReturnValue(reader);
    mocks.query.mockResolvedValue({ vouchConfigs: [], vouches: [] });

    await statusHandler.handler(baseArgv());

    expect(reader.vouchConfigs).toHaveBeenCalled();
    expect(reader.currentVouchCount).toHaveBeenCalled();
    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.currentVouches).toBe('2');
    expect(payload.requiredVouches).toBe('3');
  });

  it('a full 1000-row page cannot be trusted as a count → falls back to RPC', async () => {
    const reader = fakeReader();
    mocks.createReadContract.mockReturnValue(reader);
    mocks.query.mockResolvedValue(subgraphPayload({
      vouches: Array.from({ length: 1000 }, (_, i) => ({ id: `v${i}` })),
    }));

    await statusHandler.handler(baseArgv());

    expect(reader.currentVouchCount).toHaveBeenCalled();
    expect((output.json as any).mock.calls[0][0].currentVouches).toBe('2');
  });

  it('subgraph error degrades to RPC without failing the command', async () => {
    const reader = fakeReader();
    mocks.createReadContract.mockReturnValue(reader);
    mocks.query.mockRejectedValue(new Error('502 bad gateway'));

    await statusHandler.handler(baseArgv());

    expect(exitSpy).not.toHaveBeenCalled();
    expect(reader.vouchConfigs).toHaveBeenCalled();
    expect((output.json as any).mock.calls[0][0].currentVouches).toBe('2');
  });

  it('--rpc pins the read to that node and never queries the subgraph', async () => {
    const reader = fakeReader();
    mocks.createReadContract.mockReturnValue(reader);

    await statusHandler.handler(baseArgv({ rpc: 'http://localhost:8545' }));

    expect(mocks.query).not.toHaveBeenCalled();
    expect(reader.vouchConfigs).toHaveBeenCalled();
    expect(reader.currentVouchCount).toHaveBeenCalled();
  });

  it('subgraph and RPC agree on the same fixture (no --json shape drift)', async () => {
    await statusHandler.handler(baseArgv());
    const fromSubgraph = (output.json as any).mock.calls[0][0];

    (output.json as any).mockClear();
    mocks.query.mockRejectedValue(new Error('subgraph down'));
    await statusHandler.handler(baseArgv());
    const fromRpc = (output.json as any).mock.calls[0][0];

    expect(Object.keys(fromSubgraph)).toEqual(Object.keys(fromRpc));
    expect(fromSubgraph).toEqual(fromRpc);
  });
});
