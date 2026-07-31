/**
 * pop zkemail propose-allowlist — where the CURRENT root comes from.
 *
 * The command showed a diff ("replacing <currentRoot>") built from a `merkleRoot()` eth_call,
 * even though `ZkEmailInvites.activeRoot` is indexed and the sibling `helpers.readModuleState`
 * already serves it for free. That is display-only data, so it now reads the subgraph first and
 * only falls back to the contract when the module row is missing.
 *
 * `executor()` deliberately does NOT move: it gates the "this module answers to a different
 * executor" pre-flight, and getting that wrong costs a full governance cycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  createReadContract: vi.fn(),
  query: vi.fn(),
  pinJson: vi.fn(),
  fetchJson: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/signer', () => ({ createSigner: mocks.createSigner }));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => modules[key],
  resolveOrgId: vi.fn(),
}));
vi.mock('../../src/lib/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/contracts')>();
  return { ...actual, createReadContract: mocks.createReadContract };
});
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query, queryWithFieldFallback: vi.fn() }));
vi.mock('../../src/lib/ipfs', () => ({ pinJson: mocks.pinJson, fetchJson: mocks.fetchJson }));
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
import { proposeAllowlistHandler } from '../../src/commands/zkemail/propose-allowlist';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { _setStreamsForTest } from '../../src/lib/prompt';

const MODULE = '0xadaf24f05ee0d647a7c2af5cad0f377f1b159fd2';
const EXECUTOR = '0xa09f1035ff97d17cca40048f027c654b66b83183';
const VOTING = '0x5555555555555555555555555555555555555555';
const WALLET = '0x2222222222222222222222222222222222222222';
const ORG_ID = '0x' + 'ab'.repeat(32);
const CID = 'QmfCsZWQtF9RWaWcF8qNyhhUWKn4qcPWdBicW8n4e3NXUd';
const NEW_ROOT = '0x' + '77'.repeat(32);
// The live Gnosis value, proving activeRoot is populated on real data.
const INDEXED_ROOT = '0x1d5d75df3ee05a0a90c42f0fe423f3c063dedf3466378e45a8343bfef18ebc46';
const CHAIN_ROOT = '0x' + '99'.repeat(32);

const MODULE_IFACE = new ethers.utils.Interface([
  'function setActiveAllowlist(bytes32 root, bytes32 cidDigest)',
]);

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [], $0: 'pop', org: 'testorg', root: NEW_ROOT, cid: CID,
    duration: 1440, skipVerify: true, yes: true, dryRun: false, ...overrides,
  };
}

describe('pop zkemail propose-allowlist — current root from the subgraph, executor from chain', () => {
  let readModule: { merkleRoot: ReturnType<typeof vi.fn>; executor: ReturnType<typeof vi.fn>; interface: ethers.utils.Interface };

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
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      zkEmailInvitesAddress: MODULE,
      hybridVotingAddress: VOTING,
      executorAddress: EXECUTOR,
    });

    readModule = {
      merkleRoot: vi.fn().mockResolvedValue(CHAIN_ROOT),
      executor: vi.fn().mockResolvedValue(EXECUTOR),
      interface: MODULE_IFACE,
    };
    mocks.createReadContract.mockReturnValue(readModule);

    mocks.query.mockResolvedValue({
      organization: { id: ORG_ID, zkEmailInvites: { id: MODULE, activeRoot: INDEXED_ROOT, activeAllowlistCid: CID } },
    });
    mocks.pinJson.mockResolvedValue(CID);
    mocks.executeTx.mockResolvedValue({
      success: true, txHash: '0xabc', explorerUrl: 'https://explorer/tx/0xabc',
      logs: [{ name: 'NewProposal', args: { id: ethers.BigNumber.from(4) } }],
    });
  });

  afterEach(() => { _setStreamsForTest(); });

  it('uses the indexed activeRoot and never calls merkleRoot()', async () => {
    await proposeAllowlistHandler.handler(baseArgv());

    expect(readModule.merkleRoot).not.toHaveBeenCalled();
    expect(readModule.executor).toHaveBeenCalledTimes(1); // still authoritative
    const metadataJson = JSON.parse(mocks.pinJson.mock.calls[0][0]);
    expect(metadataJson.description).toContain(INDEXED_ROOT);
    expect(metadataJson.description).not.toContain(CHAIN_ROOT);
  });

  it('the proposal still encodes setActiveAllowlist(newRoot, cidDigest) targeting the module', async () => {
    await proposeAllowlistHandler.handler(baseArgv());

    const [, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('createProposal');
    const batches = args[4];
    const [target, value, calldata] = batches[0][0];
    expect(target).toBe(MODULE);
    expect((value as ethers.BigNumber).isZero()).toBe(true);
    const decoded = MODULE_IFACE.decodeFunctionData('setActiveAllowlist', calldata);
    expect(decoded.root).toBe(NEW_ROOT);
    expect(batches[1]).toEqual([]);
  });

  it('a null activeRoot on an EXISTING module row reads as dormant, not as unindexed', async () => {
    mocks.query.mockResolvedValue({
      organization: { id: ORG_ID, zkEmailInvites: { id: MODULE, activeRoot: null, activeAllowlistCid: null } },
    });

    await proposeAllowlistHandler.handler(baseArgv());

    expect(readModule.merkleRoot).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.pinJson.mock.calls[0][0]).description).toContain('no active allowlist');
  });

  it('falls back to merkleRoot() when the module is not indexed yet', async () => {
    mocks.query.mockResolvedValue({ organization: { id: ORG_ID, zkEmailInvites: null } });

    await proposeAllowlistHandler.handler(baseArgv());

    expect(readModule.merkleRoot).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.pinJson.mock.calls[0][0]).description).toContain(CHAIN_ROOT);
  });

  it('falls back when the indexed row points at a DIFFERENT module than the proposal targets', async () => {
    mocks.query.mockResolvedValue({
      organization: { id: ORG_ID, zkEmailInvites: { id: '0xdead000000000000000000000000000000000000', activeRoot: INDEXED_ROOT } },
    });

    await proposeAllowlistHandler.handler(baseArgv());

    expect(readModule.merkleRoot).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.pinJson.mock.calls[0][0]).description).toContain(CHAIN_ROOT);
  });

  it('a subgraph outage falls back to the contract rather than failing the proposal', async () => {
    mocks.query.mockRejectedValue(new Error('502 bad gateway'));

    await proposeAllowlistHandler.handler(baseArgv());

    expect(readModule.merkleRoot).toHaveBeenCalledTimes(1);
    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
  });
});
