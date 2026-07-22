/**
 * pop user whoami — identity + org standing snapshot.
 *
 * The command batches reads through Multicall3 (mocked at the tryAggregate
 * seam with REAL ABI-encoded return payloads, so the command's actual
 * Interface decoding runs) and merges a subgraph snapshot. Assertions:
 *   - --json emits the full structured payload (address, username, balance
 *     {wei/formatted/symbol}, org {member/ptBalance/hats/pendingTokenRequests})
 *   - membership prefers the on-chain member-hat check
 *   - subgraph fallback maps the MembershipStatus ENUM correctly
 *     ('Inactive' must NOT read as a member — regression)
 *   - unregistered signer → username: null
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSigner: vi.fn(),
  createProvider: vi.fn(() => ({ __homeChainProvider: true })),
  resolveOrgModules: vi.fn(),
  tryAggregate: vi.fn(),
  query: vi.fn(),
  isJsonMode: vi.fn(() => true),
}));

vi.mock('../../src/lib/signer', () => ({
  createSigner: mocks.createSigner,
  createProvider: mocks.createProvider,
}));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => modules[key],
}));
vi.mock('../../src/lib/multicall', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/multicall')>();
  return { ...actual, tryAggregate: mocks.tryAggregate };
});
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
    json: vi.fn(),
    keyValueBlock: vi.fn(),
    isJsonMode: mocks.isJsonMode,
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import { whoamiHandler, resolveHatName } from '../../src/commands/user/whoami';
import { HOME_CHAIN_ID } from '../../src/config/networks';
import { MULTICALL3, Call } from '../../src/lib/multicall';
import { formatToken } from '../../src/lib/format';
import * as output from '../../src/lib/output';

const WALLET = '0x2222222222222222222222222222222222222222';
const QJ_ADDR = '0x1111111111111111111111111111111111111111';
const PT_ADDR = '0x5555555555555555555555555555555555555555';
const REGISTRY_ADDR = '0x4444444444444444444444444444444444444444';
const HATS_ADDR = '0x6666666666666666666666666666666666666666';
const ORG_ID = '0x' + 'ab'.repeat(32);

// Real Hats-Protocol-scale ID (> 2^53)
const MEMBER_HAT = ethers.BigNumber.from(
  '0x0000000100020001000000000000000000000000000000000000000000000000'
);

const BALANCE_WEI = ethers.utils.parseEther('1.5');
const PT_BALANCE = ethers.utils.parseUnits('42', 18);

// Interfaces mirroring the command's, to encode REAL return payloads.
const QJ_IFACE = new ethers.utils.Interface([
  'function accountRegistry() view returns (address)',
  'function memberHatIds() view returns (uint256[])',
  'function hats() view returns (address)',
]);
const UAR_IFACE = new ethers.utils.Interface([
  'function getUsername(address user) view returns (string)',
]);
const ERC20_IFACE = new ethers.utils.Interface([
  'function balanceOf(address owner) view returns (uint256)',
]);
const HATS_IFACE = new ethers.utils.Interface([
  'function balanceOf(address wearer, uint256 hatId) view returns (uint256)',
]);

interface ChainState {
  username: string;
  memberHatIds: ethers.BigNumber[];
  hatBalance: ethers.BigNumber;
  hatReadFails?: boolean;
}

/** Dispatch each batched call to an ABI-encoded answer, like a real node. */
function installChain(state: ChainState) {
  mocks.tryAggregate.mockImplementation(async (_provider: any, calls: Call[]) =>
    calls.map((call) => {
      const sig = call.data.slice(0, 10).toLowerCase();
      if (call.to === MULTICALL3) {
        return { success: true, returnData: ethers.utils.defaultAbiCoder.encode(['uint256'], [BALANCE_WEI]) };
      }
      if (sig === QJ_IFACE.getSighash('accountRegistry')) {
        return { success: true, returnData: QJ_IFACE.encodeFunctionResult('accountRegistry', [REGISTRY_ADDR]) };
      }
      if (sig === QJ_IFACE.getSighash('memberHatIds')) {
        return { success: true, returnData: QJ_IFACE.encodeFunctionResult('memberHatIds', [state.memberHatIds]) };
      }
      if (sig === QJ_IFACE.getSighash('hats')) {
        return { success: true, returnData: QJ_IFACE.encodeFunctionResult('hats', [HATS_ADDR]) };
      }
      if (sig === UAR_IFACE.getSighash('getUsername')) {
        return { success: true, returnData: UAR_IFACE.encodeFunctionResult('getUsername', [state.username]) };
      }
      if (sig === ERC20_IFACE.getSighash('balanceOf')) {
        return { success: true, returnData: ERC20_IFACE.encodeFunctionResult('balanceOf', [PT_BALANCE]) };
      }
      if (sig === HATS_IFACE.getSighash('balanceOf')) {
        if (state.hatReadFails) return { success: false, returnData: '0x' };
        return { success: true, returnData: HATS_IFACE.encodeFunctionResult('balanceOf', [state.hatBalance]) };
      }
      return { success: false, returnData: '0x' };
    })
  );
}

