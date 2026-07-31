/**
 * Organization.metadataAdminHatId served by the subgraph instead of
 * OrgRegistry.getOrgMetadataAdminHat.
 *
 * The field is written by handleOrgMetadataAdminHatSet on every
 * OrgMetadataAdminHatSet event and is non-null on every live org (9 on
 * poa-gnosis-v-1, 1 on poa-arb-v-1). Spot-checked "Argus" against the on-chain
 * getter on Gnosis: identical value.
 *
 *   pop org view              — the value already ships inside FETCH_ORG_FULL_DATA,
 *                               so preferring it also removes the extra
 *                               FETCH_INFRASTRUCTURE_ADDRESSES query whose only
 *                               purpose was resolving the OrgRegistry address.
 *   pop org set-metadata-admin — the read is display-only for the confirm
 *                               summary (it gates nothing), so it is safe to
 *                               serve from the subgraph. The infra query stays:
 *                               the proposal's execution batch needs the
 *                               OrgRegistry address as a call target.
 *
 * Both keep the on-chain getter as the fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  fetchJson: vi.fn(),
  executeTx: vi.fn(),
  pinJson: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
  isJsonMode: vi.fn(() => true),
  json: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query, queryWithFieldFallback: vi.fn() }));
vi.mock('../../src/lib/ipfs', () => ({ fetchJson: mocks.fetchJson, pinJson: mocks.pinJson }));
vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/signer', () => ({ createSigner: mocks.createSigner, createProvider: vi.fn() }));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  resolveOrgId: vi.fn(),
  requireModule: (modules: any, key: string) => {
    if (!modules?.[key]) throw new Error(`missing module ${key}`);
    return modules[key];
  },
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
    s.succeed = () => s;
    s.fail = () => s;
    return s;
  };
  return {
    spinner: vi.fn(makeSpinner),
    success: mocks.success,
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
import { viewHandler } from '../../src/commands/org/view';
import { setMetadataAdminHandler } from '../../src/commands/org/set-metadata-admin';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { FETCH_INFRASTRUCTURE_ADDRESSES } from '../../src/queries/infrastructure';
import { FETCH_ORG_METADATA_ADMIN_HAT } from '../../src/queries/roles';

const ORG_ID = '0x' + 'ab'.repeat(32);
const ORG_REGISTRY = '0x5555555555555555555555555555555555555555';
const VOTING_ADDR = '0x4444444444444444444444444444444444444444';
const WALLET = '0x2222222222222222222222222222222222222222';
const ADMIN_HAT = '30222100625258283641858621132055137413908072809768050515156576961036288';

function orgFullData(metadataAdminHatId: string | null) {
  return {
    organization: {
      id: ORG_ID,
      name: 'Argus',
      metadataHash: null,
      metadataAdminHatId,
      metadata: null,
      deployedAt: '1700000000',
      topHatId: '1',
      roles: [],
      users: [],
    },
  };
}

describe('pop org view — metadataAdminHat from the subgraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isJsonMode.mockReturnValue(true);
  });

  it('uses Organization.metadataAdminHatId and skips the infrastructure query + eth_call', async () => {
    mocks.query.mockResolvedValue(orgFullData(ADMIN_HAT));

    await viewHandler.handler({ _: [], $0: 'pop', org: ORG_ID, chain: 100 } as any);

    // Exactly one subgraph round-trip: the org document. No infra lookup.
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls.some((c) => c[0] === FETCH_INFRASTRUCTURE_ADDRESSES)).toBe(false);
    expect(mocks.json.mock.calls[0][0].metadataAdminHat).toBe(ADMIN_HAT);
  });

  it('BigInt values are stringified, matching the on-chain getter output type', async () => {
    mocks.query.mockResolvedValue(orgFullData('0'));

    await viewHandler.handler({ _: [], $0: 'pop', org: ORG_ID, chain: 100 } as any);

    // 0 is meaningful (override cleared → topHat fallback) and must NOT be
    // treated as "missing" and pushed onto the RPC fallback.
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.json.mock.calls[0][0].metadataAdminHat).toBe('0');
  });

  it('subgraph value absent: falls back to the OrgRegistry read path', async () => {
    mocks.query.mockImplementation(async (doc: string) => {
      if (doc === FETCH_INFRASTRUCTURE_ADDRESSES) return { poaManagerContracts: [] };
      return orgFullData(null);
    });

    await viewHandler.handler({ _: [], $0: 'pop', org: ORG_ID, chain: 100 } as any);

    expect(mocks.query.mock.calls.some((c) => c[0] === FETCH_INFRASTRUCTURE_ADDRESSES)).toBe(true);
    // No OrgRegistry address reachable either → null, and the command still renders.
    expect(mocks.json.mock.calls[0][0].metadataAdminHat).toBeNull();
  });

  it('JSON key order is unchanged', async () => {
    mocks.query.mockResolvedValue(orgFullData(ADMIN_HAT));

    await viewHandler.handler({ _: [], $0: 'pop', org: ORG_ID, chain: 100 } as any);

    expect(Object.keys(mocks.json.mock.calls[0][0])).toEqual([
      'id', 'name', 'description', 'template', 'logo', 'links', 'deployedAt',
      'topHatId', 'metadataAdminHat', 'modules', 'tokenInfo', 'votingConfig',
      'roles', 'memberCount', 'projectCount',
    ]);
  });
});

describe('pop org set-metadata-admin — current hat from the subgraph', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _clearWriteContextCacheForTest();
    _setStreamsForTest(undefined, undefined, false);
    mocks.isJsonMode.mockReturnValue(false);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      // Not a Provider — createReadContract throws, so a currentHat that still
      // shows up proves it came from the subgraph and not from the getter.
      provider: {},
      address: WALLET,
      chainId: 100,
    });
    mocks.resolveOrgModules.mockResolvedValue({ orgId: ORG_ID, hybridVotingAddress: VOTING_ADDR });
    mocks.query.mockImplementation(async (doc: string) => {
      if (doc === FETCH_ORG_METADATA_ADMIN_HAT) {
        return { organization: { id: ORG_ID, metadataAdminHatId: ADMIN_HAT } };
      }
      return { poaManagerContracts: [{ id: '0x99', orgRegistryProxy: ORG_REGISTRY }] };
    });
    mocks.pinJson.mockResolvedValue('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.checkGasBalance.mockReturnValue({ label: 'gas balance' });
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xhash',
      logs: [{ name: 'NewProposal', args: { id: ethers.BigNumber.from(7) } }],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    _setStreamsForTest();
  });

  it('reads the current hat from the subgraph without touching OrgRegistry', async () => {
    await setMetadataAdminHandler.handler({
      _: [], $0: 'pop', org: 'argus', hat: '123', duration: 60, yes: true, preflight: true, dryRun: false,
    } as any);

    const adminQuery = mocks.query.mock.calls.find((c) => c[0] === FETCH_ORG_METADATA_ADMIN_HAT);
    expect(adminQuery).toBeDefined();
    expect(adminQuery![1]).toEqual({ orgId: ORG_ID });

    // The infra query stays — the proposal batch needs OrgRegistry as a target.
    expect(mocks.query.mock.calls.some((c) => c[0] === FETCH_INFRASTRUCTURE_ADDRESSES)).toBe(true);
    expect(mocks.executeTx.mock.calls[0][2][4][0][0][0]).toBe(ORG_REGISTRY);

    expect(mocks.success).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ currentHatId: ADMIN_HAT, hatId: '123', orgRegistry: ORG_REGISTRY }),
    );
  });

  it('subgraph value absent + unreachable getter: currentHatId is simply omitted, proposal still ships', async () => {
    mocks.query.mockImplementation(async (doc: string) => {
      if (doc === FETCH_ORG_METADATA_ADMIN_HAT) return { organization: { id: ORG_ID, metadataAdminHatId: null } };
      return { poaManagerContracts: [{ id: '0x99', orgRegistryProxy: ORG_REGISTRY }] };
    });

    await setMetadataAdminHandler.handler({
      _: [], $0: 'pop', org: 'argus', hat: '123', duration: 60, yes: true, preflight: true, dryRun: false,
    } as any);

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(mocks.success).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ currentHatId: undefined }),
    );
  });

  it('hat 0 from the subgraph is preserved (cleared override), not treated as missing', async () => {
    mocks.query.mockImplementation(async (doc: string) => {
      if (doc === FETCH_ORG_METADATA_ADMIN_HAT) return { organization: { id: ORG_ID, metadataAdminHatId: '0' } };
      return { poaManagerContracts: [{ id: '0x99', orgRegistryProxy: ORG_REGISTRY }] };
    });

    await setMetadataAdminHandler.handler({
      _: [], $0: 'pop', org: 'argus', hat: '123', duration: 60, yes: true, preflight: true, dryRun: false,
    } as any);

    expect(mocks.success).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ currentHatId: '0' }),
    );
  });
});
