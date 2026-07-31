/**
 * pop treasury propose-finalize — the governance wrap must encode EXACTLY
 * PaymentManager.finalizeDistribution(distributionId, minClaimPeriodBlocks)
 * as the option-0 execution batch (option 1 = keep open, no-op).
 *
 * The createProposal calldata is decoded back in the assertions so an ABI or
 * argument-order regression fails loudly. Pre-flight mirrors the contract's
 * DistributionNotFound / AlreadyFinalized gates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  createReadContract: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
  pinJson: vi.fn(),
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
vi.mock('../../src/lib/ipfs', () => ({ pinJson: mocks.pinJson }));
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
    isJsonMode: vi.fn(() => false),
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import { proposeFinalizeHandler } from '../../src/commands/treasury/propose-finalize';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { ipfsCidToBytes32, stringToBytes } from '../../src/lib/encoding';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const PM_ADDR = '0x1111111111111111111111111111111111111111';
const VOTING_ADDR = '0x5555555555555555555555555555555555555555';
const WALLET = '0x2222222222222222222222222222222222222222';
const ORG_ID = '0x' + 'ab'.repeat(32);
const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

const PM_IFACE = new ethers.utils.Interface([
  'function finalizeDistribution(uint256 distributionId, uint256 minClaimPeriodBlocks)',
]);

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

function distFixture(overrides: Record<string, any> = {}) {
  return {
    payoutToken: ethers.constants.AddressZero,
    totalAmount: ethers.utils.parseEther('100'),
    checkpointBlock: ethers.BigNumber.from(41000000),
    merkleRoot: '0x' + '11'.repeat(32),
    totalClaimed: ethers.utils.parseEther('60'),
    finalized: false,
    ...overrides,
  };
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    distribution: 3,
    minClaimBlocks: 0,
    duration: 60,
    yes: false,
    preflight: true,
    dryRun: false,
    ...overrides,
  };
}

describe('pop treasury propose-finalize — calldata + gates', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let pmRead: { getDistribution: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    _clearWriteContextCacheForTest();
    _setStreamsForTest(undefined, undefined, false);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);

    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      provider: { getBlockNumber: vi.fn().mockResolvedValue(41100000) },
      address: WALLET,
      chainId: 100,
    });
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      paymentManagerAddress: PM_ADDR,
      hybridVotingAddress: VOTING_ADDR,
    });
    pmRead = { getDistribution: vi.fn().mockResolvedValue(distFixture()) };
    mocks.createReadContract.mockReturnValue(pmRead);
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.checkGasBalance.mockReturnValue({ label: 'gas balance' });
    mocks.pinJson.mockResolvedValue(CID);
    // Indexed Distribution: createdAtBlock is AFTER checkpointBlock, as it always is on live
    // data (the tree is built at the checkpoint, then governance votes).
    mocks.query.mockResolvedValue({ distribution: { createdAtBlock: '41050000' } });
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xabc',
      explorerUrl: 'https://explorer/tx/0xabc',
      logs: [{ name: 'NewProposal', args: { id: ethers.BigNumber.from(7) } }],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    _setStreamsForTest();
  });

  it('option-0 batch decodes to finalizeDistribution(distId, minClaimBlocks) targeting the PaymentManager', async () => {
    await proposeFinalizeHandler.handler(baseArgv({ minClaimBlocks: 120960 }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('createProposal');
    expect(() => contract.interface.getFunction('createProposal')).not.toThrow();

    const [titleBytes, descriptionHash, duration, numOptions, batches, hatIds] = args;
    expect(ethers.utils.hexlify(titleBytes)).toBe(ethers.utils.hexlify(stringToBytes('Finalize distribution #3')));
    expect(descriptionHash).toBe(ipfsCidToBytes32(CID));
    expect(duration).toBe(60);
    expect(numOptions).toBe(2);
    expect(hatIds).toEqual([]);

    // Option 0: exactly one call, targeting the PaymentManager with value 0
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(1);
    const [target, value, calldata] = batches[0][0];
    expect(target).toBe(PM_ADDR);
    expect((value as ethers.BigNumber).isZero()).toBe(true);

    // The calldata round-trips through the real contract signature
    const decoded = PM_IFACE.decodeFunctionData('finalizeDistribution', calldata);
    expect(decoded.distributionId.toNumber()).toBe(3);
    expect(decoded.minClaimPeriodBlocks.toNumber()).toBe(120960);

    // Option 1 is the no-op "keep open"
    expect(batches[1]).toEqual([]);

    expect(output.success).toHaveBeenCalledWith(
      expect.stringContaining('Proposal #7'),
      expect.objectContaining({ proposalId: '7', distributionId: 3, minClaimPeriodBlocks: 120960 })
    );
  });

  it('defaults --min-claim-blocks to 0', async () => {
    await proposeFinalizeHandler.handler(baseArgv());

    const batches = mocks.executeTx.mock.calls[0][2][4];
    const decoded = PM_IFACE.decodeFunctionData('finalizeDistribution', batches[0][0][2]);
    expect(decoded.minClaimPeriodBlocks.toNumber()).toBe(0);
  });

  it('fails fast (exit 4) when the distribution does not exist — DistributionNotFound mirror', async () => {
    pmRead.getDistribution.mockResolvedValue(distFixture({ totalAmount: ethers.BigNumber.from(0) }));

    await expect(proposeFinalizeHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(mocks.pinJson).not.toHaveBeenCalled();
  });

  it('fails fast (exit 4) when the distribution is already finalized', async () => {
    pmRead.getDistribution.mockResolvedValue(distFixture({ finalized: true }));

    await expect(proposeFinalizeHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('already finalized'), expect.anything());
  });
});

/**
 * The ClaimPeriodNotExpired warning must anchor on the distribution's CREATION block.
 *
 * PaymentManager.getDistribution returns exactly
 * (payoutToken, totalAmount, checkpointBlock, merkleRoot, totalClaimed, finalized) — there is no
 * `createdAtBlock` on that struct, and `creationBlock` is private with no getter. Reading
 * `dist.createdAtBlock` off the on-chain result therefore yielded `undefined` on every call, so
 * the ternary always fell to checkpointBlock and the M-08 re-anchoring never happened. The
 * subgraph is the only source, and these tests fail if the on-chain object is trusted again.
 */
