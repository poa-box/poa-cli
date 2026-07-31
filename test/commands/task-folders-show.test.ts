/**
 * pop task folders show — root from the subgraph, CAS reads untouched.
 *
 * The command already queried Organization.foldersUpdatedAt/foldersUpdatedBy
 * and then re-read the SAME root over RPC. Organization.foldersRoot is
 * populated on live Gnosis (org Test6 = 0x8694f683…), so the root now comes
 * from that one query.
 *
 * The two rules encoded here:
 *   - a NULL foldersRoot means "no FoldersUpdated indexed", which is NOT the
 *     same as "the root is zero" — it must fall back to the on-chain lens;
 *   - `folders set` keeps BOTH getFoldersRoot calls on RPC because they are the
 *     CAS expectedCurrentRoot, and a stale value guarantees a FoldersRootStale
 *     revert. That is asserted in the last describe block.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveOrgModules: vi.fn(),
  queryWithFieldFallback: vi.fn(),
  detectTaskManagerFeatures: vi.fn(),
  tryAggregate: vi.fn(),
  getFoldersRoot: vi.fn(),
  getOrganizerHats: vi.fn(),
  json: vi.fn(),
  isJsonMode: vi.fn(() => true),
}));

vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => modules[key],
}));
vi.mock('../../src/lib/subgraph', () => ({
  queryWithFieldFallback: mocks.queryWithFieldFallback,
  query: vi.fn(),
}));
vi.mock('../../src/lib/version', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/version')>();
  return { ...actual, detectTaskManagerFeatures: mocks.detectTaskManagerFeatures };
});
vi.mock('../../src/lib/multicall', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/multicall')>();
  return { ...actual, tryAggregate: mocks.tryAggregate };
});
vi.mock('../../src/lib/task-lens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/task-lens')>();
  return { ...actual, getFoldersRoot: mocks.getFoldersRoot, getOrganizerHats: mocks.getOrganizerHats };
});
vi.mock('../../src/lib/output', () => {
  const makeSpinner = () => {
    const s: any = { text: '' };
    s.start = () => s; s.stop = () => s; s.succeed = () => s; s.fail = () => s;
    return s;
  };
  return {
    spinner: vi.fn(makeSpinner),
    success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(),
    json: mocks.json, table: vi.fn(), keyValueBlock: vi.fn(),
    isJsonMode: mocks.isJsonMode, isQuietMode: vi.fn(() => false),
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import { foldersShowHandler, normalizeRoot } from '../../src/commands/task/folders';
import { encodeLensCall, decodeLensResult, STORAGE_KEYS } from '../../src/lib/task-lens';

const ORG_ID = '0x263b2b29f392647f0fb8ddbb26f099e812ab4ba2777e5e07b906277164181f6b';
const TM = '0x3d93f0d090356d25e7a1614f0f8764b103ca99bc';
const INDEXED_ROOT = '0x8694f683853d6b83878418518069f68316dd36a296b84df1f934a6a8b3b57ed8';
const CHAIN_ROOT = '0x' + '77'.repeat(32);
const UPDATED_BY = '0xa6f4d9f44dd980b7168d829d5f74c2b00a46b2c9';

const V4_FEATURES = { deadlines: false, batchCreate: false, editMeta: false, folders: true, legacyCreate7: true };

/** Wrap a decoded payload the way TaskManager.getLensData returns it. */
function lensReturn(types: string[], values: any[]) {
  const payload = ethers.utils.defaultAbiCoder.encode(types, values);
  return ethers.utils.defaultAbiCoder.encode(['bytes'], [payload]);
}

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isJsonMode.mockReturnValue(true);
  mocks.resolveOrgModules.mockResolvedValue({ orgId: ORG_ID, taskManagerAddress: TM });
  mocks.detectTaskManagerFeatures.mockResolvedValue(V4_FEATURES);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
});
afterEach(() => exitSpy.mockRestore());

describe('normalizeRoot', () => {
  it('accepts a 32-byte hex root and lowercases it', () => {
    expect(normalizeRoot(INDEXED_ROOT.toUpperCase().replace('0X', '0x'))).toBe(INDEXED_ROOT);
  });
  it('rejects null, short hex and junk (so the caller reads the lens)', () => {
    expect(normalizeRoot(null)).toBeNull();
    expect(normalizeRoot(undefined)).toBeNull();
    expect(normalizeRoot('0x1234')).toBeNull();
    expect(normalizeRoot('QmSomething')).toBeNull();
  });
});

