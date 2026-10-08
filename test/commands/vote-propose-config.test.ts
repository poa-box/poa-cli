/**
 * P0 regression tests for `pop vote propose-config` ConfigKey mapping.
 *
 * Prior to the v6 sync, '--key quorum' mapped to ConfigKey 0 on BOTH voting
 * contracts — but key 0 is THRESHOLD on both, so a "set quorum" proposal
 * silently changed the support threshold instead. Verified enums from
 * contracts origin/main:
 *
 *   HybridVoting:          THRESHOLD=0, TARGET_ALLOWED=1 (deprecated no-op),
 *                          EXECUTOR=2, QUORUM=3
 *   DirectDemocracyVoting: THRESHOLD=0, EXECUTOR=1, TARGET_ALLOWED=2,
 *                          HAT_ALLOWED=3, QUORUM=4
 *
 * These tests decode the setConfig(uint8,bytes) calldata embedded in the
 * option-0 execution batch that the handler passes to executeTx and assert
 * the enum key + value encoding per contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';

const { executeTxMock, pinJsonMock, resolveVotingContractsMock, infoMock, errorMock } = vi.hoisted(() => ({
  executeTxMock: vi.fn(),
  pinJsonMock: vi.fn(),
  resolveVotingContractsMock: vi.fn(),
  infoMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({
  executeTx: executeTxMock,
}));

vi.mock('../../src/lib/ipfs', () => ({
  pinJson: pinJsonMock,
}));

vi.mock('../../src/commands/vote/helpers', () => ({
  resolveVotingContracts: resolveVotingContractsMock,
}));

vi.mock('../../src/lib/signer', () => ({
  createSigner: vi.fn(() => ({ signer: {} })),
}));

vi.mock('../../src/lib/contracts', () => ({
  createWriteContract: vi.fn(() => ({ address: '0xC0FFEE' })),
}));

// Post-migration plumbing: propose-config now renders via finishWrite and
// wraps the submit in withIdempotency (lib/command). The mocks pass straight
// through so the ConfigKey calldata assertions below stay byte-identical.
vi.mock('../../src/lib/resolve', () => ({
  resolveOrgId: vi.fn(async () => '0x' + '11'.repeat(32)),
}));

vi.mock('../../src/lib/command', () => ({
  finishWrite: vi.fn(),
  withIdempotency: vi.fn(async (_argv: any, _orgId: any, _cmd: any, run: any) => { await run(); }),
}));

vi.mock('../../src/lib/output', () => ({
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), text: '' })),
  success: vi.fn(),
  error: errorMock,
  info: infoMock,
  warn: vi.fn(),
}));

import { proposeConfigHandler } from '../../src/commands/vote/propose-config';

const HYBRID_ADDR = '0x1111111111111111111111111111111111111111';
const DD_ADDR = '0x2222222222222222222222222222222222222222';
const EXECUTOR_ADDR = '0x3333333333333333333333333333333333333333';

const setConfigIface = new ethers.utils.Interface(['function setConfig(uint8 key, bytes value)']);

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    org: 'test-org',
    duration: 60,
    ...overrides,
  };
}

/** Extract the option-0 batch [[target, value, calldata], ...] from the executeTx call. */
function capturedBatch(): any[] {
  expect(executeTxMock).toHaveBeenCalledTimes(1);
  const [, method, args] = executeTxMock.mock.calls[0];
  expect(method).toBe('createProposal');
  const batches = args[4];
  expect(batches).toHaveLength(2);
  expect(batches[1]).toEqual([]); // option 1 = keep current, no calls
  return batches[0];
}

function decodeSetConfig(calldata: string): { key: number; value: string } {
  const decoded = setConfigIface.decodeFunctionData('setConfig', calldata);
  return { key: decoded.key, value: decoded.value };
}

