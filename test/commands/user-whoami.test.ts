/**
 * pop user whoami — identity + org standing snapshot.
 *
 * whoami is the agent hot path, so the contract these tests pin is:
 * ONE subgraph round-trip answers everything the indexer can answer, and the
 * native gas balance — the only value no indexer holds — is fetched
 * CONCURRENTLY with it rather than before it. Assertions:
 *   - happy path issues ZERO eth_calls (tryAggregate untouched); username,
 *     PT balance, membership, hats and pending requests all come from the
 *     subgraph
 *   - the subgraph query is in flight while the balance read is still pending
 *   - --json emits the identical structured payload (address, username,
 *     balance {wei/formatted/symbol}, org
 *     {member/memberSource/ptBalance/hats/pendingTokenRequests})
 *   - membership matches the on-chain predicate: wears any QuickJoin member
 *     hat; with no member hats configured it falls back to the
 *     membershipStatus ENUM ('Inactive' must NOT read as a member)
 *   - --on-chain re-verifies membership with Hats.balanceOf
 *   - RPC fallbacks survive: no indexed account → registry.getUsername; no
 *     indexed User → on-chain hat check; no TokenBalance/User → ERC20.balanceOf
 *   - no org configured → home-chain Account lookup, NOT a second
 *     JsonRpcProvider + getUsername round-trip
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
  getBalance: vi.fn(),
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
import { whoamiHandler, resolveHatName, wearsAnyMemberHat } from '../../src/commands/user/whoami';
import { HOME_CHAIN_ID } from '../../src/config/networks';
import { Call } from '../../src/lib/multicall';
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

const UAR_IFACE = new ethers.utils.Interface([
  'function getUsername(address user) view returns (string)',
]);
const ERC20_IFACE = new ethers.utils.Interface([
  'function balanceOf(address owner) view returns (uint256)',
]);
const HATS_IFACE = new ethers.utils.Interface([
  'function balanceOf(address wearer, uint256 hatId) view returns (uint256)',
]);
const QJ_IFACE = new ethers.utils.Interface([
  'function accountRegistry() view returns (address)',
  'function memberHatIds() view returns (uint256[])',
  'function hats() view returns (address)',
]);

interface ChainState {
  username?: string;
  hatBalance?: ethers.BigNumber;
  hatReadFails?: boolean;
  ptBalance?: ethers.BigNumber;
}

/** Dispatch each batched call to an ABI-encoded answer, like a real node. */
function installChain(state: ChainState = {}) {
  mocks.tryAggregate.mockImplementation(async (_provider: any, calls: Call[]) =>
    calls.map((call) => {
      const sig = call.data.slice(0, 10).toLowerCase();
      if (sig === QJ_IFACE.getSighash('accountRegistry')) {
        return { success: true, returnData: QJ_IFACE.encodeFunctionResult('accountRegistry', [REGISTRY_ADDR]) };
      }
      if (sig === QJ_IFACE.getSighash('hats')) {
        return { success: true, returnData: QJ_IFACE.encodeFunctionResult('hats', [HATS_ADDR]) };
      }
      if (sig === QJ_IFACE.getSighash('memberHatIds')) {
        return { success: true, returnData: QJ_IFACE.encodeFunctionResult('memberHatIds', [[MEMBER_HAT]]) };
      }
      if (sig === UAR_IFACE.getSighash('getUsername')) {
        return { success: true, returnData: UAR_IFACE.encodeFunctionResult('getUsername', [state.username ?? '']) };
      }
      if (sig === ERC20_IFACE.getSighash('balanceOf')) {
        return { success: true, returnData: ERC20_IFACE.encodeFunctionResult('balanceOf', [state.ptBalance ?? PT_BALANCE]) };
      }
      if (sig === HATS_IFACE.getSighash('balanceOf')) {
        if (state.hatReadFails) return { success: false, returnData: '0x' };
        return {
          success: true,
          returnData: HATS_IFACE.encodeFunctionResult('balanceOf', [state.hatBalance ?? ethers.BigNumber.from(1)]),
        };
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
      // `hat.active` is Hats Protocol's toggle flag. It is REQUIRED for the
      // indexed membership answer: a toggled-off hat still appears in
      // User.currentHatIds (Hats does not burn the token), while
      // Hats.balanceOf — the check the subgraph path replaces — returns 0.
      roles: [{ hatId: MEMBER_HAT.toString(), name: 'Member', hat: { active: true } }],
    },
    quickJoinContract: {
      id: QJ_ADDR.toLowerCase(),
      accountRegistry: REGISTRY_ADDR,
      hatsContract: HATS_ADDR,
      memberHatIds: [MEMBER_HAT.toString()],
    },
    account: {
      id: WALLET.toLowerCase(),
      username: 'argus',
      isDeleted: false,
      registry: { id: REGISTRY_ADDR },
    },
    tokenBalance: {
      id: `${PT_ADDR.toLowerCase()}-${WALLET.toLowerCase()}`,
      balance: PT_BALANCE.toString(),
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

/** Route each mocked subgraph document to its fixture. */
function installSubgraph(opts: { orgData?: any; homeAccount?: any } = {}) {
  const orgData = 'orgData' in opts ? opts.orgData : orgDataFixture();
  mocks.query.mockImplementation(async (doc: string) => {
    if (String(doc).includes('WhoamiOrgData')) return orgData;
    if (String(doc).includes('AccountUsername')) return { account: opts.homeAccount ?? null };
    return { universalAccountRegistries: [{ id: REGISTRY_ADDR }] };
  });
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return { _: [], $0: 'pop', org: 'testorg', ...overrides };
}

describe('pop user whoami — identity + org standing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isJsonMode.mockReturnValue(true);
    mocks.getBalance.mockResolvedValue(BALANCE_WEI);
    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      provider: { getBalance: mocks.getBalance },
      address: WALLET,
      chainId: 11155111,
    });
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      quickJoinAddress: QJ_ADDR,
      participationTokenAddress: PT_ADDR,
    });
    installSubgraph();
    installChain();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('--json: full structured payload, served entirely by ONE subgraph query + the gas balance', async () => {
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
      memberSource: 'subgraph',
      ptBalance: {
        wei: PT_BALANCE.toString(),
        formatted: formatToken(PT_BALANCE, 18, 'PT'),
      },
      hats: [{ hatId: MEMBER_HAT.toString(), name: 'Member' }],
      pendingTokenRequests: 2,
    });
    expect(payload.orgError).toBeUndefined();

    // ZERO eth_calls: no QuickJoin pointers, no getUsername, no balanceOf,
    // no Hats.balanceOf. Only eth_getBalance, which no indexer can serve.
    expect(mocks.tryAggregate).not.toHaveBeenCalled();
    expect(mocks.getBalance).toHaveBeenCalledWith(WALLET);
    // ...and no second JsonRpcProvider for the home chain.
    expect(mocks.createProvider).not.toHaveBeenCalled();

    // Exactly one subgraph round-trip, org-scoped
    const whoamiCalls = mocks.query.mock.calls.filter((c: any[]) => String(c[0]).includes('WhoamiOrgData'));
    expect(whoamiCalls).toHaveLength(1);
    expect(whoamiCalls[0][1]).toEqual({
      orgId: ORG_ID,
      orgUserID: `${ORG_ID}-${WALLET.toLowerCase()}`,
      tokenAddress: PT_ADDR,
      userAddress: WALLET.toLowerCase(),
      quickJoinAddress: QJ_ADDR.toLowerCase(),
      accountID: WALLET.toLowerCase(),
      tokenBalanceID: `${PT_ADDR.toLowerCase()}-${WALLET.toLowerCase()}`,
    });
  });

  it('the gas balance is awaited in PARALLEL: the subgraph query is in flight while eth_getBalance is pending', async () => {
    let releaseBalance!: () => void;
    const gate = new Promise<void>((resolve) => { releaseBalance = resolve; });
    mocks.getBalance.mockImplementation(() => gate.then(() => BALANCE_WEI));

    const pending = whoamiHandler.handler(baseArgv());
    // Let the handler run up to its Promise.all
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.getBalance).toHaveBeenCalled();
    expect(mocks.query.mock.calls.some((c: any[]) => String(c[0]).includes('WhoamiOrgData'))).toBe(true);

    releaseBalance();
    await pending;
    expect((output.json as any).mock.calls[0][0].balance.wei).toBe(BALANCE_WEI.toString());
  });

  it('membership uses the on-chain predicate: wearing none of the QuickJoin member hats → member: false', async () => {
    installSubgraph({
      orgData: orgDataFixture({
        user: {
          id: `${ORG_ID}-${WALLET.toLowerCase()}`,
          membershipStatus: 'Active',
          participationTokenBalance: PT_BALANCE.toString(),
          currentHatIds: ['999'], // some other role hat, not the member hat
        },
      }),
    });

    await whoamiHandler.handler(baseArgv());

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.org.member).toBe(false);
    expect(payload.org.memberSource).toBe('subgraph');
    expect(mocks.tryAggregate).not.toHaveBeenCalled();
  });

  it('a TOGGLED-OFF member hat is not membership, even though currentHatIds still lists it', async () => {
    // The divergence the live sweep could not sample: there is currently no
    // inactive hat on Gnosis. Hats does NOT burn the token when a hat is
    // toggled off, so User.currentHatIds keeps listing it while
    // Hats.isWearerOfHat/balanceOf return false for EVERY wearer. Reading
    // currentHatIds alone would report `member: true` here.
    installSubgraph({
      orgData: orgDataFixture({
        organization: {
          id: ORG_ID,
          name: 'Test Org',
          roles: [{ hatId: MEMBER_HAT.toString(), name: 'Member', hat: { active: false } }],
        },
      }),
    });

    await whoamiHandler.handler(baseArgv());

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.org.member).toBe(false);
  });

  it('an UNKNOWN active flag defers to the chain rather than guessing membership', async () => {
    // Member hat that is not one of the org's indexed roles: the toggle state
    // is simply not in the payload, so the indexed answer must not be invented.
    installSubgraph({
      orgData: orgDataFixture({
        organization: { id: ORG_ID, name: 'Test Org', roles: [] },
      }),
    });

    await whoamiHandler.handler(baseArgv());

    // Falls through to the authoritative Hats.balanceOf batch.
    expect(mocks.tryAggregate).toHaveBeenCalled();
    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.org.memberSource).toBe('on-chain hat check');
  });

  it("no member hats configured: maps the enum — 'Inactive' → member: false (regression: truthiness would say true)", async () => {
    installSubgraph({
      orgData: orgDataFixture({
        quickJoinContract: {
          id: QJ_ADDR.toLowerCase(),
          accountRegistry: REGISTRY_ADDR,
          hatsContract: HATS_ADDR,
          memberHatIds: [],
        },
        user: {
          id: `${ORG_ID}-${WALLET.toLowerCase()}`,
          membershipStatus: 'Inactive',
          participationTokenBalance: '0',
          currentHatIds: [],
        },
      }),
    });

    await whoamiHandler.handler(baseArgv());

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.org.member).toBe(false);
    expect(payload.org.memberSource).toBe('subgraph');
  });

  it("no member hats configured: 'Active' → member: true", async () => {
    installSubgraph({
      orgData: orgDataFixture({
        quickJoinContract: {
          id: QJ_ADDR.toLowerCase(),
          accountRegistry: REGISTRY_ADDR,
          hatsContract: HATS_ADDR,
          memberHatIds: [],
        },
      }),
    });

    await whoamiHandler.handler(baseArgv());

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.org.member).toBe(true);
    expect(payload.org.memberSource).toBe('subgraph');
  });

  it('--on-chain: re-verifies membership with Hats.balanceOf, overriding the indexer', async () => {
    installChain({ hatBalance: ethers.BigNumber.from(0) });

    await whoamiHandler.handler(baseArgv({ 'on-chain': true }));

    const payload = (output.json as any).mock.calls[0][0];
    // The subgraph says the member hat is worn; Hats.balanceOf says 0 (a
    // dynamically revoked eligibility burns no token, so the indexer cannot
    // see it). The chain wins.
    expect(payload.org.member).toBe(false);
    expect(payload.org.memberSource).toBe('on-chain hat check');

    const hatCalls = mocks.tryAggregate.mock.calls
      .flatMap((c: any[]) => c[1] as Call[])
      .filter((call: Call) => call.data.startsWith(HATS_IFACE.getSighash('balanceOf')));
    expect(hatCalls).toHaveLength(1);
    expect(hatCalls[0].to).toBe(HATS_ADDR);
  });

  it('--on-chain with an unreadable Hats contract falls back to the indexer rather than "unknown"', async () => {
    installChain({ hatReadFails: true });

    await whoamiHandler.handler(baseArgv({ 'on-chain': true }));

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.org.member).toBe(true);
    expect(payload.org.memberSource).toBe('subgraph');
  });

  it('no indexed User (subgraph gap): falls back to the on-chain member-hat check', async () => {
    installSubgraph({ orgData: orgDataFixture({ user: null }) });
    installChain({ hatBalance: ethers.BigNumber.from(1) });

    await whoamiHandler.handler(baseArgv());

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.org.member).toBe(true);
    expect(payload.org.memberSource).toBe('on-chain hat check');
  });

  it('no indexed account: falls back to registry.getUsername on the indexed registry address', async () => {
    installSubgraph({ orgData: orgDataFixture({ account: null }) });
    installChain({ username: 'from_chain' });

    await whoamiHandler.handler(baseArgv());

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.username).toBe('from_chain');

    const nameCalls = mocks.tryAggregate.mock.calls
      .flatMap((c: any[]) => c[1] as Call[])
      .filter((call: Call) => call.data.startsWith(UAR_IFACE.getSighash('getUsername')));
    expect(nameCalls).toHaveLength(1);
    // Registry address came from the subgraph — no accountRegistry() eth_call
    expect(nameCalls[0].to).toBe(REGISTRY_ADDR);
  });

  it('indexed account on a DIFFERENT registry than this QuickJoin consults is ignored (falls back to the chain)', async () => {
    installSubgraph({
      orgData: orgDataFixture({
        account: {
          id: WALLET.toLowerCase(),
          username: 'wrong_registry_name',
          isDeleted: false,
          registry: { id: '0x9999999999999999999999999999999999999999' },
        },
      }),
    });
    installChain({ username: 'from_chain' });

    await whoamiHandler.handler(baseArgv());

    expect((output.json as any).mock.calls[0][0].username).toBe('from_chain');
  });

  it('no TokenBalance and no indexed User: falls back to ERC20.balanceOf', async () => {
    installSubgraph({ orgData: orgDataFixture({ tokenBalance: null, user: null }) });
    installChain({ ptBalance: ethers.utils.parseUnits('7', 18) });

    await whoamiHandler.handler(baseArgv());

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.org.ptBalance.wei).toBe(ethers.utils.parseUnits('7', 18).toString());
  });

  it('TokenBalance is preferred over User.participationTokenBalance when they disagree', async () => {
    installSubgraph({
      orgData: orgDataFixture({
        tokenBalance: { id: 'tb', balance: '123' },
        user: {
          id: `${ORG_ID}-${WALLET.toLowerCase()}`,
          membershipStatus: 'Active',
          participationTokenBalance: '999',
          currentHatIds: [MEMBER_HAT.toString()],
        },
      }),
    });

    await whoamiHandler.handler(baseArgv());

    expect((output.json as any).mock.calls[0][0].org.ptBalance.wei).toBe('123');
  });

  it('unregistered signer: username is null in JSON', async () => {
    installSubgraph({ orgData: orgDataFixture({ account: null }) });
    installChain({ username: '' });

    await whoamiHandler.handler(baseArgv());

    expect((output.json as any).mock.calls[0][0].username).toBeNull();
  });

  it('no org configured: identity only, username from the HOME-CHAIN Account entity — no second provider', async () => {
    installSubgraph({ homeAccount: { id: WALLET.toLowerCase(), username: 'argus', isDeleted: false, registry: { id: REGISTRY_ADDR } } });

    await whoamiHandler.handler(baseArgv({ org: undefined }));

    expect(mocks.resolveOrgModules).not.toHaveBeenCalled();
    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.address).toBe(WALLET);
    expect(payload.username).toBe('argus');
    expect(payload.org).toBeUndefined();

    const accountCall = mocks.query.mock.calls.find((c: any[]) => String(c[0]).includes('AccountUsername'));
    expect(accountCall?.[1]).toEqual({ accountID: WALLET.toLowerCase() });
    expect(accountCall?.[2]).toBe(HOME_CHAIN_ID);
    // The old shape built a second JsonRpcProvider purely for getUsername
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(mocks.tryAggregate).not.toHaveBeenCalled();
  });

  it('no org and no indexed home account: still degrades to the home-chain registry + getUsername', async () => {
    installSubgraph({ homeAccount: null });
    installChain({ username: 'argus' });

    await whoamiHandler.handler(baseArgv({ org: undefined }));

    expect((output.json as any).mock.calls[0][0].username).toBe('argus');
    expect(mocks.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: HOME_CHAIN_ID })
    );
    const infraCall = mocks.query.mock.calls.find((c: any[]) => String(c[0]).includes('FetchInfrastructureAddresses'));
    expect(infraCall?.[2]).toBe(HOME_CHAIN_ID);
  });

  it('unresolvable org: identity still answers, orgError carries the reason', async () => {
    mocks.resolveOrgModules.mockRejectedValue(new Error('Organization "testorg" not found'));
    installSubgraph({ homeAccount: { id: WALLET.toLowerCase(), username: 'argus', isDeleted: false, registry: { id: REGISTRY_ADDR } } });

    await whoamiHandler.handler(baseArgv());

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.address).toBe(WALLET);
    expect(payload.username).toBe('argus');
    expect(payload.orgError).toContain('not found');
  });

  it('dead subgraph: every org field degrades to the on-chain reads instead of throwing', async () => {
    mocks.query.mockRejectedValue(new Error('subgraph 503'));
    installChain({ username: 'argus', hatBalance: ethers.BigNumber.from(1), ptBalance: PT_BALANCE });

    await whoamiHandler.handler(baseArgv());

    const payload = (output.json as any).mock.calls[0][0];
    expect(payload.username).toBe('argus');
    expect(payload.org.member).toBe(true);
    expect(payload.org.memberSource).toBe('on-chain hat check');
    expect(payload.org.ptBalance.wei).toBe(PT_BALANCE.toString());
    expect(payload.balance.wei).toBe(BALANCE_WEI.toString());
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
      member: 'yes (subgraph)',
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

describe('wearsAnyMemberHat — uint256-safe membership predicate', () => {
  it('matches across decimal/hex spellings of the same uint256', () => {
    expect(wearsAnyMemberHat([MEMBER_HAT.toHexString()], [MEMBER_HAT.toString()])).toBe(true);
  });

  it('is false when none of the member hats are worn', () => {
    expect(wearsAnyMemberHat(['5', '6'], [MEMBER_HAT.toString()])).toBe(false);
  });

  it('is false for an empty worn list and skips unparseable entries', () => {
    expect(wearsAnyMemberHat([], [MEMBER_HAT.toString()])).toBe(false);
    expect(wearsAnyMemberHat(['nope'], ['also-nope', MEMBER_HAT.toString()])).toBe(false);
  });
});
