/**
 * Tests for `pop vote classes` (show / propose).
 *
 * show    — renders getClasses()/getProposalClasses(id) as a table with both
 *           strategies named, plus the two DISTINCT validity parameters
 *           (support threshold % / quorum voter count); degrades gracefully
 *           for orgs without HybridVoting.
 * propose — validates the ClassConfig[] JSON locally (slices must sum to
 *           100, ERC20_BAL needs an asset, ≤8 classes) and wraps
 *           setClasses(ClassConfig[]) — executor-gated on HybridVoting — in
 *           a governance proposal. The calldata embedded in the option-0
 *           execution batch is decoded here with the real ABI and asserted
 *           field-by-field (including >2^53 hat IDs surviving as BigNumbers).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';
import fs from 'fs';
import os from 'os';
import path from 'path';

const {
  executeTxMock,
  pinJsonMock,
  resolveOrgModulesMock,
  createReadContractMock,
  getWriteContextMock,
  confirmWriteMock,
  queryMock,
  infoMock,
  errorMock,
  tableMock,
  jsonMock,
  isJsonModeMock,
} = vi.hoisted(() => ({
  executeTxMock: vi.fn(),
  pinJsonMock: vi.fn(),
  resolveOrgModulesMock: vi.fn(),
  createReadContractMock: vi.fn(),
  getWriteContextMock: vi.fn(),
  confirmWriteMock: vi.fn(async () => {}),
  queryMock: vi.fn(),
  infoMock: vi.fn(),
  errorMock: vi.fn(),
  tableMock: vi.fn(),
  jsonMock: vi.fn(),
  isJsonModeMock: vi.fn(() => false),
}));

vi.mock('../../src/lib/tx', () => ({
  executeTx: executeTxMock,
}));

vi.mock('../../src/lib/ipfs', () => ({
  pinJson: pinJsonMock,
}));

vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: resolveOrgModulesMock,
}));

vi.mock('../../src/lib/subgraph', () => ({
  query: queryMock,
}));

vi.mock('../../src/lib/signer', () => ({
  createProvider: vi.fn(() => ({})),
  createSigner: vi.fn(() => ({ signer: {} })),
}));

// Keep loadAbi real (the propose path encodes setClasses with the real
// HybridVotingNew ABI); stub only the contract constructors.
vi.mock('../../src/lib/contracts', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createReadContract: createReadContractMock,
    createWriteContract: vi.fn(() => ({ address: '0xC0FFEE' })),
  };
});

vi.mock('../../src/lib/command', () => ({
  getWriteContext: getWriteContextMock,
  confirmWrite: confirmWriteMock,
  finishWrite: vi.fn(),
  withIdempotency: vi.fn(async (_argv: any, _orgId: any, _cmd: any, run: any) => { await run(); }),
}));

vi.mock('../../src/lib/preflight', () => ({
  runPreflight: vi.fn(async () => {}),
  checkGasBalance: vi.fn(() => ({ label: 'gas balance' })),
}));

vi.mock('../../src/lib/output', () => ({
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), text: '' })),
  success: vi.fn(),
  error: errorMock,
  info: infoMock,
  warn: vi.fn(),
  debug: vi.fn(),
  table: tableMock,
  json: jsonMock,
  isJsonMode: isJsonModeMock,
  keyValueBlock: vi.fn(),
}));

import { classesShowHandler, classesProposeHandler, parseClassConfigs, CLASS_STRATEGY } from '../../src/commands/vote/classes';
import HybridVotingAbi from '../../src/abi/HybridVotingNew.json';

const HYBRID_ADDR = '0x1111111111111111111111111111111111111111';
const TOKEN_ADDR = ethers.utils.getAddress('0x' + '22'.repeat(20));
const ORG_ID = '0x' + '11'.repeat(32);

// A real-shaped top-hat ID: high bits set, ≫ 2^53.
const BIG_HAT_ID = '26959946667150639794667015087019630673637144422540572481103610249216';

const setClassesIface = new ethers.utils.Interface(HybridVotingAbi as any);

let tmpDir: string;

function writeClassesFile(doc: any): string {
  const file = path.join(tmpDir, `classes-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}

function modules(overrides: Record<string, any> = {}): any {
  return {
    orgId: ORG_ID,
    hybridVotingAddress: HYBRID_ADDR,
    ddVotingAddress: null,
    taskManagerAddress: null,
    participationTokenAddress: null,
    educationHubAddress: null,
    executorAddress: null,
    quickJoinAddress: null,
    eligibilityModuleAddress: null,
    paymentManagerAddress: null,
    ...overrides,
  };
}

describe('vote classes', () => {
  let exitSpy: any;
  let logSpy: any;

  beforeEach(() => {
    executeTxMock.mockReset();
    pinJsonMock.mockReset();
    resolveOrgModulesMock.mockReset();
    createReadContractMock.mockReset();
    getWriteContextMock.mockReset();
    confirmWriteMock.mockClear();
    queryMock.mockReset();
    infoMock.mockReset();
    errorMock.mockReset();
    tableMock.mockReset();
    jsonMock.mockReset();
    isJsonModeMock.mockReturnValue(false);

    pinJsonMock.mockResolvedValue('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
    executeTxMock.mockResolvedValue({
      success: true,
      txHash: '0xabc',
      explorerUrl: 'https://example.com/tx/0xabc',
      logs: [{ name: 'NewProposal', args: { id: ethers.BigNumber.from(3) } }],
    });
    getWriteContextMock.mockResolvedValue({
      orgId: ORG_ID,
      modules: modules(),
      signer: {},
      provider: {},
      address: '0x' + 'aa'.repeat(20),
      chainId: 100,
      networkName: 'Gnosis',
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vote-classes-'));
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ────────────────────────────── show ──────────────────────────────

  describe('show', () => {
    const onChainClasses = [
      {
        strategy: 0,
        slicePct: 50,
        quadratic: false,
        minBalance: ethers.BigNumber.from(0),
        asset: ethers.constants.AddressZero,
        hatIds: [],
      },
      {
        strategy: 1,
        slicePct: 50,
        quadratic: true,
        minBalance: ethers.utils.parseEther('1'),
        asset: TOKEN_ADDR,
        hatIds: [ethers.BigNumber.from(BIG_HAT_ID)],
      },
    ];

    function mockReadContract(overrides: Record<string, any> = {}) {
      const contract = {
        getClasses: vi.fn(async () => onChainClasses),
        getProposalClasses: vi.fn(async () => [onChainClasses[0]]),
        thresholdPct: vi.fn(async () => 51),
        quorum: vi.fn(async () => 2),
        ...overrides,
      };
      createReadContractMock.mockReturnValue(contract);
      return contract;
    }

    it('renders both strategies with slice/quadratic/min-balance/hat columns + distinct threshold/quorum lines', async () => {
      resolveOrgModulesMock.mockResolvedValue(modules());
      const contract = mockReadContract();

      await classesShowHandler.handler({ org: 'test-org' } as any);

      expect(contract.getClasses).toHaveBeenCalledTimes(1);
      expect(contract.getProposalClasses).not.toHaveBeenCalled();

      expect(tableMock).toHaveBeenCalledTimes(1);
      const [headers, rows] = tableMock.mock.calls[0];
      expect(headers).toEqual(['#', 'Strategy', 'Slice %', 'Quadratic', 'Min balance', 'Asset', 'Hat IDs']);
      expect(rows).toHaveLength(2);
      expect(rows[0][1]).toBe('DIRECT');
      expect(rows[1][1]).toBe('ERC20_BAL');
      expect(rows[0][2]).toBe('50%');
      expect(rows[1][2]).toBe('50%');
      expect(rows[0][3]).toBe('no');
      expect(rows[1][3]).toBe('yes');
      expect(rows[1][4]).toBe('1'); // formatToken(1e18)
      expect(rows[1][5]).toContain('0x2222'); // formatAddress
      expect(rows[1][6]).toBe(BIG_HAT_ID);

      const printed = logSpy.mock.calls.map((c: any[]) => String(c[0] ?? '')).join('\n');
      expect(printed).toMatch(/Support threshold: 51%/);
      expect(printed).toMatch(/Quorum: 2 voters \(0 = disabled\)/);
    });

    it('--proposal N reads the frozen snapshot via getProposalClasses', async () => {
      resolveOrgModulesMock.mockResolvedValue(modules());
      const contract = mockReadContract();

      await classesShowHandler.handler({ org: 'test-org', proposal: '7' } as any);

      expect(contract.getProposalClasses).toHaveBeenCalledWith(7);
      expect(contract.getClasses).not.toHaveBeenCalled();
      // Numeric --proposal never hits the subgraph resolver.
      expect(queryMock).not.toHaveBeenCalled();
    });

    it('--json emits the machine-readable dump with both validity parameters', async () => {
      resolveOrgModulesMock.mockResolvedValue(modules());
      mockReadContract();
      isJsonModeMock.mockReturnValue(true);

      await classesShowHandler.handler({ org: 'test-org' } as any);

      expect(jsonMock).toHaveBeenCalledTimes(1);
      const doc = jsonMock.mock.calls[0][0];
      expect(doc.hybridVoting).toBe(HYBRID_ADDR);
      expect(doc.supportThresholdPct).toBe(51);
      expect(doc.quorumVoterCount).toBe(2);
      expect(doc.classes).toHaveLength(2);
      expect(doc.classes[0]).toMatchObject({ classIndex: 0, strategy: 'DIRECT', slicePct: 50, quadratic: false });
      expect(doc.classes[1]).toMatchObject({ strategy: 'ERC20_BAL', asset: TOKEN_ADDR });
      expect(doc.classes[1].hatIds).toEqual([BIG_HAT_ID]);
      expect(doc.classes[1].minBalance).toBe(ethers.utils.parseEther('1').toString());
    });

    it('degrades gracefully when the org has no HybridVoting module', async () => {
      resolveOrgModulesMock.mockResolvedValue(modules({ hybridVotingAddress: null }));

      await classesShowHandler.handler({ org: 'test-org' } as any);

      expect(createReadContractMock).not.toHaveBeenCalled();
      expect(errorMock).not.toHaveBeenCalled();
      expect(infoMock).toHaveBeenCalledTimes(1);
      expect(String(infoMock.mock.calls[0][0])).toMatch(/no HybridVoting/);
    });
  });

  // ────────────────────────────── propose ──────────────────────────────

  describe('propose', () => {
    const validClasses = [
      { strategy: 'DIRECT', slicePct: 60 },
      {
        strategy: 'ERC20_BAL',
        slicePct: 40,
        quadratic: true,
        minBalance: '1000000000000000000',
        asset: TOKEN_ADDR,
        hatIds: [BIG_HAT_ID, '42'],
      },
    ];

    it('wraps setClasses(ClassConfig[]) in a governance proposal — calldata decodes back field-by-field', async () => {
      const file = writeClassesFile(validClasses);

      await classesProposeHandler.handler({ org: 'test-org', file, duration: 60 } as any);

      expect(executeTxMock).toHaveBeenCalledTimes(1);
      const [, method, args] = executeTxMock.mock.calls[0];
      expect(method).toBe('createProposal');
      expect(args[3]).toBe(2); // numOptions: apply / keep

      const batches = args[4];
      expect(batches).toHaveLength(2);
      expect(batches[1]).toEqual([]); // option 1 = keep current, no calls
      expect(batches[0]).toHaveLength(1);

      const [target, value, calldata] = batches[0][0];
      expect(target).toBe(HYBRID_ADDR); // executor-gated setter, called on the voting contract via the Executor
      expect(ethers.BigNumber.from(value).isZero()).toBe(true);

      const decoded = setClassesIface.decodeFunctionData('setClasses', calldata);
      const newClasses = decoded.newClasses ?? decoded[0];
      expect(newClasses).toHaveLength(2);

      expect(newClasses[0].strategy).toBe(CLASS_STRATEGY.DIRECT);
      expect(newClasses[0].slicePct).toBe(60);
      expect(newClasses[0].quadratic).toBe(false);
      expect(newClasses[0].minBalance.isZero()).toBe(true);
      expect(newClasses[0].asset).toBe(ethers.constants.AddressZero);
      expect(newClasses[0].hatIds).toHaveLength(0);

      expect(newClasses[1].strategy).toBe(CLASS_STRATEGY.ERC20_BAL);
      expect(newClasses[1].slicePct).toBe(40);
      expect(newClasses[1].quadratic).toBe(true);
      expect(newClasses[1].minBalance.toString()).toBe('1000000000000000000');
      expect(newClasses[1].asset).toBe(TOKEN_ADDR);
      // >2^53 hat ID survives with exact precision.
      expect(newClasses[1].hatIds.map((h: any) => h.toString())).toEqual([BIG_HAT_ID, '42']);

      // Governance wrapping: the human confirm ran before the tx.
      expect(confirmWriteMock).toHaveBeenCalledTimes(1);
      expect(pinJsonMock).toHaveBeenCalledTimes(1);
    });

    it('rejects slices that do not sum to 100 before any pin or tx', async () => {
      const file = writeClassesFile([
        { strategy: 'DIRECT', slicePct: 60 },
        { strategy: 'DIRECT', slicePct: 30 },
      ]);

      await expect(
        classesProposeHandler.handler({ org: 'test-org', file, duration: 60 } as any)
      ).rejects.toThrow('process.exit(1)');

      expect(executeTxMock).not.toHaveBeenCalled();
      expect(pinJsonMock).not.toHaveBeenCalled();
      expect(String(errorMock.mock.calls[0][0])).toMatch(/sum to exactly 100 — got 90/);
    });

    it('rejects ERC20_BAL classes without an asset (contract would revert ZeroAddress)', async () => {
      const file = writeClassesFile([
        { strategy: 'ERC20_BAL', slicePct: 100 },
      ]);

      await expect(
        classesProposeHandler.handler({ org: 'test-org', file, duration: 60 } as any)
      ).rejects.toThrow('process.exit(1)');

      expect(executeTxMock).not.toHaveBeenCalled();
      expect(String(errorMock.mock.calls[0][0])).toMatch(/ERC20_BAL strategy requires a non-zero asset/);
    });

    it('errors when the org has no HybridVoting contract', async () => {
      getWriteContextMock.mockResolvedValue({
        orgId: ORG_ID,
        modules: modules({ hybridVotingAddress: null }),
        signer: {},
        provider: {},
        address: '0x' + 'aa'.repeat(20),
        chainId: 100,
        networkName: 'Gnosis',
      });
      const file = writeClassesFile(validClasses);

      await expect(
        classesProposeHandler.handler({ org: 'test-org', file, duration: 60 } as any)
      ).rejects.toThrow('process.exit(4)');

      expect(executeTxMock).not.toHaveBeenCalled();
      expect(String(errorMock.mock.calls[0][0])).toMatch(/HybridVoting not deployed/);
    });
  });

  // ─────────────────────── parseClassConfigs unit surface ───────────────────────

  describe('parseClassConfigs', () => {
    it('normalizes every accepted strategy spelling', () => {
      const parsed = parseClassConfigs([
        { strategy: 'DIRECT', slicePct: 25 },
        { strategy: 'ERC20_BAL', slicePct: 25, asset: TOKEN_ADDR },
        { strategy: 0, slicePct: 25 },
        { strategy: '1', slicePct: 25, asset: TOKEN_ADDR },
      ]);
      expect(parsed.map(c => c.strategy)).toEqual([0, 1, 0, 1]);
    });

    it('rejects unknown strategies, out-of-range slices, and >8 classes', () => {
      expect(() => parseClassConfigs([{ strategy: 'SQRT', slicePct: 100 }])).toThrow(/invalid strategy/);
      expect(() => parseClassConfigs([{ strategy: 'DIRECT', slicePct: 0 }])).toThrow(/slicePct/);
      expect(() => parseClassConfigs([{ strategy: 'DIRECT', slicePct: 101 }])).toThrow(/slicePct/);
      expect(() => parseClassConfigs([])).toThrow(/At least one/);
      expect(() => parseClassConfigs('nope' as any)).toThrow(/JSON array/);
      const nine = Array.from({ length: 9 }, () => ({ strategy: 'DIRECT', slicePct: 11 }));
      expect(() => parseClassConfigs(nine)).toThrow(/at most 8/);
    });

    it('parses hat IDs and minBalance as BigNumbers (no 2^53 precision loss)', () => {
      const [c] = parseClassConfigs([
        { strategy: 'ERC20_BAL', slicePct: 100, asset: TOKEN_ADDR, minBalance: BIG_HAT_ID, hatIds: [BIG_HAT_ID] },
      ]);
      expect(c.minBalance.toString()).toBe(BIG_HAT_ID);
      expect(c.hatIds[0].toString()).toBe(BIG_HAT_ID);
      expect(String(parseInt(BIG_HAT_ID, 10))).not.toBe(BIG_HAT_ID);
    });
  });
});
