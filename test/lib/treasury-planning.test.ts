import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
const mock = vi.hoisted(() => ({ aggregate: vi.fn() }));
vi.mock('../../src/lib/multicall', () => ({ tryAggregate: mock.aggregate }));
import { readTreasuryPlanningState, treasuryAvailability } from '../../src/lib/treasury-planning';
const PM = '0x' + '11'.repeat(20), ORG = '0x' + '22'.repeat(32), HASH = '0x' + '33'.repeat(32);
const IFACE = new ethers.utils.Interface(['function distributionCounter() view returns(uint256)', 'function getDistribution(uint256) view returns(address payoutToken,uint256 totalAmount,uint256 checkpointBlock,bytes32 merkleRoot,uint256 totalClaimed,bool finalized)']);
const provider = { getNetwork: async () => ({ chainId: 100 }), getBlock: vi.fn(async () => ({ number: 100, hash: HASH, timestamp: 1234 })), getBalance: vi.fn(async () => ethers.BigNumber.from(100)) } as any;
const input = { provider, chainId: 100, orgId: ORG, paymentManager: PM, asset: { chainId: 100, address: ethers.constants.AddressZero, decimals: 18 } };
beforeEach(() => {
  vi.clearAllMocks(); provider.getBlock.mockResolvedValue({ number: 100, hash: HASH, timestamp: 1234 });
  mock.aggregate.mockImplementation(async (_provider: any, calls: any[], opts: any) => {
    expect(opts).toEqual({ blockTag: 100 });
    return calls.map(call => {
      const parsed = IFACE.parseTransaction({ data: call.data });
      const value = parsed.name === 'distributionCounter' ? IFACE.encodeFunctionResult(parsed.name, [2])
        : IFACE.encodeFunctionResult(parsed.name, [ethers.constants.AddressZero, parsed.args[0].eq(1) ? 60 : 20, 42, HASH, parsed.args[0].eq(1) ? 30 : 20, false]);
      return { success: true, returnData: value };
    });
  });
});
describe('CLI reservation evidence', () => {
  it('batches complete same-block rounds and reserves full open commitments even after claims', async () => {
    const snapshot = await readTreasuryPlanningState(input), result = treasuryAvailability(snapshot);
    expect(mock.aggregate.mock.calls[1][1]).toHaveLength(2);
    expect(result).toMatchObject({ status: 'ready', data: { balanceRaw: '100', committedRaw: '80', spendableRaw: '20', releasableRaw: '0', finalizeIds: [] } });
    expect(snapshot.data.rounds[1].creationBlock.state).toBe('unknown'); // no getter; never invent closing eligibility
  });
  it('a cap or failed round cannot become partial spendable evidence', async () => {
    await expect(readTreasuryPlanningState({ ...input, maxRounds: 1 })).rejects.toThrow('ROUND_CAP');
    mock.aggregate.mockImplementationOnce(async () => [{ success: true, returnData: IFACE.encodeFunctionResult('distributionCounter', [2]) }])
      .mockImplementationOnce(async () => [{ success: false, returnData: '0x' }, { success: false, returnData: '0x' }]);
    await expect(readTreasuryPlanningState(input)).rejects.toThrow('INCOMPLETE_SNAPSHOT');
  });
  it('rejects wrong-chain and changed-block observations', async () => {
    await expect(readTreasuryPlanningState({ ...input, chainId: 42161 })).rejects.toThrow('RPC_CHAIN_MISMATCH');
    provider.getBlock.mockResolvedValueOnce({ number: 100, hash: HASH, timestamp: 1234 }).mockResolvedValueOnce({ number: 100, hash: '0x' + '44'.repeat(32), timestamp: 1234 });
    await expect(readTreasuryPlanningState(input)).rejects.toThrow('RPC_SNAPSHOT_CHANGED');
  });
});