describe('vote propose-config — v6 ConfigKey mapping', () => {
  let exitSpy: any;

  beforeEach(() => {
    executeTxMock.mockReset();
    pinJsonMock.mockReset();
    resolveVotingContractsMock.mockReset();
    infoMock.mockReset();
    errorMock.mockReset();

    pinJsonMock.mockResolvedValue('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
    executeTxMock.mockResolvedValue({
      success: true,
      txHash: '0xabc',
      explorerUrl: 'https://example.com/tx/0xabc',
      logs: [],
    });
    resolveVotingContractsMock.mockResolvedValue({
      orgId: '0x' + '11'.repeat(32),
      hybridVotingAddress: HYBRID_ADDR,
      ddVotingAddress: DD_ADDR,
    });

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('threshold → key 0 on Hybrid and key 0 on DD, uint8-encoded', async () => {
    await proposeConfigHandler.handler(baseArgv({ key: 'threshold', value: '60' }));

    const batch = capturedBatch();
    expect(batch).toHaveLength(2);

    const [hybridTarget, , hybridData] = batch[0];
    const [ddTarget, , ddData] = batch[1];
    expect(hybridTarget).toBe(HYBRID_ADDR);
    expect(ddTarget).toBe(DD_ADDR);

    const hybrid = decodeSetConfig(hybridData);
    const dd = decodeSetConfig(ddData);
    expect(hybrid.key).toBe(0); // THRESHOLD on Hybrid
    expect(dd.key).toBe(0); // THRESHOLD on DD

    const expectedValue = ethers.utils.defaultAbiCoder.encode(['uint8'], [60]);
    expect(hybrid.value).toBe(expectedValue);
    expect(dd.value).toBe(expectedValue);
    expect(ethers.utils.defaultAbiCoder.decode(['uint8'], hybrid.value)[0]).toBe(60);
  });

  it('threshold rejects out-of-range values before any tx', async () => {
    await expect(
      proposeConfigHandler.handler(baseArgv({ key: 'threshold', value: '0' }))
    ).rejects.toThrow('process.exit(1)');
    await expect(
      proposeConfigHandler.handler(baseArgv({ key: 'threshold', value: '101' }))
    ).rejects.toThrow('process.exit(1)');
    expect(executeTxMock).not.toHaveBeenCalled();
    expect(pinJsonMock).not.toHaveBeenCalled();
  });

  it('quorum → key 3 on Hybrid and key 4 on DD, uint32-encoded voter count', async () => {
    await proposeConfigHandler.handler(baseArgv({ key: 'quorum', value: '5' }));

    const batch = capturedBatch();
    expect(batch).toHaveLength(2);

    const hybrid = decodeSetConfig(batch[0][2]);
    const dd = decodeSetConfig(batch[1][2]);
    expect(batch[0][0]).toBe(HYBRID_ADDR);
    expect(batch[1][0]).toBe(DD_ADDR);
    expect(hybrid.key).toBe(3); // QUORUM on Hybrid — NOT 0 (THRESHOLD)
    expect(dd.key).toBe(4); // QUORUM on DD — NOT 0 (THRESHOLD)

    const expectedValue = ethers.utils.defaultAbiCoder.encode(['uint32'], [5]);
    expect(hybrid.value).toBe(expectedValue);
    expect(dd.value).toBe(expectedValue);
    expect(ethers.utils.defaultAbiCoder.decode(['uint32'], hybrid.value)[0]).toBe(5);
  });

  it('quorum accepts 0 (disables quorum) and prints the count-semantics note', async () => {
    await proposeConfigHandler.handler(baseArgv({ key: 'quorum', value: '0' }));

    const batch = capturedBatch();
    const hybrid = decodeSetConfig(batch[0][2]);
    expect(hybrid.key).toBe(3);
    expect(ethers.utils.defaultAbiCoder.decode(['uint32'], hybrid.value)[0]).toBe(0);

    expect(infoMock).toHaveBeenCalledTimes(1);
    expect(infoMock.mock.calls[0][0]).toMatch(/voter COUNT/);
  });

  it('quorum rejects negative and non-integer values before any tx', async () => {
    await expect(
      proposeConfigHandler.handler(baseArgv({ key: 'quorum', value: '-1' }))
    ).rejects.toThrow('process.exit(1)');
    await expect(
      proposeConfigHandler.handler(baseArgv({ key: 'quorum', value: '2.5' }))
    ).rejects.toThrow('process.exit(1)');
    expect(executeTxMock).not.toHaveBeenCalled();
  });

  it('executor → key 2 on Hybrid and key 1 on DD, address-encoded', async () => {
    await proposeConfigHandler.handler(baseArgv({ key: 'executor', value: EXECUTOR_ADDR }));

    const batch = capturedBatch();
    expect(batch).toHaveLength(2);

    const hybrid = decodeSetConfig(batch[0][2]);
    const dd = decodeSetConfig(batch[1][2]);
    expect(hybrid.key).toBe(2); // EXECUTOR on Hybrid
    expect(dd.key).toBe(1); // EXECUTOR on DD

    const expectedValue = ethers.utils.defaultAbiCoder.encode(['address'], [EXECUTOR_ADDR]);
    expect(hybrid.value).toBe(expectedValue);
    expect(dd.value).toBe(expectedValue);
    expect(ethers.utils.defaultAbiCoder.decode(['address'], hybrid.value)[0]).toBe(EXECUTOR_ADDR);
  });

  it('target-allowed is DD-only → key 2 on DD, no Hybrid call', async () => {
    await proposeConfigHandler.handler(
      baseArgv({ key: 'target-allowed', value: `${EXECUTOR_ADDR},true` })
    );

    const batch = capturedBatch();
    expect(batch).toHaveLength(1); // DD only — no HybridVoting call
    expect(batch[0][0]).toBe(DD_ADDR);

    const dd = decodeSetConfig(batch[0][2]);
    expect(dd.key).toBe(2); // TARGET_ALLOWED on DD
    const [addr, allowed] = ethers.utils.defaultAbiCoder.decode(['address', 'bool'], dd.value);
    expect(addr).toBe(EXECUTOR_ADDR);
    expect(allowed).toBe(true);
  });

  it('target-allowed on a Hybrid-only org errors before any pin or tx', async () => {
    resolveVotingContractsMock.mockResolvedValue({
      orgId: '0x' + '11'.repeat(32),
      hybridVotingAddress: HYBRID_ADDR,
      ddVotingAddress: null,
    });

    await expect(
      proposeConfigHandler.handler(baseArgv({ key: 'target-allowed', value: `${EXECUTOR_ADDR},true` }))
    ).rejects.toThrow('process.exit(1)');

    expect(executeTxMock).not.toHaveBeenCalled();
    expect(pinJsonMock).not.toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalled();
    expect(String(errorMock.mock.calls[0][0])).toMatch(/deprecated no-op on HybridVoting/);
  });

  it('rejects the removed DD hat-allowed configuration', async () => {
    await expect(proposeConfigHandler.handler(baseArgv({ key: 'hat-allowed', value: '123,true' }))).rejects.toThrow('process.exit(1)');
    expect(executeTxMock).not.toHaveBeenCalled(); expect(pinJsonMock).not.toHaveBeenCalled();
  });

});
