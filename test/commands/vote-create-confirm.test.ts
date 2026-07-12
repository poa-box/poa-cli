/**
 * Governance-safety test for `pop vote create --calls`: the confirm summary
 * DECODES the execution calls — target addresses resolve to org-module names
 * (via the write context's OrgModules) and calldata selectors to function
 * signatures (via the known ABIs, real files, no mocks) — so a human approves
 * "TaskManager → setConfig(uint8,bytes)" instead of an opaque hex blob.
 * Undecodable calls must surface as UNDECODABLE, never be hidden.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';

const { executeTxMock, pinJsonMock, getWriteContextMock, confirmWriteMock } = vi.hoisted(() => ({
  executeTxMock: vi.fn(),
  pinJsonMock: vi.fn(),
  getWriteContextMock: vi.fn(),
  confirmWriteMock: vi.fn(async () => {}),
}));

vi.mock('../../src/lib/tx', () => ({
  executeTx: executeTxMock,
}));

vi.mock('../../src/lib/ipfs', () => ({
  pinJson: pinJsonMock,
}));

// Keep loadAbi real — describeExecutionCalls must decode selectors against
// the real ABI files. Only the contract constructor is stubbed (the {} test
// signer would fail ethers' signer validation).
vi.mock('../../src/lib/contracts', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
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
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  isJsonMode: vi.fn(() => false),
}));

// NOTE: ./helpers is deliberately NOT mocked — describeExecutionCalls runs
// for real against the real ABI files.
import { createHandler } from '../../src/commands/vote/create';

const HYBRID_ADDR = ethers.utils.getAddress('0x' + '11'.repeat(20));
const TM_ADDR = ethers.utils.getAddress('0x' + '33'.repeat(20));
const UNKNOWN_ADDR = ethers.utils.getAddress('0x' + 'dd'.repeat(20));
const ORG_ID = '0x' + '11'.repeat(32);

const tmIface = new ethers.utils.Interface(['function setConfig(uint8 key, bytes value)']);

function baseArgv(overrides: Record<string, any> = {}): any {
  return {
    org: 'test-org',
    type: 'hybrid',
    name: 'Test proposal',
    description: 'Test description',
    duration: 60,
    options: 'Apply,Keep',
    noIdempotency: true,
    ...overrides,
  };
}

describe('vote create — confirm summary decodes execution calls', () => {
  beforeEach(() => {
    executeTxMock.mockReset();
    pinJsonMock.mockReset();
    getWriteContextMock.mockReset();
    confirmWriteMock.mockClear();

    pinJsonMock.mockResolvedValue('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
    executeTxMock.mockResolvedValue({
      success: true,
      txHash: '0xabc',
      explorerUrl: 'https://example.com/tx/0xabc',
      logs: [],
    });
    getWriteContextMock.mockResolvedValue({
      orgId: ORG_ID,
      modules: {
        orgId: ORG_ID,
        taskManagerAddress: TM_ADDR,
        hybridVotingAddress: HYBRID_ADDR,
        ddVotingAddress: null,
        participationTokenAddress: null,
        educationHubAddress: null,
        executorAddress: null,
        quickJoinAddress: null,
        eligibilityModuleAddress: null,
        paymentManagerAddress: null,
      },
      signer: {},
      provider: {},
      address: '0x' + 'aa'.repeat(20),
      chainId: 100,
      networkName: 'Gnosis',
    });
  });

  it('names the org module and decodes the function signature for a known call', async () => {
    const setConfigData = tmIface.encodeFunctionData('setConfig', [
      2,
      ethers.utils.defaultAbiCoder.encode(['uint256', 'uint8'], [123, 5]),
    ]);
    const calls = [
      { target: TM_ADDR, value: '0', data: setConfigData },
      { target: UNKNOWN_ADDR, value: '1000000000000000000', data: '0xdeadbeef' },
    ];

    await createHandler.handler(baseArgv({ calls: JSON.stringify(calls) }));

    expect(confirmWriteMock).toHaveBeenCalledTimes(1);
    const summary = confirmWriteMock.mock.calls[0][1] as Record<string, string>;

    // Known module + known selector → named target + decoded signature.
    const line1 = summary['call 1/2'];
    expect(line1).toBeDefined();
    expect(line1).toContain('TaskManager');
    expect(line1).toContain('setConfig(uint8,bytes)');
    expect(line1).toContain(setConfigData.slice(0, 10)); // raw selector still shown

    // Unknown target + unknown selector → flagged, with the native value.
    const line2 = summary['call 2/2'];
    expect(line2).toBeDefined();
    expect(line2).toContain(`unknown contract ${UNKNOWN_ADDR}`);
    expect(line2).toContain('UNDECODABLE');
    expect(line2).toContain('0xdeadbeef');
    expect(line2).toContain('1 native');

    // The calls still land in the option-0 execution batch untouched.
    expect(executeTxMock).toHaveBeenCalledTimes(1);
    const [, method, args] = executeTxMock.mock.calls[0];
    expect(method).toBe('createProposal');
    const batches = args[4];
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(2);
    expect(batches[1]).toEqual([]);
    expect(batches[0][0][0]).toBe(TM_ADDR);
    expect(batches[0][0][2]).toBe(setConfigData);
  });

  it('plain native transfers (empty calldata) are labeled as such', async () => {
    const calls = [{ target: UNKNOWN_ADDR, value: '2000000000000000000', data: '0x' }];

    await createHandler.handler(baseArgv({ calls: JSON.stringify(calls) }));

    const summary = confirmWriteMock.mock.calls[0][1] as Record<string, string>;
    const line = summary['call 1/1'];
    expect(line).toContain('plain native-token transfer');
    expect(line).toContain('2 native');
  });

  it('a proposal without --calls confirms without any call lines', async () => {
    await createHandler.handler(baseArgv());

    expect(confirmWriteMock).toHaveBeenCalledTimes(1);
    const summary = confirmWriteMock.mock.calls[0][1] as Record<string, string>;
    expect(Object.keys(summary).filter(k => k.startsWith('call '))).toEqual([]);
    // No calls → no batches at all (createProposal arg 4 stays []).
    expect(executeTxMock.mock.calls[0][2][4]).toEqual([]);
  });
});
