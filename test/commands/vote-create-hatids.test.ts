/**
 * Regression test for `pop vote create --hat-ids` precision loss.
 *
 * Real Hats Protocol hat IDs are uint256 values with high bits set (the
 * top-hat domain lives in the upper 32 bits), far above Number.MAX_SAFE_INTEGER
 * (2^53 - 1). The old code parsed each entry with parseInt, silently mangling
 * the ID before it reached createProposal. Each entry must survive as an
 * ethers BigNumber with exact string equality to the raw input.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';

const { executeTxMock, pinJsonMock, resolveVotingContractsMock, getWriteContextMock } = vi.hoisted(() => ({
  executeTxMock: vi.fn(),
  pinJsonMock: vi.fn(),
  resolveVotingContractsMock: vi.fn(),
  getWriteContextMock: vi.fn(),
}));

vi.mock('../../src/lib/tx', () => ({
  executeTx: executeTxMock,
}));

vi.mock('../../src/lib/ipfs', () => ({
  pinJson: pinJsonMock,
}));

vi.mock('../../src/commands/vote/helpers', () => ({
  resolveVotingContracts: resolveVotingContractsMock,
  describeExecutionCalls: vi.fn(() => []),
}));

vi.mock('../../src/lib/resolve', () => ({
  resolveOrgId: vi.fn(async () => '0x' + '11'.repeat(32)),
}));

vi.mock('../../src/lib/idempotency', () => ({
  argvToIdempotencyString: vi.fn(() => 'test-idemp-key'),
  checkIdempotencyCache: vi.fn(() => null),
  recordIdempotentResult: vi.fn(),
}));

vi.mock('../../src/lib/signer', () => ({
  createSigner: vi.fn(() => ({ signer: {} })),
}));

// Post-migration plumbing (task/claim.ts template): create.ts now composes
// getWriteContext/confirmWrite/finishWrite/withIdempotency + runPreflight.
// The mocks pass straight through so the createProposal argument assertions
// below stay byte-identical.
vi.mock('../../src/lib/command', () => ({
  getWriteContext: getWriteContextMock,
  confirmWrite: vi.fn(async () => {}),
  finishWrite: vi.fn(),
  withIdempotency: vi.fn(async (_argv: any, _orgId: any, _cmd: any, run: any) => { await run(); }),
}));

vi.mock('../../src/lib/preflight', () => ({
  runPreflight: vi.fn(async () => {}),
  checkGasBalance: vi.fn(() => ({ label: 'gas balance' })),
}));

vi.mock('../../src/lib/contracts', () => ({
  createWriteContract: vi.fn(() => ({ address: '0xC0FFEE' })),
}));

vi.mock('../../src/lib/output', () => ({
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), text: '' })),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

import { createHandler } from '../../src/commands/vote/create';

const HYBRID_ADDR = '0x1111111111111111111111111111111111111111';
const DD_ADDR = '0x2222222222222222222222222222222222222222';

// A real-shaped top-hat ID: 0x04000000... — high bits set, ≫ 2^53.
const BIG_HAT_ID = '26959946667150639794667015087019630673637144422540572481103610249216';

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    org: 'test-org',
    type: 'hybrid',
    name: 'Test proposal',
    description: 'Test description',
    duration: 60,
    options: 'Yes,No',
    noIdempotency: true,
    ...overrides,
  };
}

describe('vote create — --hat-ids BigNumber precision', () => {
  beforeEach(() => {
    executeTxMock.mockReset();
    pinJsonMock.mockReset();
    resolveVotingContractsMock.mockReset();

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
    getWriteContextMock.mockReset();
    getWriteContextMock.mockResolvedValue({
      orgId: '0x' + '11'.repeat(32),
      modules: { hybridVotingAddress: HYBRID_ADDR, ddVotingAddress: DD_ADDR },
      signer: {},
      provider: {},
      address: '0x' + 'aa'.repeat(20),
      chainId: 100,
      networkName: 'Gnosis',
    });
  });

  it('passes a 2^53+ hat ID to createProposal without precision loss', async () => {
    await createHandler.handler(baseArgv({ hatIds: BIG_HAT_ID }));

    expect(executeTxMock).toHaveBeenCalledTimes(1);
    const [, method, args] = executeTxMock.mock.calls[0];
    expect(method).toBe('createProposal');

    const hatIds = args[5];
    expect(hatIds).toHaveLength(1);
    expect(ethers.BigNumber.isBigNumber(hatIds[0])).toBe(true);
    expect(hatIds[0].toString()).toBe(BIG_HAT_ID);
    // Sanity: parseInt would NOT have round-tripped this value.
    expect(String(parseInt(BIG_HAT_ID, 10))).not.toBe(BIG_HAT_ID);
  });

  it('handles multiple comma-separated hat IDs with whitespace', async () => {
    await createHandler.handler(baseArgv({ hatIds: ` ${BIG_HAT_ID} , 42 ` }));

    const hatIds = executeTxMock.mock.calls[0][2][5];
    expect(hatIds).toHaveLength(2);
    expect(hatIds.every((h: any) => ethers.BigNumber.isBigNumber(h))).toBe(true);
    expect(hatIds[0].toString()).toBe(BIG_HAT_ID);
    expect(hatIds[1].toString()).toBe('42');
  });

  it('absent --hat-ids yields an empty array', async () => {
    await createHandler.handler(baseArgv());

    const hatIds = executeTxMock.mock.calls[0][2][5];
    expect(hatIds).toEqual([]);
  });
});
