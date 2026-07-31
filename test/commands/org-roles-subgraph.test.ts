/**
 * pop org roles — vouch config served by the subgraph instead of 2N eth_calls.
 *
 * Before this change the command issued EligibilityModule.isVouchingEnabled(hatId)
 * + EligibilityModule.vouchConfigs(hatId) once PER ROLE. Role.hat.vouchConfig is
 * present and populated on both live deployments (poa-gnosis-v-1 and
 * poa-arb-v-1), and the subgraph's handleVouchConfigSet rewrites the row on
 * every VouchConfigSet event, so tier 0 answers the whole command with zero
 * eth_calls. A null vouchConfig means "never configured", verified on-chain to
 * equal isVouchingEnabled()==false / quorum==0.
 *
 * Tier 1 (a deployment whose schema predates Hat.vouchConfig) keeps the RPC
 * path, now batched through Multicall3 instead of 2N awaited calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryWithFieldFallback: vi.fn(),
  resolveOrgModules: vi.fn(),
  createProvider: vi.fn(),
  tryAggregate: vi.fn(),
  isJsonMode: vi.fn(() => true),
  json: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/lib/subgraph', () => ({
  query: vi.fn(),
  queryWithFieldFallback: mocks.queryWithFieldFallback,
}));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  resolveOrgId: vi.fn(),
  requireModule: vi.fn(),
}));
vi.mock('../../src/lib/signer', () => ({ createProvider: mocks.createProvider }));
vi.mock('../../src/lib/multicall', () => ({ tryAggregate: mocks.tryAggregate }));
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
    error: mocks.error,
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
import { rolesHandler } from '../../src/commands/org/roles';
import { createReadContract } from '../../src/lib/contracts';
import {
  FETCH_ROLES_MEMBERS_AND_VOUCH,
  FETCH_ROLES_AND_MEMBERS,
} from '../../src/queries/roles';

const ORG_ID = '0x' + 'ab'.repeat(32);
const ELIGIBILITY = '0xb37a97c8136f6d300c399162cefab5b61c675caf';
const MEMBER = '0x451563ab9b5b4e8dfaa602f5e7890089edf6bf10';

// Real fixture shape, trimmed from the live Gnosis "Argus" org.
const HAT_ADMIN = '30222100625252006540123234451291301624484865143351948159712112926523392';
const HAT_AGENT = '30222100625258283641858621132055137413908072809768050515156576961036288';

/** Provider stub good enough for ethers.Contract; every read goes via tryAggregate. */
const fakeProvider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:1', 100);
const eligIface = createReadContract(ELIGIBILITY, 'EligibilityModuleNew', fakeProvider).interface;

function orgFixture(withVouch: boolean) {
  return {
    organization: {
      roles: [
        {
          id: 'r1',
          hatId: HAT_ADMIN,
          name: 'ELIGIBILITY_ADMIN',
          image: null,
          canVote: null,
          isUserRole: true,
          ...(withVouch ? { hat: { id: `${ELIGIBILITY}-${HAT_ADMIN}`, vouchConfig: null } } : {}),
        },
        {
          id: 'r2',
          hatId: HAT_AGENT,
          name: 'Agent',
          image: null,
          canVote: true,
          isUserRole: true,
          ...(withVouch
            ? {
                hat: {
                  id: `${ELIGIBILITY}-${HAT_AGENT}`,
                  vouchConfig: {
                    enabled: true,
                    quorum: 1,
                    membershipHatId: HAT_AGENT,
                    combinesWithHierarchy: true,
                  },
                },
              }
            : {}),
        },
      ],
      users: [
        {
          address: MEMBER,
          participationTokenBalance: ethers.utils.parseEther('2912').toString(),
          membershipStatus: 'Active',
          currentHatIds: [HAT_AGENT],
          account: { username: 'argus_prime' },
        },
      ],
      eligibilityModule: { id: ELIGIBILITY },
    },
  };
}

/** Encode what Multicall3 would return for one role's two reads. */
function vouchReturns(enabled: boolean, quorum: number, membershipHatId: string, flags: number) {
  return [
    { success: true, returnData: ethers.utils.defaultAbiCoder.encode(['bool'], [enabled]) },
    {
      success: true,
      returnData: ethers.utils.defaultAbiCoder.encode(
        ['tuple(uint32,uint256,uint8)'],
        [[quorum, ethers.BigNumber.from(membershipHatId), flags]]
      ),
    },
  ];
}

