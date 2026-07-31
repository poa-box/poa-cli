/**
 * pop treasury claim-mine — the payout-token metadata read is hoisted out of the loop.
 *
 * `resolvePayoutTokenInfo` is a pair of ERC20 eth_calls (decimals + symbol) that CANNOT come
 * from the subgraph — arbitrary ERC20s are not indexed. But claim-mine called it once per
 * distribution, and an org pays every distribution in the same one or two tokens (all five live
 * Gnosis distributions share one BREAD address), so an org with N distributions burned 2N calls
 * to learn the same two facts.
 *
 * It is memoised per distinct token address rather than moved after the root/allocation checks,
 * because both failure results report `symbol` in --json and agents parse that shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  createReadContract: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/signer', () => ({ createSigner: mocks.createSigner }));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => modules[key],
}));
vi.mock('../../src/lib/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/contracts')>();
  return { ...actual, createReadContract: mocks.createReadContract };
});
vi.mock('../../src/lib/preflight', () => ({
  runPreflight: mocks.runPreflight,
  checkGasBalance: mocks.checkGasBalance,
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
    json: vi.fn(),
    keyValueBlock: vi.fn(),
    isJsonMode: vi.fn(() => true),
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import { claimMineHandler } from '../../src/commands/treasury/claim-mine';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import * as output from '../../src/lib/output';

const PM_ADDR = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const MEMBER = '0x3333333333333333333333333333333333333333';
const BREAD = '0x4444444444444444444444444444444444444444';
const WXDAI = '0x5555555555555555555555555555555555555555';
const ORG_ID = '0x' + 'ab'.repeat(32);

function activeDist(id: number, payoutToken: string) {
  return {
    distributionId: String(id),
    totalAmount: ethers.utils.parseEther('100').toString(),
    // Deliberately not the root the recomputation produces: these distributions end as
    // "Root mismatch", which is the branch that still has to report `symbol`.
    merkleRoot: '0x' + '11'.repeat(32),
    checkpointBlock: String(41000000 + id),
    payoutToken,
    claims: [],
  };
}

/** Route the two documents claim-mine issues by their operation name. */
function installSubgraph(distributions: any[]) {
  mocks.query.mockImplementation(async (doc: string) => {
    if (doc.includes('FetchActiveDistributions')) {
      return { organization: { paymentManager: { distributions } } };
    }
    return {
      organization: {
        participationToken: { totalSupply: '100' },
        users: [{ address: MEMBER, participationTokenBalance: '100', membershipStatus: 'Active' }],
      },
      optOutToggles: [],
    };
  });
}

describe('pop treasury claim-mine — payout-token reads are memoised across the loop', () => {
  let pmRead: { hasClaimed: ReturnType<typeof vi.fn>; isOptedOut: ReturnType<typeof vi.fn> };
  let erc20Read: { decimals: ReturnType<typeof vi.fn>; symbol: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    _clearWriteContextCacheForTest();
    _setStreamsForTest(undefined, undefined, false);

    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      provider: {},
      address: WALLET,
      chainId: 100,
    });
    mocks.resolveOrgModules.mockResolvedValue({ orgId: ORG_ID, paymentManagerAddress: PM_ADDR });

    pmRead = {
      hasClaimed: vi.fn().mockResolvedValue(false),
      isOptedOut: vi.fn().mockResolvedValue(false),
    };
    erc20Read = { decimals: vi.fn().mockResolvedValue(18), symbol: vi.fn().mockResolvedValue('BREAD') };
    mocks.createReadContract.mockImplementation((_addr: string, abiName: string) =>
      abiName === 'PaymentManager' ? pmRead : erc20Read
    );

    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.checkGasBalance.mockReturnValue({ label: 'gas balance' });
  });

  afterEach(() => {
    _setStreamsForTest();
  });

  it('resolves one shared payout token ONCE across three distributions', async () => {
    installSubgraph([activeDist(1, BREAD), activeDist(2, BREAD), activeDist(3, BREAD)]);

    await claimMineHandler.handler({ _: [], $0: 'pop', org: 'testorg', preflight: true } as any);

    expect(erc20Read.decimals).toHaveBeenCalledTimes(1);
    expect(erc20Read.symbol).toHaveBeenCalledTimes(1);
  });

  it('resolves each DISTINCT payout token exactly once', async () => {
    installSubgraph([activeDist(1, BREAD), activeDist(2, WXDAI), activeDist(3, BREAD), activeDist(4, WXDAI)]);

    await claimMineHandler.handler({ _: [], $0: 'pop', org: 'testorg', preflight: true } as any);

    expect(erc20Read.decimals).toHaveBeenCalledTimes(2);
  });

  it('every result still carries its symbol — the --json shape is unchanged', async () => {
    installSubgraph([activeDist(1, BREAD), activeDist(2, BREAD)]);

    await claimMineHandler.handler({ _: [], $0: 'pop', org: 'testorg', preflight: true } as any);

    expect(output.json).toHaveBeenCalledWith(
      expect.objectContaining({
        claimed: 0,
        distributions: [
          expect.objectContaining({ distId: '1', symbol: 'BREAD', success: false, error: expect.stringContaining('Root mismatch') }),
          expect.objectContaining({ distId: '2', symbol: 'BREAD', success: false, error: expect.stringContaining('Root mismatch') }),
        ],
      })
    );
  });

  it('the opt-out warning stays a single on-chain read outside the loop', async () => {
    installSubgraph([activeDist(1, BREAD), activeDist(2, BREAD), activeDist(3, BREAD)]);

    await claimMineHandler.handler({ _: [], $0: 'pop', org: 'testorg', preflight: true } as any);

    expect(pmRead.isOptedOut).toHaveBeenCalledTimes(1);
  });
});
