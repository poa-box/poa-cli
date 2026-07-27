/**
 * pop org set-metadata-admin — governance-proposal wiring.
 *
 * setOrgMetadataAdminHat(bytes32,uint256) is executor-only after bootstrap
 * (verified against contracts origin/main src/OrgRegistry.sol), so the
 * command must ship it as a HybridVoting proposal whose option-0 execution
 * batch targets the OrgRegistry. These tests decode the exact calldata the
 * executor would perform when the vote passes.
 *
 * command.ts (getWriteContext/confirmWrite/finishWrite) runs REAL; the
 * module seams (tx, ipfs, signer, resolve, subgraph, preflight, output)
 * are mocked — same harness shape as task-perms.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  pinJson: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  query: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/ipfs', () => ({ pinJson: mocks.pinJson }));
vi.mock('../../src/lib/signer', () => ({ createSigner: mocks.createSigner }));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => {
    if (!modules?.[key]) throw new Error(`missing module ${key}`);
    return modules[key];
  },
}));
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
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
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    json: vi.fn(),
    table: vi.fn(),
    keyValueBlock: vi.fn(),
    isJsonMode: vi.fn(() => false),
    isQuietMode: vi.fn(() => false),
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import { setMetadataAdminHandler } from '../../src/commands/org/set-metadata-admin';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { ipfsCidToBytes32 } from '../../src/lib/encoding';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const VOTING_ADDR = '0x4444444444444444444444444444444444444444';
const ORG_REGISTRY = '0x5555555555555555555555555555555555555555';
const WALLET = '0x2222222222222222222222222222222222222222';
const ORG_ID = '0x' + 'ab'.repeat(32);
const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

const registryIface = new ethers.utils.Interface([
  'function setOrgMetadataAdminHat(bytes32 orgId, uint256 hatId)',
]);

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    hat: '123',
    duration: 60,
    yes: true,
    preflight: true,
    dryRun: false,
    ...overrides,
  };
}

describe('pop org set-metadata-admin — governance proposal wiring', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _clearWriteContextCacheForTest();
    _setStreamsForTest(undefined, undefined, false); // deterministic non-TTY

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);

    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      provider: {}, // createReadContract(ORG_REGISTRY, …, {}) throws → current-hat read degrades
      address: WALLET,
      chainId: 11155111,
    });
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      hybridVotingAddress: VOTING_ADDR,
      taskManagerAddress: '0x1111111111111111111111111111111111111111',
    });
    mocks.query.mockResolvedValue({
      poaManagerContracts: [{ id: '0x9999999999999999999999999999999999999999', orgRegistryProxy: ORG_REGISTRY }],
    });
    mocks.pinJson.mockResolvedValue(CID);
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.checkGasBalance.mockReturnValue({ label: 'gas balance' });
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xhash',
      explorerUrl: 'https://explorer/tx/0xhash',
      logs: [{ name: 'NewProposal', args: { id: ethers.BigNumber.from(7) } }],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    _setStreamsForTest();
  });

  it('wraps setOrgMetadataAdminHat(orgId, hat) in the option-0 execution batch targeting the OrgRegistry', async () => {
    await setMetadataAdminHandler.handler(baseArgv({ hat: '123' }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args] = mocks.executeTx.mock.calls[0];

    // Proposal goes to the org's HybridVoting with the real synced ABI.
    expect(method).toBe('createProposal');
    expect(contract.address).toBe(VOTING_ADDR);
    expect(() => contract.interface.getFunction('createProposal')).not.toThrow();

    // createProposal(title, descriptionHash, minutesDuration, numOptions, batches, hatIds)
    expect(ethers.utils.toUtf8String(args[0])).toContain('metadata-admin hat');
    expect(args[1]).toBe(ipfsCidToBytes32(CID));
    expect(args[2]).toBe(60);
    expect(args[3]).toBe(2);
    expect(args[5]).toEqual([]);

    const batches = args[4];
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([]); // option 1 = keep current admin

    expect(batches[0]).toHaveLength(1);
    const [target, value, calldata] = batches[0][0];
    expect(target).toBe(ORG_REGISTRY); // execution targets the OrgRegistry, not voting
    expect(ethers.BigNumber.from(value).isZero()).toBe(true);

    // Decode and assert the exact executor call the vote would perform.
    const decoded = registryIface.decodeFunctionData('setOrgMetadataAdminHat', calldata);
    expect(decoded.orgId).toBe(ORG_ID);
    expect(decoded.hatId.toString()).toBe('123');

    // Proposal metadata pinned once, with two option names.
    expect(mocks.pinJson).toHaveBeenCalledTimes(1);
    const pinned = JSON.parse(mocks.pinJson.mock.calls[0][0]);
    expect(pinned.optionNames).toHaveLength(2);
    expect(pinned.description).toContain('setOrgMetadataAdminHat');

    expect(output.success).toHaveBeenCalledWith(
      'Proposal #7 created — needs a vote to take effect',
      expect.objectContaining({
        proposalId: '7',
        hatId: '123',
        orgRegistry: ORG_REGISTRY,
        nextStep: expect.stringContaining('pop vote cast --proposal 7'),
      }),
    );
  });

  it('--hat 0 (clear → topHat fallback): encodes hatId 0 and says so in the metadata', async () => {
    await setMetadataAdminHandler.handler(baseArgv({ hat: '0' }));

    const [, , args] = mocks.executeTx.mock.calls[0];
    const [, , calldata] = args[4][0][0];
    const decoded = registryIface.decodeFunctionData('setOrgMetadataAdminHat', calldata);
    expect(decoded.hatId.isZero()).toBe(true);

    const pinned = JSON.parse(mocks.pinJson.mock.calls[0][0]);
    expect(pinned.description).toContain('topHat');
  });

  it('accepts a 0x-hex hat ID and encodes the same integer', async () => {
    await setMetadataAdminHandler.handler(baseArgv({ hat: '0x7b' }));

    const [, , args] = mocks.executeTx.mock.calls[0];
    const decoded = registryIface.decodeFunctionData('setOrgMetadataAdminHat', args[4][0][0][2]);
    expect(decoded.hatId.toString()).toBe('123');
  });

  it('invalid --hat fails with a usage error before any pin or tx', async () => {
    await expect(
      setMetadataAdminHandler.handler(baseArgv({ hat: 'not-a-hat' }))
    ).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid --hat'),
      expect.anything(),
    );
    expect(mocks.pinJson).not.toHaveBeenCalled();
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('org without HybridVoting: precondition error before pin/tx', async () => {
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      hybridVotingAddress: null,
    });

    await expect(setMetadataAdminHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('HybridVoting not deployed'),
      expect.anything(),
    );
    expect(mocks.pinJson).not.toHaveBeenCalled();
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('missing OrgRegistry address from the subgraph: infra error before pin/tx', async () => {
    mocks.query.mockResolvedValue({ poaManagerContracts: [] });

    await expect(setMetadataAdminHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.INFRA);
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('--dry-run passes through to executeTx without sending', async () => {
    mocks.executeTx.mockResolvedValue({
      success: true,
      dryRun: true,
      gasEstimate: '210000',
      method: 'createProposal',
      to: VOTING_ADDR,
    });

    await setMetadataAdminHandler.handler(baseArgv({ dryRun: true }));

    expect(mocks.executeTx.mock.calls[0][3]).toEqual({ dryRun: true });
    expect(output.success).toHaveBeenCalledWith(
      expect.stringContaining('DRY RUN'),
      expect.objectContaining({ method: 'createProposal' }),
    );
  });
});