describe('pop org roles — subgraph-served vouch config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isJsonMode.mockReturnValue(true);
    mocks.resolveOrgModules.mockResolvedValue({ orgId: ORG_ID });
    mocks.createProvider.mockReturnValue(fakeProvider);
  });

  it('tier 0: reads vouch config from Role.hat.vouchConfig and makes ZERO eth_calls', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({ data: orgFixture(true), tierIndex: 0 });

    await rolesHandler.handler({ _: [], $0: 'pop', org: 'argus', chain: 100 } as any);

    // No provider, no contract, no multicall — the whole command is subgraph.
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(mocks.tryAggregate).not.toHaveBeenCalled();

    const rows = mocks.json.mock.calls[0][0];
    // Null vouchConfig == "never configured" == isVouchingEnabled false / quorum 0.
    expect(rows[0]).toEqual({
      hatId: HAT_ADMIN,
      name: 'ELIGIBILITY_ADMIN',
      canVote: null,
      vouchRequired: false,
      vouchQuorum: '0',
      wearers: 0,
      wearerList: [],
    });
    expect(rows[1]).toEqual({
      hatId: HAT_AGENT,
      name: 'Agent',
      canVote: true,
      vouchRequired: true,
      vouchQuorum: '1', // Int in the subgraph, string in the JSON contract
      wearers: 1,
      wearerList: [{ address: MEMBER, username: 'argus_prime', pt: '2912.0' }],
    });
  });

  it('tier 0 is attempted first and tier 1 is the registered fallback', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({ data: orgFixture(true), tierIndex: 0 });

    await rolesHandler.handler({ _: [], $0: 'pop', org: 'argus', chain: 100 } as any);

    const [tiers, opts] = mocks.queryWithFieldFallback.mock.calls[0];
    expect(tiers).toHaveLength(2);
    expect(tiers[0].query).toBe(FETCH_ROLES_MEMBERS_AND_VOUCH);
    expect(tiers[1].query).toBe(FETCH_ROLES_AND_MEMBERS);
    expect(tiers[0].variables).toEqual({ id: ORG_ID });
    expect(tiers[1].variables).toEqual({ id: ORG_ID });
    expect(opts).toEqual({ chainId: 100 });
    // The vouch fields must only live in tier 0 — GraphQL validates the whole
    // document, so tier 1 has to stay clean for older deployments.
    expect(tiers[0].query).toContain('vouchConfig');
    expect(tiers[1].query).not.toContain('vouchConfig');
  });

  it('JSON key order is unchanged (agents parse this)', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({ data: orgFixture(true), tierIndex: 0 });

    await rolesHandler.handler({ _: [], $0: 'pop', org: 'argus', chain: 100 } as any);

    expect(Object.keys(mocks.json.mock.calls[0][0][0])).toEqual([
      'hatId', 'name', 'canVote', 'vouchRequired', 'vouchQuorum', 'wearers', 'wearerList',
    ]);
  });

  it('tier 1 (legacy schema): falls back to RPC, batched into ONE Multicall3 round-trip', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({ data: orgFixture(false), tierIndex: 1 });
    mocks.tryAggregate.mockResolvedValue([
      ...vouchReturns(false, 0, '0', 0),
      ...vouchReturns(true, 1, HAT_AGENT, 3),
    ]);

    await rolesHandler.handler({ _: [], $0: 'pop', org: 'argus', chain: 100 } as any);

    expect(mocks.tryAggregate).toHaveBeenCalledTimes(1);
    const calls = mocks.tryAggregate.mock.calls[0][1];
    expect(calls).toHaveLength(4); // 2 roles x 2 reads, one round-trip

    // Calldata targets the org's EligibilityModule with the real synced ABI.
    expect(calls.every((c: any) => c.to === ELIGIBILITY)).toBe(true);
    expect(eligIface.decodeFunctionData('isVouchingEnabled', calls[0].data)[0].toString()).toBe(HAT_ADMIN);
    expect(eligIface.decodeFunctionData('vouchConfigs', calls[1].data)[0].toString()).toBe(HAT_ADMIN);
    expect(eligIface.decodeFunctionData('isVouchingEnabled', calls[2].data)[0].toString()).toBe(HAT_AGENT);
    expect(eligIface.decodeFunctionData('vouchConfigs', calls[3].data)[0].toString()).toBe(HAT_AGENT);

    const rows = mocks.json.mock.calls[0][0];
    expect(rows[0].vouchRequired).toBe(false);
    expect(rows[0].vouchQuorum).toBe('0');
    expect(rows[1].vouchRequired).toBe(true);
    expect(rows[1].vouchQuorum).toBe('1');
  });

  it('tier 1 with a reverting call keeps the legacy "?" quorum for that role only', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({ data: orgFixture(false), tierIndex: 1 });
    mocks.tryAggregate.mockResolvedValue([
      { success: false, returnData: '0x' },
      { success: false, returnData: '0x' },
      ...vouchReturns(true, 2, HAT_AGENT, 3),
    ]);

    await rolesHandler.handler({ _: [], $0: 'pop', org: 'argus', chain: 100 } as any);

    const rows = mocks.json.mock.calls[0][0];
    expect(rows[0].vouchRequired).toBe(false);
    expect(rows[0].vouchQuorum).toBe('?');
    expect(rows[1].vouchQuorum).toBe('2');
  });

  it('tier 1 with an unreachable RPC degrades to "?" instead of throwing', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({ data: orgFixture(false), tierIndex: 1 });
    mocks.tryAggregate.mockRejectedValue(new Error('network unreachable'));

    await rolesHandler.handler({ _: [], $0: 'pop', org: 'argus', chain: 100 } as any);

    expect(mocks.error).not.toHaveBeenCalled();
    const rows = mocks.json.mock.calls[0][0];
    expect(rows.map((r: any) => r.vouchQuorum)).toEqual(['?', '?']);
  });

  it('mixed: only roles the subgraph could not answer hit RPC', async () => {
    // Tier 0 served, but one role has no Hat entity — that one alone falls back.
    const fixture = orgFixture(true);
    delete (fixture.organization.roles[0] as any).hat;
    mocks.queryWithFieldFallback.mockResolvedValue({ data: fixture, tierIndex: 0 });
    mocks.tryAggregate.mockResolvedValue([...vouchReturns(false, 0, '0', 0)]);

    await rolesHandler.handler({ _: [], $0: 'pop', org: 'argus', chain: 100 } as any);

    expect(mocks.tryAggregate).toHaveBeenCalledTimes(1);
    expect(mocks.tryAggregate.mock.calls[0][1]).toHaveLength(2); // one role, not two

    const rows = mocks.json.mock.calls[0][0];
    expect(rows[0].vouchQuorum).toBe('0');
    expect(rows[1].vouchRequired).toBe(true); // still from the subgraph
    expect(rows[1].vouchQuorum).toBe('1');
  });
});
