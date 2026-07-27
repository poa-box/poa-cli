/**
 * pop task perms — bitmask wiring against the verified v6 contract surface.
 *
 *  - set: parsePermList('create,claim') → mask 3 inside the
 *    setProjectRolePerm(bytes32,uint256,uint8) calldata (direct tx —
 *    creator-hat/executor gated on-chain).
 *  - propose-global: builds a governance proposal whose option-0 execution
 *    batch targets the TaskManager with setConfig(ROLE_PERM=2,
 *    abi.encode(uint256 hatId, uint8 mask)). ConfigKey enum verified against
 *    contracts origin/main src/TaskManager.sol (EXECUTOR=0,
 *    CREATOR_HAT_ALLOWED=1, ROLE_PERM=2, ...).
 *  - show: renders formatMask() output from subgraph GlobalRolePermission
 *    fixtures, corroborated by lens hat arrays.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeTx: vi.fn(),
  pinJson: vi.fn(),
  createSigner: vi.fn(),
  resolveOrgModules: vi.fn(),
  queryWithFieldFallback: vi.fn(),
  getOrganizerHats: vi.fn(),
  getPermissionHats: vi.fn(),
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
vi.mock('../../src/lib/subgraph', () => ({
  queryWithFieldFallback: mocks.queryWithFieldFallback,
}));
vi.mock('../../src/lib/task-lens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/task-lens')>();
  return {
    ...actual,
    getOrganizerHats: mocks.getOrganizerHats,
    getPermissionHats: mocks.getPermissionHats,
  };
});
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
    table: vi.fn(),
    keyValueBlock: vi.fn(),
    isJsonMode: vi.fn(() => false),
    isQuietMode: vi.fn(() => false),
    subgraphLagWarning: vi.fn(),
  };
});

import { ethers } from 'ethers';
import {
  permsShowHandler,
  permsSetHandler,
  permsProposeGlobalHandler,
  CONFIG_KEY_ROLE_PERM,
} from '../../src/commands/task/perms';
import { _clearWriteContextCacheForTest } from '../../src/lib/command';
import { formatMask } from '../../src/lib/perms';
import * as output from '../../src/lib/output';

const TM_ADDR = '0x1111111111111111111111111111111111111111';
const VOTING_ADDR = '0x4444444444444444444444444444444444444444';
const WALLET = '0x2222222222222222222222222222222222222222';
const ORG_ID = '0x' + 'ab'.repeat(32);
const PID = '0x' + '22'.repeat(32);
const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

const setConfigIface = new ethers.utils.Interface(['function setConfig(uint8 key, bytes value)']);

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit:${exitCode}`);
  }
}

function permsSubgraphFixture() {
  return {
    data: {
      organization: {
        id: ORG_ID,
        taskManager: {
          id: TM_ADDR.toLowerCase(),
          creatorHatIds: ['1'],
          organizerHatIds: ['5'],
          globalRolePermissions: [
            { hatId: '123', mask: 3 },
            { hatId: '456', mask: 196 }, // review(4) + edit-meta(64) + edit-full(128)
          ],
          projects: [{
            id: `${TM_ADDR}-${PID}`,
            title: 'Protocol Work',
            rolePermissions: [{ hatId: '123', mask: 15 }],
          }],
        },
      },
    },
    tierIndex: 0,
  };
}

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    _: [],
    $0: 'pop',
    org: 'testorg',
    chain: 11155111,
    preflight: false,
    dryRun: false,
    ...overrides,
  };
}

describe('pop task perms', () => {
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
      taskManagerAddress: TM_ADDR,
      hybridVotingAddress: VOTING_ADDR,
    });
    mocks.queryWithFieldFallback.mockResolvedValue(permsSubgraphFixture());
    mocks.getOrganizerHats.mockResolvedValue([ethers.BigNumber.from(5)]);
    mocks.getPermissionHats.mockResolvedValue([ethers.BigNumber.from(123), ethers.BigNumber.from(456)]);
    mocks.pinJson.mockResolvedValue(CID);
    mocks.executeTx.mockResolvedValue({
      success: true,
      txHash: '0xhash',
      explorerUrl: 'https://explorer/tx/0xhash',
      logs: [],
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  describe('set', () => {
    it('parsePermList is wired: "create,claim" → mask 3 in setProjectRolePerm calldata', async () => {
      await permsSetHandler.handler(baseArgv({ project: PID, hat: '123', perms: 'create,claim' }));

      expect(mocks.executeTx).toHaveBeenCalledTimes(1);
      const [contract, method, args, opts] = mocks.executeTx.mock.calls[0];
      expect(method).toBe('setProjectRolePerm');
      expect(args[0]).toBe(PID);
      expect(args[1].toString()).toBe('123');
      expect(args[2]).toBe(3);
      expect(opts).toEqual({ dryRun: false });

      // Round-trip through the REAL TaskManagerNew ABI: the mask survives in calldata.
      const calldata = contract.interface.encodeFunctionData(method, args);
      const decoded = contract.interface.decodeFunctionData('setProjectRolePerm', calldata);
      expect(decoded.pid ?? decoded[0]).toBe(PID);
      expect((decoded.hatId ?? decoded[1]).toString()).toBe('123');
      expect(Number(decoded.mask ?? decoded[2])).toBe(3);

      expect(output.success).toHaveBeenCalledWith(
        expect.stringContaining('create,claim'),
        expect.objectContaining({ mask: 3, txHash: '0xhash' })
      );
    });

    it('"none" → mask 0 (removes the project override)', async () => {
      await permsSetHandler.handler(baseArgv({ project: PID, hat: '123', perms: 'none' }));
      const [, , args] = mocks.executeTx.mock.calls[0];
      expect(args[2]).toBe(0);
    });

    it('unknown permission name fails with usage error before any tx', async () => {
      await expect(
        permsSetHandler.handler(baseArgv({ project: PID, hat: '123', perms: 'create,fly' }))
      ).rejects.toBeInstanceOf(ExitError);

      expect(output.error).toHaveBeenCalledWith(
        expect.stringContaining('Unknown permission "fly"'),
        expect.anything()
      );
      expect(mocks.executeTx).not.toHaveBeenCalled();
    });

    it('resolves a project by name via the subgraph before sending', async () => {
      await permsSetHandler.handler(baseArgv({ project: 'Protocol Work', hat: '9', perms: 'review' }));

      const [, , args] = mocks.executeTx.mock.calls[0];
      expect(args[0]).toBe(PID); // parsed out of the composite subgraph ID
      expect(args[2]).toBe(4);
    });
  });

  describe('propose-global', () => {
    it('wraps setConfig(ROLE_PERM=2, abi.encode(hatId, mask)) in the option-0 execution batch', async () => {
      mocks.executeTx.mockResolvedValue({
        success: true,
        txHash: '0xhash',
        explorerUrl: 'https://explorer/tx/0xhash',
        logs: [{ name: 'NewProposal', args: { id: ethers.BigNumber.from(9) } }],
      });

      await permsProposeGlobalHandler.handler(
        baseArgv({ hat: '123', perms: 'create,claim,review', duration: 60 })
      );

      expect(mocks.executeTx).toHaveBeenCalledTimes(1);
      const [contract, method, args] = mocks.executeTx.mock.calls[0];
      expect(method).toBe('createProposal');
      // createProposal(title, descriptionHash, duration, numOptions, batches, hatIds)
      expect(args[2]).toBe(60);
      expect(args[3]).toBe(2);
      expect(args[5]).toEqual([]);

      const batches = args[4];
      expect(batches).toHaveLength(2);
      expect(batches[1]).toEqual([]); // option 1 = keep current
      expect(batches[0]).toHaveLength(1);

      const [target, value, calldata] = batches[0][0];
      expect(target).toBe(TM_ADDR); // execution targets the TaskManager
      expect(ethers.BigNumber.from(value).isZero()).toBe(true);

      // Decode and assert the exact executor call the vote would perform.
      const decoded = setConfigIface.decodeFunctionData('setConfig', calldata);
      expect(decoded.key).toBe(CONFIG_KEY_ROLE_PERM);
      expect(decoded.key).toBe(2); // ROLE_PERM — verified enum index
      const [hatId, mask] = ethers.utils.defaultAbiCoder.decode(['uint256', 'uint8'], decoded.value);
      expect(hatId.toString()).toBe('123');
      expect(mask).toBe(7); // create|claim|review

      // Proposal goes to the voting contract, not the TaskManager.
      expect(contract.address).toBe(VOTING_ADDR);

      expect(mocks.pinJson).toHaveBeenCalledTimes(1);
      const pinned = JSON.parse(mocks.pinJson.mock.calls[0][0]);
      expect(pinned.optionNames).toHaveLength(2);
      expect(pinned.description).toContain('setConfig(ROLE_PERM)');

      expect(output.success).toHaveBeenCalledWith(
        'Proposal #9 created — needs a vote to take effect',
        expect.objectContaining({ proposalId: '9', mask: 7, permissions: formatMask(7) })
      );
    });

    it('org without HybridVoting: precondition error before pin/tx', async () => {
      mocks.resolveOrgModules.mockResolvedValue({
        orgId: ORG_ID,
        taskManagerAddress: TM_ADDR,
        hybridVotingAddress: null,
      });

      await expect(
        permsProposeGlobalHandler.handler(baseArgv({ hat: '123', perms: 'create' }))
      ).rejects.toBeInstanceOf(ExitError);

      expect(output.error).toHaveBeenCalledWith(
        expect.stringContaining('HybridVoting not deployed'),
        expect.anything()
      );
      expect(mocks.executeTx).not.toHaveBeenCalled();
      expect(mocks.pinJson).not.toHaveBeenCalled();
    });
  });

  describe('show', () => {
    it('renders formatMask output for global masks and the lens corroboration block', async () => {
      await permsShowHandler.handler(baseArgv());

      expect(mocks.queryWithFieldFallback).toHaveBeenCalledTimes(1);
      expect(output.table).toHaveBeenCalledWith(
        ['Hat ID', 'Mask', 'Permissions'],
        [
          ['123', '3', formatMask(3)], // 'create,claim'
          ['456', '196', formatMask(196)], // 'review,edit-meta,edit-full'
        ]
      );
      expect(formatMask(3)).toBe('create,claim');

      expect(output.keyValueBlock).toHaveBeenCalledWith(
        'On-chain corroboration (lens)',
        expect.objectContaining({
          'creator hats': '1',
          'organizer hats': '5',
          'permission hats': '123, 456',
        })
      );
    });

    it('--project adds the per-project override table', async () => {
      await permsShowHandler.handler(baseArgv({ project: 'Protocol Work' }));

      expect(output.table).toHaveBeenCalledTimes(2);
      expect(output.table).toHaveBeenLastCalledWith(
        ['Hat ID', 'Mask', 'Permissions'],
        [['123', '15', formatMask(15)]] // create,claim,review,assign
      );
    });

    it('--json emits a structured payload with formatted permissions', async () => {
      (output.isJsonMode as any).mockReturnValueOnce(true);

      await permsShowHandler.handler(baseArgv());

      expect(output.json).toHaveBeenCalledWith(expect.objectContaining({
        taskManager: TM_ADDR,
        global: expect.arrayContaining([
          expect.objectContaining({ hatId: '123', mask: 3, permissions: 'create,claim' }),
        ]),
        organizerHatIds: ['5'],
        permissionHatIds: ['123', '456'],
      }));
      expect(output.table).not.toHaveBeenCalled();
    });
  });
});