function orgDataFixture(overrides: Record<string, any> = {}) {
  return {
    organization: {
      id: ORG_ID,
      name: 'Test Org',
      roles: [{ hatId: MEMBER_HAT.toString(), name: 'Member' }],
    },
    user: {
      id: `${ORG_ID}-${WALLET.toLowerCase()}`,
      membershipStatus: 'Active',
      participationTokenBalance: PT_BALANCE.toString(),
      currentHatIds: [MEMBER_HAT.toString()],
    },
    tokenRequests: [{ id: 'req-1' }, { id: 'req-2' }],
    ...overrides,
  };
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return { _: [], $0: 'pop', org: 'testorg', ...overrides };
}

describe('pop user whoami — identity + org standing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isJsonMode.mockReturnValue(true);
    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      provider: {},
      address: WALLET,
      chainId: 11155111,
    });
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      quickJoinAddress: QJ_ADDR,
      participationTokenAddress: PT_ADDR,
    });
    mocks.query.mockResolvedValue(orgDataFixture());
    installChain({ username: 'argus', memberHatIds: [MEMBER_HAT], hatBalance: ethers.BigNumber.from(1) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('--json: full structured payload — address, username, balance, org standing', async () => {
    await whoamiHandler.handler(baseArgv());

    expect(output.json).toHaveBeenCalledTimes(1);
    const payload = (output.json as any).mock.calls[0][0];

    expect(payload.address).toBe(WALLET);
    expect(payload.username).toBe('argus');
    expect(payload.chainId).toBe(11155111);
    expect(payload.network).toBe('Sepolia');
    expect(payload.balance).toEqual({
      wei: BALANCE_WEI.toString(),
      formatted: formatToken(BALANCE_WEI, 18, 'ETH'),
      symbol: 'ETH',
    });

    expect(payload.org).toEqual({
      id: ORG_ID,
      name: 'Test Org',
      member: true,
      memberSource: 'on-chain hat check',
      ptBalance: {
        wei: PT_BALANCE.toString(),
        formatted: formatToken(PT_BALANCE, 18, 'PT'),
      },
      hats: [{ hatId: MEMBER_HAT.toString(), name: 'Member' }],
      pendingTokenRequests: 2,
    });
    expect(payload.orgError).toBeUndefined();

    // The subgraph snapshot was requested with the org-scoped variables
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('WhoamiOrgData'),
      {
        orgId: ORG_ID,
        orgUserID: `${ORG_ID}-${WALLET.toLowerCase()}`,
        tokenAddress: PT_ADDR,
        userAddress: WALLET.toLowerCase(),
      },
      undefined,
    );
  });

  it('on-chain hat balance of zero → member: false even when the subgraph says Active', async () => {
    installChain({ username: 'argus', memberHatIds: [MEMBER_HAT], hatBalance: ethers.BigNumber.from(0) });

    await whoamiHandler.handler(baseArgv());

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.org.member).toBe(false);
    expect(payload.org.memberSource).toBe('on-chain hat check');
  });

  it("subgraph fallback maps the enum: membershipStatus 'Inactive' → member: false (regression: truthiness would say true)", async () => {
    // No member hats readable on-chain → falls back to the subgraph enum
    installChain({ username: 'argus', memberHatIds: [], hatBalance: ethers.BigNumber.from(0) });
    mocks.query.mockResolvedValue(orgDataFixture({
      user: {
        id: `${ORG_ID}-${WALLET.toLowerCase()}`,
        membershipStatus: 'Inactive',
        participationTokenBalance: '0',
        currentHatIds: [],
      },
    }));

    await whoamiHandler.handler(baseArgv());

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.org.member).toBe(false);
    expect(payload.org.memberSource).toBe('subgraph');
  });

  it("subgraph fallback: membershipStatus 'Active' → member: true", async () => {
    installChain({ username: 'argus', memberHatIds: [], hatBalance: ethers.BigNumber.from(0) });

    await whoamiHandler.handler(baseArgv());

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.org.member).toBe(true);
    expect(payload.org.memberSource).toBe('subgraph');
  });

  it('unregistered signer: username is null in JSON', async () => {
    installChain({ username: '', memberHatIds: [MEMBER_HAT], hatBalance: ethers.BigNumber.from(1) });

    await whoamiHandler.handler(baseArgv());

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.username).toBeNull();
  });

  it('no org configured: identity fields only, org key absent, no org resolution attempted', async () => {
    await whoamiHandler.handler(baseArgv({ org: undefined }));

    expect(mocks.resolveOrgModules).not.toHaveBeenCalled();
    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.address).toBe(WALLET);
    expect(payload.org).toBeUndefined();
  });

  it('unresolvable org: identity still answers, orgError carries the reason', async () => {
    mocks.resolveOrgModules.mockRejectedValue(new Error('Organization "testorg" not found'));
    // With no org QuickJoin to consult, the registry comes from the
    // infrastructure subgraph query instead.
    mocks.query.mockImplementation(async (q: string) =>
      q.includes('WhoamiOrgData')
        ? orgDataFixture()
        : { universalAccountRegistries: [{ id: REGISTRY_ADDR }] }
    );

    await whoamiHandler.handler(baseArgv());

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.address).toBe(WALLET);
    expect(payload.username).toBe('argus'); // via global-registry fallback
    expect(payload.orgError).toContain('not found');
    // No-org username is home-chain state: the registry is resolved + read on
    // the home chain, not the selected chain (Sepolia here).
    expect(mocks.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: HOME_CHAIN_ID })
    );
    const infraCall = mocks.query.mock.calls.find((c: any[]) => !String(c[0]).includes('WhoamiOrgData'));
    expect(infraCall?.[2]).toBe(HOME_CHAIN_ID);
  });

  it('human mode: prints the Who am I and Org standing blocks', async () => {
    mocks.isJsonMode.mockReturnValue(false);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await whoamiHandler.handler(baseArgv());

    expect(output.keyValueBlock).toHaveBeenCalledWith('Who am I', expect.objectContaining({
      address: WALLET,
      username: 'argus',
      network: 'Sepolia (11155111)',
    }));
    expect(output.keyValueBlock).toHaveBeenCalledWith('Org standing', expect.objectContaining({
      member: 'yes (on-chain hat check)',
      hats: `Member (${MEMBER_HAT.toString()})`,
      'pending token requests': 2,
    }));
    expect(output.json).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe('resolveHatName — decimal/hex tolerant matching', () => {
  const roles = [
    { hatId: MEMBER_HAT.toString(), name: 'Member' },
    { hatId: '12', name: 'Reviewer' },
  ];

  it('matches identical decimal strings', () => {
    expect(resolveHatName(MEMBER_HAT.toString(), roles)).toBe('Member');
  });

  it('matches a hex-form worn hat against the decimal role entry', () => {
    expect(resolveHatName(MEMBER_HAT.toHexString(), roles)).toBe('Member');
  });

  it('returns undefined for unknown hats without throwing on non-numeric entries', () => {
    expect(resolveHatName('99', [...roles, { hatId: 'not-a-number', name: 'Broken' }])).toBeUndefined();
  });
});
