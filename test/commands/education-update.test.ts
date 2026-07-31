/**
 * pop education update — read-then-merge for the full-overwrite
 * EducationHub.updateModule(id, newTitle, newContentHash, newPayout)
 * (VERIFIED contracts origin/main src/EducationHub.sol).
 *
 * The command must:
 *  - read current payout from the CHAIN (getModule) and current
 *    title/metadata from the subgraph (IPFS fallback),
 *  - merge only the flags the caller passed,
 *  - a payout-only edit keeps the existing contentHash — NO re-pin,
 *  - a name/description change re-pins with the exact create-module JSON
 *    key order {name, description, link, quiz, answers},
 *  - refuse cleanly when the merge sources are missing (module unknown
 *    on-chain → exit 4; metadata not indexed yet → exit 3).
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
  runPreflight: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/signer', () => ({ createSigner: mocks.createSigner }));
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgModules: mocks.resolveOrgModules,
  requireModule: (modules: any, key: string) => {
    if (!modules?.[key]) throw new Error(`missing module ${key}`);
    return modules[key];
  },
}));
vi.mock('../../src/lib/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/contracts')>();
  return { ...actual, createReadContract: mocks.createReadContract };
});
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
vi.mock('../../src/lib/ipfs', () => ({ pinJson: mocks.pinJson, fetchJson: mocks.fetchJson }));
vi.mock('../../src/lib/preflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/preflight')>();
  return { ...actual, runPreflight: mocks.runPreflight };
});
vi.mock('../../src/lib/idempotency', () => ({
  argvToIdempotencyString: vi.fn(() => 'idem-key'),
  checkIdempotencyCache: vi.fn(() => null),
  recordIdempotentResult: vi.fn(),
  resolveTtlSeconds: vi.fn(() => 900),
}));
vi.mock('../../src/lib/prompt', () => ({
  isInteractive: () => false,
  confirm: vi.fn(),
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
import { updateModuleHandler } from '../../src/commands/education/update';
import { createModuleHandler } from '../../src/commands/education/create-module';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { bytes32ToIpfsCid, ipfsCidToBytes32 } from '../../src/lib/encoding';
import { EXIT } from '../../src/lib/exit-codes';
import * as output from '../../src/lib/output';

const HUB_ADDR = '0x7777777777777777777777777777777777777777';
const WALLET = '0x2222222222222222222222222222222222222222';
const ORG_ID = '0x' + 'ab'.repeat(32);

const CURRENT_HASH = '0x' + 'ab'.repeat(32); // current on-chain contentHash
const CURRENT_CID = bytes32ToIpfsCid(CURRENT_HASH)!; // its CIDv0 form
const NEW_HASH = '0x' + 'cd'.repeat(32);
const NEW_CID = bytes32ToIpfsCid(NEW_HASH)!; // what pinJson returns on re-pin

const CHAIN_PAYOUT = ethers.utils.parseUnits('7', 18); // chain is authoritative

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

function subgraphModuleFixture(overrides: Record<string, any> = {}) {
  return {
    id: `${HUB_ADDR}-2`,
    moduleId: '2',
    title: 'Intro',
    contentHash: CURRENT_HASH,
    payout: ethers.utils.parseUnits('5', 18).toString(), // stale vs chain — must lose
    metadata: {
      description: 'Old desc',
      link: 'https://old.example',
      quiz: ['Q1?'],
      answersJson: '[["A","B"]]',
    },
    ...overrides,
  };
}

function installSubgraph(modules: any[]) {
  mocks.query.mockResolvedValue({
    organization: { id: ORG_ID, educationHub: { id: HUB_ADDR, modules } },
  });
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    module: '2',
    yes: false,
    preflight: true,
    dryRun: false,
    ...overrides,
  };
}

describe('pop education update — read-then-merge', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _clearWriteContextCacheForTest();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);

    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      provider: {},
      address: WALLET,
      chainId: 11155111,
    });
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: ORG_ID,
      educationHubAddress: HUB_ADDR,
    });
    mocks.createReadContract.mockImplementation((_addr: string, abiName: string) => {
      if (abiName === 'EducationHubNew') {
        return { getModule: async () => [CHAIN_PAYOUT, true] };
      }
      throw new Error(`unexpected read contract: ${abiName}`);
    });
    installSubgraph([subgraphModuleFixture()]);
    // IPFS mirrors what create-module pinned (create-module key order)
    mocks.fetchJson.mockResolvedValue({
      name: 'Intro',
      description: 'Old desc',
      link: 'https://old.example',
      quiz: ['Q1?'],
      answers: [['A', 'B']],
    });
    mocks.pinJson.mockResolvedValue(NEW_CID);
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xabc',
      explorerUrl: 'https://explorer/tx/0xabc',
      logs: [],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('payout-only edit: NO re-pin — the current contentHash and title ride through unchanged', async () => {
    await updateModuleHandler.handler(baseArgv({ payout: 10 }));

    expect(mocks.pinJson).not.toHaveBeenCalled();

    expect(mocks.executeTx).toHaveBeenCalledTimes(1);
    const [contract, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('updateModule');
    expect(contract.address).toBe(HUB_ADDR);
    // Real EducationHubNew ABI carries the 4-arg overwrite
    expect(() => contract.interface.getFunction('updateModule')).not.toThrow();

    const [id, titleBytes, contentHash, payout] = args;
    expect(id).toBe('2');
    expect(ethers.utils.toUtf8String(titleBytes)).toBe('Intro'); // preserved title
    expect(contentHash).toBe(CURRENT_HASH); // preserved hash — the merge core
    expect(payout.eq(ethers.utils.parseUnits('10', 18))).toBe(true);

    expect(output.success).toHaveBeenCalledWith('Module 2 updated', expect.objectContaining({
      moduleId: '2',
      title: 'Intro',
      txHash: '0xabc',
    }));
    // The current CID was resolvable, so the IPFS read used it
    expect(mocks.fetchJson).toHaveBeenCalledWith(CURRENT_CID);
  });

  it('name change: re-pins with create-module key order, preserves unspecified fields AND the on-chain payout', async () => {
    await updateModuleHandler.handler(baseArgv({ name: 'Intro v2' }));

    // Re-pinned JSON: exact create-module key order, only name overridden
    expect(mocks.pinJson).toHaveBeenCalledTimes(1);
    expect(mocks.pinJson.mock.calls[0][0]).toBe(JSON.stringify({
      name: 'Intro v2',
      description: 'Old desc',
      link: 'https://old.example',
      quiz: ['Q1?'],
      answers: [['A', 'B']],
    }));

    const args = mocks.executeTx.mock.calls[0][2];
    const [id, titleBytes, contentHash, payout] = args;
    expect(id).toBe('2');
    expect(ethers.utils.toUtf8String(titleBytes)).toBe('Intro v2');
    expect(contentHash).toBe(ipfsCidToBytes32(NEW_CID)); // the NEW pin
    expect(contentHash).not.toBe(CURRENT_HASH);
    // payout came from getModule (7), not the stale subgraph copy (5)
    expect(payout.eq(CHAIN_PAYOUT)).toBe(true);
  });

  it('description-only change with IPFS down: merges from the subgraph metadata entity instead', async () => {
    mocks.fetchJson.mockResolvedValue(null); // gateway lag
    await updateModuleHandler.handler(baseArgv({ description: 'New desc' }));

    expect(mocks.pinJson).toHaveBeenCalledTimes(1);
    expect(mocks.pinJson.mock.calls[0][0]).toBe(JSON.stringify({
      name: 'Intro', // subgraph title
      description: 'New desc',
      link: 'https://old.example',
      quiz: ['Q1?'],
      answers: [['A', 'B']], // parsed from answersJson
    }));
  });

  it('metadata flags equal to current values: no content change → no re-pin, hash preserved', async () => {
    await updateModuleHandler.handler(baseArgv({ name: 'Intro', description: 'Old desc' }));

    expect(mocks.pinJson).not.toHaveBeenCalled();
    const [, , args] = mocks.executeTx.mock.calls[0];
    expect(args[2]).toBe(CURRENT_HASH);
  });

  it('no field flags at all: exit EXIT.USAGE before any network work', async () => {
    await expect(updateModuleHandler.handler(baseArgv())).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(mocks.resolveOrgModules).not.toHaveBeenCalled();
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  it('module unknown on-chain (getModule reverts ModuleUnknown): exit EXIT.PRECONDITION (4), nothing sent', async () => {
    mocks.createReadContract.mockImplementation(() => ({
      getModule: async () => {
        throw new Error('call revert exception: ModuleUnknown');
      },
    }));

    await expect(updateModuleHandler.handler(baseArgv({ payout: 10 }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('may not exist'),
      expect.anything(),
    );
  });

  it('payout-only edit with unindexed metadata: refuses (exit 3) instead of overwriting title/hash with defaults', async () => {
    installSubgraph([]); // subgraph has not seen the module yet

    await expect(updateModuleHandler.handler(baseArgv({ payout: 10 }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.INFRA);
    expect(mocks.executeTx).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      expect.stringContaining('not indexed yet'),
      expect.objectContaining({ suggestion: expect.stringContaining('--name') }),
    );
  });

  it('zero/negative payout: exit EXIT.USAGE (contract reverts InvalidPayout for 0)', async () => {
    await expect(updateModuleHandler.handler(baseArgv({ payout: 0 }))).rejects.toBeInstanceOf(ExitError);
    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.USAGE);
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });

  /**
   * EducationModule.payout IS indexed and populated on live Gnosis, so serving `currentPayout`
   * from the subgraph looks free. It is not: updateModule is a FULL OVERWRITE, so a payout the
   * subgraph has not caught up with would be written straight back, silently reverting whoever
   * raised it. The on-chain read stays — it is also the ModuleUnknown existence gate — but the
   * two reads no longer wait on each other.
   */
  it('the on-chain payout read and the subgraph read are issued concurrently', async () => {
    let queryIssuedBeforeGetModuleResolved = false;
    let releaseGetModule: () => void = () => {};
    const getModuleGate = new Promise<void>((resolve) => { releaseGetModule = resolve; });

    mocks.createReadContract.mockImplementation((_addr: string, abiName: string) => {
      if (abiName === 'EducationHubNew') {
        return {
          getModule: async () => {
            await getModuleGate;
            return [CHAIN_PAYOUT, true];
          },
        };
      }
      throw new Error(`unexpected read contract: ${abiName}`);
    });
    mocks.query.mockImplementation(async () => {
      // Reached while getModule is still pending → the two were started together.
      queryIssuedBeforeGetModuleResolved = true;
      releaseGetModule();
      return { organization: { id: ORG_ID, educationHub: { id: HUB_ADDR, modules: [subgraphModuleFixture()] } } };
    });

    await updateModuleHandler.handler(baseArgv({ payout: 10 }));

    expect(queryIssuedBeforeGetModuleResolved).toBe(true);
  });

  it('a subgraph outage no longer masks the on-chain ModuleUnknown gate', async () => {
    mocks.query.mockRejectedValue(new Error('502 bad gateway'));
    mocks.createReadContract.mockImplementation(() => ({
      getModule: async () => { throw new Error('call revert exception'); },
    }));

    await expect(updateModuleHandler.handler(baseArgv({ payout: 10 }))).rejects.toBeInstanceOf(ExitError);

    expect(exitSpy.mock.calls[0][0]).toBe(EXIT.PRECONDITION);
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });
});

