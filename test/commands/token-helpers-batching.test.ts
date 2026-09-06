import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
const { batch } = vi.hoisted(() => ({ batch: vi.fn() }));
vi.mock('../../src/lib/multicall', () => ({ tryAggregate: batch }));
import { readTokenGates, checkTokenPermission } from '../../src/commands/token/helpers';
import { AUTHORITY_KEYS } from '../../packages/core/src/tx/authority';
const authority = `0x${'11'.repeat(20)}`;
const executor = `0x${'22'.repeat(20)}`;
const token = `0x${'33'.repeat(20)}`;
const iface = new ethers.utils.Interface(['function membershipAuthority() view returns(address)', 'function executor() view returns(address)', 'function hasPerm(address,bytes32,bytes32) view returns(uint256)']);
describe('token authority preflight', () => {
  it('batches the live authority pointer and executor, without Hats reads', async () => {
    batch.mockResolvedValue([ { success: true, returnData: iface.encodeFunctionResult('membershipAuthority', [authority]) }, { success: true, returnData: iface.encodeFunctionResult('executor', [executor]) } ]);
    expect(await readTokenGates({} as any, token)).toEqual({ authorityAddress: authority, executor });
    expect(batch.mock.calls.at(-1)[1]).toHaveLength(2);
  });
  it('refuses incomplete gate reads', async () => {
    batch.mockResolvedValue([{ success: false, returnData: '0x' }]);
    await expect(readTokenGates({} as any, token)).rejects.toThrow('membershipAuthority');
  });
  it('checks PT_APPROVE with global context using hasPerm, without role enumeration', () => {
    const check = checkTokenPermission(authority, executor, AUTHORITY_KEYS.PT_APPROVE);
    expect(iface.decodeFunctionData('hasPerm', check.call!.data)).toEqual([executor, AUTHORITY_KEYS.PT_APPROVE, ethers.constants.HashZero]);
    expect(check.interpret!(iface.encodeFunctionResult('hasPerm', [1]), true).ok).toBe(true);
    expect(check.interpret!(iface.encodeFunctionResult('hasPerm', [0]), true).ok).toBe(false);
    expect(check.interpret!('0x', false).ok).toBe(false);
  });
});