/**
 * The claim-window anchor is the CHECKPOINT block, because that is what the
 * deployed contract uses. Verified by eth_call against live Gnosis PaymentManager
 * 0x409f51250dc5c66bb1d6952f947d841192f1140e, distribution 4 (checkpointBlock
 * 45623101, indexed createdAtBlock 45623935):
 *
 *   finalizeDistribution(4, N) with checkpoint+N passed but creation+N in the
 *   future  -> returns '0x'        (no revert — the window HAS cleared)
 *   finalizeDistribution(4, huge)                -> returns 0x4dece07e
 *                                                   (ClaimPeriodNotExpired)
 *
 * Audit M-08 proposes re-anchoring on the creation block, but that build is not
 * deployed. These tests previously asserted the creation anchor, which pinned a
 * warning that fires for windows that have ALREADY cleared and prints a clearance
 * block ~800-1500 blocks too late on every live org.
 */
describe('pop treasury propose-finalize — the claim-window anchor is the checkpoint block', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let pmRead: { getDistribution: ReturnType<typeof vi.fn> };
  let getBlockNumber: ReturnType<typeof vi.fn>;

  const CHECKPOINT = 41000000;
  const CREATED = 41050000; // 50k blocks later — the window the contract actually enforces

  beforeEach(() => {
    vi.clearAllMocks();
    _clearWriteContextCacheForTest();
    _setStreamsForTest(undefined, undefined, false);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);

    getBlockNumber = vi.fn().mockResolvedValue(CHECKPOINT + 30000);
    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      provider: { getBlockNumber },
      address: WALLET,
      chainId: 100,
    });
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      paymentManagerAddress: PM_ADDR,
      hybridVotingAddress: VOTING_ADDR,
    });
    pmRead = {
      getDistribution: vi.fn().mockResolvedValue(
        distFixture({ checkpointBlock: ethers.BigNumber.from(CHECKPOINT) })
      ),
    };
    mocks.createReadContract.mockReturnValue(pmRead);
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.checkGasBalance.mockReturnValue({ label: 'gas balance' });
    mocks.pinJson.mockResolvedValue(CID);
    mocks.query.mockResolvedValue({ distribution: { createdAtBlock: String(CREATED) } });
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xabc',
      explorerUrl: 'https://explorer/tx/0xabc',
      logs: [{ name: 'NewProposal', args: { id: ethers.BigNumber.from(7) } }],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    _setStreamsForTest();
  });

  it('stays silent when the CHECKPOINT-anchored window has already cleared', async () => {
    // 20k window: clear from the CHECKPOINT (41,020,000 < 41,030,000 now) but not from
    // creation (41,070,000 > now). The contract gate is checkpoint-anchored, so the
    // window really HAS cleared and warning here would be a false positive on every
    // live org.
    await proposeFinalizeHandler.handler(baseArgv({ minClaimBlocks: 20000 }));

    expect(output.warn).not.toHaveBeenCalled();
  });

  it('warns using checkpointBlock + minClaimBlocks when the window is genuinely open', async () => {
    await proposeFinalizeHandler.handler(baseArgv({ minClaimBlocks: 60000 }));

    expect(output.warn).toHaveBeenCalledWith(expect.stringContaining(String(CHECKPOINT + 60000)));
    expect(output.warn).not.toHaveBeenCalledWith(expect.stringContaining(String(CREATED + 60000)));
  });

  it('needs no subgraph round-trip at all — checkpointBlock is on the struct', async () => {
    await proposeFinalizeHandler.handler(baseArgv({ minClaimBlocks: 60000 }));

    // getDistribution() already returns checkpointBlock, so the extra
    // Distribution(id:) query the creation anchor required is gone.
    expect(mocks.query).not.toHaveBeenCalled();
    expect(output.warn).toHaveBeenCalledWith(expect.stringContaining(String(CHECKPOINT + 60000)));
  });

  it('describes the window as checkpoint-anchored in the pinned proposal metadata', async () => {
    // This text is pinned to IPFS and read by voters; it cannot be edited later.
    await proposeFinalizeHandler.handler(baseArgv({ minClaimBlocks: 60000 }));

    const pinned = JSON.parse(mocks.pinJson.mock.calls[0][0]);
    expect(pinned.description).toContain('blocks from the checkpoint block');
    expect(pinned.description).not.toContain('distribution creation block');
  });

  it('skips the block read entirely when --min-claim-blocks is 0', async () => {
    await proposeFinalizeHandler.handler(baseArgv({ minClaimBlocks: 0 }));

    expect(output.warn).not.toHaveBeenCalled();
  });

  it('a getBlockNumber outage degrades to no warning, never to a failed proposal', async () => {
    getBlockNumber.mockRejectedValue(new Error('502 bad gateway'));

    await proposeFinalizeHandler.handler(baseArgv({ minClaimBlocks: 20000 }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
  });
});
