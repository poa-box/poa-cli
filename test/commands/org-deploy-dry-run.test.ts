/**
 * pop org deploy — DESTRUCTIVE confirm + dry-run zero-tx guarantee.
 *
 * The deploy flow has several network side-effects (IPFS pin, nonce read,
 * local EIP-712 signature) but exactly ONE transaction:
 * OrgDeployer.deployFullOrg(params). These tests pin down that:
 *   - --dry-run fires ZERO transactions: executeTx receives dryRun:true
 *     (inside executeTx that stops at estimateGas) and the signer never
 *     signs/sends a transaction
 *   - the destructive confirmation refuses non-TTY sessions without --yes
 *     BEFORE the tx (even for dry runs — uniform destructive semantics)
 *   - config validation fails fast before any subgraph/IPFS work
 *   - the legacy success fields (orgId/orgName/metadataCid/gasUsed) are
 *     preserved through finishWrite
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  pinJson: vi.fn(),
  createSigner: vi.fn(),
  createReadContract: vi.fn(),
  query: vi.fn(),
  runPreflight: vi.fn(),
  checkGasBalance: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/ipfs', () => ({ pinJson: mocks.pinJson }));
vi.mock('../../src/lib/signer', () => ({ createSigner: mocks.createSigner }));
vi.mock('../../src/lib/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/contracts')>();
  // createWriteContract stays REAL (loads the synced OrgDeployerNew ABI);
  // only the registry read is stubbed (nonces).
  return { ...actual, createReadContract: mocks.createReadContract };
});
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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deployHandler } from '../../src/commands/org/deploy';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const ORG_DEPLOYER = '0x6666666666666666666666666666666666666666';
const ACCOUNT_REGISTRY = '0x7777777777777777777777777777777777777777';
const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

function validConfig(overrides: Record<string, any> = {}) {
  return {
    orgName: 'Test Org',
    deployerUsername: 'tester',
    description: 'A test org',
    autoUpgrade: true,
    hybridVoting: {
      thresholdPct: 51,
      classes: [{ strategy: 'DIRECT', slicePct: 100, quadratic: false, hatIds: [] }],
    },
    directDemocracy: { thresholdPct: 51 },
    roles: [
      {
        name: 'Member',
        canVote: true,
        defaults: { eligible: true, standing: true },
        distribution: { mintToDeployer: true },
        hatConfig: { maxSupply: 50, mutableHat: true },
      },
    ],
    roleAssignments: {
      quickJoinRoles: [],
      tokenMemberRoles: [0],
      tokenApproverRoles: [0],
      taskCreatorRoles: [0],
      hybridProposalCreatorRoles: [0],
      ddVotingRoles: [0],
      ddCreatorRoles: [0],
    },
    metadataAdminRoleIndex: 0,
    educationHub: { enabled: true },
    ...overrides,
  };
}

describe('pop org deploy — destructive confirm + dry-run zero-tx', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let configPath: string;
  let wallet: ethers.Wallet;
  let sendSpy: ReturnType<typeof vi.spyOn>;
  let signTxSpy: ReturnType<typeof vi.spyOn>;

  function writeConfig(config: Record<string, any>): string {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return configPath;
  }

  function baseArgv(overrides: Record<string, any> = {}): any {
    return {
      _: [],
      $0: 'pop',
      config: configPath,
      yes: true,
      preflight: true,
      dryRun: true,
      chain: 11155111,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _clearWriteContextCacheForTest();
    _setStreamsForTest(undefined, undefined, false); // deterministic non-TTY

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-deploy-test-'));
    configPath = path.join(tmpDir, 'org-deploy-config.json');

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);

    // Real wallet (offline): _signTypedData works locally; any attempt to
    // SEND would throw (no provider) and fail the test loudly.
    wallet = ethers.Wallet.createRandom();
    sendSpy = vi.spyOn(wallet, 'sendTransaction');
    signTxSpy = vi.spyOn(wallet, 'signTransaction');
    mocks.createSigner.mockReturnValue({
      signer: wallet,
      provider: {}, // est-cost getGasPrice degrades; preflight is mocked
      address: wallet.address,
      chainId: 11155111,
    });

    mocks.query.mockResolvedValue({
      poaManagerContracts: [{
        id: '0x9999999999999999999999999999999999999999',
        orgDeployerProxy: ORG_DEPLOYER,
        globalAccountRegistryProxy: ACCOUNT_REGISTRY,
      }],
    });
    mocks.createReadContract.mockReturnValue({
      nonces: vi.fn().mockResolvedValue(ethers.BigNumber.from(0)),
    });
    mocks.pinJson.mockResolvedValue(CID);
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.checkGasBalance.mockReturnValue({ label: 'gas balance' });
    mocks.executeTx.mockResolvedValue({
      success: true,
      dryRun: true,
      gasEstimate: '12000000',
      method: 'deployFullOrg',
      to: ORG_DEPLOYER,
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    _setStreamsForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('--dry-run fires ZERO transactions: executeTx gets dryRun:true and the signer never signs/sends', async () => {
    writeConfig(validConfig());

    await deployHandler.handler(baseArgv({ dryRun: true, yes: true }));

    // Exactly one executeTx — the single deployFullOrg — in dry-run mode
    // (executeTx stops at estimateGas; nothing is broadcast).
    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args, opts] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('deployFullOrg');
    expect(opts).toEqual({ dryRun: true, gasLimit: 15000000, value: undefined });
    expect(contract.address).toBe(ORG_DEPLOYER);
    expect(() => contract.interface.getFunction('deployFullOrg')).not.toThrow();

    // orgId derivation preserved: keccak256(lowercased hyphenated name)
    const [deployParams] = args;
    expect(deployParams[0]).toBe(ethers.utils.keccak256(ethers.utils.toUtf8Bytes('test-org')));
    expect(deployParams[1]).toBe('Test Org');

    // The params tuple must ENCODE against the real synced ABI — guards the
    // full 22-field DeploymentParams arity (incl. taskManagerPerms, which
    // pre-fix was missing and broke every deploy against the v6 ABI).
    expect(deployParams).toHaveLength(22);
    expect(() => contract.interface.encodeFunctionData('deployFullOrg', [deployParams])).not.toThrow();

    // The wallet itself never signed or sent ANY transaction.
    expect(sendSpy).not.toHaveBeenCalled();
    expect(signTxSpy).not.toHaveBeenCalled();

    expect(output.success).toHaveBeenCalledWith(
      expect.stringContaining('DRY RUN'),
      expect.objectContaining({ method: 'deployFullOrg', gasEstimate: '12000000' }),
    );
  });

  it('destructive gate: non-TTY without --yes refuses with EXIT.ABORTED before the tx (even in dry-run)', async () => {
    writeConfig(validConfig());

    await expect(
      deployHandler.handler(baseArgv({ yes: false, dryRun: true }))
    ).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.ABORTED);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('destructive'),
      expect.anything(),
    );
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('config validation fails fast (EXIT.USAGE) before any subgraph or IPFS work', async () => {
    writeConfig({ ...validConfig(), orgName: undefined });

    await expect(deployHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('orgName'),
      expect.anything(),
    );
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.pinJson).not.toHaveBeenCalled();
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('missing config file: EXIT.USAGE with a deploy-config suggestion', async () => {
    await expect(
      deployHandler.handler(baseArgv({ config: path.join(tmpDir, 'nope.json') }))
    ).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
      expect.objectContaining({ suggestion: expect.stringContaining('pop org deploy-config') }),
    );
  });

  it('paymaster funding rides the SAME single tx as msg.value (not a second tx)', async () => {
    writeConfig(validConfig({
      paymaster: {
        operatorRoleIndex: 0,
        maxFeePerGas: '20',
        maxPriorityFeePerGas: '5',
        defaultBudgetCapPerEpoch: '1',
        defaultBudgetEpochLen: 604800,
        funding: '1',
      },
    }));

    await deployHandler.handler(baseArgv({ dryRun: true, yes: true }));

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [, , , opts] = mocks.executeTx.mock.calls[0];
    expect(opts.value?.toString()).toBe(ethers.utils.parseEther('1').toString());
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('real run preserves the legacy success fields through finishWrite', async () => {
    writeConfig(validConfig());
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xdeadbeef',
      explorerUrl: 'https://explorer/tx/0xdeadbeef',
      gasUsed: '11884211',
      logs: [],
    });

    await deployHandler.handler(baseArgv({ dryRun: false, yes: true }));

    expect(output.success).toHaveBeenCalledWith('Organization deployed', expect.objectContaining({
      orgId: ethers.utils.keccak256(ethers.utils.toUtf8Bytes('test-org')),
      orgName: 'Test Org',
      metadataCid: CID,
      gasUsed: '11884211',
      txHash: '0xdeadbeef',
      explorerUrl: 'https://explorer/tx/0xdeadbeef',
    }));
  });
});