describe('pop task folders show', () => {
  it('an indexed foldersRoot is used and the lens root read is skipped', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({
      data: { organization: { id: ORG_ID, foldersRoot: INDEXED_ROOT, foldersUpdatedAt: '1779223825', foldersUpdatedBy: UPDATED_BY } },
      tierIndex: 0,
    });
    mocks.tryAggregate.mockResolvedValue([
      { success: true, returnData: lensReturn(['uint256[]'], [[ethers.BigNumber.from(7)]]) },
    ]);

    await foldersShowHandler.handler({ _: [], $0: 'pop', org: 'test6', chain: 100 } as any);

    // Only the organizer-hats lens call was batched — no FOLDERS_ROOT call.
    const calls = mocks.tryAggregate.mock.calls[0][1];
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toBe(encodeLensCall(STORAGE_KEYS.ORGANIZER_HATS));
    expect(mocks.getFoldersRoot).not.toHaveBeenCalled();

    const payload = mocks.json.mock.calls[0][0];
    expect(payload.foldersRoot).toBe(INDEXED_ROOT);
    expect(payload.isSet).toBe(true);
    expect(payload.organizerHatIds).toEqual(['7']);
    expect(payload.lastUpdatedBy).toBe(UPDATED_BY);
    expect(payload._source).toContain('subgraph');
  });

  it('preserves the exact --json key order', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({
      data: { organization: { foldersRoot: INDEXED_ROOT, foldersUpdatedAt: '1779223825', foldersUpdatedBy: UPDATED_BY } },
      tierIndex: 0,
    });
    mocks.tryAggregate.mockResolvedValue([
      { success: true, returnData: lensReturn(['uint256[]'], [[]]) },
    ]);

    await foldersShowHandler.handler({ _: [], $0: 'pop', org: 'test6', chain: 100 } as any);
    expect(Object.keys(mocks.json.mock.calls[0][0])).toEqual([
      'taskManager', 'foldersRoot', 'cid', 'isSet', 'organizerHatIds',
      'lastUpdatedAt', 'lastUpdatedBy', '_source',
    ]);
  });

  it('NULL foldersRoot is not read as zero — it batches the lens root read', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({
      data: { organization: { id: ORG_ID, foldersRoot: null, foldersUpdatedAt: null, foldersUpdatedBy: null } },
      tierIndex: 0,
    });
    mocks.tryAggregate.mockResolvedValue([
      { success: true, returnData: lensReturn(['bytes32'], [CHAIN_ROOT]) },
      { success: true, returnData: lensReturn(['uint256[]'], [[]]) },
    ]);

    await foldersShowHandler.handler({ _: [], $0: 'pop', org: 'test6', chain: 100 } as any);

    const calls = mocks.tryAggregate.mock.calls[0][1];
    expect(calls).toHaveLength(2);                       // ONE multicall, two reads
    expect(calls[0].data).toBe(encodeLensCall(STORAGE_KEYS.FOLDERS_ROOT));
    const payload = mocks.json.mock.calls[0][0];
    expect(payload.foldersRoot).toBe(CHAIN_ROOT);
    expect(payload._source).toContain('chain lens');
  });

  it('a legacy tier with no foldersRoot field still resolves the root from chain', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({
      data: { organization: { id: ORG_ID } },
      tierIndex: 1,
    });
    mocks.tryAggregate.mockResolvedValue([
      { success: true, returnData: lensReturn(['bytes32'], [ethers.constants.HashZero]) },
      { success: true, returnData: lensReturn(['uint256[]'], [[]]) },
    ]);

    await foldersShowHandler.handler({ _: [], $0: 'pop', org: 'test6', chain: 100 } as any);
    const payload = mocks.json.mock.calls[0][0];
    expect(payload.foldersRoot).toBe(ethers.constants.HashZero);
    expect(payload.isSet).toBe(false);
  });

  it('subgraph throwing degrades to the pure on-chain path', async () => {
    mocks.queryWithFieldFallback.mockRejectedValue(new Error('subgraph down'));
    mocks.tryAggregate.mockRejectedValue(new Error('no multicall here'));
    mocks.getFoldersRoot.mockResolvedValue(CHAIN_ROOT);
    mocks.getOrganizerHats.mockResolvedValue([ethers.BigNumber.from(3)]);

    await foldersShowHandler.handler({ _: [], $0: 'pop', org: 'test6', chain: 100 } as any);

    expect(mocks.getFoldersRoot).toHaveBeenCalledTimes(1);
    const payload = mocks.json.mock.calls[0][0];
    expect(payload.foldersRoot).toBe(CHAIN_ROOT);
    expect(payload.organizerHatIds).toEqual(['3']);
  });

  it('passes orgId to the feature probe so it can skip the EIP-1967 slot read', async () => {
    mocks.queryWithFieldFallback.mockResolvedValue({
      data: { organization: { foldersRoot: INDEXED_ROOT } }, tierIndex: 0,
    });
    mocks.tryAggregate.mockResolvedValue([{ success: true, returnData: lensReturn(['uint256[]'], [[]]) }]);

    await foldersShowHandler.handler({ _: [], $0: 'pop', org: 'test6', chain: 100 } as any);

    expect(mocks.detectTaskManagerFeatures).toHaveBeenCalledWith(
      expect.anything(), TM, 100, { orgId: ORG_ID }
    );
  });

  it('a pre-v4 TaskManager still short-circuits before any read', async () => {
    mocks.detectTaskManagerFeatures.mockResolvedValue({ ...V4_FEATURES, folders: false });

    await expect(
      foldersShowHandler.handler({ _: [], $0: 'pop', org: 'test6', chain: 100 } as any)
    ).rejects.toThrow(/exit:/);

    expect(mocks.queryWithFieldFallback).not.toHaveBeenCalled();
    expect(mocks.tryAggregate).not.toHaveBeenCalled();
  });
});

describe('the lens payload decode is the real one', () => {
  it('decodeLensResult unwraps what the fixture encodes', () => {
    const wrapped = lensReturn(['bytes32'], [CHAIN_ROOT]);
    expect(ethers.utils.defaultAbiCoder.decode(['bytes32'], decodeLensResult(wrapped))[0]).toBe(CHAIN_ROOT);
  });
});
