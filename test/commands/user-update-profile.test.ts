/**
 * pop user update-profile — username change + profile metadata merge.
 *
 * Read shape: the registry address, the current username and the existing
 * profile metadata now arrive in ONE subgraph round-trip. Previously that was
 * two subgraph queries plus a standalone getUsername eth_call that was not
 * folded into the pre-flight batch against the same contract. These tests pin:
 *   - the merged single round-trip, and that no eth_call is issued when the
 *     indexed account is usable
 *   - the AccountUnknown gate is still decided by the CHAIN whenever the
 *     indexed account is missing or tombstoned (never blocked on indexer lag)
 *   - single-flag edits still preserve every other metadata field
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  createSigner: vi.fn(),
  createReadContract: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
  checkUsernameFree: vi.fn(),
  query: vi.fn(),
  pinJson: vi.fn(),
  confirm: vi.fn(),
  isInteractive: vi.fn(() => false),
}));

vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/signer', () => ({ createSigner: mocks.createSigner }));
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
vi.mock('../../src/lib/ipfs', () => ({ pinJson: mocks.pinJson }));
vi.mock('../../src/lib/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/contracts')>();
  return { ...actual, createReadContract: mocks.createReadContract };
});
vi.mock('../../src/lib/preflight', () => ({
  runPreflight: mocks.runPreflight,
  checkGasBalance: mocks.checkGasBalance,
  checkUsernameFree: mocks.checkUsernameFree,
}));
vi.mock('../../src/lib/prompt', () => ({
  isInteractive: mocks.isInteractive,
  confirm: mocks.confirm,
  input: vi.fn(),
  select: vi.fn(),
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
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    json: vi.fn(),
    keyValueBlock: vi.fn(),
    isJsonMode: vi.fn(() => false),
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import { updateProfileHandler } from '../../src/commands/user/update-profile';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const WALLET = '0x2222222222222222222222222222222222222222';
const UAR_ADDR = '0x4444444444444444444444444444444444444444';
const CID = 'QmYvrppgjgKPi5JsZXjEbxt4oTzmofVQfJcgUNtkT6t3Tb';

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    yes: true,
    preflight: true,
    dryRun: false,
    ...overrides,
  };
}

function setIndexed(account: any) {
  mocks.query.mockResolvedValue({
    universalAccountRegistries: [{ id: UAR_ADDR }],
    account,
  });
}

function liveAccount(overrides: Record<string, any> = {}) {
  return {
    id: WALLET.toLowerCase(),
    username: 'argus',
    isDeleted: false,
    metadata: {
      bio: 'old bio',
      avatar: 'QmAvatar',
      github: null,
      twitter: 'argus_x',
      website: null,
    },
    ...overrides,
  };
}

/** What registry.getUsername() reports on-chain. */
function setChainUsername(username: string | Error) {
  mocks.createReadContract.mockImplementation((_addr: string, abiName: string) => {
    if (abiName === 'UniversalAccountRegistry') {
      return {
        getUsername: async () => {
          if (username instanceof Error) throw username;
          return username;
        },
      };
    }
    throw new Error(`unexpected read contract: ${abiName}`);
  });
}