describe('pop education create — metadata pin parity', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _clearWriteContextCacheForTest();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);
    mocks.createSigner.mockReturnValue({
      signer: new ethers.VoidSigner(WALLET),
      provider: {},
      address: WALLET,
      chainId: 11155111,
    });
    mocks.resolveOrgModules.mockResolvedValue({ orgId: ORG_ID, educationHubAddress: HUB_ADDR });
    mocks.runPreflight.mockResolvedValue(undefined);
    mocks.pinJson.mockResolvedValue(NEW_CID);
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xabc',
      explorerUrl: 'https://explorer/tx/0xabc',
      logs: [{ name: 'ModuleCreated', args: { id: ethers.BigNumber.from(3) } }],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('pins {name, description, link, quiz, answers} — the exact key order education update preserves — and sends createModule', async () => {
    await createModuleHandler.handler({
      _: [], $0: 'pop', org: 'testorg',
      name: 'Intro', description: 'Old desc', link: 'https://old.example',
      quiz: '["Q1?"]', answers: '[["A","B"]]',
      payout: 5, correctAnswer: 1, 'correct-answer': 1,
      yes: false, preflight: true, dryRun: false,
    } as any);

    expect(mocks.pinJson).toHaveBeenCalledTimes(1);
    expect(mocks.pinJson.mock.calls[0][0]).toBe(JSON.stringify({
      name: 'Intro',
      description: 'Old desc',
      link: 'https://old.example',
      quiz: ['Q1?'],
      answers: [['A', 'B']],
    }));

    const [contract, method, args] = mocks.executeTx.mock.calls[0];
    expect(method).toBe('createModule');
    expect(() => contract.interface.getFunction('createModule')).not.toThrow();
    const [titleBytes, contentHash, payoutWei, correctAnswer] = args;
    expect(ethers.utils.toUtf8String(titleBytes)).toBe('Intro');
    expect(contentHash).toBe(ipfsCidToBytes32(NEW_CID));
    expect(payoutWei.eq(ethers.utils.parseUnits('5', 18))).toBe(true);
    expect(correctAnswer).toBe(1);

    // ModuleCreated id surfaces in the receipt
    expect(output.success).toHaveBeenCalledWith(
      'Education module #3 created',
      expect.objectContaining({ moduleId: '3', txHash: '0xabc' }),
    );
  });
});
