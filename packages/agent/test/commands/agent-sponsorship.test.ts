import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
const mocks = vi.hoisted(() => ({ infra: vi.fn(), state: vi.fn(), provider: vi.fn(), batch: vi.fn(),
  network: vi.fn(), json: vi.fn(), error: vi.fn(), confirm: vi.fn(), send: vi.fn(), signer: vi.fn() }));
vi.mock('@poa-box/cli/lib/output', () => ({ spinner: () => ({ start() {}, stop() {} }), isJsonMode: () => true, json: mocks.json, error: mocks.error }));
vi.mock('@poa-box/cli/lib/signer', () => ({ createProvider: mocks.provider, createSigner: mocks.signer }));
vi.mock('@poa-box/cli/lib/resolve', () => ({ resolveOrgModules: async () => ({ orgId: '0x' + '11'.repeat(32) }) }));
vi.mock('@poa-box/cli/config/networks', () => ({ resolveNetworkConfig: mocks.network }));
vi.mock('@poa-box/cli/lib/multicall', () => ({ tryAggregate: mocks.batch }));
vi.mock('@poa-box/cli/lib/command', () => ({ confirmWrite: mocks.confirm }));
vi.mock('@poa-box/cli/lib/tx', () => ({ executeTx: mocks.send }));
vi.mock('@poa-box/cli/commands/paymaster/helpers', () => ({ resolvePaymasterInfra: mocks.infra,
  fetchPaymasterSubgraphState: mocks.state, subgraphMatchesHub: () => true,
  hatSubjectKey: () => '0x' + '55'.repeat(32) }));
vi.mock('@poa-box/cli/lib/contracts', async () => {
  const { ethers } = await import('ethers');
  const abi = require('@poa-box/cli/abi/PaymasterHub.json');
  return { createReadContract: (address: string) => ({ address, interface: new ethers.utils.Interface(abi) }), createWriteContract: vi.fn() };
});
vi.mock('ethers', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, ethers: { ...real.ethers, Contract: class { balanceOf = async () => real.ethers.BigNumber.from('100'); } } };
});
import { paymasterStatusHandler } from '../../src/commands/agent/paymaster-status';
import { setupSponsorshipHandler } from '../../src/commands/agent/setup-sponsorship';

const hub = '0x' + '22'.repeat(20), entryPoint = '0x' + '33'.repeat(20), rpc = 'http://unit.invalid';
let saved: string | undefined;
describe('agent sponsorship host', () => {
  beforeEach(() => {
    saved = process.env.POP_READONLY; delete process.env.POP_READONLY;
    vi.clearAllMocks();
    mocks.network.mockReturnValue({ chainId: 42161, resolvedRpc: rpc, nativeCurrency: { symbol: 'ETH' } });
    mocks.infra.mockResolvedValue({ paymasterHubAddress: hub });
    mocks.provider.mockReturnValue({ getNetwork: async () => ({ chainId: 42161 }),
      getBlock: async () => ({ number: 50, timestamp: 200, hash: '0x' + '44'.repeat(32) }) });
    mocks.state.mockResolvedValue({ hubAddress: hub, entryPoint, orgConfig: { paused: false },
      feeCaps: { maxFeePerGas: '10', maxPriorityFeePerGas: '1', maxCallGas: 1, maxVerificationGas: 2, maxPreVerificationGas: 3 },
      budgets: [{ subjectKey: '0x' + '55'.repeat(32), capPerEpoch: '100', usedInEpoch: '90', epochLen: 10, epochStart: 100 }] });
    const iface = new ethers.utils.Interface(require('@poa-box/cli/abi/PaymasterHub.json'));
    mocks.batch.mockResolvedValue([
      { success: true, returnData: iface.encodeFunctionResult('getOrgFinancials', [['1000', '100', '0', 100]]) },
      { success: true, returnData: iface.encodeFunctionResult('getBudget', [['100', '90', 10, 100]]) },
    ]);
  });
  afterEach(() => { if (saved === undefined) delete process.env.POP_READONLY; else process.env.POP_READONLY = saved; });

  it('resolves the selected chain hub and rolls expired budget spend without losing the raw value', async () => {
    await paymasterStatusHandler.handler({ org: 'Org', chain: 42161, subject: '9', rpc } as any);
    expect(mocks.infra).toHaveBeenCalledWith(42161);
    expect(mocks.provider).toHaveBeenCalledWith({ chainId: 42161, rpcUrl: rpc });
    expect(mocks.json.mock.calls[0][0]).toMatchObject({ chainId: 42161, paymasterHub: hub, entryPoint,
      hatBudget: { remainingWei: '100', utilizationPct: '0.0%', raw: { usedInEpoch: '90' } } });
    expect(mocks.batch.mock.calls[0][1]).toHaveLength(2);
    expect(mocks.batch.mock.calls[0][2]).toEqual({ blockTag: 50 });
    expect(mocks.signer).not.toHaveBeenCalled();
  });

  it('does not replenish an exhausted current budget from a stale indexed epoch', async () => {
    const iface = new ethers.utils.Interface(require('@poa-box/cli/abi/PaymasterHub.json'));
    mocks.batch.mockResolvedValue([
      { success: true, returnData: iface.encodeFunctionResult('getOrgFinancials', [['1000', '100', '0', 100]]) },
      { success: true, returnData: iface.encodeFunctionResult('getBudget', [['100', '100', 10, 200]]) },
    ]);
    await paymasterStatusHandler.handler({ org: 'Org', chain: 42161, subject: '9', rpc } as any);
    expect(mocks.json.mock.calls[0][0]).toMatchObject({ hatBudget: {
      remainingWei: '0', utilizationPct: '100.0%', source: 'rpc', blockNumber: 50,
      raw: { usedInEpoch: '100', epochStart: '200' }, indexedRaw: { usedInEpoch: '90', epochStart: '100' },
    } });
  });

  it('refuses budget output when its pinned block is no longer canonical', async () => {
    mocks.provider.mockReturnValue({ getNetwork: async () => ({ chainId: 42161 }),
      getBlock: async (tag: string | number) => ({ number: 50, timestamp: 200, hash: tag === 'latest' ? '0x' + '44'.repeat(32) : '0x' + '66'.repeat(32) }) });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    try {
      await expect(paymasterStatusHandler.handler({ org: 'Org', chain: 42161, subject: '9', rpc } as any)).rejects.toThrow('exit');
      expect(mocks.error).toHaveBeenCalledWith('PAYMASTER_OBSERVATION_CHANGED');
      expect(mocks.json).not.toHaveBeenCalled();
    } finally { exit.mockRestore(); }
  });

  it('rejects setup outside Gnosis before constructing a signer', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    try {
      await expect(setupSponsorshipHandler.handler({ orgId: 'org', subject: '9', chain: 42161 } as any)).rejects.toThrow('exit');
      expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('Gnosis only'), undefined);
      expect(mocks.signer).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
    } finally { exit.mockRestore(); }
  });

  it('read-only mode blocks direct setup before configuration or signing', async () => {
    process.env.POP_READONLY = '1';
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    try {
      await expect(setupSponsorshipHandler.handler({ orgId: 'org', subject: '9' } as any)).rejects.toThrow('exit');
      expect(mocks.infra).not.toHaveBeenCalled(); expect(mocks.signer).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
    } finally { exit.mockRestore(); }
  });
});