describe('pop user update-profile — one subgraph round-trip', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);

    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      provider: {},
      address: WALLET,
      chainId: 42161,
    });
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.checkGasBalance.mockReturnValue({ label: 'gas balance' });
    mocks.checkUsernameFree.mockImplementation((_r: string, n: string) => ({ label: `username "${n}"` }));
    mocks.pinJson.mockResolvedValue(CID);
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xabc',
      explorerUrl: 'https://explorer/tx/0xabc',
      logs: [],
    });
    setIndexed(liveAccount());
    setChainUsername('argus');
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('metadata-only edit: ONE subgraph query serves the registry AND the existing metadata; other fields survive', async () => {
    await updateProfileHandler.handler(baseArgv({ bio: 'new bio' }));

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][0]).toContain('RegistryAndAccount');
    expect(mocks.query.mock.calls[0][1]).toEqual({ accountID: WALLET.toLowerCase() });

    // No username change → the current name is never read at all
    expect(mocks.createReadContract).not.toHaveBeenCalled();

    const pinned = JSON.parse(mocks.pinJson.mock.calls[0][0]);
    expect(pinned).toEqual({
      bio: 'new bio',
      avatar: 'QmAvatar',
      twitter: 'argus_x',
    });

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    expect(mocks.executeTx.mock.calls[0][1]).toBe('setProfileMetadata');
    expect(mocks.executeTx.mock.calls[0][0].address).toBe(UAR_ADDR);
  });

  it('username change with a live indexed account: no getUsername eth_call', async () => {
    await updateProfileHandler.handler(baseArgv({ username: 'argus_v2' }));

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.createReadContract).not.toHaveBeenCalled();
    expect(mocks.checkUsernameFree).toHaveBeenCalledWith(UAR_ADDR, 'argus_v2');
    expect(mocks.executeTx.mock.calls[0][1]).toBe('changeUsername');
    expect(mocks.executeTx.mock.calls[0][2]).toEqual(['argus_v2']);
    expect(output.success).toHaveBeenCalledWith(
      'Username changed to "argus_v2"',
      expect.objectContaining({ oldUsername: 'argus', username: 'argus_v2' }),
    );
  });

  it('username unchanged: refuses with EXIT.USAGE before any transaction', async () => {
    await expect(updateProfileHandler.handler(baseArgv({ username: 'argus' })))
      .rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('no indexed account: the AccountUnknown gate is decided by the CHAIN, not by indexer silence', async () => {
    setIndexed(null);
    setChainUsername('argus');

    await updateProfileHandler.handler(baseArgv({ username: 'argus_v2' }));

    // The chain was consulted and reported a live registration → proceed
    expect(mocks.createReadContract).toHaveBeenCalledWith(UAR_ADDR, 'UniversalAccountRegistry', expect.anything());
    expect(mocks.executeTx.mock.calls[0][1]).toBe('changeUsername');
  });

  it('no indexed account AND the chain reports no username: PreconditionError, exit 4, nothing sent', async () => {
    setIndexed(null);
    setChainUsername('');

    await expect(updateProfileHandler.handler(baseArgv({ username: 'argus_v2' })))
      .rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('AccountUnknown'),
      expect.anything(),
    );
  });

  it('tombstoned indexed account is not trusted: falls through to the live read', async () => {
    setIndexed(liveAccount({ isDeleted: true, username: 'stale_name' }));
    setChainUsername('argus');

    await updateProfileHandler.handler(baseArgv({ username: 'argus_v2' }));

    expect(mocks.createReadContract).toHaveBeenCalled();
    expect(output.success).toHaveBeenCalledWith(
      'Username changed to "argus_v2"',
      expect.objectContaining({ oldUsername: 'argus' }),
    );
  });

  it('a failed live read is not "no username": the command continues and lets the contract decide', async () => {
    setIndexed(null);
    setChainUsername(new Error('rpc timeout'));

    await updateProfileHandler.handler(baseArgv({ username: 'argus_v2' }));

    expect(mocks.executeTx.mock.calls[0][1]).toBe('changeUsername');
  });

  it('no registry indexed: EXIT.INFRA with a syncing hint, nothing sent', async () => {
    mocks.query.mockResolvedValue({ universalAccountRegistries: [], account: null });

    await expect(updateProfileHandler.handler(baseArgv({ bio: 'x' })))
      .rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.INFRA);
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('username + metadata: changeUsername runs first, then setProfileMetadata', async () => {
    await updateProfileHandler.handler(baseArgv({ username: 'argus_v2', website: 'https://argus.xyz' }));

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.executeTx).toHaveBeenCalledTimes(2);
    expect(mocks.executeTx.mock.calls[0][1]).toBe('changeUsername');
    expect(mocks.executeTx.mock.calls[1][1]).toBe('setProfileMetadata');

    const pinned = JSON.parse(mocks.pinJson.mock.calls[0][0]);
    expect(pinned.website).toBe('https://argus.xyz');
    expect(pinned.bio).toBe('old bio');
  });
});
