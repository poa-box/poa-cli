/**
 * Transaction Execution Tests
 * Covers the dry-run result shape (new structured fields + legacy txHash
 * escape hatch), classifyError custom-error decoding, and the ERC-4337
 * inner-revert detection on sponsored transactions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';
import path from 'path';
import fs from 'fs';
import { executeTx, classifyError, detectUserOpFailure, resolveSponsoredConfig } from '../../src/lib/tx';
import { ERROR_MESSAGES } from '../../src/lib/error-catalog';

const ABI_DIR = path.join(__dirname, '..', '..', 'src', 'abi');
const taskManagerIface = new ethers.utils.Interface(
  JSON.parse(fs.readFileSync(path.join(ABI_DIR, 'TaskManagerNew.json'), 'utf-8'))
);

/** Minimal mock of what executeTx touches in dry-run mode. */
function makeMockContract() {
  return {
    address: '0x1111111111111111111111111111111111111111',
    interface: new ethers.utils.Interface(['function doThing()']),
    estimateGas: {
      doThing: async () => ethers.BigNumber.from(21000),
    },
  } as unknown as ethers.Contract;
}

describe('executeTx dry-run', () => {
  const savedLegacy = process.env.POP_LEGACY_DRYRUN_TXHASH;
  const savedSponsored = {
    POP_PRIVATE_KEY: process.env.POP_PRIVATE_KEY,
    POP_ORG_ID: process.env.POP_ORG_ID,
    POP_HAT_ID: process.env.POP_HAT_ID,
    PIMLICO_API_KEY: process.env.PIMLICO_API_KEY,
  };

  afterEach(() => {
    if (savedLegacy === undefined) {
      delete process.env.POP_LEGACY_DRYRUN_TXHASH;
    } else {
      process.env.POP_LEGACY_DRYRUN_TXHASH = savedLegacy;
    }
    for (const [key, value] of Object.entries(savedSponsored)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('returns the structured dry-run shape with no txHash by default', async () => {
    delete process.env.POP_LEGACY_DRYRUN_TXHASH;
    const contract = makeMockContract();
    const result = await executeTx(contract, 'doThing', [], { dryRun: true });

    const expectedCalldata = contract.interface.encodeFunctionData('doThing', []);
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.gasEstimate).toBe('21000');
    expect(result.calldata).toBe(expectedCalldata);
    expect(result.to).toBe('0x1111111111111111111111111111111111111111');
    expect(result.method).toBe('doThing');
    expect(result.txHash).toBeUndefined();
  });

  it('emits the legacy dry-run txHash when POP_LEGACY_DRYRUN_TXHASH=1', async () => {
    process.env.POP_LEGACY_DRYRUN_TXHASH = '1';
    const result = await executeTx(makeMockContract(), 'doThing', [], { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.txHash).toBeDefined();
    expect(result.txHash!.startsWith('dry-run:')).toBe(true);
  });

  it('returns a classified failure when gas estimation rejects', async () => {
    const contract = {
      address: '0x1111111111111111111111111111111111111111',
      interface: new ethers.utils.Interface(['function doThing()']),
      estimateGas: {
        doThing: async () => {
          const err: any = new Error('cannot estimate gas; transaction may fail');
          err.code = 'UNPREDICTABLE_GAS_LIMIT';
          throw err;
        },
      },
    } as unknown as ethers.Contract;

    const result = await executeTx(contract, 'doThing', [], { dryRun: true });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('GAS_ESTIMATION_FAILED');
  });
});

describe('classifyError custom-error decoding', () => {
  it('decodes revert data on the GAS_ESTIMATION_FAILED path', () => {
    const data = taskManagerIface.encodeErrorResult('InvalidDeadline', []);
    const error = {
      code: 'UNPREDICTABLE_GAS_LIMIT',
      message: 'cannot estimate gas; transaction may fail or may require manual gas limit',
      error: { data },
    };

    const classified = classifyError(error, taskManagerIface);
    expect(classified.code).toBe('GAS_ESTIMATION_FAILED');
    expect(classified.errorName).toBe('InvalidDeadline');
    expect(classified.message).toBe(ERROR_MESSAGES.InvalidDeadline.human);
    expect(classified.suggestion).toBe(ERROR_MESSAGES.InvalidDeadline.suggestion);
    expect(classified.rawMessage).toContain('Transaction would revert');
  });

  it('decodes revert data on the TX_REVERTED path', () => {
    const data = taskManagerIface.encodeErrorResult('InvalidDeadline', []);
    const error = {
      reason: 'execution reverted',
      message: 'execution reverted',
      error: { data },
    };

    const classified = classifyError(error, taskManagerIface);
    expect(classified.code).toBe('TX_REVERTED');
    expect(classified.errorName).toBe('InvalidDeadline');
    expect(classified.message).toBe(ERROR_MESSAGES.InvalidDeadline.human);
    expect(classified.suggestion).toBe(ERROR_MESSAGES.InvalidDeadline.suggestion);
  });

  it('keeps the original message for unknown selectors but exposes errorName', () => {
    const error = {
      reason: 'execution reverted',
      message: 'execution reverted',
      error: { data: '0xdeadbeef' + '00'.repeat(32) },
    };

    const classified = classifyError(error, taskManagerIface);
    expect(classified.code).toBe('TX_REVERTED');
    expect(classified.errorName).toBe('UnknownCustomError(0xdeadbeef)');
    expect(classified.message).toBe('Reverted: execution reverted');
  });

  it('classifies non-revert errors without decoding', () => {
    expect(classifyError({ code: 'INSUFFICIENT_FUNDS', message: 'insufficient funds' }).code).toBe(
      'INSUFFICIENT_FUNDS'
    );
    expect(classifyError({ message: 'ECONNREFUSED 127.0.0.1' }).code).toBe('NETWORK_ERROR');
    expect(classifyError({ message: 'something odd' }).code).toBe('UNKNOWN_ERROR');
  });
});

describe('detectUserOpFailure (ERC-4337 inner revert)', () => {
  const entryPointEvents = new ethers.utils.Interface([
    'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
    'event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)',
  ]);

  const userOpHash = ethers.utils.hexZeroPad('0xabc123', 32);
  const sender = '0x2222222222222222222222222222222222222222';
  const paymaster = '0x3333333333333333333333333333333333333333';
  const TX_HASH = '0x' + 'aa'.repeat(32);
  const CHAIN_ID = 100;

  function userOpEventLog(success: boolean) {
    return entryPointEvents.encodeEventLog(
      entryPointEvents.getEvent('UserOperationEvent'),
      [userOpHash, sender, paymaster, 1, success, 1000, 21000]
    );
  }

  function revertReasonLog(revertReason: string) {
    return entryPointEvents.encodeEventLog(
      entryPointEvents.getEvent('UserOperationRevertReason'),
      [userOpHash, sender, 1, revertReason]
    );
  }

  it('returns null when the inner UserOp succeeded', () => {
    const receipt: any = { logs: [userOpEventLog(true)] };
    expect(detectUserOpFailure(receipt, TX_HASH, CHAIN_ID, taskManagerIface)).toBeNull();
  });

  it('returns null when no UserOperationEvent is present (not a 4337 tx)', () => {
    const receipt: any = { logs: [] };
    expect(detectUserOpFailure(receipt, TX_HASH, CHAIN_ID, taskManagerIface)).toBeNull();
  });

  it('decodes the inner revert reason through the error catalog', () => {
    const revertData = taskManagerIface.encodeErrorResult('BadStatus', []);
    const receipt: any = { logs: [userOpEventLog(false), revertReasonLog(revertData)] };

    const result = detectUserOpFailure(receipt, TX_HASH, CHAIN_ID, taskManagerIface);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.errorCode).toBe('TX_REVERTED');
    expect(result!.sponsored).toBe(true);
    expect(result!.txHash).toBe(TX_HASH);
    expect(result!.errorName).toBe('BadStatus');
    expect(result!.error).toContain(ERROR_MESSAGES.BadStatus.human);
    expect(result!.suggestion).toBe(ERROR_MESSAGES.BadStatus.suggestion);
  });

  it('unwraps Error(string) inner revert reasons', () => {
    const revertData =
      '0x08c379a0' +
      ethers.utils.defaultAbiCoder.encode(['string'], ['deadline passed']).slice(2);
    const receipt: any = { logs: [userOpEventLog(false), revertReasonLog(revertData)] };

    const result = detectUserOpFailure(receipt, TX_HASH, CHAIN_ID, taskManagerIface);
    expect(result).not.toBeNull();
    expect(result!.error).toContain('Reverted: deadline passed');
    expect(result!.errorName).toBeUndefined();
  });

  it('falls back to a generic message when the inner revert carries no reason log', () => {
    const receipt: any = { logs: [userOpEventLog(false)] };

    const result = detectUserOpFailure(receipt, TX_HASH, CHAIN_ID, taskManagerIface);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.error).toContain('inner call reverted');
  });
});

describe('executeTx failure propagates decoded custom errors', () => {
  const saved = {
    POP_PRIVATE_KEY: process.env.POP_PRIVATE_KEY,
    POP_ORG_ID: process.env.POP_ORG_ID,
    POP_HAT_ID: process.env.POP_HAT_ID,
    PIMLICO_API_KEY: process.env.PIMLICO_API_KEY,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('surfaces errorName + suggestion when gas estimation reverts with a known custom error', async () => {
    // No sponsored config so the direct path runs; estimateGas rejects first.
    delete process.env.POP_PRIVATE_KEY;
    delete process.env.PIMLICO_API_KEY;

    const data = taskManagerIface.encodeErrorResult('BadStatus', []);
    const contract = {
      address: '0x2222222222222222222222222222222222222222',
      interface: taskManagerIface,
      estimateGas: {
        doThing: async () => {
          throw {
            code: 'UNPREDICTABLE_GAS_LIMIT',
            message: 'cannot estimate gas; transaction may fail or may require manual gas limit',
            error: { data },
          };
        },
      },
    } as unknown as ethers.Contract;

    const result = await executeTx(contract, 'doThing', []);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('GAS_ESTIMATION_FAILED');
    expect(result.errorName).toBe('BadStatus');
    expect(result.error).toBe(ERROR_MESSAGES.BadStatus.human);
    expect(result.suggestion).toBe(ERROR_MESSAGES.BadStatus.suggestion);
    expect(result.rawMessage).toContain('Transaction would revert');
  });
});

describe('resolveSponsoredConfig bundler resolution', () => {
  const KEYS = ['POP_PRIVATE_KEY', 'POP_ORG_ID', 'POP_HAT_ID', 'PIMLICO_API_KEY', 'POP_BUNDLER_URL'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.POP_PRIVATE_KEY = '0x' + '1'.repeat(64);
    process.env.POP_ORG_ID = '0x' + 'ab'.repeat(32);
    process.env.POP_HAT_ID = '1';
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it('resolves with a self-hosted bundler URL and no Pimlico key', () => {
    process.env.POP_BUNDLER_URL = 'http://localhost:14337/rpc';
    const cfg = resolveSponsoredConfig();
    expect(cfg).toBeDefined();
    expect(cfg!.orgId).toBe(process.env.POP_ORG_ID);
  });

  it('resolves with a Pimlico key and no bundler URL', () => {
    process.env.PIMLICO_API_KEY = 'pim_test';
    expect(resolveSponsoredConfig()).toBeDefined();
  });

  it('returns undefined when neither a bundler URL nor a Pimlico key is set', () => {
    expect(resolveSponsoredConfig()).toBeUndefined();
  });

  it('returns undefined when org/hat context is missing even with a bundler', () => {
    delete process.env.POP_ORG_ID;
    process.env.POP_BUNDLER_URL = 'http://localhost:14337/rpc';
    expect(resolveSponsoredConfig()).toBeUndefined();
  });
});
