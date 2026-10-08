import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveOrgId: vi.fn(), refreshAuthorityUsers: vi.fn(), json: vi.fn(), error: vi.fn(),
}));
const wallet = '0x' + 'ab'.repeat(20);
vi.mock('@poa-box/cli/lib/resolve', () => ({ resolveOrgId: mocks.resolveOrgId }));
vi.mock('@poa-box/cli/lib/authority', () => ({ refreshAuthorityUsers: mocks.refreshAuthorityUsers }));
vi.mock('@poa-box/cli/lib/signer', () => ({ createSigner: () => ({ signer: { address: '0x' + 'ab'.repeat(20) } }) }));
vi.mock('@poa-box/cli/config/networks', () => ({ resolveNetworkConfig: () => ({ resolvedRpc: 'https://unit.invalid', nativeCurrency: { symbol: 'xDAI' } }) }));
vi.mock('@poa-box/cli/lib/output', () => ({
  spinner: () => ({ start() {}, stop() {}, text: '' }), isJsonMode: () => true,
  json: mocks.json, error: mocks.error,
}));
vi.mock('ethers', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, ethers: { ...real.ethers,
    providers: { JsonRpcProvider: class {
      getBalance = async () => real.ethers.utils.parseEther('1');
      getCode = async () => '0xef010001';
    } },
    Contract: class { balanceOf = async () => real.ethers.BigNumber.from(1); },
  } };
});

import { deployToOrgHandler } from '../../src/commands/agent/deploy-to-org';

describe('agent deployment readiness uses current authority membership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOrgId.mockResolvedValue('0xorg');
  });

  it('does not count former members in historical User rows as active members', async () => {
    mocks.refreshAuthorityUsers.mockImplementation(async org => { org.users = [
      { address: wallet, membershipStatus: 'Inactive' },
      { address: '0x' + 'cd'.repeat(20), membershipStatus: 'Active' },
    ]; });
    await deployToOrgHandler.handler({ targetOrg: 'Test6', chain: 100 } as any);
    expect(mocks.resolveOrgId).toHaveBeenCalledWith('Test6', 100);
    expect(mocks.refreshAuthorityUsers).toHaveBeenCalledWith(expect.anything(), '0xorg', 100);
    expect(mocks.json.mock.calls[0][0].steps[3]).toMatchObject({ status: 'FOUND', detail: 'Test6 (1 members)' });
  });

  it('recognizes authority membership beyond the old 100-user cutoff', async () => {
    mocks.refreshAuthorityUsers.mockImplementation(async org => { org.users = [
      ...Array.from({ length: 100 }, (_, i) => ({ address: `0x${i.toString(16).padStart(40, '0')}`, membershipStatus: 'Active' })),
      { address: wallet.toUpperCase(), membershipStatus: 'Active', historyIndexed: false },
    ]; });
    await deployToOrgHandler.handler({ targetOrg: 'Test6', chain: 100 } as any);
    expect(mocks.json.mock.calls[0][0].steps[3].status).toBe('MEMBER');
  });

  it('rejects retired organizations before querying their member history', async () => {
    mocks.resolveOrgId.mockRejectedValue(new Error('Organization is retired'));
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    try {
      await expect(deployToOrgHandler.handler({ targetOrg: 'Argus', chain: 100 } as any)).rejects.toThrow('exit');
      expect(mocks.refreshAuthorityUsers).not.toHaveBeenCalled();
      expect(mocks.json).not.toHaveBeenCalled();
      expect(mocks.error).toHaveBeenCalledWith('Organization is retired');
    } finally { exit.mockRestore(); }
  });
});
